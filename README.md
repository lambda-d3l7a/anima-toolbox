# Anima XY Plot

为 Anima 模型（及其 LoRA）生成 XY 对比图的 Electron 桌面工具。
后端走本地 ComfyUI 的 HTTP/WebSocket API；UI 借鉴 sd-webui-advanced-xyz 的轴编辑方式。

## 前置依赖

1. **ComfyUI 在跑**。默认监听 `http://127.0.0.1:8188`。启动命令通常是：
   ```
   python main.py
   ```
2. **Anima 模型**（基于 NVIDIA Cosmos-Predict2-2B，分三个文件）：
   下载地址：https://huggingface.co/circlestone-labs/Anima
   ```
   ComfyUI/
   └── models/
       ├── diffusion_models/anima-base-v1.0.safetensors   (UNETLoader 加载)
       ├── text_encoders/qwen_3_06b_base.safetensors      (CLIPLoader, type=cosmos)
       └── vae/qwen_image_vae.safetensors                  (VAELoader 加载)
   ```
3. **任何要测的 LoRA** 放到 `ComfyUI/models/loras/`（可放子目录）。
4. Node.js 18+。

## 安装 & 启动

```
cd E:/MyProject/anima_xy_plot
npm install
npm start
```

或者打包：
```
npm run dist
```

## 使用

1. 顶部填 ComfyUI 地址（默认 `http://127.0.0.1:8188`），点「连接」加载模型 / LoRA / sampler 列表。
2. 左侧「模型」区会自动选中 Anima 三件套（如果文件名是默认的）：
   - 扩散模型：`anima-base-v1.0.safetensors`
   - 文本编码器：`qwen_3_06b_base.safetensors`
   - CLIP Type：`cosmos`
   - VAE：`qwen_image_vae.safetensors`
   - Weight Dtype：`default`（如果显存不够可换 `fp8_e4m3fn`）
3. 填正负 prompt、尺寸、采样设置：
   - 官方推荐：Steps 30–50，CFG 4–5，Sampler `er_sde` / `euler_a` / `dpmpp_2m_sde_gpu`。
   - Seed 填 `-1` 或留空则随机一次种子并在所有单元格中复用，方便对比其他轴。
4. **基础 LoRA**：每张图都会附加的固定 LoRA。点「+ 添加 LoRA」打开文件对话框（可多选）从 `ComfyUI/models/loras/` 选择，工具会自动把绝对路径解析回 ComfyUI 用的相对名。
5. **X 轴 / Y 轴**：分别选「类型 + 值列表」。
   - `LoRA 权重`：扫描某个 LoRA 的权重；在轴下点「📁 浏览」选目标 LoRA。值列表如 `0.2, 0.4, 0.6, 0.8, 1.0`。
   - `LoRA 文件`：扫描多个 LoRA 文件，固定一个强度。点「📁 添加文件」多选追加。
   - `Seed / CFG / Steps`：数值列表（逗号或换行分隔）。
   - `Sampler / Scheduler`：名称列表。
   - 任一轴选「— 无 —」则该方向为单列/单行。
6. 「生成 XY 图」开始，单元格按顺序填充缩略图；点击任一单元格可放大查看。
7. 「保存网格」把整张拼图（含标签）导出为 PNG。

## Anima 模型的 prompt 提示

- 画师标签格式：`@artist_name`（小写，下划线替换为空格）。`@` 前缀不可省略。
- 见同目录 `danbooru_artist_search` 工具，用于筛选画师并一键拷贝为 Anima 格式。

## 项目结构

```
anima_xy_plot/
├── main.js          Electron 主进程 + ComfyUI 客户端 + 网格调度
├── preload.js       contextBridge API
├── workflow.js      构造 ComfyUI workflow JSON
├── renderer/
│   ├── index.html
│   ├── styles.css
│   └── renderer.js  UI 逻辑：参数面板、轴编辑器、网格渲染、PNG 拼接
└── package.json
```

## 🏷 打标功能（Camie-Tagger v2）

工具栏右上角「🏷 打标」按钮打开，可对图片自动生成 danbooru 风格 tag，并一键转换为 Anima prompt 格式。

**首次使用前**：
1. 点弹出面板里的「↗ 下载模型」按钮（跳到 HuggingFace）
2. 下载这两个文件到任意目录（推荐 `anima_xy_plot/tagger_models/`）：
   - `camie-tagger-v2.onnx`（789 MB）
   - `camie-tagger-v2-metadata.json`（7.77 MB）
3. 点「📁 选目录」指向这个文件夹，再点「加载」

模型 143M 参数 ViT，在 CPU 上推理 ~3-10s 每张；Windows 有独显的话会自动用 DirectML 加速（5-10×）。

**使用**：
- 拖拽图片 / 「📁 选择图片」加载
- 「识别」跑推理
- 阈值滑块即时过滤（已经识别过的图无需重跑）
- tag chip 可点击切换勾选
- 「📋 复制为 Anima 格式」：artist 自动加 `@`，下划线换空格，小写，按 `character → copyright → artist → general → meta` 排序逗号连接

## 已知限制

- 只支持单 GPU 串行生成（ComfyUI 自身就是串行队列）。
- 不支持 Z 轴（如需 Z 轴可手动跑多次再合并）。
- LoRA 权重 model/clip 绑定为同一个值。

## License

MIT
