import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DevToolsRoot from "./devtools/DevToolsRoot";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { hydrateScanCache } from "./gameDirScanCache";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

// 主题（亮/暗）与语言（中/英）的 ConfigProvider 配置：
// 主窗口在 App.tsx 内、开发者工具窗口在 DevToolsRoot 内，均根据 settings 动态应用。

// 开发者工具是独立第二窗口（label === "devtools"），与主窗口共用同一份前端入口，
// 按 label 分流渲染各自的根组件。非 Tauri 环境（纯浏览器调试）下 getCurrentWindow
// 调用会抛错，视为主窗口。
// __DEVTOOLS__ 静态门控：生产构建中该分支被常量折叠，DevToolsRoot 及整个
// DevToolsPanel 模块树被 tree-shake，前端包零 devtool 代码。
function isDevtoolsWindow(): boolean {
  try {
    return getCurrentWindow().label === "devtools";
  } catch {
    return false;
  }
}

const devtoolsWin = __DEVTOOLS__ && isDevtoolsWindow();

// 游戏目录扫描缓存是**落盘**的：先把磁盘那一份读进内存，之后 getScanCache 才能
// 同步命中（否则重启后的第一次点击仍然会重扫）。不 await —— 读盘是异步的，
// 但用户点目录之前它早就绪了；万一没赶上，最坏也就是这次重扫，不会出错。
// 开发者工具窗口不碰游戏目录，省掉这次读盘与 IPC。
if (!devtoolsWin) void hydrateScanCache();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {devtoolsWin ? <DevToolsRoot /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
