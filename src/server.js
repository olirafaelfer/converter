const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { exec } = require('child_process');
const express = require('express');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TEMP_DIR = path.join(ROOT, 'temp');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const LEARNING_DB = path.join(DATA_DIR, 'learning-db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

try {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
} catch {}

const app = express();
const PORT = Number(process.env.PORT || 3000);
let browserPromise;
let latestSessionId = null;
const sessions = new Map();

app.use(express.json({ limit: '8mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/downloads', express.static(DOWNLOADS_DIR, { etag: false, maxAge: 0 }));
app.use('/temp', express.static(TEMP_DIR, { etag: false, maxAge: 0 }));
app.get('/favicon.ico', (_, res) => res.status(204).end());
app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/defense', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'defense.html')));

process.on('unhandledRejection', error => console.error('[unhandledRejection]', error && error.stack || error));
process.on('uncaughtException', error => console.error('[uncaughtException]', error && error.stack || error));

function uid(prefix = 's') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(value) {
  return String(value || 'audit')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'audit';
}

function sessionDir(session) {
  const dir = path.join(DOWNLOADS_DIR, `${slugify(session.pageUrl)}-${session.id}`);
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  return dir;
}

function writeReport(session, name, data) {
  const dir = path.join(sessionDir(session), 'reports');
  const jsonPath = path.join(dir, `${name}.json`);
  const htmlPath = path.join(dir, `${name}.html`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  fs.writeFileSync(htmlPath, renderReportHtml(name, data));
  return {
    json: `/downloads/${path.basename(sessionDir(session))}/reports/${name}.json`,
    html: `/downloads/${path.basename(sessionDir(session))}/reports/${name}.html`,
    jsonPath,
    htmlPath,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderReportHtml(title, data) {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:Arial,system-ui;margin:24px;line-height:1.4}pre{white-space:pre-wrap;background:#111;color:#eee;padding:16px;border-radius:10px}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccc;padding:6px;font-size:12px;text-align:left}th{background:#eee}.critical{background:#ffe2e2}.high{background:#fff0d0}.ok{background:#e7ffe7}</style>
<h1>${escapeHtml(title)}</h1><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

function normalizeUrl(value, base) {
  if (!value || typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return null;
  raw = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/^['"]|['"]$/g, '');
  try {
    return new URL(raw, base || undefined).toString();
  } catch {
    return null;
  }
}

function getAllowedHosts() {
  return String(process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function createSession(pageUrl) {
  const parsed = new URL(pageUrl);
  const allowedHosts = new Set(getAllowedHosts());
  allowedHosts.add(parsed.hostname);
  allowedHosts.add(parsed.hostname.replace(/^www\./, ''));
  allowedHosts.add(`www.${parsed.hostname.replace(/^www\./, '')}`);
  const session = {
    id: uid('s'),
    pageUrl,
    finalUrl: pageUrl,
    referer: pageUrl,
    userAgent: '',
    cookies: [],
    allowedHosts,
    media: new Map(),
    network: [],
    textBank: [],
    storage: { localStorage: {}, sessionStorage: {} },
    setCookies: [],
    logs: [],
    clients: new Set(),
    page: null,
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  latestSessionId = session.id;
  sessionDir(session);
  return session;
}

function getSession(id) {
  if (id && sessions.has(id)) return sessions.get(id);
  if (latestSessionId && sessions.has(latestSessionId)) return sessions.get(latestSessionId);
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

function addLog(session, level, message, extra = {}) {
  if (!session) return;
  const entry = { time: new Date().toISOString(), level, message, ...extra };
  session.logs.push(entry);
  if (session.logs.length > 1500) session.logs.shift();
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of session.clients) {
    try { res.write(line); } catch {}
  }
}

function classifyMedia(url, contentType = '') {
  const clean = String(url || '').split('?')[0].toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (isJunkUrl(url)) return null;
  if (clean.endsWith('.m3u8') || ct.includes('mpegurl')) return 'hls';
  if (clean.endsWith('.mpd') || ct.includes('dash+xml')) return 'dash';
  if (clean.endsWith('.ts') || ct.includes('mp2t')) return 'segment';
  if (clean.endsWith('.m4s')) return 'fragment';
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v') || ct.includes('video/mp4')) return 'mp4';
  if (clean.endsWith('.webm') || ct.includes('video/webm')) return 'webm';
  if (clean.endsWith('.mov') || ct.includes('quicktime')) return 'mov';
  if (/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(clean) || ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  return null;
}

function isPlayable(type) {
  return ['hls', 'mp4', 'webm', 'mov', 'video'].includes(type);
}

function isJunkUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return true;
  if (u.includes('/jwplayer6/ping.gif') || u.includes('/ping.gif') || u.includes('google-analytics') || u.includes('recaptcha')) return true;
  if (u.includes('/assets/css/') && (u.includes('url(') || u.includes('{') || u.includes('no-repeat') || u.includes('%7b'))) return true;
  if (/\/(this|if\(this|c\.data|z)\.mov($|[?#])/i.test(u)) return true;
  if (u.includes('.css') || u.includes('.js')) return !/\.(m3u8|mp4|webm|mov)(\?|$)/i.test(u);
  return false;
}

function addMedia(session, url, source, contentType = '', extra = {}) {
  const normalized = normalizeUrl(url, session.finalUrl || session.pageUrl);
  if (!normalized || isJunkUrl(normalized)) return;
  const type = classifyMedia(normalized, contentType);
  if (!type) return;
  try { session.allowedHosts.add(new URL(normalized).hostname); } catch {}
  const prev = session.media.get(normalized) || { url: normalized, type, sources: [], contentType: '', playable: isPlayable(type), firstSeen: new Date().toISOString() };
  prev.type = prev.type || type;
  prev.contentType = prev.contentType || contentType || '';
  prev.playable = prev.playable || isPlayable(type);
  if (source && !prev.sources.includes(source)) prev.sources.push(source);
  Object.assign(prev, extra);
  session.media.set(normalized, prev);
}

function addText(session, url, contentType, text, source) {
  if (!text || typeof text !== 'string') return;
  session.textBank.push({ url, contentType, source, text: text.slice(0, 600000), at: new Date().toISOString() });
  if (session.textBank.length > 250) session.textBank.shift();
}

function extractUrlsFromText(text, base, source = 'text') {
  if (!text || typeof text !== 'string') return [];
  const out = new Map();
  const decoded = text.replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
  const absolute = decoded.match(/https?:\/\/[^\s"'<>\\)\]]+/gi) || [];
  const relative = decoded.match(/(?:\.\.\/|\.\/|\/)[^\s"'<>\\)\]]+\.(?:m3u8|mp4|m4v|webm|mov|mpd|ts|m4s|jpg|jpeg|png|webp|gif|avif)(?:\?[^\s"'<>\\)\]]*)?/gi) || [];
  const keys = decoded.match(/(?:file|src|url|source|video|downloadUrl|fullUrl|mediaUrl|hls|mp4)\s*[:=]\s*["']([^"']+)["']/gi) || [];
  for (const item of absolute.concat(relative)) {
    const u = normalizeUrl(item, base);
    if (u && !isJunkUrl(u)) out.set(u, { url: u, source });
  }
  for (const item of keys) {
    const m = /["']([^"']+)["']/.exec(item);
    const u = m && normalizeUrl(m[1], base);
    if (u && !isJunkUrl(u)) out.set(u, { url: u, source: `${source}:kv` });
  }
  return [...out.values()];
}


function allowSignedMedia() {
  return String(process.env.ALLOW_SIGNED_MEDIA || '').toLowerCase() === 'true';
}

function shouldBlockSignedMedia() {
  return !allowSignedMedia();
}

function containsSignedParams(url) {
  try {
    const parsed = new URL(url);
    const names = [...parsed.searchParams.keys()].map(k => k.toLowerCase());
    return names.some(k => /^(ttl|token|expires|expires_at|exp|signature|sig|policy|key-pair-id|x-amz-signature|x-amz-credential|x-amz-security-token)$/.test(k));
  } catch {
    return /[?&](ttl|token|expires|signature|sig|policy|x-amz-signature)=/i.test(String(url));
  }
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/ttl|token|expires|exp|signature|sig|policy|credential|security|key-pair/i.test(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return String(url).replace(/([?&](?:ttl|token|expires|signature|sig|policy)[^=]*=)[^&]+/gi, '$1[redacted]');
  }
}

function isFullishUrl(url) {
  const u = String(url || '').toLowerCase();
  return /(full|download|source|original|high|1080|2160|4k|2k|uhd|hd).*\.(mp4|m3u8)(\?|$)/i.test(u) || /video-full\.mp4/i.test(u);
}

function mediaProxyUrl(session, targetUrl) {
  return `/api/proxy?session=${encodeURIComponent(session.id)}&url=${encodeURIComponent(targetUrl)}`;
}

function cookieHeader(session, targetUrl) {
  let target;
  try { target = new URL(targetUrl); } catch { return ''; }
  return (session.cookies || []).filter(c => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    const h = target.hostname.toLowerCase();
    if (d && h !== d && !h.endsWith(`.${d}`)) return false;
    if (c.path && !target.pathname.startsWith(c.path)) return false;
    return c.name && typeof c.value !== 'undefined';
  }).map(c => `${c.name}=${c.value}`).join('; ');
}

async function fetchWithSession(session, targetUrl, opts = {}) {
  const headers = {
    'user-agent': session.userAgent || 'Mozilla/5.0',
    accept: opts.accept || '*/*',
    'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
  };
  if (opts.referer !== false) headers.referer = opts.referer || session.referer || session.pageUrl;
  if (opts.origin !== false) {
    try { headers.origin = new URL(headers.referer || session.pageUrl).origin; } catch {}
  }
  if (opts.cookies !== false) {
    const cookie = cookieHeader(session, targetUrl);
    if (cookie) headers.cookie = cookie;
  }
  if (opts.range) headers.range = opts.range;
  return fetch(targetUrl, { method: opts.method || 'GET', headers, redirect: 'follow', signal: opts.signal });
}

async function safeFetchTest(session, url, mode = {}) {
  if (shouldBlockSignedMedia() && containsSignedParams(url)) {
    return { url: redactUrl(url), status: 'skipped', skipped: true, reason: 'signed-url-redacted-not-tested', ok: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(mode.timeout || 15000));
  try {
    const res = await fetchWithSession(session, url, {
      cookies: mode.cookies,
      referer: mode.referer,
      range: 'bytes=0-2047',
      accept: 'video/*,application/vnd.apple.mpegurl,application/x-mpegURL,image/*,*/*',
      signal: controller.signal,
    });
    const ab = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    const ct = res.headers.get('content-type') || '';
    const expected = classifyMedia(url, ct);
    return { url, status: res.status, contentType: ct, bytes: ab.byteLength, ok: (res.status === 200 || res.status === 206) && Boolean(expected), type: expected || 'unknown' };
  } catch (error) {
    return { url, status: 'error', error: error.message, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function readLearningDb() {
  try { return JSON.parse(fs.readFileSync(LEARNING_DB, 'utf8')); } catch { return { version: 1, global: {}, domains: {}, blacklist: {}, updatedAt: null }; }
}

function writeLearningDb(db) {
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(LEARNING_DB, JSON.stringify(db, null, 2));
}

function patternKey(url) {
  try {
    const p = new URL(url);
    let pathname = p.pathname.toLowerCase();
    pathname = pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '{uuid}');
    pathname = pathname.replace(/\d{8,}/g, '{num}');
    pathname = pathname.replace(/(720p|1080p|2160p|4k|2k|uhd)/g, '{quality}');
    return `${p.hostname}${pathname}`;
  } catch {
    return String(url).slice(0, 160).toLowerCase();
  }
}

function scoreCandidate(url, source, db, pageHost) {
  const key = patternKey(url);
  const global = db.global[key] || {};
  const domain = ((db.domains[pageHost] || {})[key]) || {};
  let score = 0.45;
  score += (global.critical || 0) * 0.18 + (domain.critical || 0) * 0.25;
  score += (global.success || 0) * 0.05 + (domain.success || 0) * 0.08;
  score -= (global.notFound || 0) * 0.04 + (domain.notFound || 0) * 0.06;
  score -= (global.falsePositive || 0) * 0.10 + (domain.falsePositive || 0) * 0.12;
  if (containsSignedParams(url)) score += 0.20;
  if (isFullishUrl(url)) score += 0.18;
  if (/network|jw|videojs|performance|manifest/i.test(source || '')) score += 0.08;
  if (db.blacklist[key]) score -= 1;
  return Math.max(0, Math.min(1, score));
}

function learnFromResult(url, result, pageHost) {
  const db = readLearningDb();
  const key = patternKey(url);
  db.global[key] = db.global[key] || { tests: 0, success: 0, critical: 0, notFound: 0, falsePositive: 0 };
  db.domains[pageHost] = db.domains[pageHost] || {};
  db.domains[pageHost][key] = db.domains[pageHost][key] || { tests: 0, success: 0, critical: 0, notFound: 0, falsePositive: 0 };
  for (const bucket of [db.global[key], db.domains[pageHost][key]]) {
    bucket.tests += 1;
    if (result.critical) bucket.critical += 1;
    if (result.ok) bucket.success += 1;
    if (result.status === 404) bucket.notFound += 1;
    if (/text\/html|css|javascript/i.test(result.contentType || '') && !result.ok) bucket.falsePositive += 1;
  }
  if ((db.global[key].falsePositive || 0) >= 5 && (db.global[key].success || 0) === 0) db.blacklist[key] = true;
  writeLearningDb(db);
}

async function getBrowser() {
  if (!browserPromise) {
    const headless = String(process.env.HEADLESS || '').toLowerCase() === 'false' ? false : 'new';
    const userDataDir = path.isAbsolute(process.env.BROWSER_PROFILE_DIR || '') ? process.env.BROWSER_PROFILE_DIR : path.join(ROOT, process.env.BROWSER_PROFILE_DIR || '.browser-profile');
    const launchOptions = {
      headless,
      userDataDir,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required', '--window-size=1366,900',
        '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors'
      ],
      defaultViewport: headless === false ? null : { width: 1366, height: 900, deviceScaleFactor: 1 },
    };
    if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH.replace(/^"|"$/g, '');
    browserPromise = puppeteer.launch(launchOptions);
  }
  return browserPromise;
}

async function installPageHooks(page) {
  await page.evaluateOnNewDocument(() => {
    window.__mediaHunter = [];
    const emit = (kind, value, extra = {}) => {
      try { if (value) window.__mediaHunter.push({ kind, value: String(value), extra, at: new Date().toISOString() }); } catch {}
    };
    const looksUseful = value => {
      const s = String(value || '').toLowerCase();
      return /\.m3u8|\.mp4|\.webm|\.mov|\.mpd|\.ts|\.m4s|ttl=|token=|signature=|full|downloadurl|fullurl/.test(s);
    };
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      try { const u = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url; if (looksUseful(u)) emit('fetch', u); } catch {}
      return originalFetch.apply(window, args);
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try { if (looksUseful(url)) emit('xhr', url, { method }); } catch {}
      return originalOpen.apply(this, arguments);
    };
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      try { if (/^(src|href|poster|data-src)$/i.test(name) && looksUseful(value)) emit(`attr:${this.tagName}.${name}`, value); } catch {}
      return originalSetAttribute.apply(this, arguments);
    };
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(obj) {
      const blobUrl = originalCreateObjectURL.apply(this, arguments);
      try { emit('blob', blobUrl, { size: obj && obj.size, type: obj && obj.type }); } catch {}
      return blobUrl;
    };
  });
}

async function handleManualGate(page, session) {
  if (process.env.MANUAL_AGE_CONFIRM !== 'true') return;
  if (!/confirm-age|age|login|signin/i.test(page.url())) return;
  addLog(session, 'warn', 'Página de validação/login detectada. Valide manualmente no Chrome controlado.');
  try { await page.bringToFront(); } catch {}
  const max = Number(process.env.MANUAL_CONFIRM_TIMEOUT_MS || 180000);
  const started = Date.now();
  while (Date.now() - started < max) {
    if (!/confirm-age/i.test(page.url())) return;
    await sleep(1000);
  }
}

async function collectPageState(page, session) {
  const data = await page.evaluate(() => {
    const out = { dom: [], text: [], storage: { localStorage: {}, sessionStorage: {} }, performance: [], jw: [], videojs: [] };
    const push = (kind, url, extra = {}) => { if (url) out.dom.push({ kind, url, ...extra }); };
    document.querySelectorAll('video').forEach(v => { push('video', v.currentSrc || v.src); if (v.poster) push('poster', v.poster); });
    document.querySelectorAll('source,track').forEach(s => push(`${s.tagName}.src`, s.src || s.getAttribute('src'), { type: s.type || '' }));
    document.querySelectorAll('a[href]').forEach(a => push('a.href', a.href, { text: (a.innerText || '').slice(0, 80) }));
    document.querySelectorAll('img,picture source').forEach(img => push('image', img.currentSrc || img.src || img.srcset || img.getAttribute('src') || img.getAttribute('srcset'), { width: img.naturalWidth || 0, height: img.naturalHeight || 0, alt: img.alt || '' }));
    try { out.performance = performance.getEntriesByType('resource').map(e => e.name).filter(Boolean); } catch {}
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.storage.localStorage[k] = localStorage.getItem(k); } } catch {}
    try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.storage.sessionStorage[k] = sessionStorage.getItem(k); } } catch {}
    try { out.text.push({ kind: 'html', value: document.documentElement.outerHTML.slice(0, 600000) }); } catch {}
    try {
      if (window.jwplayer) {
        const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
        for (const id of ids) {
          try {
            const p = window.jwplayer(id);
            if (p && typeof p.getPlaylist === 'function') out.jw.push({ id, playlist: p.getPlaylist(), config: typeof p.getConfig === 'function' ? p.getConfig() : null });
          } catch {}
        }
      }
    } catch {}
    try {
      if (window.videojs) {
        const players = window.videojs.getPlayers ? window.videojs.getPlayers() : {};
        for (const id of Object.keys(players)) {
          const p = players[id];
          out.videojs.push({ id, src: p.currentSrc && p.currentSrc(), sources: p.currentSources && p.currentSources() });
        }
      }
    } catch {}
    return out;
  }).catch(() => null);
  if (!data) return;
  session.storage = data.storage || session.storage;
  for (const item of data.dom || []) addMedia(session, item.url, `dom:${item.kind}`, item.type || '', item);
  for (const name of data.performance || []) addMedia(session, name, 'performance');
  for (const entry of data.text || []) {
    addText(session, session.finalUrl, 'text/html', entry.value, entry.kind);
    for (const found of extractUrlsFromText(entry.value, session.finalUrl, entry.kind)) addMedia(session, found.url, found.source);
  }
  for (const jw of data.jw || []) {
    addText(session, session.finalUrl, 'application/json', JSON.stringify(jw), 'jwplayer');
    for (const found of extractUrlsFromText(JSON.stringify(jw), session.finalUrl, 'jwplayer')) addMedia(session, found.url, found.source);
  }
  for (const vj of data.videojs || []) {
    addText(session, session.finalUrl, 'application/json', JSON.stringify(vj), 'videojs');
    for (const found of extractUrlsFromText(JSON.stringify(vj), session.finalUrl, 'videojs')) addMedia(session, found.url, found.source);
  }
  for (const [k, v] of Object.entries(data.storage.localStorage || {})) {
    for (const found of extractUrlsFromText(String(v), session.finalUrl, `localStorage:${k}`)) addMedia(session, found.url, found.source);
  }
}

async function drainHooks(page, session) {
  const events = await page.evaluate(() => { const x = window.__mediaHunter ? [...window.__mediaHunter] : []; window.__mediaHunter = []; return x; }).catch(() => []);
  for (const event of events) {
    addText(session, session.finalUrl, 'text/plain', event.value, `hook:${event.kind}`);
    for (const found of extractUrlsFromText(event.value, session.finalUrl, `hook:${event.kind}`)) addMedia(session, found.url, found.source, event.extra && event.extra.type, event.extra || {});
  }
}

async function analyzeUrl(targetUrl) {
  const pageUrl = normalizeUrl(targetUrl);
  if (!pageUrl || !/^https?:\/\//.test(pageUrl)) throw new Error('URL inválida.');
  const session = createSession(pageUrl);
  const browser = await getBrowser();
  const page = await browser.newPage();
  session.page = page;
  await installPageHooks(page);

  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    client.on('Network.responseReceivedExtraInfo', e => {
      const setCookie = (e.headers && (e.headers['set-cookie'] || e.headers['Set-Cookie'])) || '';
      if (setCookie) session.setCookies.push({ setCookie: String(setCookie).slice(0, 20000), time: new Date().toISOString() });
    });
  } catch {}

  page.on('request', req => {
    const url = req.url();
    session.network.push({ phase: 'request', method: req.method(), resourceType: req.resourceType(), url, time: new Date().toISOString() });
    if (session.network.length > 3000) session.network.shift();
    addMedia(session, url, `request:${req.resourceType()}`);
  });
  page.on('response', async response => {
    const url = response.url();
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    session.network.push({ phase: 'response', method: response.request().method(), status: response.status(), contentType, url, time: new Date().toISOString() });
    if (session.network.length > 3000) session.network.shift();
    addMedia(session, url, 'response', contentType, { status: response.status() });
    if (/json|javascript|text|html|xml|mpegurl|vnd\.apple\.mpegurl/i.test(contentType) || /\.(m3u8|json|js|html)(\?|$)/i.test(url)) {
      try {
        const text = await response.text();
        addText(session, url, contentType, text, 'response');
        for (const found of extractUrlsFromText(text, url, 'response')) addMedia(session, found.url, found.source);
      } catch {}
    }
  });
  page.on('console', msg => {
    const text = msg.text();
    if (/m3u8|mp4|media|video|hls|blob|cors|cookie|token|ttl|full/i.test(text)) addLog(session, msg.type() === 'warning' ? 'warn' : msg.type(), text);
  });

  addLog(session, 'info', `Abrindo ${pageUrl}`);
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await handleManualGate(page, session);
  session.finalUrl = page.url();
  session.referer = session.finalUrl;
  session.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => 'Mozilla/5.0');
  await page.evaluate(() => {
    document.querySelectorAll('video').forEach(v => { try { v.muted = true; v.controls = true; v.play().catch(() => {}); } catch {} });
    for (const el of [...document.querySelectorAll('button,a')].slice(0, 80)) {
      const t = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      if (/play|watch|continue|accept|enter|ok/.test(t)) { try { el.click(); } catch {} }
    }
  }).catch(() => {});
  const wait = Number(process.env.ANALYZE_WAIT_MS || 12000);
  const started = Date.now();
  while (Date.now() - started < wait) {
    await drainHooks(page, session);
    await collectPageState(page, session);
    await sleep(1500);
  }
  await drainHooks(page, session);
  await collectPageState(page, session);
  const origins = new Set([session.pageUrl, session.finalUrl]);
  for (const m of session.media.values()) { try { origins.add(new URL(m.url).origin); } catch {} }
  session.cookies = await page.cookies(...[...origins]).catch(() => []);
  addLog(session, 'info', `Análise concluída. Mídias: ${session.media.size}; cookies: ${session.cookies.length}`);
  return serializeSession(session);
}

function serializeSession(session) {
  const media = [...session.media.values()].sort((a, b) => Number(b.playable) - Number(a.playable) || String(a.type).localeCompare(String(b.type))).map(item => ({
    ...item,
    displayUrl: containsSignedParams(item.url) ? redactUrl(item.url) : item.url,
    signed: containsSignedParams(item.url),
    proxyUrl: shouldBlockSignedMedia() && containsSignedParams(item.url) ? null : mediaProxyUrl(session, item.url),
  }));
  return { success: true, sessionId: session.id, pageUrl: session.pageUrl, finalUrl: session.finalUrl, found: { all: media, video: media.filter(m => m.playable), hls: media.filter(m => m.type === 'hls'), images: media.filter(m => m.type === 'image') }, networkCount: session.network.length, logs: session.logs.slice(-250) };
}

function classifyCookie(cookie) {
  const n = String(cookie.name || '').toLowerCase();
  if (/sess|session|auth|login|csrf|xsrf|token/.test(n)) return 'auth/session';
  if (/nats|member|subscr|payment|pay|access|plan/.test(n)) return 'membership/payment';
  if (/ga|gid|utm|track|analytics|fbp|gcl/.test(n)) return 'tracking/analytics';
  if (/locale|lang|theme/.test(n)) return 'preference';
  return 'unknown';
}

function auditCookie(cookie) {
  const category = classifyCookie(cookie);
  const risks = [];
  const sensitive = category === 'auth/session' || category === 'membership/payment';
  if (sensitive && !cookie.secure) risks.push('cookie sensível sem Secure');
  if (sensitive && !cookie.httpOnly && !/csrf|xsrf/i.test(cookie.name)) risks.push('cookie sensível sem HttpOnly');
  if (String(cookie.domain || '').startsWith('.')) risks.push('cookie enviado para subdomínios');
  if (sensitive && (!cookie.sameSite || String(cookie.sameSite).toLowerCase() === 'none') && !cookie.secure) risks.push('SameSite=None sem Secure');
  const riskLevel = risks.some(r => /sem Secure|sem HttpOnly/.test(r)) ? 'high' : risks.length ? 'medium' : 'low';
  return { name: cookie.name, value: process.env.COOKIE_AUDIT_STORE_VALUES === 'true' ? cookie.value : redactValue(cookie.value), domain: cookie.domain, path: cookie.path, expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, category, risks, riskLevel };
}

function redactValue(value) {
  const s = String(value || '');
  if (s.length <= 8) return '[redacted]';
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length})`;
}

async function cookieAudit(session) {
  const cookies = (session.cookies || []).map(auditCookie);
  const summary = { total: cookies.length, byCategory: {}, byRisk: {} };
  for (const c of cookies) {
    summary.byCategory[c.category] = (summary.byCategory[c.category] || 0) + 1;
    summary.byRisk[c.riskLevel] = (summary.byRisk[c.riskLevel] || 0) + 1;
  }
  const report = { summary, cookies, setCookies: session.setCookies, storage: redactStorage(session.storage), generatedAt: new Date().toISOString() };
  report.files = writeReport(session, 'cookie-audit', report);
  return report;
}

function redactStorage(storage) {
  const out = { localStorage: {}, sessionStorage: {} };
  for (const [k, v] of Object.entries((storage && storage.localStorage) || {})) out.localStorage[k] = redactValue(v);
  for (const [k, v] of Object.entries((storage && storage.sessionStorage) || {})) out.sessionStorage[k] = redactValue(v);
  return out;
}

async function accessAudit(session) {
  const media = [...session.media.values()].filter(m => ['hls', 'mp4', 'webm', 'mov', 'image'].includes(m.type)).slice(0, 80);
  const results = [];
  for (const item of media) {
    if (shouldBlockSignedMedia() && containsSignedParams(item.url)) {
      results.push({ label: `${item.type}: URL assinada detectada`, url: redactUrl(item.url), skipped: true, reason: 'signed-url-redacted-not-tested' });
      continue;
    }
    const modes = [
      ['com sessão', { cookies: true, referer: true }],
      ['sem cookies', { cookies: false, referer: true }],
      ['sem referer', { cookies: true, referer: false }],
      ['sem cookies/sem referer', { cookies: false, referer: false }],
    ];
    for (const [label, opts] of modes) {
      const r = await safeFetchTest(session, item.url, opts);
      results.push({ label: `${item.type}: ${label}`, ...r });
    }
  }
  const report = { generatedAt: new Date().toISOString(), pageUrl: session.pageUrl, finalUrl: session.finalUrl, results };
  report.files = writeReport(session, 'access-audit', report);
  return report;
}

function collectHunterSources(session) {
  const candidates = [];
  const push = (url, source, reason = '') => {
    const u = normalizeUrl(url, session.finalUrl || session.pageUrl);
    if (!u || isJunkUrl(u)) return;
    candidates.push({ url: u, source, reason, signed: containsSignedParams(u), fullish: isFullishUrl(u) });
  };
  for (const m of session.media.values()) push(m.url, `media:${(m.sources || []).join(',')}`, 'found-media');
  for (const n of session.network) push(n.url, `network:${n.phase}`, `status:${n.status || ''}`);
  for (const t of session.textBank) for (const f of extractUrlsFromText(t.text, t.url || session.finalUrl, t.source)) push(f.url, f.source, 'text-extract');
  for (const [k, v] of Object.entries(session.storage.localStorage || {})) for (const f of extractUrlsFromText(String(v), session.finalUrl, `localStorage:${k}`)) push(f.url, f.source, 'storage');
  return candidates;
}

function generateFullCandidates(session, knownFull) {
  const out = new Map();
  const add = (url, source, reason) => {
    const u = normalizeUrl(url, session.finalUrl || session.pageUrl);
    if (u && !isJunkUrl(u)) out.set(u, { url: u, source, reason, signed: containsSignedParams(u), fullish: isFullishUrl(u) });
  };
  if (knownFull) add(knownFull, 'user-known-full', 'known-full');
  for (const c of collectHunterSources(session)) add(c.url, c.source, c.reason);
  const baseUrls = [...out.values()].filter(c => /\.(m3u8|mp4)(\?|$)/i.test(c.url)).map(c => c.url);
  for (const u of baseUrls) {
    let p;
    try { p = new URL(u); } catch { continue; }
    const pathname = p.pathname;
    const variants = new Set();
    variants.add(pathname.replace(/video\.m3u8$/i, 'video-full.mp4'));
    variants.add(pathname.replace(/\.m3u8$/i, '.mp4'));
    variants.add(pathname.replace(/_preview|preview|trailer/ig, 'full'));
    variants.add(pathname.replace(/(720p|1080p|2160p|4k|2k)/ig, '1080p'));
    variants.add(pathname.replace(/\/video\//i, '/video-full/'));
    const date = pathname.match(/(20\d{6})/);
    if (date) {
      const root = pathname.replace(/\/[^/]*$/, '/');
      variants.add(`${root}${date[1]}-video-full.mp4`);
      variants.add(`/production/${date[1]}-video-full.mp4`);
      variants.add(`/production/${date[1]}-video.mp4`);
      variants.add(`/production/${date[1]}-full.mp4`);
    }
    for (const v of variants) {
      if (!v || v === pathname) continue;
      const candidate = `${p.origin}${v}`.replace(/\/release\/(\d+)\/release\/\1\//, '/release/$1/');
      add(candidate, 'generated-pattern', 'full-candidate');
    }
  }
  const db = readLearningDb();
  const host = (() => { try { return new URL(session.pageUrl).hostname; } catch { return 'unknown'; } })();
  return [...out.values()].map(c => ({ ...c, redactedUrl: redactUrl(c.url), score: scoreCandidate(c.url, c.source, db, host), pattern: patternKey(c.url) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(process.env.MAX_CANDIDATES || 250));
}

async function fullUrlHunter(session, options = {}) {
  const candidates = generateFullCandidates(session, options.knownFullUrl);
  const results = [];
  const host = (() => { try { return new URL(session.pageUrl).hostname; } catch { return 'unknown'; } })();
  let critical = 0;
  for (const candidate of candidates) {
    if (candidate.signed) {
      results.push({ ...candidate, url: candidate.redactedUrl, skipped: true, finding: 'signed-url-exposed', severity: 'high', reason: 'URL assinada exposta; valores redigidos e não testados' });
      continue;
    }
    const tests = [];
    for (const [mode, opts] of [
      ['with-session', { cookies: true, referer: true }],
      ['no-cookies', { cookies: false, referer: true }],
      ['no-referer', { cookies: true, referer: false }],
      ['anonymous', { cookies: false, referer: false }],
    ]) {
      const r = await safeFetchTest(session, candidate.url, opts);
      tests.push({ mode, ...r });
      const isFullVideo = r.ok && ['mp4', 'hls', 'webm', 'mov', 'video'].includes(r.type) && (candidate.fullish || /full|download|source|original/i.test(candidate.url));
      if (isFullVideo && (mode === 'no-cookies' || mode === 'anonymous')) critical += 1;
    }
    const result = { ...candidate, tests, critical: tests.some(t => t.ok && ['mp4', 'hls', 'webm', 'mov', 'video'].includes(t.type) && (t.mode === 'no-cookies' || t.mode === 'anonymous')) };
    learnFromResult(candidate.url, { ok: tests.some(t => t.ok), critical: result.critical, status: tests[0] && tests[0].status, contentType: tests[0] && tests[0].contentType }, host);
    results.push(result);
  }
  const report = { generatedAt: new Date().toISOString(), pageUrl: session.pageUrl, finalUrl: session.finalUrl, summary: { candidates: candidates.length, signedExposures: results.filter(r => r.finding === 'signed-url-exposed').length, critical }, candidates: results };
  report.files = writeReport(session, 'full-url-hunter', report);
  return report;
}

async function fullLeakAudit(session, options = {}) {
  const known = normalizeUrl(options.knownFullUrl || '', session.finalUrl || session.pageUrl);
  const authorized = normalizeUrl(options.authorizedUrl || '', session.finalUrl || session.pageUrl);
  const tests = [];
  if (known) {
    for (const [mode, opts] of [['with-session', { cookies: true, referer: true }], ['anonymous', { cookies: false, referer: false }]]) tests.push({ target: 'known-full', mode, ...(await safeFetchTest(session, known, opts)) });
  }
  if (authorized) {
    if (shouldBlockSignedMedia() && containsSignedParams(authorized)) tests.push({ target: 'authorized-url', url: redactUrl(authorized), skipped: true, reason: 'authorized signed URL redacted and not tested in defense release' });
    else for (const [mode, opts] of [['with-session', { cookies: true, referer: true }], ['anonymous', { cookies: false, referer: false }]]) tests.push({ target: 'authorized-url', mode, ...(await safeFetchTest(session, authorized, opts)) });
  }
  const exposed = collectHunterSources(session).filter(c => containsSignedParams(c.url)).map(c => ({ redactedUrl: redactUrl(c.url), source: c.source, reason: c.reason, fullish: isFullishUrl(c.url) }));
  const report = { generatedAt: new Date().toISOString(), pageUrl: session.pageUrl, finalUrl: session.finalUrl, tests, signedExposures: exposed };
  report.files = writeReport(session, 'full-leak-audit', report);
  return report;
}

function buildDefenseReport(session) {
  const cookies = (session.cookies || []).map(auditCookie);
  const signed = collectHunterSources(session).filter(c => containsSignedParams(c.url));
  const fullish = collectHunterSources(session).filter(c => isFullishUrl(c.url));
  const recommendations = [];
  if (signed.length) recommendations.push('URLs assinadas foram expostas ao navegador. Verifique se apenas usuários autorizados recebem essas URLs e reduza TTL.');
  if (cookies.some(c => c.risks && c.risks.length)) recommendations.push('Corrija atributos de cookies sensíveis: Secure, HttpOnly e SameSite.');
  recommendations.push('Use assinatura atrelada a path exato, usuário/sessão e expiração curta.');
  recommendations.push('Não exponha URL full no HTML/JS para usuários sem permissão. Gere a URL full server-side somente após validação.');
  recommendations.push('Proteja segmentos HLS, não apenas o manifesto.');
  const report = { generatedAt: new Date().toISOString(), pageUrl: session.pageUrl, finalUrl: session.finalUrl, counts: { cookies: cookies.length, signedExposures: signed.length, fullishCandidates: fullish.length }, cookies, signedExposures: signed.map(c => ({ redactedUrl: redactUrl(c.url), source: c.source, reason: c.reason })), recommendations };
  report.files = writeReport(session, 'defense-report', report);
  return report;
}

function parseM3u8(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const segments = [];
  const variants = [];
  let lastInf = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#EXT-X-STREAM-INF')) { lastInf = trimmed; continue; }
    if (trimmed.startsWith('#')) continue;
    const u = normalizeUrl(trimmed, baseUrl);
    if (!u) continue;
    if (lastInf) { variants.push({ url: u, info: lastInf, signed: containsSignedParams(u), redactedUrl: redactUrl(u) }); lastInf = null; }
    else segments.push({ url: u, signed: containsSignedParams(u), redactedUrl: redactUrl(u) });
  }
  return { variants, segments, isMaster: variants.length > 0, segmentCount: segments.length };
}

async function hlsResolve(session, url) {
  const target = normalizeUrl(url, session.finalUrl || session.pageUrl);
  if (!target) throw new Error('URL HLS inválida.');
  if (shouldBlockSignedMedia() && containsSignedParams(target)) return { success: false, skipped: true, reason: 'signed-url-redacted-not-resolved', url: redactUrl(target) };
  const res = await fetchWithSession(session, target, { accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' });
  const text = await res.text();
  if (!res.ok) return { success: false, status: res.status, contentType: res.headers.get('content-type') || '', url: target, message: text.slice(0, 500) };
  const parsed = parseM3u8(text, target);
  const report = { success: true, url: target, status: res.status, contentType: res.headers.get('content-type') || '', parsed };
  writeReport(session, 'hls-resolve', report);
  return report;
}

async function proxyHandler(req, res) {
  const session = getSession(String(req.query.session || ''));
  const targetUrl = String(req.query.url || '');
  if (!session) return res.status(404).send('Sessão não encontrada.');
  if (!targetUrl) return res.status(400).send('URL ausente.');
  if (shouldBlockSignedMedia() && containsSignedParams(targetUrl)) return res.status(403).send('URL assinada detectada; proxy bloqueado nesta versão de defesa. Defina ALLOW_SIGNED_MEDIA=true para compatibilidade.');
  try { session.allowedHosts.add(new URL(targetUrl).hostname); } catch {}
  try {
    const upstream = await fetchWithSession(session, targetUrl, { range: req.headers.range, accept: req.headers.accept || '*/*' });
    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(key);
      if (v) res.setHeader(key, v);
    }
    if (!upstream.body) return res.send(Buffer.from(await upstream.arrayBuffer()));
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', err => {
      addLog(session, 'warn', `Proxy stream encerrado: ${err.message}`);
      if (!res.headersSent) res.status(502).end('stream error'); else res.end();
    });
    stream.pipe(res);
  } catch (error) {
    addLog(session, 'error', `Proxy falhou: ${error.message}`, { url: targetUrl });
    if (!res.headersSent) res.status(502).send(`Proxy falhou: ${error.message}`);
  }
}

app.get('/api/health', (_, res) => res.json({ ok: true, version: '10.0.1-defense', port: PORT, sessions: sessions.size, latestSessionId, puppeteer: '24.x', learningDb: fs.existsSync(LEARNING_DB), allowSignedMedia: allowSignedMedia() }));
app.post('/api/analyze', async (req, res) => { try { res.json(await analyzeUrl(req.body.url)); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.post('/analyze', async (req, res) => { try { res.json(await analyzeUrl(req.body.url)); } catch (e) { res.status(500).json({ success: false, error: e.message }); } });
app.get('/api/events', (req, res) => {
  const session = getSession(String(req.query.session || ''));
  if (!session) return res.status(404).end('Sessão não encontrada');
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  session.clients.add(res);
  res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'Console conectado.' })}\n\n`);
  req.on('close', () => session.clients.delete(res));
});
app.get('/api/session/:id', (req, res) => { const s = getSession(req.params.id); if (!s) return res.status(404).json({ success: false, error: 'Sessão não encontrada' }); res.json(serializeSession(s)); });
app.post('/api/cookie-audit', async (req, res) => { const s = getSession(req.body.sessionId); if (!s) return res.status(404).json({ error: 'Sessão não encontrada' }); res.json(await cookieAudit(s)); });
app.post('/api/access-audit', async (req, res) => { const s = getSession(req.body.sessionId); if (!s) return res.status(404).json({ error: 'Sessão não encontrada' }); res.json(await accessAudit(s)); });
app.post('/api/hls/resolve', async (req, res) => { const s = getSession(req.body.sessionId); if (!s) return res.status(404).json({ error: 'Sessão não encontrada' }); try { res.json(await hlsResolve(s, req.body.url)); } catch (e) { res.status(200).json({ success: false, error: e.message }); } });
app.post('/api/full-leak-audit', async (req, res) => { const s = getSession(req.body.sessionId); if (!s) return res.status(404).json({ error: 'Sessão não encontrada' }); res.json(await fullLeakAudit(s, req.body)); });
app.post('/api/full-url-hunter', async (req, res) => { const s = getSession(req.body.sessionId); if (!s) return res.status(404).json({ error: 'Sessão não encontrada' }); res.json(await fullUrlHunter(s, req.body)); });
app.post('/api/defense/report', async (req, res) => { const s = getSession(req.body.sessionId); if (!s) return res.status(404).json({ error: 'Sessão não encontrada' }); res.json(buildDefenseReport(s)); });
app.get('/api/learning', (_, res) => res.json(readLearningDb()));
app.post('/api/learning/reset', (_, res) => { writeLearningDb({ version: 1, global: {}, domains: {}, blacklist: {}, updatedAt: new Date().toISOString() }); res.json({ success: true }); });
app.options('/api/proxy', (_, res) => res.status(204).end());
app.get('/api/proxy', proxyHandler);
app.get('/proxy', proxyHandler);

app.listen(PORT, async () => {
  const browser = await getBrowser();
  const url = `http://localhost:${PORT}`;
  console.log(`HLS Media Auditor v10 Defense: ${url} | signed media ${allowSignedMedia() ? 'enabled' : 'blocked'}`);
  if (process.env.AUTO_OPEN !== 'false') {
    try { const page = await browser.newPage(); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch { exec(process.platform === 'win32' ? `start chrome ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`, () => {}); }
  }
});
