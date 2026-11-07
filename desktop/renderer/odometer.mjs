// 金额滚轮的纯逻辑：把前后两个金额文本按小数点右对齐，拆成一个个格子。
// 只做计算，不碰 DOM，方便 node 直接跑测试。
// 约定：金额文本形如 "−23.83"、"1,234.56"，小数固定两位，位数可能变化。

/** 是不是一个十进制数字字符。 */
export function isDigitChar(ch) {
  return typeof ch === 'string' && ch.length === 1 && ch >= '0' && ch <= '9';
}

/**
 * 右对齐拆格：位数不同时，多出来的字符算在左边（整数位）。
 * @returns {{from: string|null, to: string|null}[]} 从左到右的格子
 */
export function alignAmounts(prevText, nextText) {
  const prev = [...String(prevText ?? '')];
  const next = [...String(nextText ?? '')];
  const width = Math.max(prev.length, next.length);
  const offsetPrev = prev.length - width;
  const offsetNext = next.length - width;
  const cells = [];
  for (let i = 0; i < width; i++) {
    const p = offsetPrev + i;
    const q = offsetNext + i;
    cells.push({
      from: p >= 0 ? prev[p] : null,
      to: q >= 0 ? next[q] : null,
    });
  }
  return cells;
}

/**
 * 这一格该怎么动：
 *   same   —— 字符没变，完全不动
 *   roll   —— 两边都是数字，在这个格子里上下滚
 *   appear —— 位数变多，新长出来的整数位
 *   vanish —— 位数变少，退掉的整数位
 *   swap   —— 负号、小数点、千分位逗号换了，直接换，不滚
 */
export function cellKind({ from, to }) {
  if (from === to) return 'same';
  if (isDigitChar(from) && isDigitChar(to)) return 'roll';
  if (from === null) return 'appear';
  if (to === null) return 'vanish';
  return 'swap';
}

/** 对齐 + 判定一次算完，方便调用方和测试共用。 */
export function planAmounts(prevText, nextText) {
  return alignAmounts(prevText, nextText).map((cell, index) => ({
    index,
    from: cell.from,
    to: cell.to,
    kind: cellKind(cell),
  }));
}

/** 这次变化里有几格要滚（>=1 说明有位变化）。 */
export function rollingCount(plan) {
  return plan.filter(cell => cell.kind === 'roll').length;
}

/**
 * 机械计数器要转几格：数字从 from 转到 to，顺着数值变化的方向数过去。
 * 例：3→4 涨 = 1 格；9→0 涨 = 1 格（进位）；5→9 涨 = 4 格（真的路过 6、7、8）。
 * 不是数字或者没变化返回 0。
 */
export function reelSteps(from, to, direction = 1) {
  if (!isDigitChar(from) || !isDigitChar(to)) return 0;
  const a = Number(from);
  const b = Number(to);
  if (a === b) return 0;
  return direction >= 0 ? (b - a + 10) % 10 : (a - b + 10) % 10;
}

/** 滚一格大概多久：单格 170ms，每多一格加 55ms，最长封顶 460ms。 */
export function reelDuration(steps) {
  if (!(steps > 0)) return 0;
  return Math.min(460, 170 + steps * 55);
}
