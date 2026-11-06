mod ledger;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

/* 胶囊外观：和 DS Bot 里的插件挂件同尺寸，四周留 10px 透明边给投影 */
const WIN_W: f64 = 460.0;
const WIN_COLLAPSED_H: f64 = 410.0;
const WIN_EXPANDED_H: f64 = 520.0;

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
            theme: "dark".to_string(),
            character: "webm".to_string(),
            pet_scale: 130.0,
            expanded: false,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct SavedPos {
    x: i32,
    y: i32,
}

struct AppState {
    passthrough: AtomicBool,
    cache: Mutex<ledger::ScanCache>,
    prices: ledger::Prices,
}

struct TrayHandles {
    theme: MenuItem<tauri::Wry>,
    top: CheckMenuItem<tauri::Wry>,
    pass: CheckMenuItem<tauri::Wry>,
    login: CheckMenuItem<tauri::Wry>,
}

fn data_dir(app: &AppHandle) -> PathBuf {
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
        let _ = fs::write(path, text);
    }
}

fn load_position(app: &AppHandle) -> Option<SavedPos> {
    fs::read_to_string(data_dir(app).join("position.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<SavedPos>(&s).ok())
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
    config: Config,
    today: ledger::Totals,
    prices: PriceInfo,
    sessions: usize,
    updated: i64,
}

/// 挂件每 3 秒拉一次：参数 + 今日偷吃（自己扫 DS Bot 的会话日志算出来）。
/// 扫描是纯 CPU 活，必须放到异步线程上跑，否则会卡住主线程（窗口、设置页都会僵）。
#[tauri::command(async)]
fn get_state(app: AppHandle) -> StatePayload {
    let report = run_scan(&app, false);
    StatePayload {
        config: load_config(&app),
        today: report.today,
        prices: PriceInfo {
            source: report.prices,
            count: report.models,
        },
        sessions: report.sessions,
        updated: ledger::now_ms(),
    }
}

/// 设置页的「重算今天的账」：丢掉缓存，把今天的会话全部重扫一遍。
#[tauri::command(async)]
fn recompute_today(app: AppHandle) -> StatePayload {
    let report = run_scan(&app, true);
    StatePayload {
        config: load_config(&app),
        today: report.today,
        prices: PriceInfo {
            source: report.prices,
            count: report.models,
        },
        sessions: report.sessions,
        updated: ledger::now_ms(),
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
    clamp_to_monitor(&window);
}

fn clamp_to_monitor(window: &tauri::WebviewWindow) {
    let (Ok(position), Ok(size), Ok(Some(monitor))) = (
        window.outer_position(),
        window.outer_size(),
        window.current_monitor(),
    ) else {
        return;
    };
    let area = monitor.size();
    let origin = monitor.position();
    let margin = 12;
    let max_x = origin.x + area.width as i32 - size.width as i32 - margin;
    let max_y = origin.y + area.height as i32 - size.height as i32 - margin;
    let x = position.x.clamp(origin.x + margin, max_x.max(origin.x + margin));
    let y = position.y.clamp(origin.y + margin, max_y.max(origin.y + margin));
    if x != position.x || y != position.y {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
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
    if mode == "settings" {
        // 设置页比屏幕还高就按屏幕压一下，标题栏和关闭按钮得一直看得见
        let scale = window.scale_factor().unwrap_or(1.0);
        let monitor_height = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|monitor| monitor.size().height as f64 / scale)
            .unwrap_or(820.0);
        let height = 820.0_f64.min(monitor_height - 40.0).max(520.0);
        let _ = window.set_size(tauri::LogicalSize::new(466.0, height));
    } else {
        let expanded = load_config(&app).expanded;
        let height = if expanded {
            WIN_EXPANDED_H
        } else {
            WIN_COLLAPSED_H
        };
        let _ = window.set_size(tauri::LogicalSize::new(WIN_W, height));
    }
    clamp_to_monitor(&window);
    true
}

/// 挂件上的 ⋯ 按钮：直接打开参数窗口（托盘菜单里另有全部开关）
#[tauri::command]
fn open_menu(app: AppHandle) {
    open_settings(app);
}

#[tauri::command]
fn get_login(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_login(app: AppHandle, enabled: bool) -> bool {
    let al = app.autolaunch();
    let _ = if enabled { al.enable() } else { al.disable() };
    let now = al.is_enabled().unwrap_or(false);
    if let Some(h) = app.try_state::<TrayHandles>() {
        let _ = h.login.set_checked(now);
    }
    now
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
    let _ = handles.login.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
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

/* ----------------------------------------------------------------- 启动 */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            passthrough: AtomicBool::new(false),
            cache: Mutex::new(ledger::ScanCache::default()),
            prices: ledger::load_prices(
                Some(plugin_data_dir().join("prices-cache.json").as_path()),
            ),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            get_state,
            recompute_today,
            set_expanded,
            set_mode,
            open_settings,
            open_menu,
            get_login,
            set_login
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
            let login_item =
                CheckMenuItem::with_id(app, "login", "开机自启", true, false, None::<&str>)?;
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
                    &login_item,
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
                        "login" => {
                            let now = app.autolaunch().is_enabled().unwrap_or(false);
                            let _ = set_login(app.clone(), !now);
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
                login: login_item,
            });

            /* ---- 主窗口定位 ---- */
            if let Some(win) = app.get_webview_window("main") {
                match load_position(app.handle()) {
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
            }

            apply_window_size(app.handle(), cfg.expanded);

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
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("计价器启动失败");
}
