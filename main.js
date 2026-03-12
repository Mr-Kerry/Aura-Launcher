const { createApp } = require('./main.common');

function loadPlatformModule() {
  if (process.platform === 'win32') {
    return require('./main.win');
  }
  if (process.platform === 'darwin') {
    return require('./main.macos');
  }
  if (process.platform === 'linux') {
    return require('./main.linux');
  }

  return require('./main.linux');
}

createApp(loadPlatformModule());
