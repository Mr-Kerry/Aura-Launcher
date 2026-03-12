const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

let appList = [];
let mainWindow = null;
let tray = null;
let scanPromise = null;
let isScanning = false;
let iconCache = new Map();
let iconCacheLoaded = false;
let iconCacheSaveTimer = null;
const WINDOW_WIDTH = 560;
const MIN_WINDOW_HEIGHT = 110;
const MAX_WINDOW_HEIGHT = 520;

const DEFAULT_CONFIG = {
  autoLaunch: false,
  shortcut: 'Alt+Space',
  refreshCooldown:2
};

let currentConfig = null;
let currentShortcut = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}


function getIconCachePath() {
  return path.join(app.getPath('userData'), 'icon-cache.json');
}

function loadIconCache() {
  if (iconCacheLoaded) return;
  iconCacheLoaded = true;

  const cachePath = getIconCachePath();
  if (!fs.existsSync(cachePath)) return;

  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') {
      iconCache = new Map(Object.entries(parsed));
    }
  } catch (error) {
    console.error('读取图标缓存失败:', error);
  }
}

function scheduleSaveIconCache() {
  if (iconCacheSaveTimer) return;
  iconCacheSaveTimer = setTimeout(() => {
    iconCacheSaveTimer = null;
    try {
      const cachePath = getIconCachePath();
      const data = Object.fromEntries(iconCache.entries());
      fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8');
    } catch (error) {
      console.error('保存图标缓存失败:', error);
    }
  }, 500);
}

function getCachedIcon(id) {
  if (!id) return '';
  return iconCache.get(id) || '';
}

function setCachedIcon(id, iconData) {
  if (!id || !iconData) return;
  if (iconCache.get(id) === iconData) return;
  iconCache.set(id, iconData);
  scheduleSaveIconCache();
}
function readConfig() {
  const configPath = getConfigPath();

  try {
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      return { ...DEFAULT_CONFIG };
    }

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      ...DEFAULT_CONFIG,
      ...parsed
    };
  } catch (error) {
    console.error('读取配置失败:', error);
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(partialConfig = {}) {
  const configPath = getConfigPath();
  const nextConfig = {
    ...readConfig(),
    ...partialConfig
  };

  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), 'utf8');
  return nextConfig;
}

function registerLauncherShortcut(shortcut) {
  const accelerator = String(shortcut || '').trim();

  if (!accelerator) {
    return { success: false, error: '快捷键不能为空' };
  }

  if (currentShortcut) {
    globalShortcut.unregister(currentShortcut);
    currentShortcut = null;
  }

  const ok = globalShortcut.register(accelerator, () => {
    showLauncher();
  });

  if (!ok) {
    return { success: false, error: `快捷键注册失败：${accelerator}` };
  }

  currentShortcut = accelerator;
  return { success: true };
}

function applyConfig(config, platform) {
  if (platform?.applyAutoLaunch) {
    platform.applyAutoLaunch(config, app);
  }
  return registerLauncherShortcut(config.shortcut);
}

function normalizePath(input = '') {
  return String(input)
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '');
}

function normalizeAppList(apps) {
  const result = [];

  for (const item of Array.isArray(apps) ? apps : []) {
    const name = String(item?.name || '').trim();
    const itemPath = normalizePath(item?.path || '');

    if (!name || !itemPath) continue;

    const id = item?.id || `${name.toLowerCase()}__${itemPath.toLowerCase()}`;

    const record = {
      id,
      name,
      path: itemPath,
      icon: item?.icon || '',
      source: item?.source || 'unknown'
    };

    if (Array.isArray(item?.args) && item.args.length > 0) {
      record.args = item.args.slice();
    }

    if (item?.env && typeof item.env === 'object') {
      const keys = Object.keys(item.env);
      if (keys.length > 0) {
        record.env = { ...item.env };
      }
    }

        if (item?.iconRef && typeof item.iconRef === 'object') {
      record.iconRef = { ...item.iconRef };
    }
    result.push(record);
  }

  return result;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('blur', () => {
    setTimeout(() => {
      if (mainWindow && mainWindow.isVisible() && !mainWindow.isFocused()) {
        mainWindow.hide();
      }
    }, 80);
  });

}

function createTray(platform) {
  // 1. 设置托盘图标
  const iconPath = platform?.getTrayIconPath
    ? platform.getTrayIconPath({ path, __dirname })
    : path.join(__dirname, 'icons', 'icon.png');

  let trayIcon;

  if (iconPath && fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    trayIcon = nativeImage.createEmpty();
    trayIcon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(trayIcon);

  // 2. 设置鼠标悬停提示文字
  tray.setToolTip('光晕启动器 (Aura Launcher)');

  // 3. 设置右键菜单
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏搜索框',
      click: () => { showLauncher(); }
    },
    { type: 'separator' }, // 分割线
    {
      label: '退出',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // 4. 左键单击托盘图标时，也显示/隐藏窗口
  tray.on('click', () => {
    showLauncher();
  });
}

function showLauncher() {
  if (!mainWindow) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }

  const [x, y] = mainWindow.getPosition();

  mainWindow.setBounds({
    x,
    y,
    width: WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT
  });

  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('launcher:show');
}

async function scanApplications(platform) {
  if (isScanning && scanPromise) return scanPromise;

  isScanning = true;

  scanPromise = (async () => {
    try {
      const rawApps = await (platform?.scanApplications ? platform.scanApplications() : []);
      appList = normalizeAppList(rawApps);
      if (iconCacheLoaded) {
        appList.forEach((item) => {
          if (!item.icon) {
            const cached = getCachedIcon(item.id);
            if (cached) item.icon = cached;
          }
        });
      }
      console.log(`Scanned ${appList.length} applications`);
      return appList;
    } catch (error) {
      console.error('Application scan failed:', error);
      appList = [];
      return appList;
    } finally {
      isScanning = false;
    }
  })();

  return scanPromise;
}

function findAppByPath(appPath) {
  const normalized = normalizePath(appPath);
  return appList.find((item) => normalizePath(item.path) === normalized);
}

function findAppById(appId) {
  const id = String(appId || '').trim();
  if (!id) return null;
  return appList.find((item) => item.id === id);
}

function resolveTarget(input) {
  if (input && typeof input === 'object' && input.path) {
    return input;
  }
  if (input && typeof input === 'object' && input.id) {
    return findAppById(input.id);
  }
  return findAppByPath(input);
}

async function resolveAppIcon(target, platform) {
  if (!target) return '';
  const cached = getCachedIcon(target.id);
  if (cached) return cached;

  if (!platform?.getAppIcon) return '';

  try {
    const icon = await platform.getAppIcon(target);
    if (icon) {
      setCachedIcon(target.id, icon);
      return icon;
    }
  } catch (error) {
    console.error('获取图标失败:', error);
  }

  return '';
}

async function launchApplication(targetOrPath, platform) {
  const target = resolveTarget(targetOrPath);

  if (!target) {
    return {
      success: false,
      error: '应用不存在或路径未通过校验'
    };
  }

  try {
    if (!platform?.launchApplication) {
      return { success: false, error: 'Unsupported platform' };
    }

    return await platform.launchApplication(target);
  } catch (error) {
    return {
      success: false,
      error: error.message || '启动失败'
    };
  }
}function createApp(platformModule) {
  const platform = platformModule || {};

  app.whenReady().then(async () => {
    createWindow();
    createTray(platform);
    loadIconCache();

    currentConfig = readConfig();
    const applyResult = applyConfig(currentConfig, platform);

    if (!applyResult.success) {
      console.error(applyResult.error);
    }

    if (app.isPackaged && platform?.applyPackagedAutoLaunch) {
      platform.applyPackagedAutoLaunch(app);
    }

            ipcMain.handle('get-settings', async () => {
      currentConfig = readConfig();
      return currentConfig;
    });

    ipcMain.handle('save-settings', async (_event, partialConfig) => {
      try {
        const normalizedConfig = {
          ...partialConfig,
          shortcut: typeof partialConfig.shortcut === 'string'
            ? partialConfig.shortcut.trim()
            : partialConfig.shortcut
        };

        const previousConfig = readConfig();
        const nextConfig = writeConfig(normalizedConfig);

        if (platform?.applyAutoLaunch) {
          platform.applyAutoLaunch(nextConfig, app);
        }

        if (
          typeof normalizedConfig.shortcut === 'string' &&
          normalizedConfig.shortcut !== previousConfig.shortcut
        ) {
          const shortcutResult = registerLauncherShortcut(normalizedConfig.shortcut);

          if (!shortcutResult.success) {
            writeConfig({ shortcut: previousConfig.shortcut });
            registerLauncherShortcut(previousConfig.shortcut);

            return {
              success: false,
              error: shortcutResult.error,
              config: readConfig()
            };
          }
        }

        currentConfig = readConfig();

        return {
          success: true,
          config: currentConfig
        };
      } catch (error) {
        return {
          success: false,
          error: error.message || String(error)
        };
      }
    });

    ipcMain.handle('get-app-list', async () => {
      try {
        await scanApplications(platform);
        return {
          apps: appList,
          scanning: isScanning,
          error: null
        };
      } catch (error) {
        console.error('get-app-list failed:', error);
        return {
          apps: [],
          scanning: false,
          error: error.message || '扫描失败'
        };
      }
    });

    ipcMain.handle('get-app-icons', async (_event, ids) => {
      const list = Array.isArray(ids) ? ids : [];
      const results = [];

      for (const id of list) {
        const appItem = findAppById(id);
        if (!appItem) continue;
        if (appItem.icon) {
          results.push({ id: appItem.id, icon: appItem.icon });
          continue;
        }
        const icon = await resolveAppIcon(appItem, platform);
        if (icon) {
          appItem.icon = icon;
          results.push({ id: appItem.id, icon });
        }
      }

      return results;
    });
    ipcMain.handle('resize-window', async (_event, height) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false };
      }

      const nextHeight = Math.max(
        MIN_WINDOW_HEIGHT,
        Math.min(MAX_WINDOW_HEIGHT, Math.round(Number(height) || MIN_WINDOW_HEIGHT))
      );

      const [currentWidth] = mainWindow.getSize();
      const [x, y] = mainWindow.getPosition();

      mainWindow.setBounds({
        x,
        y,
        width: currentWidth || WINDOW_WIDTH,
        height: nextHeight
      });

      return { success: true, height: nextHeight };
    });

    ipcMain.handle('launch-app', async (_, payload) => {
      return launchApplication(payload, platform);
    });

    ipcMain.handle('hide-window', () => {
      if (mainWindow) {
        mainWindow.hide();
      }
      return { success: true };
    });

    try {
      await scanApplications(platform);
    } catch (error) {
      console.error('Initial scan failed:', error);
    }
  });

  app.on('second-instance', () => {
    if (!mainWindow) return;

    if (!mainWindow.isVisible()) {
      showLauncher();
      return;
    }

    mainWindow.focus();
  });

  app.on('activate', () => {
    if (!mainWindow) {
      createWindow();
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

module.exports = {
  createApp
};







