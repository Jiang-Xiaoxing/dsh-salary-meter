// 金额滚轮对齐 logic 的回归检查：
//   node desktop\checks\odometer.cjs
// 只跑纯函数，不开窗口。

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`);
  }
}

function kinds(plan) {
  return plan.map(cell => cell.kind).join(',');
}

(async () => {
  const odo = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'odometer.mjs')).href);

  // 1. 用户举的第一个例子：−23.83 → −23.84，只有最后一位滚
  {
    const plan = odo.planAmounts('−23.83', '−23.84');
    check('−23.83→−23.84 只有 1 格滚', odo.rollingCount(plan) === 1, kinds(plan));
    check('滚的是最后一位 3→4', plan[plan.length - 1].kind === 'roll' && plan[plan.length - 1].from === '3' && plan[plan.length - 1].to === '4');
    check('负号不动', plan[0].from === '−' && plan[0].kind === 'same');
    check('小数点不动', plan[3].from === '.' && plan[3].kind === 'same');
    check('整数位不动', plan.slice(1, 3).every(cell => cell.kind === 'same'));
  }

  // 2. 用户举的第二个例子：−23.89 → −23.90，两位各滚各的
  {
    const plan = odo.planAmounts('−23.89', '−23.90');
    check('−23.89→−23.90 有 2 格滚', odo.rollingCount(plan) === 2, kinds(plan));
    check('8→9 和 9→0 都在滚', plan[4].kind === 'roll' && plan[4].to === '9' && plan[5].kind === 'roll' && plan[5].to === '0');
    check('小数点在第 4 格且不动', plan[3].from === '.' && plan[3].kind === 'same');
    check('前面 2、3 没被带着动', plan[1].kind === 'same' && plan[2].kind === 'same');
  }

  // 3. 位数变多：9.99 → 10.00
  {
    const plan = odo.planAmounts('9.99', '10.00');
    check('9.99→10.00 最左边长出一位', plan[0].kind === 'appear' && plan[0].to === '1');
    check('9.99→10.00 三位数字各滚', odo.rollingCount(plan) === 3, kinds(plan));
    check('小数点仍然不动', plan[2].from === '.' && plan[2].kind === 'same');
  }

  // 4. 位数变少：100.00 → 99.99
  {
    const plan = odo.planAmounts('100.00', '99.99');
    check('100.00→99.99 最左边退掉一位', plan[0].kind === 'vanish' && plan[0].from === '1');
    check('退位不是滚动', !plan.some(cell => cell.kind === 'roll' && cell.from === null));
  }

  // 5. 负数变负数：−5.00 → −5.01
  {
    const plan = odo.planAmounts('−5.00', '−5.01');
    check('−5.00→−5.01 只滚最后一位', odo.rollingCount(plan) === 1 && plan[plan.length - 1].to === '1');
  }

  // 6. 符号出现/消失时负号不滚，直接换
  {
    const add = odo.planAmounts('5.00', '−5.00');
    check('由正转负：负号是 appear 不是 roll', add[0].kind === 'appear' && add[0].to === '−');
    check('由正转负：数字没变就不动', add.slice(1).every(cell => cell.kind === 'same'));
    const drop = odo.planAmounts('−5.00', '5.00');
    check('由负转正：负号是 vanish', drop[0].kind === 'vanish' && drop[0].from === '−');
  }

  // 7. 千分位逗号：1,999.99 → 2,000.00，逗号不动，数字各滚
  {
    const plan = odo.planAmounts('1,999.99', '2,000.00');
    check('千分位逗号不动', plan[1].from === ',' && plan[1].kind === 'same');
    check('1,999.99→2,000.00 六格滚', odo.rollingCount(plan) === 6, kinds(plan));
  }

  // 8. 过千长出逗号：999.99 → 1,000.00
  {
    const plan = odo.planAmounts('999.99', '1,000.00');
    check('999.99→1,000.00 左边长两位（1 和逗号）', plan[0].kind === 'appear' && plan[0].to === '1' && plan[1].kind === 'appear' && plan[1].to === ',');
    check('999.99→1,000.00 小数点不动', plan[5].from === '.' && plan[5].kind === 'same');
  }

  // 9. 没变化就一格都不动
  {
    const plan = odo.planAmounts('23.84', '23.84');
    check('数字没变：全部 same', plan.every(cell => cell.kind === 'same'));
  }

  // 10. 首屏：从空串建
  {
    const plan = odo.planAmounts('', '12.34');
    check('首屏建号：五格全是 appear', plan.length === 5 && plan.every(cell => cell.kind === 'appear'));
  }

  // 11. 机械滚轮：转几格、转多久
  {
    check('3→4 涨：转 1 格', odo.reelSteps('3', '4', 1) === 1, odo.reelSteps('3', '4', 1));
    check('9→0 涨：进位转 1 格', odo.reelSteps('9', '0', 1) === 1, odo.reelSteps('9', '0', 1));
    check('5→9 涨：转 4 格（路过 6、7、8）', odo.reelSteps('5', '9', 1) === 4, odo.reelSteps('5', '9', 1));
    check('4→3 跌：倒转 1 格', odo.reelSteps('4', '3', -1) === 1, odo.reelSteps('4', '3', -1));
    check('0→9 跌：借位倒转 1 格', odo.reelSteps('0', '9', -1) === 1, odo.reelSteps('0', '9', -1));
    check('9→5 跌：倒转 4 格', odo.reelSteps('9', '5', -1) === 4, odo.reelSteps('9', '5', -1));
    check('同数字不转', odo.reelSteps('7', '7', 1) === 0);
    check('不是数字不转', odo.reelSteps('.', '4', 1) === 0);
    check('一格 225ms', odo.reelDuration(1) === 225, odo.reelDuration(1));
    check('四格 390ms', odo.reelDuration(4) === 390, odo.reelDuration(4));
    check('再快也封顶 460ms', odo.reelDuration(10) === 460, odo.reelDuration(10));
    check('不转就没有时长', odo.reelDuration(0) === 0);
  }

  if (failures) {
    console.log(`\nFAILED: ${failures} 项不通过`);
    process.exit(1);
  }
  console.log('\nPASS: 右对齐 / 只滚变的位 / 负号小数点逗号不动 / 进位退位与位数变化都算对');
})();
