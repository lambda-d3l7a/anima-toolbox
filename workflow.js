// Build a ComfyUI workflow JSON for a single XY cell.
//
// Anima is a NVIDIA Cosmos-Predict2-based model distributed as three separate
// files (diffusion model + Qwen 3 text encoder + Qwen-Image VAE), so we use
// UNETLoader + CLIPLoader + VAELoader instead of CheckpointLoaderSimple.
//
// cfg shape:
//   {
//     unet: 'anima-base-v1.0.safetensors',
//     weightDtype: 'default',              // default | fp8_e4m3fn | fp8_e5m2 | ...
//     textEncoder: 'qwen_3_06b_base.safetensors',
//     clipType: 'cosmos',                  // ComfyUI CLIP loader type
//     vae: 'qwen_image_vae.safetensors',
//     positive: '...', negative: '...',
//     width: 832, height: 1216,
//     seed: 42, cfg: 4.5, steps: 35,
//     sampler: 'er_sde', scheduler: 'normal', denoise: 1.0,
//     baseLoras: [{ name, strength }],     // always applied
//     varyingLoras: [{ name, strength }]   // populated by applyAxisOverride
//   }

function buildWorkflow(cfg) {
  if (!cfg.unet) throw new Error('未选择扩散模型 (UNET)');
  if (!cfg.textEncoder) throw new Error('未选择文本编码器 (CLIP)');
  if (!cfg.vae) throw new Error('未选择 VAE');

  const w = {};
  const UNET = '4';
  const CLIP = '11';
  const VAE = '12';

  w[UNET] = {
    inputs: {
      unet_name: cfg.unet,
      weight_dtype: cfg.weightDtype || 'default',
    },
    class_type: 'UNETLoader',
  };
  w[CLIP] = {
    inputs: {
      clip_name: cfg.textEncoder,
      type: cfg.clipType || 'cosmos',
    },
    class_type: 'CLIPLoader',
  };
  w[VAE] = {
    inputs: { vae_name: cfg.vae },
    class_type: 'VAELoader',
  };

  let lastModel = [UNET, 0];
  let lastClip = [CLIP, 0];

  const baseLoras = (cfg.baseLoras || []).filter((l) => l && l.name);
  const varyingLoras = (cfg.varyingLoras || []).filter((l) => l && l.name);
  const allLoras = [...baseLoras, ...varyingLoras];

  let nextId = 100;
  for (const lo of allLoras) {
    const id = String(nextId++);
    const s = parseFloat(lo.strength);
    const strength = Number.isFinite(s) ? s : 1.0;
    // Do NOT normalize path separators here — ComfyUI's combo list on Windows
    // returns native backslashes for nested LoRAs, and the validator does an
    // exact match. The renderer is responsible for canonicalizing names against
    // state.objectInfo.loras before submission.
    const cleanName = String(lo.name || '').replace(/^[\\/]+/, '');
    w[id] = {
      inputs: {
        lora_name: cleanName,
        strength_model: strength,
        strength_clip: strength,
        model: lastModel,
        clip: lastClip,
      },
      class_type: 'LoraLoader',
    };
    lastModel = [id, 0];
    lastClip = [id, 1];
  }

  w['6'] = {
    inputs: { text: cfg.positive || '', clip: lastClip },
    class_type: 'CLIPTextEncode',
  };
  w['7'] = {
    inputs: { text: cfg.negative || '', clip: lastClip },
    class_type: 'CLIPTextEncode',
  };

  w['5'] = {
    inputs: {
      width: toInt(cfg.width, 1024),
      height: toInt(cfg.height, 1024),
      batch_size: 1,
    },
    class_type: 'EmptyLatentImage',
  };

  w['3'] = {
    inputs: {
      seed: toInt(cfg.seed, 0),
      steps: toInt(cfg.steps, 35),
      cfg: toFloat(cfg.cfg, 4.5),
      sampler_name: cfg.sampler || 'er_sde',
      scheduler: cfg.scheduler || 'normal',
      denoise: toFloat(cfg.denoise, 1.0),
      model: lastModel,
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
    class_type: 'KSampler',
  };

  w['8'] = {
    inputs: { samples: ['3', 0], vae: [VAE, 0] },
    class_type: 'VAEDecode',
  };

  w['9'] = {
    inputs: { filename_prefix: 'anima_xy', images: ['8', 0] },
    class_type: 'SaveImage',
  };

  return w;
}

// Mutate cfg in place to apply axis spec's i-th value.
// axis = { type, values, loraName?, strength? }
function applyAxisOverride(cfg, axis, index) {
  if (!axis || !axis.type || axis.type === 'none') return;
  if (!Array.isArray(axis.values) || axis.values.length === 0) return;
  if (index < 0 || index >= axis.values.length) return;
  const v = axis.values[index];

  if (!Array.isArray(cfg.varyingLoras)) cfg.varyingLoras = [];

  switch (axis.type) {
    case 'lora_weight': {
      if (!axis.loraName) throw new Error('LoRA 权重轴未指定 LoRA 文件');
      cfg.varyingLoras.push({ name: axis.loraName, strength: toFloat(v, 0) });
      break;
    }
    case 'lora_file': {
      const s = axis.strength != null ? axis.strength : 0.8;
      cfg.varyingLoras.push({ name: String(v), strength: toFloat(s, 0.8) });
      break;
    }
    case 'seed': cfg.seed = toInt(v, 0); break;
    case 'cfg': cfg.cfg = toFloat(v, 4.5); break;
    case 'steps': cfg.steps = toInt(v, 35); break;
    case 'sampler': cfg.sampler = String(v); break;
    case 'scheduler': cfg.scheduler = String(v); break;
    case 'sampler_scheduler': {
      // value is a string like "er_sde + normal" (sampler + scheduler) or an
      // object { sampler, scheduler }. Accept both forms.
      let sampler, scheduler;
      if (v && typeof v === 'object') { sampler = v.sampler; scheduler = v.scheduler; }
      else {
        const m = String(v).split(/\s*\+\s*/);
        sampler = m[0]; scheduler = m[1];
      }
      if (sampler) cfg.sampler = String(sampler);
      if (scheduler) cfg.scheduler = String(scheduler);
      break;
    }
    default: throw new Error('未知轴类型: ' + axis.type);
  }
}

function toInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function toFloat(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = { buildWorkflow, applyAxisOverride };
