//! Antigravity 会话发现：扫 `<install>/conversations/<cascadeId>.db`。
//!
//! 这一层**不打开任何数据库**，只看文件名和 metadata。真正的内容解析在
//! [`super::trajectory`]。分开的理由同 Codex 侧：发现阶段处理的是"哪些库值得
//! 打开"，那是纯粹的路径 + mtime 问题。
//!
//! ## 比 Codex 侧简单的地方
//!
//! Codex 那边要处理 `YYYY/MM/DD` 日期目录（还得小心那些目录名是本地日期、
//! 不能与当前日期比较）。这边是**平铺的一层**，直接 `stat` 拿 mtime 过滤。
//! 本机 18 个库全扫（开库 + 尾部查询）实测 21ms，不需要为成本做任何设计。
//!
//! ## 文件名自带 cascadeId
//!
//! `<cascadeId>.db`，不打开库就知道这个会话是谁。同 Codex 侧的收益。
//! 校验只做形状（uuid 的长度与连字符位置），不解析——id 就是个不透明标识。

use std::path::{Path, PathBuf};

use super::super::types::{FleetWarning, WarningCode};

/// 一个待解析的会话库。字段全部来自路径和 metadata，没有打开过数据库。
#[derive(Debug, Clone)]
pub struct DbEntry {
    pub path: PathBuf,
    /// 哪个安装 channel（`antigravity` / `antigravity-ide`）。
    /// 会原样进 IPC，前端用它区分徽章并拼进身份键。
    pub install: String,
    /// 文件名里的 cascadeId。实测与 `trajectory_meta.cascade_id` 一致。
    pub cascade_id: String,
    /// 文件 mtime，ms epoch。**这是 Antigravity 侧唯一可靠的"最后活动时间"**
    /// ——没有名册、没有进程，"这个会话还算不算数"只能靠它判断。
    pub mtime_ms: i64,
    /// 文件创建时间，ms epoch。拿不到就是 `None`。
    ///
    /// ⚠️ Windows 有创建时间，Linux 上 `created()` 常常返回 `Unsupported`。
    /// 所以这是 `Option`，由调用方决定拿不到时退到什么（实测退 mtime）。
    pub created_ms: Option<i64>,
    pub size_bytes: u64,
}

/// 一次发现扫描的结果。
#[derive(Debug, Default)]
pub struct DiscoverScan {
    pub entries: Vec<DbEntry>,
    pub warnings: Vec<FleetWarning>,
}

/// 从库文件名解析出 cascadeId。
///
/// 认的形状：`<uuid>.db`，uuid 是标准的 8-4-4-4-12 十六进制。
///
/// 返回 `None` 表示这不是一个会话库，调用方应当**静默跳过**：`conversations/`
/// 目录里混进别的文件是正常的（实测有 `-wal`/`-shm` sidecar），不值得报 warning。
pub fn parse_db_filename(name: &str) -> Option<&str> {
    let id = name.strip_suffix(".db")?;
    if !is_uuid_shaped(id) {
        return None;
    }
    Some(id)
}

/// uuid 形状校验：`8-4-4-4-12`，连字符位固定，其余必须是十六进制。
///
/// 逐位校验而不是引 regex/uuid 依赖——就这一处用，不值得。
fn is_uuid_shaped(s: &str) -> bool {
    const DASHES: [usize; 4] = [8, 13, 18, 23];
    if s.len() != 36 {
        return false;
    }
    s.bytes().enumerate().all(|(i, b)| {
        if DASHES.contains(&i) {
            b == b'-'
        } else {
            b.is_ascii_hexdigit()
        }
    })
}

fn ms_since_epoch(t: std::time::SystemTime) -> Option<i64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// 扫一个 install 的 `conversations/` 目录。
///
/// `retention_ms` 是保留窗口：mtime 早于 `now_ms - retention_ms` 的库不进列表。
/// `conversations/` 和 Codex 的 `sessions/`、Claude 的 `jobs/` 一样是**只增不删的
/// 归档**（本机最老的一条是 6 天前），不设窗口面板就是个垃圾堆。
///
/// 目录不存在时返回空结果且**不报 warning**：没装这个 channel 的机器上那目录
/// 本来就不存在，是正常状态。只有"目录在但读不了"才值得报。
pub fn discover_install(
    install: &str,
    install_dir: &Path,
    now_ms: i64,
    retention_ms: i64,
) -> DiscoverScan {
    let mut scan = DiscoverScan::default();
    let dir = install_dir.join("conversations");
    if !dir.is_dir() {
        return scan;
    }

    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) => {
            scan.warnings.push(FleetWarning::new(
                WarningCode::AntigravityDbUnreadable,
                format!("读取 {install} 的 conversations 目录失败：{}", e.kind()),
            ));
            return scan;
        }
    };

    let cutoff = now_ms.saturating_sub(retention_ms);

    for item in read.flatten() {
        let name = item.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(cascade_id) = parse_db_filename(name) else {
            continue;
        };
        let Ok(meta) = item.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime_ms = meta.modified().ok().and_then(ms_since_epoch).unwrap_or(0);
        if mtime_ms < cutoff {
            continue;
        }
        scan.entries.push(DbEntry {
            path: item.path(),
            install: install.to_string(),
            cascade_id: cascade_id.to_string(),
            mtime_ms,
            created_ms: meta.created().ok().and_then(ms_since_epoch),
            size_bytes: meta.len(),
        });
    }

    // 新的在前，同 Codex 侧。前端自己还会按状态分组，但一个稳定且有意义的
    // 初始顺序能让"没有 transcript 的会话"不至于随机跳位置。
    scan.entries
        .sort_by_key(|e| std::cmp::Reverse(e.mtime_ms));
    scan
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};

    const UUID: &str = "5fa07317-769c-4b99-b2b2-3ed8f027a75a";

    #[test]
    fn parses_a_real_db_filename() {
        assert_eq!(parse_db_filename(&format!("{UUID}.db")), Some(UUID));
    }

    #[test]
    fn rejects_wal_and_shm_sidecars() {
        // 实测：Antigravity 在跑的时候 conversations/ 里会多出这两个文件。
        // 它们必须被静默跳过，否则会被当成两个额外的会话。
        assert_eq!(parse_db_filename(&format!("{UUID}.db-wal")), None);
        assert_eq!(parse_db_filename(&format!("{UUID}.db-shm")), None);
        assert_eq!(parse_db_filename(&format!("{UUID}.db-journal")), None);
    }

    #[test]
    fn rejects_non_uuid_names() {
        assert_eq!(parse_db_filename("notauuid.db"), None);
        assert_eq!(parse_db_filename("index.db"), None);
        assert_eq!(parse_db_filename(".db"), None);
        assert_eq!(parse_db_filename(UUID), None, "没有 .db 后缀");
        // 长度对但连字符位置错
        assert_eq!(
            parse_db_filename("5fa07317769c-4b99-b2b2-3ed8f027a75a1.db"),
            None
        );
        // 非十六进制字符
        assert_eq!(
            parse_db_filename("zzzzzzzz-769c-4b99-b2b2-3ed8f027a75a.db"),
            None
        );
    }

    #[test]
    fn uuid_shape_is_strict_about_length() {
        assert!(is_uuid_shaped(UUID));
        assert!(!is_uuid_shaped(&UUID[..35]));
        assert!(!is_uuid_shaped(&format!("{UUID}a")));
    }

    #[test]
    fn missing_directory_is_silent_not_a_warning() {
        // 没装某个 channel 时那目录本来就不存在——为它刷 warning 只会淹没
        // 真正要紧的信息。
        let scan = discover_install(
            "antigravity",
            Path::new("C:\\definitely\\not\\here\\at\\all"),
            0,
            i64::MAX / 2,
        );
        assert!(scan.entries.is_empty());
        assert!(scan.warnings.is_empty(), "目录不存在不该报 warning");
    }

    // ---- 落地到真实文件系统的几条 ----

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "composer-fleet-agy-discover-test-{}-{tag}-{n}",
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

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    /// 造一个会话库文件（内容无所谓，这一层不打开它），可指定 mtime 往前推多少。
    fn write_db(install_dir: &Path, filename: &str, age_ms: u64) -> PathBuf {
        let dir = install_dir.join("conversations");
        std::fs::create_dir_all(&dir).expect("建 conversations 目录失败");
        let path = dir.join(filename);
        std::fs::write(&path, b"SQLite format 3\0").expect("写库失败");
        if age_ms > 0 {
            let when = SystemTime::now() - Duration::from_millis(age_ms);
            let f = std::fs::File::options()
                .write(true)
                .open(&path)
                .expect("重开库失败");
            f.set_modified(when).expect("设置 mtime 失败");
        }
        path
    }

    fn uuid_n(n: u8) -> String {
        format!("5fa07317-769c-4b99-b2b2-3ed8f027a7{n:02x}")
    }

    #[test]
    fn finds_a_fresh_db() {
        let tmp = TempDir::new("fresh");
        write_db(tmp.path(), &format!("{}.db", uuid_n(1)), 0);
        let scan = discover_install("antigravity", tmp.path(), now_ms(), 8 * 3600 * 1000);
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].cascade_id, uuid_n(1));
        assert_eq!(scan.entries[0].install, "antigravity");
        assert!(scan.warnings.is_empty());
    }

    #[test]
    fn drops_dbs_older_than_the_retention_window() {
        // 归档是只增不删的，不过滤面板就是垃圾堆。
        let tmp = TempDir::new("stale");
        write_db(tmp.path(), &format!("{}.db", uuid_n(1)), 0);
        write_db(tmp.path(), &format!("{}.db", uuid_n(2)), 9 * 3600 * 1000);
        let scan = discover_install("antigravity", tmp.path(), now_ms(), 8 * 3600 * 1000);
        assert_eq!(scan.entries.len(), 1, "9 小时前的那个该被筛掉");
        assert_eq!(scan.entries[0].cascade_id, uuid_n(1));
    }

    #[test]
    fn wal_sidecars_on_disk_do_not_become_extra_sessions() {
        // Antigravity 在跑的时候真的会在 conversations/ 里留下这两个文件。
        // 这条是端到端地钉住它们不会变成两张假卡片。
        let tmp = TempDir::new("wal");
        let id = uuid_n(1);
        write_db(tmp.path(), &format!("{id}.db"), 0);
        write_db(tmp.path(), &format!("{id}.db-wal"), 0);
        write_db(tmp.path(), &format!("{id}.db-shm"), 0);
        let scan = discover_install("antigravity", tmp.path(), now_ms(), 8 * 3600 * 1000);
        assert_eq!(scan.entries.len(), 1, "sidecar 不该被当成会话");
    }

    #[test]
    fn entries_are_sorted_newest_first() {
        let tmp = TempDir::new("sort");
        write_db(tmp.path(), &format!("{}.db", uuid_n(1)), 3000);
        write_db(tmp.path(), &format!("{}.db", uuid_n(2)), 0);
        write_db(tmp.path(), &format!("{}.db", uuid_n(3)), 1500);
        let scan = discover_install("antigravity", tmp.path(), now_ms(), 8 * 3600 * 1000);
        let ids: Vec<&str> = scan.entries.iter().map(|e| e.cascade_id.as_str()).collect();
        assert_eq!(ids, vec![uuid_n(2), uuid_n(3), uuid_n(1)]);
    }

    #[test]
    fn install_id_is_carried_onto_every_entry() {
        // install 要进 IPC 并拼成前端的身份键，漏了会让两个 channel 的卡片撞。
        let tmp = TempDir::new("install");
        write_db(tmp.path(), &format!("{}.db", uuid_n(1)), 0);
        let scan = discover_install("antigravity-ide", tmp.path(), now_ms(), 8 * 3600 * 1000);
        assert_eq!(scan.entries[0].install, "antigravity-ide");
    }

    #[test]
    fn empty_conversations_dir_yields_nothing_quietly() {
        let tmp = TempDir::new("empty");
        std::fs::create_dir_all(tmp.path().join("conversations")).unwrap();
        let scan = discover_install("antigravity", tmp.path(), now_ms(), 8 * 3600 * 1000);
        assert!(scan.entries.is_empty());
        assert!(scan.warnings.is_empty());
    }
}
