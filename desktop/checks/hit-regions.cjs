const vm=require('vm'),fs=require('fs'),assert=require('assert/strict');
let ready,tick,reported;
const node=(x,y,width,height,video=false)=>({hidden:false,classList:{contains:()=>video},getBoundingClientRect:()=>({x,y,width,height}),addEventListener(){}});
const nodes={'.sm-mascot':node(0,20,440,300,true),'#balanceRow':node(98,300,244,37),'.sm-top':node(85,350,270,27),'.sm-worktime':node(85,377,270,30),'.sm-ledger':node(85,407,270,43)};
const window={__TAURI__:{core:{invoke:async(k,p)=>{if(k==='set_hit_regions')reported=p.regions}},event:{listen(){}}},addEventListener(k,f){if(k==='DOMContentLoaded')ready=f}};
vm.runInNewContext(fs.readFileSync('desktop/renderer/tauri-shim.js','utf8'),{window,document:{querySelector:s=>nodes[s],querySelectorAll:()=>[],getElementById:id=>nodes['#'+id]},getComputedStyle:n=>({display:n.hidden?'none':'block'}),setInterval:f=>tick=f,console});
ready();
const hit=(x,y)=>reported.some(r=>x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height);
assert(hit(220,180));assert(hit(220,315));assert(hit(220,400));
assert(!hit(220,295),'人物与金额间空白');
assert(!hit(220,344),'金额与账目间空白');
assert(!hit(110,150),'人物左边透明区域');
for(const s of ['.sm-top','.sm-worktime','.sm-ledger'])nodes[s].hidden=true;
tick();assert(!hit(220,400),'收起明细后必须放行');
nodes['#balanceRow']=node(60,300,320,37);tick();assert(hit(70,315),'金额变宽跟随');
console.log('PASS: 独立区域、两处间隙、侧面空白、隐藏明细、动态宽度');

