const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ComfyUI server
  comfyPing: (url) => ipcRenderer.invoke('comfy:ping', url),
  comfyObjectInfo: (url) => ipcRenderer.invoke('comfy:objectInfo', url),
  comfyRunGrid: (opts) => ipcRenderer.invoke('comfy:runGrid', opts),
  comfyCancel: (jobId) => ipcRenderer.invoke('comfy:cancel', jobId),
  comfyKontextSingle: (opts) => ipcRenderer.invoke('comfy:kontextSingle', opts),
  comfyKontextBatch: (opts) => ipcRenderer.invoke('comfy:kontextBatch', opts),
  onComfyProgress: (cb) => ipcRenderer.on('comfy:progress', (_e, p) => cb(p)),

  // Image utilities
  saveGrid: (opts) => ipcRenderer.invoke('grid:save', opts),
  saveCell: (opts) => ipcRenderer.invoke('cell:save', opts),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickLoraFiles: (opts) => ipcRenderer.invoke('dialog:pickLoraFiles', opts),
  pickImage: (opts) => ipcRenderer.invoke('dialog:pickImage', opts),
  pickEditDir: () => ipcRenderer.invoke('dialog:pickEditDir'),
  kontextListImagesInDir: (opts) => ipcRenderer.invoke('kontext:listImagesInDir', opts),

  // Resolve File → absolute path (drag-drop helper).
  // Electron 32+ removed File.path; use webUtils.getPathForFile() instead.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch (e) { console.error('[preload] getPathForFile failed:', e); return ''; }
  },

  // Settings persistence
  storeGet: (key, fallback) => ipcRenderer.invoke('store:get', key, fallback),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // Misc
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  copy: (text) => ipcRenderer.invoke('app:copy', text),

  // Tagger
  taggerStatus: () => ipcRenderer.invoke('tagger:status'),
  taggerInspectDir: (dir) => ipcRenderer.invoke('tagger:inspectDir', dir),
  taggerLoad: (dir) => ipcRenderer.invoke('tagger:load', dir),
  taggerRun: (opts) => ipcRenderer.invoke('tagger:run', opts),
  taggerPickImage: () => ipcRenderer.invoke('tagger:pickImage'),
  taggerPickModelDir: () => ipcRenderer.invoke('tagger:pickModelDir'),
  taggerDefaultModelDir: () => ipcRenderer.invoke('tagger:defaultModelDir'),
  taggerImageDataUrl: (filePath) => ipcRenderer.invoke('tagger:imageDataUrl', filePath),
  taggerDownload: (opts) => ipcRenderer.invoke('tagger:download', opts),
  taggerCancelDownload: (jobId) => ipcRenderer.invoke('tagger:cancelDownload', jobId),
  onTaggerDownload: (cb) => ipcRenderer.on('tagger:download', (_e, p) => cb(p)),

  // Dataset (image folder + sibling .txt tag files)
  datasetPickDir: () => ipcRenderer.invoke('dataset:pickDir'),
  datasetList: (opts) => ipcRenderer.invoke('dataset:list', opts),
  datasetReadTags: (imagePath) => ipcRenderer.invoke('dataset:readTags', imagePath),
  datasetWriteTags: (opts) => ipcRenderer.invoke('dataset:writeTags', opts),
  datasetBatchOp: (opts) => ipcRenderer.invoke('dataset:batchOp', opts),
  datasetThumb: (opts) => ipcRenderer.invoke('dataset:thumb', opts),
});
