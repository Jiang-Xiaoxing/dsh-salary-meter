// 扣钱冻结：扣钱那一下数字变红停住，这波扣完再把工资一次补回来。
// 跑法：node_modules\electron\dist\electron.exe checks\money-hold.cjs
//
// 用户要求（2026-11-09）：
//   - 扣钱变红没问题
//   - 但别扣完立刻又变绿往上跳
//   - 扣钱期间金额固定不动，等这波扣钱结束再一次性把之前加的钱补上来
//
// Codex 审查后补强的地方：断言用 null 判断、金额保留负号、固定时钟、
// 冻结全程都要是红色（不只是前一秒）。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');

app.setPath('userData', 'D:/AITools/tmp/salary-money-hold');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({
      show: false, width: 460, height: 520,
      webPreferences: { offscreen: true, preload: __dirname + '/pet-test-preload.cjs', contextIsolation: false },
    });
    Object.defineProperty(w.webContents, 'visibilityState', { get: () => 'visible' });
    await w.loadFile(path.join(__dirname, '../renderer/index.html'));
    const run = s => w.webContents.executeJavaScript(s);

    const snapshot = () => run(`(() => {
      const t = document.querySelector('#balanceValue').dataset.amount || '';
      // 金额可能带全角负号 −、千分位逗号、前面的 ≤
      const clean = t.replace(/,/g, '').replace(/\\u2212/g, '-').replace(/[^-0-9.]/g, '');
      const n = parseFloat(clean);
      const row = document.querySelector('#balanceRow');
      return { n: Number.isFinite(n) ? n : null, text: t, cls: row.className };
    })()`);

    // 1) 等基准建立、金额开始往上涨
    await sleep(5000);
    const base = await snapshot();
    assert.ok(base.n !== null, '首屏应该有金额，实际 ' + JSON.stringify(base));
    assert.ok(base.n > 0, '基准应该是正数（测试时钟固定在工作日 10:00），实际 ' + base.n);
    console.log('基准 ¥' + base.n.toFixed(2));

    // 2) 模拟一笔 5 分钱的扣费（下一次 refresh 会被挂件读到）
    await run('window.__setExpense(5.05)');

    // 3) 等金额掉下来（扣费生效）；再等日志出现「扣钱冻结」——冻结是从那一刻开始，
    //    之前的几百毫秒还在正常上涨，不能拿来当冻结期断言。
    let dropped = null;
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      const s = await snapshot();
      if (s.n !== null && s.n <= base.n - 0.01) { dropped = s.n; break; }
      await sleep(200);
    }
    assert.ok(dropped !== null, `扣钱后金额应该掉下来，实际一直没掉（基准 ${base.n}）`);

    let frozenAt = null;
    let frozenValue = null;
    let clsAtFreeze = '';
    for (let i = 0; i < 40; i++) {
      const logs = await run('window.__wlog || []');
      if (logs.some(l => l.startsWith('扣钱冻结'))) {
        const s = await snapshot();
        frozenAt = Date.now();
        frozenValue = s.n;
        clsAtFreeze = s.cls;
        break;
      }
      await sleep(150);
    }
    assert.ok(frozenAt !== null, '日志里一直没出现「扣钱冻结」，冻结没生效');
    assert.ok(frozenValue !== null, '冻结金额没取到');
    console.log(`扣钱后金额 ¥${dropped.toFixed(2)}，冻结在 ¥${frozenValue.toFixed(2)}，class="${clsAtFreeze}"，距模拟扣费 ${frozenAt - t0}ms`);
    assert.ok(clsAtFreeze.includes('down'), '冻结时余额应该是红色(down)，实际 "' + clsAtFreeze + '"');

    // 4) 观察到解冻为止（安静期 3.6 秒 + 余量），期间金额一动不动、一直是红色
    const samples = [];
    for (let i = 0; i < 34; i++) { // 6.8 秒
      const s = await snapshot();
      samples.push({ dt: Date.now() - frozenAt, n: s.n, cls: s.cls });
      await sleep(200);
    }
    const held = samples.filter(s => s.dt <= 3000); // 安静期 3.6 秒，前 3 秒必定还在冻
    const moved = held.filter(s => Math.abs(s.n - frozenValue) > 0.001);
    assert.equal(moved.length, 0, '冻结的头 3 秒金额不该动，实际动过: ' + JSON.stringify(moved.slice(0, 5)));
    const notRed = held.filter(s => !s.cls.includes('down'));
    assert.equal(notRed.length, 0, '冻结期间应该一直是红色，这些样本不是: ' + JSON.stringify(notRed.slice(0, 5)));

    const last = samples[samples.length - 1];
    assert.ok(last.n > frozenValue + 0.005,
      `解冻后应该把工资补回来：冻结 ${frozenValue}，最后 ${last.n}`);
    const thawed = samples.filter(s => s.dt > 4500);
    assert.ok(thawed.length > 0, '应该采到解冻后的样本');
    const frozenAfterThaw = thawed.filter(s => s.cls.includes('down') && s.cls.includes('up'));
    assert.equal(frozenAfterThaw.length, 0, '解冻后不应该还带着冻结的红色');

    // 5) 日志里能查到这一轮冻结
    const logs = await run('window.__wlog || []');
    const moneyLogs = logs.filter(l => l.includes('扣钱'));
    console.log(`样本 ${samples.length} 个，最后 ¥${last.n.toFixed(2)}（补回 ${(last.n - frozenValue).toFixed(4)}）`);
    console.log('日志: ' + moneyLogs.join(' / '));
    assert.ok(moneyLogs.some(l => l.startsWith('扣钱冻结')), '日志里应该有「扣钱冻结」');
    assert.ok(moneyLogs.some(l => l.startsWith('扣钱结束')), '日志里应该有「扣钱结束」');

    console.log('PASS 扣钱变红冻住，这波结束后一次补回');
    app.exit(0);
  } catch (error) {
    console.error('FAIL ' + (error && error.message ? error.message : error));
    app.exit(1);
  }
});
