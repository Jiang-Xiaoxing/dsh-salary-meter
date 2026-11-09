// 视频失败路径的回归检查（需要 electron）：
//   node_modules\electron\dist\electron.exe checks\video-failure.cjs
// 做法：把 renderer/assets/webm 临时改名 → 人物应该隐藏（不拿图集顶）、气泡消失、面板数字照常；
// 等到 60 秒后再看仍然隐藏；把目录改回来，等重试窗口，人物应该自己回来。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const WEBM = path.join(ROOT, 'renderer', 'assets', 'webm');
const BAK = path.join(ROOT, 'renderer', 'assets', 'webm_bak');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function restoreDir() {
  if (!fs.existsSync(WEBM) && fs.existsSync(BAK)) fs.renameSync(BAK, WEBM);
}

app.setPath('userData', 'D:/AITools/tmp/salary-video-failure');
app.whenReady().then(async () => {
  let ok = false;
  try {
    // 先确认目录是正常状态，然后临时改名
    restoreDir();
    fs.renameSync(WEBM, BAK);

    const w = new BrowserWindow({
      show: false, width: 460, height: 520,
      webPreferences: { offscreen: true, preload: __dirname + '/pet-test-preload.cjs', contextIsolation: false },
    });
    await w.loadFile(path.join(ROOT, 'renderer', 'index.html'));
    const run = s => w.webContents.executeJavaScript(s);
    // 离屏窗口默认算隐藏，重试逻辑会因此跳过，这里强制当成可见
    await run(`(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { get: () => false });
      return true;
    })()`);

    const state = () => run(`(() => {
      const stage = document.querySelector('#petStage');
      const bubble = document.querySelector('#bubble');
      const status = document.querySelector('#petStatus').textContent;
      const earned = document.querySelector('#earnedText').textContent;
      const moneyBox = document.querySelector('#balanceMoney');
      return {
        stageHidden: stage.hidden,
        bubbleHidden: bubble.hidden,
        status,
        earned,
        moneyDigits: moneyBox ? moneyBox.querySelectorAll('span').length : 0,
        videosOn: [...document.querySelectorAll('video')].filter(v => v.dataset.on === 'true').length,
      };
    })()`);

    await sleep(7000);
    const broken = await state();
    console.log('  视频坏掉 7 秒后：', JSON.stringify(broken));
    assert.equal(broken.stageHidden, true, '视频坏了人物应该隐藏');
    assert.equal(broken.bubbleHidden, true, '人物隐藏时气泡不该浮着');
    assert.ok(broken.status.length > 0, '状态文字要照常');
    assert.ok(/^¥/.test(broken.earned), '今日入账要照常显示');
    assert.ok(broken.moneyDigits > 0, '鱼粮数字位要照常在');

    const money1 = broken.earned;
    await sleep(4000);
    const later = await state();
    assert.ok(later.status.length > 0 && /^¥/.test(later.earned), '面板数字要一直在');
    console.log(`  再过 4 秒：今日入账 ${money1} -> ${later.earned}，状态 ${later.status}`);

    // 等到超过 60 秒重试窗口，再多等一会儿让重试后的 4 秒加载超时走完，仍然要隐藏
    await sleep(60000);
    const afterRetry = await state();
    console.log('  60 秒重试之后（素材还是坏的）：', JSON.stringify(afterRetry));
    assert.equal(afterRetry.stageHidden, true, '重试仍然失败时人物继续隐藏');

    // 把素材放回去，等下一次重试窗口，人物应该回来
    restoreDir();
    let came = false;
    for (let i = 0; i < 70; i++) {
      await sleep(1000);
      const s = await state();
      if (!s.stageHidden && s.videosOn > 0) { came = true; console.log(`  素材恢复后第 ${i + 1} 秒人物回来了`); break; }
    }
    assert.ok(came, '素材恢复后人物应该在 60 秒内回来');

    console.log('PASS: 视频失败 → 人物隐藏、气泡收起、数字照常；恢复后自动回来');
    ok = true;
  } catch (e) {
    console.error(e);
  } finally {
    restoreDir();
    app.exit(ok ? 0 : 1);
  }
});
