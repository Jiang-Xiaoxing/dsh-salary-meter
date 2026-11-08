/*
 * 桌面版挂件：外观与 DS Bot 里的 dsh-salary-meter 挂件保持一致，
 * 区别只是账本由 Rust 侧直接扫 DS Bot 的会话日志算出来，不依赖插件。
 */
import { pickScene, sceneBubble, sceneFileName, clipCount, guardTurn } from './pet-scenes.mjs';
import { decideSceneSwitch, decideAfterClipEnded, nextTurnAfterDisplay } from './scene-scheduler.mjs';
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

  const pick = id => document.getElementById(id);
  const el = {
    widget: pick('widget'),
    statusTitle: pick('statusTitle'),
    clock: pick('clockText'),
    balance: pick('balanceRow'),
    arrow: pick('balanceArrow'),
    money: pick('balanceMoney'),
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
  let toggleGuardUntil = 0;
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
  /* 场景调度：想播的和正在播的分开，普通变化等这一段播完再切。
     playingClip 只有真正播出来才提交；pendingClip 只留最新一个目标。 */
  let playingClip = null; // { scene, turn, key, gaming }
  let pendingClip = null; // 等待片尾再切的目标
  let pendingSince = 0; // pending 从什么时候开始等，用来兜底超时
  let playingEl = null; // 当前正在播的 video 元素
  const PENDING_MAX_MS = 16000; // 等太久（暂停、隐藏、加载失败）就强切，别无限等片尾
  let dshBusy = null; // 插件心跳：{ busy, at }，DS Bot 真的有没有任务在跑
  // 视频播不出来时不再永久退回图集：记一个重试时刻，到点自动再试一次
  const VIDEO_RETRY_MS = 60000;
  let videoRetryAt = 0;
  let characterApplied = null;

  /* ------------------------------------------------------------ 彩蛋状态 */
  // 两个彩蛋共用一个效果：余粮显示成 ¥0.00 停 3 秒，只动显示层，账本一分不碰
  let eggUntil = 0; // 清零显示到什么时候（performance.now）
  let eggClipUntil = 0; // 抓抓抓动画播到什么时候（比清零长，整段放完再切回）
  let eggClipWasActive = false;
  let eggShownOnce = false; // 抓抓抓这段是否已经真正播出来过一次（保护期从实际播放算）
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
    // 展开/收起不重新决定人物动作：窗口尺寸由 Rust 改，动画交给调度层，下一帧照常算
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

  // 动画保持窗口比清零显示长：grab 这段 10.042 秒，播完整段再切回正常场景
  function eggClipActive() {
    return performance.now() < eggClipUntil;
  }

  function triggerEgg() {
    const now = performance.now();
    if (now < eggClipUntil) return false; // 整段动画放完前不叠加，连点也只算一轮
    eggUntil = now + EGG.showMs;
    eggClipUntil = now + EGG.clipMs;
    eggShownOnce = false;
    bubbleMutedUntil = 0;
    lastPoke = now; // 放完彩蛋重新起算「5 分钟没碰」，避免刚结束又掷骰
    clickTimes = []; // 连点计数清掉，一次彩蛋只算一轮
    return true;
  }

  function notePoke() {
    lastPoke = performance.now();
  }

  // 真实任务状态：插件每 5 秒续期一次的心跳，10 秒内有效才算数
  function dshBusyReport() {
    if (!dshBusy) return null;
    return Date.now() - dshBusy.at <= 10_000 ? dshBusy : null;
  }

  // 忙闲只有一个口径：真实任务状态优先；拿不到才退回「5 秒扣费 / 120 秒日志」的估算
  function isBusy() {
    const real = dshBusyReport();
    if (real) return real.busy === true;
    return Date.now() < busyUntil || (dsLastWrite > 0 && Date.now() - dsLastWrite < 120_000);
  }

  // 整台电脑最近 3 分钟动过键鼠没有。读不到系统空闲时长时按「在忙」处理，宁可少播游戏
  function userIsActive() {
    if (!isFinite(userIdleMs)) return true;
    return userIdleMs < 180_000 || performance.now() - lastPoke < 180_000;
  }

  // 休息日第二段是「开黑打游戏」：必须真的闲住、没有任务在跑、设置页没开
  function gamingAllowed() {
    if (!isFinite(userIdleMs)) return false; // 拿不到系统空闲时长：保守不许
    if (isBusy() || userIsActive()) return false;
    return el.settingsLayer.hidden;
  }

  // 每秒看一眼：设置页开着算在动；静默满 5 分钟之后，每 30 秒掷一次 2%
  function idleTick() {
    if (!el.settingsLayer.hidden) { lastPoke = performance.now(); return; }
    // 收起态看不到人物也看不到气泡，清零只会像故障，所以这个彩蛋只在展开时掷
    if (!expanded) return;
    if (eggClipActive()) return;
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
    retryVideoIfDue();
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
    const eggClip = eggClipActive();
    // 收起态平时不显示气泡，彩蛋期间靠这个标记放开（CSS 里按 data-egg 覆盖 display:none）
    if (eggClip) el.widget.dataset.egg = 'true';
    else delete el.widget.dataset.egg;
    const negative = amount < 0;
    const text = egg ? '0.00' : (negative ? "−" : "") + money(Math.abs(amount));
    // 统计有遗漏时，实际余粮不大于当前估算；彩蛋期间不显示「≤」，免得出现 ≤¥0.00
    el.prefix.textContent = egg ? '' : partial ? '≤' : '';
    const changed = renderedAmount !== text;
    if (changed) {
      if (!egg && lastAmount !== null) noteChange(amount - lastAmount);
      // 字号档位挂在 .sm-money 上：¥ 和数字都读这个变量，比例才跟着位数一起变
      el.money.style.setProperty('--sm-digits', text.length);
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
        const allowGaming = gamingAllowed();
        const caught = performance.now() < caughtUntil;
        const scene = pickScene({
          phase: wage.phase,
          busy: isBusy(),
          caught,
          egg: eggClip, // 场景看 10 秒的动画窗口，不只是 3 秒的清零窗口
        });
        // 三种情况允许立刻抢占：彩蛋、被抓、正在放游戏但许可没了
        const revokeGaming = !!(playingClip && playingClip.gaming) && !allowGaming;
        requestScene(scene, allowGaming, eggClip || caught || revokeGaming);
        // 气泡跟着「真正播出来的那一段」，不跟还没播的目标
        const shown = playingClip || { scene, turn: 0 };
        const key = shown.scene + '#' + shown.turn;
        if (bubbleKey !== key) {
          bubbleKey = key;
          // 彩蛋刚恢复时别让气泡紧跟着冒出来，保持安静
          if (performance.now() >= bubbleMutedUntil) bubbleUntil = performance.now() + 4500;
        }
        el.bubble.textContent = eggClip ? EGG.bubble : sceneBubble(shown.scene, shown.turn);
        if (eggClip) bubbleUntil = Math.max(bubbleUntil, eggClipUntil);
      }
      if (eggClipWasActive && !eggClip) {
        // 动画收尾的那一下要安静：台词跟着动画一起收，别把场景文案顺势冒出来
        bubbleMutedUntil = performance.now() + 4500;
        bubbleUntil = 0;
      }
      eggClipWasActive = eggClip;
    }

    // 人物隐藏期间气泡也跟着消失，别让台词浮在空处
    el.bubble.hidden = el.petStage.hidden || performance.now() >= bubbleUntil;
    pick('petStatus').textContent = wage.status.replace(/\s/g, '');
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

  /* -------------------------------------------------------- 人物动画（WebM） */

  // 人物只有视频这一种画法：视频播不出来时人物先隐藏，60 秒后自动重试，不再退回图集
  function useVideo() {
    return performance.now() >= videoRetryAt;
  }

  function currentScene() {
    return pickScene({
      phase: computeWage(new Date()).phase,
      busy: isBusy(),
      caught: performance.now() < caughtUntil,
      egg: performance.now() < eggClipUntil,
    });
  }

  function syncCharacterVisibility() {
    const video = useVideo();
    // 人物只有视频这一种画法；图集已经拿掉，布局固定按视频尺寸算
    el.mascotBtn.classList.add('sm-video-mode');
    el.petStage.hidden = !video;
    return video;
  }

  // 启动人物：视频立刻播。视频失败期间人物隐藏，等 60 秒重试，不再建图集画布
  function startCharacter() {
    if (!syncCharacterVisibility()) {
      stopVideos();
      return;
    }
    playingClip = null;
    pendingClip = null;
    playingEl = null;
    sceneCurrent = null;
    sceneName = null;
    requestScene(currentScene(), gamingAllowed(), true);
  }

  function applyCharacter() {
    videoRetryAt = 0;
    syncCharacterVisibility();
    startCharacter();
  }

  function stopVideos() {
    clearTimeout(videoTimer);
    clearTimeout(videoGuard);
    sceneCurrent = null;
    sceneName = null;
    sceneTurn = 0;
    sceneAttempt += 1;
    playingClip = null;
    pendingClip = null;
    playingEl = null;
    for (const video of el.videos) {
      video.pause();
      video.dataset.on = 'false';
    }
  }

  /* 场景调度：想播的和正在播的分开。
     - 普通变化只更新 pending（只留最新一个目标），等当前这一段播到结尾再切，不再从动作中间硬断
     - 彩蛋、被抓、以及「游戏许可被撤销」允许立刻抢占
     - sceneTurns 只在片段真正显示出来时才递增，避免「没播也消耗轮次」
     - video 不再 loop：片尾由 ended 回调决定「重播这一段」还是「切到 pending」 */
  function targetFor(scene, allowGaming) {
    const entering = !playingClip || playingClip.scene !== scene;
    const base = entering ? (sceneTurns[scene] || 0) : playingClip.turn;
    const turn = guardTurn(scene, base, allowGaming);
    return { scene, turn, key: scene + '#' + turn, gaming: sceneFileName(scene, turn) === 'gaming.webm' };
  }

  // 每 100ms 的入口：决定「现在切」还是「等片尾」（判断本体在 scene-scheduler.mjs）
  function requestScene(scene, allowGaming, immediate) {
    if (!scene || !useVideo()) return;
    const target = targetFor(scene, allowGaming);
    const paused = !playingEl || playingEl.paused || playingEl.ended;
    const plan = decideSceneSwitch({
      target,
      playing: playingClip,
      pending: pendingClip,
      pendingSince,
      now: performance.now(),
      paused,
      immediate,
      maxWaitMs: PENDING_MAX_MS,
    });
    pendingClip = plan.pending;
    pendingSince = plan.pendingSince;
    if (plan.start) startClip(plan.start, allowGaming);
  }

  // 片尾：有目标就切，没有就重播这一段
  function onClipEnded(video) {
    if (video !== playingEl) return;
    const plan = decideAfterClipEnded(pendingClip);
    if (plan.start) { startClip(plan.start, gamingAllowed()); return; }
    if (!plan.restart) return;
    try { video.currentTime = 0; video.play().catch(() => {}); } catch (error) { videoFailed(); }
  }

  // 真正加载并播放一个片段；只有播出来（show）才提交状态
  function startClip(target, allowGaming) {
    if (!target || !useVideo()) return;
    // 显示前再按当前许可核一次：撤销游戏许可属于立即切换，不能等片尾
    const checked = targetFor(target.scene, allowGaming);
    if (checked.key !== target.key) { target = checked; pendingClip = checked; }
    const videos = el.videos;
    const previous = playingEl;
    const nextIndex = activeVideo === 0 ? 1 : 0;
    const next = videos[nextIndex];
    const myAttempt = ++sceneAttempt;
    const src = `assets/webm/${sceneFileName(target.scene, target.turn)}`;
    const show = () => {
      if (sceneAttempt !== myAttempt) return;
      if (previous && previous !== next) previous.dataset.on = 'false';
      next.dataset.on = 'true';
      activeVideo = nextIndex;
      playingEl = next;
      const previousScene = playingClip ? playingClip.scene : null;
      playingClip = target;
      sceneCurrent = target.key;
      sceneName = target.scene;
      sceneTurn = target.turn;
      // 只有真正播出来才算「进入这个场景」，这时才轮到下一段
      // 只有真正播出来才算「进入这个场景」，这时才轮到下一段
      if (previousScene !== target.scene) {
        sceneTurns[target.scene] = nextTurnAfterDisplay(target.scene, target.turn, previousScene, clipCount(target.scene));
      }
      // 彩蛋这段要从真正播出来的时刻起算整段时长，否则加载耗时会把 10 秒吃掉
      if (target.scene === 'grab' && !eggShownOnce) {
        eggShownOnce = true;
        eggClipUntil = Math.max(eggClipUntil, performance.now() + EGG.clipMs);
      }
      if (pendingClip && pendingClip.key === target.key) pendingClip = null;
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
    // 迟迟播不起来也要有结果，不能留一块空白。
    // 但窗口被最小化/遮挡时浏览器会故意拖着不播，那种不算视频坏了，别记成失败。
    videoGuard = setTimeout(() => {
      if (sceneAttempt !== myAttempt || next.dataset.on === 'true') return;
      if (document.visibilityState !== 'visible') return;
      videoFailed();
    }, 4000);
    // src 没变也要重载的情况：上一次加载已经报错了（比如素材短暂读不到），
    // 这时只调 play() 会一直失败，必须先 load() 重新读一次
    if (next.getAttribute('src') !== src || next.error) {
      next.setAttribute('src', src);
      next.addEventListener('canplay', play, { once: true });
      next.load();
    } else {
      play();
    }
  }

  function videoFailed() {
    // 不永久放弃：人物先隐藏（不拿图集顶），60 秒后再试视频，成功就自动回来
    videoRetryAt = performance.now() + VIDEO_RETRY_MS;
    stopVideos();
    syncCharacterVisibility();
  }

  // 人物隐藏期间，到点就重试一次视频（收起态也要重试：用户平时就是收起态）
  function retryVideoIfDue() {
    if (!videoRetryAt) return;
    if (performance.now() < videoRetryAt) return;
    if (document.visibilityState !== 'visible') return;
    videoRetryAt = 0;
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
    // 视频失败期间人物是空着的，空白处不接点击，免得误触彩蛋
    if (el.petStage.hidden) return;
    const now = performance.now();
    notePoke();
    clickTimes.push(now);
    clickTimes = clickTimes.filter(t => now - t <= CLICK_EGG.windowMs);
    // 3 秒里点满 6 下开始算，之后每多点一下都有 15% 的机会
    if (rollClickEgg(clickTimes.length, Math.random())) triggerEgg();
    caughtUntil = now + 2500;
    bubbleUntil = now + 4500;
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
        // 插件心跳：DS Bot 是不是真的还有任务在跑（真实状态，优先于费用估算）
        if (state.dsh_busy && typeof state.dsh_busy.at === 'number') {
          dshBusy = { busy: state.dsh_busy.busy === true, at: Number(state.dsh_busy.at) || 0 };
        }
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
  // 片尾事件：有目标就切，没有就重播这一段（video 已取消 loop，靠这里兜住循环）
  for (const video of el.videos) {
    video.addEventListener('ended', () => onClipEnded(video));
  }

  setInterval(idleTick, 1000);

  setInterval(paint, 100);
  refresh();
  setInterval(refresh, 3000);
})();
