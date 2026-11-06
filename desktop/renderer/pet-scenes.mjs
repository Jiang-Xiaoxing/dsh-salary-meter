// 人物动画场景：把挂件状态映射到 dsh-pet 的九段透明 WebM。
// 这个模块同时被浏览器（客户端）和 node --test 使用，只放纯数据和纯函数。

/** 场景键 → assets/webm 下的文件名。 */
export const SCENE_FILES = Object.freeze({
  caught: 'caught.webm',
  overtime: 'overtime.webm',
  busy: 'busy.webm',
  working: 'working.webm',
  lunch: 'lunch.webm',
  off: 'off.webm',
  before: 'before.webm',
  rest: 'rest.webm',
  idle: 'idle.webm',
});

/** 场景键 → dsh-pet 里的原始动作名，用于文档和预览图。 */
export const SCENE_LABELS = Object.freeze({
  caught: '偷吃零食被抓住',
  overtime: '加班熬夜',
  busy: '工作状态-忙碌点按',
  working: '大口吃零食',
  lunch: '涮火锅',
  off: '工作状态-雀跃庆祝',
  before: '晨间刷牙',
  rest: '悠闲哼歌',
  idle: '待机呼吸休闲',
});

/** 气泡文案按场景走，不再依赖旧画布内部的动作名。 */
export const SCENE_BUBBLES = Object.freeze({
  working: '一边吃一边干。',
  busy: '忙起来了，先扒两口。',
  caught: '饭自己跑嘴里的。',
  lunch: '午休，涮个火锅。',
  off: '收工咯，蹦一个。',
  before: '先刷个牙再开工。',
  rest: '今天休息，哼首歌。',
  idle: '抱着饭碗发会儿呆。',
  overtime: '班是加不完的，饭得吃。',
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

export function isValidScene(scene) {
  return typeof scene === 'string' && Object.hasOwn(SCENE_FILES, scene);
}

export function sceneFileName(scene) {
  return isValidScene(scene) ? SCENE_FILES[scene] : null;
}

export function sceneBubble(scene) {
  return isValidScene(scene) ? SCENE_BUBBLES[scene] : SCENE_BUBBLES.idle;
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
