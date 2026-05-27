const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const { buildWorkflow, applyAxisOverride } = require('./workflow');
const tagger = require('./tagger');

// ---------- local persistence ----------
function storeFile(name) {
  return path.join(app.getPath('userData'), name);
}
function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(storeFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(name, data) {
  fs.writeFileSync(storeFile(name), JSON.stringify(data, null, 2), 'utf8');
}

// ---------- ComfyUI client ----------
function normalizeBase(url) {
  let u = (url || 'http://127.0.0.1:8188').trim();
  u = u.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = 'http://' + u;
  return u;
}
function wsUrlFromHttp(base) {
  return base.replace(/^http/, 'ws') + '/ws';
}

async function comfyPing(url) {
  const base = normalizeBase(url);
  console.log('[comfyPing] →', base + '/system_stats');
  try {
    const r = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(5000) });
    console.log('[comfyPing] ←', r.status, r.statusText);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: true, base, system: data };
  } catch (e) {
    console.error('[comfyPing] ERROR:', e);
    return { ok: false, error: String(e.message || e) };
  }
}

async function comfyObjectInfo(url) {
  const base = normalizeBase(url);
  console.log('[comfyObjectInfo] → fetching', base + '/object_info');
  const t0 = Date.now();
  const r = await fetch(base + '/object_info', { signal: AbortSignal.timeout(30000) });
  console.log('[comfyObjectInfo] ← status', r.status, 'in', Date.now() - t0, 'ms');
  if (!r.ok) throw new Error('object_info HTTP ' + r.status);
  const info = await r.json();
  console.log('[comfyObjectInfo] parsed JSON, keys:', Object.keys(info).length,
    'has UNETLoader:', !!info.UNETLoader,
    'has CLIPLoader:', !!info.CLIPLoader,
    'has VAELoader:', !!info.VAELoader);

  const extractCombo = (cls, key, slot) => {
    const idx = slot || 0;
    try {
      // input.required[key] is [combo_array, options_dict?] OR sometimes [combo_array]
      const spec = info[cls].input.required[key];
      const arr = spec && spec[0];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };
  const extractOptional = (cls, key) => {
    try {
      const spec = info[cls].input.optional && info[cls].input.optional[key];
      const arr = spec && spec[0];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  };

  // weight_dtype lives under optional in some ComfyUI versions
  const weightDtypes =
    extractCombo('UNETLoader', 'weight_dtype').length
      ? extractCombo('UNETLoader', 'weight_dtype')
      : extractOptional('UNETLoader', 'weight_dtype');

  return {
    unets: extractCombo('UNETLoader', 'unet_name'),
    textEncoders: extractCombo('CLIPLoader', 'clip_name'),
    clipTypes: extractCombo('CLIPLoader', 'type'),
    weightDtypes: weightDtypes.length ? weightDtypes : ['default', 'fp8_e4m3fn', 'fp8_e5m2'],
    vaes: extractCombo('VAELoader', 'vae_name'),
    loras: extractCombo('LoraLoader', 'lora_name'),
    samplers: extractCombo('KSampler', 'sampler_name'),
    schedulers: extractCombo('KSampler', 'scheduler'),
  };
}

async function submitPrompt(base, workflow, clientId) {
  const r = await fetch(base + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    // Try to parse ComfyUI's structured node_errors body to produce a human-
    // readable diagnostic instead of a wall of JSON.
    let parsed = null;
    try { parsed = JSON.parse(t); } catch {}
    if (parsed && parsed.node_errors && Object.keys(parsed.node_errors).length) {
      const lines = [`HTTP ${r.status} - ${parsed.error && parsed.error.message || 'prompt validation failed'}`];
      for (const [nodeId, info] of Object.entries(parsed.node_errors)) {
        const cls = (workflow[nodeId] && workflow[nodeId].class_type) || info.class_type || '?';
        const inputs = (workflow[nodeId] && workflow[nodeId].inputs) || {};
        lines.push(`▸ 节点 ${nodeId} (${cls}):`);
        const errs = info.errors || [];
        for (const e of errs) {
          const input = e.details && e.details.input_name ? e.details.input_name : (e.extra_info && e.extra_info.input_name) || '?';
          let val = '?';
          if (input !== '?' && Object.prototype.hasOwnProperty.call(inputs, input)) {
            const raw = inputs[input];
            val = typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw);
          }
          lines.push(`    [${e.type}] ${e.message || ''}  字段=${input}  值=${val}`);
          if (e.details && typeof e.details === 'string' && e.details.length < 200) {
            lines.push(`    details: ${e.details}`);
          }
          if (e.extra_info && Array.isArray(e.extra_info.input_config)) {
            // input_config[0] usually contains the allowed value list for combos
            const allowed = e.extra_info.input_config[0];
            if (Array.isArray(allowed)) {
              const head = allowed.slice(0, 6).join(', ');
              lines.push(`    允许的值（前 6 个，共 ${allowed.length}）: ${head}${allowed.length > 6 ? ', …' : ''}`);
            }
          }
        }
      }
      const msg = lines.join('\n');
      console.error('[submitPrompt] node_errors:\n' + msg);
      console.error('[submitPrompt] workflow JSON:', JSON.stringify(workflow, null, 2));
      throw new Error(msg);
    }
    console.error('[submitPrompt] raw response:', t);
    console.error('[submitPrompt] workflow JSON:', JSON.stringify(workflow, null, 2));
    throw new Error('提交 prompt 失败 HTTP ' + r.status + ': ' + t.slice(0, 800));
  }
  return r.json(); // { prompt_id, number, node_errors }
}

async function fetchHistory(base, promptId) {
  const r = await fetch(base + '/history/' + promptId);
  if (!r.ok) throw new Error('history HTTP ' + r.status);
  return r.json();
}

async function fetchImage(base, filename, subfolder, type) {
  const qs = new URLSearchParams({ filename, subfolder: subfolder || '', type: type || 'output' });
  const r = await fetch(base + '/view?' + qs.toString());
  if (!r.ok) throw new Error('view HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function interruptComfy(base) {
  try { await fetch(base + '/interrupt', { method: 'POST' }); } catch {}
}

// Open a single ws and multiplex it. Reconnect on demand.
class ComfySocket {
  constructor(base, clientId) {
    this.base = base;
    this.clientId = clientId;
    this.ws = null;
    this.listeners = new Set();
    this.connected = false;
  }
  ensureOpen() {
    return new Promise((resolve, reject) => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) return resolve();
      const url = wsUrlFromHttp(this.base) + '?clientId=' + encodeURIComponent(this.clientId);
      this.ws = new WebSocket(url);
      const onOpen = () => { this.connected = true; resolve(); };
      const onErr = (e) => { this.connected = false; reject(e); };
      this.ws.once('open', onOpen);
      this.ws.once('error', onErr);
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        for (const fn of this.listeners) fn(msg);
      });
      // Broadcast a synthetic close event so listeners (waitForPrompt) can
      // unblock instead of hanging forever when the socket is closed by cancel.
      this.ws.on('close', () => {
        this.connected = false;
        for (const fn of this.listeners) { try { fn({ __closed: true }); } catch {} }
      });
      this.ws.on('error', (err) => {
        for (const fn of this.listeners) { try { fn({ __error: String((err && err.message) || err) }); } catch {} }
      });
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() {
    try { this.ws && this.ws.close(); } catch {}
    this.connected = false;
    // Also fire the synthetic close in case ws.close() doesn't (already closed)
    for (const fn of this.listeners) { try { fn({ __closed: true }); } catch {} }
  }
}

// Wait for prompt_id to finish; resolves with image references from history.
// Accepts an optional `token` ({ cancelled }) so we can reject early on cancel.
async function waitForPrompt(sock, base, promptId, onCellProgress, token) {
  return new Promise((resolve, reject) => {
    let done = false;
    if (token && token.cancelled) return reject(new Error('cancelled'));
    const off = sock.on(async (msg) => {
      if (done) return;
      // Synthetic close/error from ComfySocket — break the wait immediately.
      if (msg && msg.__closed) {
        done = true;
        off();
        return reject(new Error(token && token.cancelled ? 'cancelled' : 'WebSocket closed'));
      }
      if (msg && msg.__error) {
        done = true;
        off();
        return reject(new Error('WebSocket error: ' + msg.__error));
      }
      if (msg.type === 'progress' && msg.data && onCellProgress) {
        // per-step progress within this cell
        onCellProgress({ step: msg.data.value, total: msg.data.max });
      }
      if (msg.type === 'executing' && msg.data && msg.data.prompt_id === promptId && msg.data.node === null) {
        done = true;
        off();
        try {
          const hist = await fetchHistory(base, promptId);
          const entry = hist[promptId];
          if (!entry) return reject(new Error('history empty for prompt ' + promptId));
          const outputs = entry.outputs || {};
          const images = [];
          for (const k of Object.keys(outputs)) {
            const arr = outputs[k].images;
            if (Array.isArray(arr)) for (const img of arr) images.push(img);
          }
          if (!images.length) return reject(new Error('no images returned'));
          resolve(images);
        } catch (e) {
          reject(e);
        }
      }
      if (msg.type === 'execution_error' && msg.data && msg.data.prompt_id === promptId) {
        done = true; off();
        reject(new Error('execution_error: ' + (msg.data.exception_message || msg.data.exception_type || 'unknown')));
      }
    });
  });
}

// ---------- grid runner ----------
const activeJobs = new Map(); // jobId -> { cancelled, sock, base }

async function runGrid(opts, sender) {
  const jobId = crypto.randomUUID();
  const clientId = 'anima-xy-' + crypto.randomBytes(6).toString('hex');
  const base = normalizeBase(opts.server);
  const token = { cancelled: false, sock: null, base };
  activeJobs.set(jobId, token);

  const emit = (p) => { try { sender.send('comfy:progress', { jobId, ...p }); } catch {} };

  const cells = expandCells(opts.xAxis, opts.yAxis);
  emit({ status: 'starting', jobId, cells: cells.length, xLabels: cells.xLabels, yLabels: cells.yLabels, xLen: cells.xLen, yLen: cells.yLen });

  const sock = new ComfySocket(base, clientId);
  token.sock = sock;
  try {
    await sock.ensureOpen();
  } catch (e) {
    emit({ status: 'error', error: 'WebSocket 连接失败: ' + (e.message || e) });
    activeJobs.delete(jobId);
    return { jobId, ok: false, error: String(e.message || e) };
  }

  let completed = 0;
  let errors = 0;
  for (const cell of cells.list) {
    if (token.cancelled) break;

    // build workflow for this cell
    const cellCfg = JSON.parse(JSON.stringify(opts.base));
    applyAxisOverride(cellCfg, opts.xAxis, cell.xIndex);
    applyAxisOverride(cellCfg, opts.yAxis, cell.yIndex);

    let workflow;
    try {
      workflow = buildWorkflow(cellCfg);
    } catch (e) {
      errors++;
      emit({ status: 'cell-error', cellIndex: cell.index, xIndex: cell.xIndex, yIndex: cell.yIndex, error: 'workflow 构造失败: ' + e.message });
      completed++;
      continue;
    }

    emit({ status: 'cell-start', cellIndex: cell.index, xIndex: cell.xIndex, yIndex: cell.yIndex, completed, total: cells.list.length });

    let promptResp;
    try {
      promptResp = await submitPrompt(base, workflow, clientId);
    } catch (e) {
      errors++;
      emit({ status: 'cell-error', cellIndex: cell.index, xIndex: cell.xIndex, yIndex: cell.yIndex, error: String(e.message || e) });
      completed++;
      continue;
    }
    if (promptResp.node_errors && Object.keys(promptResp.node_errors).length) {
      errors++;
      emit({ status: 'cell-error', cellIndex: cell.index, xIndex: cell.xIndex, yIndex: cell.yIndex, error: 'node_errors: ' + JSON.stringify(promptResp.node_errors).slice(0, 500) });
      completed++;
      continue;
    }

    try {
      const images = await waitForPrompt(sock, base, promptResp.prompt_id, (p) => {
        emit({ status: 'cell-step', cellIndex: cell.index, step: p.step, total: p.total });
      }, token);
      const first = images[0];
      const buf = await fetchImage(base, first.filename, first.subfolder, first.type);
      const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
      completed++;
      emit({
        status: 'cell-done',
        cellIndex: cell.index, xIndex: cell.xIndex, yIndex: cell.yIndex,
        dataUrl, filename: first.filename, subfolder: first.subfolder, type: first.type,
        completed, total: cells.list.length,
      });
    } catch (e) {
      errors++;
      completed++;
      emit({ status: 'cell-error', cellIndex: cell.index, xIndex: cell.xIndex, yIndex: cell.yIndex, error: String(e.message || e), completed, total: cells.list.length });
    }
  }

  sock.close();
  const finalStatus = token.cancelled ? 'cancelled' : 'done';
  emit({ status: finalStatus, completed, total: cells.list.length, errors });
  activeJobs.delete(jobId);
  return { jobId, ok: true, completed, errors, cancelled: token.cancelled };
}

function expandCells(xAxis, yAxis) {
  const xVals = (xAxis && xAxis.values && xAxis.values.length) ? xAxis.values : [null];
  const yVals = (yAxis && yAxis.values && yAxis.values.length) ? yAxis.values : [null];
  const list = [];
  for (let y = 0; y < yVals.length; y++) {
    for (let x = 0; x < xVals.length; x++) {
      list.push({ index: y * xVals.length + x, xIndex: x, yIndex: y });
    }
  }
  return {
    list,
    xLen: xVals.length,
    yLen: yVals.length,
    xLabels: xVals.map((v) => labelFor(xAxis, v)),
    yLabels: yVals.map((v) => labelFor(yAxis, v)),
  };
}
function labelFor(axis, v) {
  if (v == null) return '';
  if (!axis) return String(v);
  if (axis.type === 'lora_weight') return String(v);
  if (axis.type === 'lora_file') return basename(v);
  if (axis.type === 'sampler') return String(v);
  if (axis.type === 'sampler_scheduler') {
    if (v && typeof v === 'object') return `${v.sampler} + ${v.scheduler}`;
    return String(v);
  }
  return String(v);
}
function basename(p) {
  if (!p) return '';
  return String(p).split(/[\\/]/).pop();
}

function cancelJob(jobId) {
  const j = activeJobs.get(jobId);
  if (!j) return false;
  j.cancelled = true;
  interruptComfy(j.base);
  try { j.sock && j.sock.close(); } catch {}
  return true;
}

// ---------- save helpers ----------
async function saveGridImage({ dataUrl, suggestedName }) {
  const r = await dialog.showSaveDialog({
    title: '保存 XY 网格',
    defaultPath: suggestedName || 'anima_xy_grid.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  try {
    const b64 = String(dataUrl).split(',', 2)[1] || '';
    fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
    return { ok: true, filePath: r.filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function saveCellImage({ dataUrl, suggestedName }) {
  const r = await dialog.showSaveDialog({
    title: '保存单元格图片',
    defaultPath: suggestedName || 'cell.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  try {
    const b64 = String(dataUrl).split(',', 2)[1] || '';
    fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
    return { ok: true, filePath: r.filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function pickFolder() {
  const r = await dialog.showOpenDialog({
    title: '选择目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
}

let lastLoraDir = null;
async function pickLoraFiles({ multi }) {
  const props = multi ? ['openFile', 'multiSelections'] : ['openFile'];
  const opts = {
    title: '选择 LoRA 文件',
    properties: props,
    filters: [
      { name: 'LoRA', extensions: ['safetensors', 'pt', 'ckpt', 'bin'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
  if (lastLoraDir && fs.existsSync(lastLoraDir)) opts.defaultPath = lastLoraDir;
  const r = await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths.length) return [];
  lastLoraDir = path.dirname(r.filePaths[0]);
  writeJson('settings_main.json', { lastLoraDir });
  return r.filePaths;
}
// restore lastLoraDir at startup
try {
  const s = readJson('settings_main.json', {});
  if (s.lastLoraDir) lastLoraDir = s.lastLoraDir;
} catch {}

// ---------- IPC ----------
ipcMain.handle('comfy:ping', (_e, url) => comfyPing(url));
ipcMain.handle('comfy:objectInfo', (_e, url) => comfyObjectInfo(url));
ipcMain.handle('comfy:runGrid', (e, opts) => runGrid(opts, e.sender));
ipcMain.handle('comfy:cancel', (_e, jobId) => cancelJob(jobId));
ipcMain.handle('grid:save', (_e, opts) => saveGridImage(opts));
ipcMain.handle('cell:save', (_e, opts) => saveCellImage(opts));
ipcMain.handle('dialog:pickFolder', () => pickFolder());
ipcMain.handle('dialog:pickLoraFiles', (_e, opts) => pickLoraFiles(opts || {}));

// ---------- tagger IPC ----------
ipcMain.handle('tagger:status', () => tagger.getStatus());
ipcMain.handle('tagger:inspectDir', (_e, dir) => tagger.inspectModelDir(dir));
ipcMain.handle('tagger:load', async (_e, dir) => {
  try {
    const status = await tagger.loadModel(dir);
    return { ok: true, ...status };
  } catch (e) {
    console.error('[tagger:load] error:', e);
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('tagger:run', async (_e, opts) => {
  try {
    const res = await tagger.runInference(opts.imagePath, opts.threshold);
    return { ok: true, ...res };
  } catch (e) {
    console.error('[tagger:run] error:', e);
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('tagger:pickImage', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择要打标的图片',
    properties: ['openFile'],
    filters: [
      { name: '图像', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('tagger:pickModelDir', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择包含 camie-tagger-v2.onnx 和 metadata.json 的目录',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('tagger:defaultModelDir', () => path.join(__dirname, 'tagger_models'));
// ---------- tagger model download ----------
const HF_REPO = 'Camais03/camie-tagger-v2';
const TAGGER_FILES = [
  // metadata first (small, fast feedback that things work)
  { name: 'camie-tagger-v2-metadata.json', expected: 8_150_000 },
  { name: 'camie-tagger-v2.onnx',          expected: 827_400_000 },
];
const taggerDownloads = new Map(); // jobId -> AbortController

async function downloadTaggerModel({ dir, force, jobId }, sender) {
  fs.mkdirSync(dir, { recursive: true });
  const ctrl = new AbortController();
  taggerDownloads.set(jobId, ctrl);
  const emit = (p) => { try { sender.send('tagger:download', { jobId, ...p }); } catch {} };

  try {
    for (const f of TAGGER_FILES) {
      const dest = path.join(dir, f.name);
      if (!force && fs.existsSync(dest)) {
        const size = fs.statSync(dest).size;
        // Treat as complete only if within 5% of expected size
        if (size > f.expected * 0.95) {
          emit({ file: f.name, status: 'skipped', received: size, total: size });
          continue;
        }
      }
      const url = `https://huggingface.co/${HF_REPO}/resolve/main/${f.name}`;
      emit({ file: f.name, status: 'start', received: 0, total: f.expected });
      await streamDownload(url, dest, ctrl.signal, (received, total) => {
        emit({ file: f.name, status: 'progress', received, total: total || f.expected });
      });
      emit({ file: f.name, status: 'done', received: fs.statSync(dest).size, total: fs.statSync(dest).size });
    }
    emit({ status: 'all-done' });
    return { ok: true };
  } catch (e) {
    const aborted = ctrl.signal.aborted || /aborted/i.test(String(e.message || e));
    emit({ status: aborted ? 'cancelled' : 'error', error: String(e.message || e) });
    return { ok: false, cancelled: aborted, error: String(e.message || e) };
  } finally {
    taggerDownloads.delete(jobId);
  }
}

async function streamDownload(url, dest, signal, onProgress) {
  // partial-file safety: write to .part, rename on completion
  const tmp = dest + '.part';
  try { fs.unlinkSync(tmp); } catch {}
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  const ws = fs.createWriteStream(tmp);
  let received = 0;
  let lastEmit = 0;
  try {
    const reader = res.body.getReader();
    while (true) {
      if (signal.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      if (!ws.write(Buffer.from(value))) {
        await new Promise((r, j) => { ws.once('drain', r); ws.once('error', j); });
      }
      received += value.length;
      const now = Date.now();
      if (now - lastEmit > 200) {
        onProgress(received, total);
        lastEmit = now;
      }
    }
    await new Promise((r, j) => { ws.end((err) => err ? j(err) : r()); });
    fs.renameSync(tmp, dest);
    onProgress(received, total);
  } catch (e) {
    try { ws.destroy(); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function cancelTaggerDownload(jobId) {
  const ctrl = taggerDownloads.get(jobId);
  if (ctrl) { ctrl.abort(); return true; }
  return false;
}

ipcMain.handle('tagger:download', (e, opts) => downloadTaggerModel(opts || {}, e.sender));
ipcMain.handle('tagger:cancelDownload', (_e, jobId) => cancelTaggerDownload(jobId));

// ---------- dataset tag editor ----------
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif'];
let lastDatasetDir = null;
try {
  const s = readJson('settings_main.json', {});
  if (s.lastDatasetDir) lastDatasetDir = s.lastDatasetDir;
} catch {}

function tagsPathFor(imagePath) {
  const ext = path.extname(imagePath);
  return imagePath.slice(0, imagePath.length - ext.length) + '.txt';
}

function parseTagsText(text) {
  if (!text) return [];
  // Accept comma OR newline OR tab as separator. Trim whitespace per tag.
  return String(text)
    .split(/[,\n\t]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatTagsForFile(tags) {
  // Standard danbooru / sd-scripts caption: comma+space joined, single line.
  return Array.from(tags).join(', ');
}

function dedupePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

async function pickDatasetDir() {
  const opts = {
    title: '选择数据集目录',
    properties: ['openDirectory', 'createDirectory'],
  };
  if (lastDatasetDir && fs.existsSync(lastDatasetDir)) opts.defaultPath = lastDatasetDir;
  const r = await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths.length) return null;
  lastDatasetDir = r.filePaths[0];
  try {
    const cur = readJson('settings_main.json', {});
    writeJson('settings_main.json', { ...cur, lastDatasetDir });
  } catch {}
  return lastDatasetDir;
}

function listDataset({ dir, recursive }) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '目录不存在: ' + dir };
  const images = [];
  const walk = (root, prefix) => {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(root, ent.name);
      if (ent.isDirectory()) {
        if (recursive) walk(full, prefix ? prefix + '/' + ent.name : ent.name);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (!IMG_EXTS.includes(ext)) continue;
      const tagsPath = tagsPathFor(full);
      let hasTags = false; let tagCount = 0;
      try {
        if (fs.existsSync(tagsPath)) {
          hasTags = true;
          const t = parseTagsText(fs.readFileSync(tagsPath, 'utf8'));
          tagCount = t.length;
        }
      } catch {}
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      images.push({
        filename: ent.name,
        relPath: prefix ? prefix + '/' + ent.name : ent.name,
        path: full,
        tagsPath,
        hasTags,
        tagCount,
        size,
      });
    }
  };
  walk(dir, '');
  // Sort alphabetically (case-insensitive)
  images.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
  return { ok: true, dir, images };
}

function readTagsFile(imagePath) {
  try {
    const tp = tagsPathFor(imagePath);
    if (!fs.existsSync(tp)) return { ok: true, exists: false, tags: [], raw: '' };
    const raw = fs.readFileSync(tp, 'utf8');
    return { ok: true, exists: true, tags: parseTagsText(raw), raw };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function writeTagsFile({ imagePath, tags }) {
  try {
    const tp = tagsPathFor(imagePath);
    const clean = dedupePreserveOrder((Array.isArray(tags) ? tags : parseTagsText(tags)).map((s) => s.trim()).filter(Boolean));
    fs.writeFileSync(tp, formatTagsForFile(clean), 'utf8');
    return { ok: true, tagsPath: tp, tagCount: clean.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * op: 'add' | 'remove' | 'replace' | 'rename' | 'clear'
 * args:
 *   add:     { tags: [string], position: 'start'|'end' }
 *   remove:  { tags: [string] }                       // case-insensitive
 *   replace: { from: string, to: string }             // exact tag → new tag
 *   rename:  same as replace
 *   clear:   {}
 */
function batchOpDataset({ imagePaths, op, args }) {
  if (!Array.isArray(imagePaths) || !imagePaths.length) return { ok: false, error: '没有选中图片' };
  args = args || {};
  let touched = 0; let failed = 0; const errors = [];
  const removeSet = new Set((args.tags || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const addList = (args.tags || []).map((s) => String(s).trim()).filter(Boolean);
  for (const p of imagePaths) {
    try {
      const tp = tagsPathFor(p);
      let cur = [];
      if (fs.existsSync(tp)) cur = parseTagsText(fs.readFileSync(tp, 'utf8'));
      let next;
      if (op === 'add') {
        next = args.position === 'start' ? [...addList, ...cur] : [...cur, ...addList];
      } else if (op === 'remove') {
        next = cur.filter((t) => !removeSet.has(t.toLowerCase()));
      } else if (op === 'replace' || op === 'rename') {
        const fromLower = String(args.from || '').trim().toLowerCase();
        const to = String(args.to || '').trim();
        if (!fromLower || !to) { failed++; errors.push({ path: p, error: 'replace 缺少 from/to' }); continue; }
        next = cur.map((t) => t.toLowerCase() === fromLower ? to : t);
      } else if (op === 'clear') {
        next = [];
      } else {
        failed++; errors.push({ path: p, error: '未知操作: ' + op }); continue;
      }
      next = dedupePreserveOrder(next);
      fs.writeFileSync(tp, formatTagsForFile(next), 'utf8');
      touched++;
    } catch (e) {
      failed++; errors.push({ path: p, error: String(e.message || e) });
    }
  }
  return { ok: true, touched, failed, errors };
}

ipcMain.handle('dataset:pickDir', () => pickDatasetDir());
ipcMain.handle('dataset:list', (_e, opts) => listDataset(opts || {}));
ipcMain.handle('dataset:readTags', (_e, imagePath) => readTagsFile(imagePath));
ipcMain.handle('dataset:writeTags', (_e, opts) => writeTagsFile(opts || {}));
ipcMain.handle('dataset:batchOp', (_e, opts) => batchOpDataset(opts || {}));
ipcMain.handle('dataset:thumb', async (_e, opts) => {
  // Used by the dataset list to show small thumbnails without slurping huge buffers.
  // Returns a data URL (image/jpeg) at width 96, or null on failure.
  try {
    if (!opts || !opts.path || !fs.existsSync(opts.path)) return null;
    const sharp = require('sharp');
    const buf = await sharp(opts.path)
      .removeAlpha()
      .resize(opts.size || 96, opts.size || 96, { fit: 'cover' })
      .jpeg({ quality: 70 })
      .toBuffer();
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) {
    console.error('[dataset:thumb] error:', e.message || e);
    return null;
  }
});

ipcMain.handle('tagger:imageDataUrl', async (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    let ext = path.extname(filePath).slice(1).toLowerCase();
    if (ext === 'jpg') ext = 'jpeg';
    const mime = (['png', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'].includes(ext)) ? 'image/' + ext : 'application/octet-stream';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) {
    console.error('[tagger:imageDataUrl] error:', e);
    return null;
  }
});
ipcMain.handle('store:get', (_e, key, fallback) => readJson(`${key}.json`, fallback));
ipcMain.handle('store:set', (_e, key, value) => { writeJson(`${key}.json`, value); return true; });
ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(text); return true; });

// ---------- window ----------
function createWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    backgroundColor: '#16181c',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Only auto-open devtools when ANIMA_DEV is set
  if (process.env.ANIMA_DEV) {
    win.webContents.once('did-finish-load', () => {
      try { win.webContents.openDevTools({ mode: 'detach' }); } catch {}
    });
  }
  // F12 always toggles devtools (manual debugging)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
