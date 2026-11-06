/*
 * 桌面版挂件：外观与 DS Bot 里的 dsh-salary-meter 挂件保持一致，
 * 区别只是账本由 Rust 侧直接扫 DS Bot 的会话日志算出来，不依赖插件。
 */
(function () {
  'use strict';

  const DEF = { salary: 5000, days: 22, start: '09:00', end: '18:00', lunch: 1, weekend: false, theme: 'dark', expanded: false };

  const PALETTES = {
    dark: { '--sm-bg': '#232324', '--sm-text': '#e9ebf2', '--sm-muted': '#9398a6', '--sm-line': '#ffffff17', '--dsw-specific-bubble': '#34436c', '--sm-blue': '#8398ff' },
    light: { '--sm-bg': '#f7f8fa', '--sm-text': '#1f2329', '--sm-muted': '#6b7280', '--sm-line': '#00000014', '--dsw-specific-bubble': '#dfe7f7', '--sm-blue': '#4c6ef5' },
    gold: { '--sm-bg': '#1f1a13', '--sm-text': '#d6b36a', '--sm-muted': '#9c8a63', '--sm-line': '#ffffff14', '--dsw-specific-bubble': '#3a2f1d', '--sm-blue': '#c9a227' },
  };

  const MESSAGES = {
    idle: '再吃一口就收工。', scoop: '饭钱到账，开饭。', bite: '我就吃一小口。', chew: '嚼嚼嚼…',
    peek: '你还在忙呀？', caught: '饭自己跑嘴里的。', wipe: '一点都没浪费。', full: '今天也吃饱啦。',
    sleep: '抱着饭碗歇一会儿…',
  };

  const pick = id => document.getElementById(id);
  const el = {
    widget: pick('widget'),
    statusTitle: pick('statusTitle'),
    clock: pick('clockText'),
    prefix: pick('balancePrefix'),
    value: pick('balanceValue'),
    toggle: pick('toggleBtn'),
    countdown: pick('countdownText'),
    compactExpense: pick('expenseCompact'),
    bar: pick('progressBar'),
    earned: pick('earnedText'),
    spent: pick('spentText'),
    expenseLabel: pick('expenseLabel'),
    bubble: pick('bubble'),
    canvas: pick('mascotCanvas'),
    fallbackImg: pick('mascotImg'),
    mascotBtn: pick('mascotBtn'),
    settingsBtn: pick('settingsBtn'),
    errorBox: pick('errorBox'),
    settingsLayer: pick('settingsLayer'),
    settingsFrame: pick('settingsFrame'),
    settingsClose: pick('settingsClose'),
  };

  // 直接用浏览器打开预览时也能跑
  const api = window.api || {
    getState: function () {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem('salary-widget-cfg') || '{}'); } catch (e) {}
      return Promise.resolve({
        config: Object.assign({}, DEF, saved),
        today: { expense: 0, known: 0, unknown: 0 },
        prices: { source: '内置', count: 0 },
        sessions: 0, updated: Date.now(),
      });
    },
    setExpanded: function (expanded) {
      try {
        var saved = JSON.parse(localStorage.getItem('salary-widget-cfg') || '{}');
        saved.expanded = !!expanded;
        localStorage.setItem('salary-widget-cfg', JSON.stringify(saved));
      } catch (e) {}
      return Promise.resolve(null);
    },
    onConfig: function () {},
    openSettings: function () {},
  };

  let cfg = Object.assign({}, DEF);
  let today = { expense: 0, known: 0, unknown: 0 };
  let expanded = false;
  let mascot = null;
  let mascotTries = 0;
  let toggleGuardUntil = 0;
  let action = 'idle';
  let caughtUntil = 0;
  let busyUntil = 0;
  let lastExpense = 0;

  /* ------------------------------------------------------------ 小工具 */

  const pad = n => (n < 10 ? '0' + n : '' + n);
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };

  function money(v) {
    const s = Math.abs(v).toFixed(2).split('.');
    return group(s[0]) + '.' + s[1];
  }

  function hm(value) {
    const parts = String(value || '').split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    return (isFinite(h) ? h : 0) * 3600 + (isFinite(m) ? m : 0) * 60;
  }

  function duration(sec) {
    const value = Math.max(0, Math.ceil(sec));
    return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(pad).join(':');
  }

  /* -------------------------------------------------------------- 算工资 */

  function computeWage(now) {
    const start = hm(cfg.start);
    const end = hm(cfg.end);
    const lunch = num(cfg.lunch, 0) * 3600;
    const workSeconds = end - start - lunch;
    const lunchStart = Math.max(start, Math.min(12 * 3600, end - lunch));
    const clock = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
    const weekday = now.getDay();
    const rest = !cfg.weekend && (weekday === 0 || weekday === 6);
    const elapsed = Math.max(0, Math.min(clock, end) - start);
    const lunchElapsed = Math.max(0, Math.min(lunch, clock - lunchStart));
    const billable = rest ? 0 : Math.max(0, Math.min(workSeconds, elapsed - lunchElapsed));
    const perSecond = workSeconds > 0 ? num(cfg.salary, 0) / Math.max(1, num(cfg.days, 22)) / workSeconds : 0;

    let status = '上 班 中';
    let countdownLabel = '距下班';
    let countdownSeconds = Math.max(0, end - clock);
    if (rest) {
      status = '休 息 日';
      countdownLabel = '今天休息';
      countdownSeconds = 0;
    } else if (clock < start) {
      status = '未 开 工';
      countdownLabel = '距开工';
      countdownSeconds = start - clock;
    } else if (clock >= end) {
      status = '已 收 工';
      countdownLabel = '今日已收工';
      countdownSeconds = 0;
    } else if (lunch > 0 && clock >= lunchStart && clock < lunchStart + lunch) {
      status = '午 休 中';
    }

    return {
      earned: billable * perSecond,
      progress: workSeconds > 0 ? billable / workSeconds : 0,
      status, countdownLabel, countdownSeconds, rest,
      before: clock < start, after: clock >= end,
    };
  }

  /* ------------------------------------------------------------ 画界面 */

  function applyTheme() {
    const palette = PALETTES[cfg.theme] || PALETTES.dark;
    const style = el.widget.style;
    for (const key of Object.keys(palette)) style.setProperty(key, palette[key]);
    el.widget.dataset.theme = PALETTES[cfg.theme] ? cfg.theme : 'dark';
  }

  function applyExpanded() {
    el.widget.dataset.expanded = expanded ? 'true' : 'false';
    el.toggle.textContent = expanded ? '收起 ⌄' : '展开 ⌃';
    el.toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    el.toggle.setAttribute('aria-label', expanded ? '收起人物' : '展开人物');
    if (expanded) {
      // 窗口要等 Rust 那边改完高度再建画布，否则 WebView 一变形 WebGL 上下文就可能丢
      setTimeout(() => { if (expanded) ensureMascot(); }, 260);
    } else {
      disposeMascot();
    }
  }

  function paint() {
    const now = new Date();
    const wage = computeWage(now);
    const partial = today.unknown > 0;
    const amount = wage.earned - today.expense;

    el.statusTitle.textContent = '碗里还剩';
    el.statusTitle.title = wage.status.replace(/\s/g, '');
    el.clock.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

    const text = money(Math.abs(amount));
    el.prefix.textContent = (partial ? '≤ ¥' : '≈ ¥');
    el.value.textContent = text;
    el.value.style.setProperty('--sm-digits', text.length);

    el.countdown.innerHTML = wage.countdownSeconds > 0
      ? wage.countdownLabel + ' <b>' + duration(wage.countdownSeconds) + '</b>'
      : '<b>' + wage.countdownLabel + '</b>';

    el.bar.value = Math.max(0, Math.min(1, wage.progress));

    el.earned.textContent = '¥' + money(wage.earned);
    el.expenseLabel.textContent = partial ? '偷吃估算（有遗漏）' : '今日肥鱼偷吃（估算）';
    el.spent.textContent = (partial ? '≥' : '−') + ' ¥' + expenseText();
    el.compactExpense.textContent = (expanded ? '' : '偷吃 ' + (partial ? '≥' : '≈') + '¥' + expenseText());

    if (expanded) {
      const pose = performance.now() < caughtUntil ? 'caught' : null;
      el.bubble.textContent = pose === 'caught' ? MESSAGES.caught : (MESSAGES[action] || MESSAGES.idle);
    }

    if (mascot) mascot.setBusy(Date.now() < busyUntil);
  }

  function expenseText() {
    const value = today.expense;
    return value > 0 && value < 0.01 ? value.toFixed(4) : money(value);
  }

  function showError(message) {
    if (!message) {
      el.errorBox.hidden = true;
      el.errorBox.textContent = '';
      return;
    }
    el.errorBox.hidden = false;
    el.errorBox.textContent = message;
  }

  /* -------------------------------------------------------------- 人物 */

  async function ensureMascot() {
    if (mascot || !expanded) return;
    try {
      const module = await import('./assets/mascot.mjs');
      if (!expanded || mascot) return;
      const controller = await module.createWhaleAnimation(el.canvas, {
        onAction: value => { action = value; paint(); },
        onError: () => mascotFailed(),
      });
      if (!expanded || mascot) {
        if (controller) controller.dispose();
        return;
      }
      mascot = controller;
      mascotTries = 0;
      el.canvas.hidden = false;
      el.fallbackImg.hidden = true;
      mascot.setBusy(Date.now() < busyUntil);
    } catch (error) {
      mascotFailed();
    }
  }

  // WebGL 上下文丢了（窗口变形、驱动回收）就换一块新画布重来，实在不行退回静态图
  function mascotFailed() {
    mascot = null;
    el.canvas.hidden = true;
    el.fallbackImg.hidden = false;
    if (!expanded) return;
    if (mascotTries >= 5) return;
    mascotTries += 1;
    const stale = el.canvas;
    const fresh = stale.cloneNode(false);
    fresh.removeAttribute('data-action');
    stale.replaceWith(fresh);
    el.canvas = fresh;
    setTimeout(() => { if (expanded && !mascot) ensureMascot(); }, 400 * mascotTries);
  }

  function disposeMascot() {
    if (mascot) {
      mascot.dispose();
      mascot = null;
    }
    mascotTries = 0;
    el.canvas.hidden = false;
    el.fallbackImg.hidden = true;
  }

  /* -------------------------------------------------------------- 事件 */

  el.toggle.addEventListener('click', async () => {
    const next = !expanded;
    expanded = next;
    // 刚点完别让正在路上的轮询把状态又翻回去
    toggleGuardUntil = Date.now() + 2500;
    applyExpanded();
    paint();
    try { await api.setExpanded(next); } catch (error) { showError('窗口尺寸保存失败'); }
  });

  el.settingsBtn.addEventListener('click', () => openSettings());

  el.settingsClose.addEventListener('click', () => closeSettings());

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el.settingsLayer.hidden) closeSettings();
  });

  function trace(event) {
    window.__events = window.__events || [];
    window.__events.push(new Date().toTimeString().slice(0, 8) + ' ' + event);
    if (window.__events.length > 40) window.__events.shift();
  }

  function openSettings() {
    if (!el.settingsLayer.hidden) return;
    trace('open');
    if (!el.settingsFrame.getAttribute('src').includes('settings.html')) {
      el.settingsFrame.setAttribute('src', 'settings.html');
    }
    el.settingsLayer.hidden = false;
    el.mascotBtn.blur();
    try { api.setMode('settings'); } catch (error) { /* 尺寸改不动也照样能用 */ }
  }

  function closeSettings() {
    if (el.settingsLayer.hidden) return;
    trace('close @ ' + (new Error().stack || '').split('\n').slice(1, 3).join(' | '));
    el.settingsLayer.hidden = true;
    try { api.setMode('widget'); } catch (error) { /* ignore */ }
  }

  el.mascotBtn.addEventListener('click', () => {
    caughtUntil = performance.now() + 2500;
    if (mascot) mascot.catch();
    paint();
  });

  if (api.onConfig) {
    api.onConfig(next => {
      if (!next) return;
      cfg = Object.assign({}, DEF, next);
      applyTheme();
      applyExpanded();
      paint();
    });
  }

  if (api.onOpenSettings) api.onOpenSettings(() => openSettings());

  /* -------------------------------------------------------------- 同步 */

  let refreshing = false;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const state = await api.getState();
      if (state) {
        cfg = Object.assign({}, DEF, state.config || cfg);
        today = state.today || { expense: 0, known: 0, unknown: 0 };
        if (today.expense > lastExpense + 1e-9) busyUntil = Date.now() + 5000;
        lastExpense = today.expense;
        applyTheme();
        if (Date.now() > toggleGuardUntil && !!cfg.expanded !== expanded) {
          expanded = !!cfg.expanded;
          applyExpanded();
        }
        paint();
        showError('');
      }
    } catch (error) {
      showError('工资信息暂时读不到');
    } finally {
      refreshing = false;
    }
  }

  applyTheme();
  applyExpanded();
  paint();
  setInterval(paint, 100);
  refresh();
  setInterval(refresh, 3000);
})();
