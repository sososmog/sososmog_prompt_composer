//! Codex 会话发现：扫 `<codex_dir>/sessions/YYYY/MM/DD/rollout-*.jsonl`。
//!
//! 这一层**不打开任何文件**，只看目录名、文件名和 metadata。真正的内容解析在
//! [`super::rollout`]。分开是因为发现阶段要处理的是"哪些文件值得读"，那是个
//! 纯粹的路径 + mtime 问题，和 jsonl 长什么样无关。
//!
//! ## 为什么不用文件名里的时间
//!
//! 文件名形如 `rollout-2026-08-03T12-23-32-<uuid>.jsonl`，看着像个现成的起始
//! 时间，**但它是本地时间且不带时区**：同一个会话的 `session_meta.timestamp`
//! 实测是 `2026-08-03T04:23:32.963Z`，差整 8 小时（本机 UTC+8）。
//!
//! 拿它当 ms epoch 会在任何非 UTC 机器上错一个时区的量。所以这里只从文件名取
//! `session_id`，**时间一律用 mtime**（文件系统给的，本来就是 epoch）。
//! 真正的 `startedAt` 由 [`super::rollout`] 从 `session_meta.timestamp` 解析，
//! 那个带 `Z` 后缀，没有歧义。
//!
//! 日期目录（`YYYY/MM/DD`）同理，大概率也是本地日期。所以它**只用来排序**
//! （字典序恰好等于时间序），从不与当前日期做比较。

use std::path::{Path, PathBuf};

use super::super::types::{self, FleetWarning, WarningCode};

/// 一个待解析的 rollout 文件。字段全部来自路径和 metadata，没有读过文件内容。
#[derive(Debug, Clone)]
pub struct RolloutEntry {
    pub path: PathBuf,
    /// 从文件名解析出来的会话 id。实测与 `session_meta.session_id` 一致。
    pub session_id: String,
    /// 文件 mtime，ms epoch。**这是 Codex 侧唯一可靠的"最后活动时间"**。
    pub mtime_ms: i64,
    pub size_bytes: u64,
}

/// 一次发现扫描的结果。
#[derive(Debug, Default)]
pub struct DiscoverScan {
    pub entries: Vec<RolloutEntry>,
    pub warnings: Vec<FleetWarning>,
}

/// 文件名里 `rollout-` 之后、会话 id 之前那段时间戳的长度：
/// `2026-08-03T12-23-32-` 共 20 字符。
///
/// 用固定偏移而不是"取最后 36 个字符当 uuid"，是因为**时间戳格式比 id 格式更
/// 稳定**：Codex 换个 id 方案（更长的 uuid、加前缀）完全可能，而
/// `YYYY-MM-DDTHH-MM-SS` 这个形状变了的话文件名排序就废了，它没有理由变。
const TS_PREFIX_LEN: usize = 20;

/// 从 rollout 文件名解析出会话 id。
///
/// 认的形状：`rollout-<YYYY-MM-DDTHH-MM-SS>-<id>.jsonl`。时间段只做形状校验
/// （数字位是数字、分隔符在正确位置），不解析成时间——理由见模块文档。
///
/// 返回 `None` 表示这不是一个 rollout 文件，调用方应当静默跳过：`sessions/`
/// 目录里混进别的文件是完全正常的，不值得为它报 warning。
pub fn parse_rollout_filename(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("rollout-")?;
    let rest = rest.strip_suffix(".jsonl")?;

    if rest.len() <= TS_PREFIX_LEN {
        return None;
    }
    let (ts, id) = rest.split_at(TS_PREFIX_LEN);

    // `2026-08-03T12-23-32-`：数字位必须是数字，分隔符位必须严格对上。
    // 逐位校验而不是塞个正则，是为了不为这一处引入 regex 依赖。
    let bytes = ts.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        let ok = match i {
            4 | 7 | 13 | 16 | 19 => *b == b'-',
            10 => *b == b'T',
            _ => b.is_ascii_digit(),
        };
        if !ok {
            return None;
        }
    }

    // id 段不做形状校验（未来换 id 方案不该让整个功能瞎），但不能是空的，
    // 也不能带路径分隔符——后者理论上进不到文件名里，防御一下不亏。
    if id.is_empty() || id.contains(['/', '\\']) {
        return None;
    }
    Some(id)
}

/// 收集最近的日期目录，按字典序取最后 `max` 个。
///
/// `sessions/YYYY/MM/DD` 三层都是零填充的十进制，所以字典序恰好等于时间序，
/// 不用解析成日期就能排序——这也顺带回避了"目录名是本地日期还是 UTC 日期"
/// 这个我们答不上来的问题（见模块文档）。
///
/// 任何一层读不了就跳过那一层，不影响其它分支。
fn recent_date_dirs(sessions_dir: &Path, max: usize) -> Vec<PathBuf> {
    /// 列出一个目录下的子目录，按名字升序。
    fn sorted_subdirs(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        dirs
    }

    let mut days = Vec::new();
    for year in sorted_subdirs(sessions_dir) {
        for month in sorted_subdirs(&year) {
            days.extend(sorted_subdirs(&month));
        }
    }
    // 上面三层各自有序，但拼起来后仍需整体排一次：年目录之间的顺序保证了
    // 跨年有序，可 `days` 是按 (年,月) 分批 extend 的，批内有序批间也有序，
    // 实际上已经全局有序了——再排一次是防御，成本可以忽略（本机 5 个）。
    days.sort();

    if days.len() > max {
        days.drain(..days.len() - max);
    }
    days
}

/// 扫出值得解析的 rollout 文件。
///
/// - `codex_dir`：配置根目录（`~/.codex` 或 `CODEX_HOME`），不是 `sessions/`。
/// - `now_ms` / `retention_ms`：mtime 早于 `now_ms - retention_ms` 的直接丢弃。
///
/// `sessions/` 目录不存在时返回空结果且**不报 warning**——没装 Codex 的机器上
/// 这是正常状态。只有目录存在却读不了（权限一类）才报。
///
/// 结果按 mtime 降序（最近活动的在前），这样调用方即便要截断也是砍掉最旧的。
pub fn discover(codex_dir: &Path, now_ms: i64, retention_ms: i64) -> DiscoverScan {
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.is_dir() {
        return DiscoverScan::default();
    }

    let mut scan = DiscoverScan::default();
    let cutoff = now_ms.saturating_sub(retention_ms);

    for day_dir in recent_date_dirs(&sessions_dir, types::CODEX_DATE_DIRS_MAX) {
        let entries = match std::fs::read_dir(&day_dir) {
            Ok(e) => e,
            Err(e) => {
                // 单个日期目录读不了不该让整次扫描失败，但要留下线索——
                // 否则用户只会看到"我的 Codex 会话怎么不见了"而无从排查。
                scan.warnings.push(FleetWarning::new(
                    WarningCode::CodexRolloutUnreadable,
                    format!(
                        "读取 Codex 会话目录 {} 失败：{}",
                        day_dir.file_name().unwrap_or_default().to_string_lossy(),
                        e.kind()
                    ),
                ));
                continue;
            }
        };

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(session_id) = parse_rollout_filename(name) else {
                continue; // 不是 rollout 文件，静默跳过
            };

            // metadata 拿不到就跳过：既判不了是不是文件，也拿不到 mtime，
            // 没有任何可用信息，报 warning 也帮不上忙。
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }

            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            // mtime 拿不到（上面兜底成 0）的文件会被这一关筛掉，符合预期：
            // 一个连修改时间都读不出来的文件，我们也判不了它是不是还活着。
            if mtime_ms < cutoff {
                continue;
            }

            scan.entries.push(RolloutEntry {
                path: path.clone(),
                session_id: session_id.to_string(),
                mtime_ms,
                size_bytes: meta.len(),
            });
        }
    }

    // 降序：最近活动的在前。mtime 相同时按 session_id 定序，保证同一份数据
    // 每次扫描的顺序稳定（前端 keyed 更新对顺序抖动很敏感）。
    scan.entries.sort_by(|a, b| {
        b.mtime_ms
            .cmp(&a.mtime_ms)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    scan
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "composer-fleet-codex-discover-test-{}-{tag}-{n}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("创建测试临时目录失败");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 造一个 rollout 文件，可指定 mtime 相对现在往前推多少毫秒。
    fn write_rollout(codex_dir: &Path, day: &str, filename: &str, age_ms: u64) -> PathBuf {
        let day_dir = codex_dir.join("sessions").join(day);
        std::fs::create_dir_all(&day_dir).expect("建日期目录失败");
        let path = day_dir.join(filename);
        std::fs::write(&path, "{}\n").expect("写 rollout 失败");
        if age_ms > 0 {
            let when = SystemTime::now() - Duration::from_millis(age_ms);
            let f = std::fs::File::options()
                .write(true)
                .open(&path)
                .expect("重开 rollout 失败");
            f.set_modified(when).expect("设置 mtime 失败");
        }
        path
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    const REAL: &str = "rollout-2026-08-03T12-23-32-019fc5dc-d8d0-78c2-bdb7-427137d069e2.jsonl";

    // ---- 文件名解析 ----

    #[test]
    fn parses_session_id_from_a_real_filename() {
        assert_eq!(
            parse_rollout_filename(REAL),
            Some("019fc5dc-d8d0-78c2-bdb7-427137d069e2")
        );
    }

    #[test]
    fn rejects_files_that_are_not_rollouts() {
        for name in [
            "session_index.jsonl",              // 同目录下真实存在的别的文件
            "rollout-2026-08-03T12-23-32.jsonl", // 只有时间戳，没有 id
            "rollout-2026-08-03T12-23-32-abc.txt", // 后缀不对
            "prefix-rollout-2026-08-03T12-23-32-abc.jsonl", // 前缀不在开头
            "rollout-.jsonl",
            "",
        ] {
            assert_eq!(parse_rollout_filename(name), None, "{name:?} 不该被认成 rollout");
        }
    }

    #[test]
    fn rejects_malformed_timestamps() {
        // 逐位校验的意义：时间段形状不对说明这不是我们认识的命名方案，
        // 与其把后面一截当 id 用，不如整个跳过。
        for name in [
            "rollout-2026-08-03X12-23-32-abc.jsonl", // T 的位置不是 T
            "rollout-2026_08_03T12-23-32-abc.jsonl", // 日期分隔符不对
            "rollout-20xx-08-03T12-23-32-abc.jsonl", // 数字位不是数字
            "rollout-2026-08-03T12-23-32xabc.jsonl", // 时间与 id 之间不是 -
        ] {
            assert_eq!(parse_rollout_filename(name), None, "{name:?} 时间段非法");
        }
    }

    #[test]
    fn does_not_assume_the_id_is_a_uuid() {
        // id 段刻意不校验形状：Codex 换 id 方案不该让整个功能瞎。
        assert_eq!(
            parse_rollout_filename("rollout-2026-08-03T12-23-32-thread_42.jsonl"),
            Some("thread_42")
        );
    }

    // ---- 目录扫描 ----

    #[test]
    fn missing_sessions_dir_is_silent() {
        // 没装 Codex 的机器：不是错误，不该产 warning。
        let tmp = TempDir::new("no-sessions");
        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        assert!(scan.entries.is_empty());
        assert!(scan.warnings.is_empty(), "没装 Codex 不该报 warning");
    }

    #[test]
    fn finds_a_fresh_rollout() {
        let tmp = TempDir::new("fresh");
        write_rollout(tmp.path(), "2026/08/03", REAL, 0);

        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(
            scan.entries[0].session_id,
            "019fc5dc-d8d0-78c2-bdb7-427137d069e2"
        );
        assert!(scan.entries[0].size_bytes > 0);
        assert!(scan.warnings.is_empty());
    }

    #[test]
    fn drops_rollouts_older_than_the_retention_window() {
        let tmp = TempDir::new("stale");
        // 一个新的、一个超窗口的。
        write_rollout(tmp.path(), "2026/08/03", REAL, 0);
        write_rollout(
            tmp.path(),
            "2026/08/03",
            "rollout-2026-08-03T01-00-00-old-session.jsonl",
            (types::CODEX_RETENTION_MS as u64) + 60_000,
        );

        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        assert_eq!(scan.entries.len(), 1, "超窗口的那条应该被筛掉");
        assert_eq!(
            scan.entries[0].session_id,
            "019fc5dc-d8d0-78c2-bdb7-427137d069e2"
        );
    }

    #[test]
    fn ignores_non_rollout_files_in_the_same_dir() {
        let tmp = TempDir::new("mixed");
        write_rollout(tmp.path(), "2026/08/03", REAL, 0);
        let day = tmp.path().join("sessions").join("2026/08/03");
        std::fs::write(day.join("notes.txt"), "x").unwrap();
        std::fs::write(day.join("session_index.jsonl"), "{}").unwrap();
        std::fs::create_dir_all(day.join("rollout-2026-08-03T12-23-32-adir.jsonl")).unwrap();

        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        assert_eq!(scan.entries.len(), 1, "只有真正的 rollout 文件该被收进来");
        assert!(scan.warnings.is_empty(), "混着别的文件是正常的，不该报 warning");
    }

    #[test]
    fn only_the_most_recent_date_dirs_are_scanned() {
        let tmp = TempDir::new("date-cap");
        // 造 5 天，每天一个全新文件。CODEX_DATE_DIRS_MAX = 3，只该看最后三天。
        let days = [
            ("2026/06/12", "aaa"),
            ("2026/07/28", "bbb"),
            ("2026/08/01", "ccc"),
            ("2026/08/02", "ddd"),
            ("2026/08/03", "eee"),
        ];
        for (day, id) in days {
            write_rollout(
                tmp.path(),
                day,
                &format!("rollout-2026-08-03T12-23-32-{id}.jsonl"),
                0,
            );
        }

        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        let mut ids: Vec<&str> = scan.entries.iter().map(|e| e.session_id.as_str()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["ccc", "ddd", "eee"],
            "只该扫最近 {} 个日期目录",
            types::CODEX_DATE_DIRS_MAX
        );
    }

    #[test]
    fn date_dirs_are_ordered_lexicographically_across_years() {
        // 跨年时不能按"月份大的更新"排：2025/12 比 2026/01 旧。
        let tmp = TempDir::new("cross-year");
        for (day, id) in [
            ("2025/11/30", "old1"),
            ("2025/12/31", "old2"),
            ("2026/01/01", "new1"),
            ("2026/01/02", "new2"),
        ] {
            write_rollout(
                tmp.path(),
                day,
                &format!("rollout-2026-08-03T12-23-32-{id}.jsonl"),
                0,
            );
        }

        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        let mut ids: Vec<&str> = scan.entries.iter().map(|e| e.session_id.as_str()).collect();
        ids.sort();
        // 取最后 3 个日期目录 = 2025/12/31、2026/01/01、2026/01/02。
        // 若按"月份大的更新"排，2025/11 和 2025/12 会挤掉 2026 那两天。
        assert_eq!(ids, vec!["new1", "new2", "old2"]);
    }

    #[test]
    fn entries_are_sorted_by_mtime_descending() {
        let tmp = TempDir::new("sort");
        write_rollout(
            tmp.path(),
            "2026/08/03",
            "rollout-2026-08-03T12-23-32-older.jsonl",
            60_000,
        );
        write_rollout(
            tmp.path(),
            "2026/08/03",
            "rollout-2026-08-03T12-23-32-newer.jsonl",
            0,
        );

        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        let ids: Vec<&str> = scan.entries.iter().map(|e| e.session_id.as_str()).collect();
        assert_eq!(ids, vec!["newer", "older"], "最近活动的排前面");
    }

    #[test]
    fn junk_dir_names_do_not_break_the_scan() {
        // sessions/ 下混进非日期目录（实测没见过，但目录是用户可写的）。
        let tmp = TempDir::new("junk-dirs");
        write_rollout(tmp.path(), "2026/08/03", REAL, 0);
        std::fs::create_dir_all(tmp.path().join("sessions").join("tmp-garbage")).unwrap();
        std::fs::write(tmp.path().join("sessions").join("stray.json"), "{}").unwrap();

        let scan = discover(tmp.path(), now_ms(), types::CODEX_RETENTION_MS);
        assert_eq!(scan.entries.len(), 1);
    }
}
