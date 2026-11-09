// 扣钱冻结：扣钱那一下数字变红停住，这波扣完再把工资一次补回来。
// 跑法：node_modules\electron\dist\electron.exe checks\money-hold.cjs
//
// 用户要求（2026-11-09）：
//   - 扣钱变红没问题
//   - 但别扣完立刻又变绿往上跳
//   - 扣钱期间金额固定不动，等这波扣钱结束再一次性把之前加的钱补上来
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
      const n = parseFloat(t.replace(/[^0-9.]/g, ''));
      const row = document.querySelector('#balanceRow');
      return { n: Number.isFinite(n) ? n : null, text: t, cls: row.className };
    })()`);

    // 1) 等基准建立、金额开始往上涨
    await sleep(5000);
    const base = await snapshot();
    assert.ok(base.n !== null, '首屏应该有金额，实际 ' + JSON.stringify(base));
    console.log('基准 ¥' + base.n.toFixed(2));

    // 2) 模拟一笔 5 分钱的扣费（下一次 refresh 会被挂件读到）
    await run('window.__setExpense(39.81)');

    // 3) 等金额真的掉下来（说明这一笔已经反映到显示上）
    let frozenAt = 0;
    let frozenValue = null;
    let clsAtFreeze = '';
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      const s = await snapshot();
      if (s.n !== null && s.n <= base.n - 0.01) {
        frozenAt = Date.now();
        frozenValue = s.n;
        clsAtFreeze = s.cls;
        break;
      }
      await sleep(200);
    }
    assert.ok(frozenAt !== null, `扣钱后金额应该掉下来，实际一直没掉（基准 ${base.n}）`);
    console.log(`扣钱后停在 ¥${frozenValue.toFixed(2)}，class="${clsAtFreeze}"，距模拟扣费 ${frozenAt - t0}ms`);
    assert.ok(clsAtFreeze.includes('down'), '冻结时余额应该是红色(down)，实际 "' + clsAtFreeze + '"');

    // 4) 观察 5 秒：头 2 秒必须一动不动，后面必须补回来
    const samples = [];
    for (let i = 0; i < 25; i++) {
      const s = await snapshot();
      samples.push({ dt: Date.now() - frozenAt, n: s.n, cls: s.cls });
      await sleep(200);
    }
    const held = samples.filter(s => s.dt <= 2000);
    const moved = held.filter(s => Math.abs(s.n - frozenValue) > 0.001);
    assert.equal(moved.length, 0, '冻结的头 2 秒金额不该动，实际动过: ' + JSON.stringify(moved.slice(0, 5)));

    const last = samples[samples.length - 1];
    const thawed = samples.filter(s => s.dt > 3000);
    assert.ok(last.n > frozenValue + 0.005,
      `解冻后应该把工资补回来：冻结 ${frozenValue}，最后 ${last.n}`);
    assert.ok(thawed.some(s => s.cls.includes('up')),
      '补回来的时候应该闪一下绿色(up)，实际没有：' + JSON.stringify(thawed.map(s => s.cls).slice(-5)));

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
