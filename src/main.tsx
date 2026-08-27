import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// 主题（亮/暗）与语言（中/英）的 ConfigProvider 配置在 App.tsx 内
// 根据 settings 动态应用（settings.theme / settings.language）。

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);