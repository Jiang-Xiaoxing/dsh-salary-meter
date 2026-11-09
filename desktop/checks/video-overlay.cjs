// 两个 <video> 不能同时显示（会叠成两张画面：一张静态图盖在动画前面）。
// 跑法：node_modules\electron\dist\electron.exe checks\video-overlay.cjs
//
// 2026-11-09 用户录屏里出现「动画外面蒙上一张静态图片」：
//   working.webm 第 0 秒是站着垂手、没有零食，第 1~5 秒是坐着吃零食。
//   录屏里两样同时出现，说明两个播放器都开着：一个在播，另一个停在最后一帧。
//
// Codex 审查后补强：光靠 250ms 采样会漏掉短暂重叠，改成 MutationObserver 盯每一次
// data-on 变化；另外断言启动只发生一次、没有 WARN。
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

    // 任何一次 data-on 变化都检查一遍，不靠采样
    await run(`(() => {
      window.__overlayBad = [];
      const vids = [...document.querySelectorAll('video')];
      for (const v of vids) {
        new MutationObserver(() => {
          const on = vids.filter(x => x.dataset.on === 'true');
          if (on.length > 1) {
            window.__overlayBad.push({ t: Math.round(performance.now()), n: on.length, ids: on.map(x => x.id) });
          }
        }).observe(v, { attributes: true, attributeFilter: ['data-on'] });
      }
      return true;
    })()`);

    const snapExpr = `(() => [...document.querySelectorAll('video')].map(v => ({
      id: v.id, on: v.dataset.on, op: +(+getComputedStyle(v).opacity).toFixed(3),
      t: +v.currentTime.toFixed(2), paused: v.paused, ended: v.ended,
      src: (v.getAttribute('src') || '').split('/').pop()
    })))()`;

    let samples = 0;
    async function sample(tag) {
      const snap = await run(snapExpr);
      samples++;
      return snap;
    }

    // 1) 正常播 3 秒，顺手记下启动阶段的日志
    for (let i = 0; i < 15; i++) { await sample('正常'); await sleep(200); }
    const bootLogs = await run('window.__wlog || []');
    const bootStarts = bootLogs.filter(l => l.startsWith('人物启动')).length;
    const bootClips = bootLogs.filter(l => l.startsWith('切片段')).length;
    console.log(`启动阶段：人物启动 ${bootStarts} 次、切片段 ${bootClips} 次`);
    assert.equal(bootStarts, 1, `启动应该只启动一次人物，实际 ${bootStarts} 次`);
    assert.equal(bootClips, 1, `启动应该只切一次片段，实际 ${bootClips} 次`);

    // 2) 触发一次「人物重启」：改 character 会走 applyCharacter → startCharacter
    await run(`window.api.setConfig({character:'atlas'})`);
    for (let i = 0; i < 12; i++) { await sample('重启A'); await sleep(200); }
    await run(`window.api.setConfig({character:'webm'})`);
    for (let i = 0; i < 12; i++) { await sample('重启B'); await sleep(200); }

    // 3) 再跑 22 秒，跨两个片尾（每段 10.04 秒）
    for (let i = 0; i < 88; i++) { await sample('片尾'); await sleep(250); }

    const final = await run(snapExpr);
    const logs = await run('window.__wlog || []');
    const overlayBad = await run('window.__overlayBad || []');

    console.log(`采样 ${samples} 次，data-on 变化里出现多层的次数 ${overlayBad.length}`);
    if (overlayBad.length) console.log('  ' + JSON.stringify(overlayBad.slice(0, 5)));
    console.log('最终状态: ' + final.map(v => `${v.id} on=${v.on} op=${v.op} t=${v.t} paused=${v.paused} src=${v.src}`).join(' | '));
    console.log(`日志 ${logs.length} 条，WARN ${logs.filter(l => l.includes('WARN')).length} 条`);

    assert.equal(overlayBad.length, 0, '出现过多个视频层同时可见: ' + JSON.stringify(overlayBad.slice(0, 6)));
    assert.equal(logs.filter(l => l.includes('WARN')).length, 0, '日志里不该有 WARN');
    assert.ok(logs.some(l => l.startsWith('显示 ')), '日志里应该有「显示」记录');
    assert.ok(logs.some(l => l.startsWith('片尾 ')), '日志里应该有「片尾」记录');
    const ends = logs.filter(l => l.startsWith('片尾')).length;
    assert.ok(ends >= 2, `22 秒里应该至少跨两次片尾，实际 ${ends}`);

    const opaque = final.filter(v => v.op > 0.5);
    assert.equal(opaque.length, 1, `跑完后应该只有一个层不透明，实际 ${opaque.length} 个`);
    const hiddenPaused = final.filter(v => v.on !== 'true');
    assert.ok(hiddenPaused.every(v => v.paused), '隐藏的那一层应该停住，不能还在后台播');

    console.log('PASS 任何时刻最多一个视频层可见，片尾和重启都没留残影');
    app.exit(0);
  } catch (error) {
    console.error('FAIL ' + (error && error.message ? error.message : error));
    app.exit(1);
  }
});
