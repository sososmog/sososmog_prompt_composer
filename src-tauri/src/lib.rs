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
        GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
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

    /// 模拟一次 Ctrl+V。单独抽出来是为了在失败时可以重试一次。
    fn press_ctrl_v() -> Result<(), String> {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Release).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 把焦点还给“最近一个非本应用前台窗口”，然后模拟 Ctrl+V 完成粘贴。
    /// delay_ms：SetForegroundWindow 后、模拟按键前的等待时长，避免焦点切换
    /// 动画/交接尚未完成时 Ctrl+V 就打过去而丢失；默认 60ms。
    pub fn paste_to_active_window(app: &AppHandle, delay_ms: Option<u64>) -> Result<(), String> {
        let target = {
            let state = app
                .try_state::<LastForeground>()
                .ok_or_else(|| "没有可粘贴的目标窗口".to_string())?;
            let guard = state.0.lock().map_err(|e| e.to_string())?;
            guard.ok_or_else(|| "没有可粘贴的目标窗口".to_string())?
        };

        unsafe {
            let hwnd = target as HWND;
            // 目标窗口可能已经被用户关闭（进程退出/窗口销毁），此时 HWND 是野句柄，
            // 贸然 SetForegroundWindow + 粘贴要么无效要么错误地抢占了别的窗口，
            // 所以先校验窗口是否仍然存在。
            if IsWindow(hwnd) == 0 {
                return Err("目标窗口已关闭".to_string());
            }
            // 此刻本应用（浮窗）正持有系统前台，这个调用把前台还给目标窗口是合法的。
            SetForegroundWindow(hwnd);
        }
        // 等待焦点切换稳定，避免 Ctrl+V 打在切换动画/交接过程中丢失。
        std::thread::sleep(Duration::from_millis(delay_ms.unwrap_or(60)));

        // 粘贴重试：偶发情况下 enigo 模拟按键会失败（如系统正忙于处理前一个输入事件），
        // 短暂等待后重试一次，仍失败才把错误抛给调用方。
        if let Err(first_err) = press_ctrl_v() {
            std::thread::sleep(Duration::from_millis(30));
            press_ctrl_v().map_err(|second_err| {
                format!("粘贴失败（重试后仍失败）：{first_err} / {second_err}")
            })?;
        }
        Ok(())
    }
}

// ============================================================
// macOS 专属：粘贴到外部窗口的底层实现。
// ⚠️ 本模块未在本机（Windows）编译或运行过，仅按 API 文档尽力编写，
// 未经任何验证——细节可能与实际的 objc2 / objc2-app-kit API 不完全一致。
// 思路与 Windows 分支一致：一条后台线程持续追踪“最近一个非本应用的
// 前台 App”的 pid，粘贴时重新激活该 App 再模拟 Cmd+V。
// 用户需在系统「隐私与安全性 → 辅助功能」中为本 App 授权，
// 否则 NSWorkspace/CGEvent 类的按键模拟会被系统拒绝且不会报错提示。
// ============================================================
#[cfg(target_os = "macos")]
mod macos {
    use enigo::Direction::{Click, Press, Release};
    use enigo::{Enigo, Key, Keyboard, Settings};
    use objc2::rc::Retained;
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    /// 共享状态：最近一个非本应用前台 App 的 pid。
    pub struct LastForegroundApp(pub Mutex<Option<i32>>);

    /// 后台追踪线程：约每 150ms 采样一次系统前台 App（frontmostApplication）。
    /// 若其 pid 不是本进程，说明用户当前正在操作别的软件，记下它的 pid；
    /// 浮窗弹出、抢占前台后，这个值仍保留着“抢占前”的目标 App。
    pub fn track_foreground_loop(app: AppHandle) {
        let my_pid = std::process::id() as i32;
        loop {
            unsafe {
                let workspace = NSWorkspace::sharedWorkspace();
                if let Some(front) = workspace.frontmostApplication() {
                    let pid = front.processIdentifier();
                    if pid != my_pid {
                        if let Some(state) = app.try_state::<LastForegroundApp>() {
                            if let Ok(mut guard) = state.0.lock() {
                                *guard = Some(pid);
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// 模拟一次 Cmd+V（macOS 上 enigo 的 Command 键用 Key::Meta 表示）。
    fn press_cmd_v() -> Result<(), String> {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.key(Key::Meta, Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Meta, Release).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 重新激活“最近一个非本应用前台 App”，然后模拟 Cmd+V 完成粘贴。
    pub fn paste_to_active_window(app: &AppHandle, delay_ms: Option<u64>) -> Result<(), String> {
        let target_pid = {
            let state = app
                .try_state::<LastForegroundApp>()
                .ok_or_else(|| "没有可粘贴的目标窗口".to_string())?;
            let guard = state.0.lock().map_err(|e| e.to_string())?;
            guard.ok_or_else(|| "没有可粘贴的目标窗口".to_string())?
        };

        unsafe {
            // runningApplicationWithProcessIdentifier 若该 pid 对应的进程已退出，
            // 返回 None——用它天然地校验“目标窗口是否仍然存在”，类似 Windows 分支的 IsWindow。
            let running: Option<Retained<NSRunningApplication>> =
                NSRunningApplication::runningApplicationWithProcessIdentifier(target_pid);
            let running = running.ok_or_else(|| "目标窗口已关闭".to_string())?;
            if !running.isFinishedLaunching() || running.isTerminated() {
                return Err("目标窗口已关闭".to_string());
            }
            // activateWithOptions: 在较新 SDK 上是首选 API；具体可用的 options 常量
            // 需要对照 objc2-app-kit 当前版本核实，这里传空 options 做最基本的激活。
            // NOTE: 未验证——不同 objc2-app-kit 版本此方法的签名可能不同。
            let _ = running.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions(0));
        }

        std::thread::sleep(Duration::from_millis(delay_ms.unwrap_or(60)));

        if let Err(first_err) = press_cmd_v() {
            std::thread::sleep(Duration::from_millis(30));
            press_cmd_v().map_err(|second_err| {
                format!("粘贴失败（重试后仍失败）：{first_err} / {second_err}")
            })?;
        }
        Ok(())
    }
}

/// 阶段3：把剪贴板内容自动粘贴到“刚才聚焦的外部软件”。
/// 阶段4：加 delay_ms 可选参数，允许前端配置粘贴前的等待时长（30-500ms，
/// 由前端 core.js 的 normalizeState 钳制范围，这里只管兜底默认值）。
/// 非 Windows / 非 macOS 平台暂不支持，直接返回错误，保证跨平台可编译。
#[tauri::command]
fn paste_to_active_window(app: tauri::AppHandle, delay_ms: Option<u64>) -> Result<(), String> {
    #[cfg(windows)]
    {
        win32::paste_to_active_window(&app, delay_ms)
    }
    #[cfg(target_os = "macos")]
    {
        macos::paste_to_active_window(&app, delay_ms)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (&app, delay_ms);
        Err("当前平台暂不支持自动粘贴".into())
    }
}

/// 记录当前已注册的呼出热键，供 set_toggle_shortcut 在注册新热键失败时回滚，
/// 避免用户因一次无效/被占用的设置而彻底失去呼出热键。
#[cfg(desktop)]
struct ActiveShortcut(std::sync::Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>);

/// 阶段4项1：把全局呼出浮窗的快捷键换成用户自定义的 accelerator 字符串。
/// 流程：①先解析——非法格式直接返回、不触碰现有注册；②unregister_all 清掉旧热键、
/// 注册新热键；③若注册失败（如已被其它程序占用），把上一个可用热键重新注册回去，
/// 保证用户不会因一次失败设置就彻底没有呼出热键，再把失败原因透传给前端。
#[cfg(desktop)]
#[tauri::command]
fn set_toggle_shortcut(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    use std::str::FromStr;
    use tauri::Manager;

    // 先解析：非法格式直接返回，不触碰现有注册。
    let new_shortcut = Shortcut::from_str(&accelerator)
        .map_err(|e| format!("快捷键格式无效：{e}"))?;

    let gs = app.global_shortcut();
    gs.unregister_all()
        .map_err(|e| format!("注销旧快捷键失败：{e}"))?;

    if let Err(e) = gs.register(new_shortcut.clone()) {
        // 注册新热键失败：把上一个可用热键重新注册回去，避免彻底失去呼出热键。
        if let Some(state) = app.try_state::<ActiveShortcut>() {
            if let Ok(guard) = state.0.lock() {
                if let Some(prev) = guard.clone() {
                    let _ = gs.register(prev);
                }
            }
        }
        return Err(format!(
            "注册快捷键失败（可能已被其他程序占用），已保留原快捷键：{e}"
        ));
    }

    // 注册成功：更新“当前活动热键”记录，作为下次失败回滚的依据。
    if let Some(state) = app.try_state::<ActiveShortcut>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(new_shortcut);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 翻译功能：通过 HTTP 插件从应用侧发请求，绕开 webview 的 CORS，
        // API key 留在应用侧而非网页环境。允许的目标域名在 capabilities 里声明。
        .plugin(tauri_plugin_http::init())
        // 阶段4项3：记忆窗口位置/尺寸。只存 位置+尺寸，不存可见性——
        // 浮窗默认隐藏的行为必须保持，不能因为“上次退出时是显示的”而在启动时自动弹出。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        );

    // Windows 专属状态：粘贴命令要用的“最近前台窗口”缓存。
    #[cfg(windows)]
    let builder = builder.manage(win32::LastForeground(std::sync::Mutex::new(None)));

    // macOS 专属状态：粘贴命令要用的“最近前台 App pid”缓存。
    // ⚠️ 未经编译验证。
    #[cfg(target_os = "macos")]
    let builder = builder.manage(macos::LastForegroundApp(std::sync::Mutex::new(None)));

    // 当前已注册的呼出热键，供 set_toggle_shortcut 注册失败时回滚。
    #[cfg(desktop)]
    let builder = builder.manage(ActiveShortcut(std::sync::Mutex::new(None)));

    // 全局快捷键仅在桌面端可用，移动端跳过相关插件与注册逻辑
    #[cfg(desktop)]
    let builder = {
        use tauri::Manager;
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

        // 默认 Ctrl+Alt+C：呼出/隐藏浮窗。用户可在设置面板里改成任意组合，
        // 改后只会剩一个已注册的热键，所以 handler 不必再比对具体是哪个 shortcut，
        // 收到 Pressed 事件就直接 toggle 即可。
        let default_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyC);

        builder
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, _shortcut, event| {
                        // 只在按下时响应一次，避免按下+抬起触发两次。
                        // 始终只注册一个热键，因此不必比对 shortcut 是否等于某个固定值。
                        if event.state() == ShortcutState::Pressed {
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
                // 仅打日志并继续，用户此时只是少了这个热键；主窗口加载完 state 后
                // 会调用 set_toggle_shortcut 把持久化的自定义热键重新应用一遍。
                match app.global_shortcut().register(default_shortcut.clone()) {
                    Ok(()) => {
                        // 记录为当前活动热键，作为后续 set_toggle_shortcut 失败回滚的依据。
                        if let Some(state) = app.try_state::<ActiveShortcut>() {
                            if let Ok(mut guard) = state.0.lock() {
                                *guard = Some(default_shortcut.clone());
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("全局快捷键 Ctrl+Alt+C 注册失败（可能已被占用）：{e}");
                    }
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

                // macOS 专属：同上，追踪最近前台 App 的 pid。⚠️ 未经编译验证。
                #[cfg(target_os = "macos")]
                {
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        macos::track_foreground_loop(app_handle);
                    });
                }

                Ok(())
            })
    };

    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        paste_to_active_window,
        set_toggle_shortcut
    ]);
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![paste_to_active_window]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
