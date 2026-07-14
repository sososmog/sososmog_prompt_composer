#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // 全局快捷键仅在桌面端可用，移动端跳过相关插件与注册逻辑
    #[cfg(desktop)]
    let builder = {
        use tauri::Manager;
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

        // Ctrl+Alt+C：呼出/隐藏浮窗
        let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyC);
        let handler_shortcut = toggle_shortcut.clone();

        builder
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        // 只在按下时响应一次，避免按下+抬起触发两次
                        if shortcut == &handler_shortcut && event.state() == ShortcutState::Pressed {
                            if let Some(window) = app.get_webview_window("float") {
                                let is_visible = window.is_visible().unwrap_or(false);
                                if is_visible {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    })
                    .build(),
            )
            .setup(move |app| {
                // 注册失败（如 Ctrl+Alt+C 已被其他程序全局占用）不应导致应用启动崩溃，
                // 仅打日志并继续，用户此时只是少了这个热键。
                if let Err(e) = app.global_shortcut().register(toggle_shortcut.clone()) {
                    eprintln!("全局快捷键 Ctrl+Alt+C 注册失败（可能已被占用）：{e}");
                }
                Ok(())
            })
    };

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
