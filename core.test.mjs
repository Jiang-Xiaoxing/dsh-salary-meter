import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, computeWage, validateConfig, formatDuration, estimateExpense, usageFromEvent, chinaDay, recordExpense } from './core.mjs';
process.env.TZ = 'Asia/Shanghai';

const at = text => new Date(`2026-11-03T${text}+08:00`);
test('工资按时间平滑累计，保持下班倒计时', () => {
  assert.equal(DEFAULT_CONFIG.salary, 5000);
  const first = computeWage(DEFAULT_CONFIG, at('15:30:00'));
  const next = computeWage(DEFAULT_CONFIG, at('15:30:01'));
  assert.equal(first.earned, 156.25);
  assert.ok(Math.abs(next.earned - first.earned - first.perSecond) < 1e-9);
  assert.equal(formatDuration(first.countdownSeconds), '02:30:00');
  assert.equal(first.progress, 0.6875);
});
test('午休停止工资累计，倒计时继续', () => {
  const first = computeWage(DEFAULT_CONFIG, at('12:00:00'));
  const next = computeWage(DEFAULT_CONFIG, at('12:59:59'));
  assert.equal(first.status, '午休中');
  assert.equal(first.earned, next.earned);
  assert.ok(next.countdownSeconds < first.countdownSeconds);
});
test('下班后封顶，次日开工前和休息日从零开始', () => {
  assert.equal(computeWage(DEFAULT_CONFIG, at('19:00:00')).earned, DEFAULT_CONFIG.salary / DEFAULT_CONFIG.days);
  assert.equal(computeWage(DEFAULT_CONFIG, new Date('2026-11-04T08:00:00+08:00')).earned, 0);
  assert.equal(computeWage(DEFAULT_CONFIG, new Date('2026-11-08T16:00:00+08:00')).earned, 0);
});
test('非法工时和参数在保存前拒绝', () => {
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, lunch: 10 }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, end: '08:00' }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, start: '25:00' }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, salary: NaN }));
});
test('费用读取最后一条 usage，保留失败尝试的计量', () => {
  const event = { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 20 } } }] } };
  assert.deepEqual(usageFromEvent(event), { inputTokens: 20 });
  assert.equal(usageFromEvent({ type: 'user/message' }), null);
});
test('费用区分缓存和空闲时段，未知路由保持未知', () => {
  const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 };
  const route = { provider: 'deepseek-official', model: 'deepseek-flash' };
  assert.equal(estimateExpense(usage, route, at('15:30:00').getTime()), 10.04);
  assert.equal(estimateExpense(usage, route, at('20:30:00').getTime()), 5.02);
  assert.equal(estimateExpense(usage, { ...route, provider: 'other' }, Date.now()), null);
  assert.equal(chinaDay(at('00:00:00').getTime()), '2026-11-03');
});
test('刷新与重新加载同一记录不重复计费，未知路由单独计数', () => {
  const ledger = { days: {}, positions: {}, lastExpenseAt: 0 };
  const event = { seq: 18, time: Date.now(), type: 'assistant/message', data: { stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1000 } } }] } };
  const route = { provider: 'deepseek-official', model: 'deepseek-flash' };
  assert.equal(recordExpense(ledger, 'session-1', event, route), true);
  const persisted = JSON.parse(JSON.stringify(ledger));
  assert.equal(recordExpense(persisted, 'session-1', event, route), false);
  assert.equal(persisted.days[chinaDay(event.time)].known, 1);
  recordExpense(persisted, 'session-2', event, { provider: 'unknown' });
  assert.equal(persisted.days[chinaDay(event.time)].unknown, 1);
});
