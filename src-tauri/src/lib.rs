// ============================================================
// Windows 专属：粘贴到外部窗口的底层实现。
// 思路：用一条后台线程持续记录“最近一个不属于本进程的前台窗口”，
// 因为用户点击浮窗按钮的那一刻，系统前台窗口已经变成了浮窗自己，
// 无法再用 GetForegroundWindow() 现查“刚才在用的软件”是谁，
// 所以必须提前、持续地追踪并缓存下来。
// ============================================================
#[cfg(windows)]
mod win32 {
    use enigo::Direction::{Click, Press, Release};
    use enigo::{Enigo, Key, Keyboard, Settings};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    /// 共享状态：最近一个非本应用窗口的前台句柄。
    /// HWND 本质是 *mut c_void，跨线程传递前转成 isize（isize 是 Send，指针不是）。
    pub struct LastForeground(pub Mutex<Option<isize>>);

    /// 后台追踪线程：约每 150ms 采样一次系统前台窗口。
    /// 若前台窗口的进程 PID 不是本进程，说明用户当前正在操作别的软件，
    /// 记下它的 HWND；浮窗弹出、抢占前台后，这个值仍保留着“抢占前”的目标窗口。
    pub fn track_foreground_loop(app: AppHandle) {
        let my_pid = std::process::id();
        loop {
            unsafe {
                let hwnd: HWND = GetForegroundWindow();
                if !hwnd.is_null() {
                    let mut pid: u32 = 0;
                    GetWindowThreadProcessId(hwnd, &mut pid as *mut u32);
                    if pid != my_pid {
                        if let Some(state) = app.try_state::<LastForeground>() {
                            if let Ok(mut guard) = state.0.lock() {
                                *guard = Some(hwnd as isize);
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// 把焦点还给“最近一个非本应用前台窗口”，然后模拟 Ctrl+V 完成粘贴。
    pub fn paste_to_active_window(app: &AppHandle) -> Result<(), String> {
        let target = {
            let state = app
                .try_state::<LastForeground>()
                .ok_or_else(|| "没有可粘贴的目标窗口".to_string())?;
            let guard = state.0.lock().map_err(|e| e.to_string())?;
            guard.ok_or_else(|| "没有可粘贴的目标窗口".to_string())?
        };

        unsafe {
            let hwnd = target as HWND;
            // 此刻本应用（浮窗）正持有系统前台，这个调用把前台还给目标窗口是合法的。
            SetForegroundWindow(hwnd);
        }
        // 等待焦点切换稳定，避免 Ctrl+V 打在切换动画/交接过程中丢失。
        std::thread::sleep(Duration::from_millis(60));

        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Release).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 阶段3：把剪贴板内容自动粘贴到“刚才聚焦的外部软件”。
/// 非 Windows 平台暂不支持，直接返回错误，保证跨平台可编译。
#[tauri::command]
fn paste_to_active_window(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        win32::paste_to_active_window(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = &app;
        Err("当前平台暂不支持自动粘贴".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Windows 专属状态：粘贴命令要用的“最近前台窗口”缓存。
    #[cfg(windows)]
    let builder = builder.manage(win32::LastForeground(std::sync::Mutex::new(None)));

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

                // Windows 专属：起一条后台线程持续追踪“最近一个非本应用的前台窗口”，
                // 供 paste_to_active_window 命令在用户开启自动粘贴开关时找到粘贴目标。
                #[cfg(windows)]
                {
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        win32::track_foreground_loop(app_handle);
                    });
                }

                Ok(())
            })
    };

    builder
        .invoke_handler(tauri::generate_handler![paste_to_active_window])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
