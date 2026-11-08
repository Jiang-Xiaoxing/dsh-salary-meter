// 真实播放的回归检查（需要 electron）：node_modules\electron\dist\electron.exe checks\scene-loop.cjs
// 验证新调度没有把循环弄坏：video 不再 loop，片尾由 ended 回调重播，画面不能停住。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');

app.setPath('userData', 'D:/AITools/tmp/salary-scene-loop');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({
      show: false, width: 460, height: 520,
      webPreferences: { offscreen: true, preload: __dirname + '/pet-test-preload.cjs', contextIsolation: false },
    });
    // 窗口不可见时浏览器会故意不播放视频，这里强制当成可见
    Object.defineProperty(w.webContents, 'visibilityState', { get: () => 'visible' });
    await w.loadFile(path.join(__dirname, '../renderer/index.html'));
    await sleep(2500);
    const run = s => w.webContents.executeJavaScript(s);

    const setup = await run(`(() => {
      const v = [...document.querySelectorAll('video')].find(x => x.dataset.on === 'true');
      return v ? { loop: v.loop, t: v.currentTime, paused: v.paused } : null;
    })()`);
    assert.ok(setup, '应该已经有一段视频在播');

    // 取消 loop 后，片尾要靠 ended 回调重播：采样 12 秒，currentTime 必须出现过回绕
    const samples = [];
    for (let i = 0; i < 24; i++) {
      const s = await run(`(() => {
        const v = [...document.querySelectorAll('video')].find(x => x.dataset.on === 'true');
        return v ? { t: v.currentTime, paused: v.paused, loop: v.loop } : null;
      })()`);
      if (s) samples.push(s);
      await sleep(500);
    }
    assert.ok(samples.length > 20, '采样数量不足');
    assert.equal(samples[0].loop, false, 'video 不该再是 loop');
    assert.ok(samples.every(s => s.paused === false), '播放中不该暂停');

    let wrapped = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].t + 0.3 < samples[i - 1].t) wrapped++;
    }
    assert.ok(wrapped >= 1, `12 秒里应该至少回绕一次（实际 ${wrapped} 次）`);

    // 回绕之后还要继续往前播，不能停在 0
    const last = samples[samples.length - 1];
    assert.ok(last.t > 0.2, `回绕后应该继续播放，实际停在 ${last.t}`);

    console.log(`PASS: 片尾重播正常（回绕 ${wrapped} 次，末次 ${last.t.toFixed(2)}s，loop=${samples[0].loop}）`);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
