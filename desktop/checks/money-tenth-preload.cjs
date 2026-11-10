// 固定工作日10点：1天/月、8小时/天，10点已赚月薪的1/8。只使用隔离内存数据。
const RealDate = Date;
const fixed = new RealDate('2026-11-09T10:00:00+08:00').getTime();
window.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixed])); }
  static now() { return fixed; }
};
let config = { salary: 89.04, days: 1, start: '09:00', end: '18:00', lunch: 1,
  theme: 'gold', animation: false, expanded: false };
let notify = () => {};
let expense = 10;
window.api = {
  getConfig: async () => ({ ...config }),
  getState: async () => ({ config: { ...config }, today: { expense, known: 1, unknown: 0 } }),
  setConfig: async patch => { config = { ...config, ...patch }; notify(config); return config; },
  onConfig: cb => { notify = cb; },
  setExpanded: async expanded => { config.expanded = expanded; },
  setMode() {}, onOpenSettings() {}, log() {},
};
window.__setAmount = amount => window.api.setConfig({ salary: (amount + expense) * 8 });
window.__charge = amount => { expense += amount; };
window.__chargeWithAmount = (charge, amount) => {
  expense += charge;
  config = { ...config, salary: (amount + expense) * 8 };
};
