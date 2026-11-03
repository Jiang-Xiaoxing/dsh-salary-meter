export const DEFAULT_CONFIG = Object.freeze({
  salary: 10000,
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
const PRICES = {
  'deepseek-flash': [2, 0.04, 8],
  'deepseek-v4-flash': [2, 0.04, 8],
  'deepseek-v4-flash-vision-exp': [2, 0.04, 8],
  'deepseek-v4-pro': [9, 0.3, 27],
};

export function estimateExpense(usage, route, time) {
  if (!['deepseek-official', 'deepseek-account'].includes(route?.provider)) return null;
  const price = PRICES[route.model];
  if (!price) return null;
  const tokens = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => usage[key] ?? 0);
  if (tokens.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  const [input, output, cached, written] = tokens;
  const beijing = new Date(time + 8 * 3600_000);
  const weekday = beijing.getUTCDay();
  const hour = beijing.getUTCHours() + beijing.getUTCMinutes() / 60;
  const peak = weekday > 0 && weekday < 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  return ((input + written) * price[0] + cached * price[1] + output * price[2]) / 1e6 * (peak ? 1 : 0.5);
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
