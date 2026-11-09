const {chromium}=require('C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../renderer'),out=path.resolve(__dirname,'../../../checks/results/settlement');fs.mkdirSync(out,{recursive:true});
const ymd=ms=>new Date(ms).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const yesterday=ymd(Date.now()-86400000),older=ymd(Date.now()-2*86400000);
const server=http.createServer((q,r)=>{const f=path.resolve(root,'.'+decodeURIComponent(q.url.split('?')[0]));if(!f.startsWith(root+path.sep)||!fs.existsSync(f)){r.writeHead(404);return r.end()};const ext=path.extname(f);r.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.html':'text/html','.webm':'video/webm'})[ext]||'application/octet-stream');r.end(fs.readFileSync(f))});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const b=await chromium.launch({channel:'msedge',headless:true});try{
 const states=[['positive',yesterday,200,12.5,0],['rest',yesterday,0,12.5,0],['empty',yesterday,0,0,0],['quiet',yesterday,200,0,0],['deficit',yesterday,2,12.5,3],['older',older,200,12.5,0]];
 for(const [name,day,income,expense,unknown] of states){
  const page=await b.newPage({viewport:{width:620,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(v=>{
   window.__CALLS__=[];
   window.__TAURI__={core:{invoke:async(n,a)=>{window.__CALLS__.push([n,a]);if(n==='settlement_bill')return v;return null;}},window:{getCurrentWindow:()=>({close:async()=>window.__CALLS__.push(['window.close'])})}};
  },{day,income,expense,unknown});
  await page.goto(`http://127.0.0.1:${server.address().port}/settlement.html`);
  await page.waitForTimeout(700);
  await page.screenshot({path:path.join(out,name+'-start.png')});
  const first=await page.locator('#bubble').innerText(), date=await page.locator('#date').innerText();
  assert(!first.includes('今天'),`${name}: 台词写着今天 -> ${first}`);
  if(name==='older'){assert(!first.includes('昨天'),`${name}: 前天的账单还说昨天 -> ${first}`);assert(date.includes('补记的账单'),`${name}: 标题没改成补记 -> ${date}`);}
  else{assert(first.includes('昨天'),`${name}: 没说是昨天的账 -> ${first}`);assert(date.includes('昨日账单'),`${name}: 标题不是昨日账单 -> ${date}`);}
  if(name==='quiet')assert.equal(first,'昨天一分钱没花。');
  await page.waitForTimeout(5800);
  assert.equal(await page.locator('#net').innerText(),'¥'+Math.abs(income-expense).toFixed(2));
  assert.equal(await page.locator('#label').innerText(),(name==='older'?'':'昨日')+(expense>income?'净支出':'剩余'));
  assert.deepEqual(errors,[]);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,name+'-final.png')});
  await page.locator('#close').click();
  const calls=await page.evaluate(()=>window.__CALLS__.map(c=>c[0]));
  assert(calls.includes('hide_settlement'),`${name}: × 没走 hide_settlement -> ${calls}`);
  assert(!calls.includes('dismiss_settlement'),`${name}: × 把账单标成已读了 -> ${calls}`);
  await page.locator('#accept').click();
  const calls2=await page.evaluate(()=>window.__CALLS__.map(c=>c[0]));
  assert(calls2.includes('dismiss_settlement'),`${name}: 收下没走 dismiss_settlement -> ${calls2}`);
  await page.close();
 }
 console.log('PASS 6 states: 昨天的账说昨天、前天的账说日期不说昨天、有工资没花钱有独立台词、× 只隐藏不标已读、收下才清账单、金额/标签/无横向溢出');
}finally{await b.close();server.close()}})().catch(e=>{console.error(e);server.close();process.exitCode=1});
