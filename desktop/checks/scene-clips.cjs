// 人物动画片段轮播的回归检查：
//   node desktop\checks\scene-clips.cjs
// 只跑纯数据和磁盘文件检查，不开窗口、不需要显示器。

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const WEBM_DIR = path.join(ROOT, 'renderer', 'assets', 'webm');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`);
  }
}

(async () => {
  const scenes = await import(pathToFileURL(path.join(ROOT, 'renderer', 'pet-scenes.mjs')).href);

  // 1. 场景清单没漏
  const expected = ['caught', 'overtime', 'busy', 'working', 'lunch', 'off', 'before', 'rest', 'idle', 'grab'];
  for (const scene of expected) {
    check(`场景 ${scene} 有片段`, scenes.clipCount(scene) > 0, `clipCount=${scenes.clipCount(scene)}`);
  }
  check('十场景都在（含彩蛋的 grab）', expected.every(s => scenes.isValidScene(s)));
  check('未知场景不认', !scenes.isValidScene('sleep'));
  check('彩蛋场景用新动画 grab.webm', scenes.sceneFileName('grab', 0) === 'grab.webm', scenes.sceneFileName('grab', 0));
  check('彩蛋气泡是 token 来', scenes.sceneBubble('grab', 0) === 'token 来，token 来。', scenes.sceneBubble('grab', 0));

  // 2. 每个引用的文件都真的在磁盘上
  for (const [scene, clips] of Object.entries(scenes.SCENE_CLIPS)) {
    for (const clip of clips) {
      const file = path.join(WEBM_DIR, clip);
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      check(`${scene} → ${clip} 存在且非空`, size > 1000, `${size} 字节`);
    }
  }

  // 3. 午休：火锅和睡觉轮着来
  check('午休两段', scenes.clipCount('lunch') === 2, `clipCount=${scenes.clipCount('lunch')}`);
  check('午休第 0 段是火锅', scenes.sceneFileName('lunch', 0) === 'lunch.webm', scenes.sceneFileName('lunch', 0));
  check('午休第 1 段是睡觉', scenes.sceneFileName('lunch', 1) === 'sleep.webm', scenes.sceneFileName('lunch', 1));
  check('午休第 2 段绕回火锅', scenes.sceneFileName('lunch', 2) === 'lunch.webm', scenes.sceneFileName('lunch', 2));
  check('午休负数也能绕回', scenes.sceneFileName('lunch', -1) === 'sleep.webm', scenes.sceneFileName('lunch', -1));

  // 4. 休息日：哼歌和打游戏轮着来
  check('休息日两段', scenes.clipCount('rest') === 2, `clipCount=${scenes.clipCount('rest')}`);
  check('休息日第 0 段是哼歌', scenes.sceneFileName('rest', 0) === 'rest.webm', scenes.sceneFileName('rest', 0));
  check('休息日第 1 段是打游戏', scenes.sceneFileName('rest', 1) === 'gaming.webm', scenes.sceneFileName('rest', 1));

  // 5. 气泡文案和片段一一对应
  check('火锅配火锅文案', scenes.sceneBubble('lunch', 0) === '午休，涮个火锅。', scenes.sceneBubble('lunch', 0));
  check('睡觉配睡觉文案', scenes.sceneBubble('lunch', 1) === '趴一会儿，别叫醒我。', scenes.sceneBubble('lunch', 1));
  check('哼歌配哼歌文案', scenes.sceneBubble('rest', 0) === '今天休息，哼首歌。', scenes.sceneBubble('rest', 0));
  check('打游戏配开黑文案', scenes.sceneBubble('rest', 1) === '开黑，输赢不论。', scenes.sceneBubble('rest', 1));
  check('气泡条数和片段数一致', Object.entries(scenes.SCENE_CLIPS).every(([scene, clips]) => scenes.SCENE_BUBBLES[scene].length === clips.length));

  // 6. 单段场景不受影响
  check('单段场景第 1 段还是自己', scenes.sceneFileName('idle', 1) === 'idle.webm', scenes.sceneFileName('idle', 1));
  check('无效场景取不到文件', scenes.sceneFileName('nope') === null);

  // 7. 场景挑选用原来的优先级：彩蛋 > 被抓 > 加班 > 忙碌 > 工资状态
  check('彩蛋最高优先', scenes.pickScene({ phase: 'working', caught: true, egg: true }) === 'grab');
  check('点人物优先播被抓', scenes.pickScene({ phase: 'working', caught: true }) === 'caught');
  check('休息日忙碌算加班', scenes.pickScene({ phase: 'rest', busy: true }) === 'overtime');
  check('上班忙碌播忙碌', scenes.pickScene({ phase: 'working', busy: true }) === 'busy');
  check('午休不忙播午休', scenes.pickScene({ phase: 'lunch' }) === 'lunch');
  check('未知状态退回待机', scenes.pickScene({ phase: 'weird' }) === 'idle');

  // 8. 休息日打游戏那段：模型在跑 / 用户在动时不播
  check('闲时第 1 段照播打游戏', scenes.guardTurn('rest', 1, true) === 1);
  check('忙时第 1 段换成哼歌', scenes.guardTurn('rest', 1, false) === 0);
  check('忙时第 0 段不受影响', scenes.guardTurn('rest', 0, false) === 0);
  check('别的场景不受影响', scenes.guardTurn('lunch', 1, false) === 1);

  if (failures) {
    console.log(`\nFAILED: ${failures} 项不通过`);
    process.exit(1);
  }
  console.log('\nPASS: 十场景齐全 / 文件都在 / 午休与休息日各两段轮播 / 气泡对齐 / 优先级不变 / 忙时不播打游戏');
})();
