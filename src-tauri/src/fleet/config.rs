//! 各 provider 配置目录（Claude Code 的 `~/.claude`、Codex 的 `~/.codex`）的定位。
//!
//! 单独成一个文件是因为这里有一条**容易漏掉、漏了就整个功能找不到数据**的规则：
//! `CLAUDE_CONFIG_DIR` 环境变量能把整个 `~/.claude` 搬到别处（官方 env-vars 文档
//! 列出的变量）。写死 home 目录在本机能跑，在改过这个变量的机器上直接瞎。
//! Codex 同理，对应的变量是 `CODEX_HOME`。
//!
//! 纯逻辑（`resolve_from` / `resolve_codex_from`）与 Tauri 依赖（`resolve` /
//! `resolve_codex`）切开，前者可单测。

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 两个 provider 共用的解析规则，差别只有回落时拼哪个目录名。
///
/// 抽出来而不是给 `resolve_from` 加参数，是为了不动已有调用点和已有单测——
/// 那几条测试钉的是 Claude 的语义，不该因为加了个 Codex 就跟着改签名。
fn resolve_with(env_value: Option<&str>, home: Option<PathBuf>, dir_name: &str) -> Option<PathBuf> {
    if let Some(raw) = env_value {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    home.map(|h| h.join(dir_name))
}

/// 纯函数版：给定环境变量取值与 home 目录，算出配置目录。
///
/// - 环境变量有非空值（trim 后）→ 用它，**不再拼 `.claude`**
///   （用户给的就是配置目录本身，官方语义如此）
/// - 环境变量未设置 / 为空 / 只有空白 → `<home>/.claude`
/// - 连 home 都拿不到 → `None`
pub fn resolve_from(env_value: Option<&str>, home: Option<PathBuf>) -> Option<PathBuf> {
    resolve_with(env_value, home, ".claude")
}

/// Codex 版，规则与 [`resolve_from`] 逐条对齐，只是回落到 `<home>/.codex`。
///
/// `CODEX_HOME` 的存在是从实测数据里反推出来的：rollout 的 `base_instructions`
/// 里明写着 `$CODEX_HOME/automations/*/automation.toml`，说明 Codex 自己就用这个
/// 变量定位配置根目录。语义按 `CLAUDE_CONFIG_DIR` 的惯例处理（给的就是目录本身，
/// 不再往下拼 `.codex`）。
pub fn resolve_codex_from(env_value: Option<&str>, home: Option<PathBuf>) -> Option<PathBuf> {
    resolve_with(env_value, home, ".codex")
}

/// 真实环境版。用 Tauri 自带的 `path().home_dir()`，不额外引 `dirs` crate。
pub fn resolve(app: &AppHandle) -> Option<PathBuf> {
    let env_value = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let home = app.path().home_dir().ok();
    resolve_from(env_value.as_deref(), home)
}

/// Codex 的真实环境版。
pub fn resolve_codex(app: &AppHandle) -> Option<PathBuf> {
    let env_value = std::env::var("CODEX_HOME").ok();
    let home = app.path().home_dir().ok();
    resolve_codex_from(env_value.as_deref(), home)
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

    // ---- Codex 侧：规则与上面逐条对齐，但必须单独钉一遍 ----
    //
    // 共用 `resolve_with` 不等于两边行为永远一致：以后任何一边要加特例，
    // 都得先让对面这几条测试变红，而不是悄悄改掉双方的语义。

    #[test]
    fn codex_falls_back_to_home_dot_codex_when_env_unset() {
        let got = resolve_codex_from(None, home()).unwrap();
        assert_eq!(got, PathBuf::from("C:\\Users\\demo").join(".codex"));
    }

    #[test]
    fn codex_env_var_wins_and_is_used_verbatim() {
        // 同 CLAUDE_CONFIG_DIR：给的就是配置目录本身，不再往下拼 .codex
        let got = resolve_codex_from(Some("D:\\codex-home"), home()).unwrap();
        assert_eq!(got, PathBuf::from("D:\\codex-home"));
    }

    #[test]
    fn codex_empty_and_whitespace_env_var_is_treated_as_unset() {
        for raw in ["", "   ", "\t"] {
            let got = resolve_codex_from(Some(raw), home()).unwrap();
            assert_eq!(
                got,
                PathBuf::from("C:\\Users\\demo").join(".codex"),
                "CODEX_HOME 为 {raw:?} 时应回落到 home"
            );
        }
    }

    #[test]
    fn codex_env_var_is_trimmed() {
        let got = resolve_codex_from(Some("  D:\\codex-home  "), home()).unwrap();
        assert_eq!(got, PathBuf::from("D:\\codex-home"));
    }

    #[test]
    fn codex_none_when_no_env_and_no_home() {
        assert!(resolve_codex_from(None, None).is_none());
    }

    #[test]
    fn codex_and_claude_resolve_to_different_dirs_under_the_same_home() {
        // 防呆：抽 `resolve_with` 时把 dir_name 传错（两边都拼 .claude）
        // 是最容易犯且最难发现的错——两个函数各自看都"对"，只有并排比才露馅。
        let claude = resolve_from(None, home()).unwrap();
        let codex = resolve_codex_from(None, home()).unwrap();
        assert_ne!(claude, codex);
        assert!(claude.ends_with(".claude"));
        assert!(codex.ends_with(".codex"));
    }
}
