/*
 * 桌面版挂件：外观与 DS Bot 里的 dsh-salary-meter 挂件保持一致，
 * 区别只是账本由 Rust 侧直接扫 DS Bot 的会话日志算出来，不依赖插件。
 */
import { pickScene, sceneBubble, SCENE_FILES } from './pet-scenes.mjs';

(function () {
  'use strict';

  const DEF = { salary: 5000, days: 22, start: '09:00', end: '18:00', lunch: 1, weekend: false, restMode: 'double', theme: 'dark', character: 'webm', petScale: 130, expanded: false };

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
    balance: pick('balanceRow'),
    arrow: pick('balanceArrow'),
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
    petStage: pick('petStage'),
    videos: [pick('petVideoA'), pick('petVideoB')],
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
  let bubbleUntil = 0;
  let bubbleScene = null;
  let mascot = null;
  let mascotTries = 0;
  let mascotGeneration = 0;
  let mascotLoading = false;
  let toggleGuardUntil = 0;
  let action = 'idle';
  let caughtUntil = 0;
  let busyUntil = 0;
  let lastExpense = 0;
  let sceneCurrent = null;
  let activeVideo = 0;
  let sceneAttempt = 0;
  let videoTimer = null;
  let videoGuard = null;
  let videoBroken = false;
  let characterApplied = null;

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
  /* 休息制度：double 双休 / single 单休（只休周日）/ alternate 大小周（周六逢双周休）/ none 周末也上班 */
  function weekIndex(d) {
    const first = new Date(d.getFullYear(), 0, 1);
    const days = Math.floor((d - first) / 86400000);
    return Math.floor((days + first.getDay()) / 7);
  }
  function restOn(d) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) return false;
    // 老配置只有 weekend 布尔值，没写 restMode 时按它换算
    const mode = cfg.restMode || (cfg.weekend ? 'none' : 'double');
    if (mode === 'none') return false;
    if (mode === 'single') return wd === 0;
    if (mode === 'alternate') return wd === 0 || weekIndex(d) % 2 === 0;
    return true;
  }

  function computeWage(now) {
    const start = hm(cfg.start);
    const end = hm(cfg.end);
    const lunch = num(cfg.lunch, 0) * 3600;
    const workSeconds = end - start - lunch;
    const lunchStart = Math.max(start, Math.min(12 * 3600, end - lunch));
    const clock = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
    const weekday = now.getDay();
    const rest = restOn(now);
    const elapsed = Math.max(0, Math.min(clock, end) - start);
    const lunchElapsed = Math.max(0, Math.min(lunch, clock - lunchStart));
    const billable = rest ? 0 : Math.max(0, Math.min(workSeconds, elapsed - lunchElapsed));
    const perSecond = workSeconds > 0 ? num(cfg.salary, 0) / Math.max(1, num(cfg.days, 22)) / workSeconds : 0;

    let status = '上 班 中';
    let phase = 'working';
    let countdownLabel = '距下班';
    let countdownSeconds = Math.max(0, end - clock);
    if (rest) {
      status = '休 息 日';
      phase = 'rest';
      countdownLabel = '今天休息';
      countdownSeconds = 0;
    } else if (clock < start) {
      status = '未 开 工';
      phase = 'before';
      countdownLabel = '距开工';
      countdownSeconds = start - clock;
    } else if (clock >= end) {
      status = '已 收 工';
      phase = 'off';
      countdownLabel = '今日已收工';
      countdownSeconds = 0;
    } else if (lunch > 0 && clock >= lunchStart && clock < lunchStart + lunch) {
      status = '午 休 中';
      phase = 'lunch';
    }

    return {
      earned: billable * perSecond,
      progress: workSeconds > 0 ? billable / workSeconds : 0,
      status, phase, countdownLabel, countdownSeconds, rest,
      before: clock < start, after: clock >= end,
    };
  }

  /* ------------------------------------------------------------ 画界面 */

  function applyTheme() {
    const palette = PALETTES[cfg.theme] || PALETTES.dark;
    const style = el.widget.style;
    for (const key of Object.keys(palette)) style.setProperty(key, palette[key]);
    style.setProperty('--pet-scale', Math.max(80, Math.min(160, num(cfg.petScale, 130))) / 130);
    el.widget.dataset.theme = PALETTES[cfg.theme] ? cfg.theme : 'dark';
  }

  function applyExpanded() {
    el.widget.dataset.expanded = String(expanded);
    el.toggle.textContent = expanded ? '⌄' : '⌃';
    el.toggle.setAttribute('aria-expanded', String(expanded));
    el.toggle.setAttribute('aria-label', expanded ? '收起账目' : '展开账目');
    if (useVideo()) playScene(currentScene());
    else setTimeout(() => { if (!useVideo()) ensureMascot(); }, 260);
  }

  /* 余粮跳动：涨钱往上滚、扣钱往下滚；涨满 1 毛或一扣钱就亮色 + 箭头。
     用户 23:14 定：加钱像水滴（每分钱微跳、每毛一次绿闪），扣钱像刀切（立刻红闪）。
     代码审查（Astra）补的三处：跨天/隔夜休眠要重置基准、首屏真实数据到位前不触发动画、动画最短间隔。 */
  let lastAmount = null;
  let greenMark = null;
  let flashTimer = 0;
  let lastDay = '';
  let basisReady = false;
  let lastAnimAt = 0;

  function clearMoneyFx() {
    clearTimeout(flashTimer);
    flashTimer = 0;
    el.balance.classList.remove('up', 'down');
    el.value.classList.remove('roll-up', 'roll-down');
  }

  function bigFlash(dir, hold) {
    // 箭头字符由 JS 定住，撤掉 class 时保持最后的方向淡出，不会跳回 ▲
    el.arrow.textContent = dir === 'up' ? '▲' : '▼';
    el.balance.classList.remove('up', 'down');
    void el.balance.offsetWidth;
    el.balance.classList.add(dir);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.balance.classList.remove('up', 'down'), hold);
  }

  function tickMoney(amount, now) {
    const prev = lastAmount;
    lastAmount = amount;
    if (prev === null || !basisReady) { greenMark = amount; return; }
    const delta = amount - prev;
    if (Math.abs(delta) < 0.0005) return;

    el.value.classList.remove('roll-up', 'roll-down');
    void el.value.offsetWidth;
    el.value.classList.add(delta > 0 ? 'roll-up' : 'roll-down');

    if (delta < 0) {
      // 扣钱不节流——这次漏掉就永远补不回来了
      greenMark = amount;
      bigFlash('down', 2400);
      return;
    }
    // 涨钱才节流：paint 是 100ms 一次，金额涨得快的配置下别把 200ms 的滚动反复打断
    const stamp = performance.now();
    if (stamp - lastAnimAt < 140) return;
    lastAnimAt = stamp;
    if (greenMark === null || amount - greenMark >= 0.1) {
      greenMark = amount;
      bigFlash('up', 1600);
    }
  }

  function paint() {
    const now = new Date();
    const wage = computeWage(now);
    const partial = today.unknown > 0;
    const amount = wage.earned - today.expense;

    // 跨天（含隔夜休眠醒来）：工资归零是规则不是扣钱。每次都查，不能只在金额变化时查
    const dayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      lastAmount = null;
      greenMark = null;
      clearMoneyFx();
    }

    el.statusTitle.textContent = '今日账目';
    el.statusTitle.title = wage.status.replace(/\s/g, '');
    el.clock.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

    const negative = amount < 0;
    const text = money(Math.abs(amount));
    // 负号放在 ¥ 前面（−¥0.85），不要 ¥ −0.85
    el.prefix.textContent = (negative ? '−' : '') + (partial ? '≤ ¥' : '¥');
    const changed = el.value.textContent !== text;
    if (changed) {
      el.value.textContent = text;
      el.value.style.setProperty('--sm-digits', text.length);
    }
    // 文本没变也要跑一次：首屏真实数据和默认值一样时，基准还没建
    if (changed || lastAmount === null) tickMoney(amount, now);

    el.countdown.innerHTML = wage.countdownSeconds > 0
      ? wage.countdownLabel + ' <b>' + duration(wage.countdownSeconds) + '</b>'
      : '<b>' + wage.countdownLabel + '</b>';

    el.bar.value = Math.max(0, Math.min(1, wage.progress));

    el.earned.textContent = '¥' + money(wage.earned);
    el.expenseLabel.textContent = partial ? '偷吃估算（有遗漏）' : '今日肥鱼偷吃（估算）';
    el.spent.textContent = (partial ? '≥' : '−') + ' ¥' + expenseText();
    el.compactExpense.textContent = (expanded ? '' : '偷吃 ' + (partial ? '≥' : '≈') + '¥' + expenseText());

    {
      if (useVideo()) {
        const scene = pickScene({ phase: wage.phase, busy: Date.now() < busyUntil, caught: performance.now() < caughtUntil });
        if (bubbleScene !== scene) {
          bubbleScene = scene;
          bubbleUntil = performance.now() + 4500;
        }
        playScene(scene);
        el.bubble.textContent = sceneBubble(scene);
      } else {
        const pose = performance.now() < caughtUntil ? 'caught' : null;
        el.bubble.textContent = pose === 'caught' ? MESSAGES.caught : (MESSAGES[action] || MESSAGES.idle);
      }
    }

    el.bubble.hidden = performance.now() >= bubbleUntil;
    pick('petStatus').textContent = wage.status.replace(/\s/g, '');
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
    if (mascot || mascotLoading || useVideo()) return;
    const generation = mascotGeneration;
    mascotLoading = true;
    try {
      const module = await import('./assets/mascot.mjs');
      if (useVideo() || generation !== mascotGeneration || mascot) return;
      const controller = await module.createWhaleAnimation(el.canvas, {
        onAction: value => { action = value; paint(); },
        onError: () => { if (generation === mascotGeneration && !useVideo()) mascotFailed(); },
      });
      if (useVideo() || generation !== mascotGeneration || mascot) {
        if (controller) controller.dispose();
        return;
      }
      mascot = controller;
      mascotTries = 0;
      el.canvas.hidden = false;
      el.fallbackImg.hidden = true;
      mascot.setBusy(Date.now() < busyUntil);
    } catch (error) {
      if (generation === mascotGeneration && !useVideo()) mascotFailed();
    } finally {
      if (generation === mascotGeneration) mascotLoading = false;
    }
  }

  // WebGL 上下文丢了（窗口变形、驱动回收）就换一块新画布重来，实在不行退回静态图
  function mascotFailed() {
    mascot = null;
    el.canvas.hidden = true;
    el.fallbackImg.hidden = false;
    if (useVideo()) return;
    if (mascotTries >= 5) return;
    mascotTries += 1;
    const stale = el.canvas;
    const fresh = stale.cloneNode(false);
    fresh.removeAttribute('data-action');
    stale.replaceWith(fresh);
    el.canvas = fresh;
    setTimeout(() => { if (!useVideo() && !mascot) ensureMascot(); }, 400 * mascotTries);
  }

  function disposeMascot() {
    mascotGeneration += 1;
    mascotLoading = false;
    if (mascot) {
      mascot.dispose();
      mascot = null;
    }
    mascotTries = 0;
    // dispose() 主动释放 WebGL 上下文，下一次必须使用新画布。
    const fresh = el.canvas.cloneNode(false);
    fresh.removeAttribute('data-animation');
    fresh.removeAttribute('data-action');
    el.canvas.replaceWith(fresh);
    el.canvas = fresh;
    el.canvas.hidden = useVideo();
    el.fallbackImg.hidden = true;
  }

  /* -------------------------------------------------------- 人物动画（WebM） */

  function useVideo() {
    return !videoBroken && cfg.character !== 'atlas';
  }

  function currentScene() {
    return pickScene({
      phase: computeWage(new Date()).phase,
      busy: Date.now() < busyUntil,
      caught: performance.now() < caughtUntil,
    });
  }

  function syncCharacterVisibility() {
    const video = useVideo();
    el.mascotBtn.classList.toggle('sm-video-mode', video);
    el.petStage.hidden = !video;
    el.canvas.hidden = video;
    el.fallbackImg.hidden = true;
    return video;
  }

  // 展开时按当前人物类型启动：视频立刻播，图集要等窗口变完形再建画布
  function startCharacter() {
    if (syncCharacterVisibility()) {
      disposeMascot();
      sceneCurrent = null;
      playScene(currentScene());
    } else {
      stopVideos();
      setTimeout(() => { if (!useVideo()) ensureMascot(); }, 260);
    }
  }

  function applyCharacter() {
    videoBroken = false;
    syncCharacterVisibility();
    startCharacter();
  }

  function stopVideos() {
    clearTimeout(videoTimer);
    clearTimeout(videoGuard);
    sceneCurrent = null;
    sceneAttempt += 1;
    for (const video of el.videos) {
      video.pause();
      video.dataset.on = 'false';
    }
  }

  // 两块 video 轮流装场景，切换时交叉淡入
  function playScene(scene) {
    if (!scene || !useVideo()) return;
    if (scene === sceneCurrent) return;
    sceneCurrent = scene;
    const videos = el.videos;
    const previous = videos[activeVideo];
    const nextIndex = activeVideo === 0 ? 1 : 0;
    const next = videos[nextIndex];
    const myAttempt = ++sceneAttempt;
    const src = `assets/webm/${SCENE_FILES[scene]}`;
    const show = () => {
      next.dataset.on = 'true';
      if (previous) previous.dataset.on = 'false';
      activeVideo = nextIndex;
    };
    const play = () => {
      if (sceneAttempt !== myAttempt) return;
      clearTimeout(videoGuard);
      // 系统开了「减少动态效果」就停在第一帧
      const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      next.currentTime = 0;
      if (still) { show(); next.pause(); return; }
      const attempt = next.play();
      if (!attempt || !attempt.then) { show(); return; }
      attempt.then(() => {
        if (sceneAttempt !== myAttempt) return;
        show();
        clearTimeout(videoTimer);
        videoTimer = setTimeout(() => {
          if (previous && previous !== next && previous.dataset.on !== 'true') previous.pause();
        }, 500);
      }).catch(() => { if (sceneAttempt === myAttempt) videoFailed(); });
    };
    // 迟迟播不起来也要有结果，不能留一块空白
    videoGuard = setTimeout(() => {
      if (sceneAttempt === myAttempt && next.dataset.on !== 'true') videoFailed();
    }, 4000);
    if (next.getAttribute('src') !== src) {
      next.setAttribute('src', src);
      next.addEventListener('canplay', play, { once: true });
      next.load();
    } else {
      play();
    }
  }

  function videoFailed() {
    videoBroken = true;
    stopVideos();
    syncCharacterVisibility();
    startCharacter();
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

  pick('balanceRow').addEventListener('click', event => { if (!event.target.closest('button')) el.toggle.click(); });
  pick('balanceRow').addEventListener('keydown', event => { if (event.target === pick('balanceRow') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); el.toggle.click(); } });

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
    bubbleUntil = performance.now() + 4500;
    if (mascot) mascot.catch();
    paint();
  });

  if (api.onConfig) {
    api.onConfig(next => {
      if (!next) return;
      cfg = Object.assign({}, DEF, next);
      applyTheme();
      if (cfg.character !== characterApplied) { characterApplied = cfg.character; applyCharacter(); }
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
        if (!basisReady) {
          // 首屏 paint 用的是默认配置，等真实数据到了再重建基准，否则会被当成一次涨跌
          basisReady = true;
          lastAmount = null;
          greenMark = null;
        }
        if (today.expense > lastExpense + 1e-9) busyUntil = Date.now() + 5000;
        lastExpense = today.expense;
        applyTheme();
        if (cfg.character !== characterApplied) { characterApplied = cfg.character; applyCharacter(); }
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
