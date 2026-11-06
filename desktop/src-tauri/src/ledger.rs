//! 桌面版工资挂件的账本：直接扫 DS Bot 的会话日志，按官方单价折算 token 花费。
//!
//! 与 dsh-salary-meter 插件的算法保持一致：
//! - 只算今天（北京时间）发生的用量事件；
//! - 按模型名认价格，不看入口；DeepSeek 有工作日峰谷折扣，其余平价；
//! - 会话日志是多个 zstd 帧首尾相接，按流式解码全部帧。

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const USD: f64 = 7.15;

/* ---------------------------------------------------------------- 时间 */

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 毫秒时间戳 → 北京时间的日期字符串 YYYY-MM-DD。
pub fn beijing_day(time_ms: i64) -> String {
    let secs = time_ms.div_euclid(1000) + 8 * 3600;
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// 北京时间今天 00:00 对应的真实毫秒时间戳。
pub fn day_start_ms(time_ms: i64) -> i64 {
    let shifted = time_ms + 8 * 3600_000;
    shifted.div_euclid(86_400_000) * 86_400_000 - 8 * 3600_000
}

/// 北京时间某时刻的工作日（0=周日）与小时（含小数）。
fn beijing_parts(time_ms: i64) -> (i64, f64) {
    let secs = time_ms.div_euclid(1000) + 8 * 3600;
    let days = secs.div_euclid(86_400);
    let of_day = secs.rem_euclid(86_400);
    // 1970-01-01 是周四
    let weekday = (days + 4).rem_euclid(7);
    (weekday, of_day as f64 / 3600.0)
}

/* ---------------------------------------------------------------- 价格 */

pub struct Prices {
    table: HashMap<String, [f64; 3]>,
    pub source: String,
}

impl Prices {
    pub fn count(&self) -> usize {
        self.table.len()
    }
}

fn builtin() -> HashMap<String, [f64; 3]> {
    let rows: [(&str, [f64; 3]); 36] = [
        // DeepSeek（人民币）
        ("deepseek-flash", [2.0, 0.04, 8.0]),
        ("deepseek-v4-flash", [2.0, 0.04, 8.0]),
        ("deepseek-v4.1-flash", [2.0, 0.04, 8.0]),
        ("deepseek-v4-flash-vision-exp", [2.0, 0.04, 8.0]),
        ("deepseek-v4-pro", [9.0, 0.3, 27.0]),
        // 智谱 GLM（人民币）
        ("glm-5.3", [8.0, 2.0, 28.0]),
        ("glm-5.3-flash", [0.8, 0.23, 2.8]),
        ("glm-5.3-flashx", [2.0, 0.57, 7.0]),
        // 阶跃 Step（人民币）
        ("step-5-preview", [7.0, 0.7, 20.0]),
        // Kimi（人民币）
        ("kimi-k3", [20.0, 2.0, 100.0]),
        // 通义 Qwen（人民币）
        ("qwen3.8-max", [12.0, 1.2, 36.0]),
        ("qwen3.7-max", [12.0, 1.2, 36.0]),
        ("qwen3.8-flash", [0.8, 0.08, 2.7]),
        ("qwen3.7-flash", [0.2, 0.02, 0.8]),
        // MiniMax（人民币）
        ("minimax-m3", [2.1, 0.42, 8.4]),
        ("minimax-m3.1-flash", [1.0, 0.1, 4.0]),
        // OpenAI（美元 → 人民币）
        ("gpt-5.1", [1.25 * USD, 0.125 * USD, 10.0 * USD]),
        ("gpt-5", [1.25 * USD, 0.125 * USD, 10.0 * USD]),
        ("gpt-5-mini", [0.25 * USD, 0.025 * USD, 2.0 * USD]),
        ("gpt-5-nano", [0.05 * USD, 0.005 * USD, 0.4 * USD]),
        ("gpt-5.2", [1.75 * USD, 0.175 * USD, 14.0 * USD]),
        ("gpt-5.4", [2.5 * USD, 0.25 * USD, 15.0 * USD]),
        ("gpt-4.1", [2.0 * USD, 0.5 * USD, 8.0 * USD]),
        ("gpt-4o", [2.5 * USD, 1.25 * USD, 10.0 * USD]),
        ("o3", [2.0 * USD, 0.5 * USD, 8.0 * USD]),
        // Anthropic Claude（美元 → 人民币）
        ("claude-opus-5.5", [4.0 * USD, 0.2 * USD, 20.0 * USD]),
        ("claude-opus-5", [5.0 * USD, 0.5 * USD, 25.0 * USD]),
        ("claude-sonnet-5.5", [2.0 * USD, 0.1 * USD, 10.0 * USD]),
        ("claude-sonnet-5", [2.0 * USD, 0.2 * USD, 10.0 * USD]),
        ("claude-sonnet-4.5", [3.0 * USD, 0.3 * USD, 15.0 * USD]),
        ("claude-haiku-4.5", [1.0 * USD, 0.1 * USD, 5.0 * USD]),
        // Google Gemini（美元 → 人民币）
        ("gemini-3.1-pro-preview", [2.0 * USD, 0.2 * USD, 12.0 * USD]),
        // xAI Grok（美元 → 人民币）
        ("grok-4.7", [2.0 * USD, 0.5 * USD, 6.0 * USD]),
        ("grok-4.6", [2.0 * USD, 0.5 * USD, 6.0 * USD]),
        ("grok-4.5", [2.0 * USD, 0.3 * USD, 6.0 * USD]),
        ("grok-4.3", [1.25 * USD, 0.2 * USD, 2.5 * USD]),
    ];
    rows.iter()
        .map(|(name, price)| (name.to_string(), *price))
        .collect()
}

/// 读插件留下的远程价格缓存（如果有），合并进内置价目表。
pub fn load_prices(cache_file: Option<&Path>) -> Prices {
    let mut table = builtin();
    let mut source = String::from("内置");
    if let Some(path) = cache_file {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                let mut merged = 0usize;
                if let Some(map) = value.get("prices").and_then(|v| v.as_object()) {
                    for (model, raw) in map {
                        if let Some(items) = raw.as_array() {
                            if items.len() != 3 {
                                continue;
                            }
                            let parsed: Option<Vec<f64>> = items
                                .iter()
                                .map(|item| item.as_f64().filter(|v| *v >= 0.0))
                                .collect();
                            if let Some(values) = parsed {
                                table.insert(
                                    model.to_lowercase(),
                                    [values[0], values[1], values[2]],
                                );
                                merged += 1;
                            }
                        }
                    }
                }
                if merged > 0 {
                    source = format!("缓存（{} 条）", merged);
                }
            }
        }
    }
    Prices { table, source }
}

/// 模型名带日期后缀时也能匹配，例如 gpt-5.1-2026-08-07 → gpt-5.1。
fn strip_date_suffix(model: &str) -> Option<String> {
    for (idx, _) in model.match_indices('-') {
        let rest = &model[idx + 1..];
        let b = rest.as_bytes();
        if b.len() < 10 {
            continue;
        }
        let digits = |range: std::ops::Range<usize>| b[range].iter().all(|c| c.is_ascii_digit());
        if b[0] == b'2'
            && digits(0..4)
            && (b[4] == b'-' || b[4] == b'.')
            && digits(5..7)
            && (b[7] == b'-' || b[7] == b'.')
            && digits(8..10)
        {
            return Some(model[..idx].to_string());
        }
    }
    None
}

fn price_of(prices: &Prices, model: &str) -> Option<[f64; 3]> {
    if model.is_empty() {
        return None;
    }
    let key = model.to_lowercase();
    if let Some(found) = prices.table.get(&key) {
        return Some(*found);
    }
    let base = strip_date_suffix(&key)?;
    prices.table.get(&base).copied()
}

/* ---------------------------------------------------------------- 计费 */

#[derive(Clone, Copy, Default, serde::Serialize)]
pub struct Totals {
    pub expense: f64,
    pub known: u64,
    pub unknown: u64,
}

#[derive(Clone, Copy)]
struct Usage {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
}

/// 返回 None 表示「有用量但算不出价」，计入未算笔数。
fn estimate(prices: &Prices, model: &str, usage: Usage, time_ms: i64) -> Option<f64> {
    if model.is_empty() {
        return Some(0.0);
    }
    let price = match price_of(prices, model) {
        Some(value) => value,
        None => {
            return if model.to_lowercase().starts_with("deepseek") {
                None
            } else {
                Some(0.0)
            }
        }
    };
    if usage.input < 0 || usage.output < 0 || usage.cache_read < 0 || usage.cache_write < 0 {
        return None;
    }
    let (weekday, hour) = beijing_parts(time_ms);
    let peak = weekday > 0 && weekday < 6 && ((hour >= 9.0 && hour < 12.0) || (hour >= 14.0 && hour < 18.0));
    let discount = if model.to_lowercase().starts_with("deepseek") {
        if peak {
            1.0
        } else {
            0.5
        }
    } else {
        1.0
    };
    let cost = ((usage.input + usage.cache_write) as f64 * price[0]
        + usage.cache_read as f64 * price[1]
        + usage.output as f64 * price[2])
        / 1_000_000.0
        * discount;
    Some(cost)
}

/* ---------------------------------------------------------------- 扫描 */

fn decode_session(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    // 会话日志是多个 zstd 帧首尾相接；流式解码会逐帧解，写到一半的尾帧报错时保留已解出的部分。
    let mut decoder = zstd::stream::read::Decoder::new(&bytes[..]).ok()?;
    let mut out = Vec::with_capacity(bytes.len() * 8);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match decoder.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => out.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

fn tokens(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn scan_file(path: &Path, prices: &Prices, day: &str) -> Totals {
    let mut totals = Totals::default();
    let Some(text) = decode_session(path) else {
        return totals;
    };
    let mut route = String::new();
    for line in text.lines() {
        let has_usage = line.contains("\"usage\"");
        let has_header = line.contains("request/header");
        if !has_usage && !has_header {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if has_header && kind == "request/header" {
            if let Some(model) = event
                .pointer("/data/header/config/model")
                .and_then(|v| v.as_str())
            {
                route = model.to_string();
            }
            continue;
        }
        if kind != "assistant/message" && kind != "assistant/attempt" {
            continue;
        }
        let Some(time_ms) = event.get("time").and_then(|v| v.as_i64()) else {
            continue;
        };
        if beijing_day(time_ms) != day {
            continue;
        }
        let Some(stream) = event.pointer("/data/stream").and_then(|v| v.as_array()) else {
            continue;
        };
        let usage = stream.iter().rev().find_map(|record| {
            if record.get("type").and_then(|v| v.as_str()) != Some("chunk") {
                return None;
            }
            let chunk = record.get("chunk")?;
            if chunk.get("type").and_then(|v| v.as_str()) != Some("usage") {
                return None;
            }
            chunk.get("usage")
        });
        let Some(usage) = usage else {
            continue;
        };
        let parsed = Usage {
            input: tokens(usage, "inputTokens"),
            output: tokens(usage, "outputTokens"),
            cache_read: tokens(usage, "cacheReadTokens"),
            cache_write: tokens(usage, "cacheWriteTokens"),
        };
        match estimate(prices, &route, parsed, time_ms) {
            Some(cost) => {
                totals.expense += cost;
                totals.known += 1;
            }
            None => totals.unknown += 1,
        }
    }
    totals
}

fn session_files(home: &Path, since_ms: i64) -> Vec<(PathBuf, u64, u64)> {
    let root = home.join("sessions");
    let mut found = Vec::new();
    let Ok(groups) = fs::read_dir(&root) else {
        return found;
    };
    for group in groups.flatten() {
        if !group.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(sessions) = fs::read_dir(group.path()) else {
            continue;
        };
        for session in sessions.flatten() {
            let Ok(file_type) = session.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            if !session.file_name().to_string_lossy().starts_with("session-") {
                continue;
            }
            let file = session.path().join("session.v4.jsonl.zstd");
            let Ok(meta) = fs::metadata(&file) else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // 只碰今天写过的日志：昨天收工的会话不可能有新事件。
            if modified < since_ms {
                continue;
            }
            found.push((file, modified as u64, meta.len()));
        }
    }
    found
}

#[derive(Default)]
pub struct ScanCache {
    entries: HashMap<PathBuf, (u64, u64, Totals)>,
}

impl ScanCache {
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[derive(serde::Serialize)]
pub struct ScanReport {
    pub today: Totals,
    pub sessions: usize,
    pub prices: String,
    pub models: usize,
}

/// 扫今天所有会话日志，返回今日花费。未变化的文件直接复用上次结果。
pub fn scan_today(prices: &Prices, cache: &mut ScanCache, home: &Path) -> ScanReport {
    let now = now_ms();
    let day = beijing_day(now);
    let files = session_files(home, day_start_ms(now));
    let mut totals = Totals::default();
    let mut seen = Vec::with_capacity(files.len());
    for (path, modified, len) in files {
        let reuse = cache
            .entries
            .get(&path)
            .filter(|(m, l, _)| *m == modified && *l == len)
            .map(|(_, _, value)| *value);
        let value = match reuse {
            Some(value) => value,
            None => {
                let value = scan_file(&path, prices, &day);
                cache.entries.insert(path.clone(), (modified, len, value));
                value
            }
        };
        totals.expense += value.expense;
        totals.known += value.known;
        totals.unknown += value.unknown;
        seen.push(path);
    }
    cache.entries.retain(|path, _| seen.contains(path));
    ScanReport {
        today: totals,
        sessions: seen.len(),
        prices: prices.source.clone(),
        models: prices.count(),
    }
}
