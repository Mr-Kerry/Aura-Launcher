const { app, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        ...options,
        maxBuffer: 20 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

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
    .replace(/\.lnk$/i, '')
    .replace(/\.url$/i, '');
}

function createLooseMergeKey(name = '') {
  return cleanDisplayName(name)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()\[\]【】（）《》._]/g, '');
}

function isLikelyGarbageText(text = '') {
  const value = String(text || '').trim();
  if (!value) return true;
  if (value.includes('\uFFFD')) return true;

  const controlChars = (value.match(/[\u0000-\u001f\u007f]/g) || []).length;
  if (controlChars > 0) return true;

  const allowedChars = value.match(/[\u4e00-\u9fa5a-zA-Z0-9\s\-_().,&+【】（）《》]/g) || [];
  const disallowedCount = value.length - allowedChars.length;

  if (disallowedCount >= Math.max(2, Math.floor(value.length / 3))) {
    return true;
  }

  const suspiciousRuns =
    value.match(/[^\u4e00-\u9fa5a-zA-Z0-9\s\-_().,&+【】（）《》]{3,}/g) || [];
  if (suspiciousRuns.length > 0) {
    return true;
  }

  return false;
}

function buildStartMenuNameIndex(startMenuApps) {
  const map = new Map();

  for (const item of startMenuApps) {
    const key = createLooseMergeKey(item.name);
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        id: key,
        name: cleanDisplayName(item.name),
        path: item.path,
        icon: item.icon || '',
        iconRef: item.iconRef,
        args: Array.isArray(item.args) ? item.args.slice() : [],
        source: 'windows-startmenu'
      });
    }
  }

  return map;
}

function mergeWindowsAppsPreferStartMenu(registryApps, startMenuApps) {
  const startMenuMap = buildStartMenuNameIndex(startMenuApps);
  const merged = new Map(startMenuMap);

  for (const regItem of registryApps) {
    const regName = cleanDisplayName(regItem.name);
    const regKey = createLooseMergeKey(regName);
    if (!regKey) continue;

    const existing = merged.get(regKey);

    if (existing) {
      const next = { ...existing };
      if (!next.path) next.path = regItem.path;
      if (!next.icon && regItem.icon) next.icon = regItem.icon;
      if (!next.iconRef && regItem.iconRef) next.iconRef = regItem.iconRef;
      if (!next.source) next.source = 'windows-startmenu';
      merged.set(regKey, next);
      continue;
    }

    if (!isLikelyGarbageText(regName)) {
      merged.set(regKey, {
        id: regKey,
        name: regName,
        path: regItem.path,
        icon: regItem.icon || '',
        iconRef: regItem.iconRef,
        source: regItem.source || 'windows-registry'
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function chunkArray(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function parseIconLocation(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const commaIndex = value.indexOf(',');
  const part = commaIndex >= 0 ? value.slice(0, commaIndex) : value;
  return normalizePath(part);
}

function toDataUrlFromIconPath(iconPath) {
  const candidate = normalizePath(iconPath);
  if (!candidate || !fs.existsSync(candidate)) return '';

  try {
    const img = nativeImage.createFromPath(candidate);
    if (!img || img.isEmpty()) return '';
    return img.toDataURL();
  } catch {
    return '';
  }
}

function hasIconIndex(raw) {
  return String(raw || '').includes(',');
}

async function getFileIconData(filePath) {
  const candidate = normalizePath(filePath);
  if (!candidate || !fs.existsSync(candidate)) return '';

  try {
    const img = await app.getFileIcon(candidate, { size: 'normal' });
    if (!img || img.isEmpty()) return '';
    return img.toDataURL();
  } catch {
    return '';
  }
}

async function getAppIcon(target) {
  const ref = target?.iconRef || {};
  const iconPath = normalizePath(ref.iconPath || '');
  const fallbackPath = normalizePath(ref.fallbackPath || target?.path || '');

  let iconData = toDataUrlFromIconPath(iconPath);
  if (!iconData && fallbackPath) {
    iconData = await getFileIconData(fallbackPath);
  }

  return iconData;
}

function tokenizeArgs(value = '') {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (char === '\\') {
      const next = value[i + 1];
      if (next) {
        current += next;
        i += 1;
        continue;
      }
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

async function resolveShortcutDetails(shortcutPaths) {
  const result = new Map();
  const chunks = chunkArray(shortcutPaths, 200);

  for (const chunk of chunks) {
    const psPaths = chunk
      .map((p) => `'${String(p).replace(/'/g, "''")}'`)
      .join(',');

    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(${psPaths})
$shell = New-Object -ComObject WScript.Shell
$result = foreach ($p in $paths) {
  if (Test-Path $p) {
    $sc = $shell.CreateShortcut($p)
    [PSCustomObject]@{
      Path = $p
      TargetPath = $sc.TargetPath
      Arguments = $sc.Arguments
      IconLocation = $sc.IconLocation
    }
  }
}
$result | ConvertTo-Json -Depth 3 -Compress
`;

    try {
      const stdout = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { encoding: 'utf8' }
      );

      const parsed = JSON.parse(stdout || '[]');
      const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

      for (const item of items) {
        if (!item?.Path) continue;
        result.set(String(item.Path), {
          targetPath: item.TargetPath || '',
          arguments: item.Arguments || '',
          iconLocation: item.IconLocation || ''
        });
      }
    } catch {
      // ignore
    }
  }

  return result;
}

function extractExeFromCommand(command = '') {
  const value = normalizePath(command);
  if (!value) return '';

  const quotedMatch = value.match(/^"([^"]+\.exe)"/i);
  if (quotedMatch) return normalizePath(quotedMatch[1]);

  const exeMatch = value.match(/^(.+?\.exe)\b/i);
  if (exeMatch) return normalizePath(exeMatch[1]);

  return '';
}

function pickExeFromInstallLocation(installLocation = '') {
  const location = normalizePath(installLocation);
  if (!location || !fs.existsSync(location)) return '';

  try {
    const exeFiles = fs
      .readdirSync(location)
      .filter((file) => file.toLowerCase().endsWith('.exe'))
      .map((file) => path.join(location, file));

    return exeFiles[0] || '';
  } catch {
    return '';
  }
}

function walkDir(dirPath) {
  const results = [];

  if (!fs.existsSync(dirPath)) return results;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore
  }

  return results;
}

function shouldIgnoreShortcut(fileName = '') {
  const name = String(fileName).toLowerCase();

  const ignoredKeywords = [
    '卸载',
    'uninstall',
    '帮助',
    'help',
    '更新',
    'update',
    'website',
    'readme',
    'license',
    'repair',
    'documentation',
    'changelog'
  ];

  return ignoredKeywords.some((keyword) => name.includes(keyword));
}

function parseInternetShortcut(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const urlMatch = content.match(/^URL=(.*)$/m);
    const iconMatch = content.match(/^IconFile=(.*)$/m);

    return {
      url: urlMatch ? urlMatch[1].trim() : '',
      iconFile: iconMatch ? iconMatch[1].trim() : ''
    };
  } catch {
    return { url: '', iconFile: '' };
  }
}

async function scanWindowsStartMenuShortcuts() {
  const startMenuDirs = [
    path.join(
      process.env.ProgramData || 'C:\\ProgramData',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    ),
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    )
  ];

  const lnkFiles = [];
  const urlFiles = [];

  for (const dir of startMenuDirs) {
    const files = walkDir(dir);

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.lnk' && ext !== '.url') continue;

      const baseName = path.basename(file, ext).trim();
      if (!baseName) continue;
      if (shouldIgnoreShortcut(baseName)) continue;

      if (ext === '.lnk') {
        lnkFiles.push(file);
      } else {
        urlFiles.push(file);
      }
    }
  }

  const results = [];
  const shortcutDetails = await resolveShortcutDetails(lnkFiles);

  for (const file of lnkFiles) {
    const detail = shortcutDetails.get(file) || {};
    const targetPath = normalizePath(detail.targetPath || '');
    const args = tokenizeArgs(String(detail.arguments || '').trim());
    const iconLocation = detail.iconLocation || '';
    const iconPath = hasIconIndex(iconLocation) ? '' : parseIconLocation(iconLocation);
    const fallbackPath = targetPath || file;
    const iconRef = { iconPath, fallbackPath };

    const baseName = path.basename(file, path.extname(file)).trim();

    results.push({
      name: cleanDisplayName(baseName),
      path: targetPath || file,
      args,
      icon: '',
      iconRef,
      source: 'windows-startmenu'
    });
  }

  for (const file of urlFiles) {
    const baseName = path.basename(file, path.extname(file)).trim();
    const info = parseInternetShortcut(file);
    const iconPath = info.iconFile ? normalizePath(info.iconFile) : '';
    const iconRef = { iconPath, fallbackPath: file };

    results.push({
      name: cleanDisplayName(baseName),
      path: file,
      icon: '',
      iconRef,
      source: 'windows-startmenu-url'
    });
  }

  return results;
}

async function scanWindowsRegistryApplications() {
  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)

$result = foreach ($p in $paths) {
  Get-ItemProperty -Path $p -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName } |
    Select-Object DisplayName, DisplayIcon, InstallLocation, UninstallString, QuietUninstallString
}

$result | ConvertTo-Json -Depth 3 -Compress
`;

  try {
    const stdout = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { encoding: 'utf8' }
    );

    let items = [];
    try {
      const parsed = JSON.parse(stdout || '[]');
      items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    } catch (error) {
      console.error('PowerShell JSON parse failed:', error);
      return [];
    }

    const normalized = await Promise.all(items.map(async (item) => {
      let exePath =
        extractExeFromCommand(item.DisplayIcon) ||
        extractExeFromCommand(item.QuietUninstallString) ||
        extractExeFromCommand(item.UninstallString) ||
        pickExeFromInstallLocation(item.InstallLocation);

      exePath = normalizePath(exePath);

      if (!item.DisplayName || !exePath) {
        return null;
      }

      const iconLocation = item.DisplayIcon || '';
      const iconPath = hasIconIndex(iconLocation) ? '' : parseIconLocation(iconLocation);
      const iconRef = { iconPath, fallbackPath: exePath };

      return {
        name: String(item.DisplayName).trim(),
        path: exePath,
        icon: '',
        iconRef,
        source: 'windows-registry'
      };
    }));

    return normalized.filter(Boolean);
  } catch (error) {
    console.error('Windows registry scan failed:', error);
    return [];
  }
}

async function scanApplications() {
  const [startMenuApps, registryApps] = await Promise.all([
    scanWindowsStartMenuShortcuts(),
    scanWindowsRegistryApplications()
  ]);

  return mergeWindowsAppsPreferStartMenu(registryApps, startMenuApps);
}

async function launchApplication(target) {
  const targetPath = normalizePath(target?.path || '');
  if (!targetPath) {
    return { success: false, error: '应用不存在或路径未通过校验' };
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(targetPath)) {
    await shell.openExternal(targetPath);
    return { success: true };
  }

  const ext = path.extname(targetPath).toLowerCase();

  if (ext === '.lnk' || ext === '.url') {
    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) {
      return { success: false, error: errorMessage };
    }
    return { success: true };
  }

  const args = Array.isArray(target?.args) ? target.args : [];

  spawn(targetPath, args, {
    detached: true,
    stdio: 'ignore',
    shell: false
  }).unref();

  return { success: true };
}

async function captureScreen() {
  const tempPath = path.join(os.tmpdir(), 'aura_capture_' + Date.now() + '.png');
  const safePath = tempPath.replace(/'/g, "''");
  const psScript = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$path = \'' + safePath + '\'',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$graphics.Dispose()',
    '$bitmap.Dispose()'
  ].join('\n');

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { encoding: 'utf8' }
    );

    const buffer = fs.readFileSync(tempPath);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }

    const dataUrl = 'data:image/png;base64,' + buffer.toString('base64');
    return { success: true, dataUrl };
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore
    }

    return { success: false, error: error.message || String(error) };
  }
}
function applyAutoLaunch(config, appInstance) {
  if (!appInstance?.setLoginItemSettings) return;
  appInstance.setLoginItemSettings({
    openAtLogin: !!config.autoLaunch,
    openAsHidden: true
  });
}

function applyPackagedAutoLaunch(appInstance) {
  if (!appInstance?.setLoginItemSettings) return;
  appInstance.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true
  });
}

function getTrayIconPath({ path: pathModule, __dirname }) {
  return pathModule.join(__dirname, 'icons', 'icon.png');
}

module.exports = {
  captureScreen,
  getAppIcon,
  applyAutoLaunch,
  applyPackagedAutoLaunch,
  scanApplications,
  launchApplication,
  getTrayIconPath
};







