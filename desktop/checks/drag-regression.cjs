/* 拖动逻辑回归：人物/余额能拖，轻点不拖，拖完不误点，点按钮不拖，
   左键松开后（mouseup 丢失）不会被残留状态带着拖。
   跑法：cd E:\SalaryMeter\plugin && node desktop\checks\drag-regression.cjs */
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');

function target() {
  return {
    events: {},
    addEventListener(k, f) { (this.events[k] ??= []).push(f); },
    fire(k, e) { for (const f of this.events[k] || []) f(e); },
  };
}

const win = target(), pet = target(), balance = target();
let drag = 0, calls = [];
win.__TAURI__ = {
  core: { invoke: async (k, p) => { calls.push([k, p]); if (k === 'start_pet_drag') drag++; } },
  event: { listen() {} },
  window: { getCurrentWindow: () => ({ startDragging: async () => { drag++; } }) },
};
const doc = { querySelectorAll: () => [], querySelector: () => pet, getElementById: () => balance };
vm.runInNewContext(fs.readFileSync('desktop/renderer/tauri-shim.js', 'utf8'), { window: win, document: doc, console });
win.fire('DOMContentLoaded');
const settle = () => new Promise(r => setImmediate(r));

// mousedown 用 button=0 / buttons=1；mousemove 的 buttons 决定左键是否按着
const md = (node, x, btn) => ({ button: 0, buttons: 1, screenX: x, screenY: 10, target: { closest: () => btn ?? node } });
const mm = (x, buttons = 1) => ({ buttons, screenX: x, screenY: 10, target: { closest: () => null } });

(async () => {
  // 1. 人物：阈值内不动，超过 8px 才拖
  pet.fire('mousedown', md(pet, 10));
  win.fire('mousemove', mm(13)); await settle();
  assert.equal(drag, 0, '阈值内不该拖');
  win.fire('mousemove', mm(30)); await settle();
  assert.equal(drag, 1, '超过阈值该拖');

  // 2. 拖完吞掉一次 click，防止松手误触展开/收起
  let blocked = false;
  pet.fire('click', { preventDefault() {}, stopImmediatePropagation() { blocked = true; } });
  assert.ok(blocked, '拖完应吞一次 click');

  // 3. 模拟 mouseup 丢失：拖了一次之后不再发 mouseup
  win.fire('mouseup', {});
  pet.fire('mousedown', md(pet, 10));
  win.fire('mousemove', mm(30)); await settle();
  assert.equal(drag, 2);

  // 4. armed 残留但左键已松开 -> 不该拖
  pet.fire('mousedown', md(pet, 10));
  win.fire('mousemove', mm(60, 0)); await settle();
  assert.equal(drag, 2, '左键没按着不该拖');

  // 5. armed 残留 + 按在按钮上 -> 不该拖（13:07 的 bug）
  pet.fire('mousedown', md(pet, 10));
  pet.fire('mousedown', md(pet, 10, { tagName: 'BUTTON' }));
  win.fire('mousemove', mm(30)); await settle();
  assert.equal(drag, 2, '按在按钮上不该拖');

  // 6. 余额区能拖
  balance.fire('mousedown', md(balance, 10));
  win.fire('mousemove', mm(30)); await settle();
  assert.equal(drag, 3, '余额区该能拖');

  console.log('PASS: 阈值 / 拖后吞click / 左键松开不拖 / 点按钮不拖 / 余额能拖');
})();
