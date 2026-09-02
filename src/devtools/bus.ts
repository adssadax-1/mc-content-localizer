// devtools 跨窗口通信的事件契约（仅 __DEVTOOLS__ 构建使用，生产构建 tree-shake）。
// 开发者工具第二窗口与主窗口是两个独立 JS 实例，模块级对象不共享，
// 所有联动一律走 Tauri 事件广播（core:event 权限见 capabilities/devtools.json）。

export type DevResultKind = "ok" | "empty" | "warn" | "error" | "error429" | "cancel";

/** 主窗口监听：弹出真实结果 Alert（buildResultAlert 渲染路径） */
export const DEV_SHOW_RESULT_ALERT = "dev-show-result-alert";
/** 主窗口监听：用软件自身格式弹出导出失败提示 */
export const DEV_SHOW_EXPORT_ERROR = "dev-show-export-error";
/** 主窗口广播：主题/语言变化（DevToolsRoot 监听，实时联动） */
export const DEV_SETTINGS_SYNC = "dev-settings-sync";
/** 主窗口广播：invoke 日志（DevToolsWindow 监听入队） */
export const DEV_INVOKE_LOG = "dev-invoke-log";
/** 工具窗口广播：网络故障应用/清除（主窗口监听，弹提示 + 显示生效中标签） */
export const DEV_FAULT_CHANGED = "dev-fault-changed";

/** 网络故障状态（主窗口提示与常驻标签用） */
export interface DevFaultNotice {
  active: boolean;
  /** 已按工具窗口当前语言拼好的故障摘要，主窗口直接展示 */
  summary: string;
}
