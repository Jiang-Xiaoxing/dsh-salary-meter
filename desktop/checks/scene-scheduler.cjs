// 场景调度的回归检查：node desktop\checks\scene-scheduler.cjs
// 只跑纯函数，不开窗口、不需要显示器。
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`); }
}

const clip = (scene, turn) => ({ scene, turn, key: scene + '#' + turn });

(async () => {
  const ROOT = path.join(__dirname, '..');
  const mod = await import(pathToFileURL(path.join(ROOT, 'renderer', 'scene-scheduler.mjs')).href);
  const { decideSceneSwitch, decideAfterClipEnded, nextTurnAfterDisplay } = mod;

  console.log('场景调度');

  // 1. 正在播 working#0，目标变成 busy：不该立刻切，只挂 pending
  {
    const plan = decideSceneSwitch({
      target: clip('busy', 0),
      playing: clip('working', 0),
      pending: null,
      pendingSince: 0,
      now: 1000,
      paused: false,
      immediate: false,
    });
    check('普通变化不截断当前片段', plan.start === null);
    check('普通变化挂成待切目标', plan.pending && plan.pending.key === 'busy#0');
    check('待切计时从这次开始算', plan.pendingSince === 1000);
  }

  // 2. 连续变化只留最新目标
  {
    const first = decideSceneSwitch({
      target: clip('busy', 0), playing: clip('working', 0), pending: null,
      pendingSince: 0, now: 1000, paused: false, immediate: false,
    });
    const second = decideSceneSwitch({
      target: clip('overtime', 0), playing: clip('working', 0), pending: first.pending,
      pendingSince: first.pendingSince, now: 1500, paused: false, immediate: false,
    });
    const third = decideSceneSwitch({
      target: clip('idle', 0), playing: clip('working', 0), pending: second.pending,
      pendingSince: second.pendingSince, now: 2000, paused: false, immediate: false,
    });
    check('目标被替换只保留最新的', third.pending && third.pending.key === 'idle#0');
    check('目标变了要重置等待起点', third.pendingSince === 2000);
    check('同一目标的等待时间不会被每帧刷新', (() => {
      const a = decideSceneSwitch({
        target: clip('busy', 0), playing: clip('working', 0), pending: null,
        pendingSince: 0, now: 1000, paused: false, immediate: false,
      });
      const b = decideSceneSwitch({
        target: clip('busy', 0), playing: clip('working', 0), pending: a.pending,
        pendingSince: a.pendingSince, now: 9000, paused: false, immediate: false,
      });
      return b.pendingSince === 1000;
    })());
  }

  // 3. 目标又回到正在播的片段：待切作废
  {
    const plan = decideSceneSwitch({
      target: clip('working', 0), playing: clip('working', 0),
      pending: clip('busy', 0), pendingSince: 1000, now: 2000, paused: false, immediate: false,
    });
    check('目标回到当前片段时清掉待切', plan.pending === null && plan.start === null);
  }

  // 4. 片尾：有目标就切，没目标就重播
  {
    const withPending = decideAfterClipEnded(clip('busy', 0));
    check('片尾有目标就切过去', withPending.start && withPending.start.key === 'busy#0' && !withPending.restart);
    const without = decideAfterClipEnded(null);
    check('片尾没目标就重播这一段', without.restart === true && without.start === null);
  }

  // 5. 彩蛋/被抓/撤销游戏这类要立刻切
  {
    const plan = decideSceneSwitch({
      target: clip('grab', 0), playing: clip('working', 0), pending: null,
      pendingSince: 0, now: 1000, paused: false, immediate: true,
    });
    check('立刻抢占的场合直接切', plan.start && plan.start.key === 'grab#0');
  }

  // 6. 没有在播 / 暂停 / 等太久：都要能切，不能无限等
  {
    const noPlaying = decideSceneSwitch({
      target: clip('busy', 0), playing: null, pending: null,
      pendingSince: 0, now: 1000, paused: false, immediate: false,
    });
    check('没有在播的片段就直接播', noPlaying.start && noPlaying.start.key === 'busy#0');

    const paused = decideSceneSwitch({
      target: clip('busy', 0), playing: clip('working', 0), pending: clip('busy', 0),
      pendingSince: 1000, now: 2000, paused: true, immediate: false,
    });
    check('视频暂停时不再等片尾', paused.start && paused.start.key === 'busy#0');

    const timeout = decideSceneSwitch({
      target: clip('busy', 0), playing: clip('working', 0), pending: clip('busy', 0),
      pendingSince: 1000, now: 1000 + 16001, paused: false, immediate: false, maxWaitMs: 16000,
    });
    check('等太久要强切', timeout.start && timeout.start.key === 'busy#0');

    const justInside = decideSceneSwitch({
      target: clip('busy', 0), playing: clip('working', 0), pending: clip('busy', 0),
      pendingSince: 1000, now: 1000 + 15999, paused: false, immediate: false, maxWaitMs: 16000,
    });
    check('没到时限继续等片尾', justInside.start === null);
  }

  // 7. 轮次：同一场景不递增，换场景才递增
  {
    check('同一场景连续播不递增', nextTurnAfterDisplay('rest', 0, 'rest', 2) === 0);
    check('换场景后轮到下一段', nextTurnAfterDisplay('rest', 0, 'working', 2) === 1);
    check('轮次到末尾会绕回第一段', nextTurnAfterDisplay('rest', 1, 'working', 2) === 0);
    check('单段场景永远第 0 段', nextTurnAfterDisplay('grab', 0, 'working', 1) === 0);
  }

  console.log(failures === 0 ? 'PASS: scene scheduler' : `FAILED: ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
})();
