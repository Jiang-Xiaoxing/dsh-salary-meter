/*
 * 桌面版挂件：外观与 DS Bot 里的 dsh-salary-meter 挂件保持一致，
 * 区别只是账本由 Rust 侧直接扫 DS Bot 的会话日志算出来，不依赖插件。
 */
import { pickScene, sceneBubble, sceneFileName, clipCount, guardTurn } from './pet-scenes.mjs';
import { planAmounts, reelSteps, reelDuration } from './odometer.mjs';
import { EGG, CLICK_EGG, IDLE_EGG, clickStreak, rollClickEgg, rollIdleEgg } from './egg.mjs';

(function () {
  'use strict';

  const DEF = { salary: 5000, days: 22, start: '09:00', end: '18:00', lunch: 1, weekend: false, restMode: 'double', theme: 'dark', character: 'webm', petScale: 130, expanded: false };

  /* --sm-panel 是账目区（今日账目 / 进度 / 入账）专用底板：
     跟主题同色，但不透明度 96%，压住背后窗口透上来的文字。
     人物和余粮大数字不套这层，保持原来的半透明质感。 */
  const PALETTES = {
    dark: { '--sm-bg': '#232324', '--sm-panel': 'rgba(35,35,36,.96)', '--sm-text': '#e9ebf2', '--sm-muted': '#9398a6', '--sm-line': '#ffffff17', '--dsw-specific-bubble': '#34436c', '--sm-blue': '#8398ff' },
    light: { '--sm-bg': '#f7f8fa', '--sm-panel': 'rgba(247,248,250,.96)', '--sm-text': '#1f2329', '--sm-muted': '#6b7280', '--sm-line': '#00000014', '--dsw-specific-bubble': '#dfe7f7', '--sm-blue': '#4c6ef5' },
    gold: { '--sm-bg': '#1f1a13', '--sm-panel': 'rgba(31,26,19,.96)', '--sm-text': '#d6b36a', '--sm-muted': '#9c8a63', '--sm-line': '#ffffff14', '--dsw-specific-bubble': '#3a2f1d', '--sm-blue': '#c9a227' },
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

  // 方向箭头：两个小箭头叠成一列，慢变只显示上面那个，快变两个都显示
  for (let i = 0; i < 2; i++) {
    const chev = document.createElement('i');
    chev.className = 'sm-chev';
    el.arrow.appendChild(chev);
  }

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
  let bubbleKey = null; // 场景#段号，气泡跟着当前这一段的文案走
  let mascot = null;
  let mascotTries = 0;
  let mascotGeneration = 0;
  let mascotLoading = false;
  let toggleGuardUntil = 0;
  let action = 'idle';
  let caughtUntil = 0;
  let busyUntil = 0;
  let lastExpense = 0;
  let sceneCurrent = null; // 场景#段号，正在播的那一段
  let sceneName = null; // 正在播的场景名
  let sceneTurn = 0; // 正在播的是这个场景里的第几段
  const sceneTurns = Object.create(null); // 每个场景下一段该播第几段
  let activeVideo = 0;
  let sceneAttempt = 0;
  let videoTimer = null;
  let videoGuard = null;
  let videoBroken = false;
  let characterApplied = null;

  /* ------------------------------------------------------------ 彩蛋状态 */
  // 两个彩蛋共用一个效果：余粮显示成 ¥0.00 停 3 秒，只动显示层，账本一分不碰
  let eggUntil = 0; // 清零显示到什么时候（performance.now）
  let eggWasActive = false;
  let bubbleMutedUntil = 0; // 彩蛋恢复后这段时间别冒气泡
  let clickTimes = []; // 最近几次点人物的时间，3 秒窗口外的会被丢掉
  let lastPoke = 0; // 最近一次碰挂件的时间，待机彩蛋靠它算静默多久
  let idleRollAt = 0; // 待机彩蛋上次掷骰的时间
  let userIdleMs = Infinity; // 整台电脑的键鼠空闲时长（Rust 侧读系统），拿不到就当在忙
  let dsLastWrite = 0; // DS Bot 最近一次写会话日志的时间，判断它是不是在跑

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
  /* 大小周的周序号用固定基准连续算，不按自然年重置——按年重置会在每年 1 月出现连续两个周六休息 */
  const WEEK0 = Date.UTC(2026, 0, 5); // 2026-01-05 是周一，作为第 0 周
  function weekIndex(d) {
    const t = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor((t - WEEK0) / 604800000);
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
    el.settingsLayer.dataset.settingsTheme = el.widget.dataset.theme;
  }

  function applyExpanded() {
    el.widget.dataset.expanded = String(expanded);
    // 「休息日」这段文字本身就是展开按钮，不再改它的文字，只更新无障碍状态
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
  let arrowTimer = 0;
  let changeAt = 0;
  let lastDay = '';
  let basisReady = false;
  let lastAnimAt = 0;

  function clearMoneyFx() {
    clearTimeout(flashTimer);
    clearTimeout(arrowTimer);
    flashTimer = 0;
    arrowTimer = 0;
    el.balance.classList.remove('up', 'down');
    el.arrow.dataset.on = 'false';
  }

  // 箭头：dir 是方向，fast 决定单箭头还是双箭头
  function showArrow(dir, fast) {
    el.arrow.dataset.dir = dir;
    el.arrow.classList.toggle('sm-double', !!fast);
    el.arrow.dataset.on = 'true';
    clearTimeout(arrowTimer);
    arrowTimer = setTimeout(() => { el.arrow.dataset.on = 'false'; }, dir === 'down' ? 2200 : 1600);
  }

  // 快慢 = 这次变动的大小 ÷ 距上次变动的时间（每秒变动多少元）。
  // 金额是「一分一分涨」还是「一笔一笔扣」，这么算都能区分开。
  function noteChange(delta) {
    const now = performance.now();
    const gap = Math.max(.08, (now - changeAt) / 1000);
    const rate = Math.abs(delta) / gap;
    changeAt = now;
    if (Math.abs(delta) >= .0005) showArrow(delta >= 0 ? 'up' : 'down', rate >= .08);
  }

  function bigFlash(dir, hold) {
    el.balance.classList.remove('up', 'down');
    void el.balance.offsetWidth;
    el.balance.classList.add(dir);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.balance.classList.remove('up', 'down'), hold);
  }

  /* ------------------------------------------------ 金额滚轮（机械计数器） */
  // 每一位数字是一个独立的竖向滚轮：滚轮上排着 0-9，只有发生变化的那几位转，
  // 转的时候旧数字滚出窗口、新数字从另一侧滚进来。负号、小数点、逗号、前面的 ¥ 不动。
  let slots = []; // 和 renderedAmount 的字符一一对应
  let renderedAmount = null;
  let slotWidthTimer = 0;

  const REEL_COPIES = 3; // 0-9 排三份，正反转都够用，不会滚到空白
  const REEL_BASE = 10; // 从中间那份起步

  function motionOff() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // 滚轮位置用 em 算：每一格高 1em，不用量像素，换字号也不会错位
  function placeReel(slot, animate, ms) {
    slot.strip.style.transition = animate ? 'transform ' + ms + 'ms cubic-bezier(.25,.86,.3,1)' : 'none';
    slot.strip.style.transform = 'translate3d(0,' + (-slot.pos) + 'em,0)';
  }

  // 上一次还没转完又来了新值：把当前画面定住，再从这儿接着转
  function freezeReel(slot) {
    const computed = getComputedStyle(slot.strip).transform;
    slot.strip.style.transition = 'none';
    if (computed && computed !== 'none') {
      slot.strip.style.transform = computed;
      void slot.strip.offsetHeight;
    }
  }

  // 转完把位置归到中间那份（同一数字，画面完全看不出来）
  function normalizeReel(slot) {
    const target = REEL_BASE + Number(slot.ch);
    if (slot.pos === target) return;
    slot.pos = target;
    placeReel(slot, false);
  }

  function settleSlot(slot) {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = 0; }
    slot.animating = false;
    if (slot.kind === 'digit') normalizeReel(slot);
  }

  function makeSlot(ch) {
    const isDigit = ch >= '0' && ch <= '9';
    const el = document.createElement('span');
    if (!isDigit) {
      el.className = 'sm-slot sm-slot-' + (ch === '.' || ch === ',' ? 'sep' : 'mark');
      const glyph = document.createElement('span');
      glyph.className = 'sm-glyph';
      glyph.textContent = ch;
      el.appendChild(glyph);
      return { el, kind: 'char', ch, glyph, timer: 0, animating: false };
    }
    // 数字格：看不见的「字」撑出格宽和基线，上面盖一条 0-9 的滚轮
    el.className = 'sm-slot sm-slot-digit';
    const strut = document.createElement('span');
    strut.className = 'sm-strut';
    strut.textContent = ch;
    const reel = document.createElement('span');
    reel.className = 'sm-reel';
    reel.setAttribute('aria-hidden', 'true');
    const strip = document.createElement('span');
    strip.className = 'sm-reel-strip';
    for (let i = 0; i < 10 * REEL_COPIES; i++) {
      const item = document.createElement('span');
      item.className = 'sm-reel-item';
      item.textContent = String(i % 10);
      strip.appendChild(item);
    }
    reel.appendChild(strip);
    el.appendChild(strut);
    el.appendChild(reel);
    const slot = { el, kind: 'digit', ch, strip, strut, pos: REEL_BASE + Number(ch), timer: 0, animating: false };
    placeReel(slot, false);
    return slot;
  }

  function updateChar(slot, ch) {
    if (slot.ch === ch) return;
    slot.ch = ch;
    slot.glyph.textContent = ch;
  }

  // 滚轮里塞着一整条 0-9，textContent 会变成一长串；真实金额单独存在 data-amount 上
  // 货币符号 ¥ 在数字前面（负号之前），和明细里的写法一致
  function publishAmount(text) {
    el.value.dataset.amount = text;
    el.value.setAttribute('aria-label', '¥' + text);
  }

  // 数字：转动对应格数；符号/小数点：直接换
  function rollSlot(slot, ch, dir) {
    if (slot.kind !== 'digit') { updateChar(slot, ch); return; }
    if (slot.ch === ch) return;
    const steps = reelSteps(slot.ch, ch, dir);
    slot.ch = ch;
    slot.strut.textContent = ch;
    if (!steps) return;
    if (motionOff()) { slot.pos = REEL_BASE + Number(ch); placeReel(slot, false); return; }
    if (slot.animating) freezeReel(slot);
    slot.pos += dir >= 0 ? steps : -steps;
    const ms = reelDuration(steps);
    slot.animating = true;
    placeReel(slot, true, ms);
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      slot.timer = 0;
      slot.animating = false;
      normalizeReel(slot);
    }, ms + 40);
  }

  // 位数变化时容器宽度跟着补间，避免整个数左右跳一下
  function animateAmountWidth(before) {
    const after = el.value.getBoundingClientRect().width;
    if (!(before > 0) || Math.abs(after - before) < .5) return;
    el.value.style.width = before + 'px';
    void el.value.offsetWidth;
    el.value.style.width = after + 'px';
    clearTimeout(slotWidthTimer);
    slotWidthTimer = setTimeout(() => { el.value.style.width = ''; }, 240);
  }

  function rebuildAmount(text) {
    renderedAmount = text;
    slots = [];
    el.value.textContent = '';
    for (const ch of text) {
      const slot = makeSlot(ch);
      slots.push(slot);
      el.value.appendChild(slot.el);
    }
    publishAmount(text);
  }

  function renderAmount(text, dir) {
    if (renderedAmount === null) { rebuildAmount(text); return; }
    if (renderedAmount === text) return;
    const before = el.value.getBoundingClientRect().width;
    const prev = renderedAmount;
    renderedAmount = text;
    const plan = planAmounts(prev, text);
    const leads = plan.filter(cell => cell.kind === 'appear');
    const drops = plan.filter(cell => cell.kind === 'vanish');

    if (leads.length) {
      // 位数变多：最左边补几格（进到十位/百位/千分位），淡入而不是滚
      const fresh = leads.map(cell => makeSlot(cell.to));
      for (let i = fresh.length - 1; i >= 0; i--) el.value.insertBefore(fresh[i].el, el.value.firstChild);
      slots = fresh.concat(slots);
      for (const slot of fresh) slot.el.classList.add('sm-slot-pending');
      requestAnimationFrame(() => { for (const slot of fresh) slot.el.classList.remove('sm-slot-pending'); });
    } else if (drops.length) {
      // 位数变少：最左边几格退场
      const gone = slots.splice(0, drops.length);
      for (const slot of gone) {
        slot.el.classList.add('sm-slot-exit');
        setTimeout(() => slot.el.remove(), 220);
      }
    }

    for (let i = 0; i < plan.length; i++) {
      const cell = plan[i];
      if (cell.kind === 'appear' || cell.kind === 'vanish') continue;
      // plan 下标 → 新字符串里的字符位置：退位只在最左边，所以要减掉
      const slot = slots[i - drops.length];
      if (!slot) continue;
      if (cell.kind === 'same') continue;
      if (cell.kind === 'roll') rollSlot(slot, cell.to, dir);
      else updateChar(slot, cell.to);
    }
    publishAmount(text);
    animateAmountWidth(before);
  }

  /* ------------------------------------------------------------ 彩蛋 */
  // 触发后：余粮显示 ¥0.00 停 3 秒、气泡喊「token 来，token 来」、人物换成伸手抓抓抓。
  // 只改显示层，账本和 lastAmount 照常走，恢复时不弹出任何提示。

  function eggActive() {
    return performance.now() < eggUntil;
  }

  function triggerEgg() {
    const now = performance.now();
    if (now < eggUntil) return false; // 连着触发不叠加，先等这轮放完
    eggUntil = now + EGG.showMs;
    bubbleMutedUntil = 0;
    lastPoke = now; // 放完彩蛋重新起算「5 分钟没碰」，避免刚结束又掷骰
    clickTimes = []; // 连点计数清掉，一次彩蛋只算一轮
    return true;
  }

  function notePoke() {
    lastPoke = performance.now();
  }

  // 整台电脑最近动过键鼠没有。Rust 侧读 GetLastInputInfo，拿不到时退回「挂件被碰过」的判断
  function userIsActive() {
    if (userIdleMs !== Infinity) return userIdleMs < 60_000 || performance.now() - lastPoke < 90_000;
    return performance.now() - lastPoke < 90_000;
  }

  // DS Bot 在跑：刚产生费用，或最近两分钟还在往会话日志里写
  function dsBotActive() {
    return Date.now() < busyUntil || (dsLastWrite > 0 && Date.now() - dsLastWrite < 120_000);
  }

  // 休息日第二段是「开黑打游戏」，只有真闲着才播
  function gamingAllowed() {
    if (userIsActive() || dsBotActive()) return false;
    return el.settingsLayer.hidden;
  }

  // 每秒看一眼：设置页开着算在动；静默满 5 分钟之后，每 30 秒掷一次 2%
  function idleTick() {
    if (!el.settingsLayer.hidden) { lastPoke = performance.now(); return; }
    // 收起态看不到人物也看不到气泡，清零只会像故障，所以这个彩蛋只在展开时掷
    if (!expanded) return;
    if (eggActive()) return;
    const res = rollIdleEgg({ lastPoke, now: performance.now(), lastRoll: idleRollAt, rand: Math.random() });
    idleRollAt = res.lastRoll;
    if (res.fire) triggerEgg();
  }

  function tickMoney(amount, now) {
    const prev = lastAmount;
    lastAmount = amount;
    if (prev === null || !basisReady) { greenMark = amount; return; }
    const delta = amount - prev;
    if (Math.abs(delta) < 0.0005) return;

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

    el.widget.dataset.rest = String(wage.rest);
    el.statusTitle.textContent = wage.rest ? '今天休息' : '今日账目';
    el.statusTitle.title = wage.status.replace(/\s/g, '');
    el.clock.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

    // 彩蛋期间：显示层清零（¥0.00），账本和 lastAmount 照原样走，恢复时不闪不提示
    const egg = eggActive();
    const negative = amount < 0;
    const text = egg ? '0.00' : (negative ? "−" : "") + money(Math.abs(amount));
    // 统计有遗漏时，实际余粮不大于当前估算；彩蛋期间不显示「≤」，免得出现 ≤¥0.00
    el.prefix.textContent = egg ? '' : partial ? '≤' : '';
    const changed = renderedAmount !== text;
    if (changed) {
      if (!egg && lastAmount !== null) noteChange(amount - lastAmount);
      el.value.style.setProperty('--sm-digits', text.length);
      // 涨钱往上滚、扣钱往下滚；首屏没有基准，按涨处理（反正不动画）
      renderAmount(text, egg ? -1 : lastAmount === null || amount >= lastAmount ? 1 : -1);
    }
    if (egg) {
      // 显示被顶掉了，基准跟着真实金额走，恢复的那一下才不会被当成一次涨跌
      lastAmount = amount;
      greenMark = amount;
    } else if (changed || lastAmount === null) {
      tickMoney(amount, now);
    }

    el.countdown.innerHTML = wage.countdownSeconds > 0
      ? wage.countdownLabel + ' <b>' + duration(wage.countdownSeconds) + '</b>'
      : '<b>' + wage.countdownLabel + '</b>';

    el.bar.value = Math.max(0, Math.min(1, wage.progress));

    el.earned.textContent = '¥' + money(wage.earned);
    el.expenseLabel.textContent = partial ? '偷吃估算（有遗漏）' : '肥鱼饭钱（估算）';
    el.spent.textContent = '¥' + (partial ? '≥' : '−') + expenseText();
    el.compactExpense.textContent = (expanded ? '' : '偷吃 ' + (partial ? '≥' : '≈') + '¥' + expenseText());

    {
      if (useVideo()) {
        const scene = pickScene({
          phase: wage.phase,
          busy: Date.now() < busyUntil,
          caught: performance.now() < caughtUntil,
          egg,
        });
        const turn = playScene(scene, gamingAllowed());
        const key = scene + '#' + turn;
        if (bubbleKey !== key) {
          bubbleKey = key;
          // 彩蛋刚恢复时别让气泡紧跟着冒出来，保持安静
          if (performance.now() >= bubbleMutedUntil) bubbleUntil = performance.now() + 4500;
        }
        el.bubble.textContent = egg ? EGG.bubble : sceneBubble(scene, turn);
        if (egg) bubbleUntil = Math.max(bubbleUntil, eggUntil);
      } else {
        const pose = performance.now() < caughtUntil ? 'caught' : null;
        el.bubble.textContent = egg ? EGG.bubble : pose === 'caught' ? MESSAGES.caught : (MESSAGES[action] || MESSAGES.idle);
        if (egg) bubbleUntil = Math.max(bubbleUntil, eggUntil);
      }
      if (eggWasActive && !egg) {
        // 恢复的那一下要安静：气泡立刻收起来，别把场景文案顺势冒出来
        bubbleMutedUntil = performance.now() + 4500;
        bubbleUntil = 0;
      }
      eggWasActive = egg;
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

  // 图集已从设置里去掉：人物一律用视频动画，图集只在视频真的播不了时兜底
  function useVideo() {
    return !videoBroken;
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
      sceneName = null; // 重开人物时当作「重新进入场景」，轮到下一段
      playScene(currentScene(), gamingAllowed());
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
    sceneName = null;
    sceneAttempt += 1;
    for (const video of el.videos) {
      video.pause();
      video.dataset.on = 'false';
    }
  }

  // 两块 video 轮流装场景，切换时交叉淡入。
  // 一个场景可以挂多段片段：每次重新进入这个场景就换下一段（返回这次播的是第几段）。
  // allowGaming=false 时，休息日轮到的「开黑打游戏」会被换成哼歌那一段。
  function playScene(scene, allowGaming = true) {
    if (!scene || !useVideo()) return 0;
    if (scene !== sceneName) {
      sceneName = scene;
      sceneTurn = sceneTurns[scene] || 0;
      sceneTurns[scene] = (sceneTurn + 1) % Math.max(1, clipCount(scene));
    }
    const turn = guardTurn(scene, sceneTurn, allowGaming);
    const clipKey = scene + '#' + turn;
    if (clipKey === sceneCurrent) return turn;
    sceneCurrent = clipKey;
    const videos = el.videos;
    const previous = videos[activeVideo];
    const nextIndex = activeVideo === 0 ? 1 : 0;
    const next = videos[nextIndex];
    const myAttempt = ++sceneAttempt;
    const src = `assets/webm/${sceneFileName(scene, turn)}`;
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
    return turn;
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

  pick('balanceRow').addEventListener('click', event => { if (!event.target.closest('button, .sm-toggle')) el.toggle.click(); });
  el.toggle.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    el.toggle.click();
  });
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
    document.body.classList.add("settings-open");
    el.settingsLayer.hidden = false;
    el.mascotBtn.blur();
    try { api.setMode('settings'); } catch (error) { /* 尺寸改不动也照样能用 */ }
  }

  function closeSettings() {
    if (el.settingsLayer.hidden) return;
    trace('close @ ' + (new Error().stack || '').split('\n').slice(1, 3).join(' | '));
    el.settingsLayer.hidden = true;
    document.body.classList.remove("settings-open");
    try { api.setMode('widget'); } catch (error) { /* ignore */ }
  }

  el.mascotBtn.addEventListener('click', () => {
    const now = performance.now();
    notePoke();
    clickTimes.push(now);
    clickTimes = clickTimes.filter(t => now - t <= CLICK_EGG.windowMs);
    // 3 秒里点满 6 下开始算，之后每多点一下都有 15% 的机会
    if (rollClickEgg(clickTimes.length, Math.random())) triggerEgg();
    caughtUntil = now + 2500;
    bubbleUntil = now + 4500;
    if (mascot) mascot.catch();
    paint();
  });

  // 右键大肥鱼也能打开设置：顶上那个「⋯」太难找（用户 20:05 提的）
  el.mascotBtn.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    openSettings();
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
        dsLastWrite = Number(state.last_write) || dsLastWrite;
        // 整台电脑的键鼠空闲时长交给系统数，判断「用户是不是正在用电脑」
        if (api.userIdle) {
          api.userIdle().then(ms => { userIdleMs = Number(ms) || 0; }).catch(() => {});
        }
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

  // 碰过挂件就记一笔：待机彩蛋要的是真没人理它
  lastPoke = performance.now();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'contextmenu']) {
    document.addEventListener(type, notePoke, { capture: true, passive: true });
  }
  setInterval(idleTick, 1000);

  setInterval(paint, 100);
  refresh();
  setInterval(refresh, 3000);
})();
