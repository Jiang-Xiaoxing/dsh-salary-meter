/* 本月 token 的假接口层。
   fixture 文件决定返回什么；另外把 60 秒的刷新定时器压缩成 300 毫秒，
   这样检查脚本能在一秒内测「第二次刷新失败时保留旧值」，
   不用等一分钟，也就不用给页面开测试钩子。 */
const fs = require('fs');
const path = require('path');
const FIXTURE = path.join(__dirname, 'month-fixture.json');

function read() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

// 只压缩那条 60 秒的月刷新；5 秒的常规刷新保持原样（它拉的是假数据，不费事）
const rawSetInterval = window.setInterval.bind(window);
window.setInterval = function (fn, ms) {
  if (ms >= 60000) return rawSetInterval(fn, 300);
  return rawSetInterval(fn, ms);
};

window.__monthCalls = 0;

window.api = {
  getConfig: async () => ({
    // restMode 用 none：这组检查跑在任何一天都要有「今天已赚」，
    // 用双休的话周末跑就是 ¥0.00，看不出金额有没有跟着时间走。
    salary: 5000, days: 22, start: '09:00', end: '18:00', lunch: 1,
    restMode: 'none', theme: 'dark', animation: true, petScale: 130,
  }),
  setConfig: async () => ({}),
  getState: async () => ({ today: {}, prices: {}, sessions: 0, tps: null, last_write: 0, dirs: [] }),
  recompute: async () => ({ today: {}, prices: {}, sessions: 0, dirs: [] }),
  // 真接口的形状是 {report: {...}|null, stale, updated}：
  // report 为 null 表示后台正忙/跨月/换了目录，没有可用的本月数。
  getMonthTokens: function () {
    window.__monthCalls += 1;
    const raw = read();
    if (raw.mode === 'error') return Promise.reject(new Error('test'));
    if (raw.mode === 'empty') return Promise.resolve({ report: null, stale: true, updated: Date.now() });
    // legacy：模拟老后端（没有 today 字段），前端那格必须守「—」
    if (raw.mode === 'legacy') {
      const v = Object.assign({}, raw.value);
      delete v.today; delete v.today_total; delete v.today_start_ms;
      return Promise.resolve({ report: v, stale: false, updated: Date.now() });
    }
    const wrap = v => ({ report: v === undefined ? null : v, stale: false, updated: Date.now() });
    if (raw.mode === 'slow') {
      return new Promise(resolve => setTimeout(() => resolve(wrap(raw.value)), 1200));
    }
    return Promise.resolve(wrap(raw.value));
  },
  pickDir: async () => null,
};
