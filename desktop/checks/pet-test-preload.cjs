let config={salary:5000,days:22,start:'09:00',end:'18:00',lunch:1,theme:'light',character:'webm',petScale:130,expanded:false};
let today={expense:39.76,known:10,unknown:0};
let notify=()=>{};
window.__wlog=[];
window.api={
  getConfig:async()=>config,
  getState:async()=>({config,today}),
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
