mod ledger;
mod settlement;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// 原生窗口拖动会接管鼠标消息，网页不一定收到 mouseup。
// 按键真实状态决定是否允许恢复穿透，不能用 1.5 秒定时器猜测。
#[cfg(target_os = "windows")]
fn left_mouse_down() -> bool {
    #[link(name = "user32")]
    extern "system" { fn GetAsyncKeyState(key: i32) -> i16; }
    unsafe { GetAsyncKeyState(0x01) < 0 }
}
#[cfg(not(target_os = "windows"))]
fn left_mouse_down() -> bool { false }

/// 当前毫秒时间戳，用来给「拖动中」计时
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---------------------------- 跟着 DS Bot 走 ---------------------------- */
/* DSH 起挂件时会把宿主进程号放进 SALARYMETER_HOST_PID（跟 dsh-pet 一个路子）。
   这里每 2 秒确认一次宿主还在，宿主没了就自己退出——DSH 崩溃或强杀时插件来不及收，
   靠这条兜底，挂件不会孤零零留在桌面上。手动双击启动（没有这个环境变量）时不做任何事。 */
const HOST_POLL_MS: u64 = 2000;

#[cfg(target_os = "windows")]
fn process_alive(pid: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn GetExitCodeProcess(handle: isize, code: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}
#[cfg(not(target_os = "windows"))]
fn process_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// 手动双击启动时没有环境变量：这时自己找一下 DS Bot 的主进程，找到就照样跟着它。
#[cfg(target_os = "windows")]
fn find_dsh_pid() -> Option<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Process -Name 'DS Bot' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)
}
#[cfg(not(target_os = "windows"))]
fn find_dsh_pid() -> Option<u32> {
    None
}

fn start_host_watch(app: AppHandle) {
    let from_env = std::env::var("SALARYMETER_HOST_PID")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|pid| *pid > 0);
    std::thread::spawn(move || {
        let host_pid = match from_env {
            Some(pid) => pid,
            None => match find_dsh_pid() {
                Some(pid) => pid,
                None => return, // DS Bot 没开：不跟任何人，行为跟以前一样
            },
        };
        startup_log(&app, &format!("跟随宿主进程 {host_pid}，它退出我就退出"));
        loop {
            std::thread::sleep(std::time::Duration::from_millis(HOST_POLL_MS));
            if process_alive(host_pid) {
                continue;
            }
            startup_log(&app, &format!("宿主进程 {host_pid} 不在了，挂件自己退出"));
            app.exit(0);
            // 万一 exit 被卡住，2 秒后硬退，绝不留一个孤儿窗口
            std::thread::sleep(std::time::Duration::from_millis(2000));
            std::process::exit(0);
        }
    });
}

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};

/* 窗口尺寸跟内容一样大，不留透明边——留了边就会挡住底下窗口的点击 */
const WIN_W: f64 = 440.0;
const WIN_COLLAPSED_H: f64 = 390.0;
const WIN_EXPANDED_H: f64 = 500.0;
/* 设置页：内容（量过）555 高 + 顶部 45 的标题栏 + 6 余量；设成固定值比原来 820 少一整块空白 */
const WIN_SETTINGS_H: f64 = 606.0;

/// 整台电脑的键鼠空闲了多少毫秒。彩蛋判据和休息日「打游戏」那段的取舍都靠它。
#[cfg(target_os = "windows")]
#[tauri::command]
fn user_idle_ms() -> u64 {
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) == 0 {
            return 0; // 拿不到就当作「刚刚动过」，宁少播打游戏
        }
        GetTickCount64()
            .saturating_sub(info.dwTime as u64)
            .min(86_400_000)
    }
}
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn user_idle_ms() -> u64 { 0 }

/* ------------------------------------------------------------------ 配置 */

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    salary: f64,
    days: f64,
    start: String,
    end: String,
    lunch: f64,
    weekend: bool,
    #[serde(rename = "restMode", default)]
    rest_mode: String,
    theme: String,
    character: String,
    #[serde(rename = "petScale")]
    pet_scale: f64,
    expanded: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            salary: 5000.0,
            days: 22.0,
            start: "09:00".to_string(),
            end: "18:00".to_string(),
            lunch: 1.0,
            weekend: false,
            // 空字符串 = 还没设置过休息制度，前端会按老配置的 weekend 换算（true→none，false→double）
            rest_mode: String::new(),
            theme: "dark".to_string(),
            character: "webm".to_string(),
            pet_scale: 130.0,
            expanded: false,
        }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
struct SavedPos {
    x: i32,
    y: i32,
}

#[derive(Clone, Deserialize)]
struct HitRect { x: f64, y: f64, width: f64, height: f64 }

#[tauri::command]
fn set_hit_regions(state: tauri::State<AppState>, regions: Vec<HitRect>) {
    *state.hit_regions.lock().unwrap() = regions;
}

struct AppState {
    hit_regions: Mutex<Vec<HitRect>>,
    passthrough: AtomicBool,
    settings_open: AtomicBool,
    dragging_until: AtomicU64,
    cache: Mutex<ledger::ScanCache>,
    prices: ledger::Prices,
}

struct TrayHandles {
    theme: MenuItem<tauri::Wry>,
    top: CheckMenuItem<tauri::Wry>,
    pass: CheckMenuItem<tauri::Wry>,
}

fn data_dir(app: &AppHandle) -> PathBuf {
    // 原生验收使用独立目录，避免测试账单污染真实配置和已读记录。
    if let Some(path) = std::env::var_os("SALARYMETER_TEST_DATA") {
        let path = PathBuf::from(path);
        if path.is_absolute() { return path; }
    }
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn load_config(app: &AppHandle) -> Config {
    let path = data_dir(app).join("config.json");
    let saved = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Config>(&s).ok());
    // 第一次跑桌面版时，沿用 DS Bot 插件里已经存好的参数和外观，两边不会对不上。
    match saved {
        Some(cfg) => cfg,
        None => migrate_plugin_config().unwrap_or_default(),
    }
}

fn plugin_data_dir() -> PathBuf {
    dsh_home().join("data").join("dsh-salary-meter")
}

fn migrate_plugin_config() -> Option<Config> {
    let text = fs::read_to_string(plugin_data_dir().join("config.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let raw = value.get("config")?;
    let mut cfg = Config::default();
    if let Some(v) = raw.get("salary").and_then(|v| v.as_f64()) {
        cfg.salary = v;
    }
    if let Some(v) = raw.get("days").and_then(|v| v.as_f64()) {
        cfg.days = v;
    }
    if let Some(v) = raw.get("start").and_then(|v| v.as_str()) {
        cfg.start = v.to_string();
    }
    if let Some(v) = raw.get("end").and_then(|v| v.as_str()) {
        cfg.end = v.to_string();
    }
    if let Some(v) = raw.get("lunch").and_then(|v| v.as_f64()) {
        cfg.lunch = v;
    }
    if let Some(v) = raw.get("weekend").and_then(|v| v.as_bool()) {
        cfg.weekend = v;
    }
    if let Some(v) = raw.get("restMode").and_then(|v| v.as_str()) {
        cfg.rest_mode = v.to_string();
    }
    if let Ok(text) = fs::read_to_string(plugin_data_dir().join("view.json")) {
        if let Ok(view) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(theme) = view.get("theme").and_then(|v| v.as_str()) {
                if ["dark", "light", "gold"].contains(&theme) {
                    cfg.theme = theme.to_string();
                }
            }
            if let Some(expanded) = view.get("expanded").and_then(|v| v.as_bool()) {
                cfg.expanded = expanded;
            }
        }
    }
    Some(cfg)
}

fn save_config(app: &AppHandle, cfg: &Config) {
    let path = data_dir(app).join("config.json");
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(path, text);
    }
}

fn save_position(app: &AppHandle, x: i32, y: i32) {
    let path = data_dir(app).join("position.json");
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&SavedPos { x, y }) {
        // 先写临时文件再改名：进程在写的半路被强杀时，position.json 不会只剩半截或 0 字节。
        // 半截文件下次启动会解析失败，然后静默退回默认位置——那就是「重启后位置跑偏」。
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, text).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

fn load_position(app: &AppHandle) -> Option<SavedPos> {
    // 位置文件可能被外部工具改过：去掉 BOM 和首尾空白再解析，
    // 以前带 BOM 会解析失败，然后静默退回右下角默认位置，看起来就是「重启后位置跑了」。
    let text = fs::read_to_string(data_dir(app).join("position.json")).ok()?;
    let cleaned = text.trim_start_matches('\u{feff}').trim();
    match serde_json::from_str::<SavedPos>(cleaned) {
        Ok(pos) => Some(pos),
        Err(error) => {
            startup_log(app, &format!("position.json 解析失败: {error}; 原文={cleaned:?}"));
            None
        }
    }
}

/// 启动过程写一行日志，方便下次「位置又跑了」时有据可查。
fn startup_log(app: &AppHandle, message: &str) {
    use std::io::Write;
    let path = data_dir(app).join("startup.log");
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{ms} {message}");
    }
}

/// 运行时日志：动画切到哪一段、视频有没有失败、有没有两个视频层同时显示，
/// 都记在这里，出问题能回看现场（2026-11-09 用户截图里冒出「静态图片」时，
/// 手上只有启动日志，查不到那一刻发生了什么）。
/// 超过 200KB 就截到只剩最后 100KB，从换行处切，别把一行劈开。
fn runtime_log(app: &AppHandle, message: &str) {
    use std::io::Write;
    let dir = data_dir(app);
    let path = dir.join("renderer.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 200 * 1024 {
            if let Ok(bytes) = fs::read(&path) {
                let keep = bytes.len().saturating_sub(100 * 1024);
                let start = bytes[keep..]
                    .iter()
                    .position(|&b| b == b'\n')
                    .map(|i| keep + i + 1)
                    .unwrap_or(keep);
                let _ = fs::write(&path, &bytes[start..]);
            }
        }
    }
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{ms} {message}");
    }
}

/// 渲染进程写一行日志。参数长度兜个底，防止误传大段文本把日志撑爆。
#[tauri::command]
fn log_event(app: AppHandle, message: String) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return;
    }
    let line: String = trimmed.chars().take(400).collect();
    runtime_log(&app, &line);
}

/* ---------------------------------------------------------------- 偷吃 */

fn dsh_home() -> PathBuf {
    if let Ok(home) = std::env::var("DSH_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let ds_bot = PathBuf::from(&profile).join(".ds-bot");
        if ds_bot.join("data").exists() {
            return ds_bot;
        }
        return PathBuf::from(&profile).join(".dsh");
    }
    PathBuf::from(".")
}

fn run_scan(app: &AppHandle, refresh: bool) -> ledger::ScanReport {
    let state = app.state::<AppState>();
    let AppState { cache, prices, .. } = &*state;
    let mut cache = cache.lock().unwrap_or_else(|error| error.into_inner());
    if refresh {
        cache.clear();
    }
    ledger::scan_today(prices, &mut cache, &dsh_home())
}

#[derive(Serialize)]
struct PriceInfo {
    source: String,
    count: usize,
}

#[derive(Serialize)]
struct StatePayload {
    tps: Option<f64>,
    config: Config,
    today: ledger::Totals,
    prices: PriceInfo,
    sessions: usize,
    updated: i64,
    /* DS Bot 最近一次写会话日志的时间：两分钟内写过就算它还在跑，休息日不播打游戏 */
    last_write: i64,
    /* 插件写的心跳：DS Bot 里有没有任务在跑（真实状态，优先于上面的估算） */
    dsh_busy: Option<BusyReport>,
}

#[derive(Serialize)]
struct BusyReport {
    busy: bool,
    at: i64,
    sessions: u32,
}

/// 读插件写的心跳文件，判断 DS Bot 是不是真的还有任务在跑
fn read_busy_report(app: &AppHandle) -> Option<BusyReport> {
    let text = fs::read_to_string(data_dir(app).join("dsh-busy.json")).ok()?;
    let cleaned = text.trim_start_matches('\u{feff}').trim();
    let value: serde_json::Value = serde_json::from_str(cleaned).ok()?;
    Some(BusyReport {
        busy: value.get("busy").and_then(|v| v.as_bool()).unwrap_or(false),
        at: value.get("at").and_then(|v| v.as_i64())?,
        sessions: value.get("sessions").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    })
}

/// 挂件每 3 秒拉一次：参数 + 今日偷吃（自己扫 DS Bot 的会话日志算出来）。
/// 扫描是纯 CPU 活，必须放到异步线程上跑，否则会卡住主线程（窗口、设置页都会僵）。
#[tauri::command(async)]
fn get_state(app: AppHandle) -> StatePayload {
    let report = run_scan(&app, false);
    StatePayload {
        config: load_config(&app),
        tps: report.today.tps(),
        today: report.today,
        prices: PriceInfo {
            source: report.prices,
            count: report.models,
        },
        sessions: report.sessions,
        updated: ledger::now_ms(),
        last_write: report.last_write_ms,
        dsh_busy: read_busy_report(&app),
    }
}

/// 设置页的「重算今天的账」：丢掉缓存，把今天的会话全部重扫一遍。
#[tauri::command(async)]
fn recompute_today(app: AppHandle) -> StatePayload {
    let report = run_scan(&app, true);
    StatePayload {
        config: load_config(&app),
        tps: report.today.tps(),
        today: report.today,
        prices: PriceInfo {
            source: report.prices,
            count: report.models,
        },
        sessions: report.sessions,
        updated: ledger::now_ms(),
        last_write: report.last_write_ms,
        dsh_busy: read_busy_report(&app),
    }
}

/* ---------------------------------------------------------------- 命令 */

#[tauri::command]
fn get_config(app: AppHandle) -> Config {
    load_config(&app)
}

#[tauri::command]
fn set_config(app: AppHandle, patch: serde_json::Value) -> Config {
    let mut cfg = load_config(&app);

    if let Some(v) = patch.get("salary").and_then(|v| v.as_f64()) {
        cfg.salary = v.max(0.0);
    }
    if let Some(v) = patch.get("days").and_then(|v| v.as_f64()) {
        cfg.days = v.max(1.0);
    }
    if let Some(v) = patch.get("start").and_then(|v| v.as_str()) {
        cfg.start = v.to_string();
    }
    if let Some(v) = patch.get("end").and_then(|v| v.as_str()) {
        cfg.end = v.to_string();
    }
    if let Some(v) = patch.get("lunch").and_then(|v| v.as_f64()) {
        cfg.lunch = v.max(0.0);
    }
    if let Some(v) = patch.get("weekend").and_then(|v| v.as_bool()) {
        cfg.weekend = v;
    }
    if let Some(v) = patch.get("restMode").and_then(|v| v.as_str()) {
        cfg.rest_mode = match v {
            "single" => "single".to_string(),
            "alternate" => "alternate".to_string(),
            "none" => "none".to_string(),
            _ => "double".to_string(),
        };
    }
    if let Some(v) = patch.get("theme").and_then(|v| v.as_str()) {
        cfg.theme = match v {
            "light" => "light".to_string(),
            "gold" => "gold".to_string(),
            _ => "dark".to_string(),
        };
    }
    if let Some(v) = patch.get("character").and_then(|v| v.as_str()) {
        cfg.character = match v {
            "atlas" => "atlas".to_string(),
            _ => "webm".to_string(),
        };
    }

    if let Some(v) = patch.get("petScale").and_then(|v| v.as_f64()) {
        cfg.pet_scale = v.clamp(80.0, 160.0);
    }
    save_config(&app, &cfg);
    let _ = app.emit("config-changed", &cfg);
    sync_menu(&app, &cfg);
    cfg
}

/// 展开 / 收起人物：窗口跟着变高，位置尽量留在屏幕里。
#[tauri::command]
fn set_expanded(app: AppHandle, expanded: bool) -> Config {
    let mut cfg = load_config(&app);
    cfg.expanded = expanded;
    save_config(&app, &cfg);
    apply_window_size(&app, expanded);
    let _ = app.emit("config-changed", &cfg);
    cfg
}

fn apply_window_size(app: &AppHandle, expanded: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let height = if expanded {
        WIN_EXPANDED_H
    } else {
        WIN_COLLAPSED_H
    };
    let _ = window.set_size(tauri::LogicalSize::new(WIN_W, height));
}

fn clamp_to_monitor(window: &tauri::WebviewWindow, size: tauri::PhysicalSize<u32>) {
    let (Ok(position), Ok(Some(monitor))) = (window.outer_position(), window.current_monitor()) else {
        return;
    };
    // 用工作区（刨掉任务栏）而不是整块屏幕：用整块屏幕的话，放到最下面时页脚会被任务栏盖住
    let work = monitor.work_area();
    let work_ok = work.size.width > 0 && work.size.height > 0;
    let origin = if work_ok { work.position } else { *monitor.position() };
    let usable = if work_ok { work.size } else { *monitor.size() };
    let margin = 12;
    let max_x = origin.x + usable.width as i32 - size.width as i32 - margin;
    let max_y = origin.y + usable.height as i32 - size.height as i32 - margin;
    let x = position.x.clamp(origin.x + margin, max_x.max(origin.x + margin));
    let y = position.y.clamp(origin.y + margin, max_y.max(origin.y + margin));
    if x != position.x || y != position.y {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// 按配置算窗口的物理尺寸。夹取要用「将来」的尺寸，不能读实时尺寸：
/// set_size 之后窗口尺寸要过一会儿才更新，读到的还是旧值，夹完仍旧会露出屏幕外。
fn physical_window_size(window: &tauri::WebviewWindow, expanded: bool) -> tauri::PhysicalSize<u32> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let height = if expanded { WIN_EXPANDED_H } else { WIN_COLLAPSED_H };
    let sized = (WIN_W * scale).round() as u32;
    let h = (height * scale).round() as u32;
    if sized == 0 || h == 0 {
        return window
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(WIN_W as u32, WIN_COLLAPSED_H as u32));
    }
    tauri::PhysicalSize::new(sized, h)
}

/// 设置页现在是主窗口里的浮层：让前端把它撑开就行，不再开第二个 webview
#[tauri::command]
fn open_settings(app: AppHandle) {
    let _ = app.emit("open-settings", ());
}

/// 挂件 / 设置 两种窗口尺寸
#[tauri::command]
fn set_mode(app: AppHandle, mode: String) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    if let Some(state) = app.try_state::<AppState>() {
        state
            .settings_open
            .store(mode == "settings", Ordering::Relaxed);
    }
    if mode == "settings" {
        // 设置页比屏幕还高就按屏幕压一下，标题栏和关闭按钮得一直看得见
        let scale = window.scale_factor().unwrap_or(1.0);
        let monitor_height = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor.size().height as f64 / scale)
            .unwrap_or(WIN_SETTINGS_H);
        let height = WIN_SETTINGS_H.min(monitor_height - 40.0).max(520.0);
        let _ = window.set_size(tauri::LogicalSize::new(466.0, height));
        // 用刚算出来的尺寸夹取：set_size 之后实时尺寸还没更新，读到的还是旧值
        let settings = tauri::PhysicalSize::new(
            (466.0 * scale).round() as u32,
            (height * scale).round() as u32,
        );
        clamp_to_monitor(&window, settings);
    } else {
        let expanded = load_config(&app).expanded;
        let height = if expanded {
            WIN_EXPANDED_H
        } else {
            WIN_COLLAPSED_H
        };
        let _ = window.set_size(tauri::LogicalSize::new(WIN_W, height));
    }
    true
}

/// 挂件上的 ⋯ 按钮：直接打开参数窗口（托盘菜单里另有全部开关）
#[tauri::command]
fn open_menu(app: AppHandle) {
    open_settings(app);
}

/* -------------------------------------------------------------- 菜单同步 */

fn theme_label(theme: &str) -> &'static str {
    match theme {
        "light" => "外观：浅白",
        "gold" => "外观：暗金",
        _ => "外观：深色",
    }
}

fn next_theme(theme: &str) -> &'static str {
    match theme {
        "dark" => "light",
        "light" => "gold",
        _ => "dark",
    }
}

fn sync_menu(app: &AppHandle, cfg: &Config) {
    let handles = match app.try_state::<TrayHandles>() {
        Some(h) => h,
        None => return,
    };

    let _ = handles.theme.set_text(theme_label(&cfg.theme));

    if let Some(w) = app.get_webview_window("main") {
        let _ = handles.top.set_checked(w.is_always_on_top().unwrap_or(true));
    }

    let pass = app
        .try_state::<AppState>()
        .map(|s| s.passthrough.load(Ordering::Relaxed))
        .unwrap_or(false);
    let _ = handles.pass.set_checked(pass);
}

/// 前端开始拖窗口时通知一声，拖动期间别去切穿透——窗口位置更新有延迟，
/// 40ms 的轮询会把鼠标瞬间算到窗口外，一切换拖动就断了、窗口弹回去。
#[tauri::command]
fn set_dragging(app: AppHandle, dragging: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        let until = if dragging { now_ms() + 1500 } else { 0 };
        state.dragging_until.store(until, Ordering::Relaxed);
    }
}

// 自己跟随鼠标移动，避免系统拖窗的贴边吸附和 WebView 消息接管。
#[tauri::command]
fn start_pet_drag(app: AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return; };
    let (Ok(origin), Ok(cursor)) = (win.outer_position(), app.cursor_position()) else { return; };
    std::thread::spawn(move || {
        while left_mouse_down() {
            if let Ok(current) = app.cursor_position() {
                let _ = win.set_position(PhysicalPosition::new(
                    origin.x + (current.x - cursor.x).round() as i32,
                    origin.y + (current.y - cursor.y).round() as i32,
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        if let Some(state) = app.try_state::<AppState>() {
            state.dragging_until.store(now_ms() + 150, Ordering::Relaxed);
        }
    });
}

fn apply_passthrough(app: &AppHandle, on: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        state.passthrough.store(on, Ordering::Relaxed);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(on);
    }
    let _ = app.emit("passthrough", on);
    let cfg = load_config(app);
    sync_menu(app, &cfg);
}

/// 透明的地方让鼠标穿过去，只让人物身体 / 金额 / 明细接住点击。
/// 不做的话，窗口矩形里那圈看不见的空气会把底下窗口的按钮全挡住。
fn start_click_through(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let Some(win) = app.get_webview_window("main") else {
                continue;
            };
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            // 托盘里手动开了「鼠标穿透」，或者设置页铺满整个窗口，都不归这里管
            if state.passthrough.load(Ordering::Relaxed) {
                ignoring = true;
                continue;
            }
            // 拖动保护仅在按住且确实开始拖挂件时生效。
            if left_mouse_down() && now_ms() < state.dragging_until.load(Ordering::Relaxed) {
                if ignoring {
                    ignoring = false;
                    let _ = win.set_ignore_cursor_events(false);
                }
                continue;
            }
            if state.settings_open.load(Ordering::Relaxed) {
                if ignoring {
                    ignoring = false;
                    let _ = win.set_ignore_cursor_events(false);
                }
                continue;
            }
            // 按在底下窗口时，保持原来的穿透状态，不能抢回后续鼠标事件。
            if left_mouse_down() { continue; }
            let Ok(cursor) = app.cursor_position() else {
                continue;
            };
            let Ok(pos) = win.outer_position() else {
                continue;
            };
            let scale = win.scale_factor().unwrap_or(1.0);
            let lx = (cursor.x - pos.x as f64) / scale;
            let ly = (cursor.y - pos.y as f64) / scale;
            let inside = state.hit_regions.lock().unwrap().iter().any(|r|
                lx >= r.x && lx <= r.x + r.width && ly >= r.y && ly <= r.y + r.height);
            let want = !inside;
            if want != ignoring {
                ignoring = want;
                let _ = win.set_ignore_cursor_events(ignoring);
            }
        }
    });
}

/* ----------------------------------------------------------------- 启动 */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            hit_regions: Mutex::new(Vec::new()),
            passthrough: AtomicBool::new(false),
            settings_open: AtomicBool::new(false),
            dragging_until: AtomicU64::new(0),
            cache: Mutex::new(ledger::ScanCache::default()),
            prices: ledger::load_prices(
                Some(plugin_data_dir().join("prices-cache.json").as_path()),
            ),
        })
        .invoke_handler(tauri::generate_handler![
            settlement::poll_settlement, settlement::settlement_bill, settlement::dismiss_settlement,
            get_config,
            set_config,get_state,
            recompute_today,
            set_expanded,
            set_mode,
            open_settings,
            open_menu,
            set_dragging,
            start_pet_drag,
            set_hit_regions,
            user_idle_ms,
            log_event
        ])
        .setup(|app| {
            let cfg = load_config(app.handle());

            /* ---- 托盘 ---- */
            let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let theme_item =
                MenuItem::with_id(app, "theme", theme_label(&cfg.theme), true, None::<&str>)?;
            let top_item = CheckMenuItem::with_id(app, "top", "始终置顶", true, true, None::<&str>)?;
            let pass_item =
                CheckMenuItem::with_id(app, "pass", "鼠标穿透（不挡点击）", true, false, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出计价器", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &settings_item,
                    &sep1,
                    &theme_item,
                    &top_item,
                    &pass_item,
                    &sep2,
                    &quit_item,
                ],
            )?;

            let mut builder = TrayIconBuilder::with_id("main-tray")
                .tooltip("计价器")
                .menu(&menu);

            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }

            builder
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref().to_string();
                    match id.as_str() {
                        "settings" => open_settings(app.clone()),
                        "quit" => app.exit(0),
                        "theme" => {
                            let mut cfg = load_config(app);
                            cfg.theme = next_theme(&cfg.theme).to_string();
                            save_config(app, &cfg);
                            let _ = app.emit("config-changed", &cfg);
                            sync_menu(app, &cfg);
                        }
                        "top" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let now = !w.is_always_on_top().unwrap_or(true);
                                let _ = w.set_always_on_top(now);
                            }
                            let cfg = load_config(app);
                            sync_menu(app, &cfg);
                        }
                        "pass" => {
                            let cur = app
                                .try_state::<AppState>()
                                .map(|s| s.passthrough.load(Ordering::Relaxed))
                                .unwrap_or(false);
                            apply_passthrough(app, !cur);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            app.manage(TrayHandles {
                theme: theme_item,
                top: top_item,
                pass: pass_item,
            });

            /* ---- 主窗口定位 ---- */
            if let Some(win) = app.get_webview_window("main") {
                let saved = load_position(app.handle());
                let saved_text = match saved {
                    Some(p) => format!("一些位置: ({}, {})", p.x, p.y),
                    None => "没有可用的位置记录".to_string(),
                };
                startup_log(
                    app.handle(),
                    &format!("启动; 数据目录={}; {saved_text}", data_dir(app.handle()).display()),
                );
                match saved {
                    Some(p) => {
                        let _ = win.set_position(PhysicalPosition::new(p.x, p.y));
                    }
                    None => {
                        if let Ok(Some(mon)) = win.primary_monitor() {
                            let screen = mon.size();
                            let own = win.outer_size().unwrap_or(tauri::PhysicalSize::new(
                                WIN_W as u32,
                                WIN_COLLAPSED_H as u32,
                            ));
                            let x = screen.width as i32 - own.width as i32 - 48;
                            let y = screen.height as i32 - own.height as i32 - 96;
                            let _ = win.set_position(PhysicalPosition::new(x, y));
                        }
                    }
                }
                let _ = win.show();
                // 窗口显示时系统偶尔会把它摆回默认位置：真发生了就按存档的位置再放一次。
                if let Some(p) = saved {
                    if let Ok(actual) = win.outer_position() {
                        if (actual.x - p.x).abs() > 2 || (actual.y - p.y).abs() > 2 {
                            startup_log(
                                app.handle(),
                                &format!(
                                    "显示后位置被改成 ({}, {})，按存档 ({}, {}) 重新放一次",
                                    actual.x, actual.y, p.x, p.y
                                ),
                            );
                            let _ = win.set_position(PhysicalPosition::new(p.x, p.y));
                        }
                    }
                }
            }

            apply_window_size(app.handle(), cfg.expanded);
            if let Some(win) = app.get_webview_window("main") {
                clamp_to_monitor(&win, physical_window_size(&win, cfg.expanded));
                if let Ok(final_pos) = win.outer_position() {
                    startup_log(
                        app.handle(),
                        &format!("定版位置: ({}, {})", final_pos.x, final_pos.y),
                    );
                }
            }
            // 透明区域穿透：只让人物和账目接住鼠标
            start_host_watch(app.handle().clone());
            start_click_through(app.handle().clone());

            // 调试用：SALARYMETER_OPEN_SETTINGS=1 时启动直接打开设置窗口，方便截图核对
            if std::env::var("SALARYMETER_OPEN_SETTINGS").ok().as_deref() == Some("1") {
                open_settings(app.handle().clone());
            }

            let cfg2 = load_config(app.handle());
            sync_menu(app.handle(), &cfg2);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Moved(pos) = event {
                if window.label() == "main" {
                    save_position(window.app_handle(), pos.x, pos.y);
                    // 窗口在动大概率是在拖：把「暂停穿透」的时间往后顺延，慢速长距离拖动也不会被打断
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        state
                            .dragging_until
                            .store(now_ms() + 1200, Ordering::Relaxed);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("计价器启动失败");
}
