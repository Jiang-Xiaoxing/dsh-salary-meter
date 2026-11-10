// 三主题 × 人物显示/隐藏 × 收起/展开 = 12 种挂件状态，
// 以及三主题设置页、开关前后保存/禁用、尺寸与点击区域。
// 跑法：cd plugin && node_modules\electron\dist\electron.exe desktop\checks\ui-polish.cjs
// 全部数据走 checks/ui-polish-preload.cjs 的内存假实现，不碰用户账本/工资参数。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join('E:/SalaryMeter/tmp', 'ui-polish-userdata-' + process.pid));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = path.join(__dirname, '..', '..', '..', 'checks', 'results', 'ui-polish');
fs.mkdirSync(out, { recursive: true });

const themes = {
  dark: { wall: 'radial-gradient(circle at 30% 18%, #526883 0%, #3c4c65 55%, #2e3b50 100%)', panel: 'rgb(32, 44, 61)' },
  light: { wall: 'linear-gradient(135deg, #f7f9fd 0%, #e7edf6 58%, #dbe4f0 100%)', panel: 'rgb(255, 255, 255)' },
  gold: { wall: 'radial-gradient(circle at 30% 18%, #4a4136 0%, #3b352e 58%, #2b261f 100%)', panel: 'rgb(40, 35, 29)' },
};

app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({
      show: false, width: 440, height: 500, frame: false,
      transparent: true, backgroundColor: '#00000000',
      webPreferences: {
        offscreen: true, sandbox: false, contextIsolation: false,
        preload: path.join(__dirname, 'ui-polish-preload.cjs'),
      },
    });
    w.webContents.on('console-message', (event, level, message) => {
      const text = (event && event.message) || message || '';
      const lv = (event && event.level) || level;
      if (lv === 3 || lv === 'error') console.error('RENDERER ' + text);
    });
    w.webContents.on('render-process-gone', (_event, details) => {
      console.error('RENDERER GONE ' + JSON.stringify(details));
    });
    w.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('PRELOAD ERROR ' + preloadPath + ' :: ' + (error && error.stack ? error.stack : error));
    });
    Object.defineProperty(w.webContents, 'visibilityState', { get: () => 'visible' });
    await w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // 页面加载后开启焦点模拟，让隐藏测试窗口也能匹配 iframe 的 :focus。
    w.webContents.debugger.attach('1.3');
    await Promise.race([
      w.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }),
      sleep(5000).then(() => { throw new Error('焦点模拟命令超时'); }),
    ]);
    const run = async source => {
      try {
        return await w.webContents.executeJavaScript(source);
      } catch (error) {
        throw new Error('renderer 执行失败: ' + String(source).slice(0, 220) + ' :: ' + (error && error.message ? error.message : error));
      }
    };
    const snap = () => run('window.__test.snapshot()');
    const waitFor = async (fn, tries = 40, gap = 100) => {
      for (let i = 0; i < tries; i++) {
        if (await fn()) return true;
        await sleep(gap);
      }
      return false;
    };
    await sleep(1200);
    await run('document.fonts.ready.then(() => true)');

    async function setUiExpanded(target) {
      const current = await run("document.querySelector('#widget').dataset.expanded === 'true'");
      if (current !== target) {
        await run("document.querySelector('#toggleBtn').click()");
        await sleep(260);
      }
    }

    const geometries = [];
    const balanceTops = {};
    for (const theme of Object.keys(themes)) {
      for (const animation of [true, false]) {
        for (const expanded of [false, true]) {
          const state = `${theme}-${animation ? 'character' : 'hidden'}-${expanded ? 'expanded' : 'collapsed'}`;
          await run(`__test.setConfig({theme:${JSON.stringify(theme)},animation:${animation},expanded:false})`);
          await sleep(250);
          await setUiExpanded(expanded);
          await run(`document.body.style.background=${JSON.stringify(themes[theme].wall)}`);
          await sleep(220);

          const info = await run(`(() => {
            try {
            const w = document.querySelector('#widget');
            const b = document.querySelector('#balanceRow').getBoundingClientRect();
            const l = document.querySelector('#ledgerRow').getBoundingClientRect();
            const stage = document.querySelector('#petStage');
            const videos = [...document.querySelectorAll('video')];
            const dot = document.querySelector('#balanceValue .sm-dot');
            const slot = document.querySelector('#balanceValue .sm-slot-digit');
            const frac = document.querySelector('#balanceValue .sm-slot.sm-fraction');
            const label = document.querySelector('#balanceLabel');
            const status = document.querySelector('#petStatus');
            const caret = document.querySelector('.sm-caret');
            const card = document.querySelector('#ledgerRow');
            const head = document.querySelector('.sm-ledger-head').getBoundingClientRect();
            const meta = document.querySelector('.sm-ledger-meta').getBoundingClientRect();
            const title = document.querySelector('#statusTitle').getBoundingClientRect();
            const timing = document.querySelector('#worktimeRow').getBoundingClientRect();
            const money = document.querySelector('.sm-ledger-money').getBoundingClientRect();
            const cols = [...document.querySelectorAll('.sm-ledger-money > div')].map(n => n.getBoundingClientRect());
            return {
              theme: w.dataset.theme, expanded: w.dataset.expanded, animation: w.dataset.animation,
              balance: { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, text: document.querySelector('#balanceValue').dataset.amount },
              ledger: { x: l.x, y: l.y, w: l.width, h: l.height, bottom: l.bottom, display: getComputedStyle(document.querySelector('#ledgerRow')).display },
              content: {
                headTop: head.top, headBottom: head.bottom, headDir: getComputedStyle(document.querySelector('.sm-ledger-head')).flexDirection,
                titleCenter: title.top + title.height / 2, metaCenter: meta.top + meta.height / 2,
                timingTop: timing.top, timingBottom: timing.bottom, moneyTop: money.top, moneyBottom: money.bottom,
                moneyDir: getComputedStyle(document.querySelector('.sm-ledger-money')).flexDirection,
                colTops: cols.map(r => r.top), colX: cols.map(r => r.x), colRights: cols.map(r => r.right),
                scrollH: card.scrollHeight, clientH: card.clientHeight, cardBottom: l.bottom,
              },
              stageHidden: stage.hidden,
              videoSrc: videos.map(v => v.getAttribute('src')).filter(Boolean),
              amountFont: getComputedStyle(slot).fontSize,
              fracFont: frac ? getComputedStyle(frac).fontSize : null,
              dotRect: dot ? (r => ({ top: r.top, height: r.height, x: r.x }))(dot.getBoundingClientRect()) : null,
              labelFont: getComputedStyle(label).fontSize,
              statusFont: getComputedStyle(status).fontSize,
              statusColor: getComputedStyle(document.querySelector('#toggleBtn')).color,
              balanceColor: getComputedStyle(document.querySelector('#balanceRow')).color,
              hasCaret: !!caret,
              doc: { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight },
              viewport: { w: innerWidth, h: innerHeight },
            };
            } catch (e) { return { __error: String(e && e.stack || e) }; }
          })()`);
          if (info.__error) throw new Error(state + ' 读取布局失败: ' + info.__error);

          assert.equal(info.theme, theme, state + ' 主题没切到');
          assert.equal(info.expanded, String(expanded), state + ' 展开状态不对');
          assert.equal(info.animation, animation ? 'on' : 'off', state + ' 人物开关状态不对');
          assert.equal(info.balance.y, 300, state + ' 鱼粮条位置跳了');
          assert.ok(info.balance.h > 26 && info.balance.y + info.balance.h < 348, state + ' 鱼粮条侵入账目卡');
          assert.equal(info.balance.right <= 424, true, state + ' 鱼粮条右侧溢出');
          assert.equal(info.labelFont, '15px', state + ' 鱼粮标签字号不对');
          assert.equal(info.statusFont, '15px', state + ' 状态字号不对');
          assert.equal(info.fracFont, info.amountFont, state + ' 小数未恢复原字号');
          assert.equal(info.hasCaret, false, state + ' 新增展开箭头未移除');
          if (expanded) {
            assert.equal(Math.round(info.ledger.w), 300, state + ' 账目卡宽度不是 300');
            assert.equal(Math.round(info.ledger.h), 144, state + ' 账目卡高度不是 144');
            assert.ok(info.ledger.bottom <= 500, state + ' 账目卡底部被裁: ' + info.ledger.bottom);
            assert.equal(Math.round(info.ledger.x), 70, state + ' 账目卡没有居中');
            assert.equal(info.ledger.display, 'flex', state + ' 展开态账目没显示');
            assert.equal(info.content.headDir, 'row', state + ' 标题和时间没有排成一行');
            assert.ok(Math.abs(info.content.titleCenter - info.content.metaCenter) <= 2, state + ' 标题/时间不同行');
            assert.equal(info.content.moneyDir, 'row', state + ' 两列收支没有排成一行');
            assert.ok(Math.abs(info.content.colTops[0] - info.content.colTops[1]) <= 1, state + ' 两列收支顶端不齐');
            assert.ok(info.content.colTops.every(v => v >= info.content.timingBottom - 1), state + ' 收支列压到倒计时');
            assert.ok(info.content.moneyBottom <= info.ledger.bottom - 10, state + ' 金额贴到卡片底边/被裁');
            assert.ok(info.content.colRights.every(v => v <= info.ledger.x + 300 - 14), state + ' 收支列超出卡片右边');
            assert.ok(info.content.scrollH <= info.content.clientH + 1, state + ' 账目卡内容溢出: ' + JSON.stringify(info.content));
          } else {
            assert.equal(info.ledger.display, 'none', state + ' 收起态账目没隐藏');
          }
          if (animation) {
            assert.equal(info.stageHidden, false, state + ' 人物应显示');
            assert.ok(info.videoSrc.length >= 1, state + ' 人物视频没加载');
          } else {
            assert.equal(info.stageHidden, true, state + ' 人物应隐藏');
            assert.equal(info.videoSrc.length, 0, state + ' 隐藏后视频 src 没释放');
            assert.notEqual(info.balance.text, '0.00', state + ' 隐藏人物后余额被清零');
          }

          await w.webContents.capturePage({ x: 0, y: 0, width: 440, height: expanded ? 500 : 390 })
            .then(img => fs.writeFileSync(path.join(out, state + '.png'), img.toPNG()));
          geometries.push({ state, ...info.balance, ledgerBottom: info.ledger.bottom });
          if (!balanceTops[theme]) balanceTops[theme] = new Set();
          balanceTops[theme].add(info.balance.y);
          console.log(state, `balance=${Math.round(info.balance.x)},${Math.round(info.balance.y)} ${Math.round(info.balance.w)}x${Math.round(info.balance.h)}`, `ledgerBottom=${Math.round(info.ledger.bottom)}`);
        }
      }
    }
    assert.equal(geometries.length, 12, '应覆盖 12 种状态');
    for (const [theme, tops] of Object.entries(balanceTops)) assert.equal(tops.size, 1, theme + ' 开关人物时鱼粮位置跳了');

    // 点击区域：人物关掉后只有鱼粮（收起）/鱼粮+账目（展开），没有人物。
    await run('__test.setConfig({theme:"dark",animation:false,expanded:false})');
    await setUiExpanded(false);
    await sleep(250);
    let regions = await run('__test.hitRegions()');
    assert.equal(regions.length, 1, '隐藏+收起应只剩鱼粮点击区，实际 ' + JSON.stringify(regions));
    assert.ok(regions[0].y >= 299 && regions[0].y <= 301, '鱼粮点击区位置不对');
    await setUiExpanded(true);
    regions = await run('__test.hitRegions()');
    assert.equal(regions.length, 2, '隐藏+展开应有鱼粮和账目两个点击区，实际 ' + JSON.stringify(regions));
    assert.ok(regions.some(r => r.width === 300 && r.height === 144), '账目点击区不是 300×144');
    await run('__test.setConfig({animation:true})');
    await sleep(250);
    regions = await run('__test.hitRegions()');
    assert.equal(regions.length, 3, '显示+展开应有人物、鱼粮、账目三个点击区，实际 ' + JSON.stringify(regions));
    const petRegion = regions.find(r => r.width < 200);
    assert.ok(petRegion && petRegion.width < 440, '人物点击区应只占身体，不挡左右空白');
    console.log('点击区：隐藏收起 1、隐藏展开 2、显示展开 3，账目 300×144，人物只占身体');

    // 数字：负数、未知费用、多位金额都不裁切；小数槽在滚动中不上下跳。
    await run('__test.setConfig({animation:false,expanded:true,theme:"dark"})');
    await setUiExpanded(true);
    await sleep(250);
    await run('__test.setConfig({salary:987654321,days:1,start:"00:00",end:"23:59",lunch:0})');
    await sleep(350);
    let money = await run(`(() => {
      const row = document.querySelector('#balanceRow').getBoundingClientRect();
      const val = document.querySelector('#balanceValue').getBoundingClientRect();
      return { row: { x: row.x, right: row.right, w: row.width, sw: document.querySelector('#balanceRow').scrollWidth },
        val: { x: val.x, right: val.right, w: val.width }, text: document.querySelector('#balanceValue').dataset.amount,
        font: getComputedStyle(document.querySelector('#balanceValue .sm-slot-digit')).fontSize };
    })()`);
    assert.ok(money.row.x >= 0 && money.row.right <= 440, '多位金额横向溢出: ' + JSON.stringify(money));
    assert.ok(money.row.sw <= 425, '多位金额被 max-width 裁切: ' + JSON.stringify(money));
    assert.ok(money.text.length >= 10, '多位金额样本不够长: ' + money.text);
    console.log('多位金额', money.text, `行宽 ${money.row.w.toFixed(1)}，字号 ${money.font}`);

    const dotBefore = await run("(()=>{try{const d=document.querySelector('#balanceValue .sm-dot');if(!d)return{error:'no dot'};const r=d.getBoundingClientRect();return{top:r.top,height:r.height,x:r.x}}catch(e){return{error:e.message}}})()");
    assert.ok(!dotBefore.error, '取小数点位失败: ' + JSON.stringify(dotBefore));
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await sleep(90);
      const sample = await run("(()=>{try{const d=document.querySelector('#balanceValue .sm-dot'),f=document.querySelector('#balanceValue .sm-slot.sm-fraction');if(!d||!f)return{error:'missing decimal slot',html:document.querySelector('#balanceValue').outerHTML.slice(0,300)};const r=d.getBoundingClientRect(),q=f.getBoundingClientRect();return{top:r.top,height:r.height,x:r.x,ftop:q.top,fheight:q.height}}catch(e){return{error:e.message}}})()");
      if (sample.error) throw new Error('小数采样失败: ' + JSON.stringify(sample));
      samples.push(sample);
    }
    for (const s of samples) {
      assert.ok(Math.abs(s.top - dotBefore.top) < 1 && Math.abs(s.height - dotBefore.height) < 1, '小数点在滚动时上下位移: ' + JSON.stringify({ dotBefore, s }));
      assert.ok(Math.abs(s.ftop - s.top) < 2, '小数位和点基线错位');
    }

    await run('__test.setConfig({salary:0,days:22,start:"09:00",end:"18:00",lunch:1})');
    await sleep(300);
    const neg = await run("(()=>({text:document.querySelector('#balanceValue').dataset.amount,right:document.querySelector('#balanceRow').getBoundingClientRect().right,color:getComputedStyle(document.querySelector('#balanceValue')).color}))()");
    assert.ok(neg.text.startsWith('−'), '负数符号丢失: ' + neg.text);
    assert.ok(neg.right <= 440, '负数被裁切');
    console.log('数字→负号：不抛异常，负数', neg.text, neg.color);

    await run('__test.setConfig({salary:5000,days:22,start:"09:00",end:"18:00",lunch:1});__test.setExpense(5);__test.setUnknown(1)');
    const recovered = await run("document.querySelector('#balanceValue').dataset.amount");
    assert.ok(!recovered.startsWith('−'), '负号→数字没有恢复: ' + recovered);
    console.log('负号→数字：不抛异常，金额恢复', recovered);
    const partialOk = await waitFor(async () => (await run("document.querySelector('#expenseLabel').textContent")).includes('有遗漏'), 50, 100);
    assert.ok(partialOk, '未知费用没有出现「有遗漏」');
    const partial = await run("(()=>({prefix:document.querySelector('#balancePrefix').textContent,label:document.querySelector('#expenseLabel').textContent,spent:document.querySelector('#spentText').textContent}))()");
    assert.equal(partial.prefix, '≤', '未知费用余粮缺 ≤');
    assert.ok(partial.spent.startsWith('¥≥'), '未知费用饭钱缺 ≥: ' + partial.spent);
    console.log('未知费用', partial);

    // 扣钱方向：refresh 读到花费上涨后，鱼粮变红并显示向下箭头。
    await run('__test.setUnknown(0);__test.setExpense(8)');
    const downOk = await waitFor(async () => run("document.querySelector('#balanceRow').classList.contains('down') && document.querySelector('#balanceArrow').dataset.dir==='down' && document.querySelector('#balanceArrow').dataset.on==='true'"), 60, 100);
    assert.ok(downOk, '扣钱后没有红色/向下箭头反馈');
    console.log('扣钱反馈：红字 + 向下箭头');

    // 设置页：三主题、开关禁用范围、自动保存、焦点态、底部可达。
    await run('__test.setConfig({salary:5000,days:22,start:"09:00",end:"18:00",lunch:1,theme:"dark",animation:true,expanded:true})');
    w.setContentSize(466, 660);
    await sleep(300);
    w.webContents.focus();
    await run("document.querySelector('#settingsBtn').click()");
    await sleep(900);
    const frameRun = source => run(`(()=>{const d=document.querySelector('#settingsFrame').contentDocument;const f=d.defaultView;${source}})()`);
    await frameRun('return f.document.fonts.ready.then(()=>true)');
    const settingsShots = [];
    for (const theme of Object.keys(themes)) {
      await frameRun(`d.querySelector('[data-theme="${theme}"]').click()`);
      await sleep(350);
      await frameRun("f.focus();d.querySelector('#salary').focus()");
      // 焦点环有 150ms 过渡；聚焦同一帧读取会读到起始的 none。
      await sleep(200);
      const themeInfo = await run(`(() => {
        const layer = document.querySelector('#settingsLayer');
        const f = document.querySelector('#settingsFrame');
        const d = f.contentDocument;
        const body = d.body;
        const anim = d.querySelector('.anim-row');
        const input = d.querySelector('#salary');
        const sel = d.querySelector('#seg button.on');
        return {
          layerTheme: layer.dataset.settingsTheme,
          bodyTheme: body.dataset.settingsTheme,
          bodyBg: getComputedStyle(body).backgroundColor,
          focused: d.activeElement === input,
          layerBg: getComputedStyle(layer).backgroundColor,
          animBg: getComputedStyle(anim).backgroundColor,
          inputBg: getComputedStyle(input).backgroundColor,
          inputBorder: getComputedStyle(input).borderColor,
          focusShadow: getComputedStyle(input).boxShadow,
          selectedBg: getComputedStyle(sel).backgroundColor,
          selectedColor: getComputedStyle(sel).color,
          scrollH: d.documentElement.scrollHeight, clientH: d.documentElement.clientHeight,
          frameH: f.getBoundingClientRect().height,
          footBottom: d.querySelector('.foot').getBoundingClientRect().bottom,
          switchRole: d.querySelector('#animation').getAttribute('role'),
          switchLabelled: d.querySelector('#animation').getAttribute('aria-labelledby'),
          switchDescribed: d.querySelector('#animation').getAttribute('aria-describedby'),
          switchTrackBg: getComputedStyle(d.querySelector('.switch-track')).backgroundColor,
        };
      })()`);
      assert.equal(themeInfo.layerTheme, theme, theme + ' 设置浮层主题没同步');
      assert.equal(themeInfo.bodyTheme, theme, theme + ' iframe 主题没同步');
      assert.equal(themeInfo.layerBg, themes[theme].panel, theme + ' 设置底色不是主题色: ' + themeInfo.layerBg);
      assert.equal(themeInfo.bodyBg, themes[theme].panel, theme + ' iframe 内部底色没有跟随主题');
      assert.equal(themeInfo.animBg, 'rgba(0, 0, 0, 0)', theme + ' 动画开关后面出现色块: ' + themeInfo.animBg);
      assert.ok(themeInfo.focused, theme + ' 输入框拿不到焦点，无法检查焦点态');
      assert.notEqual(themeInfo.inputBg, 'rgb(255, 255, 255)', theme + ' 深色输入框是白底');
      assert.ok(themeInfo.focusShadow !== 'none', theme + ' 输入框没有焦点环');
      assert.notEqual(themeInfo.selectedBg, 'rgba(0, 0, 0, 0)', theme + ' 选中态背景为空');
      assert.equal(themeInfo.switchRole, 'switch', '开关缺少 role=switch');
      assert.equal(themeInfo.switchLabelled, 'animationLabel', '开关没有可访问名称');
      assert.equal(themeInfo.switchDescribed, 'animationHint', '开关说明没有关联');
      await w.webContents.capturePage().then(img => fs.writeFileSync(path.join(out, 'settings-' + theme + '.png'), img.toPNG()));
      assert.ok(themeInfo.scrollH <= themeInfo.clientH + 1,
        `${theme}: 660 高设置页底部被裁 scrollH=${themeInfo.scrollH} clientH=${themeInfo.clientH}`);
      assert.ok(themeInfo.footBottom <= themeInfo.clientH + 1, theme + ' 页脚超出 iframe');
      await w.webContents.capturePage().then(img => fs.writeFileSync(path.join(out, 'settings-' + theme + '.png'), img.toPNG()));
      settingsShots.push(themeInfo);
      console.log('设置', theme, themeInfo.layerBg, 'ifftH=' + Math.round(themeInfo.frameH), 'scroll=' + themeInfo.scrollH + '/' + themeInfo.clientH);
    }

    // 开关关闭：只禁用大小滑块和恢复默认；值保留，重开恢复；配置自动保存。
    await frameRun("d.querySelector('[data-theme=\"dark\"]').click()");
    await sleep(200);
    await frameRun("const s=d.querySelector('#petScale');s.value='145';s.dispatchEvent(new Event('input',{bubbles:true}))");
    await sleep(300);
    await frameRun("d.querySelector('#animation').click()");
    await sleep(350);
    const off = await run(`(() => {
      const d = document.querySelector('#settingsFrame').contentDocument;
      return {
        anim: d.querySelector('#animation').checked,
        scaleDisabled: d.querySelector('#petScale').disabled,
        resetDisabled: d.querySelector('#resetPetScale').disabled,
        salaryDisabled: d.querySelector('#salary').disabled,
        themeDisabled: d.querySelector('[data-theme="light"]').disabled,
        restDisabled: d.querySelector('[data-rest="single"]').disabled,
        value: d.querySelector('#petScale').value,
        cfg: window.__test.snapshot().config,
      };
    })()`);
    assert.equal(off.anim, false, '开关没关');
    assert.equal(off.scaleDisabled, true, '关人物后大小滑块没禁用');
    assert.equal(off.resetDisabled, true, '关人物后恢复默认没禁用');
    assert.equal(off.salaryDisabled, false, '关人物后月薪被误禁用');
    assert.equal(off.themeDisabled, false, '关人物后主题被误禁用');
    assert.equal(off.restDisabled, false, '关人物后休息制度被误禁用');
    assert.equal(off.value, '145', '关人物后大小值被清掉');
    assert.equal(off.cfg.animation, false, '关人物没自动保存');
    assert.equal(off.cfg.petScale, 145, '大小没有自动保存');
    await w.webContents.capturePage().then(img => fs.writeFileSync(path.join(out, 'settings-animation-off.png'), img.toPNG()));
    console.log('关人物：只禁用大小/恢复默认，值 ' + off.value + ' 保留，配置 animation=false');

    await frameRun("d.querySelector('#animation').click()");
    await sleep(300);
    const on = await run(`(() => {
      const d = document.querySelector('#settingsFrame').contentDocument;
      return { anim: d.querySelector('#animation').checked, scaleDisabled: d.querySelector('#petScale').disabled,
        resetDisabled: d.querySelector('#resetPetScale').disabled, value: d.querySelector('#petScale').value,
        cfg: window.__test.snapshot().config };
    })()`);
    assert.equal(on.anim, true, '开关没重开');
    assert.equal(on.scaleDisabled, false, '重开后大小仍禁用');
    assert.equal(on.resetDisabled, false, '重开后恢复默认仍禁用');
    assert.equal(on.value, '145', '重开后大小值没恢复');
    assert.equal(on.cfg.animation, true, '重开没自动保存');
    assert.equal(on.cfg.petScale, 145, '重开后大小保存值变了');
    console.log('重开人物：大小 145 保留，两个控件恢复可用');

    // 设置页高度被屏幕压短时，底部仍能滚到，不是裁掉。
    w.setContentSize(466, 500);
    await sleep(350);
    const short = await frameRun(`const last=d.querySelector('.foot');last.scrollIntoView({block:'end'});return new Promise(ok=>requestAnimationFrame(()=>{const r=last.getBoundingClientRect();ok({scrollH:d.documentElement.scrollHeight,clientH:d.documentElement.clientHeight,lastBottom:r.bottom,lastTop:r.top,frameH:f.innerHeight,scrollY:f.scrollY})}))`);
    assert.ok(short.scrollH > short.clientH, '短窗口应触发设置页滚动');
    assert.ok(short.lastBottom <= short.clientH + 2, '短窗口滚到底后页脚仍被裁: ' + JSON.stringify(short));
    await w.webContents.capturePage().then(img => fs.writeFileSync(path.join(out, 'settings-short-bottom.png'), img.toPNG()));
    console.log('短窗口 500：设置页可滚动，页脚滚到底后完整可见', short);

    await run("document.querySelector('#settingsClose').click()");
    await sleep(300);
    assert.equal((await snap()).mode, 'widget', '关闭设置没恢复挂件模式');
    assert.equal(await run("getComputedStyle(document.querySelector('#widget')).visibility"), 'visible', '关闭设置后挂件仍隐藏');

    // 读取失败提示必须在鱼粮上方独立一行，不能盖住账目卡（Codex 复查 P2）。
    w.setContentSize(440, 500);
    await sleep(300);
    await run('__test.setConfig({theme:"dark",animation:false})');
    await setUiExpanded(true);
    await run('__test.failState(true)');
    const errorShown = await waitFor(async () => run("!document.querySelector('#errorBox').hidden"), 50, 100);
    assert.ok(errorShown, '模拟读取失败后错误提示没出现');
    const errorLayout = await run(`(() => {
      const e = document.querySelector('#errorBox').getBoundingClientRect();
      const b = document.querySelector('#balanceRow').getBoundingClientRect();
      const l = document.querySelector('#ledgerRow').getBoundingClientRect();
      return { text: document.querySelector('#errorBox').textContent, error: { top: e.top, bottom: e.bottom, left: e.left, right: e.right },
        balanceTop: b.top, ledgerTop: l.top, ledgerBottom: l.bottom };
    })()`);
    assert.ok(errorLayout.error.bottom <= errorLayout.balanceTop, '错误提示压到鱼粮: ' + JSON.stringify(errorLayout));
    assert.ok(errorLayout.error.bottom <= errorLayout.ledgerTop, '错误提示压到账目卡: ' + JSON.stringify(errorLayout));
    assert.ok(errorLayout.error.left >= 0 && errorLayout.error.right <= 440, '错误提示横向超出窗口');
    await w.webContents.capturePage({ x: 0, y: 0, width: 440, height: 500 })
      .then(img => fs.writeFileSync(path.join(out, 'error-expanded.png'), img.toPNG()));
    console.log('错误提示', errorLayout.text, `bottom=${errorLayout.error.bottom.toFixed(1)}，鱼粮=${errorLayout.balanceTop}，账目=${errorLayout.ledgerTop}`);
    await run('__test.failState(false)');
    const errorHidden = await waitFor(async () => run("document.querySelector('#errorBox').hidden"), 60, 100);
    assert.ok(errorHidden, '读取恢复后错误提示没有消失');

    console.log(`PASS: 12 个挂件状态、三主题设置、开关禁用范围/保存、长负数与未知费用、错误态、点击区、扣钱反馈；截图 ${out}`);
    app.exit(0);
  } catch (error) {
    console.error('FAIL ' + (error && error.stack ? error.stack : error));
    app.exit(1);
  }
});
