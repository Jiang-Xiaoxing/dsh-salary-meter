const fs=require('fs');
window.sample=JSON.parse(fs.readFileSync('E:/SalaryMeter/checks/hour-tps-sample.json'));window.stateMode='value';
let config={salary:5000,days:22,start:'09:00',end:'18:00',lunch:1,restMode:'double',theme:'light',character:'webm',petScale:130,expanded:false};let notify=()=>{};
window.api={getConfig:async()=>config,getState:async()=>{if(window.stateMode==='error')throw Error('test');return {config,tps:window.stateMode==='empty'?null:window.sample.tps,today:{expense:39.76,known:10,unknown:0},prices:{source:'缓存'}}},setConfig:async p=>{config={...config,...p};notify(config);return config},onConfig:cb=>notify=cb,setExpanded:async expanded=>{config.expanded=expanded;notify(config)},setMode:()=>{},getLogin:async()=>false,onOpenSettings:()=>{}};
