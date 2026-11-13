use std::fs;
use std::sync::atomic::AtomicBool as StdAtomicBool;
use std::sync::atomic::AtomicU64 as StdAtomicU64;
static FOCUS_PIN: StdAtomicBool = StdAtomicBool::new(false);
// Bumped on every reset_timer so the background tick loop can detect a reset
// that occurred between its running-check and its emit.
static RESET_EPOCH: StdAtomicU64 = StdAtomicU64::new(0);
// Claude Code process monitor — counts consecutive seconds claude has been absent.
// Reset to 0 whenever claude is seen running.
// True while the timer is paused because claude was absent.
static CLAUDE_AUTO_PAUSED: StdAtomicBool = StdAtomicBool::new(false);
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewWindow,
};

// ─────────────────────────────────────────────
//  DATA STRUCTS
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
//  TIMER STATE
//  Owned by the Rust background thread.
//  JS calls start/pause/resume/reset commands.
// ─────────────────────────────────────────────

struct TimerState {
    elapsed_secs: Arc<AtomicU64>,
    is_running:   Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    id: String,
    date: String,
    #[serde(rename = "startTime")]
    start_time: String,
    #[serde(rename = "endTime")]
    end_time: String,
    #[serde(rename = "durationSeconds")]
    duration_seconds: i64,
    label: String,
    #[serde(rename = "goalSeconds")]
    goal_seconds: i64,
    #[serde(default)]
    notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Config {
    #[serde(rename = "dailyGoalSeconds")]
    daily_goal_seconds: i64,
}

// ─────────────────────────────────────────────
//  FILE PATH HELPERS
// ─────────────────────────────────────────────

fn data_dir() -> PathBuf {
    let home = dirs::home_dir().expect("Cannot resolve home directory");
    home.join(".clauding-hours")
}

fn sessions_path() -> PathBuf {
    data_dir().join("sessions.json")
}

fn config_path() -> PathBuf {
    data_dir().join("config.json")
}
fn draft_path() -> PathBuf {
    data_dir().join("draft.json")
}

fn ensure_data_dir() {
    let dir = data_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Cannot create ~/.clauding-hours");
    }
}

fn format_duration_secs(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

// ─────────────────────────────────────────────
//  ONE-TIME MIGRATION
//  Copies sessions.json / config.json from the
//  old project root to ~/.clauding-hours/ on
//  first launch, if the new location is empty.
// ─────────────────────────────────────────────

fn migrate_legacy_data() {
    ensure_data_dir();

    // Walk up from the binary's directory looking for the old data files
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    let candidate_root = exe_dir.as_ref().and_then(|dir| {
        let mut d = dir.clone();
        for _ in 0..5 {
            if d.join("sessions.json").exists() || d.join("config.json").exists() {
                return Some(d);
            }
            if let Some(parent) = d.parent() {
                d = parent.to_path_buf();
            } else {
                break;
            }
        }
        None
    });

    let sessions_dst = sessions_path();
    let config_dst = config_path();

    if let Some(root) = candidate_root {
        let sessions_src = root.join("sessions.json");
        let config_src = root.join("config.json");

        if sessions_src.exists() && !sessions_dst.exists() {
            let _ = fs::copy(&sessions_src, &sessions_dst);
        }
        if config_src.exists() && !config_dst.exists() {
            let _ = fs::copy(&config_src, &config_dst);
        }
    }

    // Ensure files exist with sane defaults
    if !sessions_dst.exists() {
        let _ = fs::write(&sessions_dst, "[]");
    }
    if !config_dst.exists() {
        let default_config = Config { daily_goal_seconds: 14400 };
        let _ = fs::write(
            &config_dst,
            serde_json::to_string_pretty(&default_config).unwrap(),
        );
    }
}

// ─────────────────────────────────────────────
//  TAURI COMMANDS
// ─────────────────────────────────────────────

#[tauri::command]
fn get_sessions() -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(sessions_path()).map_err(|e| e.to_string())?;
    let mut sessions: Vec<Session> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    sessions.sort_by(|a, b| a.date.cmp(&b.date).then(a.start_time.cmp(&b.start_time)));
    Ok(serde_json::json!({ "sessions": sessions }))
}

#[tauri::command]
fn add_session(session: Session) -> Result<serde_json::Value, String> {
    if session.duration_seconds <= 0 {
        return Err("durationSeconds must be > 0".into());
    }
    let content = fs::read_to_string(sessions_path()).map_err(|e| e.to_string())?;
    let mut sessions: Vec<Session> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    sessions.push(session.clone());
    let json = serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?;
    fs::write(sessions_path(), json).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true, "session": session }))
}

#[tauri::command]
fn delete_session(id: String) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(sessions_path()).map_err(|e| e.to_string())?;
    let sessions: Vec<Session> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let before = sessions.len();
    let filtered: Vec<Session> = sessions.into_iter().filter(|s| s.id != id).collect();
    if filtered.len() == before {
        return Err(format!("Session not found: {id}"));
    }
    let json = serde_json::to_string_pretty(&filtered).map_err(|e| e.to_string())?;
    fs::write(sessions_path(), json).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn get_config() -> Result<Config, String> {
    let content = fs::read_to_string(config_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(
    #[allow(non_snake_case)]
    dailyGoalSeconds: i64,
) -> Result<serde_json::Value, String> {
    if dailyGoalSeconds <= 0 {
        return Err("dailyGoalSeconds must be > 0".into());
    }
    let config = Config { daily_goal_seconds: dailyGoalSeconds };
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(), json).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true }))
}


// ─────────────────────────────────────────────
//  TIMER COMMANDS
//  JS calls these to control the Rust timer.
// ─────────────────────────────────────────────

#[tauri::command]
fn start_timer(state: tauri::State<TimerState>) {
    CLAUDE_AUTO_PAUSED.store(false, Ordering::Release);

    state.elapsed_secs.store(0, Ordering::Relaxed);
    state.is_running.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn pause_timer(state: tauri::State<TimerState>) {
    CLAUDE_AUTO_PAUSED.store(false, Ordering::Release);
    state.is_running.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn resume_timer(state: tauri::State<TimerState>) {
    CLAUDE_AUTO_PAUSED.store(false, Ordering::Release);

    state.is_running.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn reset_timer(app: AppHandle, state: tauri::State<TimerState>) -> Result<(), String> {
    // Bump the reset epoch first. The background tick loop reads the epoch
    // before sleeping and again before emitting; if it sees the epoch change
    // it discards its in-flight increment so we don't emit a stale "00:00:01"
    // immediately after the reset.
    RESET_EPOCH.fetch_add(1, Ordering::AcqRel);
    CLAUDE_AUTO_PAUSED.store(false, Ordering::Release);

    state.is_running.store(false, Ordering::Release);
    state.elapsed_secs.store(0, Ordering::Release);
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_title(Some("00:00:00")).map_err(|e| e.to_string())?;
    }
    app.emit("timer-tick", "00:00:00").ok();
    Ok(())
}

#[tauri::command]
fn get_elapsed_secs(state: tauri::State<TimerState>) -> u64 {
    state.elapsed_secs.load(Ordering::Relaxed)
}

#[tauri::command]
fn update_session(id: String, label: String, notes: String) -> Result<serde_json::Value, String> {
    let content = fs::read_to_string(sessions_path()).map_err(|e| e.to_string())?;
    let mut sessions: Vec<Session> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let session = sessions.iter_mut().find(|s| s.id == id)
        .ok_or_else(|| format!("Session not found: {id}"))?;
    session.label = label;
    session.notes = notes;
    let json = serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?;
    fs::write(sessions_path(), json).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true }))
}

// ─────────────────────────────────────────────
//  OVERLAY COMMANDS
// ─────────────────────────────────────────────

#[tauri::command]
fn show_overlay(app: AppHandle) -> Result<(), String> {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    // Prefer the monitor under the cursor (where the user just clicked the tray
    // or the expand button). Fall back to the main window's monitor.
    let monitor = app.cursor_position().ok()
        .and_then(|pos| app.monitor_from_point(pos.x, pos.y).ok().flatten())
        .or_else(|| app.get_webview_window("main")
            .and_then(|w| w.current_monitor().ok().flatten()));
    if let Some(monitor) = monitor {
        let mpos  = monitor.position();
        let msize = monitor.size();
        let scale = monitor.scale_factor();
        let lx = mpos.x as f64 / scale + (msize.width  as f64 / scale - 900.0) / 2.0;
        let ly = mpos.y as f64 / scale + (msize.height as f64 / scale - 500.0) / 2.0;
        let _ = overlay.set_position(tauri::Position::Logical(
            tauri::LogicalPosition::new(lx, ly),
        ));
    }
    overlay.show().map_err(|e| e.to_string())?;
    overlay.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Enters or exits native macOS fullscreen (hides the menu bar via its own Space).
#[tauri::command]
fn set_overlay_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), String> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resets the overlay window back to its floating 900×500 size, centred on its
/// current monitor (not necessarily the primary). Called from JS after the
/// fullscreen-exit animation finishes (~380 ms).
#[tauri::command]
fn reset_overlay_size(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(900.0, 500.0)))
        .map_err(|e| e.to_string())?;
    // Centre within the overlay's current monitor — not always the primary.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let mpos  = monitor.position();
        let msize = monitor.size();
        let scale = monitor.scale_factor();
        let lx = mpos.x as f64 / scale + (msize.width  as f64 / scale - 900.0) / 2.0;
        let ly = mpos.y as f64 / scale + (msize.height as f64 / scale - 500.0) / 2.0;
        window.set_position(tauri::Position::Logical(
            tauri::LogicalPosition::new(lx, ly),
        )).map_err(|e| e.to_string())?;
    } else {
        window.center().map_err(|e| e.to_string())?;
    }
    Ok(())
}


/// Writes the in-flight session draft (label, notes, elapsed, started_at, state)
/// so that quitting / crashing mid-session doesn't lose the user's work.
/// JS calls this debounced on input changes.
#[tauri::command]
fn save_draft(draft: serde_json::Value) -> Result<(), String> {
    ensure_data_dir();
    let json = serde_json::to_string_pretty(&draft).map_err(|e| e.to_string())?;
    fs::write(draft_path(), json).map_err(|e| e.to_string())
}

/// Reads the draft (returns null if none). JS uses this on init to restore
/// label/notes/elapsed if the previous session was never ended.
#[tauri::command]
fn get_draft() -> Result<serde_json::Value, String> {
    if !draft_path().exists() {
        return Ok(serde_json::Value::Null);
    }
    let content = fs::read_to_string(draft_path()).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// Clears the draft — called on End / Reset so a stale draft isn't restored next launch.
#[tauri::command]
fn clear_draft() -> Result<(), String> {
    if draft_path().exists() {
        let _ = fs::remove_file(draft_path());
    }
    Ok(())
}

/// Seeds the Rust timer thread's elapsed counter — used when restoring a draft
/// so the Rust-owned timer continues from where it was, not from zero.
#[tauri::command]
fn seed_elapsed(state: tauri::State<TimerState>, secs: u64) {
    state.elapsed_secs.store(secs, Ordering::Relaxed);
}

/// Tells the focus-loss handler to skip hiding the window. JS sets this to true
/// while the user is actively editing an input/textarea so an OS dialog or
/// permission prompt that briefly steals focus doesn't destroy the in-flight edit.
#[tauri::command]
fn set_focus_pin(pinned: bool) {
    FOCUS_PIN.store(pinned, std::sync::atomic::Ordering::Relaxed);
}

/// Re-centers the main window on the cursor's monitor. Recovery for cases where
/// the window ends up off-screen or partially clipped on a multi-monitor setup.
#[tauri::command]
fn recenter_main(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else { return Ok(()); };
    let monitor = app.cursor_position().ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let mpos = monitor.position();
        let msize = monitor.size();
        let scale = monitor.scale_factor();
        let win_w_phys = (400.0 * scale) as i32;
        let win_h_phys = (560.0 * scale) as i32;
        let x = mpos.x + (msize.width as i32 - win_w_phys) / 2;
        let y = mpos.y + (msize.height as i32 - win_h_phys) / 2;
        let _ = window.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition::new(x, y)));
    }
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Fires a native macOS notification banner via osascript. We use this instead
/// of in-app toasts for auto-pause/resume because the main window is usually
/// hidden when the user has stepped away — the toast goes unseen.
#[tauri::command]
fn notify(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Escape embedded double quotes so the AppleScript stays well-formed.
        let safe_title = title.replace('"', "\\\"");
        let safe_body  = body.replace('"', "\\\"");
        let script = format!(
            "display notification \"{safe_body}\" with title \"{safe_title}\""
        );
        // Spawn so we don't block; ignore failure (notification permission, etc.)
        let _ = std::process::Command::new("osascript")
            .arg("-e").arg(script)
            .spawn();
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (title, body); }
    Ok(())
}

/// Returns how many seconds the system has been idle (no keyboard/mouse input).
/// Uses macOS CoreGraphics on macOS; returns 0 on other platforms.
#[tauri::command]
fn get_idle_seconds() -> f64 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
        }
        // kCGEventSourceStateCombinedSessionState = 1
        // kCGAnyInputEventType = 0xFFFFFFFF
        unsafe { CGEventSourceSecondsSinceLastEventType(1, 0xFFFF_FFFF) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        0.0
    }
}

// ─────────────────────────────────────────────
//  WINDOW TOGGLE
//  Positions the window just below the tray
//  icon click point before showing it.
// ─────────────────────────────────────────────

fn toggle_window_phys(window: &WebviewWindow, x: i32, y: i32) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition::new(x, y),
        ));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ─────────────────────────────────────────────
//  TRAY MENU BUILDER
//  Rebuilds the tray menu with the current
//  autostart state reflected as a checkmark.
// ─────────────────────────────────────────────

fn rebuild_tray_menu(app: &AppHandle<tauri::Wry>) {
    use tauri_plugin_autostart::ManagerExt;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let Ok(autostart_item) = CheckMenuItemBuilder::new("Launch at Login")
        .id("autostart")
        .checked(enabled)
        .build(app)
    else {
        return;
    };
    let Ok(quit_item) = MenuItemBuilder::new("Quit ClaudingHours")
        .id("quit")
        .build(app)
    else {
        return;
    };
    if let Ok(menu) = MenuBuilder::new(app)
        .item(&autostart_item)
        .separator()
        .item(&quit_item)
        .build()
    {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

// ─────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_legacy_data();

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, ShortcutState};
                    if event.state() != ShortcutState::Pressed { return; }
                    match shortcut.key {
                        Code::KeyC => {
                            // ⌘⌥C — show / hide the popup window
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        Code::KeyS => {
                            // ⌘⌥S — start / pause timer
                            app.emit("toggle-timer", ()).ok();
                        }
                        Code::KeyR => {
                            // ⌘⌥R — recenter main window on cursor's monitor
                            // (recovery for off-screen / mis-positioned popup)
                            let _ = recenter_main(app.clone());
                        }
                        _ => {}
                    }
                })
                .build(),
        )
        .setup(|app| {
            use tauri_plugin_autostart::ManagerExt;
            // Register global hotkeys:
            //   ⌘⌥C — toggle popup window
            //   ⌘⌥S — start / pause timer
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let sc = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyC);
                let _ = app.global_shortcut().register(sc);
                let ss = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyS);
                let _ = app.global_shortcut().register(ss);
                let sr = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyR);
                let _ = app.global_shortcut().register(sr);
            }

            // Rust-side timer: ticks every second independently of window visibility.
            // Fixes the tray-freeze and overlay-skipping bugs caused by WKWebView
            // pausing JS timers in hidden windows.
            let elapsed  = Arc::new(AtomicU64::new(0));
            let running  = Arc::new(AtomicBool::new(false));
            let elapsed2 = Arc::clone(&elapsed);
            let running2 = Arc::clone(&running);
            let app_h    = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    let epoch_before = RESET_EPOCH.load(Ordering::Acquire);
                    std::thread::sleep(Duration::from_secs(1));
                    if !running2.load(Ordering::Acquire) { continue; }
                    // Reset happened during sleep — skip this tick.
                    if RESET_EPOCH.load(Ordering::Acquire) != epoch_before { continue; }
                    let secs = elapsed2.fetch_add(1, Ordering::AcqRel) + 1;
                    // Re-check epoch after the increment. If reset raced in,
                    // restore elapsed to the freshly-zeroed state and skip emit.
                    if RESET_EPOCH.load(Ordering::Acquire) != epoch_before {
                        elapsed2.store(0, Ordering::Release);
                        continue;
                    }
                    let title = format_duration_secs(secs);
                    if let Some(tray) = app_h.tray_by_id("main-tray") {
                        let _ = tray.set_title(Some(&title));
                    }
                    app_h.emit("timer-tick", &title).ok();
                }
            });
            // Inactivity monitor — pauses the timer after PAUSE_THRESHOLD seconds
            // of no keyboard/mouse input (via CGEventSource idle time).  Also
            // catches Mac sleep: if the thread wakes later than expected, the
            // wall-clock gap is counted as inactivity.
            // Emits "claude-active" when the user returns so the JS can update.
            let running3 = Arc::clone(&running);
            let app_m    = app.handle().clone();
            std::thread::spawn(move || {
                const CHECK_SECS:          u64 = 10;
                const PAUSE_THRESHOLD_F:   f64 = 300.0; // 5 minutes idle
                const NAG_EVERY_SECS:      u64 = 60;
                const ACTIVE_THRESHOLD_F:  f64 = 30.0;  // back if idle < 30s
                const SLEEP_SLOP_SECS:     u64 = 15;    // extra latency = Mac woke
                let mut paused_secs: u64 = 0;
                let mut last_wake = std::time::Instant::now();
                loop {
                    std::thread::sleep(Duration::from_secs(CHECK_SECS));
                    let now        = std::time::Instant::now();
                    let actual_gap = now.duration_since(last_wake).as_secs();
                    last_wake      = now;

                    // If the gap was much larger than CHECK_SECS the system was
                    // asleep; count the whole gap as idle time.
                    let idle_secs: f64 = if actual_gap > CHECK_SECS + SLEEP_SLOP_SECS {
                        actual_gap as f64
                    } else {
                        get_idle_seconds()
                    };

                    let auto_paused = CLAUDE_AUTO_PAUSED.load(Ordering::Acquire);
                    let is_active   = idle_secs < ACTIVE_THRESHOLD_F;

                    // ── User returned after auto-pause ────────────────────
                    if is_active && auto_paused {
                        // Stay paused — user must explicitly resume.
                        // Just notify JS so the banner updates.
                        app_m.emit("claude-active", ()).ok();
                    }

                    // ── Trigger auto-pause ────────────────────────────────
                    if !auto_paused && idle_secs >= PAUSE_THRESHOLD_F && running3.load(Ordering::Acquire) {
                        running3.store(false, Ordering::Release);
                        CLAUDE_AUTO_PAUSED.store(true, Ordering::Release);
                        paused_secs = 0;
                        let mins = (idle_secs as u64) / 60;
                        let _ = std::process::Command::new("osascript")
                            .args(["-e", &format!(
                                "display notification \"No activity for {}m — timer paused. Press ⌘⌥S to resume.\" with title \"⏸ ClaudingHours paused\" sound name \"Submarine\"",
                                mins
                            )])
                            .spawn();
                        if let Some(w) = app_m.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        if let Some(tray) = app_m.tray_by_id("main-tray") {
                            let _ = tray.set_title(Some("⏸ PAUSED"));
                        }
                        app_m.emit("auto-paused", mins).ok();
                    }

                    // ── Persistent reminder while auto-paused ─────────────
                    if CLAUDE_AUTO_PAUSED.load(Ordering::Acquire) {
                        paused_secs += CHECK_SECS;
                        if let Some(tray) = app_m.tray_by_id("main-tray") {
                            let title = if (paused_secs / CHECK_SECS) % 2 == 0 {
                                "⏸ PAUSED"
                            } else {
                                "▶ RESUME"
                            };
                            let _ = tray.set_title(Some(title));
                        }
                        if paused_secs % NAG_EVERY_SECS == 0 {
                            let mins_paused = paused_secs / 60;
                            let body = if is_active {
                                format!("You're back! Timer still paused ({}m) — press ⌘⌥S to resume.", mins_paused)
                            } else {
                                format!("Timer still paused ({}m). Resume with ⌘⌥S when ready.", mins_paused)
                            };
                            let _ = std::process::Command::new("osascript")
                                .args(["-e", &format!(
                                    "display notification \"{}\" with title \"⏸ ClaudingHours still paused\" sound name \"Submarine\"",
                                    body
                                )])
                                .spawn();
                        }
                    } else {
                        paused_secs = 0;
                    }
                }
            });

            app.manage(TimerState { elapsed_secs: elapsed, is_running: running });

            // Build initial tray menu
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_item = CheckMenuItemBuilder::new("Launch at Login")
                .id("autostart")
                .checked(autostart_enabled)
                .build(app)?;
            let quit_item = MenuItemBuilder::new("Quit ClaudingHours")
                .id("quit")
                .build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&autostart_item)
                .separator()
                .item(&quit_item)
                .build()?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .title("00:00:00")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon<tauri::Wry>, event| {
                    // Refresh menu on any click so the autostart checkmark stays
                    // in sync with System Settings → Login Items (which can be
                    // toggled outside the app).
                    if let TrayIconEvent::Click { button_state: MouseButtonState::Down, .. } = event {
                        rebuild_tray_menu(tray.app_handle());
                    }
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            // Use Physical coords. Tauri's Logical positions are
                            // interpreted relative to the window's *current* monitor's
                            // scale, which gives wrong placement when moving between
                            // monitors with mixed scales (e.g. a Retina display next to a 1x one).
                            // Physical coords are in the global desktop pixel space
                            // and are unambiguous.
                            let monitor = app
                                .monitor_from_point(position.x, position.y)
                                .ok().flatten()
                                .or_else(|| window.current_monitor().ok().flatten())
                                .or_else(|| app.primary_monitor().ok().flatten());
                            if let Some(monitor) = monitor {
                                let mpos = monitor.position();
                                let msize = monitor.size();
                                let scale = monitor.scale_factor();
                                // 400 logical px window → physical pixels on this monitor
                                let win_w_phys = (400.0 * scale) as i32;
                                let centered = mpos.x + (msize.width as i32 - win_w_phys) / 2;
                                let top = mpos.y + (32.0 * scale) as i32; // below menu bar
                                toggle_window_phys(&window, centered, top);
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app: &AppHandle<tauri::Wry>, event| {
                    match event.id().as_ref() {
                        "quit" => app.exit(0),
                        "autostart" => {
                            use tauri_plugin_autostart::ManagerExt;
                            let mgr = app.autolaunch();
                            if mgr.is_enabled().unwrap_or(false) {
                                let _ = mgr.disable();
                            } else {
                                let _ = mgr.enable();
                            }
                            // Rebuild menu so checkmark reflects new state
                            rebuild_tray_menu(app);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Intercept the red-X close button: hide instead of quit.
            // Also hide when the window loses focus (click on desktop / another app).
            let main_win = app.get_webview_window("main").unwrap();
            let win_clone = main_win.clone();
            main_win.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = win_clone.hide();
                    }
                    tauri::WindowEvent::Focused(false) => {
                        // Don't hide if the user is editing inside the window — losing
                        // focus to a notification permission prompt or a momentary OS
                        // dialog should not destroy in-flight inline edits or goal/notes.
                        if !FOCUS_PIN.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = win_clone.hide();
                        }
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            add_session,
            delete_session,
            update_session,
            get_config,
            save_config,
            start_timer,
            pause_timer,
            resume_timer,
            reset_timer,
            get_elapsed_secs,
            show_overlay,
            hide_overlay,
            set_overlay_fullscreen,
            reset_overlay_size,
            get_idle_seconds,
            notify,
            set_focus_pin,
            recenter_main,
            save_draft,
            get_draft,
            clear_draft,
            seed_elapsed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
