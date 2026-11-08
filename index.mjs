import { readFile, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, validateConfig, chinaDay, recordExpense, setPrices, defaultPrices, usageFromEvent, estimateExpense } from './core.mjs';

export const name = 'salary-meter';
export const inject = ['connection', 'sessions'];
const packageRoot = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// 列出正在运行的工资挂件进程。只认可执行文件全路径，避免同名进程误伤。
async function listWidgetProcesses(exePath) {
  if (process.platform !== 'win32' || !exePath) return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='SalaryMeter.exe'\" | Select-Object ProcessId,ExecutablePath,@{n='StartedAt';e={ if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' } }} | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true });
    const text = String(stdout).trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter(item => item && typeof item.ExecutablePath === 'string' && item.ExecutablePath.toLowerCase() === exePath.toLowerCase())
      .map(item => ({ pid: item.ProcessId, startedAt: item.StartedAt || null }));
  } catch {
    return [];
  }
}

function resolveWidgetExe() {
  const candidates = [
    process.env.SALARY_METER_EXE,
    join(packageRoot, 'SalaryMeter.exe'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'SalaryMeter', 'SalaryMeter.exe') : null,
    'E:\\SalaryMeter\\SalaryMeter.exe',
    'C:\\Program Files\\SalaryMeter\\SalaryMeter.exe',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function apply(ctx) {
  // 桌面挂件：插件启用时拉起，插件停用时收走——「已安装插件」列表里的开关直接控制它。
  const widgetExe = resolveWidgetExe();
  let managedWidget = null;
  let widgetChild = null;
  async function ensureWidget() {
    if (!widgetExe) return;
    // 已有实例（用户手动开的、或开机自启的）就复用，绝不重复开第二个。
    if ((await listWidgetProcesses(widgetExe)).length > 0) return;
    try {
      // 把本进程号带过去：DSH 一退（哪怕是崩溃/强杀），挂件自己会退，不留在桌面上当孤儿。
      const child = spawn(widgetExe, [], {
        stdio: 'ignore',
        windowsHide: false,
        cwd: dirname(widgetExe),
        env: { ...process.env, SALARYMETER_HOST_PID: String(process.pid) },
      });
      widgetChild = child;
      child.on('exit', () => { if (widgetChild === child) widgetChild = null; });
      child.unref();
      const pid = child.pid;
      await new Promise(resolve => setTimeout(resolve, 900));
      const found = (await listWidgetProcesses(widgetExe)).find(item => item.pid === pid);
      managedWidget = { pid, startedAt: found?.startedAt ?? null };
    } catch {
      managedWidget = null;
    }
  }
  async function releaseWidget() {
    const record = managedWidget;
    managedWidget = null;
    if (!record || !widgetExe) return;
    // 杀之前核对：可执行文件全路径要一致，PID 和启动时间也要对得上；对不上宁可不杀。
    const running = await listWidgetProcesses(widgetExe);
    const match = running.find(item => item.pid === record.pid && (record.startedAt === null || item.startedAt === record.startedAt));
    if (!match) return;
    try { process.kill(match.pid); } catch {}
  }
  ctx.effect(() => () => { releaseWidget().catch(() => {}); }, 'salary-meter: desktop widget');
  ensureWidget().catch(() => {});
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'dsh-salary-meter');
  const configFile = join(root, 'config.json');
  const ledgerFile = join(root, 'ledger.json');
  const viewFile = join(root, 'view.json');
  let saved = await readJson(configFile, null);
  if (!saved) {
    const original = process.platform === 'win32' && process.env.APPDATA
      ? await readJson(join(process.env.APPDATA, 'com.local.salarymeter', 'config.json'), null)
      : null;
    saved = { revision: 0, config: validateConfig(original ?? DEFAULT_CONFIG) };
    await atomicJson(configFile, saved);
  }
  saved.config = validateConfig(saved.config);
  const savedView = await readJson(viewFile, null);
  const savedOpacity = typeof savedView?.opacity === 'number' && savedView.opacity >= 0 && savedView.opacity <= 1 ? savedView.opacity : 0.85;
  let view = { expanded: savedView?.expanded === true, theme: ['light', 'gold'].includes(savedView?.theme) ? savedView.theme : 'dark', opacity: savedOpacity, revision: savedView?.revision ?? 0 };
  const ledger = await readJson(ledgerFile, { days: {}, positions: {}, lastExpenseAt: 0 });
  const priceCacheFile = join(root, 'prices-cache.json');
  let priceState = { source: '内置', fetchedAt: null, count: Object.keys(defaultPrices()).length };
  async function refreshPrices() {
    try {
      const cached = await readJson(priceCacheFile, null);
      if (cached?.prices) {
        setPrices(cached.prices);
        priceState = { source: '缓存', fetchedAt: cached.fetchedAt ?? null, count: Object.keys(cached.prices).length };
      }
    } catch { /* 缓存损坏就用内置价 */ }
    const sources = [
      'https://cdn.jsdelivr.net/gh/Jiang-Xiaoxing/dsh-salary-meter@main/prices.json',
      'https://raw.githubusercontent.com/Jiang-Xiaoxing/dsh-salary-meter/main/prices.json',
    ];
    for (const source of sources) {
      try {
        const response = await fetch(source, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) continue;
        const body = await response.json();
        if (body?.prices && typeof body.prices === 'object') {
          setPrices(body.prices);
          priceState = { source: '远程', fetchedAt: Date.now(), count: Object.keys(body.prices).length };
          await atomicJson(priceCacheFile, { fetchedAt: Date.now(), prices: body.prices }).catch(() => {});
          return;
        }
      } catch { /* 换下一个源 */ }
    }
  }
  refreshPrices().catch(() => {});
  const priceTimer = setInterval(() => { refreshPrices().catch(() => {}); }, 24 * 3600_000);
  ctx.effect(() => () => clearInterval(priceTimer), 'salary-meter: refresh prices');
  let sessions = new WeakMap();
  const active = new Set();
  let writes = Promise.resolve();
  let writeError = null;
  let configWrites = Promise.resolve();
  let viewWrites = Promise.resolve();
  function persistLedger() {
    const snapshot = structuredClone(ledger);
    writes = writes.then(async () => {
      await atomicJson(ledgerFile, snapshot);
      writeError = null;
    }).catch(error => {
      writeError = '费用记录保存失败';
      console.error('[salary-meter] ledger persistence failed', error.code || error.name);
    });
  }
  function scan(session) {
    let cursor = sessions.get(session);
    if (!cursor) {
      cursor = { seq: 0, route: null };
      sessions.set(session, cursor);
    }
    let changed = false;
    for (const event of session.snapshotEvents(cursor.seq)) {
      cursor.seq = event.seq + 1;
      if (event.type === 'request/header') {
        const config = event.data.header?.config;
        if (config?.model) cursor.route = config;
      }
      if (event.seq < session.inheritedEventCount) continue;
      if (event.type === 'turn/start') active.add(session.id);
      if (event.type === 'turn/end') active.delete(session.id);
      changed = recordExpense(ledger, session.id, event, cursor.route) || changed;
    }
    if (changed) persistLedger();
  }
  ctx.on('session/event', session => scan(session));
  // 会话日志是多个 zstd 帧首尾相接；按魔数切开逐帧解压，拼回 JSONL。
  function decodeSessionLog(bytes) {
    const magic = [0x28, 0xb5, 0x2f, 0xfd];
    const frames = [];
    let start = -1;
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes[i] === magic[0] && bytes[i + 1] === magic[1] && bytes[i + 2] === magic[2] && bytes[i + 3] === magic[3]) {
        if (start >= 0) frames.push(bytes.subarray(start, i));
        start = i;
      }
    }
    if (start >= 0) frames.push(bytes.subarray(start));
    const chunks = [];
    for (const frame of frames) {
      try { chunks.push(zstdDecompressSync(frame)); } catch { /* 坏帧跳过 */ }
    }
    const events = [];
    for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return events;
  }
  // 已关闭的会话不在 ctx.sessions 里，从磁盘日志补扫；只算今天，且跳过当前还在内存里扫过的会话。
  async function scanArchivedSessions(day, liveIds, totals) {
    const sessionsDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
    let groups = [];
    try { groups = await readdir(sessionsDir, { withFileTypes: true }); } catch { return 0; }
    let scanned = 0;
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const groupDir = join(sessionsDir, group.name);
      let entries = [];
      try { entries = await readdir(groupDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
        if (liveIds.has(entry.name.slice('session-'.length))) continue;
        let bytes;
        try { bytes = await readFile(join(groupDir, entry.name, 'session.v4.jsonl.zstd')); } catch { continue; }
        let route = null;
        for (const event of decodeSessionLog(bytes)) {
          if (event.type === 'request/header') {
            const config = event.data?.header?.config;
            if (config?.model) route = config;
            continue;
          }
          const usage = usageFromEvent(event);
          if (!usage || chinaDay(event.time) !== day) continue;
          const expense = estimateExpense(usage, route, event.time);
          if (expense === null) totals.unknown += 1;
          else { totals.expense += expense; totals.known += 1; }
        }
        scanned += 1;
      }
    }
    return scanned;
  }
  // 自检用：把今天的账清空，重扫当前会话 + 磁盘上已关闭的会话，按当前价格表重算一遍。
  async function recomputeToday() {
    const day = chinaDay(Date.now());
    const totals = { expense: 0, known: 0, unknown: 0 };
    ledger.days[day] = totals;
    ledger.positions = {};
    ledger.lastExpenseAt = 0;
    sessions = new WeakMap();
    const live = ctx.sessions.list();
    for (const session of live) scan(session);
    const archived = await scanArchivedSessions(day, new Set(live.map(session => session.id)), totals);
    persistLedger();
    return { day, sessions: live.length + archived, archived, today: totals, prices: priceState };
  }
  ctx.effect(() => () => Promise.all([writes, configWrites, viewWrites]), 'salary-meter: drain data writes');

  const assets = new Map([
    ['/api/salary-meter/actions.png', ['assets/whale-girl-actions.png', 'image/png']],
    ['/api/salary-meter/mascot.mjs', ['assets/mascot.mjs', 'text/javascript; charset=utf-8']],
    ['/api/salary-meter/widget.css', ['assets/widget.css', 'text/css; charset=utf-8']],
    ['/api/salary-meter/core.mjs', ['core.mjs', 'text/javascript; charset=utf-8']],
    ['/api/salary-meter/settings', ['assets/settings.html', 'text/html; charset=utf-8']],
  ]);
  for (const [path, [file, contentType]] of assets) {
    const bytes = await readFile(join(packageRoot, file));
    ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch: () => new Response(bytes, { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' } }) });
  }
  ctx.connection.fetch.register({
    path: '/api/salary-meter/state', methods: ['GET'], requestBody: 'buffered',
    fetch: () => {
      const live = ctx.sessions.list();
      for (const session of live) scan(session);
      const liveIds = new Set(live.map(session => session.id));
      for (const id of active) if (!liveIds.has(id)) active.delete(id);
      return Response.json({
        config: saved.config, revision: saved.revision, view,
        today: ledger.days[chinaDay(Date.now())] ?? { expense: 0, known: 0, unknown: 0 },
        active: active.size, lastExpenseAt: ledger.lastExpenseAt,
        error: writeError, priceDate: '2026-11-06', prices: priceState,
      }, { headers: { 'Cache-Control': 'no-store' } });
    },
  });
  ctx.connection.fetch.register({
    path: '/api/salary-meter/recompute', methods: ['POST'], requestBody: 'buffered',
    fetch: async () => Response.json(await recomputeToday(), { headers: { 'Cache-Control': 'no-store' } }),
  });
  ctx.connection.fetch.register({
    path: '/api/salary-meter/config', methods: ['PUT'], requestBody: 'buffered',
    fetch: async request => {
      const text = await request.text();
      if (text.length > 4096) return Response.json({ error: '参数内容过长' }, { status: 413 });
      let body;
      try { body = JSON.parse(text); validateConfig(body.config); }
      catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
      const operation = configWrites.then(async () => {
        if (body.revision !== saved.revision) return Response.json({ error: '参数已在别处更新，请重新打开设置' }, { status: 409 });
        const next = { revision: saved.revision + 1, config: validateConfig(body.config) };
        await atomicJson(configFile, next);
        saved = next;
        return Response.json(next);
      });
      configWrites = operation.catch(() => {});
      try { return await operation; }
      catch { return Response.json({ error: '参数保存失败，请检查数据目录权限' }, { status: 500 }); }
    },
  });
  ctx.connection.fetch.register({
    path: '/api/salary-meter/view', methods: ['PUT'], requestBody: 'buffered',
    fetch: async request => {
      const text = await request.text();
      if (text.length > 256) return Response.json({ error: '显示设置内容过长' }, { status: 413 });
      let body;
      try { body = JSON.parse(text); }
      catch { return Response.json({ error: '显示设置格式错误' }, { status: 400 }); }
      const hasExpanded = typeof body?.expanded === 'boolean';
      const hasTheme = ['dark', 'light', 'gold'].includes(body?.theme);
      const hasOpacity = typeof body?.opacity === 'number' && Number.isFinite(body.opacity) && body.opacity >= 0 && body.opacity <= 1;
      if (!hasExpanded && !hasTheme && !hasOpacity) return Response.json({ error: '请选择收起或展开人物' }, { status: 400 });
      const operation = viewWrites.then(async () => {
        const next = {
          expanded: hasExpanded ? body.expanded : view.expanded,
          theme: hasTheme ? body.theme : view.theme,
          opacity: hasOpacity ? Math.round(body.opacity * 100) / 100 : view.opacity,
          revision: view.revision + 1,
        };
        await atomicJson(viewFile, next);
        view = next;
        return Response.json(view);
      });
      viewWrites = operation.catch(() => {});
      try { return await operation; }
      catch { return Response.json({ error: '显示设置保存失败，请重试' }, { status: 500 }); }
    },
  });
}
