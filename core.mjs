export const DEFAULT_CONFIG = Object.freeze({
  salary: 5000,
  days: 22,
  start: '09:00',
  end: '18:00',
  lunch: 1,
  weekend: false,
});

function secondsAt(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 3600 + minute * 60;
}

export function validateConfig(input) {
  const config = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, input[key] ?? DEFAULT_CONFIG[key]]));
  for (const key of ['salary', 'days', 'lunch']) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key])) throw new Error('工资参数需要填写有效数字');
  }
  if (config.salary < 0 || config.salary > 1e9 || config.days < 1 || config.days > 31 || config.lunch < 0) {
    throw new Error('请检查月薪、每月工作日和午休时长');
  }
  for (const key of ['start', 'end']) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config[key])) throw new Error('上下班时间格式需要为 HH:mm');
  }
  if (typeof config.weekend !== 'boolean') throw new Error('周末上班选项需要为布尔值');
  const span = secondsAt(config.end) - secondsAt(config.start);
  if (span <= 0) throw new Error('下班时间需要晚于上班时间，本版按同一天的班次计算');
  if (config.lunch * 3600 >= span) throw new Error('午休时长需要小于在岗时长');
  return config;
}

export function computeWage(config, now = new Date()) {
  const start = secondsAt(config.start);
  const end = secondsAt(config.end);
  const lunch = config.lunch * 3600;
  const workSeconds = end - start - lunch;
  const lunchStart = Math.max(start, Math.min(12 * 3600, end - lunch));
  const clock = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
  const rest = !config.weekend && (now.getDay() === 0 || now.getDay() === 6);
  const elapsed = Math.max(0, Math.min(clock, end) - start);
  const lunchElapsed = Math.max(0, Math.min(lunch, clock - lunchStart));
  const billable = rest ? 0 : Math.max(0, Math.min(workSeconds, elapsed - lunchElapsed));
  const perSecond = config.salary / config.days / workSeconds;
  let status = '上班中';
  let countdownLabel = '距下班';
  let countdownSeconds = Math.max(0, end - clock);
  if (rest) {
    status = '休息日';
    countdownLabel = '今天休息';
    countdownSeconds = 0;
  } else if (clock < start) {
    status = '未开工';
    countdownLabel = '距开工';
    countdownSeconds = start - clock;
  } else if (clock >= end) {
    status = '已下班';
    countdownLabel = '今日已收工';
    countdownSeconds = 0;
  } else if (lunch > 0 && clock >= lunchStart && clock < lunchStart + lunch) {
    status = '午休中';
  }
  return { earned: billable * perSecond, perSecond, progress: billable / workSeconds, status, countdownLabel, countdownSeconds };
}

export function formatDuration(seconds) {
  const value = Math.max(0, Math.ceil(seconds));
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(value => String(value).padStart(2, '0')).join(':');
}

export function chinaDay(time) {
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
}

// CNY per million tokens, verified against the official pricing page on 2026-11-03.
// Weekday peak periods are estimated from the clock. Public-holiday adjustments,
// search/fetch charges, auxiliary model calls, and third-party tariffs are excluded.
// Priced by model, not by route: the same model through the official account or a
// gateway (for example opencode-go) is folded in at the same official rate.
// CNY per million tokens. USD vendors converted at 7.15. Checked 2026-11-06.
// Only DeepSeek has the peak/off-peak 0.5x discount; everything else is billed flat.
const USD = 7.15; // 美元价 × 汇率
const DEFAULT_PRICES = {
  // DeepSeek（人民币）
  'deepseek-flash': [2, 0.04, 8],
  'deepseek-v4-flash': [2, 0.04, 8],
  'deepseek-v4.1-flash': [2, 0.04, 8],
  'deepseek-v4-flash-vision-exp': [2, 0.04, 8],
  'deepseek-v4-pro': [9, 0.3, 27],
  // 智谱 GLM（人民币）
  'glm-5.3': [8, 2, 28],
  'glm-5.3-flash': [0.8, 0.23, 2.8],
  'glm-5.3-flashx': [2, 0.57, 7],
  // 阶跃 Step（人民币）
  'step-5-preview': [7, 0.7, 20],
  // Kimi（人民币）
  'kimi-k3': [20, 2, 100],
  // 通义 Qwen（人民币）
  'qwen3.8-max': [12, 1.2, 36],
  'qwen3.7-max': [12, 1.2, 36],
  'qwen3.8-flash': [0.8, 0.08, 2.7],
  'qwen3.7-flash': [0.2, 0.02, 0.8],
  // MiniMax（人民币）
  'minimax-m3': [2.1, 0.42, 8.4],
  'minimax-m3.1-flash': [1, 0.1, 4],
  // OpenAI（美元 → 人民币）
  'gpt-5.1': [1.25 * USD, 0.125 * USD, 10 * USD],
  'gpt-5': [1.25 * USD, 0.125 * USD, 10 * USD],
  'gpt-5-mini': [0.25 * USD, 0.025 * USD, 2 * USD],
  'gpt-5-nano': [0.05 * USD, 0.005 * USD, 0.4 * USD],
  'gpt-5.2': [1.75 * USD, 0.175 * USD, 14 * USD],
  'gpt-5.4': [2.5 * USD, 0.25 * USD, 15 * USD],
  'gpt-4.1': [2 * USD, 0.5 * USD, 8 * USD],
  'gpt-4o': [2.5 * USD, 1.25 * USD, 10 * USD],
  'o3': [2 * USD, 0.5 * USD, 8 * USD],
  // Anthropic Claude（美元 → 人民币）
  'claude-opus-5.5': [4 * USD, 0.2 * USD, 20 * USD],
  'claude-opus-5': [5 * USD, 0.5 * USD, 25 * USD],
  'claude-sonnet-5.5': [2 * USD, 0.1 * USD, 10 * USD],
  'claude-sonnet-5': [2 * USD, 0.2 * USD, 10 * USD],
  'claude-sonnet-4.5': [3 * USD, 0.3 * USD, 15 * USD],
  'claude-haiku-4.5': [1 * USD, 0.1 * USD, 5 * USD],
  // Google Gemini（美元 → 人民币）
  'gemini-3.1-pro-preview': [2 * USD, 0.2 * USD, 12 * USD],
  // xAI Grok（美元 → 人民币）
  'grok-4.7': [2 * USD, 0.5 * USD, 6 * USD],
  'grok-4.6': [2 * USD, 0.5 * USD, 6 * USD],
  'grok-4.5': [2 * USD, 0.3 * USD, 6 * USD],
  'grok-4.3': [1.25 * USD, 0.2 * USD, 2.5 * USD],
};

let PRICES = { ...DEFAULT_PRICES };

export function defaultPrices() {
  return { ...DEFAULT_PRICES };
}

export function setPrices(table) {
  const next = { ...DEFAULT_PRICES };
  for (const [model, price] of Object.entries(table ?? {})) {
    if (Array.isArray(price) && price.length === 3 && price.every(value => Number.isFinite(value) && value >= 0)) {
      next[String(model).toLowerCase()] = price.slice(0, 3);
    }
  }
  PRICES = next;
}

// 模型名带日期/版本后缀时也能匹配，例如 gpt-5.1-2026-08-07 → gpt-5.1
function priceOf(model) {
  if (!model) return null;
  const key = String(model).toLowerCase();
  if (PRICES[key]) return PRICES[key];
  const base = key.replace(/-(20\d{2}[-.]\d{2}[-.]\d{2})(?:-.*)?$/, '');
  return PRICES[base] ?? null;
}

export function estimateExpense(usage, route, time) {
  const model = route?.model;
  if (!model) return 0;
  const price = priceOf(model);
  if (!price) return String(model).startsWith('deepseek') ? null : 0;
  const tokens = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => usage[key] ?? 0);
  if (tokens.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  const [input, output, cached, written] = tokens;
  const beijing = new Date(time + 8 * 3600_000);
  const weekday = beijing.getUTCDay();
  const hour = beijing.getUTCHours() + beijing.getUTCMinutes() / 60;
  const peak = weekday > 0 && weekday < 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  const discount = model.startsWith('deepseek') ? (peak ? 1 : 0.5) : 1;
  return ((input + written) * price[0] + cached * price[1] + output * price[2]) / 1e6 * discount;
}

export function usageFromEvent(event) {
  if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return null;
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return null;
  const record = stream.findLast(record => record.type === 'chunk' && record.chunk?.type === 'usage');
  return record?.chunk.usage ?? null;
}

export function recordExpense(ledger, sessionId, event, route) {
  const usage = usageFromEvent(event);
  if (!usage || event.seq <= (ledger.positions[sessionId]?.seq ?? -1)) return false;
  const today = chinaDay(Date.now());
  const day = chinaDay(event.time);
  if (day < today || day > today) return false;
  const expense = estimateExpense(usage, route, event.time);
  const totals = ledger.days[day] ??= { expense: 0, known: 0, unknown: 0 };
  if (expense === null) totals.unknown += 1;
  else {
    totals.expense += expense;
    totals.known += 1;
    ledger.lastExpenseAt = event.time;
  }
  ledger.positions[sessionId] = { seq: event.seq, day };
  // Positions are retained for today's sessions, so replay cannot charge twice.
  for (const [key, value] of Object.entries(ledger.positions)) if (value.day < today) delete ledger.positions[key];
  for (const key of Object.keys(ledger.days)) if (key < today) delete ledger.days[key];
  return true;
}
