'use strict';

/* ============================ 工具函数 ============================ */
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 极简 Markdown：代码块 / 行内代码 / 粗体 / 标题 / 换行 */
function md(src) {
  let s = esc(src);
  const blocks = [];
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code);
    return '\uE000B' + (blocks.length - 1) + '\uE000';
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>');
  s = s.replace(/^&gt;\s?(.+)$/gm, '<em>$1</em>');
  s = s.replace(/\n{2,}/g, '</p><p>');
  s = '<p>' + s.replace(/\n/g, '<br>') + '</p>';
  s = s.replace(/\uE000B(\d+)\uE000/g, (_, i) => '<pre><code>' + blocks[+i] + '</code></pre>');
  return s;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return sameDay ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

const STATUS_TEXT = {
  running: '进行中', completed: '已完成', failed: '失败',
  interrupted: '已中断', recent: '刚刚', idle: '空闲',
};

/* ============================ API ============================ */
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ============================ 视图状态 ============================ */
let threads = [];
let currentId = null;
let currentItems = [];
let es = null;
let autoScroll = true;
let threadsTimer = null;

/* ============================ 登录 ============================ */
function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
  if (es) { es.close(); es = null; }
  if (threadsTimer) { clearInterval(threadsTimer); threadsTimer = null; }
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  loadThreads();
  if (!threadsTimer) threadsTimer = setInterval(loadThreads, 15000);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  const errEl = $('login-err');
  btn.disabled = true;
  errEl.hidden = true;
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('pw').value }),
    });
    $('pw').value = '';
    showApp();
  } catch (err) {
    errEl.textContent = err.message === 'unauthorized' ? '密码错误' : err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  showLogin();
});

/* ============================ 会话列表 ============================ */
async function loadThreads() {
  try {
    const { threads: list } = await api('/api/threads');
    threads = list;
    renderThreads();
  } catch { /* 401 已处理 */ }
}

function renderThreads() {
  const q = $('search').value.trim().toLowerCase();
  const onlyActive = $('only-active').checked;
  const ul = $('thread-list');
  ul.innerHTML = '';

  const shown = threads.filter((t) => {
    if (onlyActive && t.status !== 'running') return false;
    if (q && !String(t.title || '').toLowerCase().includes(q)) return false;
    return true;
  });

  if (!shown.length) {
    ul.innerHTML = '<li class="muted small" style="cursor:default">没有匹配的会话</li>';
    return;
  }

  for (const t of shown) {
    const li = document.createElement('li');
    if (t.id === currentId) li.className = 'active';
    li.innerHTML =
      '<span class="dot ' + esc(t.status) + '"></span>' +
      '<div class="tinfo">' +
        '<div class="tname">' + esc(t.title || '(未命名)') + '</div>' +
        '<div class="tmeta">' + esc(STATUS_TEXT[t.status] || t.status) +
          (t.turns != null ? ' · ' + t.turns + ' 轮' : '') +
          ' · ' + fmtBytes(t.size) +
          ' · ' + fmtTime(t.updatedAt) +
        '</div>' +
      '</div>';
    li.addEventListener('click', () => selectThread(t.id));
    ul.appendChild(li);
  }
}

$('search').addEventListener('input', renderThreads);
$('only-active').addEventListener('change', renderThreads);
$('reload-btn').addEventListener('click', () => {
  loadThreads();
  if (currentId) selectThread(currentId);
});
$('menu-btn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

/* ============================ 会话详情 ============================ */
async function selectThread(id) {
  currentId = id;
  $('sidebar').classList.remove('open');
  $('empty').hidden = true;
  $('detail').hidden = false;
  renderThreads();

  $('timeline').innerHTML = '<p class="muted small">加载中…</p>';
  try {
    const data = await api('/api/threads/' + id);
    currentItems = data.items;
    renderTimeline();
    renderGallery(data.media || []);
    $('media-count').textContent = (data.media || []).length;

    const meta = threads.find((t) => t.id === id);
    $('cur-title').textContent = meta?.title || id.slice(0, 8);
    $('cur-sub').textContent =
      (meta ? (STATUS_TEXT[meta.status] || meta.status) + ' · ' : '') +
      currentItems.length + ' 条' + (data.truncated ? '（已截断，仅显示最近内容）' : '');

    openStream(id);
    autoScroll = true;
    scrollBottom();
  } catch (err) {
    $('timeline').innerHTML = '<p class="err">加载失败：' + esc(err.message) + '</p>';
  }
}

function openStream(id) {
  if (es) { es.close(); es = null; }
  es = new EventSource('/api/threads/' + id + '/stream');

  es.addEventListener('item', (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    if (payload.threadId !== currentId) return;
    currentItems.push(payload.item);
    appendItem(payload.item);
    const sub = $('cur-sub');
    sub.textContent = sub.textContent.replace(/^\d+ 条/, currentItems.length + ' 条');
  });

  es.addEventListener('warn', (e) => {
    let m = 'stream warning';
    try { m = JSON.parse(e.data).message; } catch { /* ignore */ }
    console.warn('[stream]', m);
  });

  es.addEventListener('error', () => { /* EventSource 会自动重连 */ });
}

/* ============================ 渲染 ============================ */
function isNoise(item) {
  return item.kind === 'usage' || item.kind === 'context';
}

function itemNode(item) {
  const el = document.createElement('div');

  switch (item.kind) {
    case 'marker':
      el.className = 'marker';
      el.textContent = item.text || '';
      return el;

    case 'user':
    case 'assistant':
    case 'agent': {
      el.className = 'msg ' + (item.kind === 'user' ? 'user' : 'assistant');
      const who = item.kind === 'user' ? '我'
        : item.kind === 'agent' ? '子代理'
        : 'Codex';
      el.innerHTML =
        '<div class="who">' + who + (item.ts ? ' · ' + fmtTime(item.ts) : '') + '</div>' +
        '<div class="bubble">' + md(item.text) + '</div>';
      return el;
    }

    case 'reasoning': {
      el.innerHTML =
        '<details class="tool"><summary><span class="tag">思考</span>' +
        (item.ts ? '<span class="muted small">' + fmtTime(item.ts) + '</span>' : '') +
        '</summary><pre>' + esc(item.text) + '</pre></details>';
      return el;
    }

    case 'tool_call':
    case 'tool_result': {
      const isCall = item.kind === 'tool_call';
      el.innerHTML =
        '<details class="tool"><summary>' +
          '<span class="tag ' + (isCall ? 'call' : 'result') + '">' +
            (isCall ? '调用' : '返回') + '</span>' +
          '<span>' + esc(item.name || '') + '</span>' +
          (item.ts ? '<span class="muted small" style="margin-left:auto">' + fmtTime(item.ts) + '</span>' : '') +
        '</summary><pre>' + esc(item.text) + '</pre></details>';
      return el;
    }

    case 'context':
    case 'usage': {
      el.className = 'noise';
      el.innerHTML =
        '<details class="tool"><summary><span class="tag">' +
        (item.kind === 'usage' ? '用量' : '上下文') + '</span></summary>' +
        '<pre>' + esc(item.text) + '</pre></details>';
      return el;
    }

    case 'compact':
      el.className = 'noise';
      el.innerHTML =
        '<details class="tool"><summary><span class="tag">压缩摘要</span></summary>' +
        '<pre>' + esc(item.text) + '</pre></details>';
      return el;

    default:
      return null;
  }
}

function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const item of currentItems) {
    const n = itemNode(item);
    if (n) frag.appendChild(n);
  }
  tl.appendChild(frag);
  applyNoiseVisibility();
}

function appendItem(item) {
  const tl = $('timeline');
  const n = itemNode(item);
  if (!n) return;
  tl.appendChild(n);
  applyNoiseVisibility();
  if (autoScroll) scrollBottom();
}

function applyNoiseVisibility() {
  document.body.classList.toggle('show-noise', $('show-noise').checked);
}

$('show-noise').addEventListener('change', applyNoiseVisibility);

/* ---------- 滚动 ---------- */
function scrollBottom() {
  const el = $('tab-chat');
  el.scrollTop = el.scrollHeight;
  autoScroll = true;
  $('jump').hidden = true;
}

$('tab-chat').addEventListener('scroll', () => {
  const el = $('tab-chat');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  autoScroll = atBottom;
  $('jump').hidden = atBottom;
});

$('jump').addEventListener('click', scrollBottom);

/* ---------- 标签页 ---------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    $('tab-chat').hidden = target !== 'chat';
    $('tab-gallery').hidden = target !== 'gallery';
  });
});

/* ============================ 图库 ============================ */
function renderGallery(media) {
  const g = $('gallery');
  g.innerHTML = '';
  if (!media.length) {
    g.innerHTML = '<p class="gempty">这个会话还没有产出的图片或文件</p>';
    return;
  }
  for (const m of media) {
    const url = '/api/media?p=' + encodeURIComponent(m.name);
    const ext = (m.ext || '').toLowerCase();
    const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
    const div = document.createElement('div');
    div.className = 'gitem';
    const inner = isImg
      ? '<img src="' + url + '" loading="lazy" alt="">'
      : '<div style="padding:22px 8px;text-align:center" class="muted small">' + esc(ext.slice(1).toUpperCase()) + '</div>';
    div.innerHTML =
      '<a href="' + url + '" target="_blank" rel="noopener">' + inner +
      '<div class="gn">' + esc(m.name.split('/').pop()) + '</div></a>';
    g.appendChild(div);
  }
}

/* ============================ 启动 ============================ */
(async function boot() {
  try {
    const me = await api('/api/me');
    if (me.authenticated) showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
