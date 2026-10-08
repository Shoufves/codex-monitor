#!/usr/bin/env node
/**
 * Codex Monitor —— 只读的本地 Codex / Codex++ 会话监视器
 *
 * 设计原则：
 *   1. 只读。绝不写入 ~/.codex，SQLite 以 readOnly 打开，避免与运行中的 Codex 抢锁。
 *   2. 零依赖。只用 Node 内置模块（node:sqlite 在 Node 22.5+ 可用）。
 *   3. 默认只监听回环 + Tailscale 地址，不向校园网暴露端口。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const MONITOR_HOME = process.env.CODEX_MONITOR_HOME || path.join(HOME, '.codex-monitor');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MEDIA_ROOTS = [
  path.join(CODEX_HOME, 'visualizations'),
  path.join(CODEX_HOME, 'computer-use'),
];

// 屏蔽 node:sqlite 的实验性警告（功能正常，只是噪音）
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === 'object' ? warning.message : String(warning);
  const name = typeof warning === 'object' ? warning.name : rest[0];
  if (name === 'ExperimentalWarning' && /SQLite/i.test(msg)) return;
  _emitWarning(warning, ...rest);
};

// node:sqlite 是可选依赖，缺失时降级为「按文件 mtime 推断状态」
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.warn('[warn] node:sqlite 不可用，进度状态将退化为基于文件时间推断');
}

// ============================================================================
// 配置 / 鉴权
// ============================================================================
const CONFIG_PATH = path.join(MONITOR_HOME, 'config.json');

async function loadConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function saveConfig(cfg) {
  await fsp.mkdir(MONITOR_HOME, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  try {
    const [scheme, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(pw, salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const sessions = new Map();      // token -> { expiresAt }
const loginAttempts = new Map(); // ip -> { fails, blockedUntil }

function newSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function sessionValid(token) {
  const s = token && sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// ============================================================================
// 数据层：扫描 ~/.codex
// ============================================================================
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const ROLLOUT_RE = /^rollout-(.+)\.jsonl$/;

async function scanRolloutFiles() {
  const root = path.join(CODEX_HOME, 'sessions');
  const found = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const m = ROLLOUT_RE.exec(e.name);
        if (!m) continue;
        const ids = [...m[1].matchAll(UUID_RE)].map((x) => x[1]);
        if (!ids.length) continue;
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        found.push({
          threadId: ids[0],
          turnId: ids[1] || null,
          file: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
          // 文件名前段是可排序的 ISO 时间戳
          stamp: m[1].slice(0, 23),
        });
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function readSessionIndex() {
  const map = new Map();
  try {
    const raw = await fsp.readFile(path.join(CODEX_HOME, 'session_index.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.id) map.set(o.id, o);
      } catch { /* 跳过坏行 */ }
    }
  } catch { /* 索引缺失不影响主流程 */ }
  return map;
}

/** 从 thread_history_1.sqlite 读取 turn 状态（只读打开） */
function readTurnStatus() {
  const result = new Map();
  if (!DatabaseSync) return result;
  const dbPath = path.join(CODEX_HOME, 'thread_history_1.sqlite');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      `SELECT thread_id, status, started_at, duration_ms
         FROM thread_turns
        ORDER BY started_at ASC`
    ).all();
    for (const r of rows) {
      const prev = result.get(r.thread_id) || { turns: 0, lastStatus: null, lastStartedAt: null };
      prev.turns += 1;
      prev.lastStatus = r.status;
      prev.lastStartedAt = toMillis(r.started_at);
      result.set(r.thread_id, prev);
    }
  } catch (err) {
    console.warn(`[warn] 读取 thread_turns 失败: ${err.message}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return result;
}

/** Codex 的时间戳单位不统一：< 1e11 视为秒，否则视为毫秒 */
function toMillis(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

/** 汇总会话列表 */
async function listThreads() {
  const [files, index, statusMap] = await Promise.all([
    scanRolloutFiles(),
    readSessionIndex(),
    Promise.resolve(readTurnStatus()),
  ]);

  const byThread = new Map();
  for (const f of files) {
    let t = byThread.get(f.threadId);
    if (!t) {
      t = { id: f.threadId, files: [], size: 0, mtimeMs: 0 };
      byThread.set(f.threadId, t);
    }
    t.files.push(f);
    t.size += f.size;
    t.mtimeMs = Math.max(t.mtimeMs, f.mtimeMs);
  }

  const now = Date.now();
  const out = [];
  for (const t of byThread.values()) {
    t.files.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
    const idx = index.get(t.id);
    const st = statusMap.get(t.id);
    const idleMs = now - t.mtimeMs;

    let status = 'idle';
    if (st?.lastStatus === 'inProgress') status = 'running';
    else if (idleMs < 45_000) status = 'running';
    else if (st?.lastStatus === 'failed') status = 'failed';
    else if (st?.lastStatus === 'interrupted') status = 'interrupted';
    else if (st?.lastStatus === 'completed') status = 'completed';
    else if (idleMs < 3600_000) status = 'recent';

    // 会话名：索引里的 thread_name，否则用 cwd 猜一个
    let title = idx?.thread_name || null;
    if (!title) title = await guessTitle(t.files);

    out.push({
      id: t.id,
      title,
      status,
      turns: st?.turns ?? null,
      size: t.size,
      mtime: t.mtimeMs,
      updatedAt: idx?.updated_at || new Date(t.mtimeMs).toISOString(),
      fileCount: t.files.length,
    });
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

const titleCache = new Map();

/** 从首个 rollout 文件的 session_meta 里取 cwd 作为兜底标题 */
async function guessTitle(files) {
  const first = files[0];
  if (!first) return '(未知会话)';
  if (titleCache.has(first.file)) return titleCache.get(first.file);
  let title = '(未知会话)';
  try {
    const fd = await fsp.open(first.file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const nl = text.indexOf('\n');
      const line = nl >= 0 ? text.slice(0, nl) : text;
      const rec = JSON.parse(line);
      const p = rec?.payload || {};
      title = p.cwd || p.originator || title;
    } finally {
      await fd.close();
    }
  } catch { /* ignore */ }
  titleCache.set(first.file, title);
  return title;
}

// ============================================================================
// 对话解析：把 rollout JSONL 记录规范化成前端可渲染的条目
// ============================================================================
function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'input_image' || c.type === 'image_url') parts.push('[图片]');
  }
  return parts.join('\n');
}

function brief(v, max = 600) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 返回 null 表示该记录无需展示 */
function normalize(rec) {
  const { type, payload: p, timestamp, ordinal } = rec || {};
  if (!p || typeof p !== 'object') return null;

  if (type === 'response_item') {
    switch (p.type) {
      case 'message': {
        const role = p.role || 'assistant';
        const text = textFromContent(p.content);
        if (!text.trim()) return null;
        return { kind: role === 'user' ? 'user' : role === 'developer' ? 'context' : 'assistant',
                 role, text, ts: timestamp, ordinal };
      }
      case 'agent_message':
        return { kind: 'agent', text: brief(p.text ?? p.message ?? p, 4000), ts: timestamp, ordinal };
      case 'reasoning': {
        const s = Array.isArray(p.summary) ? p.summary.map((x) => x?.text ?? '').join('\n') : '';
        if (!s.trim()) return null; // 只有加密内容时无展示价值
        return { kind: 'reasoning', text: s, ts: timestamp, ordinal };
      }
      case 'function_call':
      case 'custom_tool_call':
        return {
          kind: 'tool_call',
          name: p.name || p.tool_name || 'tool',
          text: brief(p.arguments ?? p.input ?? '', 2000),
          ts: timestamp, ordinal,
        };
      case 'function_call_output':
      case 'custom_tool_call_output':
        return {
          kind: 'tool_result',
          name: p.name || null,
          text: brief(p.output ?? p.content ?? p.result ?? '', 3000),
          ts: timestamp, ordinal,
        };
      default:
        return null;
    }
  }

  if (type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
        return { kind: 'marker', marker: 'start', text: '任务开始', ts: timestamp, ordinal };
      case 'task_complete':
        return { kind: 'marker', marker: 'done', text: '任务结束', ts: timestamp, ordinal };
      case 'token_count':
        return {
          kind: 'usage',
          text: brief(p, 400),
          inputTokens: p.input_tokens ?? p.inputTokens ?? null,
          outputTokens: p.output_tokens ?? p.outputTokens ?? null,
          ts: timestamp, ordinal,
        };
      default:
        return null;
    }
  }

  if (type === 'compacted') {
    return { kind: 'compact', text: brief(p.message ?? '', 4000), ts: timestamp, ordinal };
  }

  return null;
}

/**
 * 读取单个会话的尾部内容。
 * 大文件只取末尾 maxBytes，避免一次解析几十 MB。
 */
async function readThreadItems(threadId, { maxBytes = 3 * 1024 * 1024, maxItems = 400 } = {}) {
  const files = (await scanRolloutFiles()).filter((f) => f.threadId === threadId);
  files.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  if (!files.length) return { items: [], files: [], truncated: false };

  const items = [];
  let truncated = false;

  // 从最新文件往前读，凑够 maxItems 为止
  for (let i = files.length - 1; i >= 0; i--) {
    const f = files[i];
    let text;
    if (f.size > maxBytes) {
      truncated = true;
      const fd = await fsp.open(f.file, 'r');
      try {
        const start = f.size - maxBytes;
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fd.read(buf, 0, maxBytes, start);
        text = buf.subarray(0, bytesRead).toString('utf8');
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1); // 丢掉半行
      } finally {
        await fd.close();
      }
    } else {
      text = await fsp.readFile(f.file, 'utf8');
    }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const item = normalize(rec);
      if (item) items.push(item);
    }
    if (items.length >= maxItems) break;
  }

  items.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  return { items: items.slice(-maxItems), files, truncated };
}

// ============================================================================
// 媒体服务（成果图）
// ============================================================================
function resolveMedia(rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  for (const root of MEDIA_ROOTS) {
    const full = path.resolve(root, cleaned);
    if (full.startsWith(path.resolve(root) + path.sep) && fs.existsSync(full)) {
      const st = fs.statSync(full);
      if (st.isFile()) return { full, st };
    }
  }
  return null;
}

async function listThreadMedia(threadId) {
  const out = [];
  const exts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.mp4', '.csv', '.json']);
  for (const root of MEDIA_ROOTS) {
    if (!fs.existsSync(root)) continue;
    // visualizations/YYYY/MM/DD/<threadId>/ —— 按 threadId 定位目录
    async function walk(dir, depth) {
      if (depth > 4) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === threadId) {
            await collect(full, root);
          } else {
            await walk(full, depth + 1);
          }
        }
      }
    }
    async function collect(dir, rootDir) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await collect(full, rootDir); continue; }
        const ext = path.extname(e.name).toLowerCase();
        if (!exts.has(ext)) continue;
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        out.push({
          name: path.relative(rootDir, full).replace(/\\/g, '/'),
          size: st.size,
          mtime: st.mtimeMs,
          ext,
        });
      }
    }
    await walk(root, 0);
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

// ============================================================================
// HTTP 层
// ============================================================================
function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function requireAuth(req, res) {
  const token = parseCookies(req).cm_token;
  if (sessionValid(token)) return true;
  json(res, 401, { error: 'unauthorized' });
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.csv': 'text/csv; charset=utf-8',
};

async function serveStatic(res, filePath) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- SSE：跟踪 rollout 文件增长 ----
function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 长轮询式 tail：每 1s 检查文件 size，只读增量 */
class Tail {
  constructor(threadId, res) {
    this.threadId = threadId;
    this.res = res;
    this.offsets = new Map();
    this.pending = new Map();
    this.timer = null;
  }

  async init() {
    const files = (await scanRolloutFiles()).filter((f) => f.threadId === this.threadId);
    // 已存在的文件从当前末尾开始，只推新内容
    for (const f of files) this.offsets.set(f.file, f.size);
  }

  async poll() {
    try {
      const files = (await scanRolloutFiles()).filter((f) => f.threadId === this.threadId);
      files.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
      for (const f of files) {
        const prev = this.offsets.has(f.file) ? this.offsets.get(f.file) : 0;
        if (f.size <= prev) { this.offsets.set(f.file, prev); continue; }
        const fd = await fsp.open(f.file, 'r');
        try {
          const len = f.size - prev;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fd.read(buf, 0, len, prev);
          let text = buf.subarray(0, bytesRead).toString('utf8');
          const tail = this.pending.get(f.file) || '';
          text = tail + text;
          const lines = text.split('\n');
          this.pending.set(f.file, lines.pop() ?? '');
          for (const line of lines) {
            if (!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }
            const item = normalize(rec);
            if (item) sseSend(this.res, 'item', { threadId: this.threadId, item });
          }
        } finally {
          await fd.close();
        }
        this.offsets.set(f.file, f.size);
      }
    } catch (err) {
      sseSend(this.res, 'warn', { message: err.message });
    }
  }

  start() {
    this.timer = setInterval(() => this.poll(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

// ---- 路由 ----
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // 静态资源
  if (p === '/' || p === '/index.html') return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  if (p === '/app.js') return serveStatic(res, path.join(PUBLIC_DIR, 'app.js'));
  if (p === '/style.css') return serveStatic(res, path.join(PUBLIC_DIR, 'style.css'));

  // 登录
  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const rec = loginAttempts.get(ip) || { fails: 0, blockedUntil: 0 };
    if (rec.blockedUntil > Date.now()) {
      return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad request' }); }

    const cfg = await loadConfig();
    if (!cfg?.passwordHash || !verifyPassword(String(body.password ?? ''), cfg.passwordHash)) {
      rec.fails += 1;
      if (rec.fails >= 5) { rec.blockedUntil = Date.now() + 60_000; rec.fails = 0; }
      loginAttempts.set(ip, rec);
      await new Promise((r) => setTimeout(r, 400)); // 削弱爆破速率
      return json(res, 401, { error: '密码错误' });
    }
    loginAttempts.delete(ip);
    const token = newSession();
    res.setHeader('Set-Cookie',
      `cm_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).cm_token;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'cm_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (p === '/api/me') {
    return json(res, 200, { authenticated: sessionValid(parseCookies(req).cm_token) });
  }

  // 以下全部需要登录
  if (p.startsWith('/api/')) {
    if (!requireAuth(req, res)) return;

    if (p === '/api/threads') {
      return json(res, 200, { threads: await listThreads() });
    }

    const mDetail = /^\/api\/threads\/([0-9a-f-]{36})$/.exec(p);
    if (mDetail) {
      const id = mDetail[1];
      const [data, media] = await Promise.all([readThreadItems(id), listThreadMedia(id)]);
      return json(res, 200, {
        id,
        items: data.items,
        truncated: data.truncated,
        files: data.files.map((f) => ({ name: path.basename(f.file), size: f.size, mtime: f.mtimeMs })),
        media,
      });
    }

    const mStream = /^\/api\/threads\/([0-9a-f-]{36})\/stream$/.exec(p);
    if (mStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const tail = new Tail(mStream[1], res);
      await tail.init();
      tail.start();
      const beat = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { tail.stop(); clearInterval(beat); });
      return;
    }

    if (p === '/api/media') {
      const hit = resolveMedia(url.searchParams.get('p'));
      if (!hit) return json(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(hit.full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': hit.st.size,
        'Cache-Control': 'private, max-age=60',
      });
      return fs.createReadStream(hit.full).pipe(res);
    }

    return json(res, 404, { error: 'not found' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ============================================================================
// 启动
// ============================================================================
function detectTailscaleIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const oct = ni.address.split('.').map(Number);
      // Tailscale 使用 CGNAT 段 100.64.0.0/10
      if (oct[0] === 100 && oct[1] >= 64 && oct[1] <= 127) return ni.address;
    }
  }
  return null;
}

async function main() {
  // --set-password <pw>
  const argIdx = process.argv.indexOf('--set-password');
  if (argIdx >= 0) {
    const pw = process.argv[argIdx + 1];
    if (!pw || pw.length < 6) {
      console.error('用法: node server.mjs --set-password <至少6位密码>');
      process.exit(1);
    }
    const cfg = (await loadConfig()) || {};
    cfg.passwordHash = hashPassword(pw);
    cfg.updatedAt = new Date().toISOString();
    await saveConfig(cfg);
    console.log(`密码已更新，配置写入 ${CONFIG_PATH}`);
    process.exit(0);
  }

  if (!fs.existsSync(CODEX_HOME)) {
    console.error(`找不到 Codex 数据目录: ${CODEX_HOME}`);
    process.exit(1);
  }

  let cfg = await loadConfig();
  if (!cfg?.passwordHash) {
    const pw = crypto.randomBytes(9).toString('base64url');
    cfg = cfg || {};
    cfg.passwordHash = hashPassword(pw);
    cfg.createdAt = new Date().toISOString();
    await saveConfig(cfg);
    console.log('-'.repeat(58));
    console.log('  首次启动，已生成随机密码（请立即保存）:');
    console.log(`\n      ${pw}\n`);
    console.log('  修改密码: node server.mjs --set-password <新密码>');
    console.log('-'.repeat(58));
  }

  const tailscaleIp = detectTailscaleIPv4();
  const binds = ['127.0.0.1'];
  if (tailscaleIp) binds.push(tailscaleIp);

  for (const host of binds) {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[error]', err);
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
        else try { res.end(); } catch { /* ignore */ }
      });
    });
    server.listen(PORT, host, () => {
      const label = host === '127.0.0.1' ? '本机' : 'Tailscale';
      console.log(`  ${label.padEnd(10)} http://${host}:${PORT}`);
    });
  }

  console.log(`\nCodex 数据: ${CODEX_HOME}`);
  console.log(`配置:       ${CONFIG_PATH}`);
  if (!tailscaleIp) {
    console.log('\n[!] 未检测到 Tailscale 地址，当前仅本机可访问。');
  } else {
    console.log(`\n手机接入：装 Tailscale 登录同一账号后访问 http://${tailscaleIp}:${PORT}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
