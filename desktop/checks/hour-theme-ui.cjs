const {app,BrowserWindow}=require('electron'),fs=require('fs'),assert=require('assert/strict'),path=require('path');
app.setPath('userData','D:/AITools/tmp/salary-hour-theme-check');
app.whenReady().then(async()=>{try{
const w=new BrowserWindow({show:false,width:440,height:900,webPreferences:{offscreen:true,sandbox:false,contextIsolation:false,preload:path.join(__dirname,'hour-theme-preload.cjs')}});
await w.loadFile(path.join(__dirname,'../renderer/index.html'));
const run=s=>w.webContents.executeJavaScript(s),sleep=ms=>new Promise(r=>setTimeout(r,ms));await sleep(800);
await run("document.querySelector('#settingsBtn').click()");await sleep(900);
const frame=s=>run(`(()=>{const d=document.querySelector('#settingsFrame').contentDocument;${s}})()`);
await frame('return d.fonts.ready.then(()=>true)');
const expected=await run("sample.tps===null?'—':sample.tps.toFixed(1)");assert.equal(await frame("return d.querySelector('#perToken').textContent"),expected);
for(const theme of ['dark','light','gold']){
await frame(`d.querySelector('[data-theme="${theme}"]').click()`);await sleep(500);
assert.equal(await run("document.querySelector('#settingsLayer').dataset.settingsTheme"),theme);
assert.equal(await frame('return d.body.dataset.settingsTheme'),theme);
assert.equal(await run('(async()=> (await api.getConfig()).theme)()'),theme);
const layout=await frame("return Array.from(d.querySelectorAll('.stat')).map(n=>({y:n.getBoundingClientRect().y,w:n.clientWidth,scroll:n.scrollWidth,label:n.querySelector('span').textContent}))");
assert.equal(new Set(layout.map(r=>r.y)).size,1);assert(layout.every(r=>r.scroll<=r.w));
const fonts=await frame("return ['#salary','#perDay','#perMonth','#perToken','.field label','.seg button'].map(s=>d.defaultView.getComputedStyle(d.querySelector(s)).fontFamily)");assert(fonts.every(f=>f.includes('Salary Noto Sans SC')));
await frame("d.querySelector('.stats').scrollIntoView({block:'center'})");await sleep(200);
fs.writeFileSync('E:/SalaryMeter/checks/hour-theme-'+theme+'.png',(await w.webContents.capturePage()).toPNG());console.log(theme,layout,fonts);
}
await run("stateMode='error'");await sleep(5200);assert.equal(await frame("return d.querySelector('#perToken').textContent"),expected);
await run("stateMode='empty'");await sleep(5200);assert.equal(await frame("return d.querySelector('#perToken').textContent"),'—');
fs.writeFileSync('E:/SalaryMeter/checks/hour-empty.png',(await w.webContents.capturePage()).toPNG());
await run("stateMode='value';document.querySelector('#settingsClose').click();document.querySelector('#toggleBtn').click()");await sleep(300);
const fonts=await run("Array.from(document.querySelectorAll('.sm-ledger,.sm-ledger b,.sm-ledger span')).map(n=>getComputedStyle(n).fontFamily)");assert(fonts.length>0&&fonts.every(f=>f.includes('Salary Noto Sans SC')));console.log('Ledger fonts',fonts);
fs.writeFileSync('E:/SalaryMeter/checks/hour-ledger-font.png',(await w.webContents.capturePage()).toPNG());
await run("document.querySelector('#settingsBtn').click()");await sleep(200);assert.equal(await frame('return d.body.dataset.settingsTheme'),'gold');
console.log('PASS: themes/persisted config/reopen/fonts/3 columns/5s/error retained/null dash; UI='+expected);app.exit(0);
}catch(e){console.error(e);app.exit(1)}});
