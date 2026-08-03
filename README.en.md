# Composer · Modular Prompt Builder

A desktop app for assembling AI prompts like building blocks. Available on Windows, macOS, and Linux.

<!-- Uncomment when a screenshot is available:
![Composer main interface](docs/screenshot.png)
-->

## Installation

Download the latest release from [GitHub Releases](https://github.com/sososmog/sososmog_prompt_composer/releases):

| Platform | Installer |
| --- | --- |
| Windows | `.exe` (recommended) or `.msi` |
| macOS | `.dmg` |
| Linux | `.deb` / `.rpm` / `.AppImage` |

> Windows 10 users: if the app shows a blank window, install [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (built into Windows 11).

The app checks for updates automatically on launch — when a new version is found, it only shows a notification in the settings page. **It never upgrades automatically.** You can also disable update checks in Settings > General.

---

## Features

### Modular Assembly

Break your prompts into independent modules (role, scenario, question, rules, workflow, output format, etc.) and freely combine them in the assembly area. Each module can be renamed, edited, enabled/disabled, and reordered by drag-and-drop.

### Variables

Write `{{name}}` in any module to create a variable. Fill in values in the right panel. Variable names are shared across languages; values are maintained separately for each language.

### Bilingual (Chinese & English)

Both the interface and content support Chinese and English. The right panel includes a token estimation card comparing token counts across both languages at a glance.

### Inline Autocomplete

As you type, the editor shows ghost text previewing what comes next. Press `Tab` / `→` to accept, `Esc` to dismiss. Candidates come from:

- Built-in common phrases and quick paragraphs
- **Local self-learning engine** — every time you copy or export text, the app learns clause fragments from it, getting more attuned to your writing style over time

Self-learning data is stored locally only. You can view, delete, import/export it in Settings > Self-Learning, or turn it off entirely (disabling only stops learning; existing data is preserved).

### Common Phrases & Quick Paragraphs

- Each module has a list of common phrases below it — click to insert at cursor, fully customizable
- Quick Paragraphs is a separate section with group management (two levels: group > paragraph) — click to insert preset text

### One-Click Translation

Translate the current language's content to the other language in one click. Built-in support for Google Gemini, GLM (Zhipu), Groq, OpenRouter, and custom OpenAI-compatible endpoints. Select your provider and enter your API key in the settings panel. Code blocks are automatically skipped during translation, and failed translations never alter existing content.

### Import & Export

Bundle your module library, variables, and settings into a `.json` backup file. On import, you can preview a summary and the app merges intelligently by name. **API keys are never exported, and importing never clears your existing keys.**

### Floating Window

Press the global hotkey (default `Ctrl+Alt+C`, customizable) to summon a pinned mini-window anytime — quickly copy content without switching back to the main window.

- Inline autocomplete works here too, sharing the same candidate pool as the main window
- Collapse into a floating bubble to save screen space; click to restore, hold to drag
- Window position and size are remembered
- **Auto-paste**: when enabled, clicking content in the floating window automatically switches back to your previous window and pastes (verified on Windows, experimental on macOS)

### Agent Monitor Panel

The floating window's second tab — a live view of AI coding agent sessions running on your machine. Currently supports **Claude Code, Codex, and Antigravity**. Can be toggled in the settings panel.

- Each session gets a card showing: status, session title, git branch, model, runtime, and context token usage
- Grouped by status with "waiting for your input" sessions pinned to the top, plus a badge count on the tab
- Claude Code sessions can be expanded to view the subagent tree — what each subagent is working on, their token usage and active time
- When background subagents are still running, the card shows this separately from the main session status

This panel is **observe-only** — it never starts, stops, or interferes with any session, and writes nothing to any agent's configuration directory. When data can't be read, it shows "status unknown" rather than guessing.

### Other

- **Onboarding guide**: highlight overlay on first launch, contextual tips near features
- **Copy / Export**: one-click copy to clipboard, or export as `.md` file
- **Local persistence**: all content is saved locally and restored when you reopen the app
- **Dark / Light theme**: manual toggle, floating window follows the main window automatically

---

## Data Storage

All data is stored locally — nothing is uploaded:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\com.composer.app\` |
| macOS | `~/Library/Application Support/com.composer.app/` |
| Linux | `~/.config/com.composer.app/` |

---

## FAQ

**The hotkey `Ctrl+Alt+C` doesn't summon the floating window**
The hotkey may already be taken by another program. Rebind it in the settings panel — if registration fails, it automatically rolls back and tells you why.

**Auto-paste doesn't work / says "no target window"**
You need to switch to the target app first, then summon the floating window so the app can remember your previous window. On macOS, you also need to grant accessibility permission in System Settings > Privacy & Security > Accessibility.

**Translation fails**
Make sure you've selected a provider and entered a valid API key and model name in the settings panel. Network access to the corresponding service is required. Failed translations never alter existing content.

**API keys are gone after importing a config**
This is by design — exports never include API keys, and imports never clear existing keys. After switching machines, re-enter your keys manually.

**Can't detect new versions**
Make sure your network can reach GitHub. If a release was just published, wait a few minutes for the CI build to complete.

**Agent panel shows "status unknown"**
The panel reads session files written locally by each agent. These are undocumented internal formats that may break after upstream updates. This doesn't affect any other functionality.

---

## Contributing

Contributions welcome. For development setup, project structure, testing, and release workflow, see [docs/development.md](docs/development.md).

## License

MIT
