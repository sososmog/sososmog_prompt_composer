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

/// Antigravity 版，回落到 `<home>/.gemini`。
///
/// ⚠️ **`GEMINI_HOME` 未经证实**。Claude 的 `CLAUDE_CONFIG_DIR` 有官方文档、
/// Codex 的 `CODEX_HOME` 能从 `base_instructions` 里反推出来，而 Antigravity
/// 这边两样都没有——这个变量名是照着前两家的惯例猜的。成本只有几行，且与既有
/// 结构一致，所以留着当防御；但**不要**因为这里有它就以为它被验证过。
pub fn resolve_antigravity_from(
    env_value: Option<&str>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    resolve_with(env_value, home, ".gemini")
}

/// Antigravity 的两个安装 channel。
///
/// **这是与 Claude/Codex 最大的结构差异：不是一个根目录，是两个。**
/// 正式版和 IDE 版在本机并存且数据完全同构（实测两边 schema 一致、
/// cascadeId 不重叠），采集器写一份扫两个根就行。
///
/// 元组的第一项是 install 标识，会原样进 IPC 的 `AgentSession.install`，
/// 前端用它区分徽章文案并拼进 keyed 更新的身份键。
pub const ANTIGRAVITY_INSTALLS: [&str; 2] = ["antigravity", "antigravity-ide"];

/// 把 `.gemini` 根展开成各 install 的会话目录候选。
///
/// **不做 `is_dir()` 过滤**，纯拼路径好单测；存在性由调用方判断
/// （同 `resolve_codex` 在 `mod.rs` 里 `.filter(|d| d.is_dir())` 的分工）。
pub fn antigravity_installs(gemini_root: &std::path::Path) -> Vec<(String, PathBuf)> {
    ANTIGRAVITY_INSTALLS
        .iter()
        .map(|name| ((*name).to_string(), gemini_root.join(name)))
        .collect()
}

/// Antigravity 的项目定义目录。**两个 install 共享这一份**（实测
/// `~/.gemini/config/projects/`，不在任何 install 目录下面）。
pub fn antigravity_projects_dir(gemini_root: &std::path::Path) -> PathBuf {
    gemini_root.join("config").join("projects")
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

/// Antigravity 的真实环境版。返回的是 `.gemini` 根，不是某个 install。
pub fn resolve_antigravity(app: &AppHandle) -> Option<PathBuf> {
    let env_value = std::env::var("GEMINI_HOME").ok();
    let home = app.path().home_dir().ok();
    resolve_antigravity_from(env_value.as_deref(), home)
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

    // ---- Antigravity 侧 ----

    #[test]
    fn antigravity_falls_back_to_home_dot_gemini_when_env_unset() {
        let got = resolve_antigravity_from(None, home()).unwrap();
        assert_eq!(got, PathBuf::from("C:\\Users\\demo").join(".gemini"));
    }

    #[test]
    fn antigravity_env_var_wins_and_is_used_verbatim() {
        let got = resolve_antigravity_from(Some("D:\\gemini-home"), home()).unwrap();
        assert_eq!(got, PathBuf::from("D:\\gemini-home"));
    }

    #[test]
    fn antigravity_empty_and_whitespace_env_var_is_treated_as_unset() {
        for raw in ["", "   ", "\t"] {
            let got = resolve_antigravity_from(Some(raw), home()).unwrap();
            assert_eq!(
                got,
                PathBuf::from("C:\\Users\\demo").join(".gemini"),
                "GEMINI_HOME 为 {raw:?} 时应回落到 home"
            );
        }
    }

    #[test]
    fn antigravity_none_when_no_env_and_no_home() {
        assert!(resolve_antigravity_from(None, None).is_none());
    }

    #[test]
    fn antigravity_expands_to_both_installs() {
        // 双安装是这一侧的结构核心：漏掉任何一个都会让一半会话不显示，
        // 而那种缺失在真机上很难看出来（用户只会觉得"有几个会话没出现"）。
        let root = PathBuf::from("C:\\Users\\demo\\.gemini");
        let installs = antigravity_installs(&root);
        assert_eq!(installs.len(), 2);
        assert_eq!(installs[0].0, "antigravity");
        assert_eq!(installs[0].1, root.join("antigravity"));
        assert_eq!(installs[1].0, "antigravity-ide");
        assert_eq!(installs[1].1, root.join("antigravity-ide"));
    }

    #[test]
    fn antigravity_install_ids_are_distinct() {
        // 防呆：两个 install 的标识如果相同，前端的身份键就会撞，
        // E6 的加权 LIS 会把两个会话的卡片串在一起。
        let root = PathBuf::from("/home/demo/.gemini");
        let installs = antigravity_installs(&root);
        assert_ne!(installs[0].0, installs[1].0);
        assert_ne!(installs[0].1, installs[1].1);
    }

    #[test]
    fn antigravity_projects_dir_is_shared_not_per_install() {
        // 实测 projects/ 在 ~/.gemini/config/ 下，**不在** install 目录里。
        // 写成 <root>/antigravity/config/projects 会让项目名全查不到。
        let root = PathBuf::from("C:\\Users\\demo\\.gemini");
        let got = antigravity_projects_dir(&root);
        assert_eq!(got, root.join("config").join("projects"));
        for (_, install_dir) in antigravity_installs(&root) {
            assert!(
                !got.starts_with(&install_dir),
                "projects 目录不该落在 install 目录 {install_dir:?} 下面"
            );
        }
    }

    #[test]
    fn codex_and_claude_resolve_to_different_dirs_under_the_same_home() {
        // 防呆：抽 `resolve_with` 时把 dir_name 传错（两边都拼 .claude）
        // 是最容易犯且最难发现的错——两个函数各自看都"对"，只有并排比才露馅。
        let claude = resolve_from(None, home()).unwrap();
        let codex = resolve_codex_from(None, home()).unwrap();
        let antigravity = resolve_antigravity_from(None, home()).unwrap();
        assert_ne!(claude, codex);
        assert_ne!(claude, antigravity);
        assert_ne!(codex, antigravity);
        assert!(claude.ends_with(".claude"));
        assert!(codex.ends_with(".codex"));
        assert!(antigravity.ends_with(".gemini"));
    }
}
