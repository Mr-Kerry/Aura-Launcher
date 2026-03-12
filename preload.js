const { contextBridge, ipcRenderer } = require('electron');

let pinyinFn = null;

try {
  const pinyinModule = require('pinyin-pro');
  pinyinFn = pinyinModule.pinyin || pinyinModule.default || pinyinModule;
} catch (error) {
  console.error('加载 pinyin-pro 失败:', error);
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
  onLauncherShow: (callback) => {
    ipcRenderer.removeAllListeners('launcher:show');
    ipcRenderer.on('launcher:show', callback);
  }
});