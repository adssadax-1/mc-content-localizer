import { useEffect, useState } from "react";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { listen } from "@tauri-apps/api/event";
import { TranslationProvider, type Language } from "../i18n";
import { DevToolsWindow } from "../components/DevToolsPanel";
import { api } from "../api";
import { darkTheme, lightTheme } from "../App";
import { DEV_SETTINGS_SYNC } from "./bus";

/**
 * 开发者工具第二窗口的根组件（Tauri label === "devtools" 时由 main.tsx 挂载）。
 * 独立 webview 不共享主窗口的 React Context，因此主题/语言在这里单独接线：
 * 挂载时读一次设置，之后监听主窗口广播的 dev-settings-sync 实时联动。
 */
export default function DevToolsRoot() {
  const [themeMode, setThemeMode] = useState<"light" | "dark">("light");
  const [language, setLanguage] = useState<Language>("zh");

  // 初始：读一次设置
  useEffect(() => {
    api
      .loadSettings()
      .then((s) => {
        setThemeMode(s.theme === "dark" ? "dark" : "light");
        setLanguage(s.language === "en" ? "en" : "zh");
      })
      .catch(() => {});
  }, []);

  // 实时联动：主窗口在主题/语言变化时广播 dev-settings-sync
  useEffect(() => {
    const un = listen<{ theme: "light" | "dark"; language: "zh" | "en" }>(
      DEV_SETTINGS_SYNC,
      (e) => {
        setThemeMode(e.payload.theme === "dark" ? "dark" : "light");
        setLanguage(e.payload.language === "en" ? "en" : "zh");
      },
    );
    return () => {
      void un.then((u) => u());
    };
  }, []);

  // 与主窗口一致：主题 CSS 变量挂在 html 根元素（App.css 的 [data-theme="dark"]）
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  return (
    <ConfigProvider theme={themeMode === "dark" ? darkTheme : lightTheme} locale={language === "zh" ? zhCN : enUS}>
      <TranslationProvider language={language}>
        <DevToolsWindow />
      </TranslationProvider>
    </ConfigProvider>
  );
}
