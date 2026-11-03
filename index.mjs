import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, validateConfig, chinaDay, recordExpense } from './core.mjs';

export const name = 'salary-meter';
export const inject = ['connection', 'sessions'];
const packageRoot = dirname(fileURLToPath(import.meta.url));

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
  let view = { expanded: savedView?.expanded === true, revision: savedView?.revision ?? 0 };
  const ledger = await readJson(ledgerFile, { days: {}, positions: {}, lastExpenseAt: 0 });
  const sessions = new WeakMap();
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
      if (event.type === 'request/header') cursor.route = event.data.header?.config ?? null;
      if (event.seq < session.inheritedEventCount) continue;
      if (event.type === 'turn/start') active.add(session.id);
      if (event.type === 'turn/end') active.delete(session.id);
      changed = recordExpense(ledger, session.id, event, cursor.route) || changed;
    }
    if (changed) persistLedger();
  }
  ctx.on('session/event', session => scan(session));
  ctx.effect(() => () => Promise.all([writes, configWrites, viewWrites]), 'salary-meter: drain data writes');

  const assets = new Map([
    ['/api/salary-meter/mascot.png', ['assets/whale-girl-poses.png', 'image/png']],
    ['/api/salary-meter/eating.png', ['assets/whale-girl-eating.png', 'image/png']],
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
        error: writeError, priceDate: '2026-11-03',
      }, { headers: { 'Cache-Control': 'no-store' } });
    },
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
      if (typeof body?.expanded !== 'boolean') return Response.json({ error: '请选择收起或展开人物' }, { status: 400 });
      const operation = viewWrites.then(async () => {
        const next = { expanded: body.expanded, revision: view.revision + 1 };
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
