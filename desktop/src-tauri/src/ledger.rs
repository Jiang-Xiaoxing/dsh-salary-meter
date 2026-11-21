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

/// 毫秒时间戳 → 北京时间的月份字符串 YYYY-MM。
pub fn beijing_month(time_ms: i64) -> String {
    beijing_day(time_ms)[..7].to_string()
}

/// 北京时间本月 1 号 00:00 对应的真实毫秒时间戳。
/// 北京时间没有夏令时，每天正好 86_400_000 毫秒，所以从今天零点往回退 (日-1) 天就够。
pub fn month_start_ms(time_ms: i64) -> i64 {
    let day = beijing_day(time_ms);
    let date: i64 = day[8..10].parse().unwrap_or(1);
    day_start_ms(time_ms) - (date - 1) * 86_400_000
}

/// 下个月 1 号 00:00。
///
/// 必须从「本月 1 号」往后挪，不能从「当前时刻」往后挪：
/// 11-30 当天挪 32 天正好是次年 1-1，取到的「下月初」就成了元旦，
/// 于是 11 月的统计会连带把 12 月整月算进来。同理 12-31、2-28 这些月末都会错。
/// 从 1 号挪 31 天则一定落在下个月内（最短的 2 月也有 28 天），再取那个月的 1 号就稳。
fn next_month_start_ms(time_ms: i64) -> i64 {
    month_start_ms(month_start_ms(time_ms) + 31 * 86_400_000)
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

#[derive(Clone, Default, serde::Serialize)]
pub struct Totals {
    pub hour_out: u64,
    pub hour_dur_ms: f64,
    #[serde(skip)]
    samples: Vec<SpeedSample>,
    pub expense: f64,
    pub known: u64,
    pub unknown: u64,
}

#[derive(Clone)]
struct SpeedSample {
    time: i64,
    output: u64,
    duration_ms: f64,
}

impl Totals {
    fn refresh_hour(&mut self, now: i64) {
        self.hour_out = 0;
        self.hour_dur_ms = 0.0;
        for sample in &self.samples {
            if sample.time > now - 3_600_000 && sample.time <= now {
                self.hour_out += sample.output;
                self.hour_dur_ms += sample.duration_ms;
            }
        }
    }

    pub fn tps(&self) -> Option<f64> {
        (self.hour_out >= 200 && self.hour_dur_ms >= 500.0)
            .then(|| self.hour_out as f64 * 1000.0 / self.hour_dur_ms)
    }
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

/// 解压会话日志，顺便告诉调用方这次算不算「彻底解不出来」。
///
/// 会话日志是多个 zstd 帧首尾相接，正在写的文件末尾常有个写了一半的帧：
/// 那属于正常情况，已经解出来的部分照样有用，**不算失败**。
/// 只有连解码器都建不起来、或者一个字节都没解出来（文件却有内容）才算真坏。
fn decode_session_with(path: &Path) -> (String, bool) {
    let Ok(bytes) = fs::read(path) else {
        return (String::new(), true);
    };
    let mut decoder = match zstd::stream::read::Decoder::new(&bytes[..]) {
        Ok(decoder) => decoder,
        Err(_) => return (String::new(), !bytes.is_empty()),
    };
    let mut out = Vec::with_capacity(bytes.len() * 8);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match decoder.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => out.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&out).into_owned();
    let broken = text.is_empty() && !bytes.is_empty();
    (text, broken)
}

/// 旧版入口，只留给出对账用的老实现。
#[cfg(test)]
fn decode_session(path: &Path) -> Option<String> {
    let (text, _) = decode_session_with(path);
    Some(text)
}


fn tokens(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

/// 一次带用量的助手事件，解析后的形状。
struct UsageEvent<'a> {
    /// 这一刻生效的模型名（来自前面最近的 request/header）。
    route: &'a str,
    kind: &'a str,
    time_ms: i64,
    usage: Usage,
    stream: &'a [serde_json::Value],
}

/// 逐个事件取出用量。今日花费和本月 token 共用这一份解析，口径必须完全一致：
/// - 只认 `request/header`（更新模型名）、`assistant/message`、`assistant/attempt`；
/// - 每条消息的用量取 `data.stream` 里最后一个 `chunk.type=usage`，前面的是增量片段；
/// - 解压失败的文件返回 false，由调用方决定是跳过还是记一笔失败。
fn walk_usages<F>(path: &Path, mut on_event: F) -> bool
where
    F: FnMut(UsageEvent<'_>),
{
    let (text, broken) = decode_session_with(path);
    if broken {
        return false;
    }
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
        on_event(UsageEvent { route: &route, kind, time_ms, usage: parsed, stream });
    }
    true
}

fn scan_file(path: &Path, prices: &Prices, day: &str) -> Totals {
    let mut totals = Totals::default();
    walk_usages(path, |event| {
        let UsageEvent { route, kind, time_ms, usage: parsed, stream } = event;
        if kind == "assistant/message" && parsed.output >= 200 {
            let times: Vec<f64> = stream.iter().flat_map(|r|
                ["time", "time0"].into_iter().filter_map(move |k| r.get(k).and_then(|v| v.as_f64()))
            ).filter(|v| v.is_finite()).collect();
            let min = times.iter().copied().reduce(f64::min);
            let max = times.iter().copied().reduce(f64::max);
            if let (Some(min), Some(max)) = (min, max) {
                let dur = max - min;
                if dur >= 500.0 && dur.is_finite() {
                    totals.samples.push(SpeedSample {
                        time: time_ms,
                        output: parsed.output as u64,
                        duration_ms: dur,
                    });
                }
            }
        }        // Expenses remain strictly today's; speed samples may cross midnight.
        if beijing_day(time_ms) != day {
            return;
        }
        match estimate(prices, route, parsed, time_ms) {
            Some(cost) => {
                totals.expense += cost;
                totals.known += 1;
            }
            None => totals.unknown += 1,
        }
    });
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
    day: String,
    entries: HashMap<PathBuf, (u64, u64, Totals)>,
}

impl ScanCache {
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// 本月 token 的一格汇总。
#[derive(Clone, Default, serde::Serialize)]
pub struct MonthTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// 参与统计的用量事件笔数（跟算钱的「笔」一个口径）。
    pub events: u64,
}

impl MonthTotals {
    /// 输入 + 输出。缓存读单列，故意不并进来（并进去就成 56 亿，看不出是 token 了）。
    pub fn total(&self) -> u64 {
        self.input.saturating_add(self.output)
    }
    fn add(&mut self, usage: Usage) {
        // 负数表示日志写坏了；跳过这一笔，别把总数拉低。
        if usage.input < 0 || usage.output < 0 || usage.cache_read < 0 || usage.cache_write < 0 {
            return;
        }
        self.input += usage.input as u64;
        self.output += usage.output as u64;
        self.cache_read += usage.cache_read as u64;
        self.cache_write += usage.cache_write as u64;
        self.events += 1;
    }
}

/// 一份会话文件里，本月和今天各用了多少。
/// 同一次解压顺带数完两笔，免得为了「今天 token」把两百多兆日志再扫一遍。
#[derive(Clone, Default)]
struct FileUsage {
    month: MonthTotals,
    today: MonthTotals,
}

/// 本月 token 的扫描缓存：跟今日账目分开，按 (path, mtime, len) 复用。
#[derive(Default)]
pub struct MonthCache {
    month: String,
    /// 今天（北京日期）。跨天要跟着一起清，
    /// 否则昨天的 today 会被当成今天的数显示出来。
    day: String,
    /// (mtime, len, 用量)。
    /// 解析失败的那条不入缓存：文件可能只是被临时独占，下一轮要重试，
    /// 否则这个文件会一直被当成 0，权限恢复了也补不上。
    entries: HashMap<PathBuf, (u64, u64, FileUsage)>,
}

impl MonthCache {
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[derive(Clone, serde::Serialize)]
pub struct MonthReport {
    pub month_start_ms: i64,
    pub tokens: MonthTotals,
    /// 今天（北京时间 0 点到现在）的 token 用量。
    pub today: MonthTotals,
    /// 今天 00:00 的毫秒时间戳，前端拿它标「今天」是哪一天。
    pub today_start_ms: i64,
    /// 本月输入 + 输出，主数字就用它。由 Rust 算好传给前端，免得两边各算一遍对不上。
    pub total: u64,
    /// 今天输入 + 输出。
    pub today_total: u64,
    /// 扫了几个会话文件（去重后）。
    pub files: usize,
    /// 其中真有本月用量事件的有几个。
    pub files_with_events: usize,
    /// 解压失败、被跳过的文件数。>0 时数字偏小，设置页会标出来。
    pub failed: usize,
}

/// 同一个会话可能同时出现在多个数据目录里（从旧 DS Bot 迁移时复制过一份）。
/// 按会话编号去重，只留文件更新的那份，避免同一笔钱算两遍。
fn dedupe_sessions(files: Vec<(PathBuf, u64, u64)>) -> Vec<(PathBuf, u64, u64)> {
    let mut best: HashMap<String, (PathBuf, u64, u64)> = HashMap::new();
    for (path, modified, len) in files {
        let id = path
            .parent()
            .and_then(|dir| dir.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let keep = match best.get(&id) {
            Some((_, seen_modified, seen_len)) => modified > *seen_modified || (modified == *seen_modified && len > *seen_len),
            None => true,
        };
        if keep {
            best.insert(id, (path, modified, len));
        }
    }
    best.into_values().collect()
}

/// 本月统计要扫的会话文件：不做 mtime 粗筛。
/// 理由是迁移/复制过的日志可能保留旧 mtime，但里面确实有本月事件；
/// 而算钱那条路径要的是「便宜」，这里要的是「全」，所以两边筛法不一样。
fn all_session_files(home: &Path) -> Vec<(PathBuf, u64, u64)> {
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
            // 跟算钱一个口径：只认 session-*，mnemon 那批记忆子任务不算。
            if !session.file_name().to_string_lossy().starts_with("session-") {
                continue;
            }
            let file = session.path().join("session.v4.jsonl.zstd");
            let Ok(meta) = fs::metadata(&file) else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            found.push((file, modified, meta.len()));
        }
    }
    found
}

/// 扫本月所有会话日志的 token 用量。未变化的文件直接复用上次结果。
/// 顺手把「今天」的用量也数出来：同一次解压顺路数两笔，不额外读盘。
pub fn scan_month_roots(cache: &mut MonthCache, roots: &[PathBuf], now: i64) -> MonthReport {
    let month = beijing_month(now);
    let day = beijing_day(now);
    // 跨月或跨天都要清缓存：跨月不清会算错本月，跨天不清会把昨天的 today 当今天。
    if cache.month != month || cache.day != day {
        cache.clear();
        cache.month = month;
        cache.day = day;
    }
    let since = month_start_ms(now);
    let until = next_month_start_ms(now);
    // 今天的上界必须是「明天 0 点」，不是「下月 1 号」：拿 until 当上界的话，
    // 日志里只要有明天或后天的记录（时钟回拨、日志写在前）就会提前算进今天。
    let today_since = day_start_ms(now);
    let today_until = today_since + 86_400_000;
    let mut files = Vec::new();
    for root in roots {
        files.extend(all_session_files(root));
    }
    let files = dedupe_sessions(files);
    let mut tokens = MonthTotals::default();
    let mut today = MonthTotals::default();
    let mut files_with_events = 0usize;
    let mut failed = 0usize;
    let mut seen = Vec::with_capacity(files.len());
    for (path, modified, len) in files {
        let reuse = cache
            .entries
            .get(&path)
            .filter(|(m, l, _)| *m == modified && *l == len)
            .map(|(_, _, value)| value.clone());
        let (value, ok) = match reuse {
            Some(hit) => (hit, true),
            None => {
                let mut value = FileUsage::default();
                // 单个文件解压失败只跳过它，不影响其他文件。
                let ok = walk_usages(&path, |event| {
                    if event.time_ms >= since && event.time_ms < until {
                        value.month.add(event.usage);
                    }
                    // 今天的区间一定落在本月区间里（1 号 0 点起），不用再比一次月份。
                    if event.time_ms >= today_since && event.time_ms < today_until {
                        value.today.add(event.usage);
                    }
                });
                // 只有成功解析才入缓存：失败的多半是临时占用，下一轮要重试。
                if ok {
                    cache
                        .entries
                        .insert(path.clone(), (modified, len, value.clone()));
                }
                (value, ok)
            }
        };
        if !ok {
            failed += 1;
        }
        if value.month.events > 0 {
            files_with_events += 1;
        }
        tokens.input += value.month.input;
        tokens.output += value.month.output;
        tokens.cache_read += value.month.cache_read;
        tokens.cache_write += value.month.cache_write;
        tokens.events += value.month.events;
        today.input += value.today.input;
        today.output += value.today.output;
        today.cache_read += value.today.cache_read;
        today.cache_write += value.today.cache_write;
        today.events += value.today.events;
        seen.push(path);
    }
    // 清掉这一轮没见到的文件。用 HashSet 查，别用 Vec::contains：
    // 会话攒到几千个时那是 O(N²)。
    let seen_set: std::collections::HashSet<PathBuf> = seen.iter().cloned().collect();
    cache.entries.retain(|path, _| seen_set.contains(path));
    let total = tokens.total();
    let today_total = today.total();
    MonthReport {
        month_start_ms: since,
        tokens,
        today,
        today_start_ms: today_since,
        total,
        today_total,
        files: seen.len(),
        files_with_events,
        failed,
    }
}

#[derive(serde::Serialize)]
pub struct ScanReport {
    pub today: Totals,
    pub sessions: usize,
    pub prices: String,
    pub models: usize,
    /// 今天写过的会话日志里，最近一次的修改时间（毫秒）；没有会话就是 0。
    /// 挂件用它判断还有没有人在用 DSH／DS Bot（两分钟内写过就算在跑）。
    pub last_write_ms: i64,
    /// 这一轮实际读了哪几个目录（给设置页显示，出问题一眼能看出来）。
    pub dirs: Vec<String>,
}

/// 扫今天所有会话日志，返回今日花费。未变化的文件直接复用上次结果。
#[allow(dead_code)] // 单元测试还在用单目录版本
pub fn scan_today(prices: &Prices, cache: &mut ScanCache, home: &Path) -> ScanReport {
    scan_today_roots(prices, cache, &[home.to_path_buf()])
}
pub fn scan_today_roots(prices: &Prices, cache: &mut ScanCache, roots: &[PathBuf]) -> ScanReport {
    scan_at_roots(prices, cache, roots, now_ms())
}
#[allow(dead_code)] // 单元测试还在用单目录版本
pub fn scan_at(prices: &Prices, cache: &mut ScanCache, home: &Path, now: i64) -> ScanReport {
    scan_at_roots(prices, cache, &[home.to_path_buf()], now)
}
pub fn scan_at_roots(prices: &Prices, cache: &mut ScanCache, roots: &[PathBuf], now: i64) -> ScanReport {
    let day = beijing_day(now);
    if cache.day != day {
        cache.clear();
        cache.day = day.clone();
    }
    let since = day_start_ms(now).min(now - 3_600_000);
    let mut files = Vec::new();
    for root in roots {
        files.extend(session_files(root, since));
    }
    let files = dedupe_sessions(files);
    let mut totals = Totals::default();
    let mut seen = Vec::with_capacity(files.len());
    let mut last_write_ms = 0i64;
    for (path, modified, len) in files {
        last_write_ms = last_write_ms.max(modified as i64);
        let reuse = cache
            .entries
            .get(&path)
            .filter(|(m, l, _)| *m == modified && *l == len)
            .map(|(_, _, value)| value.clone());
        let value = match reuse {
            Some(value) => value,
            None => {
                let value = scan_file(&path, prices, &day);
                cache.entries.insert(path.clone(), (modified, len, value.clone()));
                value
            }
        };
        totals.samples.extend(value.samples);
        totals.expense += value.expense;
        totals.known += value.known;
        totals.unknown += value.unknown;
        seen.push(path);
    }
    cache.entries.retain(|path, _| seen.contains(path));
    totals.refresh_hour(now);
    ScanReport {
        today: totals,
        sessions: seen.len(),
        prices: prices.source.clone(),
        models: prices.count(),
        last_write_ms,
        dirs: roots.iter().map(|root| root.display().to_string()).collect(),
    }
}

#[cfg(test)]
mod tps_tests {
    use super::*;

    #[test]
    fn rolling_hour_is_weighted_and_expires_without_new_events() {
        let now = 1793980801000; // 2026-11-07 00:00:01 Beijing // includes previous day's samples
        let mut totals = Totals::default();
        for (age, output, duration_ms) in [
            (100, 200, 1000.0), (2000, 800, 10000.0),
            (3_600_000, 900, 500.0), (-1, 999, 500.0),
        ] {
            totals.samples.push(SpeedSample {time: now - age, output, duration_ms});
        }
        totals.refresh_hour(now);
        assert_eq!(totals.hour_out, 1000);
        assert_eq!(totals.hour_dur_ms, 11000.0);
        assert!((totals.tps().unwrap() - 90.909090909).abs() < 0.000001);
        totals.refresh_hour(now + 3_600_002);
        assert_eq!(totals.tps(), None);
    }

    #[test]
    fn scanner_filters_short_messages_and_keeps_expenses_today_only() {
        let now = 1793980801000; // 2026-11-07 00:00:01 Beijing
        let mut lines = vec![serde_json::json!({"type":"request/header", "data":{"header":{"config":{"model":"deepseek-flash"}}}}).to_string()];
        for (kind, time, output, duration) in [
            ("assistant/message", now - 2000, 800, 10000),
            ("assistant/message", now, 200, 500),
            ("assistant/message", now, 199, 1000),
            ("assistant/message", now, 800, 499),
            ("assistant/attempt", now, 800, 1000),
        ] {
            lines.push(serde_json::json!({"type":kind,"time":time,"data":{"stream":[
                {"time0":100,"time":"ignore"},
                {"type":"chunk","time":100+duration,"chunk":{"type":"usage","usage":{"outputTokens":output}}}
            ]}}).to_string());
        }
        let path = std::env::temp_dir().join(format!("salary-hour-{}.zstd", std::process::id()));
        fs::write(&path, zstd::stream::encode_all(lines.join("\n").as_bytes(), 0).unwrap()).unwrap();
        let mut totals = scan_file(&path, &load_prices(None), &beijing_day(now));
        let yesterday = scan_file(&path, &load_prices(None), &beijing_day(now-2000));
        assert_eq!(yesterday.known, 1);
        assert!((yesterday.expense - 800.0 * 8.0 / 1_000_000.0 * 0.5).abs() < 1e-10);
        fs::remove_file(path).unwrap();
        totals.refresh_hour(now);
        assert_eq!(totals.hour_out, 1000);
        assert_eq!(totals.hour_dur_ms, 10500.0);
        assert_eq!(totals.known, 4);
        // Saturday off-peak: only today's four usage events, including attempts.
        assert!((totals.expense - 1999.0 * 8.0 / 1_000_000.0 * 0.5).abs() < 1e-10);
    }

    #[test]
    fn real_hour() {
        let Ok(profile) = std::env::var("USERPROFILE") else { return };
        let home = PathBuf::from(profile).join(".ds-bot");
        let report = scan_today(&load_prices(None), &mut ScanCache::default(), &home);
        println!("TPS_HOUR out={} dur={} tps={:?}",
            report.today.hour_out, report.today.hour_dur_ms, report.today.tps());
    }
}

/// 临时：重构前后对账用。跑真实快照，打印五项数字。定稿前删除。
#[cfg(test)]
mod baseline_probe {
    use super::*;

    /// 固定时刻，避免重跑时「近1小时」窗口跟着真实时间滑动而数字不同。
    const FIXED_NOW: i64 = 1_795_231_200_000; // 2026-11-21 11:20:00 北京时间

    fn roots() -> [PathBuf; 2] {
        [
            PathBuf::from(r"E:\SalaryMeter\tmp\baseline-roots\ds-bot"),
            PathBuf::from(r"E:\SalaryMeter\tmp\baseline-roots\dsh"),
        ]
    }

    /// 重构前的 scan_file，原样抄一份（git HEAD 版本），只用来对账。
    fn scan_file_old(path: &Path, prices: &Prices, day: &str) -> Totals {
        let mut totals = Totals::default();
        let text = decode_session(path).unwrap_or_default();
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
            if kind == "assistant/message" && parsed.output >= 200 {
                let times: Vec<f64> = stream.iter().flat_map(|r|
                    ["time", "time0"].into_iter().filter_map(move |k| r.get(k).and_then(|v| v.as_f64()))
                ).filter(|v| v.is_finite()).collect();
                let min = times.iter().copied().reduce(f64::min);
                let max = times.iter().copied().reduce(f64::max);
                if let (Some(min), Some(max)) = (min, max) {
                    let dur = max - min;
                    if dur >= 500.0 && dur.is_finite() {
                        totals.samples.push(SpeedSample {
                            time: time_ms,
                            output: parsed.output as u64,
                            duration_ms: dur,
                        });
                    }
                }
            }
            if beijing_day(time_ms) != day {
                continue;
            }
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

    /// 用重构前的实现扫同一批文件，得到同样五项。
    /// 文件先按路径排序：`dedupe_sessions` 返回的是 HashMap 的随机顺序，
    /// 浮点累加顺序一变，最后几位就会不同，那样比不出「逻辑有没有变」。
    fn scan_at_roots_old(prices: &Prices, roots: &[PathBuf], now: i64) -> (Totals, Vec<(PathBuf, Totals)>) {
        let day = beijing_day(now);
        let since = day_start_ms(now).min(now - 3_600_000);
        let mut files = Vec::new();
        for root in roots {
            files.extend(session_files(root, since));
        }
        let mut files = dedupe_sessions(files);
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let mut totals = Totals::default();
        let mut per_file = Vec::new();
        for (path, _, _) in files {
            let value = scan_file_old(&path, prices, &day);
            totals.samples.extend(value.samples.clone());
            totals.expense += value.expense;
            totals.known += value.known;
            totals.unknown += value.unknown;
            per_file.push((path, value));
        }
        (totals, per_file)
    }

    #[test]
    #[ignore]
    fn print_baseline() {
        let prices = load_prices(None);
        let now = FIXED_NOW;
        let day = beijing_day(now);

        // 同一个文件、同一套排序，逐个文件比：这是最严格的等价证明。
        let (mut old, old_files) = scan_at_roots_old(&prices, &roots(), now);
        let mut new = Totals::default();
        let mut compared = 0usize;
        for (path, old_value) in &old_files {
            let new_value = scan_file(path, &prices, &day);
            assert_eq!(old_value.expense.to_bits(), new_value.expense.to_bits(), "{} 的花费不一致", path.display());
            assert_eq!(old_value.known, new_value.known, "{} 的已算笔数不一致", path.display());
            assert_eq!(old_value.unknown, new_value.unknown, "{} 的未算笔数不一致", path.display());
            assert_eq!(old_value.samples.len(), new_value.samples.len(), "{} 的速度样本数不一致", path.display());
            new.expense += new_value.expense;
            new.known += new_value.known;
            new.unknown += new_value.unknown;
            new.samples.extend(new_value.samples);
            compared += 1;
        }
        old.refresh_hour(now);
        new.refresh_hour(now);

        println!(
            "OLD files={} expense={:.10} known={} unknown={} hour_out={} hour_dur_ms={:.3}",
            compared, old.expense, old.known, old.unknown, old.hour_out, old.hour_dur_ms
        );
        println!(
            "NEW files={} expense={:.10} known={} unknown={} hour_out={} hour_dur_ms={:.3}",
            compared, new.expense, new.known, new.unknown, new.hour_out, new.hour_dur_ms
        );
        assert_eq!(old.expense.to_bits(), new.expense.to_bits(), "expense 不一致");
        assert_eq!(old.known, new.known, "known 不一致");
        assert_eq!(old.unknown, new.unknown, "unknown 不一致");
        assert_eq!(old.hour_out, new.hour_out, "hour_out 不一致");
        assert_eq!(old.hour_dur_ms.to_bits(), new.hour_dur_ms.to_bits(), "hour_dur_ms 不一致");
        println!("SAME=逐文件 + 五项完全一致（{} 个文件）", compared);
    }

    #[test]
    #[ignore]
    fn print_month() {
        let report = scan_month_roots(&mut MonthCache::default(), &roots(), FIXED_NOW);
        println!(
            "MONTH files={} with_events={} failed={} input={} output={} total={} cache_read={} cache_write={} events={}\nTODAY input={} output={} total={} cache_read={} events={}",
            report.files,
            report.files_with_events,
            report.failed,
            report.tokens.input,
            report.tokens.output,
            report.tokens.total(),
            report.tokens.cache_read,
            report.tokens.cache_write,
            report.tokens.events,
            report.today.input,
            report.today.output,
            report.today.total(),
            report.today.cache_read,
            report.today.events,
        );
    }

    /// 真实目录、真实耗时：首次全量扫和第二次命中缓存的差距。
    #[test]
    #[ignore]
    fn print_month_real_timing() {
        let Some(profile) = std::env::var("USERPROFILE").ok() else { return };
        let roots = [
            PathBuf::from(&profile).join(".ds-bot"),
            PathBuf::from(&profile).join(".dsh"),
        ];
        let mut cache = MonthCache::default();
        let start = std::time::Instant::now();
        let first = scan_month_roots(&mut cache, &roots, now_ms());
        let cold = start.elapsed();
        let start = std::time::Instant::now();
        let second = scan_month_roots(&mut cache, &roots, now_ms());
        let warm = start.elapsed();
        println!(
            "REAL cold={:?} warm={:?} files={} with_events={} failed={} input={} output={} total={} cache_read={} events={} today_total={}",
            cold, warm, first.files, first.files_with_events, first.failed,
            first.tokens.input, first.tokens.output, first.total,
            first.tokens.cache_read, first.tokens.events, first.today_total
        );
        assert_eq!(first.total, second.total, "第二次命中缓存时数字必须一样");
        assert_eq!(first.today_total, second.today_total);
    }
}

#[cfg(test)]
mod month_tests {
    use super::*;

    /// 北京时间某天某时某分的毫秒时间戳（UTC+8，无夏令时）。
    fn bj(y: i32, mo: u32, d: u32, h: i64, mi: i64) -> i64 {
        let days = days_from_civil(y, mo, d);
        (days * 86_400 + h * 3600 + mi * 60 - 8 * 3600) * 1000
    }

    /// 公历 → 1970-01-01 起的天数。
    fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
        let y = if m <= 2 { y - 1 } else { y } as i64;
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let m = m as i64;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    fn session_bytes(events: &[(i64, i64, i64)]) -> Vec<u8> {
        let mut lines = vec![serde_json::json!({
            "type": "request/header",
            "data": {"header": {"config": {"model": "deepseek-flash"}}}
        })
        .to_string()];
        for (time, input, output) in events {
            lines.push(
                serde_json::json!({
                    "type": "assistant/message",
                    "time": time,
                    "data": {"stream": [
                        {"time0": 100, "time": "ignore"},
                        {"type": "chunk", "time": 1100, "chunk": {"type": "usage", "usage": {
                            "inputTokens": input, "outputTokens": output,
                            "cacheReadTokens": 7, "cacheWriteTokens": 0
                        }}}
                    ]}
                })
                .to_string(),
            );
        }
        zstd::stream::encode_all(lines.join("\n").as_bytes(), 0).unwrap()
    }

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("salary-month-{}-{}", tag, std::process::id()))
    }

    fn put(root: &Path, session: &str, bytes: &[u8]) -> PathBuf {
        let dir = root.join("sessions").join("group").join(session);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("session.v4.jsonl.zstd");
        fs::write(&file, bytes).unwrap();
        file
    }

    #[test]
    fn month_window_is_beijing_midnight_and_excludes_last_month() {
        assert_eq!(beijing_month(bj(2026, 11, 21, 11, 20)), "2026-11");
        assert_eq!(month_start_ms(bj(2026, 11, 21, 11, 20)), bj(2026, 11, 1, 0, 0));
        assert_eq!(month_start_ms(bj(2026, 11, 1, 0, 0)), bj(2026, 11, 1, 0, 0));
        assert_eq!(month_start_ms(bj(2026, 11, 30, 23, 59)), bj(2026, 11, 1, 0, 0));
        // 12 月要跨月，不能还停在 11 月
        assert_eq!(month_start_ms(bj(2026, 12, 1, 0, 0)), bj(2026, 12, 1, 0, 0));
        assert_eq!(beijing_month(bj(2026, 12, 1, 0, 0)), "2026-12");
    }

    /// 月末那天算下个月初，必须正好落在这个月的下一天 00:00，
    /// 不能把「今天 + 32 天」当成下个月——11-30 那天会跑到次年 1-1 去。
    #[test]
    fn next_month_start_is_exact_on_every_month_end() {
        let cases = [
            ((2026, 1, 31), (2026, 2, 1)),
            ((2026, 2, 28), (2026, 3, 1)),
            ((2026, 4, 30), (2026, 5, 1)),
            ((2026, 5, 31), (2026, 6, 1)),
            ((2026, 7, 31), (2026, 8, 1)),
            ((2026, 8, 31), (2026, 9, 1)),
            ((2026, 10, 31), (2026, 11, 1)),
            ((2026, 11, 30), (2026, 12, 1)),
            ((2026, 12, 31), (2027, 1, 1)),
            ((2028, 2, 29), (2028, 3, 1)), // 闰年
            ((2026, 11, 1), (2026, 12, 1)),
            ((2026, 11, 15), (2026, 12, 1)),
        ];
        for ((y, mo, d), (ey, emo, ed)) in cases {
            let now = bj(y, mo, d, 12, 0);
            assert_eq!(
                next_month_start_ms(now),
                bj(ey, emo, ed, 0, 0),
                "{y}-{mo}-{d} 的下个月初算错了"
            );
        }
    }

    /// 月末那天扫本月，绝不能把下个月的事件算进来。
    #[test]
    fn month_end_scan_does_not_leak_next_month() {
        for (y, mo, d, ny, nmo, nd) in [
            (2026, 11, 30, 2026, 12, 1),
            (2026, 12, 31, 2027, 1, 1),
            (2026, 2, 28, 2026, 3, 1),
            (2026, 4, 30, 2026, 5, 1),
        ] {
            let root = temp_root(&format!("leak-{y}{mo}{d}"));
            let _ = fs::remove_dir_all(&root);
            put(
                &root,
                "session-leak",
                &session_bytes(&[
                    (bj(y, mo, d, 23, 0), 10, 1),      // 本月，算
                    (bj(ny, nmo, nd, 0, 0), 900, 900), // 下月第一毫秒，不算
                    (bj(ny, nmo, nd, 12, 0), 500, 500), // 下月中旬，不算
                ]),
            );
            let report =
                scan_month_roots(&mut MonthCache::default(), &[root.clone()], bj(y, mo, d, 23, 30));
            assert_eq!(
                (report.tokens.input, report.tokens.output),
                (10, 1),
                "{y}-{mo}-{d} 扫描漏进了下个月的用量"
            );
            fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn month_window_scan_is_bounded_at_month_edges() {
        let root = temp_root("window");
        let _ = fs::remove_dir_all(&root);
        put(
            &root,
            "session-w",
            &session_bytes(&[
                (bj(2026, 10, 31, 23, 59), 1_000_000, 1_000_000), // 上月最后一分钟，不算
                (bj(2026, 10, 31, 23, 59) + 59_999, 1_000_000, 1_000_000), // 还是上月
                (bj(2026, 11, 1, 0, 0), 100, 10),                 // 本月第一毫秒，算
                (bj(2026, 11, 21, 11, 20), 200, 20),
            ]),
        );
        let report = scan_month_roots(&mut MonthCache::default(), &[root.clone()], bj(2026, 11, 21, 11, 20));
        assert_eq!(report.tokens.input, 300);
        assert_eq!(report.tokens.output, 30);
        assert_eq!(report.tokens.events, 2);
        assert_eq!(report.files_with_events, 1);
        fs::remove_dir_all(&root).ok();
    }

    /// 「今天」那一格：只数北京时间今天 0 点到现在，昨天和上月都不许漏进来。
    #[test]
    fn today_window_is_beijing_midnight_to_now() {
        let root = temp_root("today-window");
        let _ = fs::remove_dir_all(&root);
        put(
            &root,
            "session-today",
            &session_bytes(&[
                (bj(2026, 11, 20, 23, 59), 700, 70), // 昨天最后一分钟，不算今天
                (bj(2026, 10, 31, 23, 59), 800, 80), // 上月，也不算
                (bj(2026, 11, 21, 0, 0), 100, 10),   // 今天第一毫秒，算
                (bj(2026, 11, 21, 11, 20), 200, 20),
            ]),
        );
        let now = bj(2026, 11, 21, 11, 20);
        let report = scan_month_roots(&mut MonthCache::default(), &[root.clone()], now);
        assert_eq!(
            (report.today.input, report.today.output, report.today.events),
            (300, 30, 2),
            "今天的窗口应从北京时间 0 点起"
        );
        assert_eq!(report.today_start_ms, bj(2026, 11, 21, 0, 0));
        assert_eq!(report.today_total, 330);
        // 本月还得是对的：今天这两笔 + 昨天那笔，不含上月
        assert_eq!((report.tokens.input, report.tokens.output), (1000, 100));
        fs::remove_dir_all(&root).ok();
    }

    /// 今天的上界是「明天 0 点」，不是「下月 1 号」：
    /// 日志里出现明天、后天的记录（时钟回拨、日志写在前）不能提前算进今天。
    #[test]
    fn today_window_stops_at_tomorrow_midnight() {
        let root = temp_root("today-upper");
        let _ = fs::remove_dir_all(&root);
        put(
            &root,
            "session-future",
            &session_bytes(&[
                (bj(2026, 11, 21, 23, 59), 100, 10), // 今天最后一分钟，算
                (bj(2026, 11, 22, 0, 0), 500, 50),   // 明天第一毫秒，不算今天
                (bj(2026, 11, 25, 12, 0), 700, 70),  // 后几天，也不算今天
            ]),
        );
        let now = bj(2026, 11, 21, 11, 20);
        let report = scan_month_roots(&mut MonthCache::default(), &[root.clone()], now);
        assert_eq!(
            (report.today.input, report.today.output),
            (100, 10),
            "明天及以后的记录不该算进今天"
        );
        // 本月还是要全收（它们都在 11 月里）
        assert_eq!(report.tokens.input, 1300);
        fs::remove_dir_all(&root).ok();
    }

    /// 跨天之后缓存要跟着清，不能把昨天的 today 当成今天发出去。
    #[test]
    fn today_counter_resets_when_the_day_changes() {
        let now = bj(2026, 11, 21, 23, 50);
        let root = temp_root("today-reset");
        let _ = fs::remove_dir_all(&root);
        put(&root, "session-d", &session_bytes(&[(now - 60_000, 500, 50)]));
        let mut cache = MonthCache::default();
        let first = scan_month_roots(&mut cache, &[root.clone()], now);
        assert_eq!(first.today.input, 500);
        // 同一份文件，第二天再看：本月还认那 500，今天必须是 0
        let next = scan_month_roots(&mut cache, &[root.clone()], bj(2026, 11, 22, 9, 0));
        assert_eq!(next.today.input, 0, "昨天的用量不该算成今天");
        assert_eq!(next.tokens.input, 500, "本月不该被跨天影响");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn first_minute_of_month_and_next_month_are_exclusive() {
        let root = temp_root("edges");
        let _ = fs::remove_dir_all(&root);
        // 12 月的事件在 11 月的扫描里必须被排除（until 边界）
        put(
            &root,
            "session-e",
            &session_bytes(&[
                (bj(2026, 11, 30, 23, 59), 5, 5),
                (bj(2026, 12, 1, 0, 0), 900, 900),
            ]),
        );
        let nov = scan_month_roots(&mut MonthCache::default(), &[root.clone()], bj(2026, 11, 21, 11, 20));
        assert_eq!((nov.tokens.input, nov.tokens.output), (5, 5));
        let dec = scan_month_roots(&mut MonthCache::default(), &[root.clone()], bj(2026, 12, 15, 9, 0));
        assert_eq!((dec.tokens.input, dec.tokens.output), (900, 900));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn same_session_in_two_roots_counts_once() {
        let now = bj(2026, 11, 21, 11, 20);
        let root_a = temp_root("dup-a");
        let root_b = temp_root("dup-b");
        let _ = fs::remove_dir_all(&root_a);
        let _ = fs::remove_dir_all(&root_b);
        let bytes = session_bytes(&[(now - 60_000, 400, 40)]);
        put(&root_a, "session-shared", &bytes);
        // 两份内容一样，但 b 那份要更新一些，去重应留 b
        let path_b = put(&root_b, "session-shared", &bytes);
        let later = fs::metadata(&path_b).unwrap();
        fs::File::options()
            .write(true)
            .open(&path_b)
            .unwrap()
            .set_modified(later.modified().unwrap() + std::time::Duration::from_secs(5))
            .unwrap();
        put(&root_b, "session-only-b", &session_bytes(&[(now - 30_000, 600, 60)]));

        let report = scan_month_roots(&mut MonthCache::default(), &[root_a.clone(), root_b.clone()], now);
        assert_eq!(report.files, 2, "共享会话只应算一次");
        assert_eq!(report.tokens.input, 1_000);
        assert_eq!(report.tokens.events, 2);
        fs::remove_dir_all(&root_a).ok();
        fs::remove_dir_all(&root_b).ok();
    }

    #[test]
    fn broken_file_is_skipped_and_counted() {
        let now = bj(2026, 11, 21, 11, 20);
        let root = temp_root("broken");
        let _ = fs::remove_dir_all(&root);
        put(&root, "session-good", &session_bytes(&[(now - 60_000, 250, 25)]));
        put(&root, "session-bad", b"this is not zstd at all");

        let report = scan_month_roots(&mut MonthCache::default(), &[root.clone()], now);
        // 坏文件跳过，但数字不能变 0，失败数要报出来
        assert_eq!(report.tokens.input, 250);
        assert_eq!(report.tokens.events, 1);
        assert_eq!(report.failed, 1, "坏文件数没报出来");
        assert_eq!(report.files, 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mnemon_sessions_are_not_counted() {
        let now = bj(2026, 11, 21, 11, 20);
        let root = temp_root("mnemon");
        let _ = fs::remove_dir_all(&root);
        put(&root, "session-real", &session_bytes(&[(now - 60_000, 100, 10)]));
        put(&root, "mnemon-run-abc", &session_bytes(&[(now - 60_000, 9_999, 9_999)]));
        let report = scan_month_roots(&mut MonthCache::default(), &[root.clone()], now);
        assert_eq!(report.files, 1);
        assert_eq!(report.tokens.input, 100, "mnemon 那批不该算进来");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cache_reuses_unchanged_files_and_resets_next_month() {
        let now = bj(2026, 11, 21, 11, 20);
        let root = temp_root("cache");
        let _ = fs::remove_dir_all(&root);
        put(&root, "session-c", &session_bytes(&[(now - 60_000, 100, 10)]));
        let mut cache = MonthCache::default();
        let first = scan_month_roots(&mut cache, &[root.clone()], now);
        assert_eq!(first.tokens.input, 100);
        assert_eq!(first.today.input, 100, "今天也该数到这一笔");
        assert_eq!(cache.entries.len(), 1);

        // 文件没变：第二次直接复用，结果一样
        let second = scan_month_roots(&mut cache, &[root.clone()], now + 60_000);
        assert_eq!(second.tokens.input, 100);
        assert_eq!(second.today.input, 100);

        // 跨月：缓存自动清空，11 月的事件不再计入 12 月
        let third = scan_month_roots(&mut cache, &[root.clone()], bj(2026, 12, 2, 9, 0));
        assert_eq!(cache.month, "2026-12");
        assert_eq!(third.tokens.input, 0);
        assert_eq!(third.today.input, 0, "换了月份，旧事件不能算成今天");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn negative_usage_is_skipped_not_subtracted() {
        let mut totals = MonthTotals::default();
        totals.add(Usage { input: 100, output: 10, cache_read: 5, cache_write: 0 });
        totals.add(Usage { input: -50, output: -5, cache_read: 0, cache_write: 0 });
        assert_eq!(totals.input, 100);
        assert_eq!(totals.output, 10);
        assert_eq!(totals.events, 1);
        assert_eq!(totals.total(), 110);
    }
}

#[cfg(test)]
mod merge_tests {
    use super::dedupe_sessions;
    use std::fs;
    use std::path::PathBuf;

    fn file(root: &str, session: &str, modified: u64, len: u64) -> (PathBuf, u64, u64) {
        (
            PathBuf::from(root)
                .join("sessions")
                .join("group")
                .join(session)
                .join("session.v4.jsonl.zstd"),
            modified,
            len,
        )
    }

    #[test]
    fn copied_session_keeps_only_the_newer_copy() {
        let old = file("old-bot", "session-1", 100, 500);
        let new = file("dsh", "session-1", 200, 900);
        let kept = dedupe_sessions(vec![old, new.clone()]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].0, new.0);
        assert_eq!(kept[0].1, 200);
    }

    #[test]
    fn different_sessions_are_all_kept() {
        let kept = dedupe_sessions(vec![
            file("dsh", "session-a", 100, 500),
            file("dsh", "session-b", 100, 600),
            file("old-bot", "session-c", 100, 700),
        ]);
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn same_time_keeps_the_longer_copy() {
        let short = file("old-bot", "session-1", 100, 500);
        let long = file("dsh", "session-1", 100, 800);
        let kept = dedupe_sessions(vec![short, long.clone()]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].2, 800);
    }

    fn session_bytes(now: i64, outputs: &[u64]) -> Vec<u8> {
        let mut lines: Vec<String> = vec![serde_json::json!({
            "type": "request/header",
            "data": {"header": {"config": {"model": "deepseek-flash"}}}
        })
        .to_string()];
        for (index, output) in outputs.iter().enumerate() {
            lines.push(
                serde_json::json!({
                    "type": "assistant/message",
                    "time": now - 5000 + index as i64,
                    "data": {"stream": [
                        {"time0": 100, "time": "ignore"},
                        {"type": "chunk", "time": 1100, "chunk": {"type": "usage", "usage": {"outputTokens": output}}}
                    ]}
                })
                .to_string(),
            );
        }
        zstd::stream::encode_all(lines.join("\n").as_bytes(), 0).unwrap()
    }

    #[test]
    fn shared_session_in_two_roots_is_counted_once() {
        let now = super::now_ms();
        let root_a = std::env::temp_dir().join(format!("salary-merge-a-{}", std::process::id()));
        let root_b = std::env::temp_dir().join(format!("salary-merge-b-{}", std::process::id()));
        let shared_a = root_a.join("sessions").join("group").join("session-shared");
        let shared_b = root_b.join("sessions").join("group").join("session-shared");
        let only_b = root_b.join("sessions").join("group").join("session-only-b");
        for dir in [&shared_a, &shared_b, &only_b] {
            fs::create_dir_all(dir).unwrap();
        }
        let shared = session_bytes(now, &[1000, 2000]);
        fs::write(shared_a.join("session.v4.jsonl.zstd"), &shared).unwrap();
        fs::write(shared_b.join("session.v4.jsonl.zstd"), &shared).unwrap();
        fs::write(only_b.join("session.v4.jsonl.zstd"), session_bytes(now, &[500])).unwrap();

        let prices = super::load_prices(None);
        let a = super::scan_at_roots(&prices, &mut super::ScanCache::default(), &[root_a.clone()], now);
        let b = super::scan_at_roots(&prices, &mut super::ScanCache::default(), &[root_b.clone()], now);
        let both = super::scan_at_roots(
            &prices,
            &mut super::ScanCache::default(),
            &[root_a.clone(), root_b.clone()],
            now,
        );

        // A 里的会话在 B 里有一份一模一样的，合起来应该等于只扫 B（2 个会话），而不是 3 个。
        assert_eq!(both.sessions, 2);
        assert_eq!(both.today.known, b.today.known);
        assert!((both.today.expense - b.today.expense).abs() < 1e-9);
        // 而且共享那份确实算进了钱（不是被丢掉）。
        assert!(a.today.expense > 0.0);
        assert!(b.today.expense > a.today.expense);

        fs::remove_dir_all(&root_a).ok();
        fs::remove_dir_all(&root_b).ok();
    }
}
