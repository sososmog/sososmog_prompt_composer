
use std::path::Path;

use serde::Deserialize;

use super::types;

/// 一条名册条目，摊平后的展示字段。
#[derive(Debug, Clone)]
pub struct RosterEntry {
    pub pid: u32,
    pub session_id: String,
    pub name: String,
    pub cwd: String,
    pub entrypoint: String,
    pub kind: String,
    pub started_at: i64,
    pub cli_version: String,
}

/// 一次名册扫描的结果：解析出的条目 + 过程中产生的非致命 warning。
#[derive(Debug)]
pub struct RosterScan {
    pub entries: Vec<RosterEntry>,
    pub warnings: Vec<types::FleetWarning>,
}

/// 名册文件的原始形状。字段名与 JSON 逐一对齐（`version` 在 JSON 里就叫
/// `version`，不是 `cliVersion`——落到 [`RosterEntry`] 时才改名）。
///
/// 全部是 `Option`：**除了 pid/sessionId，其余字段缺失不构成解析失败**，
/// 只是展示时兜底成空串/0。用 `Option` 而不是给非 Option 字段配
/// `#[serde(default)]`是为了在 `parse_entry` 里能精确区分"pid/sessionId 缺失"
/// 和"其它字段缺失"这两种完全不同的处理路径。
///
/// 不加 `deny_unknown_fields`：JSON 里还有 `peerProtocol`、`nameSource` 等我们
/// 不关心的字段，社区/未来版本可能继续加字段，来了就该忽略，而不是解析失败。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRosterEntry {
    pid: Option<u32>,
    session_id: Option<String>,
    name: Option<String>,
    cwd: Option<String>,
    entrypoint: Option<String>,
    kind: Option<String>,
    started_at: Option<i64>,
    version: Option<String>,
}

/// 单条名册文件解析失败的原因，只用来拼 warning 的中文说明——
/// 两种原因在契约里对应同一个 [`types::WarningCode::RosterEntryInvalid`]，
/// 分开只是为了让 detail 里的措辞更精确，方便排错。
#[derive(Debug)]
enum RosterEntryError {
    InvalidJson,
    MissingRequired,
}

impl std::fmt::Display for RosterEntryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RosterEntryError::InvalidJson => write!(f, "JSON 解析失败"),
            RosterEntryError::MissingRequired => write!(f, "缺少 pid 或 sessionId"),
        }
    }
}

/// 纯函数：把一个文件的原始内容解析成一条 [`RosterEntry`]。
///
/// 不做任何文件 I/O，方便单测直接喂字符串，覆盖"字段缺失时的兜底值"这类
/// 用真实夹具不好精确构造的场景。
fn parse_entry(content: &str) -> Result<RosterEntry, RosterEntryError> {
    let raw: RawRosterEntry =
        serde_json::from_str(content).map_err(|_| RosterEntryError::InvalidJson)?;

    // pid 和 sessionId 是仅有的两个"缺了就没有展示价值"的字段——没有 pid 无法
    // 关联到进程做 L5 采样，没有 sessionId 无法关联到 L2 的 transcript。
    // 其余字段哪怕全空，这条记录依然值得展示（用户至少能看到"有个东西在跑"）。
    let pid = raw.pid.ok_or(RosterEntryError::MissingRequired)?;
    let session_id = raw.session_id.ok_or(RosterEntryError::MissingRequired)?;

    Ok(RosterEntry {
        pid,
        session_id,
        name: raw.name.unwrap_or_default(),
        cwd: raw.cwd.unwrap_or_default(),
        entrypoint: raw.entrypoint.unwrap_or_default(),
        kind: raw.kind.unwrap_or_default(),
        started_at: raw.started_at.unwrap_or(0),
        cli_version: raw.version.unwrap_or_default(),
    })
}

/// 扫描 `<config_dir>/sessions/*.json`，摊平成名册条目。
///
/// 失败语义：**只有单个文件级别的失败**（非法 JSON、缺字段、读不了），一律
/// 跳过该条 + 记一条 warning，不影响其余文件——不能因为一个坏文件让整个名册
/// 扫描失败。目录级别的失败只有两种：不存在（正常状态，静默返回空）、
/// 存在但读不了（真的异常，报 warning）。
pub fn scan(config_dir: &Path) -> RosterScan {
    let sessions_dir = config_dir.join("sessions");

    let read_dir = match std::fs::read_dir(&sessions_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // "从没跑过 claude"是正常状态，不是错误，不产 warning。
            return RosterScan {
                entries: Vec::new(),
                warnings: Vec::new(),
            };
        }
        Err(_) => {
            // 目录存在但读不出来（常见于权限问题）——这才是真正需要提醒用户的情况。
            return RosterScan {
                entries: Vec::new(),
                warnings: vec![types::FleetWarning::new(
                    types::WarningCode::RosterUnreadable,
                    format!("无法读取目录：{}", sessions_dir.display()),
                )],
            };
        }
    };

    let mut entries = Vec::new();
    let mut warnings = Vec::new();

    for dir_entry in read_dir {
        let dir_entry = match dir_entry {
            Ok(e) => e,
            // 单个目录项读取失败极罕见（例如扫描途中被并发删除），
            // 不构成整体失败，跳过即可，无需专门报 warning。
            Err(_) => continue,
        };
        let path = dir_entry.path();

        // 只看 .json 结尾的文件；其余（如 notes.txt）是正常存在、不相关的文件，
        // 忽略即可，**不产 warning**——这不是问题，是约定之外的正常情况。
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        // warning 的 detail 只允许带文件名，不能带文件内容（隐私要求，见
        // types.rs 头部注释）。这里提前把文件名取出来，后面所有分支只用这个变量，
        // 避免哪天有人手滑把 content 拼进 detail 里。
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("<unknown>")
            .to_string();

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                warnings.push(types::FleetWarning::new(
                    types::WarningCode::RosterEntryInvalid,
                    format!("读取失败：{file_name}"),
                ));
                continue;
            }
        };

        match parse_entry(&content) {
            Ok(entry) => entries.push(entry),
            Err(reason) => {
                warnings.push(types::FleetWarning::new(
                    types::WarningCode::RosterEntryInvalid,
                    format!("{reason}：{file_name}"),
                ));
            }
        }
    }

    RosterScan { entries, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/roster")
    }

    fn find(scan: &RosterScan, pid: u32) -> Option<&RosterEntry> {
        scan.entries.iter().find(|e| e.pid == pid)
    }

    #[test]
    fn valid_entry_parses_every_field() {
        let scan = scan(&fixtures_dir());
        let e = find(&scan, 52052).expect("52052.json 应该被解析出来");

        assert_eq!(e.pid, 52052);
        assert_eq!(e.session_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(e.name, "demo-proj-52052");
        assert_eq!(e.cwd, "C:\\work\\demo");
        assert_eq!(e.entrypoint, "claude-vscode");
        assert_eq!(e.kind, "interactive");
        assert_eq!(e.started_at, 1_785_395_815_772);
        assert_eq!(e.cli_version, "2.1.220");
    }

    #[test]
    fn same_cwd_different_session_id_both_kept() {
        // 实测本机有 4 个会话共享一个 cwd——不能按 cwd 去重，必须按 sessionId 区分。
        let scan = scan(&fixtures_dir());
        let a = find(&scan, 52052).expect("52052 应该在");
        let b = find(&scan, 52053).expect("52053 应该在");

        assert_eq!(a.cwd, b.cwd, "两条本该同一个 cwd，这是本用例的前提");
        assert_ne!(
            a.session_id, b.session_id,
            "cwd 相同不代表同一会话，必须按 sessionId 区分"
        );
    }

    #[test]
    fn missing_session_id_is_skipped_with_exactly_one_warning() {
        let scan = scan(&fixtures_dir());

        assert!(
            find(&scan, 52054).is_none(),
            "缺 sessionId 的条目不该出现在结果里"
        );

        let matching: Vec<_> = scan
            .warnings
            .iter()
            .filter(|w| w.detail.contains("52054.json"))
            .collect();
        assert_eq!(matching.len(), 1, "应该恰好产生一条针对 52054.json 的 warning");
        assert_eq!(matching[0].code, types::WarningCode::RosterEntryInvalid);
    }

    #[test]
    fn invalid_json_is_skipped_without_affecting_other_entries() {
        let scan = scan(&fixtures_dir());

        assert!(
            find(&scan, 52055).is_none(),
            "非法 JSON 的条目不该出现在结果里"
        );
        let matching: Vec<_> = scan
            .warnings
            .iter()
            .filter(|w| w.detail.contains("52055.json"))
            .collect();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].code, types::WarningCode::RosterEntryInvalid);

        // 关键断言：一个坏文件不能拖累其它文件的解析。
        assert!(
            find(&scan, 52052).is_some(),
            "52055.json 解析失败不该影响 52052.json 被正常解析"
        );
    }

    #[test]
    fn non_json_file_is_ignored_without_warning() {
        let scan = scan(&fixtures_dir());
        assert!(
            scan.warnings.iter().all(|w| !w.detail.contains("notes.txt")),
            "非 .json 文件必须被静默忽略，不该产生 warning"
        );
    }

    #[test]
    fn weird_file_name_still_parses_from_content() {
        // weird-name.json 文件名不是数字，pid 必须来自内容（pid: 1）而不是文件名。
        let scan = scan(&fixtures_dir());
        let e = find(&scan, 1).expect("weird-name.json 应该按内容里的 pid 解析出来");
        assert_eq!(e.session_id, "11111111-2222-3333-4444-555555555555");
    }

    #[test]
    fn missing_sessions_dir_returns_empty_without_warnings() {
        // 指向一个确定不存在的目录，模拟"这台机器从没跑过 claude"。
        let scan = scan(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/roster-does-not-exist"));
        assert!(scan.entries.is_empty());
        assert!(
            scan.warnings.is_empty(),
            "目录不存在是正常状态，不该产生 warning"
        );
    }

    #[test]
    fn warning_detail_never_leaks_file_content() {
        // 52055.json 的内容是 "{{{ not json"——detail 里绝不能出现这段文本，
        // 只能带文件名。这是隐私要求（types.rs 头部注释），也是本函数唯一
        // 需要小心的隐私边界。
        let scan = scan(&fixtures_dir());
        for w in &scan.warnings {
            assert!(
                !w.detail.contains("not json"),
                "warning detail 泄漏了文件内容：{}",
                w.detail
            );
        }
    }

    // ---- 以下用 parse_entry 直接喂字符串，覆盖用真实夹具不好精确构造的分支 ----

    #[test]
    fn parse_entry_defaults_missing_optional_fields_instead_of_dropping_the_record() {
        // 只给 pid + sessionId，其余字段全部缺失：仍然要解析成功，
        // 因为"有 pid 和 sessionId 就还有展示价值"。
        let json = r#"{"pid":9,"sessionId":"only-these-two"}"#;
        let e = parse_entry(json).expect("只有 pid/sessionId 也该解析成功");
        assert_eq!(e.pid, 9);
        assert_eq!(e.session_id, "only-these-two");
        assert_eq!(e.name, "");
        assert_eq!(e.cwd, "");
        assert_eq!(e.entrypoint, "");
        assert_eq!(e.kind, "");
        assert_eq!(e.started_at, 0);
        assert_eq!(e.cli_version, "");
    }

    #[test]
    fn parse_entry_rejects_missing_pid() {
        let json = r#"{"sessionId":"abc","cwd":"C:\\work"}"#;
        assert!(parse_entry(json).is_err());
    }

    #[test]
    fn parse_entry_rejects_missing_session_id() {
        let json = r#"{"pid":5,"cwd":"C:\\work"}"#;
        assert!(parse_entry(json).is_err());
    }

    #[test]
    fn parse_entry_rejects_malformed_json() {
        assert!(parse_entry("{{{ not json").is_err());
    }

    #[test]
    fn parse_entry_ignores_unknown_fields() {
        // peerProtocol / nameSource 之类我们不关心的字段来了就该忽略，
        // 不能因为多了字段就解析失败——未来版本大概率还会继续加字段。
        let json = r#"{"pid":1,"sessionId":"s","peerProtocol":1,"nameSource":"derived","somethingBrandNew":{"nested":true}}"#;
        assert!(parse_entry(json).is_ok());
    }
}
