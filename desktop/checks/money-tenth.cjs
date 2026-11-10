const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', 'E:/SalaryMeter/tmp/money-tenth-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({ show:false, width:440, height:390,
      webPreferences:{ offscreen:true, contextIsolation:false, sandbox:false,
        preload:path.join(__dirname,'money-tenth-preload.cjs') } });
    await w.loadFile(path.join(__dirname,'../renderer/index.html'));
    const run = s => w.webContents.executeJavaScript(s);
    const sample = () => run(`({text:document.querySelector('#balanceValue').dataset.amount,
      up:document.querySelector('#balanceRow').classList.contains('up'),
      down:document.querySelector('#balanceRow').classList.contains('down'),
      color:getComputedStyle(document.querySelector('#balanceMoney')).color})`);
    await sleep(700);
    assert.equal((await sample()).text, '1.13');
    assert.equal((await sample()).up, false, '首屏不闪绿');
    async function move(amount, text, green) {
      await run(`__setAmount(${amount})`);
      for(let i=0;i<20 && (await sample()).text!==text;i++) await sleep(50);
      await sleep(230);
      const s = await sample();
      assert.equal(s.text, text); assert.equal(s.up, green, JSON.stringify(s));
      if(green) assert.equal(s.color,'rgb(23, 166, 115)');
      console.log(`PASS ${text}: green=${s.up}`);
    }
    await move(1.19,'1.19',false);
    await move(1.20,'1.20',true); // 只涨7分，仍应在角位进位时变绿。
    await sleep(1700); assert.equal((await sample()).up,false,'1.6秒后恢复主题色');
    await move(1.23,'1.23',false); // 不能沿用首屏1.13+0.1的旧阈值。
    await move(1.299,'1.30',true); // 显示进位早于原始浮点值到1.30。
    await sleep(1700);
    await move(1.39,'1.39',false);
    await move(2.00,'2.00',true);
    await sleep(1700);
    await move(3.00,'3.00',true); // 同一角位数字但跨整元也应提示。
    await run('__setAmount(-1.23)'); await sleep(230);
    assert.equal((await sample()).down,true,'减少仍变红');
    await sleep(2500);
    await move(-1.20,'−1.20',false);
    await move(-1.19,'−1.19',true); // 负余额上涨时同样按显示角位变化。
    await move(1.1949,'1.19',true);
    await sleep(1700);
    await move(1.1951,'1.20',true); // 只涨0.0002元，显示跨角仍必须绿。
    async function waitRed(red) {
      for(let i=0;i<100;i++) {
        const s=await sample();
        if(s.down===red) return s;
        await sleep(50);
      }
      throw new Error('等待冻结状态超时: '+red);
    }
    await run('__setAmount(1.23)'); await sleep(250);
    await run('__charge(0.1)'); await waitRed(true);
    assert.equal((await sample()).text,'1.13');
    await run('__setAmount(1.16)');
    const same=await waitRed(false);
    assert.equal(same.text,'1.16'); assert.equal(same.up,false,'同角补差不能绿');
    await move(1.20,'1.20',true); // 同角补差之后继续涨，到了角位才绿。
    await run('__setAmount(2.29)'); await sleep(250);
    await run('__charge(0.1)'); await waitRed(true);
    assert.equal((await sample()).text,'2.19');
    await run('__setAmount(2.20)');
    const crossed=await waitRed(false);
    assert.equal(crossed.text,'2.20'); assert.equal(crossed.up,true,'跨角补差立即绿');
    console.log('PASS: 同角补差不绿、随后进角才绿、跨角补差立即绿');
    await run('__setAmount(1.1949)'); await sleep(2500);
    await run(`window.__freezeClasses=[]; window.__freezeObserver=new MutationObserver(() => {
      __freezeClasses.push(document.querySelector('#balanceRow').className);
    }); __freezeObserver.observe(document.querySelector('#balanceRow'), {attributes:true,attributeFilter:['class']});
    __chargeWithAmount(0.0001,1.1956)`);
    await waitRed(true);
    const firstFrame = await run('window.__freezeClasses');
    assert.ok(firstFrame.length>0 && !firstFrame.some(c=>c.split(' ').includes('up')),
      '净上涨跨角且扣费时，冻结首帧不许绿: '+JSON.stringify(firstFrame));
    await run('__freezeObserver.disconnect()');
    console.log('PASS: 扣费与净上涨跨角同时发生时，冻结首帧保持红色');
    console.log('PASS: 显示角位进位、非进位不闪、四舍五入、跨元、负余额与红色反馈');
    app.exit(0);
  } catch(e) { console.error(e); app.exit(1); }
});
