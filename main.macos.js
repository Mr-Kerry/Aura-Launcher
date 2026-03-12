const { shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

function normalizePath(input = '') {
  return String(input)
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '');
}

function cleanDisplayName(name = '') {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.app$/i, '');
}

function uniqueApps(apps) {
  const map = new Map();

  for (const item of apps) {
    const name = cleanDisplayName(item.name);
    const itemPath = normalizePath(item.path);
    if (!name || !itemPath) continue;

    const key = item.id || `${name.toLowerCase()}__${itemPath.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        name,
        path: itemPath,
        icon: item.icon || '',
        source: item.source || 'unknown'
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function walkApps(rootDirs) {
  const results = [];
  const stack = Array.isArray(rootDirs) ? rootDirs.slice() : [];

  while (stack.length) {
    const dir = stack.pop();
    if (!dir || !fs.existsSync(dir)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) {
          results.push(fullPath);
          continue;
        }
        stack.push(fullPath);
      }
    }
  }

  return results;
}

function findIcnsFile(appPath) {
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  if (!fs.existsSync(resourcesDir)) return '';

  try {
    const files = fs.readdirSync(resourcesDir);
    const icns = files.find((file) => file.toLowerCase().endsWith('.icns'));
    if (icns) {
      return path.join(resourcesDir, icns);
    }
  } catch {
    return '';
  }

  return '';
}

function toDataUrl(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return '';

  try {
    const img = nativeImage.createFromPath(imagePath);
    if (!img || img.isEmpty()) return '';
    return img.toDataURL();
  } catch {
    return '';
  }
}

function buildAppIcon(appPath) {
  const icnsPath = findIcnsFile(appPath);
  if (!icnsPath) return '';
  return toDataUrl(icnsPath);
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function scanByMdfind() {
  const mdfindPath = '/usr/bin/mdfind';
  if (!fs.existsSync(mdfindPath)) return [];

  try {
    const stdout = await execFileAsync(
      mdfindPath,
      ['kMDItemContentType == "com.apple.application-bundle"'],
      { encoding: 'utf8' }
    );

    return String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.app') && fs.existsSync(line))
      .map((appPath) => ({
        name: path.basename(appPath, '.app'),
        path: appPath,
        icon: '',
        source: 'mac-mdfind'
      }));
  } catch {
    return [];
  }
}

function scanByDirectories() {
  const appDirs = [
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications')
  ];

  const appPaths = walkApps(appDirs);

  return appPaths.map((appPath) => ({
    name: path.basename(appPath, '.app'),
    path: appPath,
    icon: '',
    source: 'mac-applications'
  }));
}

async function scanApplications() {
  const [mdfindApps, dirApps] = await Promise.all([
    scanByMdfind(),
    Promise.resolve(scanByDirectories())
  ]);

  return uniqueApps([...mdfindApps, ...dirApps]);
}


async function getAppIcon(target) {
  const appPath = normalizePath(target?.path || '');
  if (!appPath) return '';
  return buildAppIcon(appPath);
}
async function launchApplication(target) {
  const targetPath = normalizePath(target?.path || '');
  if (!targetPath) {
    return { success: false, error: '应用不存在或路径未通过校验' };
  }

  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) {
    return { success: false, error: errorMessage };
  }
  return { success: true };
}

function applyAutoLaunch(config, app) {
  if (!app?.setLoginItemSettings) return;
  app.setLoginItemSettings({
    openAtLogin: !!config.autoLaunch,
    openAsHidden: true
  });
}

function applyPackagedAutoLaunch(app) {
  if (!app?.setLoginItemSettings) return;
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true
  });
}

function getTrayIconPath({ path, __dirname }) {
  return path.join(__dirname, 'icons', 'icon.png');
}

module.exports = {
  getAppIcon,
  applyAutoLaunch,
  applyPackagedAutoLaunch,
  scanApplications,
  launchApplication,
  getTrayIconPath
};

