const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
function target(){return {events:{},addEventListener(k,f){(this.events[k]??=[]).push(f)},fire(k,e){for(const f of this.events[k]||[])f(e)}}}
const win=target(),pet=target(),balance=target();let ready,drag=0,calls=[];
win.__TAURI__={core:{invoke:async(k,p)=>{calls.push([k,p]);if(k==='start_pet_drag')drag++}},event:{listen(){}},window:{getCurrentWindow:()=>({startDragging:async()=>{drag++}})}};
const doc={querySelectorAll:()=>[],querySelector:()=>pet,getElementById:()=>balance};
vm.runInNewContext(fs.readFileSync('desktop/renderer/tauri-shim.js','utf8'),{window:win,document:doc,console});win.fire('DOMContentLoaded');
const settle=()=>new Promise(r=>setImmediate(r));
(async()=>{const e=(node,x)=>({button:0,screenX:x,screenY:10,target:{closest:()=>node}});
pet.fire('mousedown',e(pet,10));win.fire('mousemove',e(pet,13));await settle();assert.equal(drag,0);
win.fire('mousemove',e(pet,30));await settle();assert.equal(drag,1);let blocked=false;pet.fire('click',{preventDefault(){},stopImmediatePropagation(){blocked=true}});assert.ok(blocked);
win.fire('mouseup',{});pet.fire('mousedown',e(pet,10));win.fire('mouseup',{});blocked=false;pet.fire('click',{preventDefault(){},stopImmediatePropagation(){blocked=true}});assert.equal(blocked,false);
balance.fire('mousedown',e({},10));win.fire('mousemove',e({},30));await settle();assert.equal(drag,1);
balance.fire('mousedown',{...e(null,10)});win.fire('mousemove',e(null,30));await settle();assert.equal(drag,2);
console.log('PASS: 人物拖动、轻点保留、拖后不误点、子按钮排除、余额拖动');})();
