/* README 设置页截图专用假接口：数字固定，只为展示四格。
   跟 month-preload.cjs 分开，免得改坏功能检查用的那份。 */
const path = require('path');

/* 截图这天的日期也钉死：真实系统日期要是落在周末，「今天已赚」会是 ¥0.00，
   截出来像坏了。钉到 2026-11-20（周五）15:00，正好是上班中间。 */
const FAKE_NOW = new Date(2026, 10, 20, 15, 0, 0).getTime();
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FAKE_NOW);
    else super(...args);
  }
  static now() { return FAKE_NOW; }
};

const MONTH = {
  month_start_ms: 1793462400000,
  // 跟下面 FAKE_NOW（2026-11-20 15:00）同一天：不然前端按日期一核对，
  // 会把这格当成「昨天的数」清成「—」。
  today_start_ms: 1795104000000, // 2026-11-20 00:00 北京时间
  total: 144041652,
  tokens: { input: 130886293, output: 13155359, cache_read: 5545466751, cache_write: 0, events: 18662 },
  today: { input: 6391088, output: 699302, cache_read: 201334211, cache_write: 0, events: 611 },
  today_total: 7090390,
  files: 101,
  files_with_events: 83,
  failed: 0,
};

window.api = {
  getConfig: async () => ({
    salary: 5000, days: 22, start: '09:00', end: '18:00', lunch: 1,
    restMode: 'double', theme: 'light', animation: true, petScale: 130,
    sessionDirs: ['C:\\Users\\Lenovo\\.ds-bot'],
  }),
  setConfig: async () => ({}),
  getState: async () => ({
    today: { expense: 12.13, known: 880, unknown: 0 },
    prices: { source: '内置', count: 12 },
    sessions: 13, tps: 42.6, last_write: Date.now() - 120000,
    dirs: ['C:\\Users\\Lenovo\\.ds-bot'],
  }),
  recompute: async () => ({ today: {}, prices: {}, sessions: 0, dirs: [] }),
  getMonthTokens: async () => ({ report: MONTH, stale: false, updated: Date.now() }),
  pickDir: async () => null,
};
