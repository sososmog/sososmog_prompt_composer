//! L3 subagent 树采集：扫 `<config_dir>/projects/<slug>/<session_id>/subagents/`。
//!
//! 完整背景见 `docs/agent-fleet.md` §2「L3 subagent 树」、§3.2 `SubagentDigest`、
//! §9 边界情况。官方没有文档，这一层是纯实测反推出来的：一个 subagent 落两个
//! 文件——`agent-<id>.meta.json`（派生信息：类型/描述/父子关系）和
//! `agent-<id>.jsonl`（这个子 agent 自己的转录，格式与主 transcript 相同）。
//!
//! 本模块只做「摊平成一份可展示的 [`types::SubagentDigest`] 列表」，**不做树重建**
//! （父子关系、环、孤儿的处理是前端 `fleet.js` 的 `buildSubagentTree` 的职责，
//! 见方案 B2）——这里只负责老老实实把磁盘上有什么、以及每个 agent 的状态摘要
//! 如实报出去。

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Deserialize;

use super::transcript;
use super::types;

/// 一次 subagent 目录扫描的结果。
pub struct SubagentScan {
    pub digests: Vec<types::SubagentDigest>,
    pub warnings: Vec<types::FleetWarning>,
}

/// `agent-<id>.meta.json` 的原始形状，字段名与 JSON camelCase 对齐。
///
/// 不加 `deny_unknown_fields`——实测还有 `toolUseId` 字段，我们不关心，忽略即可。
/// 和 `roster.rs` 的 `RawRosterEntry` 同一个理由：社区/未来版本随时可能加字段，
/// 多一个字段不该导致整条记录解析失败。
///
/// 四个字段全是 `Option`：**meta.json 本身能被解析出来** 就够了，里面缺哪个字段
/// 都不构成解析失败——顶层 agent 的 `parentAgentId` 缺失就是常态（不是 null，
/// 是这个键在 JSON 里根本不存在），`Option` 天然把「缺失」和「解析出 null」统一
/// 处理，这正是我们想要的语义。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubagentMeta {
    agent_type: Option<String>,
    description: Option<String>,
    parent_agent_id: Option<String>,
    spawn_depth: Option<u32>,
}

/// 扫描一个会话的 `subagents/` 目录。
///
/// `subagents_dir` 是 `<config_dir>/projects/<slug>/<session_id>/subagents/`。
/// `tail_bytes` 是上游（编排层）传下来的通用尾部窗口配置；本函数内部会把它
/// 收紧到最多 16KB 再传给 `transcript::read_digest`（见下方注释）。
pub fn scan(subagents_dir: &Path, tail_bytes: u64) -> SubagentScan {
    let read_dir = match std::fs::read_dir(subagents_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 绝大多数会话从没派过子 agent——这是正常状态，不是错误。
            // 同 roster.rs 对 `sessions/` 目录不存在的处理：静默返回空，不报 warning，
            // 否则每一次没派过子 agent 的轮询都会刷出一条毫无意义的提示。
            return SubagentScan {
                digests: Vec::new(),
                warnings: Vec::new(),
            };
        }
        Err(_) => {
            // 目录存在但读不出来（权限问题一类）——这才是真正值得提醒用户的情况。
            return SubagentScan {
                digests: Vec::new(),
                warnings: vec![types::FleetWarning::new(
                    types::WarningCode::SubagentsUnreadable,
                    format!("无法读取目录：{}", subagents_dir.display()),
                )],
            };
        }
    };

    // 一个 agent 可能只有 meta（还没产生任何输出）、也可能只有 jsonl（meta 写
    // 失败或写入过程中中断）。两种文件分别收集，最后取文件名剥出的 agentId 的
    // **并集**——只认其中一种会导致用户看不到那个 agent（夹具用 child2 钉住
    // 「只有 meta」、nometa 钉住「只有 jsonl」这两种情况）。
    let mut meta_paths: HashMap<String, PathBuf> = HashMap::new();
    let mut jsonl_paths: HashMap<String, PathBuf> = HashMap::new();

    for dir_entry in read_dir.filter_map(Result::ok) {
        let path = dir_entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix("agent-") else {
            continue;
        };
        if let Some(id) = rest.strip_suffix(".meta.json") {
            meta_paths.insert(id.to_string(), path.clone());
        } else if let Some(id) = rest.strip_suffix(".jsonl") {
            jsonl_paths.insert(id.to_string(), path.clone());
        }
        // 既不匹配 `.meta.json` 也不匹配 `.jsonl` 的文件（理论上不该有）安全忽略。
    }

    // 用 BTreeSet 收集并集里出现过的所有 agentId：既天然去重（一个 id 可能在
    // 两个 map 里都有），又天然按字典序升序——省掉扫描结束后再排一次序，
    // 也保证同一份磁盘状态每次返回的顺序一致（前端会自己再排，但采集层稳定
    // 输出更好测、也避免无意义的 diff）。
    let mut ids: BTreeSet<&String> = meta_paths.keys().collect();
    ids.extend(jsonl_paths.keys());

    // subagent 的 tail 窗口收小到 16KB：我们只需要尾部消息的形态（role / stop
    // reason / tail kind 这几样状态判定用的字段），不需要像主 transcript 那样
    // 往前找 ai-title 之类要跨越很多行才能碰到的字段。一个会话可能同时挂着
    // 5 个以上子 agent，每个都跟主 transcript 一样按 64KB 读、每 2 秒轮询一次，
    // 白白多读的量相当可观，而这些字节对子 agent 摘要毫无用处。
    let window = tail_bytes.min(16 * 1024);

    let mut digests = Vec::new();
    let mut warnings = Vec::new();

    for id in ids {
        let meta_path = meta_paths.get(id);
        let jsonl_path = jsonl_paths.get(id);

        let mut agent_type = None;
        let mut description = None;
        let mut parent_agent_id = None;
        let mut spawn_depth = None;
        // 没有 meta 文件本身不算「解析失败」（对应 nometa 夹具）；只有「文件存在
        // 但内容不是合法 JSON」才算。
        let mut meta_ok = true;

        if let Some(mp) = meta_path {
            let parsed = std::fs::read_to_string(mp)
                .ok()
                .and_then(|content| serde_json::from_str::<RawSubagentMeta>(&content).ok());
            match parsed {
                Some(raw) => {
                    agent_type = raw.agent_type;
                    description = raw.description.as_deref().map(types::truncate_text);
                    parent_agent_id = raw.parent_agent_id;
                    spawn_depth = raw.spawn_depth;
                }
                None => {
                    meta_ok = false;
                    // detail 只带文件名，不带内容——badmeta 夹具的内容是非法 JSON
                    // `{{{`，这条 warning 绝不能把它带出去（隐私要求见 types.rs）。
                    let file_name = mp
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("<unknown>");
                    warnings.push(types::FleetWarning::new(
                        types::WarningCode::SubagentsUnreadable,
                        format!("meta 解析失败：{file_name}"),
                    ));
                }
            }
        }

        // meta 坏且没有 jsonl：没有任何可展示信息了（agentId 之外什么都没有），
        // 跳过这个 agent——但上面产生的 warning 要保留，用户至少知道「有个东西
        // 读不出来」。
        if !meta_ok && jsonl_path.is_none() {
            continue;
        }

        let mut mtime_ms = None;
        let mut size_bytes = None;
        let mut last_role = None;
        let mut last_stop_reason = None;
        let mut last_tail_kind = None;
        let mut last_msg_ts_ms = None;
        let mut context_tokens = None;

        if let Some(jp) = jsonl_path {
            // 复用 transcript::read_digest 而不是自己再写一遍 jsonl 解析——两边
            // 是同一种文件格式，格式漂移只需要在一个地方跟进。
            match transcript::read_digest(jp, window) {
                Ok(d) => {
                    mtime_ms = Some(d.mtime_ms);
                    size_bytes = Some(d.size_bytes);
                    last_role = d.last_role;
                    last_stop_reason = d.last_stop_reason;
                    last_tail_kind = d.last_tail_kind;
                    last_msg_ts_ms = d.last_msg_ts_ms;
                    context_tokens = d.context_tokens;
                }
                Err(_) => {
                    // read_digest 读不出摘要（尾部窗口里没有 user/assistant 消息，
                    // 或者 I/O 出错）不产 warning：子 agent 的转录读不出摘要不影响
                    // 主功能展示，而且这里是每 2 秒一轮的高频轮询路径，产 warning
                    // 就是纯刷屏。
                    //
                    // 但 mtime/size 只是文件系统元数据，跟内容能不能解析是两回事——
                    // nometa 夹具就是「jsonl 存在（只有一行 ai-title，没有任何
                    // user/assistant 消息）但解析不出摘要」的真实场景，此时仍然
                    // 应该报出「这个文件多大、多新」，所以这里单独兜底一次 stat，
                    // 不能让它跟着 read_digest 的失败一起变成 None。
                    if let Ok(meta) = std::fs::metadata(jp) {
                        size_bytes = Some(meta.len());
                        mtime_ms = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64);
                    }
                }
            }
        }

        digests.push(types::SubagentDigest {
            agent_id: id.clone(),
            agent_type,
            description,
            parent_agent_id,
            spawn_depth,
            mtime_ms,
            size_bytes,
            last_role,
            last_stop_reason,
            last_tail_kind,
            last_msg_ts_ms,
            context_tokens,
        });
    }

    SubagentScan { digests, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::types::{Role, TailKind};

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/subagents")
    }

    fn find<'a>(scan: &'a SubagentScan, id: &str) -> Option<&'a types::SubagentDigest> {
        scan.digests.iter().find(|d| d.agent_id == id)
    }

    /// 全量核对：`tree/` 夹具应该恰好扫出 9 个 agent（badmeta 因为「meta 坏且
    /// 没有 jsonl」被跳过），且按 agentId 字典序升序排列。
    #[test]
    fn tree_scans_every_agent_and_orders_by_agent_id() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let ids: Vec<&str> = scan.digests.iter().map(|d| d.agent_id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "child1", "child2", "cyclea", "cycleb", "nodepth", "nometa", "orphan", "root1",
                "root2",
            ],
            "应恰好扫出这 9 个 agent（badmeta 被跳过），且按 agentId 升序排列"
        );
    }

    #[test]
    fn root1_has_meta_and_jsonl_with_tool_use_tail() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let d = find(&scan, "root1").expect("root1 应该出现在结果里");

        assert_eq!(d.agent_type.as_deref(), Some("general-purpose"));
        assert_eq!(d.description.as_deref(), Some("占位描述：顶层 agent 一"));
        // 顶层 agent 的 parentAgentId 在 meta.json 里是字段缺失，不是 null，
        // 反序列化后同样是 None——这是本模块最容易搞混的一条语义。
        assert_eq!(d.parent_agent_id, None, "顶层 agent 的 parentAgentId 应为 None");
        assert_eq!(d.spawn_depth, Some(1));

        assert!(d.mtime_ms.is_some());
        assert!(d.size_bytes.is_some_and(|n| n > 0));
        assert_eq!(d.last_role, Some(Role::Assistant));
        assert_eq!(d.last_stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(d.last_tail_kind, Some(TailKind::ToolUse));
        assert_eq!(
            d.context_tokens,
            Some(70_424),
            "usage 2 + 3483 + 66939 = 70424"
        );
        assert_eq!(
            d.last_msg_ts_ms,
            transcript::parse_iso8601_utc_ms("2026-07-30T07:29:57.407Z")
        );
    }

    #[test]
    fn root2_has_meta_and_jsonl_with_end_turn_text_tail() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let d = find(&scan, "root2").expect("root2 应该出现在结果里");

        assert_eq!(d.agent_type.as_deref(), Some("general-purpose"));
        assert_eq!(d.description.as_deref(), Some("占位描述：顶层 agent 二"));
        assert_eq!(d.parent_agent_id, None, "顶层 agent 的 parentAgentId 应为 None");
        assert_eq!(d.spawn_depth, Some(1));

        assert_eq!(d.last_role, Some(Role::Assistant));
        assert_eq!(d.last_stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(d.last_tail_kind, Some(TailKind::Text));
    }

    #[test]
    fn child1_has_meta_and_jsonl_pointing_at_root1() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let d = find(&scan, "child1").expect("child1 应该出现在结果里");

        assert_eq!(d.agent_type.as_deref(), Some("general-purpose"));
        assert_eq!(d.description.as_deref(), Some("占位描述：子 agent 一"));
        assert_eq!(d.parent_agent_id.as_deref(), Some("root1"));
        assert_eq!(d.spawn_depth, Some(2));

        assert_eq!(d.last_role, Some(Role::Assistant));
        assert_eq!(d.last_stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(d.last_tail_kind, Some(TailKind::ToolUse));
    }

    /// child2 只有 meta，没有 jsonl（还没产生任何输出）：仍必须出现在结果里，
    /// 只是所有来自 jsonl 的字段都是 None。
    #[test]
    fn child2_only_has_meta_jsonl_fields_are_none() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let d = find(&scan, "child2").expect("只有 meta 也该出现在结果里");

        assert_eq!(d.agent_type.as_deref(), Some("Explore"));
        assert_eq!(d.description.as_deref(), Some("占位描述：子 agent 二"));
        assert_eq!(d.parent_agent_id.as_deref(), Some("root1"));
        assert_eq!(d.spawn_depth, Some(2));

        assert_eq!(d.mtime_ms, None);
        assert_eq!(d.size_bytes, None);
        assert_eq!(d.last_role, None);
        assert_eq!(d.last_stop_reason, None);
        assert_eq!(d.last_tail_kind, None);
        assert_eq!(d.last_msg_ts_ms, None);
        assert_eq!(d.context_tokens, None);
    }

    /// nometa 只有 jsonl，没有 meta：出现在结果里，meta 相关字段全 None，
    /// 但 jsonl 存在这件事本身（mtime/size）必须被如实报出来——即便这个
    /// jsonl 里只有一条 `ai-title`、没有任何 user/assistant 消息，
    /// read_digest 会判定 Unparsable，mtime/size 也不能因此跟着变 None。
    #[test]
    fn nometa_only_has_jsonl_metadata_survives_unparsable_digest() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let d = find(&scan, "nometa").expect("只有 jsonl 也该出现在结果里");

        assert_eq!(d.agent_type, None);
        assert_eq!(d.description, None);
        assert_eq!(d.parent_agent_id, None);
        assert_eq!(d.spawn_depth, None);

        assert!(d.mtime_ms.is_some(), "jsonl 文件本身存在，mtime 应该有值");
        assert!(d.size_bytes.is_some_and(|n| n > 0));
        // 内容本身解析不出摘要——没有 user/assistant 消息。
        assert_eq!(d.last_role, None);
        assert_eq!(d.last_stop_reason, None);
        assert_eq!(d.last_tail_kind, None);
    }

    /// badmeta 是非法 JSON 且没有 jsonl：没有任何可展示信息，必须被跳过，
    /// 同时恰好产生一条 warning，且 warning 的 detail 绝不能带上文件内容
    /// （`{{{`），只能带文件名——隐私要求。
    #[test]
    fn badmeta_is_skipped_with_exactly_one_privacy_safe_warning() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);

        assert!(find(&scan, "badmeta").is_none(), "badmeta 不该出现在结果里");
        assert_eq!(scan.warnings.len(), 1, "应恰好产生一条 warning");
        assert_eq!(scan.warnings[0].code, types::WarningCode::SubagentsUnreadable);
        assert!(scan.warnings[0].detail.contains("badmeta"));
        assert!(
            !scan.warnings[0].detail.contains("{{{"),
            "warning detail 不能泄漏文件内容：{}",
            scan.warnings[0].detail
        );
    }

    /// orphan 的父 id 指向一个不存在的 agent——本模块不做树重建，不需要关心
    /// 这件事，原样把 parentAgentId 报出去即可（悬空指针的处理是前端
    /// buildSubagentTree 的职责）。
    #[test]
    fn orphan_parent_pointing_nowhere_is_reported_as_is() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let d = find(&scan, "orphan").expect("orphan 应该出现在结果里");

        assert_eq!(d.description.as_deref(), Some("占位描述：孤儿"));
        assert_eq!(d.parent_agent_id.as_deref(), Some("does-not-exist"));
        assert_eq!(d.spawn_depth, Some(2));
    }

    /// cyclea/cycleb 互相指对方为父——本模块只做扁平化，不递归遍历父链，
    /// 天然不存在死循环的风险；这里只需确认两条记录各自的字段被原样报出。
    #[test]
    fn cyclic_parent_pointers_are_both_reported_without_hanging() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let a = find(&scan, "cyclea").expect("cyclea 应该出现在结果里");
        let b = find(&scan, "cycleb").expect("cycleb 应该出现在结果里");

        assert_eq!(a.parent_agent_id.as_deref(), Some("cycleb"));
        assert_eq!(b.parent_agent_id.as_deref(), Some("cyclea"));
    }

    /// nodepth 缺 spawnDepth 与 agentType，但有 parentAgentId——三者互相独立，
    /// 缺其中两个不该影响第三个被正常解析出来。
    #[test]
    fn nodepth_missing_spawn_depth_and_agent_type_but_has_parent() {
        let scan = scan(&fixtures_dir().join("tree"), 65536);
        let d = find(&scan, "nodepth").expect("nodepth 应该出现在结果里");

        assert_eq!(d.agent_type, None);
        assert_eq!(d.spawn_depth, None);
        assert_eq!(d.parent_agent_id.as_deref(), Some("root2"));
        assert_eq!(d.description.as_deref(), Some("占位：没有深度字段"));
    }

    #[test]
    fn empty_dir_returns_no_digests_and_no_warnings() {
        let scan = scan(&fixtures_dir().join("empty"), 65536);
        assert!(scan.digests.is_empty());
        assert!(scan.warnings.is_empty());
    }

    #[test]
    fn missing_dir_returns_no_digests_and_no_warnings() {
        // 绝大多数会话没派过子 agent——目录不存在是正常状态，不是错误。
        let scan = scan(&fixtures_dir().join("does-not-exist"), 65536);
        assert!(scan.digests.is_empty());
        assert!(
            scan.warnings.is_empty(),
            "目录不存在不该产生 warning（同 roster.rs 对 sessions/ 的处理）"
        );
    }
}
