/**
 * 场景切换的纯决策：什么时候该「等片尾」，什么时候该「立刻切」。
 *
 * 单独拿出来是为了能不依赖 DOM、不依赖真视频就跑测试：
 * widget.js 里只负责「加载/播放/提交」，判断全在这里。
 *
 * 规则：
 * - 目标就是正在播的片段 → 清掉 pending
 * - 普通变化 → 只更新 pending（最新目标覆盖旧的），等片尾再切
 * - 立刻抢占（彩蛋、被抓、游戏许可被撤销）→ 当场切
 * - 没有正在播的、暂停了、或者等太久 → 也当场切，不能无限等
 *
 * @param {object} input
 * @param {{scene: string, turn: number, key: string} | null} input.target 想播的目标
 * @param {{key: string} | null} input.playing 正在播的片段
 * @param {{scene: string, turn: number, key: string} | null} input.pending 当前挂着的待切目标
 * @param {number} input.pendingSince pending 从什么时候开始等（毫秒时钟）
 * @param {number} input.now 当前时间（毫秒时钟）
 * @param {boolean} input.paused 正在播的片段是否暂停/结束了
 * @param {boolean} input.immediate 是否允许立刻抢占
 * @param {number} [input.maxWaitMs] 最多等多久，超时就强切
 * @returns {{pending: object|null, pendingSince: number, start: object|null}}
 */
export function decideSceneSwitch({
  target,
  playing,
  pending,
  pendingSince,
  now,
  paused,
  immediate,
  maxWaitMs = 16000,
}) {
  if (!target) return { pending, pendingSince, start: null };

  // 已经就是这个片段：不用切，待切也作废
  if (playing && playing.key === target.key) {
    return { pending: null, pendingSince: 0, start: null };
  }

  // 目标变了才重置等待起点；同一目标继续等，时间不能每帧刷新
  const changed = !pending || pending.key !== target.key;
  const nextPending = changed ? target : pending;
  const nextSince = changed ? now : pendingSince;

  const nothingPlaying = !playing;
  const waitedTooLong = now - nextSince > maxWaitMs;
  if (immediate || nothingPlaying || paused || waitedTooLong) {
    return { pending: nextPending, pendingSince: nextSince, start: nextPending };
  }
  return { pending: nextPending, pendingSince: nextSince, start: null };
}

/**
 * 片尾到了以后该做什么：有目标就切目标，没有就重播当前这一段。
 * @param {{key: string} | null} pending
 * @returns {{restart: boolean, start: object|null}}
 */
export function decideAfterClipEnded(pending) {
  if (pending) return { restart: false, start: pending };
  return { restart: true, start: null };
}

/**
 * 一段播完、真正进入某个场景时才轮到下一段；同一个场景连续播（含游戏被替换成哼歌）不递增。
 * @param {string} scene 场景名
 * @param {number} turn 这一段是第几段
 * @param {string|null} previousScene 上一段属于哪个场景
 * @param {number} count 这个场景一共有几段
 * @returns {number} 下一段该播第几段
 */
export function nextTurnAfterDisplay(scene, turn, previousScene, count) {
  if (previousScene === scene) return turn;
  return (turn + 1) % Math.max(1, count);
}
