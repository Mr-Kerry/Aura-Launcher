const { contextBridge, ipcRenderer, desktopCapturer, screen, clipboard } = require('electron');

let pinyinFn = null;

try {
  const pinyinModule = require('pinyin-pro');
  pinyinFn = pinyinModule.pinyin || pinyinModule.default || pinyinModule;
} catch (error) {
  console.error('加载 pinyin-pro 失败:', error);
}

async function getPrimaryDisplayMetrics() {
  if (screen && typeof screen.getPrimaryDisplay === 'function') {
    const display = screen.getPrimaryDisplay();
    return {
      id: display.id,
      width: display.size.width,
      height: display.size.height,
      scaleFactor: display.scaleFactor || 1
    };
  }

  try {
    const metrics = await ipcRenderer.invoke('get-primary-display-metrics');
    if (metrics && metrics.width && metrics.height) {
      return metrics;
    }
  } catch {
    // ignore
  }

  return {
    id: null,
    width: 1920,
    height: 1080,
    scaleFactor: 1
  };
}

async function captureViaDesktopCapturer() {
  if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
    return { success: false, error: 'desktopCapturer unavailable' };
  }

  const metrics = await getPrimaryDisplayMetrics();
  const width = metrics.width || 1920;
  const height = metrics.height || 1080;
  const scale = metrics.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    }
  });

  if (!Array.isArray(sources) || sources.length === 0) {
    return { success: false, error: 'no screen sources' };
  }

  const primaryId = metrics.id !== null ? String(metrics.id) : '';
  const source = sources.find((item) => String(item.display_id) === primaryId) || sources[0];
  if (!source || !source.thumbnail) {
    return { success: false, error: 'empty thumbnail' };
  }

  const dataUrl = source.thumbnail.toDataURL();
  if (!dataUrl) {
    return { success: false, error: 'empty dataUrl' };
  }

  return { success: true, dataUrl };
}

async function capturePrimaryScreenDataUrl() {
  try {
    const fastResult = await captureViaDesktopCapturer();
    if (fastResult && fastResult.success && fastResult.dataUrl) {
      return fastResult;
    }
  } catch {
    // ignore
  }

  try {
    const result = await ipcRenderer.invoke('capture-screen');
    if (result && result.success && result.dataUrl) {
      return result;
    }
    return result || { success: false, error: 'capture-screen failed' };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

function getPinyinInfo(text = '') {
  const source = String(text || '').trim();
  if (!source || typeof pinyinFn !== 'function') {
    return { full: '', initials: '' };
  }

  try {
    const full = pinyinFn(source, {
      toneType: 'none',
      type: 'array'
    }).join('').toLowerCase();

    const initials = pinyinFn(source, {
      toneType: 'none',
      pattern: 'first',
      type: 'array'
    }).join('').toLowerCase();

    return { full, initials };
  } catch (error) {
    console.error('getPinyinInfo 失败:', source, error);
    return { full: '', initials: '' };
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  getAppList: () => ipcRenderer.invoke('get-app-list'),
  getAppIcons: (ids) => ipcRenderer.invoke('get-app-icons', ids),
  launchApp: (appOrPath) => ipcRenderer.invoke('launch-app', appOrPath),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  resizeWindow: (height) => ipcRenderer.invoke('resize-window', height),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getPinyinInfo,
  capturePrimaryScreenDataUrl,
  ocrImage: (dataUrl) => ipcRenderer.invoke('ocr-image', dataUrl),
  preloadOcr: () => ipcRenderer.invoke('preload-ocr'),
  copyText: (text) => {
    clipboard.writeText(String(text || ''));
  },
  showSnip: () => ipcRenderer.invoke('show-snip'),
  closeSnip: () => ipcRenderer.invoke('close-snip'),
  convertSnipRect: (rect) => ipcRenderer.invoke('convert-snip-rect', rect),
  onLauncherShow: (callback) => {
    ipcRenderer.removeAllListeners('launcher:show');
    ipcRenderer.on('launcher:show', callback);
  }
});
