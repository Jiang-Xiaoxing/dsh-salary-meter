'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const WIN_W = 348;
const WIN_H = 164;

const DEFAULTS = {
  salary: 10000,
  days: 22,
  start: '09:00',
  end: '18:00',
  lunch: 1,
  weekend: false,
  theme: 'dark'
};

let widgetWin = null;
let settingsWin = null;
let tray = null;
let cfg = Object.assign({}, DEFAULTS);
let topMost = true;
let clickThrough = false;
let quitting = false;

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const posFile = () => path.join(app.getPath('userData'), 'position.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJSON(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch (e) { /* 静默：写盘失败不影响运行 */ }
}

function loadCfg() {
  const saved = readJSON(cfgFile(), null);
  cfg = Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
}

function pushCfg() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('cfg:changed', cfg);
  }
}

function commitCfg(patch) {
  if (!patch || typeof patch !== 'object') return;
  cfg = Object.assign({}, cfg, patch);
  writeJSON(cfgFile(), cfg);
  pushCfg();
}

/* ---------------- 挂件窗口 ---------------- */

function createWidget() {
  const work = screen.getPrimaryDisplay().workArea;
  const saved = readJSON(posFile(), null);

  let x = saved && Number.isFinite(saved.x) ? saved.x : work.x + work.width - WIN_W - 48;
  let y = saved && Number.isFinite(saved.y) ? saved.y : work.y + work.height - WIN_H - 48;

  // 换过显示器也要保证它还看得见
  const disp = screen.getDisplayNearestPoint({ x: x + WIN_W / 2, y: y + WIN_H / 2 });
  const wa = disp.workArea;
  x = Math.min(Math.max(x, wa.x - WIN_W + 90), wa.x + wa.width - 90);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - 48);

  widgetWin = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  widgetWin.setAlwaysOnTop(true, 'floating');
  widgetWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  widgetWin.once('ready-to-show', () => widgetWin.show());

  widgetWin.on('moved', () => {
    if (!widgetWin || widgetWin.isDestroyed()) return;
    const [px, py] = widgetWin.getPosition();
    writeJSON(posFile(), { x: px, y: py });
  });

  widgetWin.on('closed', () => { widgetWin = null; });
}

/* ---------------- 设置窗口 ---------------- */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 466,
    height: 700,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '计价器 · 参数',
    backgroundColor: '#EDE9DF',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ---------------- 菜单 ---------------- */

function setTopMost(on) {
  topMost = !!on;
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.setAlwaysOnTop(topMost, 'floating');
}

function setClickThrough(on) {
  clickThrough = !!on;
  if (!widgetWin || widgetWin.isDestroyed()) return;
  widgetWin.setIgnoreMouseEvents(clickThrough, { forward: true });
  widgetWin.webContents.send('ui:passthrough', clickThrough);
}

// 源码方式运行时，登录项必须带上应用目录，否则开机只会拉起一个空的 Electron
function setLogin(openAtLogin) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!openAtLogin,
      path: process.execPath,
      args: [path.resolve(__dirname)]
    });
  } catch (e) { /* ignore */ }
}

function buildMenu() {
  const login = app.getLoginItemSettings().openAtLogin;

  return Menu.buildFromTemplate([
    { label: '参数设置…', click: openSettings },
    { type: 'separator' },
    {
      label: '浅白外观',
      type: 'checkbox',
      checked: cfg.theme === 'light',
      click: (item) => commitCfg({ theme: item.checked ? 'light' : 'dark' })
    },
    { label: '始终置顶', type: 'checkbox', checked: topMost, click: (item) => setTopMost(item.checked) },
    {
      label: '鼠标穿透（挂件不挡点击）',
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => setClickThrough(item.checked)
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: login,
      click: (item) => setLogin(item.checked)
    },
    { type: 'separator' },
    { label: '退出计价器', click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let img = null;
  try { img = nativeImage.createFromPath(iconPath); } catch (e) { img = null; }
  if (!img || img.isEmpty()) return;

  tray = new Tray(img);
  tray.setToolTip('计价器');
  tray.on('click', () => {
    if (!widgetWin) createWidget();
    else { widgetWin.show(); widgetWin.focus(); }
  });
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

/* ---------------- IPC ---------------- */

ipcMain.handle('cfg:get', () => cfg);
ipcMain.on('cfg:set', (_e, patch) => commitCfg(patch));
ipcMain.on('ui:settings', openSettings);
ipcMain.on('ui:close-settings', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); });
ipcMain.on('ui:menu', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) buildMenu().popup({ window: win });
});
ipcMain.handle('app:login', () => app.getLoginItemSettings().openAtLogin);
ipcMain.on('app:set-login', (_e, v) => setLogin(v));

/* ---------------- 生命周期 ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (widgetWin && !widgetWin.isDestroyed()) { widgetWin.show(); widgetWin.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.local.salarywidget');
    loadCfg();
    createWidget();
    createTray();

    // 自检：SW_CAPTURE=<png 路径> 时导出挂件画面并退出，用于构建期核对
    if (process.env.SW_CAPTURE) {
      setTimeout(async () => {
        const out = process.env.SW_CAPTURE;
        try {
          const img = await widgetWin.capturePage();
          fs.writeFileSync(out, img.toPNG());

          if (process.env.SW_SELFTEST) {
            openSettings();
            await new Promise(r => setTimeout(r, 1500));

            const before = await widgetWin.webContents.executeJavaScript(
              "document.getElementById('intPart').textContent"
            );

            // 在设置窗口里改月薪，验证是否实时同步到挂件
            await settingsWin.webContents.executeJavaScript(
              "var s=document.querySelector('#salary');s.value='20000';" +
              "s.dispatchEvent(new Event('input',{bubbles:true}));'ok'"
            );
            await new Promise(r => setTimeout(r, 600));

            const after = await widgetWin.webContents.executeJavaScript(
              "document.getElementById('intPart').textContent"
            );

            fs.writeFileSync(out + '.sync.log', 'before=' + before + ' after=' + after);

            const sImg = await settingsWin.capturePage();
            fs.writeFileSync(out.replace(/\.png$/, '-settings.png'), sImg.toPNG());
          }
        } catch (e) {
          try { fs.writeFileSync(out + '.err.log', String((e && e.stack) || e)); } catch (_) {}
        }
        app.quit();
      }, 2000);
    }
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('window-all-closed', (e) => {
    // 挂件常驻，不随窗口关闭退出
    if (quitting) app.quit();
  });
}
