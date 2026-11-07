// 彩蛋条件的回归检查：
//   node desktop\checks\egg.cjs
// 只跑纯函数，不开窗口、不需要显示器。

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

(async () => {
  const ROOT = path.join(__dirname, '..');
  const egg = await import(pathToFileURL(path.join(ROOT, 'renderer', 'egg.mjs')).href);

  // 规则本身
  check('3 秒窗口', egg.CLICK_EGG.windowMs === 3000);
  check('第 6 下开始算', egg.CLICK_EGG.startAt === 6);
  check('连点概率 15%', egg.CLICK_EGG.chance === 0.15);
  check('待机静默 5 分钟', egg.IDLE_EGG.quietMs === 300000);
  check('待机每 30 秒掷一次', egg.IDLE_EGG.everyMs === 30000);
  check('待机概率 2%', egg.IDLE_EGG.chance === 0.02);
  check('待机概率明显低于连点', egg.IDLE_EGG.chance < egg.CLICK_EGG.chance / 5);
  check('清零停留 3 秒', egg.EGG.showMs === 3000);
  check('气泡文案', egg.EGG.bubble === 'token 来，token 来');

  // 连点：3 秒窗口怎么数
  const t0 = 10000;
  check('空记录算 0 下', egg.clickStreak([], t0) === 0);
  check('窗口内 3 下算 3', egg.clickStreak([t0 - 100, t0 - 900, t0 - 2900], t0) === 3);
  check('超过 3 秒的丢掉', egg.clickStreak([t0 - 3001], t0) === 0);
  check('正好 3 秒还算', egg.clickStreak([t0 - 3000], t0) === 1);

  // 连点：第 6 下之前不掷
  check('第 5 下没机会', egg.rollClickEgg(5, 0) === false);
  check('第 6 下有机会（随机数命中）', egg.rollClickEgg(6, 0.1499) === true);
  check('第 6 下没命中不触发', egg.rollClickEgg(6, 0.15) === false);
  check('第 20 下也按 15% 算', egg.rollClickEgg(20, 0.1499) === true);

  // 待机：静默不够久、掷得太勤都不掷
  const now = 1_000_000;
  check('静默 4 分 59 秒不掷',
    egg.rollIdleEgg({ lastPoke: now - 299_000, now, lastRoll: 0, rand: 0 }).fire === false);
  const due = egg.rollIdleEgg({ lastPoke: now - 300_000, now, lastRoll: 0, rand: 0.0199 });
  check('静默满 5 分钟 + 随机数命中就触发', due.fire === true);
  check('触发后记下这次掷骰时间', due.lastRoll === now);
  const again = egg.rollIdleEgg({ lastPoke: now - 300_000, now: now + 10_000, lastRoll: now, rand: 0 });
  check('30 秒内不重复掷', again.fire === false && again.lastRoll === now);
  const later = egg.rollIdleEgg({ lastPoke: now - 300_000, now: now + 30_000, lastRoll: now, rand: 0.0199 });
  check('满 30 秒再掷', later.fire === true && later.lastRoll === now + 30_000);
  check('随机数不命中就不触发',
    egg.rollIdleEgg({ lastPoke: now - 300_000, now, lastRoll: 0, rand: 0.02 }).fire === false);

  // 恢复后的静默窗口
  check('刚恢复时气泡压住', egg.bubbleMuted(1000, 2000) === true);
  check('4.5 秒后放开', egg.bubbleMuted(1000, 5600) === false);

  if (failures) { console.log(`\nFAILED: ${failures} 项不通过`); process.exit(1); }
  console.log('\nPASS: 连点 6 下起・15%，待机 5 分钟・每 30 秒・2%，清零 3 秒');
})();
