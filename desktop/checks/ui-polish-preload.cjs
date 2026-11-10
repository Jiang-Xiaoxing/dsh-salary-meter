// UI polish checks 的隔离 API + Tauri 适配层假实现。
// 不读真实配置、不写用户 APPDATA；所有状态都只在当前测试进程里。
const FIXED_MS = new Date('2026-11-09T10:00:00+08:00').getTime();
const clockBase = performance.now();
const RealDate = Date;
const fakeNow = () => FIXED_MS + (performance.now() - clockBase);
class FakeDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fakeNow()])); }
  static now() { return fakeNow(); }
}
window.Date = FakeDate;

let config = {
  salary: 5000, days: 22, start: '09:00', end: '18:00', lunch: 1,
  weekend: false, restMode: 'double', theme: 'light', character: 'webm',
  animation: true, petScale: 130, expanded: false,
};
let today = { expense: 5, known: 2, unknown: 0 };
let tps = 42.6;
let mode = 'widget';
let failState = false;
const listeners = Object.create(null);
const calls = [];
const logs = [];

function emitConfig() {
  for (const cb of listeners['config-changed'] || []) cb({ payload: { ...config } });
}

async function invoke(name, args = {}) {
  calls.push({ name, args });
  switch (name) {
    case 'get_config':
      return { ...config };
    case 'set_config':
      config = { ...config, ...(args.patch || {}) };
      emitConfig();
      return { ...config };
    case 'set_expanded':
      config.expanded = !!args.expanded;
      emitConfig();
      return { ...config };
    case 'get_state':
      if (failState) throw new Error('simulated read failure');
      return {
        config: { ...config },
        today: { ...today },
        prices: { source: '缓存', count: 36 },
        sessions: 7,
        tps,
        last_write: Date.now() - 1000,
        dsh_busy: null,
      };
    case 'recompute_today':
      return {
        config: { ...config },
        today: { ...today },
        prices: { source: '缓存', count: 36 },
        sessions: 7,
        tps,
      };
    case 'set_mode':
      mode = args.mode;
      return true;
    case 'open_settings':
      for (const cb of listeners['open-settings'] || []) cb();
      return true;
    case 'user_idle_ms':
      return 999999;
    case 'log_event':
      logs.push(String(args.message));
      return null;
    case 'set_hit_regions':
      window.__hitRegions = Array.isArray(args.regions) ? args.regions : [];
      return null;
    case 'set_dragging':
    case 'start_pet_drag':
      return null;
    default:
      return null;
  }
}

window.__TAURI__ = {
  core: { invoke },
  event: {
    listen(name, cb) {
      (listeners[name] ||= []).push(cb);
      return Promise.resolve(() => {
        listeners[name] = (listeners[name] || []).filter(fn => fn !== cb);
      });
    },
  },
  window: { getCurrentWindow: () => ({}) },
};

window.__test = {
  setConfig(patch) {
    config = { ...config, ...patch };
    emitConfig();
  },
  setExpense(v) { today.expense = Number(v); },
  setUnknown(v) { today.unknown = Number(v); },
  failState(v) { failState = !!v; },
  snapshot() { return { config: { ...config }, today: { ...today }, mode, calls, logs }; },
  hitRegions() { return window.__hitRegions || []; },
  clearCalls() { calls.length = 0; },
};
