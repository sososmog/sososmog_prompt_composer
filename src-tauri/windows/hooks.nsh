; ============================================================
; hooks.nsh —— NSIS 安装钩子：拷文件之前确认 composer.exe 的文件锁已经放开
; ------------------------------------------------------------
; 起因（2026-08-03 用户反馈）：安装时弹
;   Error opening file for writing:
;   C:\Users\<user>\AppData\Local\Composer\composer.exe
; 三选项 中止/重试/忽略。Windows 不允许写入正在执行的 exe，旧进程只要还占着
; 这个文件，覆盖就必然失败。
;
; 为什么模板自带的杀进程没兜住这一次：
; 模板在 Section Install 里有 `!insertmacro CheckIfAppIsRunning`，它会杀掉运行中
; 的应用，杀不掉则 Abort 并提示「Failed to kill Composer. Please close it first」。
; 但用户看到的是 NSIS 原生的 file-write 错误，不是那句提示，说明这一步认为
; 「没进程在跑」直接放行了，而文件锁还在。两种路径都会走到这个结果：
;
;   A. 手动双击安装包（用户这次的情况——截图里出现了 Back/Next/Cancel 向导页，
;      而 updater 拉起安装器时会带 /P 走 passive 模式、跳过这些页面，所以这次
;      不是自动更新触发的）。此时应用大概率还开着，CheckIfAppIsRunning 本该杀掉
;      它；一旦用户在弹出的 MB_OKCANCEL 上迟疑、或进程恰好处于退出中间态，
;      就会漏过去。
;   B. updater 路径下的 TOCTOU（tauri-apps/tauri#12309）：进程已从进程表消失，
;      但内核回收 image section / 文件句柄是异步的，晚于进程消失。模板对此只有
;      一个 `Sleep 500`，而且它只在「真的执行了 kill」的分支里，A/B 两种放行
;      路径都走不到。
;
; 所以这里兜的不是「杀进程」，而是「等锁真正放开」——直接对目标 exe 申请写权限，
; 拿得到就说明锁没了。这比 sleep 一个拍脑袋的固定值准确：它测的正是接下来
; `File` 命令要做的那件事，而不是它的某个代理指标。
;
; 顺带补杀一次，覆盖 A 里应用仍然活着的情况；taskkill 对不存在的进程只是返回
; 非 0，无害。
;
; 幂等、对全新安装无害：目标 exe 不存在时直接跳过，一次 taskkill 都不会执行。
; ============================================================

!macro NSIS_HOOK_PREINSTALL
  ; 全新安装时 $INSTDIR 下没有 exe，没什么可等的。
  ${IfNot} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    Goto composer_lock_done
  ${EndIf}

  ; $R0 = 剩余轮次。20 × 250ms ≈ 最多等 5 秒。
  StrCpy $R0 20

  composer_lock_loop:
    ; 以追加方式打开目标 exe：能拿到写权限就说明没有进程再占用它。
    ; 不写入任何内容，纯探测，拿到立刻关掉。
    ClearErrors
    FileOpen $R1 "$INSTDIR\${MAINBINARYNAME}.exe" a
    ${IfNot} ${Errors}
      FileClose $R1
      Goto composer_lock_done
    ${EndIf}

    ; 锁还在。补一发强杀（/T 连子进程一起），应对「应用其实还开着」。
    nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
    Pop $R2

    Sleep 250

    IntOp $R0 $R0 - 1
    IntCmp $R0 0 composer_lock_done composer_lock_done composer_lock_loop

  composer_lock_done:
    ; 超时也不 Abort：等不到就继续往下走，交给模板原有的 CheckIfAppIsRunning
    ; 和 NSIS 自己的错误对话框处理。兜底没兜住不该比原来更糟——用户点「重试」
    ; 仍然能救回来。
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
