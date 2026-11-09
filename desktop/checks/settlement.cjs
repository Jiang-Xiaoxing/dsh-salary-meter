const {chromium}=require('C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../renderer'),out=path.resolve(__dirname,'../../../checks/results/settlement');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((q,r)=>{const f=path.resolve(root,'.'+decodeURIComponent(q.url.split('?')[0]));if(!f.startsWith(root+path.sep)||!fs.existsSync(f)){r.writeHead(404);return r.end()};const ext=path.extname(f);r.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.html':'text/html'})[ext]||'application/octet-stream');r.end(fs.readFileSync(f))});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const b=await chromium.launch({channel:'msedge',headless:true});try{
 for(const [name,income,expense,unknown] of [['positive',200,12.5,0],['rest',0,12.5,0],['empty',0,0,0],['deficit',2,12.5,3]]){
 const page=await b.newPage({viewport:{width:620,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(v=>window.__SETTLEMENT_PREVIEW__=v,{day:'2026-11-09',income,expense,unknown});
 await page.goto(`http://127.0.0.1:${server.address().port}/settlement.html`);await page.waitForTimeout(700);await page.screenshot({path:path.join(out,name+'-start.png')});await page.waitForTimeout(5800);
 assert.equal(await page.locator('#net').innerText(),'¥'+Math.abs(income-expense).toFixed(2));assert.equal(await page.locator('#label').innerText(),expense>income?'昨日净支出':'昨日剩余');assert.deepEqual(errors,[]);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,name+'-final.png')});await page.locator('#accept').click();assert.equal(await page.locator('body').getAttribute('data-closed'),'true');await page.close();
 }console.log('PASS 4 states: phase timing, amounts, deficit, unknown note, closing, no horizontal overflow');
 }finally{await b.close();server.close()}})().catch(e=>{console.error(e);server.close();process.exitCode=1});
