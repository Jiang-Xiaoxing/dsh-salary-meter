const {app,BrowserWindow}=require('electron'),fs=require('fs'),assert=require('assert/strict'),path=require('path');
app.setPath('userData','D:/AITools/tmp/salary-readability-test');
app.whenReady().then(async()=>{try{
const w=new BrowserWindow({show:false,width:440,height:500,frame:false,webPreferences:{offscreen:true,sandbox:false,preload:path.join(__dirname,'pet-test-preload.cjs'),contextIsolation:false}});
await w.loadFile(path.join(__dirname,'../renderer/index.html'));
const run=async s=>{try{return await w.webContents.executeJavaScript(s)}catch(e){console.error('FAILED SCRIPT',s);throw e}},sleep=ms=>new Promise(r=>setTimeout(r,ms));
await sleep(2500);await run('document.fonts.ready.then(()=>true)');
assert(await run('document.fonts.check("400 15px Salary Noto Sans SC")'));
const out='E:/SalaryMeter/checks/results/readability';fs.mkdirSync(out,{recursive:true});
for(const [theme,bg] of [['light','#fff'],['dark','#18181c'],['gold','linear-gradient(30deg,#648674 40%,#d0b98b 40%,#385666 80%)']]){
await run(`api.setConfig({theme:'${theme}',expanded:false});document.body.style.background='${bg}'`);await sleep(250);
const metrics=await run(`(()=>{const r=document.querySelector('#balanceRow').getBoundingClientRect();return {x:r.x,right:r.right,text:document.querySelector('#balanceRow').innerText,font:getComputedStyle(document.querySelector('#balanceLabel')).fontSize,color:getComputedStyle(document.querySelector('#balanceRow')).color,stroke:getComputedStyle(document.querySelector('#balanceRow')).webkitTextStrokeWidth,amountSize:getComputedStyle(document.querySelector('#balanceValue')).fontSize,fracSize:getComputedStyle(document.querySelector('#balanceValue .sm-fraction')).fontSize}})()`);
assert(metrics.x>=0&&metrics.right<=440,JSON.stringify(metrics));assert.equal(metrics.font,'15px');assert.equal(metrics.stroke,'0px');assert.equal(metrics.amountSize,'26px');assert.equal(metrics.fracSize,metrics.amountSize);assert.equal(metrics.color,theme==='light'?'rgb(53, 59, 72)':theme==='gold'?'rgb(214, 179, 106)':'rgb(240, 242, 246)');assert(metrics.text.includes('鱼粮'));assert(!metrics.text.includes('余粮'));assert(metrics.text.includes('¥'));assert(!metrics.text.includes('元'));console.log(theme,metrics);
fs.writeFileSync(out+'/'+theme+'.png',(await w.webContents.capturePage({x:0,y:0,width:440,height:390})).toPNG());
}
await run("document.querySelector('#toggleBtn').click()");await sleep(250);assert.equal(await run("document.querySelector('#widget').dataset.expanded"),'true');
fs.writeFileSync(out+'/expanded.png',(await w.webContents.capturePage({x:0,y:0,width:440,height:500})).toPNG());
await run("document.querySelector('#toggleBtn').click()");await sleep(250);assert.equal(await run("document.querySelector('#widget').dataset.expanded"),'false');
for(const value of ['0.00','−21.25','−1,234,567.89']){
await run(`document.querySelector('#balanceValue').textContent='${value}';document.querySelector('#balanceMoney').style.setProperty('--sm-digits',${value.length});document.querySelector('#balancePrefix').textContent='≤'`);
const fits=await run("(()=>{const r=document.querySelector('#balanceRow');return r.scrollWidth<=424&&r.getBoundingClientRect().left>=0&&r.getBoundingClientRect().right<=440})()");assert(fits,value);
}
console.log('PASS: bundled font, three themes, original 26px amount / equal decimal, currency, large amounts, expand/collapse');app.exit(0);
}catch(e){console.error(e);app.exit(1)}});
