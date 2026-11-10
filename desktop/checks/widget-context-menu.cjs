// 隔离数据验证：隐藏人物后右键鱼粮/账目仍能打开设置，且不触发展开或拖动。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', 'E:/SalaryMeter/tmp/context-menu-test');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({ show: false, width: 440, height: 500,
      webPreferences: { offscreen: true, contextIsolation: false, sandbox: false,
        preload: path.join(__dirname, 'ui-polish-preload.cjs') } });
    await w.loadFile(path.join(__dirname, '../renderer/index.html'));
    const run = s => w.webContents.executeJavaScript(s);
    await sleep(1000);
    for (const animation of [false, true]) {
      for (const expanded of [false, true]) {
        await run(`__test.setConfig({animation:${animation}})`);
        await run(`if ((document.querySelector('#widget').dataset.expanded === 'true') !== ${expanded}) document.querySelector('#toggleBtn').click()`);
        await sleep(150);
        assert.equal(await run("document.querySelector('#widget').dataset.expanded"), String(expanded));
        const targets = ['#balanceLabel', '#balanceValue .sm-slot', '#petStatus'];
        if (expanded) targets.push('#statusTitle', '#earnedText', '#settingsBtn');
        if (animation) targets.push('#mascotBtn');
        for (const selector of targets) {
          const result = await run(`(() => {
            __test.clearCalls();
            const event = new MouseEvent('contextmenu', {bubbles:true,cancelable:true,button:2});
            document.querySelector(${JSON.stringify(selector)}).dispatchEvent(event);
            const state=__test.snapshot();
            return { prevented:event.defaultPrevented, open:!document.querySelector('#settingsLayer').hidden,
              mode:state.mode, expanded:state.config.expanded, calls:state.calls };
          })()`);
          assert.ok(result.prevented && result.open, `${selector}: ${JSON.stringify(result)}`);
          assert.equal(result.mode, 'settings');
          assert.equal(result.expanded, expanded, '右键不能切换账目');
          assert.equal(result.calls.filter(c => c.name === 'set_mode').length, 1);
          assert.ok(!result.calls.some(c => ['set_config','set_expanded','start_pet_drag'].includes(c.name)));
          await run("document.querySelector('#settingsClose').click()");
          assert.equal(await run('__test.snapshot().mode'), 'widget');
        }
        console.log(`PASS animation=${animation} expanded=${expanded}: ${targets.join(', ')}`);
      }
    }
    assert.equal(await run("document.querySelector('#balanceRow').hasAttribute('title')"), false);
    const blank = await run(`(() => {
      const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2});
      document.querySelector('#widget').dispatchEvent(e);
      return {prevented:e.defaultPrevented,hidden:document.querySelector('#settingsLayer').hidden};
    })()`);
    assert.deepEqual(blank, {prevented:false,hidden:true}, '透明空白不新增右键入口');
    const before = await run('__test.snapshot().config.expanded');
    await run("document.querySelector('#balanceLabel').click()");
    assert.equal(await run('__test.snapshot().config.expanded'), !before);
    await run("document.querySelector('#toggleBtn').click()");
    assert.equal(await run('__test.snapshot().config.expanded'), before);
    console.log('PASS: 无鱼粮悬停说明，右键设置，关闭恢复，左键收展，空白区域边界');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
