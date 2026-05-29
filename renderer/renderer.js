'use strict';

// Wrap the whole module in an IIFE so top-level const/let don't leak into the
// global lexical scope. Without this, a page reload (Ctrl+R) or any second
// evaluation of this script throws "Identifier 'api' has already been declared".
(function () {

// Surface any uncaught error directly on screen — otherwise a silent throw
// during module load means NO event handlers bind and the UI looks dead.
function showFatal(msg, where) {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:40vh;overflow:auto;background:#3a0e0e;color:#ffdcdc;padding:10px;font-family:Consolas,monospace;font-size:12px;border-top:2px solid #ef4444;z-index:9999;white-space:pre-wrap;';
  box.textContent = '[' + where + '] ' + msg;
  document.body.appendChild(box);
  console.error('[FATAL', where + ']', msg);
}
window.addEventListener('error', (ev) => {
  showFatal((ev.error && ev.error.stack) || ev.message || String(ev), 'window.error');
});
window.addEventListener('unhandledrejection', (ev) => {
  showFatal((ev.reason && (ev.reason.stack || ev.reason.message)) || String(ev.reason), 'unhandledrejection');
});

const api = window.api;
if (!api) showFatal('window.api is undefined — preload.js did not run. Check main.js webPreferences.preload path.', 'init');

// ---------- state ----------
const state = {
  objectInfo: null,
  baseLoras: [],            // [{ name, strength }]  name = ComfyUI relative lora path
  currentJobId: null,
  grid: null,
  defaults: null,
  job: null,                // { startTime, total, completed, cellStart, cellTimes: [] }
  etaTimer: null,
  view: 'xy',               // 'xy' | 'tag'
  tmMode: 'single',         // 'single' | 'dataset'   (sub-mode within tag view)
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const el = (tag, attrs, children) => {
  const n = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'style') n.setAttribute('style', attrs[k]);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else n.setAttribute(k, attrs[k]);
  }
  if (children) {
    if (!Array.isArray(children)) children = [children];
    for (const c of children) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return n;
};
const fillSelect = (sel, items, current, opts) => {
  sel.innerHTML = '';
  const placeholder = opts && opts.placeholder;
  if (placeholder) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder;
    sel.appendChild(o);
  }
  for (const v of items) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
  if (current && items.includes(current)) {
    sel.value = current;
  } else if (opts && opts.preferred) {
    for (const p of opts.preferred) {
      if (items.includes(p)) { sel.value = p; break; }
    }
  }
};
const parseValues = (raw) =>
  String(raw || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const basename = (p) => p ? String(p).replace(/\\/g, '/').split('/').pop() : '';

// Map any user-provided LoRA name (possibly with wrong path separator or case)
// to the exact string ComfyUI has in its combo list. Returns null if no match.
// Separator-insensitive AND case-insensitive.
function canonicalizeLoraName(name) {
  if (!name) return null;
  const list = (state.objectInfo && state.objectInfo.loras) || [];
  if (!list.length) return null;
  const target = String(name).replace(/[\\/]+/g, '/').toLowerCase();
  for (const item of list) {
    const itemKey = String(item).replace(/[\\/]+/g, '/').toLowerCase();
    if (itemKey === target) return item;   // exact match (regardless of sep/case)
  }
  // basename-only fallback (unique)
  const base = target.split('/').pop();
  const matches = list.filter((it) =>
    String(it).replace(/[\\/]+/g, '/').toLowerCase().split('/').pop() === base);
  if (matches.length === 1) return matches[0];
  return null;
}

// Try to map a full filesystem path picked by the user to the lora_name string
// ComfyUI expects. ComfyUI's LoraLoader combo lists relative paths under
// `ComfyUI/models/loras/`, so we suffix-match the picked absolute path.
function resolveLoraName(fullPath) {
  if (!fullPath) return null;
  const list = state.objectInfo ? state.objectInfo.loras : [];
  const normOrig = fullPath.replace(/\\/g, '/');
  const norm = normOrig.toLowerCase();
  // 1. exact suffix match against ComfyUI's known list
  for (const item of list) {
    const itemNorm = item.replace(/\\/g, '/').toLowerCase();
    if (norm === itemNorm) return item;
    if (norm.endsWith('/' + itemNorm)) return item;
  }
  // 2. basename fallback (unique match wins)
  const base = norm.split('/').pop();
  const matches = list.filter((it) => {
    const b = it.replace(/\\/g, '/').toLowerCase().split('/').pop();
    return b === base;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ambiguous: true, matches };
  // 3. Path contains `/loras/` somewhere — take everything after as best-effort
  const idx = norm.lastIndexOf('/loras/');
  if (idx >= 0) {
    return { uncached: true, name: normOrig.substring(idx + '/loras/'.length) };
  }
  return null;
}

// ---------- LoRA list picker (modal) ----------
// State for the active modal call. We use a single global promise resolver
// so the modal can return a single value (or array if multi).
const loraModal = {
  promise: null,
  resolve: null,
  multi: false,
  selection: new Set(),
};

function pickLoraFromList(preselect, opts) {
  opts = opts || {};
  loraModal.multi = !!opts.multi;
  loraModal.selection = new Set();
  if (preselect && !opts.multi) loraModal.selection.add(preselect);
  const list = (state.objectInfo && state.objectInfo.loras) || [];
  $('loraModalSub').textContent = `ComfyUI 已识别 ${list.length} 个 LoRA · ${loraModal.multi ? '可多选' : '单选'}`;
  $('loraFilter').value = '';
  renderLoraModal('');
  $('loraOk').disabled = loraModal.selection.size === 0;
  $('loraModal').classList.remove('hidden');
  setTimeout(() => { try { $('loraFilter').focus(); } catch {} }, 50);

  loraModal.promise = new Promise((resolve) => { loraModal.resolve = resolve; });
  return loraModal.promise;
}

function renderLoraModal(filterText) {
  const wrap = $('loraListWrap');
  wrap.innerHTML = '';
  const list = (state.objectInfo && state.objectInfo.loras) || [];
  const q = (filterText || '').toLowerCase().trim();
  let shown = 0;
  for (const name of list) {
    if (q && !name.toLowerCase().includes(q)) continue;
    shown++;
    if (shown > 1000) continue;  // hard cap; user should filter
    const isSelected = loraModal.selection.has(name);
    const cb = el('input', {
      type: loraModal.multi ? 'checkbox' : 'radio',
      name: 'llm-pick',
      onClick: (e) => {
        e.stopPropagation();
        if (loraModal.multi) {
          if (e.target.checked) loraModal.selection.add(name);
          else loraModal.selection.delete(name);
        } else {
          loraModal.selection.clear();
          loraModal.selection.add(name);
        }
        $('loraOk').disabled = loraModal.selection.size === 0;
        renderLoraModal($('loraFilter').value);
      },
    });
    cb.checked = isSelected;
    const slash = name.lastIndexOf('/');
    const dir = slash >= 0 ? name.substring(0, slash) : '';
    const base = slash >= 0 ? name.substring(slash + 1) : name;
    const row = el('div', {
      class: 'llm-row' + (isSelected ? ' selected' : ''),
      'data-name': name,
      title: name,
      onClick: () => {
        // toggle/select on row click
        if (loraModal.multi) {
          if (loraModal.selection.has(name)) loraModal.selection.delete(name);
          else loraModal.selection.add(name);
        } else {
          loraModal.selection.clear();
          loraModal.selection.add(name);
        }
        $('loraOk').disabled = loraModal.selection.size === 0;
        renderLoraModal($('loraFilter').value);
      },
    }, [
      cb,
      el('span', { class: 'llm-row-name' }, base),
      dir ? el('span', { class: 'llm-row-dir' }, dir + '/') : null,
    ]);
    wrap.appendChild(row);
  }
  if (shown === 0) {
    wrap.appendChild(el('div', { class: 'llm-empty' },
      list.length === 0
        ? '列表为空。请先点上方「连接」按钮连接 ComfyUI。'
        : '没有匹配项，调整过滤词。'));
  } else if (shown > 1000) {
    wrap.appendChild(el('div', { class: 'llm-empty' },
      `共匹配 ${shown}+，只显示前 1000，请用更具体的过滤词。`));
  }
}

function loraModalClose(result) {
  $('loraModal').classList.add('hidden');
  if (loraModal.resolve) {
    if (result === null) loraModal.resolve(loraModal.multi ? [] : null);
    else loraModal.resolve(result);
    loraModal.resolve = null;
  }
}

async function refreshObjectInfo() {
  if (!$('server').value.trim()) return;
  try {
    const info = await withTimeout(api.comfyObjectInfo($('server').value.trim()), 35000, 'object_info');
    state.objectInfo = info;
    console.log('[refreshObjectInfo] LoRA count:', info.loras.length);
  } catch (e) {
    console.error('[refreshObjectInfo] failed:', e);
  }
}

// Resolve a LoRA path. On miss, refresh once and retry. On still-miss, offer
// a detailed diagnostic and (if path is under /loras/) let the user accept anyway.
async function resolveLoraWithRetry(fullPath) {
  let r = resolveLoraName(fullPath);
  if (r && !r.ambiguous && !r.uncached) return r;
  if (!r) {
    // Maybe a LoRA file was added after ComfyUI started: refresh and retry
    console.log('[resolveLora] miss, refreshing object_info for', fullPath);
    await refreshObjectInfo();
    r = resolveLoraName(fullPath);
    if (r && !r.ambiguous && !r.uncached) return r;
  }
  if (r && r.ambiguous) {
    const pick = prompt('同名 LoRA 有多个，请粘贴要使用的相对路径：\n\n' + r.matches.join('\n'));
    if (pick && r.matches.includes(pick)) return pick;
    return null;
  }
  if (r && r.uncached) {
    const ok = confirm(
      `ComfyUI 的列表里没看到这个文件，但路径里包含 /loras/。\n\n` +
      `选择的文件：\n${fullPath}\n\n` +
      `准备作为以下名字提交：\n${r.name}\n\n` +
      `(如果 ComfyUI 用了 extra_model_paths.yaml 把 loras 路径指到这里，应该能跑。)\n\n点确定继续。`);
    return ok ? r.name : null;
  }
  // truly miss — show a diagnostic dialog
  const list = state.objectInfo ? state.objectInfo.loras : [];
  const sample = list.slice(0, 10).join('\n') || '(空)';
  alert(
    `无法识别这个 LoRA：\n${fullPath}\n\n` +
    `ComfyUI 当前 LoRA 列表共 ${list.length} 个，前 10 个：\n${sample}\n\n` +
    `可能原因：\n` +
    `1. 文件不在 ComfyUI/models/loras/（或 extra_model_paths.yaml 指定的路径）下\n` +
    `2. 文件名含 ComfyUI 不识别的扩展名（仅认 .safetensors/.pt/.ckpt/.bin）\n` +
    `3. 把文件挪进 loras 文件夹后没重启 ComfyUI`
  );
  return null;
}

// ---------- settings persistence ----------
async function loadSettings() {
  const s = (await api.storeGet('settings', {})) || {};
  $('server').value = s.server || 'http://127.0.0.1:8188';
  $('positive').value = s.positive || '';
  $('negative').value = s.negative || '';
  $('width').value = s.width || 1024;
  $('height').value = s.height || 1024;
  $('steps').value = s.steps || 35;
  $('cfg').value = s.cfg != null ? s.cfg : 4.5;
  $('seed').value = s.seed != null ? s.seed : -1;
  state.baseLoras = Array.isArray(s.baseLoras) ? s.baseLoras : [];
  state.defaults = s;
  state.savedXType = s.xType;
  state.savedYType = s.yType;
  $('xValues').value = s.xValues || '';
  $('yValues').value = s.yValues || '';
}
function saveSettings() {
  const s = {
    server: $('server').value,
    positive: $('positive').value,
    negative: $('negative').value,
    width: $('width').value,
    height: $('height').value,
    steps: $('steps').value,
    cfg: $('cfg').value,
    seed: $('seed').value,
    unet: $('unet').value,
    weightDtype: $('weightDtype').value,
    textEncoder: $('textEncoder').value,
    clipType: $('clipType').value,
    vae: $('vae').value,
    sampler: $('sampler').value,
    scheduler: $('scheduler').value,
    baseLoras: state.baseLoras,
    xType: $('xType').value,
    yType: $('yType').value,
    xValues: $('xValues').value,
    yValues: $('yValues').value,
    xExtra: collectAxisExtra('x'),
    yExtra: collectAxisExtra('y'),
  };
  api.storeSet('settings', s);
}

// ---------- connection ----------
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 (' + ms + 'ms)')), ms)),
  ]);
}

async function doConnect() {
  $('connStatus').textContent = '连接中…';
  $('connStatus').className = 'conn-status';
  const url = $('server').value.trim();
  console.log('[doConnect] URL =', url);

  let ping;
  try {
    ping = await withTimeout(api.comfyPing(url), 8000, 'IPC ping');
  } catch (e) {
    console.error('[doConnect] ping IPC error:', e);
    $('connStatus').textContent = '连接失败: ' + e.message;
    $('connStatus').className = 'conn-status err';
    $('connStatus').title = String(e.stack || e);
    return;
  }
  console.log('[doConnect] ping result =', ping);
  if (!ping.ok) {
    $('connStatus').textContent = '连接失败: ' + ping.error;
    $('connStatus').className = 'conn-status err';
    $('connStatus').title = '完整错误: ' + ping.error + '\nURL: ' + url;
    return;
  }
  try {
    console.log('[doConnect] fetching object_info…');
    const info = await withTimeout(api.comfyObjectInfo(url), 35000, 'object_info');
    console.log('[doConnect] object_info parsed:', {
      unets: info.unets.length, textEncoders: info.textEncoders.length,
      vaes: info.vaes.length, loras: info.loras.length,
      samplers: info.samplers.length, clipTypes: info.clipTypes.length,
    });
    state.objectInfo = info;
    const d = state.defaults || {};
    // Match Anima recommended files by name when first connecting
    fillSelect($('unet'), info.unets, d.unet, {
      placeholder: '— 选择扩散模型 —',
      preferred: ['anima-base-v1.0.safetensors'],
    });
    fillSelect($('textEncoder'), info.textEncoders, d.textEncoder, {
      placeholder: '— 选择文本编码器 —',
      preferred: ['qwen_3_06b_base.safetensors'],
    });
    fillSelect($('vae'), info.vaes, d.vae, {
      placeholder: '— 选择 VAE —',
      preferred: ['qwen_image_vae.safetensors'],
    });
    fillSelect($('clipType'), info.clipTypes, d.clipType, { preferred: ['cosmos'] });
    fillSelect($('weightDtype'), info.weightDtypes, d.weightDtype, { preferred: ['default'] });
    fillSelect($('sampler'), info.samplers, d.sampler, { preferred: ['er_sde', 'euler_a', 'euler'] });
    fillSelect($('scheduler'), info.schedulers, d.scheduler, { preferred: ['normal', 'simple'] });

    renderBaseLoras();
    renderAxisExtra('x');
    renderAxisExtra('y');
    $('generateBtn').disabled = false;

    const parts = [
      `${info.unets.length} UNET`,
      `${info.textEncoders.length} CLIP`,
      `${info.vaes.length} VAE`,
      `${info.loras.length} LoRA`,
    ];
    $('connStatus').textContent = '已连接 · ' + parts.join(' / ');
    $('connStatus').className = 'conn-status ok';
    $('connStatus').title = JSON.stringify(parts);
  } catch (e) {
    console.error('[doConnect] object_info error:', e);
    $('connStatus').textContent = '加载失败: ' + (e.message || e);
    $('connStatus').className = 'conn-status err';
    $('connStatus').title = String(e.stack || e);
  }
}

// ---------- base LoRA list ----------
function renderBaseLoras() {
  const wrap = $('baseLoras');
  wrap.innerHTML = '';
  state.baseLoras.forEach((lo, i) => {
    const pathLabel = el('div', {
      class: 'lora-path',
      title: lo.name || '',
    }, basename(lo.name) || '(未选择)');
    const listBtn = el('button', {
      class: 'small ghost',
      title: '从 ComfyUI 列表里选',
      onClick: async () => {
        const name = await pickLoraFromList(lo.name);
        if (name) { state.baseLoras[i].name = name; renderBaseLoras(); saveSettings(); }
      },
    }, '🔎');
    const browseBtn = el('button', {
      class: 'small ghost',
      title: '从文件系统浏览（需要路径在 ComfyUI/models/loras 下）',
      onClick: () => pickAndSetBaseLora(i),
    }, '📁');
    const strengthInput = el('input', {
      type: 'number',
      step: '0.05',
      value: lo.strength != null ? lo.strength : 0.8,
      onChange: (e) => { state.baseLoras[i].strength = parseFloat(e.target.value); saveSettings(); },
    });
    const delBtn = el('button', {
      class: 'small ghost',
      title: '删除',
      onClick: () => { state.baseLoras.splice(i, 1); renderBaseLoras(); saveSettings(); },
    }, '×');
    const row = el('div', { class: 'lora-row' }, [pathLabel, listBtn, browseBtn, strengthInput, delBtn]);
    wrap.appendChild(row);
  });
}

async function pickAndSetBaseLora(index) {
  const paths = await api.pickLoraFiles({ multi: false });
  if (!paths || !paths.length) return;
  const name = await resolveLoraWithRetry(paths[0]);
  if (!name) return;
  state.baseLoras[index].name = name;
  renderBaseLoras();
  saveSettings();
}

$('addBaseLora').addEventListener('click', async () => {
  // List-mode add: open the modal multi-select.
  const names = await pickLoraFromList(null, { multi: true });
  if (Array.isArray(names) && names.length) {
    for (const n of names) state.baseLoras.push({ name: n, strength: 0.8 });
    renderBaseLoras();
    saveSettings();
  }
});
$('addBaseLoraFile').addEventListener('click', async () => {
  // File-dialog add (original behaviour).
  const paths = await api.pickLoraFiles({ multi: true });
  if (paths && paths.length) {
    let added = 0;
    for (const p of paths) {
      const name = await resolveLoraWithRetry(p);
      if (name) { state.baseLoras.push({ name, strength: 0.8 }); added++; }
    }
    if (added) { renderBaseLoras(); saveSettings(); }
  }
});

// ---------- axis extras ----------
function renderAxisExtra(which) {
  const wrap = $(which + 'Extra');
  const type = $(which + 'Type').value;
  wrap.innerHTML = '';
  const saved = (state.defaults && state.defaults[which + 'Extra']) || {};

  if (type === 'lora_weight') {
    const pathInp = el('input', {
      type: 'text', readonly: 'readonly',
      id: which + 'AxisLora',
      value: saved.loraName || '',
      placeholder: '点右侧 🔎 / 📁 选择 LoRA',
      title: saved.loraName || '',
    });
    pathInp.dataset.full = saved.loraName || '';
    const listBtn = el('button', {
      class: 'small ghost',
      title: '从 ComfyUI 列表里选',
      onClick: async () => {
        const name = await pickLoraFromList(pathInp.dataset.full || '');
        if (!name) return;
        pathInp.value = name;
        pathInp.dataset.full = name;
        pathInp.title = name;
        saveSettings();
      },
    }, '🔎 列表');
    const browseBtn = el('button', {
      class: 'small ghost',
      title: '从文件系统浏览',
      onClick: async () => {
        const paths = await api.pickLoraFiles({ multi: false });
        if (!paths || !paths.length) return;
        const name = await resolveLoraWithRetry(paths[0]);
        if (!name) return;
        pathInp.value = name;
        pathInp.dataset.full = name;
        pathInp.title = name;
        saveSettings();
      },
    }, '📁 文件');
    wrap.appendChild(el('div', { class: 'row' }, [
      el('div', null, [el('label', null, '目标 LoRA (将被扫描权重)'), pathInp]),
      el('div', { style: 'display:flex;gap:4px;' }, [listBtn, browseBtn]),
    ]));
    if (!$(which + 'Values').value.trim()) {
      $(which + 'Values').value = '0.2, 0.4, 0.6, 0.8, 1.0';
    }
  } else if (type === 'lora_file') {
    const inp = el('input', {
      type: 'number', step: '0.05', id: which + 'AxisStrength',
      value: saved.strength != null ? saved.strength : 0.8,
      onChange: saveSettings,
    });
    const listBtn = el('button', {
      class: 'small ghost',
      title: '从 ComfyUI 列表里多选添加',
      onClick: async () => {
        const names = await pickLoraFromList(null, { multi: true });
        if (!Array.isArray(names) || !names.length) return;
        const ta = $(which + 'Values');
        const existing = parseValues(ta.value);
        const merged = Array.from(new Set([...existing, ...names]));
        ta.value = merged.join('\n');
        saveSettings();
      },
    }, '🔎 列表');
    const browseBtn = el('button', {
      class: 'small ghost',
      title: '从文件系统多选',
      onClick: () => browseAndAppendLoraFiles(which),
    }, '📁 文件');
    wrap.appendChild(el('div', { class: 'row' }, [
      el('div', null, [el('label', null, '扫描时使用的固定强度'), inp]),
      el('div', { style: 'display:flex;gap:4px;' }, [listBtn, browseBtn]),
    ]));
    $(which + 'Values').placeholder = '每行一个 LoRA，点 🔎 或 📁 添加';
  } else if (type === 'seed') {
    if (!$(which + 'Values').value.trim()) $(which + 'Values').value = '0, 1, 2, 3';
  } else if (type === 'cfg') {
    if (!$(which + 'Values').value.trim()) $(which + 'Values').value = '3, 4, 5, 6';
  } else if (type === 'steps') {
    if (!$(which + 'Values').value.trim()) $(which + 'Values').value = '20, 30, 40, 50';
  } else if (type === 'sampler') {
    if (state.objectInfo && state.objectInfo.samplers) {
      wrap.appendChild(buildCheckboxPicker(which, state.objectInfo.samplers, 'sampler'));
    }
    $(which + 'Values').placeholder = '勾选上方，或一行一个手填';
  } else if (type === 'scheduler') {
    if (state.objectInfo && state.objectInfo.schedulers) {
      wrap.appendChild(buildCheckboxPicker(which, state.objectInfo.schedulers, 'scheduler'));
    }
    $(which + 'Values').placeholder = '勾选上方，或一行一个手填';
  } else if (type === 'sampler_scheduler') {
    if (state.objectInfo && state.objectInfo.samplers && state.objectInfo.schedulers) {
      wrap.appendChild(buildSamplerSchedulerPicker(which));
    }
    $(which + 'Values').placeholder = '勾选上方组合，或一行一个 "sampler + scheduler" 手填';
  }
  saveSettings();
}
async function browseAndAppendLoraFiles(which) {
  const paths = await api.pickLoraFiles({ multi: true });
  if (!paths || !paths.length) return;
  const resolved = [];
  for (const p of paths) {
    const name = await resolveLoraWithRetry(p);
    if (name) resolved.push(name);
  }
  if (!resolved.length) return;
  const ta = $(which + 'Values');
  const existing = parseValues(ta.value);
  const merged = Array.from(new Set([...existing, ...resolved]));
  ta.value = merged.join('\n');
  saveSettings();
}
function collectAxisExtra(which) {
  const type = $(which + 'Type').value;
  if (type === 'lora_weight') {
    const sel = $(which + 'AxisLora');
    return { loraName: sel ? (sel.value || sel.dataset.full || '') : '' };
  }
  if (type === 'lora_file') {
    const inp = $(which + 'AxisStrength');
    return { strength: inp ? parseFloat(inp.value) : 0.8 };
  }
  return {};
}

// Build a "select all that apply" picker for sampler / scheduler axes. Selecting
// a checkbox appends the value to the textarea (and unchecking removes it).
function buildCheckboxPicker(which, options, label) {
  const ta = $(which + 'Values');
  const wrap = document.createElement('div');
  wrap.className = 'ss-picker';
  const head = el('div', { class: 'ss-head' }, [
    el('span', null, `选择 ${label}（${options.length}）`),
    el('button', { class: 'small ghost', onClick: (e) => { e.preventDefault(); ta.value = options.join('\n'); saveSettings(); refreshCheckboxState(); } }, '全选'),
    el('button', { class: 'small ghost', onClick: (e) => { e.preventDefault(); ta.value = ''; saveSettings(); refreshCheckboxState(); } }, '清空'),
  ]);
  wrap.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'ss-grid';
  for (const name of options) {
    const cb = el('input', { type: 'checkbox', value: name, onChange: (e) => {
      const cur = parseValues(ta.value);
      const set = new Set(cur);
      if (e.target.checked) set.add(name);
      else set.delete(name);
      // Preserve order: keep originally-listed order from options
      ta.value = options.filter((o) => set.has(o)).concat(cur.filter((c) => !options.includes(c))).join('\n');
      saveSettings();
    }});
    cb.checked = parseValues(ta.value).includes(name);
    const lbl = el('label', { class: 'ss-item' }, [cb, el('span', null, name)]);
    grid.appendChild(lbl);
  }
  wrap.appendChild(grid);

  function refreshCheckboxState() {
    const cur = new Set(parseValues(ta.value));
    wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = cur.has(cb.value); });
  }
  // Refresh whenever textarea changes manually
  ta.addEventListener('input', refreshCheckboxState);
  return wrap;
}

// Combo picker: pick a sampler AND a scheduler then click "+ 添加" to append the
// pair to the values list as "sampler + scheduler".
function buildSamplerSchedulerPicker(which) {
  const ta = $(which + 'Values');
  const samplers = state.objectInfo.samplers || [];
  const schedulers = state.objectInfo.schedulers || [];

  const wrap = document.createElement('div');
  wrap.className = 'ss-picker';

  const head = el('div', { class: 'ss-head' }, [
    el('span', null, '选 sampler × scheduler 组合'),
    el('button', { class: 'small ghost', onClick: (e) => { e.preventDefault(); ta.value = ''; saveSettings(); refreshTags(); } }, '清空'),
  ]);
  wrap.appendChild(head);

  const samplerSel = document.createElement('select');
  for (const s of samplers) samplerSel.appendChild(el('option', { value: s }, s));
  const schedSel = document.createElement('select');
  for (const s of schedulers) schedSel.appendChild(el('option', { value: s }, s));
  const addBtn = el('button', { class: 'small primary', onClick: (e) => {
    e.preventDefault();
    const s = samplerSel.value, sc = schedSel.value;
    if (!s || !sc) return;
    const tag = `${s} + ${sc}`;
    const cur = parseValues(ta.value);
    if (cur.includes(tag)) return;
    cur.push(tag);
    ta.value = cur.join('\n');
    saveSettings();
    refreshTags();
  } }, '+ 添加组合');

  const row = el('div', { class: 'ss-combo-row' }, [
    el('label', { class: 'ss-combo-lbl' }, [el('span', null, 'Sampler'), samplerSel]),
    el('label', { class: 'ss-combo-lbl' }, [el('span', null, 'Scheduler'), schedSel]),
    addBtn,
  ]);
  wrap.appendChild(row);

  const tagsHead = el('div', { class: 'ss-tags-head muted' }, '已选组合（点 × 移除）');
  const tags = document.createElement('div');
  tags.className = 'ss-tags';
  wrap.appendChild(tagsHead);
  wrap.appendChild(tags);

  function refreshTags() {
    tags.innerHTML = '';
    const cur = parseValues(ta.value);
    if (!cur.length) {
      tags.appendChild(el('span', { class: 'muted', style: 'font-size:11px;' }, '（暂无）'));
      return;
    }
    for (const item of cur) {
      const t = el('span', { class: 'ss-tag' }, [
        item,
        el('button', { class: 'ss-tag-x', onClick: (e) => {
          e.preventDefault();
          const next = parseValues(ta.value).filter((x) => x !== item);
          ta.value = next.join('\n');
          saveSettings();
          refreshTags();
        }}, '×'),
      ]);
      tags.appendChild(t);
    }
  }
  refreshTags();
  ta.addEventListener('input', refreshTags);
  return wrap;
}
$('xType').addEventListener('change', () => renderAxisExtra('x'));
$('yType').addEventListener('change', () => renderAxisExtra('y'));

// ---------- build axis spec for runGrid ----------
function buildAxisSpec(which) {
  const type = $(which + 'Type').value;
  if (type === 'none') return { type: 'none', values: [] };
  const values = parseValues($(which + 'Values').value);
  const extra = collectAxisExtra(which);
  const spec = { type, values };
  if (type === 'lora_weight') {
    spec.loraName = extra.loraName || '';
    spec.values = values.map((v) => parseFloat(v));
  } else if (type === 'lora_file') {
    spec.strength = parseFloat(extra.strength != null ? extra.strength : 0.8);
  } else if (type === 'seed' || type === 'steps') {
    spec.values = values.map((v) => parseInt(v, 10));
  } else if (type === 'cfg') {
    spec.values = values.map((v) => parseFloat(v));
  } else if (type === 'sampler_scheduler') {
    // Parse "sampler + scheduler" strings into structured objects.
    spec.values = values.map((v) => {
      const s = String(v);
      const parts = s.split(/\s*\+\s*/);
      return { sampler: parts[0] || '', scheduler: parts[1] || '' };
    }).filter((o) => o.sampler && o.scheduler);
  }
  return spec;
}

function axisDisplayName(axis) {
  if (!axis || axis.type === 'none') return '';
  switch (axis.type) {
    case 'lora_weight': return 'Weight: ' + basename(axis.loraName || '');
    case 'lora_file': return 'LoRA @' + axis.strength;
    case 'seed': return 'Seed';
    case 'cfg': return 'CFG';
    case 'steps': return 'Steps';
    case 'sampler': return 'Sampler';
    case 'scheduler': return 'Scheduler';
    case 'sampler_scheduler': return 'Sampler+Scheduler';
    default: return axis.type;
  }
}

// Show short label in grid cells: for lora_file we show just the basename.
function shortLabel(axis, value) {
  if (axis && axis.type === 'lora_file') return basename(value);
  return String(value);
}

// ---------- generate ----------
async function startGenerate() {
  saveSettings();
  const url = $('server').value.trim();

  if (!$('unet').value) { alert('请先选择扩散模型 (UNET)'); return; }
  if (!$('textEncoder').value) { alert('请先选择文本编码器'); return; }
  if (!$('vae').value) { alert('请先选择 VAE'); return; }

  const seedRaw = String($('seed').value).trim();
  let baseSeed = parseInt(seedRaw, 10);
  if (!Number.isFinite(baseSeed) || baseSeed < 0) {
    baseSeed = Math.floor(Math.random() * 2 ** 31);
  }

  const xAxis = buildAxisSpec('x');
  const yAxis = buildAxisSpec('y');

  for (const [which, ax] of [['X', xAxis], ['Y', yAxis]]) {
    if (ax.type === 'none') continue;
    if (!ax.values.length) { alert(which + ' 轴值列表为空'); return; }
    if (ax.type === 'lora_weight' && !ax.loraName) { alert(which + ' 轴: 请选择目标 LoRA'); return; }
    if ((ax.type === 'cfg' || ax.type === 'lora_weight') &&
        ax.values.some((v) => !Number.isFinite(v))) {
      alert(which + ' 轴: 有值无法解析为数字'); return;
    }
  }

  // Canonicalize every LoRA name (base + axis) against ComfyUI's combo list so
  // path-separator / case differences don't trip the validator.
  const baseLorasCanonical = [];
  const unresolvedNames = [];
  for (const lo of state.baseLoras.filter((l) => l && l.name)) {
    const canon = canonicalizeLoraName(lo.name);
    if (canon) baseLorasCanonical.push({ name: canon, strength: lo.strength });
    else { baseLorasCanonical.push(lo); unresolvedNames.push(lo.name); }
  }
  if (xAxis.type === 'lora_weight' && xAxis.loraName) {
    const c = canonicalizeLoraName(xAxis.loraName);
    if (c) xAxis.loraName = c; else unresolvedNames.push(xAxis.loraName);
  }
  if (yAxis.type === 'lora_weight' && yAxis.loraName) {
    const c = canonicalizeLoraName(yAxis.loraName);
    if (c) yAxis.loraName = c; else unresolvedNames.push(yAxis.loraName);
  }
  if (xAxis.type === 'lora_file') {
    xAxis.values = xAxis.values.map((v) => canonicalizeLoraName(String(v)) || (unresolvedNames.push(v), v));
  }
  if (yAxis.type === 'lora_file') {
    yAxis.values = yAxis.values.map((v) => canonicalizeLoraName(String(v)) || (unresolvedNames.push(v), v));
  }
  if (unresolvedNames.length) {
    const uniq = Array.from(new Set(unresolvedNames));
    const ok = confirm('以下 LoRA 名字未在 ComfyUI 列表里找到精确匹配，可能会失败：\n\n' +
      uniq.slice(0, 8).join('\n') + (uniq.length > 8 ? `\n…还有 ${uniq.length - 8} 项` : '') +
      '\n\n仍然继续？');
    if (!ok) {
      $('generateBtn').disabled = false;
      $('cancelBtn').classList.add('hidden');
      $('progressWrap').classList.add('hidden');
      return;
    }
  }

  const base = {
    unet: $('unet').value,
    weightDtype: $('weightDtype').value || 'default',
    textEncoder: $('textEncoder').value,
    clipType: $('clipType').value || 'cosmos',
    vae: $('vae').value,
    positive: $('positive').value,
    negative: $('negative').value,
    width: parseInt($('width').value, 10),
    height: parseInt($('height').value, 10),
    seed: baseSeed,
    cfg: parseFloat($('cfg').value),
    steps: parseInt($('steps').value, 10),
    sampler: $('sampler').value,
    scheduler: $('scheduler').value,
    denoise: 1.0,
    baseLoras: baseLorasCanonical,
    varyingLoras: [],
  };

  $('generateBtn').disabled = true;
  $('cancelBtn').classList.remove('hidden');
  $('saveGridBtn').disabled = true;
  $('progressWrap').classList.remove('hidden');
  setProgress(0, '准备…');

  await api.comfyRunGrid({ server: url, base, xAxis, yAxis });
}

function setProgress(pct, text) {
  $('progressBar').style.width = pct + '%';
  $('progressText').textContent = text || '';
}

// ---------- big progress bar ----------
function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function bpShow() { $('bigProgress').classList.remove('hidden'); }
function bpHide() { $('bigProgress').classList.add('hidden'); }
function bpUpdateOverall() {
  if (!state.job) return;
  const { total, completed } = state.job;
  const pct = total ? (completed / total) * 100 : 0;
  $('bpBarOverall').style.width = pct + '%';
  $('bpCellsText').textContent = `${completed} / ${total} (${pct.toFixed(0)}%)`;
}
function bpUpdateClock() {
  if (!state.job) return;
  const elapsed = (Date.now() - state.job.startTime) / 1000;
  $('bpElapsed').textContent = '用时 ' + fmtTime(elapsed);
  const { completed, total, cellTimes } = state.job;
  let etaSec = null;
  if (completed > 0 && completed < total) {
    const avg = cellTimes.length ? cellTimes.reduce((a, b) => a + b, 0) / cellTimes.length : elapsed / completed;
    etaSec = avg * (total - completed);
  } else if (completed >= total) {
    etaSec = 0;
  }
  $('bpEta').textContent = 'ETA ' + (etaSec != null ? fmtTime(etaSec) : '--:--');
}
function bpStartClock() {
  if (state.etaTimer) clearInterval(state.etaTimer);
  state.etaTimer = setInterval(bpUpdateClock, 500);
}
function bpStopClock() {
  if (state.etaTimer) { clearInterval(state.etaTimer); state.etaTimer = null; }
  bpUpdateClock();
}
function bpInit(total) {
  state.job = { startTime: Date.now(), total, completed: 0, cellStart: 0, cellTimes: [], currentCell: -1 };
  bpShow();
  bpUpdateOverall();
  $('bpBarCell').style.width = '0%';
  $('bpCellText').textContent = '准备…';
  bpStartClock();
}
function bpCellStart(cellIndex, completed, total) {
  if (!state.job) return;
  state.job.cellStart = Date.now();
  state.job.currentCell = cellIndex;
  state.job.completed = completed;
  state.job.total = total;
  $('bpBarCell').style.width = '0%';
  $('bpCellText').textContent = `单元 #${cellIndex + 1} 排队中…`;
  bpUpdateOverall();
}
function bpCellStep(step, total) {
  if (!state.job) return;
  const pct = total ? (step / total) * 100 : 0;
  $('bpBarCell').style.width = pct + '%';
  $('bpCellText').textContent = `单元 #${state.job.currentCell + 1} · 第 ${step}/${total} 步`;
}
function bpCellDone(completed, total, errored) {
  if (!state.job) return;
  const ms = Date.now() - state.job.cellStart;
  if (state.job.cellStart && ms > 0) state.job.cellTimes.push(ms / 1000);
  state.job.completed = completed;
  state.job.total = total;
  $('bpBarCell').style.width = '100%';
  $('bpCellText').textContent = errored
    ? `单元 #${state.job.currentCell + 1} 失败`
    : `单元 #${state.job.currentCell + 1} 完成`;
  bpUpdateOverall();
  bpUpdateClock();
}
function bpFinish(status, completed, total, errors) {
  if (!state.job) return;
  state.job.completed = completed;
  state.job.total = total;
  bpUpdateOverall();
  $('bpBarCell').style.width = '100%';
  $('bpCellText').textContent =
    (status === 'cancelled' ? '已取消' : '全部完成') +
    (errors ? ` · ${errors} 个错误` : '');
  bpStopClock();
}

// ---------- generation stream sidebar ----------
// ---------- completed grids history (below the active grid) ----------
// state.gridHistory: [{ id, ts, snapshot }] — newest first
state.gridHistory = state.gridHistory || [];

function archiveGridToHistory() {
  if (!state.grid) return;
  const g = state.grid;
  // Deep snapshot of just what we need to re-render
  const snapshot = {
    xLen: g.xLen, yLen: g.yLen,
    xLabels: g.xLabels.slice(), yLabels: g.yLabels.slice(),
    xAxis: JSON.parse(JSON.stringify(g.xAxis)),
    yAxis: JSON.parse(JSON.stringify(g.yAxis)),
    cells: g.cells.map((c) => c ? { dataUrl: c.dataUrl || null, error: c.error || null } : null),
  };
  const entry = {
    id: 'gh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    snapshot,
  };
  state.gridHistory.unshift(entry);
  // Cap at 12 to bound memory (each cell holds a base64 PNG)
  while (state.gridHistory.length > 12) state.gridHistory.pop();
  renderGridHistory();
}

function renderGridHistory() {
  const wrap = $('gridHistory');
  const list = $('ghList');
  $('ghCount').textContent = `(${state.gridHistory.length})`;
  list.innerHTML = '';
  if (!state.gridHistory.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  for (const entry of state.gridHistory) {
    list.appendChild(buildGridHistoryCard(entry));
  }
}

function buildGridHistoryCard(entry) {
  const s = entry.snapshot;
  // Build the mini thumbnail grid (size each cell so the whole thumb is ~ 180x180)
  const maxSide = 180;
  const cellSize = Math.max(12, Math.floor(maxSide / Math.max(s.xLen, s.yLen)));
  const thumb = document.createElement('div');
  thumb.className = 'gh-thumb';
  thumb.style.gridTemplateColumns = `repeat(${s.xLen}, ${cellSize}px)`;
  thumb.style.gridTemplateRows = `repeat(${s.yLen}, ${cellSize}px)`;
  thumb.title = '点击恢复为当前网格';
  let ok = 0, err = 0;
  for (let y = 0; y < s.yLen; y++) {
    for (let x = 0; x < s.xLen; x++) {
      const c = s.cells[y * s.xLen + x];
      const div = document.createElement('div');
      div.className = 'gh-thumb-cell' + (!c ? ' miss' : (c.error ? ' err' : ''));
      if (c && c.dataUrl) { div.style.backgroundImage = `url("${c.dataUrl}")`; ok++; }
      else if (c && c.error) err++;
      thumb.appendChild(div);
    }
  }
  thumb.addEventListener('click', () => restoreGridFromHistory(entry.id));

  const when = new Date(entry.ts);
  const whenStr = `${when.getFullYear()}-${String(when.getMonth()+1).padStart(2,'0')}-${String(when.getDate()).padStart(2,'0')} ${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')}`;
  const axesParts = [];
  if (s.xAxis && s.xAxis.type !== 'none') axesParts.push(`X = ${s.xAxis.type} × ${s.xLen}`);
  if (s.yAxis && s.yAxis.type !== 'none') axesParts.push(`Y = ${s.yAxis.type} × ${s.yLen}`);

  const info = el('div', { class: 'gh-info' }, [
    el('div', { class: 'gh-when' }, whenStr),
    el('div', { class: 'gh-axes' }, axesParts.join('  ·  ') || '(无轴)'),
    el('div', { class: 'gh-stat' }, `共 ${s.xLen * s.yLen} 格 · 成功 ${ok}${err ? ` · 错误 ${err}` : ''}`),
  ]);

  const restoreBtn = el('button', {
    class: 'small primary',
    onClick: () => restoreGridFromHistory(entry.id),
  }, '↑ 设为当前');
  const saveBtn = el('button', {
    class: 'small ghost',
    onClick: () => saveHistoryGridAsPng(entry.id),
  }, '💾 保存');
  const delBtn = el('button', {
    class: 'small ghost',
    onClick: () => {
      state.gridHistory = state.gridHistory.filter((e) => e.id !== entry.id);
      renderGridHistory();
    },
  }, '× 删除');
  const actions = el('div', { class: 'gh-actions' }, [restoreBtn, saveBtn, delBtn]);

  return el('div', { class: 'gh-card', 'data-id': entry.id }, [thumb, info, actions]);
}

function restoreGridFromHistory(id) {
  const entry = state.gridHistory.find((e) => e.id === id);
  if (!entry) return;
  const s = entry.snapshot;
  // Rebuild state.grid as if we had just generated it
  initGrid({
    cells: s.xLen * s.yLen,
    xLen: s.xLen, yLen: s.yLen,
    xLabels: s.xLabels, yLabels: s.yLabels,
  }, s.xAxis, s.yAxis);
  for (let i = 0; i < s.cells.length; i++) {
    const c = s.cells[i];
    if (!c) continue;
    if (c.dataUrl) setCellImage(i, c.dataUrl, {});
    else if (c.error) setCellError(i, c.error);
  }
  $('saveGridBtn').disabled = false;
  $('canvasMainScrollAnchor') && $('canvasMainScrollAnchor').scrollIntoView({ behavior: 'smooth' });
  // Scroll to top of canvas-main
  const cm = document.querySelector('.canvas-main');
  if (cm) cm.scrollTop = 0;
}

async function saveHistoryGridAsPng(id) {
  const entry = state.gridHistory.find((e) => e.id === id);
  if (!entry) return;
  // Temporarily swap state.grid to the history one and reuse saveGridAsPng
  const cur = state.grid;
  const s = entry.snapshot;
  state.grid = {
    xLen: s.xLen, yLen: s.yLen,
    xLabels: s.xLabels, yLabels: s.yLabels,
    xAxis: s.xAxis, yAxis: s.yAxis,
    cells: s.cells.map((c) => c ? { ...c } : null),
  };
  try { await saveGridAsPng(); } finally { state.grid = cur; }
}

// ---------- progress handler ----------
api.onComfyProgress((msg) => {
  if (msg.status === 'starting') {
    initGrid(msg);
    state.currentJobId = msg.jobId;
    bpInit(msg.cells);
    return;
  }
  if (msg.status === 'cell-start') {
    markCell(msg.cellIndex, 'busy');
    setProgress((msg.completed / msg.total) * 100, `生成中 ${msg.completed}/${msg.total}…`);
    bpCellStart(msg.cellIndex, msg.completed, msg.total);
    return;
  }
  if (msg.status === 'cell-step') {
    bpCellStep(msg.step, msg.total);
    return;
  }
  if (msg.status === 'cell-done') {
    setCellImage(msg.cellIndex, msg.dataUrl, msg);
    setProgress((msg.completed / msg.total) * 100, `已完成 ${msg.completed}/${msg.total}`);
    bpCellDone(msg.completed, msg.total, false);
    return;
  }
  if (msg.status === 'cell-error') {
    setCellError(msg.cellIndex, msg.error);
    if (msg.total) setProgress((msg.completed / msg.total) * 100, `已完成 ${msg.completed}/${msg.total} (有错误)`);
    bpCellDone(msg.completed || 0, msg.total || (state.job && state.job.total) || 0, true);
    return;
  }
  if (msg.status === 'done' || msg.status === 'cancelled') {
    state.currentJobId = null;
    resetGenerateUI();
    $('saveGridBtn').disabled = !state.grid;
    setProgress(100, `${msg.status === 'cancelled' ? '已取消' : '全部完成'} · ${msg.completed}/${msg.total}` +
      (msg.errors ? ` · ${msg.errors} 错误` : ''));
    bpFinish(msg.status, msg.completed, msg.total, msg.errors || 0);
    // Archive the completed grid to history. Cancelled grids only archive if
    // there's at least one successful cell (no point keeping totally-empty ones).
    if (state.grid && (msg.status === 'done' || (state.grid.cells || []).some((c) => c && c.dataUrl))) {
      archiveGridToHistory();
    }
    return;
  }
  if (msg.status === 'error') {
    state.currentJobId = null;
    resetGenerateUI();
    setProgress(0, '错误: ' + msg.error);
    bpStopClock();
    return;
  }
});

// ---------- grid rendering ----------
function initGrid(msg, xAxisOverride, yAxisOverride) {
  $('emptyHint').classList.add('hidden');
  $('gridScroll').classList.remove('hidden');
  const xAxis = xAxisOverride || buildAxisSpec('x');
  const yAxis = yAxisOverride || buildAxisSpec('y');
  // When restoring from history the labels are already display-ready strings —
  // shortLabel would mangle them. Detect this via the override flag.
  const fromHistory = !!(xAxisOverride || yAxisOverride);
  const xLabels = (msg.xLabels && msg.xLabels.length ? msg.xLabels : ['']).map((v) => fromHistory ? String(v) : shortLabel(xAxis, v));
  const yLabels = (msg.yLabels && msg.yLabels.length ? msg.yLabels : ['']).map((v) => fromHistory ? String(v) : shortLabel(yAxis, v));
  const xLen = msg.xLen || xLabels.length;
  const yLen = msg.yLen || yLabels.length;

  state.grid = { xLen, yLen, xLabels, yLabels, cells: new Array(xLen * yLen), xAxis, yAxis };

  const w = parseInt($('width').value, 10) || 1024;
  const h = parseInt($('height').value, 10) || 1024;
  const cellW = Math.max(140, Math.min(280, Math.floor(900 / Math.max(xLen, 1))));
  const cellH = Math.round(cellW * h / w);

  const table = $('gridTable');
  table.innerHTML = '';
  const hasX = xAxis.type !== 'none';
  const hasY = yAxis.type !== 'none';
  const labelColW = hasY ? 90 : 0;
  table.style.gridTemplateColumns = (hasY ? `${labelColW}px ` : '') + `repeat(${xLen}, ${cellW}px)`;

  if (hasX) {
    if (hasY) {
      const corner = el('div', { class: 'label-cell corner' }, [
        el('div', { class: 'axis-name' }, 'Y: ' + axisDisplayName(yAxis)),
        el('div', { class: 'muted' }, 'X: ' + axisDisplayName(xAxis)),
      ]);
      table.appendChild(corner);
    }
    for (let xi = 0; xi < xLen; xi++) {
      table.appendChild(el('div', { class: 'label-cell x', title: xLabels[xi] }, xLabels[xi]));
    }
  } else if (hasY) {
    table.appendChild(el('div', { class: 'label-cell corner' }, 'Y: ' + axisDisplayName(yAxis)));
    table.appendChild(el('div', { class: 'label-cell' }, ''));
  }

  for (let yi = 0; yi < yLen; yi++) {
    if (hasY) {
      table.appendChild(el('div', { class: 'label-cell y', title: yLabels[yi] }, yLabels[yi]));
    }
    for (let xi = 0; xi < xLen; xi++) {
      const idx = yi * xLen + xi;
      const cell = el('div', { class: 'cell pending', 'data-idx': String(idx) });
      cell.style.width = cellW + 'px';
      cell.style.height = cellH + 'px';
      cell.addEventListener('click', () => openViewer(idx));
      table.appendChild(cell);
    }
  }
  state.grid.cellW = cellW;
  state.grid.cellH = cellH;
}
function cellEl(idx) { return document.querySelector('.cell[data-idx="' + idx + '"]'); }
function markCell(idx, cls) {
  const c = cellEl(idx);
  if (!c) return;
  c.className = 'cell ' + cls;
}
function setCellImage(idx, dataUrl, meta) {
  if (!state.grid) return;
  state.grid.cells[idx] = { dataUrl, ...meta };
  const c = cellEl(idx);
  if (!c) return;
  c.className = 'cell';
  c.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  c.appendChild(img);
}
function setCellError(idx, err) {
  if (!state.grid) return;
  state.grid.cells[idx] = { error: err };
  const c = cellEl(idx);
  if (!c) return;
  c.className = 'cell err';
  c.innerHTML = '';
  const preview = el('div', { class: 'cell-err-preview' }, (err || '').slice(0, 200));
  const hint = el('div', { class: 'cell-err-hint muted' }, '🔍 点击查看完整错误');
  c.appendChild(preview);
  c.appendChild(hint);
}

function showErrorViewer(idx) {
  const cell = state.grid && state.grid.cells[idx];
  if (!cell || !cell.error) return;
  $('viewerImg').src = '';
  $('viewerImg').classList.add('hidden');
  const xi = idx % state.grid.xLen;
  const yi = Math.floor(idx / state.grid.xLen);
  $('viewerMeta').textContent = `单元 #${idx + 1}  [${state.grid.xLabels[xi] || '-'}] × [${state.grid.yLabels[yi] || '-'}]`;

  // Build a richer error display: error text + LoRA diagnostic (when applicable)
  let errBox = document.getElementById('viewerErr');
  if (!errBox) {
    errBox = document.createElement('div');
    errBox.id = 'viewerErr';
    errBox.style.cssText = 'max-width:92vw;max-height:80vh;overflow:auto;background:#1e2127;color:#ffdcdc;padding:18px 22px;border-radius:8px;font-family:Consolas,monospace;font-size:13px;white-space:pre-wrap;word-break:break-word;border:1px solid #ef4444;';
    $('viewer').appendChild(errBox);
  }
  errBox.innerHTML = '';
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;';
  pre.textContent = cell.error;
  errBox.appendChild(pre);

  // If this is a lora_name validation error, attach a diagnostic block
  const loraMatch = /lora_name[^\n]*?["']([^"']+)["']/i.exec(cell.error);
  if (loraMatch && /value[_ ]not[_ ]in[_ ]list/i.test(cell.error)) {
    const failed = loraMatch[1];
    errBox.appendChild(buildLoraDiagnostic(failed));
  }

  errBox.classList.remove('hidden');
  $('viewer').classList.remove('hidden');
  $('viewer').dataset.idx = String(idx);
  $('viewerSave').classList.add('hidden');
}

function buildLoraDiagnostic(failedName) {
  const list = (state.objectInfo && state.objectInfo.loras) || [];
  const failedLower = failedName.toLowerCase();
  const failedBase = failedLower.split('/').pop();
  const failedStem = failedBase.replace(/\.(safetensors|pt|ckpt|bin)$/i, '');

  // Score every known LoRA by basename similarity
  const scored = list.map((name) => {
    const lower = name.toLowerCase();
    const base = lower.split('/').pop();
    const stem = base.replace(/\.(safetensors|pt|ckpt|bin)$/i, '');
    let score = 0;
    if (lower === failedLower) score = 100;                                  // exact (case diff)
    else if (base === failedBase) score = 90;                                // same basename, different folder
    else if (stem === failedStem) score = 85;                                // same stem, different ext
    else if (base.includes(failedStem) || failedStem.includes(stem)) score = 60;
    else if (stem.includes(failedStem.slice(0, 6)) || failedStem.startsWith(stem.slice(0, 6))) score = 30;
    return { name, score };
  }).filter((s) => s.score > 20).sort((a, b) => b.score - a.score).slice(0, 8);

  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px dashed rgba(239,68,68,0.4);';

  const title = document.createElement('div');
  title.style.cssText = 'color:#e6e8eb;font-weight:600;margin-bottom:6px;';
  title.textContent = `🔍 ComfyUI 已识别 ${list.length} 个 LoRA，提交的 "${failedName}" 不在其中`;
  wrap.appendChild(title);

  if (scored.length) {
    const sub = document.createElement('div');
    sub.style.cssText = 'color:#9aa3af;font-size:11px;margin-bottom:6px;';
    sub.textContent = '相似度匹配（点击复制名字到剪贴板）：';
    wrap.appendChild(sub);
    for (const s of scored) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:4px 8px;background:#262a32;border:1px solid #333842;border-radius:4px;margin-bottom:3px;cursor:pointer;color:#e6e8eb;font-size:12px;display:flex;justify-content:space-between;gap:8px;';
      row.title = '点击复制';
      const left = document.createElement('span');
      left.textContent = s.name;
      left.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const right = document.createElement('span');
      right.style.cssText = 'color:#4c8bf5;flex:none;font-size:10px;';
      right.textContent = s.score >= 85 ? '高度相似 ✓' : '可能匹配';
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener('click', () => {
        api.copy(s.name);
        right.textContent = '已复制 ✓';
      });
      wrap.appendChild(row);
    }
  } else {
    const noMatch = document.createElement('div');
    noMatch.style.cssText = 'color:#9aa3af;font-size:11px;margin-bottom:8px;';
    noMatch.textContent = '没有找到相似项。说明 ComfyUI 完全不知道这个文件名。';
    wrap.appendChild(noMatch);
  }

  // Full list expander
  const details = document.createElement('details');
  details.style.cssText = 'margin-top:10px;';
  const summary = document.createElement('summary');
  summary.textContent = `▸ 展开 ComfyUI 完整 LoRA 列表（${list.length}）`;
  summary.style.cssText = 'color:#9aa3af;cursor:pointer;font-size:12px;';
  details.appendChild(summary);
  const ul = document.createElement('div');
  ul.style.cssText = 'margin-top:6px;padding:6px;background:#16181c;border:1px solid #333842;border-radius:4px;max-height:300px;overflow-y:auto;font-size:11px;color:#e6e8eb;';
  for (const name of list) {
    const li = document.createElement('div');
    li.style.cssText = 'padding:2px 4px;cursor:pointer;';
    li.textContent = name;
    li.title = '点击复制';
    li.addEventListener('click', () => { api.copy(name); li.style.color = '#22c55e'; });
    ul.appendChild(li);
  }
  details.appendChild(ul);
  wrap.appendChild(details);

  // Help text
  const help = document.createElement('div');
  help.style.cssText = 'margin-top:12px;padding:8px 10px;background:#262a32;border-radius:4px;font-size:11px;color:#9aa3af;line-height:1.5;';
  help.innerHTML =
    '<b style="color:#e6e8eb;">为什么不在列表里？</b><br>' +
    '1. 文件 <b>不在 ComfyUI/models/loras/</b> 下（你的文件对话框翻到了其他位置）<br>' +
    '2. 文件是在 ComfyUI 启动 <b>之后</b> 才放进去的 — 重启 ComfyUI 才能扫到<br>' +
    '3. 用了 <code>extra_model_paths.yaml</code>，但该 yaml 没指到你以为的位置<br><br>' +
    '<b style="color:#e6e8eb;">推荐做法：</b>用左侧 LoRA 选择栏的 <b>🔎 列表</b> 按钮直接从上面 58 个里挑。';
  wrap.appendChild(help);

  return wrap;
}

// ---------- viewer ----------
function openViewer(idx) {
  if (!state.grid || !state.grid.cells[idx]) return;
  const cell = state.grid.cells[idx];
  // Errored cell — show error text instead of an image
  if (cell.error && !cell.dataUrl) {
    showErrorViewer(idx);
    return;
  }
  if (!cell.dataUrl) return;
  // Hide any error pre that was previously shown
  const errBox = document.getElementById('viewerErr');
  if (errBox) errBox.classList.add('hidden');
  $('viewerImg').classList.remove('hidden');
  $('viewerSave').classList.remove('hidden');
  $('viewerImg').src = cell.dataUrl;
  const xi = idx % state.grid.xLen;
  const yi = Math.floor(idx / state.grid.xLen);
  const xLab = state.grid.xLabels[xi];
  const yLab = state.grid.yLabels[yi];
  $('viewerMeta').textContent = `[${xLab || '-'}] × [${yLab || '-'}]`;
  $('viewer').classList.remove('hidden');
  $('viewer').dataset.idx = String(idx);
}
$('viewerClose').addEventListener('click', () => $('viewer').classList.add('hidden'));
$('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') $('viewer').classList.add('hidden'); });
$('viewerSave').addEventListener('click', async () => {
  const idx = parseInt($('viewer').dataset.idx, 10);
  const cell = state.grid && state.grid.cells[idx];
  if (!cell || !cell.dataUrl) return;
  await api.saveCell({ dataUrl: cell.dataUrl, suggestedName: `cell_${idx}.png` });
});

// ---------- save grid as PNG ----------
async function saveGridAsPng() {
  if (!state.grid) return;
  const { xLen, yLen, xLabels, yLabels, cells, xAxis, yAxis } = state.grid;
  const hasX = xAxis && xAxis.type !== 'none';
  const hasY = yAxis && yAxis.type !== 'none';

  const loaded = await Promise.all(cells.map((c) => loadImg(c && c.dataUrl)));
  const sample = loaded.find((x) => x);
  const fullW = sample ? sample.width : parseInt($('width').value, 10);
  const fullH = sample ? sample.height : parseInt($('height').value, 10);

  const targetCellW = Math.min(fullW, 640);
  const scale = targetCellW / fullW;
  const cw = Math.round(fullW * scale);
  const ch = Math.round(fullH * scale);

  const pad = 8;
  const labelFontPx = 16;
  const labelRowH = hasX ? 40 : 0;
  const labelColW = hasY ? 160 : 0;

  const canvasW = labelColW + xLen * cw + (xLen + 1) * pad;
  const canvasH = labelRowH + yLen * ch + (yLen + 1) * pad;

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#16181c';
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.fillStyle = '#e6e8eb';
  ctx.font = labelFontPx + 'px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  if (hasX) {
    ctx.textAlign = 'center';
    for (let xi = 0; xi < xLen; xi++) {
      const cx = labelColW + pad + xi * (cw + pad) + cw / 2;
      ctx.fillText(String(xLabels[xi] != null ? xLabels[xi] : ''), cx, labelRowH / 2);
    }
  }
  if (hasY) {
    ctx.textAlign = 'right';
    for (let yi = 0; yi < yLen; yi++) {
      const cy = labelRowH + pad + yi * (ch + pad) + ch / 2;
      ctx.fillText(String(yLabels[yi] != null ? yLabels[yi] : ''), labelColW - 6, cy);
    }
  }

  for (let yi = 0; yi < yLen; yi++) {
    for (let xi = 0; xi < xLen; xi++) {
      const idx = yi * xLen + xi;
      const img = loaded[idx];
      const x = labelColW + pad + xi * (cw + pad);
      const y = labelRowH + pad + yi * (ch + pad);
      if (img) {
        ctx.drawImage(img, x, y, cw, ch);
      } else {
        ctx.fillStyle = '#262a32';
        ctx.fillRect(x, y, cw, ch);
        ctx.strokeStyle = '#333842';
        ctx.strokeRect(x, y, cw, ch);
        ctx.fillStyle = '#e6e8eb';
      }
    }
  }

  const dataUrl = canvas.toDataURL('image/png');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await api.saveGrid({ dataUrl, suggestedName: `anima_xy_${ts}.png` });
}
function loadImg(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---------- tagger ----------
const tagger = {
  imagePath: null,
  results: null,          // { byCategory: { cat: [{tag, prob}] }, threshold (=collect), ... }
  selected: new Set(),    // tag names currently checked
  loaded: false,
  modelDir: null,
};
const taggerDl = { active: false, jobId: null, current: null, received: 0, total: 0 };
const COLLECT_THRESH = 0.05;   // run inference at low thresh; UI slider filters in-memory
const CATEGORY_ORDER = ['rating', 'character', 'copyright', 'artist', 'general', 'meta', 'year'];
const ANIMA_CATEGORY_ORDER = ['character', 'copyright', 'artist', 'general', 'meta'];

async function tgInitStatus() {
  const s = await api.taggerStatus();
  tagger.loaded = !!s.loaded;
  tagger.modelDir = s.modelDir;
  const def = await api.taggerDefaultModelDir();
  // restore saved or fall back to default
  const saved = (await api.storeGet('tagger', {})) || {};
  const dir = s.modelDir || saved.modelDir || def;
  $('tgModelDir').value = dir || '';
  tgUpdateStatus();
}
function tgUpdateStatus(loading) {
  const el = $('tgStatus');
  if (loading) {
    el.textContent = '加载中…';
    el.className = 'tg-status';
  } else if (tagger.loaded) {
    el.textContent = '已加载 ✓';
    el.className = 'tg-status ok';
  } else {
    el.textContent = '未加载';
    el.className = 'tg-status';
  }
  $('tgRun').disabled = !(tagger.loaded && tagger.imagePath);
  // dataset auto-tag depends on model + current selection
  const dsRunBtn = document.getElementById('dsRunAutoTag');
  if (dsRunBtn) dsRunBtn.disabled = !(tagger.loaded && ds.current);
  // batch auto-tag depends only on model + selection
  const dsBatchBtn = document.getElementById('dsBatchAutoTag');
  if (dsBatchBtn) {
    const selCount = ds.images.filter((i) => i._selected).length;
    dsBatchBtn.disabled = !(tagger.loaded && selCount > 0);
  }
  // standalone batch tagger: needs model + scanned images
  const btStartBtn = document.getElementById('btStart');
  if (btStartBtn) {
    const hasImgs = bt && bt.images && bt.images.length > 0;
    btStartBtn.disabled = !(tagger.loaded && hasImgs && !bt.running);
  }
}

async function tgLoad() {
  const dir = $('tgModelDir').value.trim();
  if (!dir) { alert('请先选择模型目录'); return; }
  tgUpdateStatus(true);
  const inspect = await api.taggerInspectDir(dir);
  if (!inspect.ok) {
    tagger.loaded = false;
    $('tgStatus').textContent = inspect.error;
    $('tgStatus').className = 'tg-status err';
    return;
  }
  const r = await api.taggerLoad(dir);
  if (!r.ok) {
    tagger.loaded = false;
    $('tgStatus').textContent = '加载失败: ' + r.error;
    $('tgStatus').className = 'tg-status err';
    return;
  }
  tagger.loaded = true;
  tagger.modelDir = r.modelDir;
  await api.storeSet('tagger', { modelDir: r.modelDir });
  tgUpdateStatus();
  console.log('[tagger] loaded', r);
}

async function tgPickDir() {
  const dir = await api.taggerPickModelDir();
  if (!dir) return;
  $('tgModelDir').value = dir;
}

async function tgSetImage(filePath) {
  tagger.imagePath = filePath;
  $('tgImagePath').textContent = filePath;
  const img = $('tgPreview');
  const hint = $('tgDrop').querySelector('.tg-drop-hint');
  // Read the file in main and return a data URL — avoids file:// CSP issues.
  const dataUrl = await api.taggerImageDataUrl(filePath);
  if (!dataUrl) {
    alert('无法读取图片：' + filePath);
    return;
  }
  img.src = dataUrl;
  img.classList.remove('hidden');
  if (hint) hint.classList.add('hidden');
  tgUpdateStatus();
}
async function tgPickImage() {
  const p = await api.taggerPickImage();
  if (p) tgSetImage(p);
}

async function tgRun() {
  if (!tagger.imagePath || !tagger.loaded) return;
  $('tgRun').disabled = true;
  $('tgRunInfo').textContent = '推理中…';
  const r = await api.taggerRun({ imagePath: tagger.imagePath, threshold: COLLECT_THRESH });
  $('tgRun').disabled = false;
  if (!r.ok) {
    $('tgRunInfo').textContent = '失败: ' + r.error;
    return;
  }
  tagger.results = r;
  $('tgRunInfo').textContent =
    `${r.totalCount} 个候选 · 预处理 ${r.preprocessMs}ms · 推理 ${r.inferenceMs}ms`;
  tgRefreshSelection();
  tgRender();
}

// Reset selection: check every tag whose prob >= UI threshold.
function tgRefreshSelection() {
  if (!tagger.results) return;
  const thresh = parseFloat($('tgThresh').value);
  tagger.selected.clear();
  for (const cat of Object.keys(tagger.results.byCategory)) {
    for (const t of tagger.results.byCategory[cat]) {
      if (t.prob >= thresh) tagger.selected.add(t.tag);
    }
  }
}

function tgRender() {
  const wrap = $('tgResults');
  wrap.innerHTML = '';
  if (!tagger.results) {
    wrap.appendChild(el('div', { class: 'tg-empty muted' }, '加载模型并选择图片后，结果会显示在这里。'));
    $('tgCopyAnima').disabled = true;
    $('tgCopyRaw').disabled = true;
    $('tgSelectAll').disabled = true;
    $('tgSelectNone').disabled = true;
    return;
  }
  const uiThresh = parseFloat($('tgThresh').value);
  const cats = Object.keys(tagger.results.byCategory);
  // sort cats by predefined order, unknown ones last
  cats.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  let any = false;
  for (const cat of cats) {
    const tags = tagger.results.byCategory[cat].filter((t) => t.prob >= uiThresh);
    if (!tags.length) continue;
    any = true;
    const block = el('div', { class: 'tg-category tg-cat-' + cat }, [
      el('h4', null, [
        cat.toUpperCase(),
        el('span', { class: 'tg-cat-count' }, String(tags.length)),
      ]),
      el('div', { class: 'tg-tag-list' },
        tags.map((t) => {
          const checked = tagger.selected.has(t.tag);
          const chip = el('span', {
            class: 'tg-tag ' + (checked ? 'checked' : 'unchecked'),
            'data-tag': t.tag,
            onClick: () => {
              if (tagger.selected.has(t.tag)) tagger.selected.delete(t.tag);
              else tagger.selected.add(t.tag);
              tgRender();
            },
          }, [
            t.tag.replace(/_/g, ' '),
            el('span', { class: 'tg-prob' }, t.prob.toFixed(2)),
          ]);
          return chip;
        })
      ),
    ]);
    wrap.appendChild(block);
  }
  if (!any) {
    wrap.appendChild(el('div', { class: 'tg-empty muted' }, '当前阈值下没有结果，试着把阈值滑低。'));
  }
  $('tgCopyAnima').disabled = !any;
  $('tgCopyRaw').disabled = !any;
  $('tgSelectAll').disabled = !any;
  $('tgSelectNone').disabled = !any;
}

function tgFormatAnima() {
  if (!tagger.results) return '';
  const parts = [];
  for (const cat of ANIMA_CATEGORY_ORDER) {
    const tags = tagger.results.byCategory[cat];
    if (!tags) continue;
    for (const t of tags) {
      if (!tagger.selected.has(t.tag)) continue;
      let s = t.tag.replace(/_/g, ' ').toLowerCase();
      if (cat === 'artist') s = '@' + s;
      parts.push(s);
    }
  }
  return parts.join(', ');
}
function tgFormatRaw() {
  if (!tagger.results) return '';
  const parts = [];
  for (const cat of CATEGORY_ORDER) {
    const tags = tagger.results.byCategory[cat];
    if (!tags) continue;
    for (const t of tags) {
      if (!tagger.selected.has(t.tag)) continue;
      parts.push(t.tag);
    }
  }
  return parts.join(', ');
}

function tgSelectAll(checked) {
  if (!tagger.results) return;
  const uiThresh = parseFloat($('tgThresh').value);
  if (checked) {
    for (const cat of Object.keys(tagger.results.byCategory)) {
      for (const t of tagger.results.byCategory[cat]) {
        if (t.prob >= uiThresh) tagger.selected.add(t.tag);
      }
    }
  } else {
    tagger.selected.clear();
  }
  tgRender();
}

// Wire up tagger buttons & events
$('tgPickDir').addEventListener('click', tgPickDir);
$('tgLoad').addEventListener('click', tgLoad);
$('tgDownload').addEventListener('click', () => {
  if (taggerDl.active) tgCancelDownload();
  else tgStartDownload();
});

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function tgStartDownload() {
  let dir = $('tgModelDir').value.trim();
  if (!dir) dir = await api.taggerDefaultModelDir();
  $('tgModelDir').value = dir;
  if (!confirm(
    `将下载约 800 MB 到：\n${dir}\n\n` +
    `· camie-tagger-v2-metadata.json (~8 MB)\n` +
    `· camie-tagger-v2.onnx (~789 MB)\n\n` +
    `请确保磁盘空间充足。已存在的同名文件会被跳过。\n点确定开始下载。`)) return;

  const jobId = 'dl-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  taggerDl.active = true;
  taggerDl.jobId = jobId;
  taggerDl.current = null;
  taggerDl.received = 0;
  taggerDl.total = 0;

  $('tgDownload').textContent = '⏸ 取消下载';
  $('tgDownload').classList.remove('ghost');
  $('tgLoad').disabled = true;
  $('tgPickDir').disabled = true;
  $('tgStatus').textContent = '准备下载…';
  $('tgStatus').className = 'tg-status';

  const result = await api.taggerDownload({ dir, force: false, jobId });
  // result returns when complete (or error); progress events handled by listener
  if (result && result.ok) {
    // Auto-load
    $('tgStatus').textContent = '下载完成，加载中…';
    await tgLoad();
  } else if (!result || !result.ok) {
    if (result && result.cancelled) {
      $('tgStatus').textContent = '已取消';
    } else {
      $('tgStatus').textContent = '下载失败: ' + (result && result.error);
      $('tgStatus').className = 'tg-status err';
    }
  }
  taggerDl.active = false;
  taggerDl.jobId = null;
  $('tgDownload').textContent = '↗ 下载模型';
  $('tgDownload').classList.add('ghost');
  $('tgLoad').disabled = false;
  $('tgPickDir').disabled = false;
}
async function tgCancelDownload() {
  if (!taggerDl.jobId) return;
  await api.taggerCancelDownload(taggerDl.jobId);
}

function shortFileLabel(filename) {
  if (filename && filename.endsWith('.onnx')) return 'onnx';
  if (filename && filename.endsWith('.json')) return 'metadata';
  return filename || '';
}

api.onTaggerDownload((p) => {
  if (!taggerDl.active || p.jobId !== taggerDl.jobId) return;
  const label = shortFileLabel(p.file);
  if (p.status === 'start') {
    taggerDl.current = p.file;
    taggerDl.received = 0;
    taggerDl.total = p.total || 0;
    $('tgStatus').textContent = `下载 ${label}…`;
  } else if (p.status === 'progress') {
    taggerDl.received = p.received;
    taggerDl.total = p.total;
    const pct = p.total ? (p.received / p.total * 100).toFixed(1) : '?';
    $('tgStatus').textContent = `${label} ${fmtBytes(p.received)}/${fmtBytes(p.total)} · ${pct}%`;
  } else if (p.status === 'skipped') {
    $('tgStatus').textContent = `${label} 已存在 (${fmtBytes(p.received)})，跳过`;
  } else if (p.status === 'done') {
    $('tgStatus').textContent = `${label} ✓ ${fmtBytes(p.received)}`;
  } else if (p.status === 'all-done') {
    $('tgStatus').textContent = '全部下载完成';
    $('tgStatus').className = 'tg-status ok';
  } else if (p.status === 'cancelled') {
    $('tgStatus').textContent = '已取消';
  } else if (p.status === 'error') {
    $('tgStatus').textContent = '下载错误: ' + (p.error || '');
    $('tgStatus').className = 'tg-status err';
  }
});
$('tgPickImg').addEventListener('click', tgPickImage);
$('tgRun').addEventListener('click', tgRun);
$('tgThresh').addEventListener('input', () => {
  $('tgThreshVal').textContent = parseFloat($('tgThresh').value).toFixed(2);
  tgRefreshSelection();
  tgRender();
});
$('tgCopyAnima').addEventListener('click', async () => {
  const text = tgFormatAnima();
  if (!text) return;
  await api.copy(text);
  $('tgRunInfo').textContent = `已复制 (Anima 格式) · ${text.split(',').length} 个 tag`;
});
$('tgCopyRaw').addEventListener('click', async () => {
  const text = tgFormatRaw();
  if (!text) return;
  await api.copy(text);
  $('tgRunInfo').textContent = `已复制 (原始) · ${text.split(',').length} 个 tag`;
});
$('tgSelectAll').addEventListener('click', () => tgSelectAll(true));
$('tgSelectNone').addEventListener('click', () => tgSelectAll(false));

// Resolve a dropped File to an absolute filesystem path.
// Electron 32+ removed File.path; use webUtils.getPathForFile via preload.
function pathFromDroppedFile(f) {
  if (!f) return '';
  try {
    if (api && typeof api.getPathForFile === 'function') {
      const p = api.getPathForFile(f);
      if (p) return p;
    }
  } catch (e) { console.error('[drop] getPathForFile error:', e); }
  // Last-ditch fallback for very old Electron builds.
  if (f.path) return f.path;
  return '';
}

// Drag-drop support on the single-image drop area
(function wireDrop() {
  const drop = $('tgDrop');
  if (!drop) return;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    stop(e);
    drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    stop(e);
    drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = pathFromDroppedFile(f);
    if (p) tgSetImage(p);
    else alert('无法获取文件路径。请确认是从本地文件系统拖入而不是浏览器/网页。');
  });
})();

// Also accept drops anywhere in the tag-management view to forward to the active
// image target (handy when users miss the dashed drop zone).
(function wireGlobalDrop() {
  const view = document.getElementById('viewTag');
  if (!view) return;
  view.addEventListener('dragover', (e) => { e.preventDefault(); });
  view.addEventListener('drop', (e) => {
    // If event was already handled by the inner #tgDrop, do nothing.
    if (e.defaultPrevented) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    const p = pathFromDroppedFile(f);
    if (!p) return;
    // Decide target by current sub-mode
    if (state.tmMode === 'dataset') {
      // If a directory was dropped onto dataset list — try to load it
      // (browser File API can't tell directory vs file reliably; users should still use the picker)
      // For an image dropped, preview it as a one-off (no save target).
      if (/\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i.test(p)) {
        // Show in dataset preview without selecting a row
        ds.current = null;
        ds.currentTags = [];
        ds.dirty = false;
        dsRefreshPreview(p);
      }
    } else {
      tgSetImage(p);
    }
  });
})();

// ---------- view + sub-mode switching ----------
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  document.getElementById('viewXy').classList.toggle('hidden', view !== 'xy');
  document.getElementById('viewTag').classList.toggle('hidden', view !== 'tag');
  document.getElementById('viewEdit').classList.toggle('hidden', view !== 'edit');
  document.getElementById('toolbarXy').classList.toggle('hidden', view !== 'xy');
  document.getElementById('toolbarTag').classList.toggle('hidden', view !== 'tag');
  document.getElementById('toolbarEdit').classList.toggle('hidden', view !== 'edit');
  if (view === 'tag') {
    tgInitStatus();
  }
  if (view === 'edit') {
    kxInit();
  }
  try { api.storeSet('ui', { view, tmMode: state.tmMode }); } catch {}
}
function switchTmMode(mode) {
  state.tmMode = mode;
  document.querySelectorAll('.tm-mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  document.getElementById('tmSingle').classList.toggle('hidden', mode !== 'single');
  document.getElementById('tmDataset').classList.toggle('hidden', mode !== 'dataset');
  document.getElementById('tmBatch').classList.toggle('hidden', mode !== 'batch');
  try { api.storeSet('ui', { view: state.view, tmMode: mode }); } catch {}
}
document.querySelectorAll('.nav-btn').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});
document.querySelectorAll('.tm-mode').forEach((b) => {
  b.addEventListener('click', () => switchTmMode(b.dataset.mode));
});

// ---------- dataset editor ----------
const ds = {
  dir: null,
  images: [],             // [{ path, filename, relPath, tagsPath, hasTags, tagCount, _selected, _thumb }]
  filtered: [],           // indices of visible items after filter
  current: null,          // image object currently being edited (may be null)
  currentTags: [],        // tags array for currently-edited image
  originalTags: '',       // last saved raw text for dirty-check
  dirty: false,
  autoTagSuggested: [],   // suggested tags from last auto-tag run (still pre-apply)
  thumbCache: new Map(),  // path → dataUrl
};

async function dsPickDir() {
  const dir = await api.datasetPickDir();
  if (!dir) return;
  await dsLoadDir(dir);
}

async function dsLoadDir(dir) {
  $('dsDir').textContent = '加载中…';
  const r = await api.datasetList({ dir, recursive: false });
  if (!r.ok) {
    $('dsDir').textContent = '加载失败: ' + (r.error || '');
    return;
  }
  ds.dir = r.dir;
  ds.images = r.images.map((it) => ({ ...it, _selected: false }));
  ds.thumbCache.clear();
  await api.storeSet('dataset', { dir: r.dir });
  $('dsDir').textContent = r.dir;
  $('dsReload').disabled = false;
  $('dsSelectAll').disabled = ds.images.length === 0;
  $('dsSelectNone').disabled = ds.images.length === 0;
  dsApplyFilter();
  // Auto-pick first image
  if (ds.images.length) dsSelectImage(ds.images[0]);
  else dsRefreshPreview(null);
}

function dsApplyFilter() {
  const q = ($('dsFilter').value || '').toLowerCase().trim();
  const mode = $('dsFilterTag').value;
  ds.filtered = [];
  for (let i = 0; i < ds.images.length; i++) {
    const it = ds.images[i];
    if (q && !it.relPath.toLowerCase().includes(q)) continue;
    if (mode === 'tagged' && !it.hasTags) continue;
    if (mode === 'untagged' && it.hasTags) continue;
    ds.filtered.push(i);
  }
  dsRenderList();
  const total = ds.images.length;
  const shown = ds.filtered.length;
  $('dsCount').textContent = shown === total ? `${total} 张` : `${shown} / ${total} 张`;
  dsUpdateBatchButtons();
}

function dsRenderList() {
  const wrap = $('dsImages');
  wrap.innerHTML = '';
  const visibleSlice = ds.filtered.slice(0, 500); // cap render for huge datasets
  for (const idx of visibleSlice) {
    const it = ds.images[idx];
    const cb = el('input', {
      type: 'checkbox',
      onClick: (e) => {
        e.stopPropagation();
        it._selected = e.target.checked;
        dsUpdateBatchButtons();
      },
    });
    cb.checked = !!it._selected;
    const thumb = el('div', { class: 'ds-img-thumb' }, [el('span', { class: 'ph' }, '…')]);
    const nameDiv = el('div', { class: 'ds-img-name', title: it.relPath }, it.relPath);
    const badge = it.hasTags
      ? el('span', { class: 'ds-img-badge tagged', title: `${it.tagCount} tags` }, String(it.tagCount))
      : el('span', { class: 'ds-img-badge untagged', title: '没有 .txt 文件' }, '—');
    const row = el('div', {
      class: 'ds-img-row' + (ds.current && ds.current.path === it.path ? ' active' : ''),
      'data-idx': String(idx),
      onClick: () => dsSelectImage(it),
    }, [cb, thumb, nameDiv, badge]);
    wrap.appendChild(row);
    // Lazy-load thumbnail
    if (ds.thumbCache.has(it.path)) {
      const img = document.createElement('img');
      img.src = ds.thumbCache.get(it.path);
      thumb.innerHTML = '';
      thumb.appendChild(img);
    } else {
      api.datasetThumb({ path: it.path, size: 64 }).then((url) => {
        if (!url) return;
        ds.thumbCache.set(it.path, url);
        const img = document.createElement('img');
        img.src = url;
        thumb.innerHTML = '';
        thumb.appendChild(img);
      });
    }
  }
  if (ds.filtered.length > visibleSlice.length) {
    wrap.appendChild(el('div', { class: 'muted', style: 'text-align:center;padding:8px;font-size:11px;' },
      `已显示 ${visibleSlice.length} / ${ds.filtered.length}，请用过滤器收窄`));
  }
}

function dsUpdateBatchButtons() {
  const n = ds.images.filter((i) => i._selected).length;
  $('dsBatchCount').textContent = `(${n} 选中)`;
  const dis = n === 0;
  for (const id of ['dsBatchAdd', 'dsBatchRemove', 'dsBatchRename', 'dsBatchClear', 'dsBatchAutoTag']) {
    $(id).disabled = dis;
  }
}

async function dsSelectImage(it) {
  if (ds.dirty) {
    if (!confirm('当前 tag 有未保存的修改，确认放弃？')) return;
  }
  ds.current = it;
  ds.autoTagSuggested = [];
  $('dsAutoTagInfo').textContent = '';
  $('dsApplyAutoTag').disabled = true;
  // Mark active row
  document.querySelectorAll('.ds-img-row').forEach((r) => r.classList.remove('active'));
  const row = document.querySelector('.ds-img-row[data-idx="' + ds.images.indexOf(it) + '"]');
  if (row) row.classList.add('active');

  await dsLoadTagsFor(it);
  await dsRefreshPreview(it.path);
  $('dsRunAutoTag').disabled = !tagger.loaded;
  $('dsSaveTags').disabled = false;
  $('dsReloadTags').disabled = false;
  $('dsClearTags').disabled = false;
}

async function dsLoadTagsFor(it) {
  const r = await api.datasetReadTags(it.path);
  if (r.ok) {
    ds.currentTags = r.tags || [];
    ds.originalTags = (r.tags || []).join(', ');
    $('dsTagsText').value = ds.originalTags;
    ds.dirty = false;
    $('dsDirty').classList.add('hidden');
    dsRenderChips();
  } else {
    alert('读取 tag 失败: ' + r.error);
  }
}

async function dsRefreshPreview(filePath) {
  const img = $('dsPreview');
  const empty = $('dsPreviewEmpty');
  $('dsImagePath').textContent = filePath || '';
  if (!filePath) {
    img.classList.add('hidden');
    img.src = '';
    empty.classList.remove('hidden');
    return;
  }
  const dataUrl = await api.taggerImageDataUrl(filePath);
  if (!dataUrl) {
    img.classList.add('hidden');
    img.src = '';
    empty.classList.remove('hidden');
    empty.textContent = '无法读取: ' + filePath;
    return;
  }
  img.src = dataUrl;
  img.classList.remove('hidden');
  empty.classList.add('hidden');
}

function dsCurrentTagsFromText() {
  return $('dsTagsText').value
    .split(/[,\n\t]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dsRenderChips() {
  const wrap = $('dsTagChips');
  wrap.innerHTML = '';
  const tags = dsCurrentTagsFromText();
  if (!tags.length) {
    wrap.appendChild(el('span', { class: 'muted', style: 'font-size:11px;' }, '没有 tag'));
    return;
  }
  tags.forEach((t, i) => {
    const chip = el('span', { class: 'ds-chip' }, [
      t,
      el('span', {
        class: 'ds-chip-x', title: '删除',
        onClick: () => {
          const arr = dsCurrentTagsFromText();
          arr.splice(i, 1);
          $('dsTagsText').value = arr.join(', ');
          dsMarkDirty();
          dsRenderChips();
        },
      }, '×'),
    ]);
    wrap.appendChild(chip);
  });
}

function dsMarkDirty() {
  const cur = $('dsTagsText').value.trim();
  ds.dirty = cur !== ds.originalTags;
  $('dsDirty').classList.toggle('hidden', !ds.dirty);
}

async function dsSaveTags() {
  if (!ds.current) return;
  const tags = dsCurrentTagsFromText();
  const r = await api.datasetWriteTags({ imagePath: ds.current.path, tags });
  if (!r.ok) { alert('保存失败: ' + r.error); return; }
  ds.originalTags = tags.join(', ');
  ds.dirty = false;
  $('dsDirty').classList.add('hidden');
  // Update list metadata
  const it = ds.current;
  it.hasTags = true;
  it.tagCount = r.tagCount;
  dsRenderList();
  $('dsAutoTagInfo').textContent = `已保存 ${r.tagCount} 个 tag → ${r.tagsPath.split(/[\\/]/).pop()}`;
}

async function dsRunAutoTag() {
  if (!ds.current || !tagger.loaded) return;
  $('dsAutoTagInfo').textContent = '识别中…';
  $('dsRunAutoTag').disabled = true;
  $('dsApplyAutoTag').disabled = true;
  try {
    const r = await api.taggerRun({ imagePath: ds.current.path, threshold: COLLECT_THRESH });
    if (!r.ok) { $('dsAutoTagInfo').textContent = '失败: ' + r.error; return; }
    const thr = parseFloat($('dsThresh').value);
    const useAnima = $('dsUseAnima').checked;
    const tags = [];
    const order = useAnima ? ANIMA_CATEGORY_ORDER : CATEGORY_ORDER;
    for (const cat of order) {
      const arr = r.byCategory[cat];
      if (!arr) continue;
      for (const t of arr) {
        if (t.prob < thr) continue;
        let s = t.tag;
        if (useAnima) {
          s = s.replace(/_/g, ' ').toLowerCase();
          if (cat === 'artist') s = '@' + s;
        }
        tags.push(s);
      }
    }
    ds.autoTagSuggested = tags;
    $('dsAutoTagInfo').textContent =
      `候选 ${tags.length} 个 (阈值 ${thr.toFixed(2)}) · 推理 ${r.inferenceMs}ms`;
    $('dsApplyAutoTag').disabled = tags.length === 0;
  } finally {
    $('dsRunAutoTag').disabled = false;
  }
}

function dsApplyAutoTag() {
  if (!ds.autoTagSuggested.length) return;
  const mode = $('dsAutoTagMode').value;
  if (mode === 'replace') {
    $('dsTagsText').value = ds.autoTagSuggested.join(', ');
  } else {
    const exist = dsCurrentTagsFromText();
    const existLower = new Set(exist.map((s) => s.toLowerCase()));
    const merged = [...exist];
    for (const t of ds.autoTagSuggested) {
      if (existLower.has(t.toLowerCase())) continue;
      merged.push(t);
      existLower.add(t.toLowerCase());
    }
    $('dsTagsText').value = merged.join(', ');
  }
  dsMarkDirty();
  dsRenderChips();
}

// Batch operations across selected images
function dsSelectedPaths() {
  return ds.images.filter((i) => i._selected).map((i) => i.path);
}

async function dsBatchOp(op) {
  const sel = dsSelectedPaths();
  if (!sel.length) return;
  let args = {};
  if (op === 'add') {
    const tag = prompt('要添加的 tag（多个用逗号分隔）：');
    if (!tag) return;
    args = { tags: tag.split(',').map((s) => s.trim()).filter(Boolean), position: 'end' };
  } else if (op === 'remove') {
    const tag = prompt('要删除的 tag（多个用逗号分隔，大小写不敏感）：');
    if (!tag) return;
    args = { tags: tag.split(',').map((s) => s.trim()).filter(Boolean) };
  } else if (op === 'rename') {
    const from = prompt('原 tag：');
    if (!from) return;
    const to = prompt('新 tag：');
    if (!to) return;
    args = { from, to };
  } else if (op === 'clear') {
    if (!confirm(`确认清空 ${sel.length} 张图片的所有 tag？此操作会清空 .txt 文件。`)) return;
  }
  const r = await api.datasetBatchOp({ imagePaths: sel, op, args });
  if (!r.ok) { alert('批量操作失败: ' + r.error); return; }
  alert(`批量操作完成：${r.touched} 成功 / ${r.failed} 失败`);
  // Refresh metadata + reload current image's tags
  await dsRefreshMeta();
  if (ds.current) await dsLoadTagsFor(ds.current);
}

async function dsBatchAutoTag() {
  const sel = dsSelectedPaths();
  if (!sel.length) return;
  if (!tagger.loaded) { alert('请先加载打标模型'); return; }
  const useAnima = $('dsUseAnima').checked;
  const thr = parseFloat($('dsThresh').value);
  const mode = $('dsAutoTagMode').value;
  if (!confirm(
    `将对 ${sel.length} 张图片跑识别并${mode === 'replace' ? '【替换】' : '【合并到】'}各自的 .txt：\n` +
    `· 阈值 ${thr.toFixed(2)}\n` +
    `· 格式 ${useAnima ? 'Anima (@artist, lowercase, spaces)' : '原始'}\n\n` +
    `这会花一些时间。点确定开始。`)) return;

  $('dsAutoTagInfo').textContent = `批量识别 0 / ${sel.length}…`;
  let ok = 0, fail = 0;
  for (let i = 0; i < sel.length; i++) {
    const p = sel[i];
    try {
      const r = await api.taggerRun({ imagePath: p, threshold: COLLECT_THRESH });
      if (!r.ok) throw new Error(r.error);
      const newTags = [];
      const order = useAnima ? ANIMA_CATEGORY_ORDER : CATEGORY_ORDER;
      for (const cat of order) {
        const arr = r.byCategory[cat];
        if (!arr) continue;
        for (const t of arr) {
          if (t.prob < thr) continue;
          let s = t.tag;
          if (useAnima) {
            s = s.replace(/_/g, ' ').toLowerCase();
            if (cat === 'artist') s = '@' + s;
          }
          newTags.push(s);
        }
      }
      let finalTags;
      if (mode === 'replace') finalTags = newTags;
      else {
        // merge
        const rt = await api.datasetReadTags(p);
        const exist = (rt && rt.tags) || [];
        const seen = new Set(exist.map((s) => s.toLowerCase()));
        finalTags = [...exist];
        for (const t of newTags) {
          if (seen.has(t.toLowerCase())) continue;
          finalTags.push(t);
          seen.add(t.toLowerCase());
        }
      }
      const w = await api.datasetWriteTags({ imagePath: p, tags: finalTags });
      if (!w.ok) throw new Error(w.error);
      ok++;
    } catch (e) {
      fail++;
      console.error('[batchAutoTag] error for', p, e);
    }
    $('dsAutoTagInfo').textContent = `批量识别 ${i + 1} / ${sel.length} (✓${ok} ✗${fail})`;
  }
  $('dsAutoTagInfo').textContent = `批量识别完成 ✓${ok} ✗${fail}`;
  await dsRefreshMeta();
  if (ds.current) await dsLoadTagsFor(ds.current);
}

async function dsRefreshMeta() {
  if (!ds.dir) return;
  const r = await api.datasetList({ dir: ds.dir, recursive: false });
  if (!r.ok) return;
  // Merge — preserve _selected and active state
  const selSet = new Set(ds.images.filter((i) => i._selected).map((i) => i.path));
  ds.images = r.images.map((it) => ({ ...it, _selected: selSet.has(it.path) }));
  dsApplyFilter();
}

// ---------- batch tagger ----------
const bt = {
  dir: null,
  images: [],        // [{ path, relPath, hasTags, ... }] from dataset:list
  running: false,
  cancelled: false,
  startTime: 0,
  etaTimer: null,
  processedTimes: [], // per-image durations (s) for ETA averaging
};

function btLog(text, cls) {
  const wrap = $('btLog');
  const time = new Date();
  const ts = String(time.getHours()).padStart(2, '0') + ':' +
             String(time.getMinutes()).padStart(2, '0') + ':' +
             String(time.getSeconds()).padStart(2, '0');
  const line = el('div', { class: 'bt-log-line' + (cls ? ' ' + cls : '') }, [
    el('span', { class: 'bt-log-time' }, ts),
    text,
  ]);
  wrap.appendChild(line);
  wrap.scrollTop = wrap.scrollHeight;
  // Cap log to last 500 lines to avoid runaway memory
  while (wrap.childElementCount > 500) wrap.removeChild(wrap.firstChild);
}

async function btPickDir() {
  const dir = await api.pickFolder();
  if (!dir) return;
  $('btDir').value = dir;
  bt.dir = dir;
  $('btScan').disabled = false;
  // Auto-scan immediately so user gets a count
  await btScan();
}

async function btScan() {
  if (!bt.dir) return;
  $('btCount').textContent = '扫描中…';
  const recursive = $('btRecursive').checked;
  const r = await api.datasetList({ dir: bt.dir, recursive });
  if (!r.ok) {
    $('btCount').textContent = '扫描失败: ' + r.error;
    return;
  }
  bt.images = r.images;
  const total = bt.images.length;
  const tagged = bt.images.filter((it) => it.hasTags).length;
  $('btCount').textContent = `共 ${total} 张图片（已打标 ${tagged}，未打标 ${total - tagged}）`;
  btUpdatePending();
  $('btStart').disabled = total === 0 || !tagger.loaded;
  $('btProgText').textContent = `0 / ${btPendingCount()}`;
}

function btPendingCount() {
  const skip = $('btSkipTagged').checked;
  return skip ? bt.images.filter((it) => !it.hasTags).length : bt.images.length;
}
function btUpdatePending() {
  const n = btPendingCount();
  $('btProgText').textContent = `0 / ${n}`;
}

function btFmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function btUpdateClock(processed, total) {
  const elapsed = (Date.now() - bt.startTime) / 1000;
  $('btElapsed').textContent = '用时 ' + btFmtTime(elapsed);
  let etaSec = null;
  if (processed > 0 && processed < total) {
    const avg = bt.processedTimes.length
      ? bt.processedTimes.reduce((a, b) => a + b, 0) / bt.processedTimes.length
      : elapsed / processed;
    etaSec = avg * (total - processed);
  } else if (processed >= total) {
    etaSec = 0;
  }
  $('btEta').textContent = 'ETA ' + (etaSec != null ? btFmtTime(etaSec) : '--:--');
}

async function btStart() {
  if (bt.running) return;
  if (!tagger.loaded) { alert('请先在上方加载打标模型'); return; }
  if (!bt.images.length) { alert('请先扫描目录'); return; }

  const skip = $('btSkipTagged').checked;
  const thr = parseFloat($('btThresh').value);
  const useAnima = $('btFormat').value === 'anima';
  const mode = $('btMode').value;  // 'replace' | 'merge'
  const targets = skip ? bt.images.filter((it) => !it.hasTags) : bt.images.slice();
  if (!targets.length) {
    alert('没有需要处理的图片（可能已全部打标，请取消「跳过已有 .txt」）');
    return;
  }

  let processed = 0, ok = 0, fail = 0;
  bt.running = true;
  bt.cancelled = false;
  bt.startTime = Date.now();
  bt.processedTimes = [];
  $('btStart').disabled = true;
  $('btCancel').classList.remove('hidden');
  $('btPickDir').disabled = true;
  $('btScan').disabled = true;
  $('btState').textContent = '运行中…';
  $('btBar').style.width = '0%';
  if (bt.etaTimer) clearInterval(bt.etaTimer);
  bt.etaTimer = setInterval(() => btUpdateClock(processed, targets.length), 500);

  btLog(`开始批量打标：${targets.length} 张图片，阈值 ${thr.toFixed(2)}，格式 ${useAnima ? 'Anima' : '原始'}，模式 ${mode}`, 'ok');
  for (let i = 0; i < targets.length; i++) {
    if (bt.cancelled) {
      btLog(`用户取消，停在 ${processed} / ${targets.length}`, 'skip');
      break;
    }
    const it = targets[i];
    const tStart = Date.now();
    try {
      const r = await api.taggerRun({ imagePath: it.path, threshold: COLLECT_THRESH });
      if (!r.ok) throw new Error(r.error || '识别失败');
      // Build tag list per format
      const newTags = [];
      const order = useAnima ? ANIMA_CATEGORY_ORDER : CATEGORY_ORDER;
      for (const cat of order) {
        const arr = r.byCategory[cat];
        if (!arr) continue;
        for (const t of arr) {
          if (t.prob < thr) continue;
          let s = t.tag;
          if (useAnima) {
            s = s.replace(/_/g, ' ').toLowerCase();
            if (cat === 'artist') s = '@' + s;
          }
          newTags.push(s);
        }
      }
      let finalTags;
      if (mode === 'merge') {
        const rt = await api.datasetReadTags(it.path);
        const exist = (rt && rt.tags) || [];
        const seen = new Set(exist.map((s) => s.toLowerCase()));
        finalTags = [...exist];
        for (const t of newTags) {
          if (seen.has(t.toLowerCase())) continue;
          finalTags.push(t);
          seen.add(t.toLowerCase());
        }
      } else {
        finalTags = newTags;
      }
      const w = await api.datasetWriteTags({ imagePath: it.path, tags: finalTags });
      if (!w.ok) throw new Error('写入失败: ' + w.error);
      it.hasTags = true;
      it.tagCount = w.tagCount;
      ok++;
      btLog(`✓ ${it.relPath} → ${w.tagCount} tags`, 'ok');
    } catch (e) {
      fail++;
      btLog(`✗ ${it.relPath}: ${e.message || e}`, 'err');
    }
    processed++;
    bt.processedTimes.push((Date.now() - tStart) / 1000);
    if (bt.processedTimes.length > 50) bt.processedTimes.shift();
    const pct = (processed / targets.length) * 100;
    $('btBar').style.width = pct.toFixed(1) + '%';
    $('btProgText').textContent = `${processed} / ${targets.length} (${pct.toFixed(0)}%)`;
    btUpdateClock(processed, targets.length);
  }

  if (bt.etaTimer) { clearInterval(bt.etaTimer); bt.etaTimer = null; }
  bt.running = false;
  $('btCancel').classList.add('hidden');
  $('btStart').disabled = false;
  $('btPickDir').disabled = false;
  $('btScan').disabled = false;
  const finalState = bt.cancelled
    ? `已取消 · ✓${ok} ✗${fail}`
    : `完成 · ✓${ok} ✗${fail}`;
  $('btState').textContent = finalState;
  btLog(finalState, bt.cancelled ? 'skip' : 'ok');

  // If the dataset editor was viewing this folder, refresh its list metadata too
  if (ds.dir && (ds.dir === bt.dir || bt.dir.startsWith(ds.dir))) {
    try { await dsRefreshMeta(); } catch {}
  }
}

function btCancel() {
  if (!bt.running) return;
  bt.cancelled = true;
  $('btState').textContent = '取消中…';
}

// Wire batch buttons
$('btPickDir').addEventListener('click', btPickDir);
$('btScan').addEventListener('click', btScan);
$('btRecursive').addEventListener('change', () => { if (bt.dir) btScan(); });
$('btSkipTagged').addEventListener('change', btUpdatePending);
$('btThresh').addEventListener('input', () => {
  $('btThreshVal').textContent = parseFloat($('btThresh').value).toFixed(2);
});
$('btStart').addEventListener('click', btStart);
$('btCancel').addEventListener('click', btCancel);
$('btClearLog').addEventListener('click', () => { $('btLog').innerHTML = ''; });

// Wire dataset buttons
$('dsPickDir').addEventListener('click', dsPickDir);
$('dsReload').addEventListener('click', () => ds.dir && dsLoadDir(ds.dir));
$('dsFilter').addEventListener('input', dsApplyFilter);
$('dsFilterTag').addEventListener('change', dsApplyFilter);
$('dsSelectAll').addEventListener('click', () => {
  for (const idx of ds.filtered) ds.images[idx]._selected = true;
  dsRenderList();
  dsUpdateBatchButtons();
});
$('dsSelectNone').addEventListener('click', () => {
  for (const it of ds.images) it._selected = false;
  dsRenderList();
  dsUpdateBatchButtons();
});
$('dsTagsText').addEventListener('input', () => { dsMarkDirty(); dsRenderChips(); });
$('dsSaveTags').addEventListener('click', dsSaveTags);
$('dsReloadTags').addEventListener('click', () => ds.current && dsLoadTagsFor(ds.current));
$('dsClearTags').addEventListener('click', () => {
  if (!ds.current) return;
  if (!confirm('清空当前编辑器中的所有 tag（点保存才会写入文件）？')) return;
  $('dsTagsText').value = '';
  dsMarkDirty();
  dsRenderChips();
});
$('dsRunAutoTag').addEventListener('click', dsRunAutoTag);
$('dsApplyAutoTag').addEventListener('click', dsApplyAutoTag);
$('dsThresh').addEventListener('input', () => {
  $('dsThreshVal').textContent = parseFloat($('dsThresh').value).toFixed(2);
});
$('dsBatchAdd').addEventListener('click', () => dsBatchOp('add'));
$('dsBatchRemove').addEventListener('click', () => dsBatchOp('remove'));
$('dsBatchRename').addEventListener('click', () => dsBatchOp('rename'));
$('dsBatchClear').addEventListener('click', () => dsBatchOp('clear'));
$('dsBatchAutoTag').addEventListener('click', dsBatchAutoTag);

// ---------- LoRA modal wire-up ----------
$('loraFilter').addEventListener('input', (e) => renderLoraModal(e.target.value));
$('loraModalClose').addEventListener('click', () => loraModalClose(null));
$('loraCancel').addEventListener('click', () => loraModalClose(null));
$('loraOk').addEventListener('click', () => {
  const picks = Array.from(loraModal.selection);
  if (!picks.length) return;
  loraModalClose(loraModal.multi ? picks : picks[0]);
});
$('loraRefresh').addEventListener('click', async () => {
  $('loraOk').disabled = true;
  $('loraModalSub').textContent = '刷新中…';
  await refreshObjectInfo();
  const list = (state.objectInfo && state.objectInfo.loras) || [];
  $('loraModalSub').textContent = `ComfyUI 已识别 ${list.length} 个 LoRA · ${loraModal.multi ? '可多选' : '单选'}`;
  // Drop any selections that vanished from the new list
  for (const n of Array.from(loraModal.selection)) {
    if (!list.includes(n)) loraModal.selection.delete(n);
  }
  $('loraOk').disabled = loraModal.selection.size === 0;
  renderLoraModal($('loraFilter').value);
});
// Esc closes
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('loraModal').classList.contains('hidden')) loraModalClose(null);
});

// ---------- wire up buttons ----------
$('connectBtn').addEventListener('click', doConnect);
$('generateBtn').addEventListener('click', startGenerate);
$('cancelBtn').addEventListener('click', async () => {
  if (!state.currentJobId) {
    // No active job — just reset UI
    resetGenerateUI('已取消');
    return;
  }
  const btn = $('cancelBtn');
  // Second click within 3s: force reset (in case main process hung)
  if (btn.dataset.requested === '1') {
    state.currentJobId = null;
    resetGenerateUI('已强制取消');
    return;
  }
  btn.dataset.requested = '1';
  btn.textContent = '取消中… 再点强制结束';
  btn.disabled = false;
  try { await api.comfyCancel(state.currentJobId); } catch {}
  // Safety: if no `cancelled` event arrives within 8s, force reset
  setTimeout(() => {
    if (btn.dataset.requested === '1' && state.currentJobId) {
      state.currentJobId = null;
      resetGenerateUI('已强制取消（主进程未响应）');
    }
  }, 8000);
});

function resetGenerateUI(reason) {
  $('generateBtn').disabled = false;
  const btn = $('cancelBtn');
  btn.classList.add('hidden');
  btn.textContent = '取消';
  btn.dataset.requested = '';
  $('saveGridBtn').disabled = !state.grid;
  setProgress(0, reason || '');
  bpStopClock();
}
$('saveGridBtn').addEventListener('click', saveGridAsPng);
$('ghClear').addEventListener('click', () => {
  if (!state.gridHistory.length) return;
  if (!confirm(`清空 ${state.gridHistory.length} 条历史？此操作不可撤销。`)) return;
  state.gridHistory = [];
  renderGridHistory();
});
$('inspectLorasBtn').addEventListener('click', async () => {
  // Read-only view: open the modal in single-select mode, but the user can just
  // browse / copy without picking. We use the picker and ignore the result.
  await pickLoraFromList(null, { multi: false });
});
$('animaLink').addEventListener('click', (e) => {
  e.preventDefault();
  api.openExternal('https://huggingface.co/circlestone-labs/Anima');
});

for (const id of ['server', 'positive', 'negative', 'width', 'height', 'steps', 'cfg', 'seed',
                  'unet', 'weightDtype', 'textEncoder', 'clipType', 'vae',
                  'sampler', 'scheduler', 'xType', 'yType', 'xValues', 'yValues']) {
  const node = $(id);
  if (node) node.addEventListener('change', saveSettings);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('viewer').classList.contains('hidden')) {
    $('viewer').classList.add('hidden');
  }
});

// ---------- init ----------
(async function init() {
  console.log('[init] starting');
  try {
    await loadSettings();
    console.log('[init] settings loaded');
    renderBaseLoras();
    console.log('[init] base LoRAs rendered');

    // Restore last-used view + sub-mode
    try {
      const ui = (await api.storeGet('ui', {})) || {};
      if (ui.view === 'tag') switchView('tag');
      else if (ui.view === 'edit') switchView('edit');
      if (ui.tmMode === 'dataset') switchTmMode('dataset');
    } catch (e) { console.warn('[init] ui restore failed:', e); }

    // Restore dataset directory if previously selected
    try {
      const dsSaved = (await api.storeGet('dataset', {})) || {};
      if (dsSaved.dir) {
        // best-effort; if the directory was removed/moved it'll just fail silently
        await dsLoadDir(dsSaved.dir);
      }
    } catch (e) { console.warn('[init] dataset restore failed:', e); }

    await doConnect();
    console.log('[init] connect done');
    if (state.savedXType) { $('xType').value = state.savedXType; renderAxisExtra('x'); }
    if (state.savedYType) { $('yType').value = state.savedYType; renderAxisExtra('y'); }
    console.log('[init] complete');
  } catch (e) {
    showFatal((e && e.stack) || String(e), 'init');
  }
})();

// ============================================================
// Flux Kontext editor module
// ============================================================
// Unified flow: user collects N image paths (drag, pick files, or pick folder),
// chooses output mode (replace original / save with same name to other dir),
// then runs. For N=1 we also show before/after compare. For N>1 we just show
// progress + log.
const kx = {
  files: [],               // [{ path, name, status: 'pending'|'doing'|'done'|'err', error? }]
  outputMode: 'sibling',   // 'sibling' | 'replace'
  outputDir: '',
  jobId: null,
  running: false,
  cancelled: false,
  initialised: false,
  startTime: 0,
  processed: 0,
  times: [],
  etaTimer: null,
};

const KX_PRESETS = [
  ['🚫 去水印', 'remove all watermarks and texts while maintaining the original composition'],
  ['🌅 改晴天', 'change to bright daytime while maintaining the same style and composition'],
  ['🎨 转油画', 'transform to oil painting with visible brushstrokes, thick paint texture, while maintaining composition'],
  ['✏️ 转素描', 'convert to pencil sketch with natural graphite lines, cross-hatching, and visible paper texture'],
  ['🌊 抠主体', 'extract only the subject over a white background, product photography style'],
  ['🎭 去背景', 'remove the background, transparent or white background, keep subject untouched'],
  ['💡 增清晰', 'enhance details and sharpness while maintaining the original composition'],
];

function kxInit() {
  if (kx.initialised) return;
  kx.initialised = true;
  kxPopulateSelects();
  kxRenderPresets();
  kxRestoreSettings();
}

function kxPopulateSelects() {
  if (!state.objectInfo) return;
  const info = state.objectInfo;
  fillSelect($('kxUnet'), info.unets, '', { preferred: ['flux1-kontext-dev', 'kontext'] });
  fillSelect($('kxWeightDtype'), info.weightDtypes || ['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2'], 'fp8_e4m3fn_fast');
  fillSelect($('kxClipType'), info.dualClipTypes && info.dualClipTypes.length ? info.dualClipTypes : ['flux', 'sdxl', 'sd3'], 'flux');
  fillSelect($('kxClipL'), info.dualClipNames && info.dualClipNames.length ? info.dualClipNames : info.textEncoders, '', { preferred: ['clip_l'] });
  fillSelect($('kxClipT5'), info.dualClipNames && info.dualClipNames.length ? info.dualClipNames : info.textEncoders, '', { preferred: ['t5xxl', 't5'] });
  fillSelect($('kxVae'), info.vaes, '', { preferred: ['ae.safetensors', 'flux_vae'] });
  fillSelect($('kxSampler'), info.samplers, 'euler');
  fillSelect($('kxScheduler'), info.schedulers, 'simple');
}

function kxRenderPresets() {
  const wrap = $('kxPresets');
  wrap.innerHTML = '';
  for (const [label, text] of KX_PRESETS) {
    const btn = el('button', {
      class: 'kx-preset',
      onClick: () => { $('kxPrompt').value = text; kxSaveSettings(); },
    }, label);
    wrap.appendChild(btn);
  }
}

function kxCfgFromUi() {
  const seedRaw = String($('kxSeed').value || '').trim();
  let seed = parseInt(seedRaw, 10);
  if (!Number.isFinite(seed) || seed < 0) seed = Math.floor(Math.random() * 2 ** 31);
  return {
    unet: $('kxUnet').value,
    weightDtype: $('kxWeightDtype').value,
    clipL: $('kxClipL').value,
    clipT5: $('kxClipT5').value,
    clipType: $('kxClipType').value,
    vae: $('kxVae').value,
    prompt: $('kxPrompt').value,
    steps: parseInt($('kxSteps').value, 10) || 20,
    cfg: parseFloat($('kxCfg').value) || 1.0,
    fluxGuidance: parseFloat($('kxGuidance').value) || 2.5,
    denoise: parseFloat($('kxDenoise').value) || 1.0,
    sampler: $('kxSampler').value,
    scheduler: $('kxScheduler').value,
    seed,
  };
}

function kxSaveSettings() {
  try {
    api.storeSet('kontext', {
      unet: $('kxUnet').value,
      weightDtype: $('kxWeightDtype').value,
      clipL: $('kxClipL').value,
      clipT5: $('kxClipT5').value,
      clipType: $('kxClipType').value,
      vae: $('kxVae').value,
      prompt: $('kxPrompt').value,
      steps: $('kxSteps').value,
      cfg: $('kxCfg').value,
      fluxGuidance: $('kxGuidance').value,
      denoise: $('kxDenoise').value,
      sampler: $('kxSampler').value,
      scheduler: $('kxScheduler').value,
      seed: $('kxSeed').value,
      outputMode: kx.outputMode,
      outputDir: kx.outputDir,
      recursive: $('kxRecursive').checked,
      skipDone: $('kxSkipDone').checked,
    });
  } catch {}
}

async function kxRestoreSettings() {
  try {
    const s = (await api.storeGet('kontext', {})) || {};
    if (s.prompt) $('kxPrompt').value = s.prompt;
    if (s.steps) $('kxSteps').value = s.steps;
    if (s.cfg) $('kxCfg').value = s.cfg;
    if (s.fluxGuidance) $('kxGuidance').value = s.fluxGuidance;
    if (s.denoise) $('kxDenoise').value = s.denoise;
    if (s.seed != null) $('kxSeed').value = s.seed;
    if (s.outputDir) { kx.outputDir = s.outputDir; $('kxOutDir').value = s.outputDir; }
    if (s.recursive) $('kxRecursive').checked = true;
    if (s.skipDone === false) $('kxSkipDone').checked = false;
    if (s.outputMode === 'replace' || s.outputMode === 'sibling') {
      kx.outputMode = s.outputMode;
      document.querySelectorAll('input[name="kxOutMode"]').forEach((r) => { r.checked = r.value === s.outputMode; });
    }
    const trySet = (id, v) => { if (v && $(id).querySelector(`option[value="${CSS.escape(v)}"]`)) $(id).value = v; };
    trySet('kxUnet', s.unet);
    trySet('kxWeightDtype', s.weightDtype);
    trySet('kxClipL', s.clipL);
    trySet('kxClipT5', s.clipT5);
    trySet('kxClipType', s.clipType);
    trySet('kxVae', s.vae);
    trySet('kxSampler', s.sampler);
    trySet('kxScheduler', s.scheduler);
    kxRefreshOutputUi();
  } catch (e) { console.warn('[kx] restore failed', e); }
}

// ---------- File list management ----------
function kxAddFiles(paths) {
  if (!paths || !paths.length) return;
  const seen = new Set(kx.files.map((f) => f.path));
  let added = 0;
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    kx.files.push({ path: p, name: p.split(/[\\/]/).pop(), status: 'pending' });
    added++;
  }
  if (added) kxRenderFileList();
}
function kxRemoveFile(idx) {
  kx.files.splice(idx, 1);
  kxRenderFileList();
}
function kxClearFiles() {
  kx.files = [];
  kxRenderFileList();
  // Also clear before/after panes
  $('kxBefore').innerHTML = '';
  $('kxAfter').innerHTML = '';
  $('kxCompareWrap').classList.add('hidden');
}
function kxRenderFileList() {
  const wrap = $('kxFileList');
  wrap.innerHTML = '';
  if (kx.files.length) wrap.classList.add('has-items');
  else wrap.classList.remove('has-items');
  for (let i = 0; i < kx.files.length; i++) {
    const f = kx.files[i];
    const row = el('div', { class: 'kx-filelist-item' }, [
      el('span', { class: 'kx-filelist-path', title: f.path }, f.path),
      el('span', { class: 'kx-filelist-status ' + (f.status === 'done' ? 'done' : f.status === 'err' ? 'err' : '') },
        f.status === 'done' ? '✓' : f.status === 'err' ? '✗' : f.status === 'doing' ? '…' : ''),
      el('button', { class: 'kx-filelist-x', title: '移除', onClick: () => kxRemoveFile(i) }, '×'),
    ]);
    wrap.appendChild(row);
  }
  // Update summary
  const n = kx.files.length;
  if (n === 0) $('kxInputSummary').textContent = '未选择文件';
  else if (n === 1) $('kxInputSummary').textContent = `1 张图片 · 将显示前后对比`;
  else $('kxInputSummary').textContent = `${n} 张图片 · 批量处理`;
  kxRefreshRunBtn();
  // Show before pane preview when exactly 1 file
  if (n === 1) kxLoadBeforePreview(kx.files[0].path);
}
async function kxLoadBeforePreview(p) {
  $('kxCompareWrap').classList.remove('hidden');
  $('kxAfter').innerHTML = '<div class="kx-placeholder">点「开始编辑」后显示</div>';
  try {
    const r = await api.taggerImageDataUrl(p);
    if (r && r.ok && r.dataUrl) {
      $('kxBefore').innerHTML = '';
      const img = document.createElement('img');
      img.src = r.dataUrl;
      $('kxBefore').appendChild(img);
    }
  } catch (e) { console.warn('[kx] preview failed', e); }
}

function kxRefreshOutputUi() {
  const isReplace = kx.outputMode === 'replace';
  $('kxOutDirRow').style.opacity = isReplace ? '0.4' : '1';
  $('kxOutDirRow').style.pointerEvents = isReplace ? 'none' : '';
  kxRefreshRunBtn();
}
function kxRefreshRunBtn() {
  const btn = $('kxRunBtnInline');
  const hasFiles = kx.files.length > 0;
  const hasModel = !!$('kxUnet').value;
  const needsOutDir = kx.outputMode === 'sibling' && !kx.outputDir;
  btn.disabled = !hasFiles || !hasModel || kx.running || needsOutDir;
  let info;
  if (kx.running) info = `运行中 · ${kx.processed}/${kx.files.length}`;
  else if (!hasFiles) info = '请先添加图片';
  else if (!hasModel) info = '请先连接 ComfyUI 并选 Flux 模型';
  else if (needsOutDir) info = '请选择输出目录';
  else info = `就绪 · ${kx.files.length} 张图片 → ${kx.outputMode === 'replace' ? '替换原文件' : '保存到 ' + (kx.outputDir.split(/[\\/]/).pop() || '...')}`;
  $('kxRunInfo').textContent = info;
  const hi = $('kxHeaderInfo');
  if (hi) hi.textContent = info;
}

// ---------- Input pickers ----------
async function kxPickImages() {
  const r = await api.pickImage({ multi: true });
  if (Array.isArray(r) && r.length) kxAddFiles(r);
  else if (typeof r === 'string') kxAddFiles([r]);
}
async function kxPickFolder() {
  const dir = await api.pickEditDir();
  if (!dir) return;
  const recursive = $('kxRecursive').checked;
  const r = await api.kontextListImagesInDir({ dir, recursive });
  if (!r.ok) { alert('扫描目录失败: ' + r.error); return; }
  if (!r.files.length) { alert('目录里没有支持的图片格式 (png/jpg/jpeg/webp/bmp)'); return; }
  kxAddFiles(r.files);
}
async function kxPickOutDir() {
  const d = await api.pickEditDir();
  if (!d) return;
  kx.outputDir = d;
  $('kxOutDir').value = d;
  kxSaveSettings();
  kxRefreshRunBtn();
}

// ---------- Run / cancel ----------
function kxFmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function kxUpdateClock(processed, total) {
  const elapsed = (Date.now() - kx.startTime) / 1000;
  $('kxElapsed').textContent = '用时 ' + kxFmtTime(elapsed);
  let etaSec = null;
  if (processed > 0 && processed < total) {
    const avg = kx.times.length ? kx.times.reduce((a, b) => a + b, 0) / kx.times.length : elapsed / processed;
    etaSec = avg * (total - processed);
  } else if (processed >= total) {
    etaSec = 0;
  }
  $('kxEta').textContent = 'ETA ' + (etaSec != null ? kxFmtTime(etaSec) : '--:--');
}
function kxLog(text, cls) {
  const wrap = $('kxLog');
  const t = new Date();
  const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const line = el('div', { class: 'bt-log-line' + (cls ? ' ' + cls : '') }, [
    el('span', { class: 'bt-log-time' }, ts), text,
  ]);
  wrap.appendChild(line);
  wrap.scrollTop = wrap.scrollHeight;
  while (wrap.childElementCount > 500) wrap.removeChild(wrap.firstChild);
}

async function kxRun() {
  if (kx.running) return;
  if (!kx.files.length) { alert('请先添加图片'); return; }
  if (!$('kxUnet').value) { alert('请选 Flux UNET 模型'); return; }
  if (kx.outputMode === 'sibling' && !kx.outputDir) { alert('请选输出目录'); return; }

  // For replace mode, ask confirmation since files are overwritten
  if (kx.outputMode === 'replace') {
    if (!confirm(`将覆盖 ${kx.files.length} 个原文件，无法恢复。继续？`)) return;
  }

  // Optionally skip-done for sibling mode
  const skipDone = $('kxSkipDone').checked && kx.outputMode === 'sibling';

  // Reset statuses
  for (const f of kx.files) { f.status = 'pending'; f.error = null; }
  kxRenderFileList();

  // Build payload
  const cfg = kxCfgFromUi();
  kxSaveSettings();
  const url = $('server').value.trim() || 'http://127.0.0.1:8188';

  kx.running = true;
  kx.cancelled = false;
  kx.startTime = Date.now();
  kx.processed = 0;
  kx.times = [];
  $('kxRunBtnInline').disabled = true;
  $('kxCancelBtnInline').classList.remove('hidden');
  $('kxProgressWrap').classList.remove('hidden');
  $('kxLogWrap').classList.remove('hidden');
  $('kxBar').style.width = '0%';
  $('kxStateText').textContent = '运行中…';
  if (kx.etaTimer) clearInterval(kx.etaTimer);
  kx.etaTimer = setInterval(() => kxUpdateClock(kx.processed, kx.files.length), 500);

  kxLog(`开始：${kx.files.length} 张图片，模式 = ${kx.outputMode === 'replace' ? '替换原文件' : '保存到 ' + kx.outputDir}`, 'ok');

  // Compare panes shown only for single file
  if (kx.files.length === 1) {
    $('kxCompareWrap').classList.remove('hidden');
    $('kxAfter').innerHTML = '<div class="kx-placeholder">上传中…</div>';
    $('kxAfter').classList.add('busy');
  } else {
    $('kxCompareWrap').classList.add('hidden');
  }

  const r = await api.comfyKontextBatch({
    server: url,
    files: kx.files.map((f) => f.path),
    outputMode: kx.outputMode,
    outputDir: kx.outputMode === 'sibling' ? kx.outputDir : null,
    skipDone,
    sendPreview: kx.files.length === 1,
    cfg,
  });
  kx.jobId = r.jobId;
}

function kxOnProgress(msg) {
  if (msg.status === 'kontext-batch-start') {
    kx.jobId = msg.jobId;
    kxLog(`队列 ${msg.total} 张，跳过 ${msg.skipped}`, 'ok');
    $('kxProgText').textContent = `0 / ${msg.total}`;
    return;
  }
  if (msg.status === 'kontext-batch-item-start') {
    $('kxStateText').textContent = `处理 ${msg.index + 1}/${msg.total}: ${msg.filename}`;
    // Mark file as doing
    const idx = kx.files.findIndex((f) => f.path === msg.inputPath);
    if (idx >= 0) { kx.files[idx].status = 'doing'; kxRenderFileList(); }
    return;
  }
  if (msg.status === 'cell-step') {
    const cur = kx.processed + 1;
    const total = kx.files.length;
    $('kxProgText').textContent = `${cur} / ${total} · 采样 ${msg.step}/${msg.total}`;
    return;
  }
  if (msg.status === 'kontext-batch-item-done') {
    kx.processed = msg.completed;
    kx.times.push(((Date.now() - kx.startTime) / 1000) / Math.max(1, msg.completed));
    if (kx.times.length > 50) kx.times.shift();
    const pct = (msg.completed / msg.total) * 100;
    $('kxBar').style.width = pct.toFixed(1) + '%';
    $('kxProgText').textContent = `${msg.completed} / ${msg.total} (${pct.toFixed(0)}%)`;
    const savedShort = (msg.savedPath || '').split(/[\\/]/).pop();
    kxLog(`✓ ${msg.filename} → ${savedShort}`, 'ok');
    kxUpdateClock(msg.completed, msg.total);
    // Mark file as done
    const idx = kx.files.findIndex((f) => f.path === msg.inputPath);
    if (idx >= 0) { kx.files[idx].status = 'done'; kxRenderFileList(); }
    // Show the after image if it was a single-file run
    if (msg.dataUrl) {
      $('kxAfter').classList.remove('busy');
      $('kxAfter').innerHTML = '';
      const img = document.createElement('img');
      img.src = msg.dataUrl;
      $('kxAfter').appendChild(img);
    }
    return;
  }
  if (msg.status === 'kontext-batch-item-error') {
    kxLog(`✗ ${msg.filename}: ${msg.error}`, 'err');
    const idx = kx.files.findIndex((f) => f.path === msg.inputPath);
    if (idx >= 0) { kx.files[idx].status = 'err'; kx.files[idx].error = msg.error; kxRenderFileList(); }
    if (kx.files.length === 1) {
      $('kxAfter').classList.remove('busy');
      $('kxAfter').innerHTML = '<div class="kx-placeholder" style="color:#ef4444;font-size:11px;padding:8px;white-space:pre-wrap;">错误:\n' + (msg.error || '') + '</div>';
    }
    return;
  }
  if (msg.status === 'kontext-batch-done' || msg.status === 'kontext-batch-cancelled') {
    if (kx.etaTimer) { clearInterval(kx.etaTimer); kx.etaTimer = null; }
    kx.running = false;
    kx.jobId = null;
    $('kxRunBtnInline').disabled = false;
    $('kxCancelBtnInline').classList.add('hidden');
    $('kxAfter').classList.remove('busy');
    const final = msg.status === 'kontext-batch-cancelled'
      ? `已取消 · ✓${msg.completed} ✗${msg.errors}`
      : `完成 · ✓${msg.completed} ✗${msg.errors}`;
    $('kxStateText').textContent = final;
    kxLog(final, msg.status === 'kontext-batch-cancelled' ? 'skip' : 'ok');
    kxRefreshRunBtn();
    return;
  }
  if (msg.status === 'kontext-batch-error') {
    if (kx.etaTimer) { clearInterval(kx.etaTimer); kx.etaTimer = null; }
    kx.running = false;
    $('kxRunBtnInline').disabled = false;
    $('kxCancelBtnInline').classList.add('hidden');
    $('kxStateText').textContent = '错误';
    kxLog('错误: ' + msg.error, 'err');
    kxRefreshRunBtn();
    return;
  }
}

// ---------- Wire it up ----------
api.onComfyProgress((msg) => {
  if (state.view !== 'edit') return;
  if (msg.status && (msg.status.startsWith('kontext-batch') || msg.status === 'cell-step')) {
    kxOnProgress(msg);
  }
});

// Drop zone: accepts dropped files (single or multi)
const kxDropZone = $('kxDropZone');
kxDropZone.addEventListener('dragover', (e) => { e.preventDefault(); kxDropZone.classList.add('dragover'); });
kxDropZone.addEventListener('dragleave', () => kxDropZone.classList.remove('dragover'));
kxDropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  kxDropZone.classList.remove('dragover');
  const paths = [];
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    for (const f of e.dataTransfer.files) {
      const p = api.getPathForFile(f);
      if (p) paths.push(p);
    }
  }
  // If a folder was dropped, the file object's path is the dir; treat single
  // dropped entry as a folder if it has no recognizable image extension.
  if (paths.length === 1) {
    const p = paths[0];
    const isImg = /\.(png|jpe?g|webp|bmp)$/i.test(p);
    if (!isImg) {
      // Try as folder
      const recursive = $('kxRecursive').checked;
      const r = await api.kontextListImagesInDir({ dir: p, recursive });
      if (r.ok && r.files.length) { kxAddFiles(r.files); return; }
    }
  }
  kxAddFiles(paths);
});

// Buttons
$('kxPickImages').addEventListener('click', (e) => { e.stopPropagation(); kxPickImages(); });
$('kxPickFolder').addEventListener('click', (e) => { e.stopPropagation(); kxPickFolder(); });
$('kxPickOutDir').addEventListener('click', kxPickOutDir);
$('kxRunBtnInline').addEventListener('click', kxRun);
$('kxCancelBtnInline').addEventListener('click', async () => {
  if (kx.jobId) await api.comfyCancel(kx.jobId);
  kx.cancelled = true;
});
$('kxClearLog').addEventListener('click', () => { $('kxLog').innerHTML = ''; });

// Output mode radio
document.querySelectorAll('input[name="kxOutMode"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    if (e.target.checked) {
      kx.outputMode = e.target.value;
      kxSaveSettings();
      kxRefreshOutputUi();
    }
  });
});

$('kxRecursive').addEventListener('change', kxSaveSettings);
$('kxSkipDone').addEventListener('change', kxSaveSettings);

// Save on field change
['kxPrompt', 'kxSteps', 'kxCfg', 'kxGuidance', 'kxDenoise', 'kxSampler', 'kxScheduler', 'kxSeed',
 'kxUnet', 'kxWeightDtype', 'kxClipL', 'kxClipT5', 'kxClipType', 'kxVae'].forEach((id) => {
  const e = $(id);
  if (e) e.addEventListener('change', () => { kxSaveSettings(); kxRefreshRunBtn(); });
});

})(); // end module IIFE
