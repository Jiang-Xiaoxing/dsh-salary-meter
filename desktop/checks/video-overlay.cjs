// 两个 <video> 不能同时显示（会叠成两张画面：一张静态图盖在动画前面）。
// 跑法：node_modules\electron\dist\electron.exe checks\video-overlay.cjs
//
// 2026-11-09 用户录屏里出现「动画外面蒙上一张静态图片」：
//   working.webm 第 0 秒是站着垂手、没有零食，第 1~5 秒是坐着吃零食。
//   录屏里两样同时出现，说明两个播放器都开着：一个在播，另一个停在最后一帧。
// 这里盯三件事：
//   1) 任何一刻 data-on='true' 的 video 不能超过 1 个
//   2) 「重启人物」（配置里 character 变一次）之后也不能出现两个可见层
//   3) 跑完两个片尾周期后，只有一个层不透明（另一个真的停了）
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');

app.setPath('userData', 'D:/AITools/tmp/salary-video-overlay');
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

    const snapExpr = `(() => [...document.querySelectorAll('video')].map(v => ({
      id: v.id, on: v.dataset.on, op: +(+getComputedStyle(v).opacity).toFixed(3),
      t: +v.currentTime.toFixed(2), paused: v.paused, ended: v.ended,
      src: (v.getAttribute('src') || '').split('/').pop()
    })))()`;

    const bad = [];
    let samples = 0;
    let maxVisible = 0;

    async function sample(tag) {
      const snap = await run(snapExpr);
      samples++;
      const visible = snap.filter(v => v.on === 'true');
      if (visible.length > maxVisible) maxVisible = visible.length;
      if (visible.length > 1) {
        bad.push(`${tag} 同时可见 ${visible.length} 个 → ` + snap.map(v => `${v.id}:on=${v.on},t=${v.t},paused=${v.paused},src=${v.src}`).join(' | '));
      }
      return snap;
    }

    // 1) 正常播 3 秒
    for (let i = 0; i < 12; i++) { await sample('正常'); await sleep(250); }

    // 2) 触发一次「人物重启」：改 character 会走 applyCharacter → startCharacter
    await run(`window.api.setConfig({character:'atlas'})`);
    for (let i = 0; i < 12; i++) { await sample('重启A'); await sleep(250); }
    await run(`window.api.setConfig({character:'webm'})`);
    for (let i = 0; i < 12; i++) { await sample('重启B'); await sleep(250); }

    // 3) 再跑 22 秒，跨两个片尾（每段 10.04 秒）
    for (let i = 0; i < 88; i++) { await sample('片尾'); await sleep(250); }

    const final = await run(snapExpr);
    const logs = await run('window.__wlog || []');

    console.log(`采样 ${samples} 次，最多同时可见 ${maxVisible} 个 video`);
    console.log('最终状态: ' + final.map(v => `${v.id} on=${v.on} op=${v.op} t=${v.t} paused=${v.paused} src=${v.src}`).join(' | '));
    console.log(`日志 ${logs.length} 条:`);
    for (const line of logs.slice(-14)) console.log('  ' + line);

    assert.equal(bad.length, 0, '出现过多个视频层同时可见:\n' + bad.slice(0, 6).join('\n'));
    assert.ok(logs.some(l => l.startsWith('显示 ')), '日志里应该有「显示」记录');
    assert.ok(logs.some(l => l.startsWith('片尾 ')), '日志里应该有「片尾」记录');
    assert.ok(logs.some(l => l.startsWith('人物启动')), '日志里应该有「人物启动」记录');
    const opaque = final.filter(v => v.op > 0.5);
    assert.equal(opaque.length, 1, `跑完后应该只有一个层不透明，实际 ${opaque.length} 个`);

    console.log('PASS 任何时刻最多一个视频层可见，片尾和重启都没留残影');
    app.exit(0);
  } catch (error) {
    console.error('FAIL ' + (error && error.message ? error.message : error));
    app.exit(1);
  }
});
