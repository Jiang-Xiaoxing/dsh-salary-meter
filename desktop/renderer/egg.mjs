// 彩蛋的条件判断：只放纯数据和纯函数，供浏览器和 node 检查脚本共用。
// 两个彩蛋共用一个效果（余粮显示清零 3 秒），触发条件不同：
//   连点：3 秒内点到第 6 下开始算，此后每多点一下有 15% 概率
//   待机：连续 5 分钟没碰挂件之后，每 30 秒掷一次，概率 2%

export const EGG = Object.freeze({
  showMs: 3000, // 显示清零停留时间
  clipMs: 10050, // 抓抓抓动画保持时间：整段 10.042 秒播完再收手，别切在动作中间
  bubble: 'token 来，token 来',
});

export const CLICK_EGG = Object.freeze({
  windowMs: 3000, // 连点的统计窗口
  startAt: 6, // 第 6 下开始掷
  chance: 0.15,
});

export const IDLE_EGG = Object.freeze({
  quietMs: 5 * 60 * 1000, // 连续多久没碰挂件
  everyMs: 30 * 1000, // 之后多久掷一次
  chance: 0.02,
});

/** 3 秒窗口内的点击数（同一时刻的旧记录先丢掉）。 */
export function clickStreak(times, now) {
  let count = 0;
  for (const t of times) {
    if (now - t <= CLICK_EGG.windowMs) count += 1;
  }
  return count;
}

/** 这次点击要不要触发：窗口里够 6 下了，并且随机数落在 15% 里。 */
export function rollClickEgg(count, rand) {
  return count >= CLICK_EGG.startAt && rand < CLICK_EGG.chance;
}

/**
 * 待机彩蛋：静默够久、距上次掷骰满 30 秒，才掷一次 2%。
 * 返回是否触发，以及下一次该从什么时候重新计时（没掷就原样带回）。
 */
export function rollIdleEgg({ lastPoke, now, lastRoll, rand }) {
  if (now - lastPoke < IDLE_EGG.quietMs) return { fire: false, lastRoll };
  if (now - lastRoll < IDLE_EGG.everyMs) return { fire: false, lastRoll };
  return { fire: rand < IDLE_EGG.chance, lastRoll: now };
}

/** 静默这么久之后，气泡不该马上冒出来（恢复时要安静）。 */
export function bubbleMuted(eggJustEndedAt, now) {
  return now - eggJustEndedAt < 4500;
}
