// 人物动画场景：把挂件状态映射到 dsh-pet 的九段透明 WebM。
// 一个场景可以挂多段片段：每次重新进入这个场景就换下一段（轮着来，不重复）。
// 这个模块同时被浏览器（客户端）和 node --test 使用，只放纯数据和纯函数。

/** 场景键 → assets/webm 下的文件名数组，多段的按顺序轮播。 */
export const SCENE_CLIPS = Object.freeze({
  caught: Object.freeze(['caught.webm']),
  overtime: Object.freeze(['overtime.webm']),
  busy: Object.freeze(['busy.webm']),
  working: Object.freeze(['working.webm']),
  lunch: Object.freeze(['lunch.webm', 'sleep.webm']),
  off: Object.freeze(['off.webm']),
  before: Object.freeze(['before.webm']),
  rest: Object.freeze(['rest.webm', 'gaming.webm']),
  idle: Object.freeze(['idle.webm']),
});

/** 兼容旧调用：场景键 → 第一段文件名。 */
export const SCENE_FILES = Object.freeze(
  Object.fromEntries(Object.entries(SCENE_CLIPS).map(([scene, clips]) => [scene, clips[0]])),
);

/** 场景键 → dsh-pet 里的原始动作名，用于文档和预览图。 */
export const SCENE_LABELS = Object.freeze({
  caught: '偷吃零食被抓住',
  overtime: '加班熬夜',
  busy: '工作状态-忙碌点按',
  working: '大口吃零食',
  lunch: '涮火锅 / 趴着睡一会儿',
  off: '工作状态-雀跃庆祝',
  before: '晨间刷牙',
  rest: '悠闲哼歌 / 玩游戏气急败坏',
  idle: '待机呼吸休闲',
});

/** 气泡文案按场景走，一段片段一条，顺序和 SCENE_CLIPS 对齐。 */
export const SCENE_BUBBLES = Object.freeze({
  working: Object.freeze(['一边吃一边干。']),
  busy: Object.freeze(['忙起来了，先扒两口。']),
  caught: Object.freeze(['饭自己跑嘴里的。']),
  lunch: Object.freeze(['午休，涮个火锅。', '趴一会儿，别叫醒我。']),
  off: Object.freeze(['收工咯，蹦一个。']),
  before: Object.freeze(['先刷个牙再开工。']),
  rest: Object.freeze(['今天休息，哼首歌。', '开黑，输赢不论。']),
  idle: Object.freeze(['抱着饭碗发会儿呆。']),
  overtime: Object.freeze(['班是加不完的，饭得吃。']),
});

/** 工资状态里属于「今天没在上班」的几种，忙起来时算加班。 */
const OFF_DUTY = new Set(['off', 'before', 'rest']);
/** 工资本身就能映射成场景的状态，其余一律交给 idle 兜底。 */
const WAGE_SCENES = new Set(['working', 'lunch', 'off', 'before', 'rest']);

export const SCENE_ORDER = Object.freeze([
  'working',
  'busy',
  'caught',
  'lunch',
  'off',
  'before',
  'rest',
  'overtime',
  'idle',
]);

/** 把任意整数折进 [0, size) 的区间，负数也能用。 */
function wrap(turn, size) {
  const step = Math.trunc(Number(turn) || 0);
  return ((step % size) + size) % size;
}

export function isValidScene(scene) {
  return typeof scene === 'string' && Object.hasOwn(SCENE_CLIPS, scene);
}

/** 这个场景挂了几段片段；无效场景返回 0。 */
export function clipCount(scene) {
  return isValidScene(scene) ? SCENE_CLIPS[scene].length : 0;
}

/** 取这个场景的第 turn 段（越界自动绕回）。 */
export function sceneFileName(scene, turn = 0) {
  if (!isValidScene(scene)) return null;
  const clips = SCENE_CLIPS[scene];
  return clips[wrap(turn, clips.length)];
}

/** 取第 turn 段对应的气泡文案；无效场景退回 idle。 */
export function sceneBubble(scene, turn = 0) {
  const lines = isValidScene(scene) ? SCENE_BUBBLES[scene] : SCENE_BUBBLES.idle;
  return lines ? lines[wrap(turn, lines.length)] : SCENE_BUBBLES.idle[0];
}

/**
 * 按优先级挑场景：caught > overtime > busy > 工资状态 > idle。
 * @param {{phase?: string, busy?: boolean, caught?: boolean}} state
 *   phase 来自 core.computeWage 的 phase 字段；
 *   busy 表示模型正在跑或刚产生费用；caught 表示刚点了人物。
 */
export function pickScene({ phase, busy = false, caught = false } = {}) {
  if (caught) return 'caught';
  if (busy && OFF_DUTY.has(phase)) return 'overtime';
  if (busy) return 'busy';
  return WAGE_SCENES.has(phase) ? phase : 'idle';
}
