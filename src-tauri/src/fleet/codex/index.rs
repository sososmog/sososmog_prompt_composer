//! `<codex_dir>/session_index.jsonl` —— 会话标题的来源。
//!
//! 每行形如 `{"id":"019f…","thread_name":"你好","updated_at":"2026-07-31T10:17:20.8656376Z"}`。
//! 我们只要 `id → thread_name` 这一层映射：Codex 自己不往 rollout 里写标题，
//! 这个文件是唯一能拿到「这个会话叫什么」的地方。
//!
//! ## 它不全，所以只能当补充
//!
//! 实测 27 行 vs 56 个 rollout（推测只索引 Codex Desktop 建的线程）。
//! **绝不能拿它当发现源**——那会让一半会话凭空消失。查不到标题的会话由上层
//! 退回「最后一条提问」或 cwd 的目录名。
//!
//! ## 为什么用尾部窗口而不是整读
//!
//! 现在才 3.4KB，但它和 `sessions/` 一样是只增的。用 [`tail_lines`] 读尾部有两个
//! 好处：天然给内存封顶，且最近的会话本来就在文件末尾——正是我们要显示的那些。
//! 代价是超长文件里的老会话查不到标题，而那些会话早就被保留窗口筛掉了。

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::super::transcript::tail_lines;
use super::super::types;

/// 索引文件的尾部读取上限。
///
/// 3.4KB 的现状下这个值等于"整读"。给到 256KB 是为了它长大以后仍然只占一点点
/// 内存——按每行约 130 字节算，256KB 能覆盖最近约 2000 个会话，
/// 而保留窗口只会让我们关心其中最近的几个。
const INDEX_TAIL_BYTES: u64 = 256 * 1024;

/// 读出 `sessionId → 标题` 的映射。
///
/// 文件不存在 / 读不了 / 全是坏行，一律返回空 map 且**不报 warning**：
/// 标题只是锦上添花，没有它会话照常显示（退回提问或目录名）。为一个可选的
/// 展示字段刷 warning，只会淹没真正要紧的告警。
pub fn load_titles(codex_dir: &Path) -> HashMap<String, String> {
    let path = codex_dir.join("session_index.jsonl");
    let mut out = HashMap::new();

    let Ok(tail) = tail_lines(&path, INDEX_TAIL_BYTES) else {
        return out;
    };

    // 反向扫描 + `or_insert`：同一个 id 若出现多次（更新时追加新行），
    // 保留**最后**写的那条。实测目前 27 行没有重复 id，但 `updated_at` 字段的
    // 存在说明它是会被更新的，不该赌它永远不重复。
    for line in tail.lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(id) = v.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = v.get("thread_name").and_then(Value::as_str) else {
            continue;
        };
        // 空标题当没有：显示一个空白标题比退回目录名更糟。
        if name.trim().is_empty() {
            continue;
        }
        out.entry(id.to_string())
            .or_insert_with(|| types::truncate_text(name));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            static C: AtomicU64 = AtomicU64::new(0);
            let n = C.fetch_add(1, Ordering::Relaxed);
            let d = std::env::temp_dir().join(format!(
                "composer-fleet-codex-index-test-{}-{tag}-{n}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
        fn write_index(&self, rows: &[&str]) {
            std::fs::write(
                self.0.join("session_index.jsonl"),
                format!("{}\n", rows.join("\n")),
            )
            .unwrap();
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_titles_from_a_realistic_index() {
        let dir = TempDir::new("basic");
        dir.write_index(&[
            r#"{"id":"019fb7ad","thread_name":"你好","updated_at":"2026-07-31T10:17:20.8656376Z"}"#,
            r#"{"id":"019fc5dc","thread_name":"Review project and await tasks","updated_at":"2026-08-03T04:23:49.6635915Z"}"#,
        ]);

        let titles = load_titles(&dir.0);
        assert_eq!(titles.get("019fb7ad").map(String::as_str), Some("你好"));
        assert_eq!(
            titles.get("019fc5dc").map(String::as_str),
            Some("Review project and await tasks")
        );
    }

    #[test]
    fn a_missing_index_file_is_not_an_error() {
        // 没装 Codex、或这个版本不写索引：会话照常显示，只是没标题。
        let dir = TempDir::new("missing");
        assert!(load_titles(&dir.0).is_empty());
    }

    #[test]
    fn later_rows_win_for_a_repeated_id() {
        // updated_at 字段的存在说明条目会被更新，不能赌它永远不重复。
        let dir = TempDir::new("dup");
        dir.write_index(&[
            r#"{"id":"same","thread_name":"旧标题"}"#,
            r#"{"id":"same","thread_name":"新标题"}"#,
        ]);
        assert_eq!(
            load_titles(&dir.0).get("same").map(String::as_str),
            Some("新标题")
        );
    }

    #[test]
    fn bad_rows_are_skipped_without_killing_the_good_ones() {
        let dir = TempDir::new("mixed");
        dir.write_index(&[
            "{ not json",
            r#"{"id":"no-name"}"#,
            r#"{"thread_name":"没有 id"}"#,
            r#"{"id":"blank","thread_name":"   "}"#,
            r#"{"id":"ok","thread_name":"正常"}"#,
        ]);

        let titles = load_titles(&dir.0);
        assert_eq!(titles.len(), 1, "只有一条是完整可用的");
        assert_eq!(titles.get("ok").map(String::as_str), Some("正常"));
    }

    #[test]
    fn long_titles_are_truncated() {
        let dir = TempDir::new("long");
        let long = "标".repeat(types::TEXT_LIMIT + 50);
        dir.write_index(&[&format!(r#"{{"id":"x","thread_name":"{long}"}}"#)]);

        let got = load_titles(&dir.0);
        let title = got.get("x").unwrap();
        assert!(
            title.chars().count() <= types::TEXT_LIMIT + 1,
            "应截断到 TEXT_LIMIT（+1 是省略号）"
        );
        assert!(title.ends_with('…'));
    }
}
