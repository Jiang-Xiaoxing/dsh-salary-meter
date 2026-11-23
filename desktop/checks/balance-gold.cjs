// 用户 2026-11-21 定：「鱼粮 + 金额 + 右边状态」整行都是金色，三种配色都要金。
// 逐主题取三处的计算色 + 实际不透明度，按各自的底色算对比度，并截图留证。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

app.setPath('userData', path.join(app.getPath('temp'), 'salary-balance-gold'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每个主题真正的底板色（从 widget.js 的 PALETTES 抄来，用作对比度基准）
const THEME_BG = {
  dark: { r: 32, g: 44, b: 61 },    // --sm-bg #202c3d
  light: { r: 255, g: 255, b: 255 }, // --sm-bg #ffffff
  gold: { r: 40, g: 35, b: 29 }      // --sm-bg #28231d
};

function parseRgb(value) {
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map(v => parseFloat(v.trim()));
  return { r: parts[0], g: parts[1], b: parts[2] };
}

// 金色判据：红通道最高，绿适中，蓝明显最低（暖色、偏黄）
function looksGold(rgb) {
  if (!rgb) return false;
  return rgb.r > rgb.g && rgb.g > rgb.b && (rgb.r - rgb.b) >= 40;
}

// WCAG 相对亮度
function luminance({ r, g, b }) {
  const chan = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({
      show: false, frame: false, width: 440, height: 500,
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'pet-test-preload.cjs'), contextIsolation: false }
    });
    await w.loadFile(path.join(__dirname, '../renderer/index.html'));
    const run = s => w.webContents.executeJavaScript(s);
    await sleep(2000);

    const out = process.env.SALARYMETER_CHECKS_DIR || app.getPath('userData');
    fs.mkdirSync(out, { recursive: true });
    const report = {};
    for (const theme of ['dark', 'light', 'gold']) {
      await run(`api.setConfig({theme:'${theme}', expanded:true}); document.body.style.background = 'rgb(${THEME_BG[theme].r}, ${THEME_BG[theme].g}, ${THEME_BG[theme].b})'`);
      await sleep(300);

      // 不透明度沿父链相乘：某个祖先只要透明度 <1，实际看到的颜色就被冲淡
      const colors = await run(`(() => {
        const pick = s => { const el = document.querySelector(s); return el ? getComputedStyle(el).color : null; };
        const effOpacity = s => {
          let el = document.querySelector(s), o = 1;
          while (el && el.nodeType === 1) { o *= parseFloat(getComputedStyle(el).opacity || '1'); el = el.parentElement; }
          return Math.round(o * 1000) / 1000;
        };
        return {
          label: pick('#balanceLabel'),
          money: pick('#balanceMoney'),
          status: pick('#petStatus'),
          labelOpacity: effOpacity('#balanceLabel'),
          moneyOpacity: effOpacity('#balanceMoney'),
          statusOpacity: effOpacity('#petStatus'),
          theme: document.querySelector('#widget').dataset.theme
        };
      })()`);

      assert.equal(colors.theme, theme, `${theme}：data-theme 没跟上`);

      // 三处文字色必须完全一致：整行统一，不能只有数字变金
      assert.equal(colors.label, colors.money, `${theme}：鱼粮 与 金额 颜色不一致`);
      assert.equal(colors.money, colors.status, `${theme}：金额 与 状态文字 颜色不一致`);

      // 三处不透明度必须都是 1，否则实际看到的颜色被冲淡、跟旁边不是一个色
      for (const key of ['label', 'money', 'status']) {
        assert.equal(colors[`${key}Opacity`], 1, `${theme}：${key} 实际不透明度不是 1，颜色会被冲淡`);
      }

      const rgb = parseRgb(colors.money);
      assert.ok(looksGold(rgb), `${theme}：不是金色，实际是 ${colors.money}`);

      // 按各自底色算对比度：普通文字门槛 4.5:1
      const bg = THEME_BG[theme];
      const ratio = contrast(rgb, bg);
      assert.ok(ratio >= 4.5, `${theme}：底色上对比度只有 ${ratio.toFixed(2)}:1，低于 4.5:1`);

      report[theme] = { ...colors, bg, rgb, contrast: Number(ratio.toFixed(2)) };

      fs.writeFileSync(path.join(out, `balance-gold-${theme}.png`), (await w.webContents.capturePage()).toPNG());
    }

    console.log(JSON.stringify(report, null, 2));
    console.log('PASS: 三主题下「鱼粮 + 金额 + 状态」整行同色、不透明、为金色，且对比度达标');
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
