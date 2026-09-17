import type { ReactNode } from "react";
import {
  AppstoreOutlined,
  CloudServerOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  PictureOutlined,
  SunOutlined,
} from "@ant-design/icons";

/** 内容包类型（模组 / 光影包 / 资源包 / 服务器插件） */
export type PackKind = "mod" | "shader" | "resourcepack" | "plugin";

/**
 * 四类内容包在全局唯一的「图标 + 文案键 + 品牌色」定义。
 *
 * 侧栏导航、内容包卡片类型标签、提示词编辑器、游戏目录筛选按钮都引用这一份，
 * 避免同一类型在不同页面长成不同图标（PromptEditorModal 曾自带一份副本）。
 * 顺序即展示顺序：模组 → 资源包 → 光影包 → 插件。
 */
export const KIND_META: Record<PackKind, { labelKey: string; icon: ReactNode; color: string }> = {
  mod: { labelKey: "app.mod", icon: <AppstoreOutlined />, color: "#4A90D9" },
  shader: { labelKey: "app.shader", icon: <SunOutlined />, color: "#D97706" },
  resourcepack: { labelKey: "app.resourcepack", icon: <PictureOutlined />, color: "#16A34A" },
  plugin: { labelKey: "app.plugin", icon: <CloudServerOutlined />, color: "#7C3AED" },
};

/** 统一展示顺序（避免各处各写一遍字面量数组） */
export const KIND_ORDER: PackKind[] = ["mod", "resourcepack", "shader", "plugin"];

/**
 * 两种工作模式的图标。顶栏分段控件与游戏目录页的「打开游戏目录」按钮
 * 复用同一枚（同一个 ReactNode 实例，保证两处永远一致）。
 */
export const MODE_ICON: Record<"free" | "gamedir", ReactNode> = {
  free: <ImportOutlined />,
  gamedir: <FolderOpenOutlined />,
};
