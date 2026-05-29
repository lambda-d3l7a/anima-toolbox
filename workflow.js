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

// ---------------------------------------------------------------------------
// Flux.1 Kontext (Dev) workflow — prompt-driven image editing.
//
// cfg shape:
//   {
//     unet: 'flux1-kontext-dev.safetensors',
//     weightDtype: 'fp8_e4m3fn_fast',
//     clipL: 'clip_l.safetensors',
//     clipT5: 't5xxl_fp8_e4m3fn.safetensors',
//     clipType: 'flux',            // DualCLIPLoader type
//     vae: 'ae.safetensors',
//     prompt: 'remove all watermarks ...',
//     inputImage: 'uploaded_filename.png',  // ComfyUI input/ filename
//     seed, steps, cfg, sampler, scheduler, denoise,
//     fluxGuidance,                 // FluxGuidance widget (cfg 2-3 typical)
//     savePrefix: 'kontext_out'
//   }
function buildKontextWorkflow(cfg) {
  if (!cfg.unet) throw new Error('未选 Flux UNET 模型');
  if (!cfg.clipL || !cfg.clipT5) throw new Error('未选 clip_l 和 t5xxl');
  if (!cfg.vae) throw new Error('未选 VAE');
  if (!cfg.inputImage) throw new Error('未上传输入图片');

  const w = {};
  const UNET = '1', CLIP = '2', VAE = '3';
  const LOAD_IMG = '10', SCALE = '11', VAE_ENC = '12';
  const POS_ENC = '20', REF_LATENT = '21', GUIDANCE = '22', NEG = '23';
  const KSAMPLER = '30', DECODE = '40', SAVE = '50';

  w[UNET] = {
    inputs: { unet_name: cfg.unet, weight_dtype: cfg.weightDtype || 'fp8_e4m3fn_fast' },
    class_type: 'UNETLoader',
  };
  w[CLIP] = {
    inputs: {
      clip_name1: cfg.clipL,
      clip_name2: cfg.clipT5,
      type: cfg.clipType || 'flux',
    },
    class_type: 'DualCLIPLoader',
  };
  w[VAE] = { inputs: { vae_name: cfg.vae }, class_type: 'VAELoader' };

  w[LOAD_IMG] = {
    inputs: { image: cfg.inputImage, upload: 'image' },
    class_type: 'LoadImage',
  };
  w[SCALE] = {
    inputs: { image: [LOAD_IMG, 0] },
    class_type: 'FluxKontextImageScale',
  };
  w[VAE_ENC] = {
    inputs: { pixels: [SCALE, 0], vae: [VAE, 0] },
    class_type: 'VAEEncode',
  };

  w[POS_ENC] = {
    inputs: { text: cfg.prompt || '', clip: [CLIP, 0] },
    class_type: 'CLIPTextEncode',
  };
  w[REF_LATENT] = {
    inputs: { conditioning: [POS_ENC, 0], latent: [VAE_ENC, 0] },
    class_type: 'ReferenceLatent',
  };
  w[GUIDANCE] = {
    inputs: { conditioning: [REF_LATENT, 0], guidance: toFloat(cfg.fluxGuidance, 2.5) },
    class_type: 'FluxGuidance',
  };
  w[NEG] = {
    inputs: { conditioning: [POS_ENC, 0] },
    class_type: 'ConditioningZeroOut',
  };

  w[KSAMPLER] = {
    inputs: {
      seed: toInt(cfg.seed, 0),
      steps: toInt(cfg.steps, 20),
      cfg: toFloat(cfg.cfg, 1.0),
      sampler_name: cfg.sampler || 'euler',
      scheduler: cfg.scheduler || 'simple',
      denoise: toFloat(cfg.denoise, 1.0),
      model: [UNET, 0],
      positive: [GUIDANCE, 0],
      negative: [NEG, 0],
      latent_image: [VAE_ENC, 0],
    },
    class_type: 'KSampler',
  };

  w[DECODE] = {
    inputs: { samples: [KSAMPLER, 0], vae: [VAE, 0] },
    class_type: 'VAEDecode',
  };
  w[SAVE] = {
    inputs: {
      filename_prefix: cfg.savePrefix || 'kontext_edit',
      images: [DECODE, 0],
    },
    class_type: 'SaveImage',
  };
  return w;
}

module.exports = { buildWorkflow, applyAxisOverride, buildKontextWorkflow };
