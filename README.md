# Aura-Launcher

Aura Launcher 是一款基于 Electron 的桌面快速启动器，提供应用搜索、全局快捷键唤起、开机自启及列表刷新等能力，适用于 Windows、macOS 与 Linux。

## 功能特性

- 应用搜索：名称、路径、拼音与首字母匹配
- 全局快捷键唤起（默认 `Alt+Space`）
- 开机自启
- 应用列表后台刷新与手动刷新
- 异步图标加载与缓存

## 开发环境

- Node.js（建议 LTS）
- Electron

## 安装依赖

```bash
npm install
```

## 启动

```bash
npm run start
```

## 打包

Windows 安装包（NSIS）：

```bash
npm run build:win
```

Windows 便携版：

```bash
npm run build:portable
```

> macOS/Linux 可通过 `electron-builder` 扩展配置。

## 项目结构

```
.
├─ main.js                # 入口
├─ main.common.js         # 公共主进程逻辑
├─ main.win.js            # Windows 平台逻辑
├─ main.macos.js          # macOS 平台逻辑
├─ main.linux.js          # Linux 平台逻辑
├─ preload.js             # 预加载脚本
├─ index.html             # UI
├─ package.json
└─ icons/                 # 图标资源
```

## 配置

配置文件位于 `app.getPath('userData')`，包含：

- 快捷键
- 开机自启
- 刷新冷却时间（分钟）

## 贡献指南

欢迎提交 Issue 与 PR。建议流程：

1. Fork 并创建特性分支
2. 保持改动聚焦且可复现
3. 提交前自测关键功能（搜索、启动、快捷键）
4. PR 描述中说明动机与影响范围

## 更新日志

- 1.1.0
  - 主进程按平台拆分
  - 应用图标异步加载与缓存
  - 搜索与启动流程优化
