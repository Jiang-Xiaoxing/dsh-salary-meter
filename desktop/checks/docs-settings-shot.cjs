/* 重新生成 README 用的设置页截图（docs/settings.png）。
   读数是合成数据，只为展示四格布局；不写任何产品代码。 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.setPath('userData', 'D:/AITools/tmp/salary-docs-shot');

const SAMPLE = {
  month_start_ms: 1793462400000,
  total: 144041652,
  tokens: { input: 130886293, output: 13155359, cache_read: 5545466751, cache_write: 0, events: 18662 },
  files: 101,
  files_with_events: 83,
  failed: 0,
};

const preload = path.join(__dirname, 'docs-preload.cjs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 500, height: 980,
    webPreferences: {
      offscreen: true, sandbox: false, contextIsolation: false,
      preload,
    },
  });
  const run = (s) => win.webContents.executeJavaScript(s);

  await win.loadFile(path.join(__dirname, '../renderer/settings.html'));
  // 切浅白主题：README 里这张就是浅白的
  await run(`document.body.dataset.settingsTheme='light'`);
  await new Promise((r) => setTimeout(r, 900));
  // 等本月那格真的填上，别截到「—」
  for (let i = 0; i < 40; i++) {
    const t = await run(`document.querySelector('#monthTokens').textContent`);
    if (t && t !== '—') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 300));
  // 滚到底，让四格和页脚都在画面里
  await run(`document.querySelector('.stats').scrollIntoView({block:'center'})`);
  await new Promise((r) => setTimeout(r, 300));

  const shot = await win.webContents.capturePage();
  const out = path.join(__dirname, 'docs-settings-preview.png');
  fs.writeFileSync(out, shot.toPNG());
  console.log('写成：' + out, shot.getSize());
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
