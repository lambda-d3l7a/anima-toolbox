// camie-tagger-v2 ONNX inference for Electron main process.
//
// Pipeline mirrors Camais03/camie-tagger-v2/onnx_inference.py exactly:
//   1. Convert image to RGB, resize maintaining aspect ratio so the longer
//      side equals `img_size` (default 512), using Lanczos3.
//   2. Pad to img_size × img_size with RGB (124, 116, 104) — ImageNet mean.
//   3. NCHW float32, ImageNet normalize: (x/255 - mean) / std.
//   4. ONNX inference. Three outputs: [initial, refined, candidates].
//      Use refined (index 1).
//   5. Sigmoid, threshold, group by category from metadata.json.

const path = require('path');
const fs = require('fs');

let ort = null;
let sharp = null;
let session = null;
let modelDir = null;
let metadata = null;
let idxToTag = null;        // { "0": "tag_name", ... }
let tagToCategory = null;   // { "tag_name": "general", ... }
let imgSize = 512;
let totalTags = 0;

function ensureDeps() {
  if (!ort) ort = require('onnxruntime-node');
  if (!sharp) sharp = require('sharp');
}

const ONNX_FILENAME = 'camie-tagger-v2.onnx';
const META_FILENAME = 'camie-tagger-v2-metadata.json';

function inspectModelDir(dir) {
  if (!dir) return { ok: false, error: '未指定模型目录' };
  if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在: ' + dir };
  const onnxPath = path.join(dir, ONNX_FILENAME);
  const metaPath = path.join(dir, META_FILENAME);
  const onnxOk = fs.existsSync(onnxPath);
  const metaOk = fs.existsSync(metaPath);
  if (!onnxOk || !metaOk) {
    return {
      ok: false,
      error: `目录下缺少文件：${!onnxOk ? ONNX_FILENAME + ' ' : ''}${!metaOk ? META_FILENAME : ''}`,
      onnxPath, metaPath, onnxOk, metaOk,
    };
  }
  const onnxSize = fs.statSync(onnxPath).size;
  return { ok: true, onnxPath, metaPath, onnxSizeMB: Math.round(onnxSize / 1024 / 1024) };
}

async function loadModel(dir) {
  ensureDeps();
  const info = inspectModelDir(dir);
  if (!info.ok) throw new Error(info.error);

  console.log('[tagger] loading metadata…');
  const metaText = fs.readFileSync(info.metaPath, 'utf8');
  metadata = JSON.parse(metaText);
  const di = metadata.dataset_info || {};
  const tm = (di.tag_mapping) || {};
  idxToTag = tm.idx_to_tag || {};
  tagToCategory = tm.tag_to_category || {};
  imgSize = (metadata.model_info && metadata.model_info.img_size) || 512;
  totalTags = di.total_tags || Object.keys(idxToTag).length;

  console.log('[tagger] loading ONNX session… (this may take ~10s on first load)');
  const t0 = Date.now();
  // Prefer DirectML on Windows (5-10x speedup on dedicated GPU), fall back to CPU.
  try {
    session = await ort.InferenceSession.create(info.onnxPath, {
      executionProviders: ['dml', 'cpu'],
      graphOptimizationLevel: 'all',
    });
  } catch (e) {
    console.warn('[tagger] DML load failed, retrying CPU only:', e.message || e);
    session = await ort.InferenceSession.create(info.onnxPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }
  console.log('[tagger] session ready in', Date.now() - t0, 'ms; inputs:', session.inputNames,
    'outputs:', session.outputNames);
  modelDir = dir;
  return getStatus();
}

function getStatus() {
  return {
    loaded: !!session,
    modelDir,
    imgSize,
    totalTags,
    inputName: session ? session.inputNames[0] : null,
    outputNames: session ? session.outputNames : null,
  };
}

async function preprocessImage(imagePath) {
  ensureDeps();
  if (!fs.existsSync(imagePath)) throw new Error('图片不存在: ' + imagePath);

  // 1. read metadata for aspect-ratio calc
  const meta = await sharp(imagePath).metadata();
  if (!meta.width || !meta.height) throw new Error('无法读取图像尺寸: ' + imagePath);
  const ar = meta.width / meta.height;
  let newW, newH;
  if (ar > 1) { newW = imgSize; newH = Math.round(imgSize / ar); }
  else { newH = imgSize; newW = Math.round(imgSize * ar); }
  // Guard against zero (extreme aspect ratios)
  if (newW < 1) newW = 1;
  if (newH < 1) newH = 1;

  const padX = Math.floor((imgSize - newW) / 2);
  const padY = Math.floor((imgSize - newH) / 2);

  // 2. resize (lanczos3) + pad with ImageNet mean color, output raw RGB
  const { data, info } = await sharp(imagePath)
    .removeAlpha()             // drop alpha if present (RGBA → RGB)
    .toColorspace('srgb')
    .resize(newW, newH, { kernel: sharp.kernel.lanczos3, fit: 'fill' })
    .extend({
      top: padY,
      bottom: imgSize - newH - padY,
      left: padX,
      right: imgSize - newW - padX,
      background: { r: 124, g: 116, b: 104 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== imgSize || info.height !== imgSize) {
    throw new Error(`预处理后尺寸不对: ${info.width}x${info.height}, 期望 ${imgSize}x${imgSize}`);
  }

  // 3. RGB interleaved → NCHW Float32 with ImageNet normalize
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const chSize = imgSize * imgSize;
  const float = new Float32Array(3 * chSize);
  for (let p = 0; p < chSize; p++) {
    const base = p * 3;
    const r = data[base] / 255;
    const g = data[base + 1] / 255;
    const b = data[base + 2] / 255;
    float[p] = (r - mean[0]) / std[0];
    float[chSize + p] = (g - mean[1]) / std[1];
    float[2 * chSize + p] = (b - mean[2]) / std[2];
  }
  return float;
}

async function runInference(imagePath, threshold) {
  if (!session) throw new Error('模型未加载，请先在「打标」面板里选择模型目录');
  ensureDeps();

  const t0 = Date.now();
  const float = await preprocessImage(imagePath);
  const tPre = Date.now() - t0;

  const inputName = session.inputNames[0];
  const inputTensor = new ort.Tensor('float32', float, [1, 3, imgSize, imgSize]);

  const t1 = Date.now();
  const outputs = await session.run({ [inputName]: inputTensor });
  const tInf = Date.now() - t1;

  // Use refined predictions (output[1]) if available
  const names = session.outputNames;
  const mainName = names.length >= 2 ? names[1] : names[0];
  const mainOut = outputs[mainName];
  const logits = mainOut.data; // Float32Array of length totalTags

  const thr = Number.isFinite(threshold) ? threshold : 0.5;
  const byCategory = {};
  for (let i = 0; i < logits.length; i++) {
    const p = 1 / (1 + Math.exp(-logits[i]));
    if (p < thr) continue;
    const idxStr = String(i);
    const tagName = idxToTag[idxStr];
    if (!tagName) continue;
    const cat = tagToCategory[tagName] || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ tag: tagName, prob: p });
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].sort((a, b) => b.prob - a.prob);
  }

  return {
    byCategory,
    threshold: thr,
    preprocessMs: tPre,
    inferenceMs: tInf,
    outputName: mainName,
    totalCount: Object.values(byCategory).reduce((s, a) => s + a.length, 0),
  };
}

module.exports = {
  loadModel, runInference, getStatus, inspectModelDir,
  ONNX_FILENAME, META_FILENAME,
};
