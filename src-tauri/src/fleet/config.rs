//! Claude Code 配置目录（默认 `~/.claude`）的定位。
//!
//! 单独成一个文件是因为这里有一条**容易漏掉、漏了就整个功能找不到数据**的规则：
//! `CLAUDE_CONFIG_DIR` 环境变量能把整个 `~/.claude` 搬到别处（官方 env-vars 文档
//! 列出的变量）。写死 home 目录在本机能跑，在改过这个变量的机器上直接瞎。
//!
//! 纯逻辑（`resolve_from`）与 Tauri 依赖（`resolve`）切开，前者可单测。

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 纯函数版：给定环境变量取值与 home 目录，算出配置目录。
///
/// - 环境变量有非空值（trim 后）→ 用它，**不再拼 `.claude`**
///   （用户给的就是配置目录本身，官方语义如此）
/// - 环境变量未设置 / 为空 / 只有空白 → `<home>/.claude`
/// - 连 home 都拿不到 → `None`
pub fn resolve_from(env_value: Option<&str>, home: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(raw) = env_value {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    home.map(|h| h.join(".claude"))
}

/// 真实环境版。用 Tauri 自带的 `path().home_dir()`，不额外引 `dirs` crate。
pub fn resolve(app: &AppHandle) -> Option<PathBuf> {
    let env_value = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let home = app.path().home_dir().ok();
    resolve_from(env_value.as_deref(), home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> Option<PathBuf> {
        Some(PathBuf::from("C:\\Users\\demo"))
    }

    #[test]
    fn falls_back_to_home_dot_claude_when_env_unset() {
        let got = resolve_from(None, home()).unwrap();
        assert_eq!(got, PathBuf::from("C:\\Users\\demo").join(".claude"));
    }

    #[test]
    fn env_var_wins_and_is_used_verbatim() {
        // 注意：不拼 .claude —— 用户给的就是配置目录本身
        let got = resolve_from(Some("D:\\cc-config"), home()).unwrap();
        assert_eq!(got, PathBuf::from("D:\\cc-config"));
    }

    #[test]
    fn empty_and_whitespace_env_var_is_treated_as_unset() {
        // 空字符串在 Windows 上很常见（`set CLAUDE_CONFIG_DIR=` 之后就是空值），
        // 当成"用了配置目录 ''"会让后续所有路径拼接都变成相对路径，必须回落。
        for raw in ["", "   ", "\t"] {
            let got = resolve_from(Some(raw), home()).unwrap();
            assert_eq!(
                got,
                PathBuf::from("C:\\Users\\demo").join(".claude"),
                "环境变量为 {raw:?} 时应回落到 home"
            );
        }
    }

    #[test]
    fn env_var_is_trimmed() {
        let got = resolve_from(Some("  D:\\cc-config  "), home()).unwrap();
        assert_eq!(got, PathBuf::from("D:\\cc-config"));
    }

    #[test]
    fn none_when_no_env_and_no_home() {
        assert!(resolve_from(None, None).is_none());
    }

    #[test]
    fn env_var_still_wins_when_home_missing() {
        // 拿不到 home 不该影响显式指定了配置目录的情况
        let got = resolve_from(Some("D:\\cc-config"), None).unwrap();
        assert_eq!(got, PathBuf::from("D:\\cc-config"));
    }
}
