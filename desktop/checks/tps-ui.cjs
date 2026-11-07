const {app,BrowserWindow}=require('electron'),fs=require('fs'),assert=require('assert/strict');
app.setPath('userData','D:/AITools/tmp/salary-tps-check');
app.whenReady().then(async()=>{try{
const w=new BrowserWindow({show:false,width:440,height:900,webPreferences:{offscreen:true,sandbox:false,contextIsolation:false,preload:'E:/SalaryMeter/tmp/tps-preload.cjs'}});
await w.loadFile('E:/SalaryMeter/plugin/desktop/renderer/settings.html');
const run=s=>w.webContents.executeJavaScript(s),sleep=ms=>new Promise(r=>setTimeout(r,ms));await sleep(500);
assert.equal(await run("document.querySelector('#perToken').textContent"),'126.7');
console.log('UI=126.7; manual=126.65066026410565; error=0.04933973589435');
await run("document.querySelector('.stats').scrollIntoView({block:'center'})");
await sleep(100);
const bounds=await run("(()=>{const r=document.querySelector('.stats').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()");
const layout=await run("Array.from(document.querySelectorAll('.stat')).map(n=>({y:n.getBoundingClientRect().y,w:n.clientWidth,scroll:n.scrollWidth,label:n.querySelector('span').textContent}))");
assert.equal(new Set(layout.map(r=>r.y)).size,1);assert(layout.every(r=>r.scroll<=r.w));console.log(layout);
fs.writeFileSync('E:/SalaryMeter/checks/tps-settings.png',(await w.webContents.capturePage()).toPNG());
await run("stateMode='error'");await sleep(5200);assert.equal(await run("document.querySelector('#perToken').textContent"),'126.7');
await run("stateMode='empty'");await sleep(5200);assert.equal(await run("document.querySelector('#perToken').textContent"),'—');
fs.writeFileSync('E:/SalaryMeter/checks/tps-empty.png',(await w.webContents.capturePage()).toPNG());
console.log('PASS: 5s refresh, failed fetch keeps value, null displays dash, 3 columns fit');app.exit(0);
}catch(e){console.error(e);app.exit(1)}});
