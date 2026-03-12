const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function normalizePath(input = '') {
  return String(input)
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '');
}

function cleanDisplayName(name = '') {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ');
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
        iconRef: item.iconRef,
        source: item.source || 'unknown',
        args: Array.isArray(item.args) ? item.args.slice() : [],
        env: item.env && typeof item.env === 'object' ? { ...item.env } : undefined
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function walkDir(dirPath) {
  const results = [];
  const stack = [dirPath];

  while (stack.length) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function tokenizeExec(value = '') {
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

function stripFieldCodes(token = '') {
  if (!token) return '';
  const cleaned = token.replace(/%[a-zA-Z]/g, '').trim();
  return cleaned;
}

function parseDesktopExec(execLine = '') {
  const tokens = tokenizeExec(String(execLine || '').trim())
    .map(stripFieldCodes)
    .filter((token) => token);

  if (tokens.length === 0) {
    return { command: '', args: [], env: undefined };
  }

  if (tokens[0] === 'env') {
    const env = {};
    let index = 1;

    for (; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token.includes('=')) {
        break;
      }
      const [key, ...rest] = token.split('=');
      if (!key) continue;
      env[key] = rest.join('=');
    }

    const command = tokens[index] || '';
    const args = tokens.slice(index + 1);
    return { command, args, env };
  }

  return {
    command: tokens[0],
    args: tokens.slice(1),
    env: undefined
  };
}

function resolveIconPath(iconName) {
  const raw = String(iconName || '').trim();
  if (!raw) return '';

  if (path.isAbsolute(raw) && fs.existsSync(raw)) {
    return raw;
  }

  const hasExt = /\.(png|svg|xpm)$/i.test(raw);
  const fileNames = hasExt ? [raw] : [`${raw}.png`, `${raw}.svg`, `${raw}.xpm`];

  const iconRoots = [
    path.join(os.homedir(), '.local/share/icons'),
    '/usr/share/icons',
    '/usr/share/pixmaps'
  ];

  const sizes = [
    '256x256',
    '128x128',
    '64x64',
    '48x48',
    '32x32',
    '24x24',
    '16x16',
    'scalable'
  ];

  for (const root of iconRoots) {
    if (!fs.existsSync(root)) continue;

    if (root.endsWith('pixmaps')) {
      for (const fileName of fileNames) {
        const candidate = path.join(root, fileName);
        if (fs.existsSync(candidate)) return candidate;
      }
      continue;
    }

    for (const size of sizes) {
      const base = path.join(root, 'hicolor', size, 'apps');
      for (const fileName of fileNames) {
        const candidate = path.join(base, fileName);
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    for (const fileName of fileNames) {
      const candidate = path.join(root, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
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

function scanApplications() {
  const desktopDirs = [
    '/usr/share/applications',
    path.join(os.homedir(), '.local/share/applications')
  ];

  const result = [];

  for (const desktopDir of desktopDirs) {
    if (!fs.existsSync(desktopDir)) continue;

    const files = walkDir(desktopDir).filter((file) => file.endsWith('.desktop'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');

        if (/NoDisplay=true/i.test(content)) continue;
        if (/Hidden=true/i.test(content)) continue;

        const localizedNameMatch = content.match(/^Name\[zh_CN\]=(.*)$/m);
        const nameMatch = localizedNameMatch || content.match(/^Name=(.*)$/m);
        const execMatch = content.match(/^Exec=(.*)$/m);
        const iconMatch = content.match(/^Icon=(.*)$/m);

        if (!nameMatch || !execMatch) continue;

        const execInfo = parseDesktopExec(execMatch[1]);
        if (!execInfo.command) continue;

        const iconName = iconMatch ? iconMatch[1].trim() : '';

        const name = nameMatch[1].trim();
        const commandDisplay = execInfo.command;
        const args = execInfo.args || [];
        const env = execInfo.env;
        const id = `${name.toLowerCase()}__${commandDisplay.toLowerCase()}__${args.join(' ')}`;

        result.push({
          id,
          name,
          path: commandDisplay,
          args,
          env,
          icon: '',
          iconRef: { iconName },
          source: 'linux-desktop-file'
        });
      } catch {
        // ignore
      }
    }
  }

  return uniqueApps(result);
}


async function getAppIcon(target) {
  const ref = target?.iconRef || {};
  const iconName = String(ref.iconName || '').trim();
  if (!iconName) return '';
  const iconPath = resolveIconPath(iconName);
  return toDataUrl(iconPath);
}
async function launchApplication(target) {
  const command = normalizePath(target?.path || '');
  if (!command) {
    return { success: false, error: '应用不存在或路径未通过校验' };
  }

  const args = Array.isArray(target?.args) ? target.args : [];
  const env = target?.env && typeof target.env === 'object'
    ? { ...process.env, ...target.env }
    : process.env;

  spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    env
  }).unref();

  return { success: true };
}

function getTrayIconPath({ path, __dirname }) {
  return path.join(__dirname, 'icons', 'icon.png');
}

module.exports = {
  getAppIcon,
  scanApplications,
  launchApplication,
  getTrayIconPath
};

