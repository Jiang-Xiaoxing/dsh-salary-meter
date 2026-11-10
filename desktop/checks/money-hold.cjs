// 扣钱冻结：扣钱那一下数字变红停住，这波扣完再把工资一次补回来。
// 跑法：node_modules\electron\dist\electron.exe checks\money-hold.cjs
//
// 用户要求（2026-11-09）：
//   - 扣钱变红没问题
//   - 但别扣完立刻又变绿往上跳
//   - 扣钱期间金额固定不动，等这波扣钱结束再一次性把之前加的钱补上来
//
// 断言口径（Codex 两轮审查后收紧）：
//   - 冻结从「扣钱冻结」日志出现的时刻算，不从金额刚掉下来算
//   - 冻结期间每一个样本都必须是红的；解冻后每一个样本都不能还带着红
//   - 2026-11-10：补回后只有显示角位变化才绿色，不再每次补差都绿色
//   - 连续扣费也要在 10 秒上限处强制解冻一次
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
    const logs = () => run('window.__wlog || []');
    const waitFor = async (pred, tries, gap) => {
      for (let i = 0; i < tries; i++) {
        if (await pred()) return true;
        await sleep(gap);
      }
      return false;
    };

    // 1) 等基准建立、金额开始往上涨
    await sleep(5000);
    const base = await snapshot();
    assert.ok(base.n !== null, '首屏应该有金额，实际 ' + JSON.stringify(base));
    assert.ok(base.n > 0, '基准应该是正数（测试时钟固定在工作日 10:00），实际 ' + base.n);
    console.log('基准 ¥' + base.n.toFixed(2));

    // 2) 模拟一笔 5 分钱的扣费
    await run('window.__setExpense(5.05)');

    // 3) 等「扣钱冻结」日志出现，这才是冻结真正开始的时刻
    const froze = await waitFor(async () => (await logs()).some(l => l.startsWith('扣钱冻结')), 40, 200);
    assert.ok(froze, '日志里一直没出现「扣钱冻结」，冻结没生效');
    const frozenStart = await snapshot();
    assert.ok(frozenStart.n !== null, '冻结时金额没取到');
    assert.ok(frozenStart.n < base.n - 0.01, `扣钱后金额应该下来：基准 ${base.n}，冻结 ${frozenStart.n}`);
    assert.ok(frozenStart.cls.includes('down'), '冻结时余额应该是红色(down)，实际 "' + frozenStart.cls + '"');
    const frozenValue = frozenStart.n;
    console.log(`冻结在 ¥${frozenValue.toFixed(2)}（基准 ¥${base.n.toFixed(2)}），class="${frozenStart.cls}"`);

    // 4) 从冻结时刻开始采样 7 秒，覆盖解冻
    const samples = [];
    const t0 = Date.now();
    for (let i = 0; i < 35; i++) {
      const s = await snapshot();
      samples.push({ dt: Date.now() - t0, n: s.n, cls: s.cls });
      await sleep(200);
    }
    // 金额没变 = 还在冻结；变了 = 已解冻
    const held = samples.filter(s => Math.abs(s.n - frozenValue) <= 0.001);
    const thawed = samples.filter(s => Math.abs(s.n - frozenValue) > 0.001);
    assert.ok(held.length >= 10, `冻结样本太少（${held.length}），冻结可能没撑住`);
    const notRed = held.filter(s => !s.cls.includes('down'));
    assert.equal(notRed.length, 0, '冻结期间每一个样本都该是红色，这些不是: ' + JSON.stringify(notRed.slice(0, 5)));
    assert.ok(thawed.length > 0, '7 秒内应该已经解冻，实际金额一直没恢复');

    const stillDown = thawed.filter(s => s.cls.includes('down'));
    assert.equal(stillDown.length, 0, '解冻后不该还挂着红色: ' + JSON.stringify(stillDown.slice(0, 5)));
    const sawUp = thawed.some(s => s.cls.includes('up'));
    const tenth = n => Math.abs(n).toFixed(2).slice(0, -1);
    const crossedTenth = thawed.some(s => tenth(s.n) !== tenth(frozenValue));
    assert.equal(sawUp, crossedTenth, '补回工资只在显示角位变化后闪绿');

    const last = samples[samples.length - 1];
    assert.ok(last.n > frozenValue + 0.005, `解冻后应该把工资补回来：冻结 ${frozenValue}，最后 ${last.n}`);
    console.log(`样本 ${samples.length} 个（冻结 ${held.length} / 解冻 ${thawed.length}），最后 ¥${last.n.toFixed(2)}（补回 ${(last.n - frozenValue).toFixed(4)}）`);

    // 5) 连续扣费：每 3.3 秒一笔，共 4 笔，10 秒上限必须生效一次
    const beforeBurst = (await logs()).filter(l => l.startsWith('扣钱结束')).length;
    for (let i = 0; i < 4; i++) {
      await run(`window.__setExpense(${5.10 + i * 0.05})`);
      if (i === 0) await waitFor(async () => (await logs()).filter(l => l.startsWith('扣钱冻结')).length >= 2, 30, 200);
      else await sleep(3300);
    }
    await sleep(3000);
    const afterBurstLogs = await logs();
    const thawCount = afterBurstLogs.filter(l => l.startsWith('扣钱结束')).length - beforeBurst;
    assert.ok(thawCount >= 1, `连续扣费 13 秒里应该至少因 10 秒上限解冻一次，实际 ${thawCount} 次`);
    // 光看「解冻过一次」不够：安静期到期也会解冻。要确认最后这一波是冻满 10 秒才解的
    const stamp = line => Number((String(line).match(/t=(\d+)/) || [])[1]);
    const freezeLines = afterBurstLogs.filter(l => l.startsWith('扣钱冻结'));
    const thawLines = afterBurstLogs.filter(l => l.startsWith('扣钱结束'));
    const lastFreezeT = stamp(freezeLines[freezeLines.length - 1]);
    const lastThawT = stamp(thawLines[thawLines.length - 1]);
    assert.ok(Number.isFinite(lastFreezeT) && Number.isFinite(lastThawT), '日志里应该有 t= 时间戳');
    assert.ok(lastThawT - lastFreezeT >= 9500,
      `连续扣费时应该是 10 秒上限解冻，实际只冻了 ${lastThawT - lastFreezeT}ms`);
    console.log(`连续扣费：新增解冻 ${thawCount} 次，最后一波冻了 ${lastThawT - lastFreezeT}ms（上限 10 秒）`);

    const moneyLogs = afterBurstLogs.filter(l => l.includes('扣钱'));
    assert.ok(moneyLogs.some(l => l.startsWith('扣钱冻结')), '日志里应该有「扣钱冻结」');
    assert.ok(moneyLogs.some(l => l.startsWith('扣钱结束')), '日志里应该有「扣钱结束」');
    console.log('扣钱日志 ' + moneyLogs.length + ' 条，最后 4 条: ' + moneyLogs.slice(-4).join(' / '));

    console.log('PASS 扣钱变红冻住、全程红、这波结束后一次补回；连续扣费到上限会强制解冻');
    app.exit(0);
  } catch (error) {
    console.error('FAIL ' + (error && error.message ? error.message : error));
    app.exit(1);
  }
});
