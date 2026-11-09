// 测试固定到「2026-11-09 10:00」（周一、上班中），之后按真实速度往前走。
// 不固定的话，休息日/下班后工资不涨，金额相关的断言会随真实时间飘。
const FIXED_MS = new Date('2026-11-09T10:00:00+08:00').getTime();
const clockBase = performance.now();
const RealDate = Date;
const fakeNow = () => FIXED_MS + (performance.now() - clockBase);
class FakeDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fakeNow()])); }
  static now() { return fakeNow(); }
}
window.Date = FakeDate;

let config={salary:5000,days:22,start:'09:00',end:'18:00',lunch:1,theme:'light',character:'webm',petScale:130,expanded:false};
let today={expense:5,known:2,unknown:0};
let notify=()=>{};
window.__wlog=[];
window.api={
  getConfig:async()=>config,
  // 返回快照而不是共享对象：真实环境是跨进程取数，改花费必须等到下一次 refresh 才生效
  getState:async()=>({config:{...config},today:{...today}}),
  setConfig:async p=>{config={...config,...p};notify(config);return config},
  onConfig:cb=>notify=cb,
  setExpanded:async expanded=>{config.expanded=expanded;notify(config)},
  setMode:()=>{},
  getLogin:async()=>false,
  onOpenSettings:()=>{},
  log:msg=>{window.__wlog.push(String(msg));}
};
// 测试用：模拟一笔新的扣费（today.expense 涨），下一次 refresh 就会被挂件读到
window.__setExpense=v=>{today.expense=Number(v);};
// 测试用：直接改配置（比如把工资时段改掉，验证「不涨工资时解冻也要清红」）
window.__setConfig=p=>{config={...config,...p};notify(config);};
