/* 本月 token 一格：四格排布、首屏「—」、失败保留、各档位格式化、短窗口可达。
   全程走页面自己的加载逻辑（打开算一次 + 60 秒刷新，preload 把 60 秒压成 300 毫秒），
   不往页面里塞测试钩子，测的就是用户真看到的那条路。 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const assert = require('assert/strict');
const path = require('path');

app.setPath('userData', 'D:/AITools/tmp/salary-month-check');
const FIXTURE = path.join(__dirname, 'month-fixture.json');

/// 北京时间今天 0 点（跟后端的 day_start_ms 同一算法）。测试跑在哪天都能对上。
function bjTodayStart(ms) {
  const t = Number(ms) || Date.now();
  return Math.floor((t + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
}

const SAMPLE = {
  month_start_ms: 1793462400000, // 2026-11-01 00:00 北京时间
  total: 143272024,
  tokens: { input: 130360059, output: 12911965, cache_read: 5472515583, cache_write: 0, events: 18383 },
  today: { input: 6400000, output: 702000, cache_read: 201000000, cache_write: 0, events: 612 },
  today_total: 7102000,
  files: 101,
  files_with_events: 83,
  failed: 0,
  stale: false,
};
// 「今天」那格的日期跟着当天走：写死日期的话，第二天跑这条检查就会把新鲜数据当过期。
SAMPLE.today_start_ms = bjTodayStart(Date.now());

function writeFixture(mode, value) {
  // 写盘前把「今天」的日期对齐到真正的今天：写死日期的话，第二天跑这条检查
  // 就会把新鲜数据当成过期的（前端会按日期核对）。要专门测「过期报告」时
  // 传 __keepStart，就别改。
  const v = value === undefined ? SAMPLE : value;
  if (v && v.today_start_ms !== undefined && !v.__keepStart) {
    v.today_start_ms = bjTodayStart(Date.now());
  }
  fs.writeFileSync(FIXTURE, JSON.stringify({ mode, value: v }));
}

async function open(win) {
  await win.loadFile(path.join(__dirname, '../renderer/settings.html'));
}

/// 轮询等某个表达式返回期望值：离屏窗口的定时器会被限流，死等固定毫秒不稳。
async function waitFor(run, expr, want, timeoutMs = 4000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await run(expr);
    if (JSON.stringify(last) === JSON.stringify(want)) return last;
    await new Promise(r => setTimeout(r, 100));
  }
  return last;
}

app.whenReady().then(async () => {
  let win;
  try {
    // ---- 首屏：慢接口时必须先看到「—」，不能是空白 ----
    writeFixture('slow');
    win = new BrowserWindow({
      show: false, width: 466, height: 660,
      webPreferences: {
        offscreen: true, sandbox: false, contextIsolation: false,
        preload: path.join(__dirname, 'month-preload.cjs'),
      },
    });
    const run = s => win.webContents.executeJavaScript(s);
    await open(win);
    await new Promise(r => setTimeout(r, 250));
    const firstPaint = await run(`(() => {
      const cell = document.querySelector('#monthTokens');
      const today = document.querySelector('#todayTokens');
      return {
        text: cell.textContent,
        todayText: today.textContent,
        visible: cell.getBoundingClientRect().height > 0,
        todayVisible: today.getBoundingClientRect().height > 0,
        cells: document.querySelectorAll('.stat').length,
      };
    })()`);
    assert.equal(firstPaint.text, '—', '首屏应该是「—」，实际：' + firstPaint.text);
    assert.equal(firstPaint.todayText, '—', '今天那格首屏也该是「—」，实际：' + firstPaint.todayText);
    assert.ok(firstPaint.visible, '首屏 token 那格不该是空白的');
    assert.ok(firstPaint.todayVisible, '首屏今天那格不该是空白的');
    assert.equal(firstPaint.cells, 4, '首屏就该看到四格');
    console.log('首屏：四格都在，今天和本月都显示「—」');

    await new Promise(r => setTimeout(r, 1400)); // 等慢接口回来
    assert.equal(await run("document.querySelector('#monthTokens').textContent"), '1.43 亿', '算完该填上');
    assert.equal(await run("document.querySelector('#todayTokens').textContent"), '710 万', '今天那格该填上');

    // ---- 四格 2×2、不溢出、第二列没边框、顺序是「今天 / 本月」两行 ----
    const layout = await run(`(() => {
      const cells = Array.from(document.querySelectorAll('.stat'));
      const boxes = cells.map(n => n.getBoundingClientRect());
      const tps = document.querySelector('.tps-line');
      return {
        count: cells.length,
        rows: new Set(boxes.map(b => Math.round(b.y))).size,
        cols: new Set(boxes.map(b => Math.round(b.x))).size,
        overflow: cells.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.querySelector('span').textContent),
        labels: cells.map(n => n.querySelector('span').textContent),
        borders: cells.map(n => getComputedStyle(n).borderRightWidth),
        pads: cells.map(n => getComputedStyle(n).paddingLeft),
        tokenText: document.querySelector('#monthTokens').textContent,
        subText: document.querySelector('#monthTokensSub').textContent,
        todayText: document.querySelector('#todayTokens').textContent,
        todaySub: document.querySelector('#todayTokensSub').textContent,
        tpsInStats: !!document.querySelector('.stats .tps-line'),
        tpsLine: tps ? tps.textContent.replace(/\\s+/g, ' ').trim() : null,
        tpsOpacity: tps ? Number(getComputedStyle(tps).opacity) : null,
      };
    })()`);
    assert.equal(layout.count, 4, '应该是四格');
    assert.equal(layout.rows, 2, '应该排成两行');
    assert.equal(layout.cols, 2, '应该排成两列');
    assert.deepEqual(layout.overflow, [], '有格子横向溢出：' + layout.overflow);
    assert.deepEqual(
      layout.labels,
      ['今天已赚', '今天 token', '本月累计 · 估算', '本月累计 token'],
      '四格顺序应该按「今天 / 本月」成对排：' + layout.labels
    );
    assert.equal(layout.tokenText, '1.43 亿');
    assert.equal(layout.subText, '本月累计 token');
    assert.equal(layout.todayText, '710 万');
    assert.equal(layout.todaySub, '今天 token');
    assert.equal(layout.borders[1], '0px', '第二列不该有右边框');
    assert.equal(layout.borders[3], '0px', '第二列不该有右边框');
    assert.notEqual(layout.borders[0], '0px', '第一列该有分隔线');
    assert.notEqual(layout.borders[2], '0px', '第一列该有分隔线');
    assert.equal(layout.pads[0], '0px', '第一列左边不该缩进');
    assert.equal(layout.pads[2], '0px', '第一列左边不该缩进');
    // tps 从四格里挪出去了，单独一行、颜色更淡
    assert.equal(layout.tpsInStats, false, 'tps 不该再占四格里的位置');
    assert.ok(layout.tpsLine && layout.tpsLine.includes('token/s'), 'tps 那行没渲染：' + layout.tpsLine);
    assert.ok(layout.tpsOpacity !== null && layout.tpsOpacity < 1, 'tps 那行该比小字更淡');
    console.log('四格 2×2：', layout.labels.join(' / '), '|', layout.todayText, layout.tokenText, '| tps 行：', layout.tpsLine);

    // ---- 悬停写全 ----
    const title = await run("document.querySelector('#monthTokens').parentNode.title");
    for (const expect of ['输入 130,360,059', '输出 12,911,965', '缓存读 5,472,515,583', '18,383 笔', '83 个会话']) {
      assert.ok(title.includes(expect), 'title 缺「' + expect + '」：' + title);
    }
    const todayTitle = await run("document.querySelector('#todayTokens').parentNode.title");
    for (const expect of ['输入 6,400,000', '输出 702,000', '缓存读 201,000,000', '612 笔']) {
      assert.ok(todayTitle.includes(expect), '今天那格的 title 缺「' + expect + '」：' + todayTitle);
    }
    console.log('title：' + title);
    console.log('今天 title：' + todayTitle);

    // ---- 后台正忙（report 为 null）：必须保持「—」，不能显示 0 或上个月 ----
    writeFixture('value');
    await waitFor(run, "document.querySelector('#monthTokens').textContent", '1.43 亿');
    writeFixture('empty'); // 模拟 stale + report:null
    await new Promise(r => setTimeout(r, 1200));
    {
      const after = await run("({m:document.querySelector('#monthTokens').textContent, s:document.querySelector('#monthTokensSub').textContent, t:document.querySelector('#todayTokens').textContent})");
      // 这一轮没有可用数：旧值不该被 0 覆盖，也不该被清空
      assert.notEqual(after.m, '0', '后台没算完时不能把 0 当成本月数：' + JSON.stringify(after));
      assert.ok(after.m === '1.43 亿' || after.m === '—', '后台没算完时应保持旧值或「—」，实际：' + JSON.stringify(after));
      assert.notEqual(after.t, '0', '后台没算完时不能把 0 当成今天的数：' + JSON.stringify(after));
      console.log('后台正忙（report=null）：显示 ' + after.m + ' / ' + after.t + '，没有拿 0 冒充');
    }

    // ---- 报告是昨天扫出来的（跨零点前那次扫描）：今天那格必须清成「—」，本月照常 ----
    writeFixture('value', Object.assign({}, SAMPLE, {
      today_start_ms: bjTodayStart(Date.now()) - 86400000, __keepStart: true,
    }));
    const staleToday = await waitFor(run, "({t:document.querySelector('#todayTokens').textContent, m:document.querySelector('#monthTokens').textContent})",
      { t: '—', m: '1.43 亿' });
    assert.deepEqual(staleToday, { t: '—', m: '1.43 亿' },
      '昨天的「今天」数据不该挂在脸上：' + JSON.stringify(staleToday));
    console.log('跨零点的旧报告：今天那格清成「—」，本月照常');

    // ---- 5 秒轮询只刷金额，不能把「保存失败」这行提示抹掉 ----
    writeFixture('value');
    await waitFor(run, "document.querySelector('#monthTokens').textContent", '1.43 亿');
    {
      // 手动把校验提示写上，等一轮 5 秒轮询，看它还在不在
      await run("document.querySelector('#diag').textContent='保存失败，请再试一次'");
      await new Promise(r => setTimeout(r, 5600));
      const diag = await run("document.querySelector('#diag').textContent");
      assert.equal(diag, '保存失败，请再试一次', '轮询把保存失败的提示清掉了：' + JSON.stringify(diag));
      console.log('5 秒轮询没清掉「保存失败」提示');
      await run("document.querySelector('#diag').textContent=''");
    }

    // ---- 「今天已赚」要跟着时间走：把页面时钟往后拨，等一轮 5 秒轮询，金额必须变 ----
    writeFixture('value');
    await waitFor(run, "document.querySelector('#monthTokens').textContent", '1.43 亿');
    {
      // 页面里临时替换 Date，不影响 Electron 自己的定时器；测完还原。
      await run(`(() => {
        const before = document.querySelector('#perDay').textContent;
        const Real = window.Date;
        const fake = Real.now() + 90 * 60 * 1000; // 拨快 90 分钟
        class FakeDate extends Real {
          constructor(...args) { if (args.length === 0) super(fake); else super(...args); }
          static now() { return fake; }
        }
        window.__realDate = Real;
        window.__perDayBefore = before;
        window.Date = FakeDate;
        return before;
      })()`);
      await new Promise(r => setTimeout(r, 5600)); // 等一轮 5 秒轮询
      const moved = await run("({before:window.__perDayBefore, after:document.querySelector('#perDay').textContent})");
      assert.notEqual(moved.after, moved.before,
        '时钟往后拨 90 分钟，5 秒轮询后「今天已赚」应该变，实际没变：' + JSON.stringify(moved));
      console.log('今天已赚跟着时间走：' + moved.before + ' → ' + moved.after);
      // 还原时钟，别影响后面几项（末尾返回 true，别把 Date 构造函数序列化回去）
      await run("window.Date = window.__realDate; true");
    }

    // ---- 老后端（没有 today 字段）：新开一个窗口首屏，今天那格必须守「—」，不拿 0 冒充 ----
    writeFixture('legacy');
    {
      const w2 = new BrowserWindow({
        show: false, width: 466, height: 660,
        webPreferences: {
          offscreen: true, sandbox: false, contextIsolation: false,
          preload: path.join(__dirname, 'month-preload.cjs'),
        },
      });
      await w2.loadFile(path.join(__dirname, '../renderer/settings.html'));
      const run2 = s => w2.webContents.executeJavaScript(s);
      await waitFor(run2, "document.querySelector('#monthTokens').textContent", '1.43 亿');
      const legacy = await run2("({t:document.querySelector('#todayTokens').textContent, m:document.querySelector('#monthTokens').textContent})");
      assert.equal(legacy.t, '—', '后端没给 today 时今天那格该显示「—」，实际：' + legacy.t);
      assert.equal(legacy.m, '1.43 亿', '本月那格不该受影响，实际：' + legacy.m);
      w2.destroy();
      console.log('老后端无 today 字段：今天那格首屏显示「—」，本月照常');
    }

    // ---- 接口失败：保留旧值，不清零 ----
    writeFixture('value');
    // 等「今天」那格也回来（上面 legacy 那轮把它清成了「—」）
    await waitFor(run, "document.querySelector('#todayTokens').textContent", '710 万');
    writeFixture('error');
    await new Promise(r => setTimeout(r, 1200)); // 等压缩后的刷新跑一轮（离屏窗口会限流）
    assert.equal(await run("document.querySelector('#monthTokens').textContent"), '1.43 亿', '失败后不该清空');
    assert.equal(await run("document.querySelector('#monthTokensSub').textContent"), '本月累计 token', '失败后小字不该清空');
    assert.equal(await run("document.querySelector('#todayTokens').textContent"), '710 万', '失败后今天那格不该被清空');
    console.log('失败保留旧值：1.43 亿 / 710 万');

    // ---- 各档位格式化（走真接口形状） ----
    const cases = [
      [{ input: 999, output: 0, events: 1 }, '999', '本月累计 token'],
      [{ input: 12345, output: 0, events: 1 }, '1 万', '本月累计 token'],
      [{ input: 1234567, output: 0, events: 1 }, '123 万', '本月累计 token'],
      [{ input: 0, output: 0, events: 0 }, '0', '本月累计 token'],
    ];
    for (const [tokens, wantMain, wantSub] of cases) {
      writeFixture('value', {
        month_start_ms: SAMPLE.month_start_ms, total: tokens.input,
        tokens: Object.assign({ cache_read: 0, cache_write: 0 }, tokens),
        today: { input: 0, output: 0, cache_read: 0, cache_write: 0, events: 0 },
        today_total: 0, today_start_ms: SAMPLE.today_start_ms,
        files: 1, files_with_events: 1, failed: 0, stale: false,
      });
      const got = await waitFor(run, "[document.querySelector('#monthTokens').textContent,document.querySelector('#monthTokensSub').textContent]", [wantMain, wantSub]);
      assert.deepEqual(got, [wantMain, wantSub], '格式化不对，想要 ' + JSON.stringify([wantMain, wantSub]) + '，实际 ' + JSON.stringify(got));
    }
    // 今天那格也走一遍档位
    for (const [value, want] of [[888, '888'], [23456, '2 万'], [3456789, '346 万'], [0, '0']]) {
      writeFixture('value', Object.assign({}, SAMPLE, {
        today: { input: value, output: 0, cache_read: 0, cache_write: 0, events: value ? 1 : 0 },
        today_total: value,
      }));
      const got = await waitFor(run, "document.querySelector('#todayTokens').textContent", want);
      assert.equal(got, want, '今天那格格式化不对，想要 ' + want + '，实际 ' + got);
    }
    console.log('格式化：999 / 1 万 / 123 万 / 0 都对，今天那格也对');

    // ---- 坏文件时小字要标出来 ----
    writeFixture('value', Object.assign({}, SAMPLE, { failed: 2 }));
    const bad = await waitFor(run, "(() => { const r = document.querySelector('#monthTokensSub'); return {text: r.textContent, title: r.title}; })()", { text: '本月累计 token', title: '2 个会话日志解压失败，数字偏小' });
    assert.equal(bad.title, '2 个会话日志解压失败，数字偏小', '坏文件数没在提示里：' + JSON.stringify(bad));
    console.log('坏文件提示：' + bad.title);

    // ---- 截图（回到正常数据） ----
    writeFixture('value');
    await waitFor(run, "document.querySelector('#monthTokens').textContent", '1.43 亿');
    await run("document.querySelector('.stats').scrollIntoView({block:'center'})");
    await new Promise(r => setTimeout(r, 200));
    fs.writeFileSync(path.join(__dirname, 'month-tokens-440.png'), (await win.webContents.capturePage()).toPNG());
    fs.copyFileSync(path.join(__dirname, 'month-tokens-440.png'), 'E:/SalaryMeter/checks/month-tokens-440.png');

    // ---- 短窗口 500：底部仍能滚到 ----
    win.setContentSize(466, 500);
    await new Promise(r => setTimeout(r, 350));
    const short = await run(`(() => {
      const foot = document.querySelector('.foot');
      foot.scrollIntoView({block:'end'});
      return new Promise(ok => requestAnimationFrame(() => {
        const r = foot.getBoundingClientRect();
        ok({ scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight, bottom: r.bottom });
      }));
    })()`);
    assert.ok(short.scrollH > short.clientH, '短窗口应能滚');
    assert.ok(short.bottom <= short.clientH + 2, '滚到底页脚仍被裁：' + JSON.stringify(short));
    console.log('短窗口 500 可滚到底：', JSON.stringify(short));

    // ---- 长窗口 660：不该出现无谓滚动 ----
    win.setContentSize(466, 660);
    await new Promise(r => setTimeout(r, 300));
    const tall = await run("({scrollH:document.documentElement.scrollHeight,clientH:document.documentElement.clientHeight})");
    console.log('660 高：', JSON.stringify(tall), tall.scrollH > tall.clientH ? '(有滚动，属正常：内容本来就高于窗口)' : '(无滚动)');

    console.log('PASS: 首屏破折号(今天+本月) / 四格 2×2 顺序 / tps 挪出四格 / 边框与缩进 / title 全量 / 后台忙守破折号 / 跨零点旧报告清今天 / 轮询不抹校验提示 / 老后端守破折号 / 失败保留 / 各档位格式 / 坏文件提示 / 短窗口可达');
    app.exit(0);
  } catch (e) {
    console.error(e);
    try { fs.writeFileSync(path.join(__dirname, 'month-fail.png'), ''); } catch (_) {}
    app.exit(1);
  }
});
