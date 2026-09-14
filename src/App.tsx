import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  ConfigProvider,
  Drawer,
  Dropdown,
  InputNumber,
  Layout,
  Segmented,
  message,
  Modal,
  notification,
  Popover,
  Progress,
  Radio,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import {
  CloudUploadOutlined,
  ClearOutlined,
  DeleteOutlined,
  DownOutlined,
  ExportOutlined,
  AppstoreOutlined,
  GithubOutlined,
  PauseOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  RightOutlined,
  SaveOutlined,
  SettingOutlined,
  StopOutlined,
  SunOutlined,
  ThunderboltOutlined,
  ToolOutlined, CloudServerOutlined } from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";

import { api as rawApi, createDevApi, onFileDropped, onGlossaryDone, onTranslateProgress, onTranslationBatch } from "./api";
import { DropZone } from "./components/DropZone";
import { SlideNav } from "./components/SlideNav";
import { GameDirView } from "./components/GameDirView";
import { EntryTable } from "./components/EntryTable";
import { ContextPanel } from "./components/ContextPanel";
import { SettingsModal } from "./components/SettingsModal";
import { DeepScanRulesModal } from "./components/DeepScanRulesModal";
import { DeepScanIcon } from "./components/DeepScanIcon";
import { pushInvoke } from "./components/DevToolsPanel";
import { type DevResultKind, DEV_SHOW_RESULT_ALERT, DEV_SHOW_EXPORT_ERROR, DEV_SETTINGS_SYNC, DEV_FAULT_CHANGED, type DevFaultNotice } from "./devtools/bus";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { TranslationProvider, useTranslation, useTranslationContext } from "./i18n";
import { LOADER_LABEL, packFormatForMc } from "./types";

// devApi 代理：__DEVTOOLS__ 时包装 api，每次 invoke 记录到 ring buffer；生产构建直接用原 api。
const api = __DEVTOOLS__ ? createDevApi(rawApi, pushInvoke) : rawApi;
import type {
  BatchItem,
  LangEntry,
  LangFormat,
  ModFile,
  PluginFile,
  DeepScanOverride,
  DeepScanRules,
  ProgressPayload,
  ResourcePackBundle,
  Settings,
  TranslateContext,
  TranslatedItem,
} from "./types";

const { Header, Content, Footer, Sider } = Layout;

// 亮色主题配置
export const lightTheme = {
  token: {
    colorPrimary: "#4A90D9",
    colorBgLayout: "#F5F6F8",
    colorBgContainer: "#FFFFFF",
    colorText: "#1F2937",
    colorTextSecondary: "#6B7280",
    colorBorder: "#E6E8EB",
    colorBorderSecondary: "#EFF1F4",
    colorSuccess: "#16A34A",
    colorWarning: "#D97706",
    colorError: "#DC2626",
    borderRadius: 10,
    fontSize: 13,
  },
  components: {
    Layout: {
      headerBg: "#FFFFFF",
      siderBg: "#FFFFFF",
      bodyBg: "#F5F6F8",
      footerBg: "#FFFFFF",
    },
    Table: {
      headerBg: "#F9FAFB",
      headerColor: "#4B5563",
      borderColor: "#F0F2F5",
    },
    Card: {
      colorBorderSecondary: "#E6E8EB",
    },
  },
};

// 暗色主题配置（优化颜值）
export const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#6CB3FF",
    colorBgLayout: "#141414",
    colorBgContainer: "#1F1F1F",
    colorText: "#E5E7EB",
    colorTextSecondary: "#9CA3AF",
    colorBorder: "#303030",
    colorBorderSecondary: "#262626",
    colorSuccess: "#22C55E",
    colorWarning: "#FBBF24",
    colorError: "#EF4444",
    borderRadius: 10,
    fontSize: 13,
  },
  components: {
    Layout: {
      headerBg: "#1F1F1F",
      siderBg: "#1F1F1F",
      bodyBg: "#141414",
      footerBg: "#1F1F1F",
    },
    Table: {
      headerBg: "#1F2937",
      headerColor: "#D1D5DB",
      borderColor: "#374151",
    },
    Card: {
      colorBorderSecondary: "#262626",
    },
  },
};

/** 项目 GitHub 地址 */
const GITHUB_URL = "https://github.com/adssadax-1/mc-content-localizer";

/** 打开 GitHub 项目页 */
function openGithub() {
  void openUrl(GITHUB_URL);
}

/** dialog 返回的目录路径可能是 string / string[] / null，统一为 string | null */
function asDir(dir: string | string[] | null): string | null {
  if (!dir) return null;
  return Array.isArray(dir) ? dir[0] : dir;
}

/** 插件导出条目：把条目键（file_path#key_path）拆成导出所需的两段 */
function pluginItems(entries: LangEntry[]): { filePath: string; keyPath: string; translation: string }[] {
  return entries.map((e) => ({
    filePath: e.filePath,
    keyPath: e.key.startsWith(e.filePath + "#") ? e.key.slice(e.filePath.length + 1) : e.key,
    translation: e.translation ?? "",
  }));
}

/** Windows 文件名非法字符清洗（* ? : < > | / \ "）→ _，并截断超过 100 字符。
 *  防止 modid / 文件名含非法字符时导出触发 os error 123（文件名语法不正确）。 */
function sanitizeFileName(s: string): string {
  return s.replace(/[*?:<>|\\/"]/g, "_").slice(0, 100);
}

/** 导出命名偏好 → 基准名与后缀。
 *  raw：原名（无后缀）；suffix：源文件名 + _zh_cn（jar/插件）/ _zh_CN（光影/资源包）；
 *  ai：AI 中文名 + _汉化（未生成则回退源文件名，并标记 fallback 供导出提示） */
function exportNameFor(
  it: PackItem,
  naming: "raw" | "suffix" | "ai",
  aiNames: Record<string, string>,
): { base: string; suffix: string; fallback: boolean } {
  // 源文件主名（模组不再用 modid；插件也只改文件名、不动 plugin.yml 的 name）
  const stem = sanitizeFileName(it.fileName.replace(/\.(zip|jar)$/i, ""));
  if (naming === "ai") {
    const ai = aiNames[aiKeyOf(it)];
    if (ai && ai.trim()) return { base: sanitizeFileName(ai.trim()), suffix: "_汉化", fallback: false };
    return { base: stem, suffix: "_zh_cn", fallback: true };
  }
  if (naming === "raw") return { base: stem, suffix: "", fallback: false };
  const isJar = it.kind === "mod" || it.kind === "plugin";
  return { base: stem, suffix: isJar ? "_zh_cn" : "_zh_CN", fallback: false };
}

/** AI 名称缓存键：文件名 + 大小（大小缺失时用路径兜底，避免同名不同包互相命中） */
function aiKeyOf(it: PackItem): string {
  return `${it.fileName}|${it.size ?? it.sourcePath}`;
}

/** 目标文件若已存在则自动加序号，避免覆盖既有产物 */
async function uniqueDest(dir: string, base: string, suffix: string, ext: string): Promise<string> {
  let name = `${base}${suffix}${ext}`;
  let i = 0;
  while (await api.pathExists(`${dir}/${name}`)) {
    i += 1;
    name = `${base}${suffix}_${i}${ext}`;
    if (i >= 50) break;
  }
  return `${dir}/${name}`;
}

/** 内置规则布尔字段清单（摘要与差异计算共用） */
const DEEP_RULE_KEYS = [
  "scopeJson", "scopeLang", "scopeText", "scopeNested", "scopeClass",
  "skipMeta", "skipLangfiles", "skipLibs", "onlySourceLocale", "keepCjk",
  "dropSql", "dropDescriptor", "dropLog", "dropIdent", "classNeedsMarker",
] as const;

/** 与全局规则相比的差异（单包覆盖只存差异，避免缓存膨胀） */
function diffDeepRules(base: DeepScanRules, next: DeepScanRules): Partial<DeepScanRules> {
  const out: Partial<DeepScanRules> = {};
  for (const k of DEEP_RULE_KEYS) {
    if (base[k] !== next[k]) (out as Record<string, boolean>)[k] = next[k];
  }
  return out;
}

/** 某内容包实际生效的深度扫描规则：全局规则（按类型）+ 单包覆盖 */
function effectiveDeepRules(item: PackItem, settings: Settings | null): DeepScanRules | null {
  const base =
    item.kind === "plugin" ? settings?.deepScanRules?.plugin : settings?.deepScanRules?.mod;
  if (!base) return null;
  const merged: DeepScanRules = { ...base, ...(item.deepScanOverride?.rules ?? {}) };
  const enabled = item.deepScanOverride?.customEnabled;
  if (enabled) {
    merged.custom = merged.custom.map((r) => ({ ...r, enabled: enabled[r.id] ?? r.enabled }));
  }
  return merged;
}

/** 内容包类型 */
type PackKind = "mod" | "shader" | "resourcepack" | "plugin";

/** 自由导入：单次导入超过该数量时，卡片默认收缩（展开会为每包挂载表格，数量大时卡顿） */
const AUTO_EXPAND_MAX = 10;
/** 自由导入：每解析这么多个包向队列批量提交一次（避免逐包 setQueue 造成 O(n²) 重渲染） */
const IMPORT_FLUSH_CHUNK = 10;
/** 内容包列表分页步长：上千个内容包时只挂载视口附近这些卡片，滚动到底自动续加载 */
const PACK_RENDER_STEP = 50;

/**
 * 术语表建议：收集出现 ≥3 次且已翻译的英文短语（未在现有术语表中）
 */
function collectSuggestions(
  entries: LangEntry[],
  existing: [string, string][],
): [string, string][] {
  const count = new Map<string, number>();
  const zh = new Map<string, string>();
  for (const e of entries) {
    const src = e.source?.trim() ?? "";
    const tr = e.translation?.trim() ?? "";
    if (!src || !tr || src.length < 3 || src.length > 60 || !/[a-zA-Z]/.test(src)) {
      continue;
    }
    count.set(src, (count.get(src) ?? 0) + 1);
    if (!zh.has(src)) zh.set(src, tr);
  }
  const skip = new Set(existing.map(([en]) => en.toLowerCase()));
  const out: [string, string][] = [];
  for (const [src, c] of count) {
    if (c >= 3 && !skip.has(src.toLowerCase()) && zh.get(src)) {
      out.push([src, zh.get(src)!]);
    }
  }
  out.sort((a, b) => (count.get(b[0]) ?? 0) - (count.get(a[0]) ?? 0));
  return out.slice(0, 20);
}

/** 由后端返回的单条结果推导前端条目补丁（与实时事件保持一致的状态着色） */
function entryPatchFromResult(r: TranslatedItem): {
  translation: string | null;
  notes: string[];
  status: LangEntry["status"];
  translating: boolean;
} {
  const status: LangEntry["status"] = !r.translation
    ? r.notes[0]?.startsWith("翻译失败")
      ? "aiFailed"
      : "aiEmpty"
    : "aiTranslated";
  return { translation: r.translation || null, notes: r.notes, status, translating: false };
}

/** 根据实时统计构造翻译结果汇总提示（醒目、可操作的解决建议） */
type CountValue = number | "XX";

function buildResultAlert(
  c: {
    ok: CountValue;
    empty: CountValue;
    error: CountValue;
    error429: CountValue;
    warn: CountValue;
  },
  t: (p: string, v?: Record<string, string | number>) => string,
): { type: "success" | "warning" | "error" | "info"; title: string; desc: React.ReactNode } {
  // "XX" 用于 devtools 弹窗模拟：视为非零，展示为 XX
  const has = (v: CountValue) => v === "XX" || v > 0;
  const lines: string[] = [];
  if (has(c.empty)) {
    lines.push(t("app.alertEmpty", { empty: c.empty }));
  }
  if (has(c.error)) {
    if (has(c.error429)) {
      lines.push(t("app.alertError429", { error: c.error }));
    } else {
      lines.push(t("app.alertErrorOther", { error: c.error }));
    }
  }
  if (has(c.warn)) {
    lines.push(
      `有 ${c.warn} 条译文含占位符/格式校验警告（橙色标签），导出前请检查 %s、§ 等是否完整，避免游戏内显示异常。`,
    );
  }
  if (has(c.ok) && lines.length === 0) {
    return {
      type: "success",
      title: `翻译完成：成功汉化 ${c.ok} 条`,
      desc: "可勾选后导出汉化结果。",
    };
  }
  if (lines.length === 0) {
    return { type: "info", title: "翻译完成", desc: "本次没有产生新的译文。" };
  }
  const type: "success" | "warning" | "error" = has(c.error) ? "error" : "warning";
  const title =
    has(c.error)
      ? `翻译完成（${c.ok} 条成功，${c.error} 条失败）`
      : `翻译完成（${c.ok} 条成功，${c.empty} 条未返回）`;
  return {
    type,
    title,
    desc: <div>{lines.map((l, i) => <div key={i} style={{ marginBottom: 4 }}>{l}</div>)}</div>,
  };
}

const KIND_META: Record<PackKind, { labelKey: string; icon: React.ReactNode; color: string }> = {
  mod: { labelKey: "app.mod", icon: <AppstoreOutlined />, color: "#4A90D9" },
  shader: { labelKey: "app.shader", icon: <SunOutlined />, color: "#D97706" },
  resourcepack: { labelKey: "app.resourcepack", icon: <PictureOutlined />, color: "#16A34A" },
  plugin: { labelKey: "app.plugin", icon: <CloudServerOutlined />, color: "#7C3AED" },
};

/** 右上角全局结果卡片：底部 2s 读条后自动收起，右上角 × 可手动关闭 */
function showResultCard(
  type: "success" | "warning" | "error" | "info",
  title: string,
  desc: React.ReactNode,
) {
  const fn =
    type === "success" ? notification.success
    : type === "error" ? notification.error
    : type === "warning" ? notification.warning
    : notification.info;
  fn({
    message: title,
    description: (
      <>
        {desc}
        <div className="dev-card-progress">
          <div />
        </div>
      </>
    ),
    placement: "topRight",
    duration: 2,
  });
}

interface PackCardProps {
  item: PackItem;
  translating: boolean;
  /** 本包是否正在翻译（并行时区分各包） */
  thisTranslating?: boolean;
  /** 本包实时进度（并行时卡片内显示） */
  packProgress?: { done: number; total: number };
  onToggleExpanded: (key: string) => void;
  onToggleChecked: (key: string, v: boolean) => void;
  onEdit: (packKey: string, entryKey: string, value: string) => void;
  onSelect: (key: string) => void;
  onClear: (packKey: string, entryKey: string) => void;
  onToggleSelected: (packKey: string, entryKey: string, selected: boolean) => void;
  onToggleAllSelected: (packKey: string, selected: boolean) => void;
  onToggleManySelected: (packKey: string, keys: string[], selected: boolean) => void;
  onResize: (key: string, e: React.MouseEvent) => void;
  /** 手动深度扫描 */
  onDeepScan?: (key: string) => void;
  /** 切换深度扫描分组勾选 */
  onToggleDeepGroup?: (packKey: string, label: string, checked: boolean) => void;
  /** 正在深度扫描的卡片 key */
  deepScanningKey?: string | null;
  /** 该包当前生效的深度扫描规则摘要（悬停提示用） */
  deepScanSummary?: string;
  /** 打开该包的深度扫描规则配置（齿轮） */
  onOpenDeepRules?: (key: string) => void;
}

/** 单个内容包卡片（memo 化：只有自己的数据/回调变化才重渲染） */
const PackCard = memo(function PackCard({
  item,
  translating,
  thisTranslating,
  packProgress,
  onToggleExpanded,
  onToggleChecked,
  onEdit,
  onSelect,
  onClear,
  onToggleSelected,
  onToggleAllSelected,
  onToggleManySelected,
  onResize,
  onDeepScan,
  onToggleDeepGroup,
  deepScanningKey,
  deepScanSummary,
  onOpenDeepRules,
}: PackCardProps) {
  const { t } = useTranslationContext();
  const total = item.entries.length;
  // 卡内 O(M) 统计缓存：仅条目数组变化时重算（避免每次渲染都遍历）
  const translated = useMemo(
    () => item.entries.reduce((n, e) => n + (e.translation ? 1 : 0), 0),
    [item.entries],
  );
  const deepCount = useMemo(
    () => (item.deepScanGroups ?? []).reduce((a, g) => a + g.count, 0),
    [item.deepScanGroups],
  );
  const meta = KIND_META[item.kind];
  // 绑定本包 key 的稳定回调：EntryTable 是 memo 组件，回调身份必须稳定
  const packKey = item.key;
  const hEdit = useCallback((k: string, v: string) => onEdit(packKey, k, v), [packKey, onEdit]);
  const hClear = useCallback((k: string) => onClear(packKey, k), [packKey, onClear]);
  const hSel = useCallback(
    (k: string, s: boolean) => onToggleSelected(packKey, k, s),
    [packKey, onToggleSelected],
  );
  const hSelAll = useCallback(
    (s: boolean) => onToggleAllSelected(packKey, s),
    [packKey, onToggleAllSelected],
  );
  const hSelMany = useCallback(
    (keys: string[], s: boolean) => onToggleManySelected(packKey, keys, s),
    [packKey, onToggleManySelected],
  );
  return (
    <div
      className={item.expanded ? "pack-card" : "pack-card pack-card-collapsed"}
      style={{
        border: "1px solid var(--border-color, #E6E8EB)",
        borderRadius: 12,
        marginBottom: 8,
        background: "var(--card-bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          cursor: "pointer",
          flexWrap: "wrap",
        }}
        onClick={() => onToggleExpanded(item.key)}
      >
        <Checkbox
          checked={item.checked}
          disabled={translating}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleChecked(item.key, e.target.checked)}
        />
        {item.expanded ? <DownOutlined /> : <RightOutlined />}
        <span style={{ color: meta.color }}>{meta.icon}</span>
        <Typography.Text strong>{item.name}</Typography.Text>
        <Tag color={meta.color}>{t(meta.labelKey)}</Tag>
        {item.modFile?.version && <Tag>{item.modFile.version}</Tag>}
        {item.modFile && <Tag>{item.modFile.loader === "unknown" ? t("loader.unknown") : item.modFile.loader.toUpperCase()}</Tag>}
        {item.hasZh && (
          <Tag color="cyan">{t("app.hasZh")} {item.zhCount ?? 0} {t("app.hasZhCount")}</Tag>
        )}
        {item.gameVersion && (
          <Tag color="geekblue">§ {item.gameVersion}</Tag>
        )}
        {thisTranslating && (
          <Tag color="processing" className="dev-pulse-tag">
            {t("components.translating")}
            {packProgress ? ` ${packProgress.done}/${packProgress.total}` : ""}
          </Tag>
        )}
        <Typography.Text type="secondary" style={{ marginLeft: "auto" }}>
          {translated}/{total} {t("app.translatedCount")}
        </Typography.Text>
        {(item.kind === "mod" || item.kind === "plugin") && onDeepScan && (
          <Popover
            trigger="hover"
            title={
              <Space size={6}>
                <span>{t(item.kind === "plugin" ? "app.deepScanPlugin" : "app.deepScan")}</span>
                {onOpenDeepRules && (
                  <Tooltip title={t("app.deepScanOpenRules")}>
                    <Button
                      size="small"
                      type="text"
                      icon={<SettingOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenDeepRules(item.key);
                      }}
                    />
                  </Tooltip>
                )}
              </Space>
            }
            content={
              <div style={{ maxWidth: 300, fontSize: 12 }}>
                <div>{deepScanSummary ?? t("app.deepScanDesc")}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {t("app.deepScanPopoverHint")}
                </Typography.Text>
              </div>
            }
          >
            <Button
              size="small"
              icon={<DeepScanIcon size={13} />}
              type={item.deepScanGroups ? "default" : "dashed"}
              loading={deepScanningKey === item.key}
              onClick={(e) => {
                e.stopPropagation();
                onDeepScan(item.key);
              }}
            >
              {item.deepScanGroups
                ? `${t(item.kind === "plugin" ? "app.deepScanPlugin" : "app.deepScan")} ${deepCount}`
                : t(item.kind === "plugin" ? "app.deepScanPlugin" : "app.deepScan")}
            </Button>
          </Popover>
        )}
      </div>
      {item.expanded && (
        <div className="pack-card-expanded-content" style={{ padding: "0 12px 12px" }}>
          {item.deepScanGroups && item.deepScanGroups.length > 0 && (
            <Space style={{ marginBottom: 6 }} wrap align="center">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("app.deepScanText")}
              </Typography.Text>
              {item.deepScanGroups.map((g) => (
                <Checkbox
                  key={g.key}
                  checked={g.checked}
                  onChange={(e) => onToggleDeepGroup?.(item.key, g.key, e.target.checked)}
                  style={{ fontSize: 12 }}
                >
                  {t(`deepGroup.${g.key}`, { defaultValue: g.label })}({g.count})
                </Checkbox>
              ))}
            </Space>
          )}
          <div
            style={{
              height: item.height,
              overflow: "auto",
              border: "1px solid #F0F2F5",
              borderRadius: 8,
              padding: 8,
            }}
          >
            <EntryTable
              entries={item.entries}
              onEdit={hEdit}
              onSelect={onSelect}
              onClear={hClear}
              onToggleSelected={hSel}
              onToggleAllSelected={hSelAll}
              onToggleManySelected={hSelMany}
              scrollY={Math.max(item.height - 96, 120)}
            />
          </div>
          <div
            onMouseDown={(e) => onResize(item.key, e)}
            title="拖动调节显示区域高度"
            style={{
              height: 10,
              cursor: "row-resize",
              marginTop: 4,
              borderRadius: 4,
              background: "#F0F2F5",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              userSelect: "none",
            }}
          >
            <span style={{ fontSize: 10, color: "#999", letterSpacing: 2 }}>
              ⠿⠿⠿
            </span>
          </div>
        </div>
      )}
    </div>
  );
});

/** 深度扫描条目的分组 key（新数据用 deepGroup；旧会话缓存回退到备注前缀按标签匹配） */
function deepEntryGroup(e: LangEntry): string | null {
  if (e.deepGroup) return e.deepGroup;
  const legacy = e.notes?.[0];
  const prefixes = ["深度扫描·", "模组深度扫描·"];
  for (const pre of prefixes) {
    if (legacy?.startsWith(pre)) {
      const label = legacy.slice(pre.length);
      const hit = DEEP_LABEL_TO_KEY[label as keyof typeof DEEP_LABEL_TO_KEY];
      return hit ?? label;
    }
  }
  return null;
}

/** 旧备注标签 → 分组 key（仅为兼容历史会话缓存） */
const DEEP_LABEL_TO_KEY = {
  消息文本: "message",
  成就: "achievement",
  配置文件: "config",
  数据文件: "data",
  嵌套模组: "nested",
  嵌套内容包: "nested",
  "代码内嵌·其他": "class_text",
  库文本: "lib_text",
  其他语种: "other_locale",
  普通文本: "plain",
  其他文本: "plain",
} as const;

/** 队列中的单个内容包（模组 / 光影包 / 资源包统一结构） */
export interface PackItem {
  key: string;
  kind: PackKind;
  name: string;
  fileName: string;
  sourcePath: string;
  expanded: boolean;
  checked: boolean;
  height: number;
  entries: LangEntry[];
  /** 深度扫描分组状态（key 为稳定标识，label 仅用于展示） */
  deepScanGroups?: { key: string; label: string; count: number; checked: boolean }[];
  // 模组额外信息
  modFile?: ModFile;
  /** 服务器插件额外信息 */
  pluginFile?: PluginFile;
  /** 单包深度扫描覆盖（只存与全局规则的差异；跟随会话缓存，不跨重新导入） */
  deepScanOverride?: DeepScanOverride;
  langFormat?: LangFormat;
  hasZh?: boolean;
  zhCount?: number;
  /** 游戏目录模式：来源版本名（自由导入无此字段） */
  gameVersion?: string;
  /** 文件大小（跨包译文复用的指纹之一；自由导入已知路径时可填充） */
  size?: number;
}

function AppInner({
  settings,
  setSettings,
  reloadSettings,
}: {
  settings: Settings | null;
  setSettings: (s: Settings | null) => void;
  /** 从磁盘重新读取设置（清除用户数据后磁盘上已是默认值） */
  reloadSettings: () => Promise<void>;
}) {
  const { t } = useTranslationContext();
  const [queue, setQueue] = useState<PackItem[]>([]);
  const [activeTab, setActiveTab] = useState<PackKind>("mod");
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  // 翻译开始时间（剩余时间估算用）
  const translateStartRef = useRef(0);
  // 队列最新值引用：供身份需稳定的回调读取（避免把 queue 写进依赖导致 memo 失效）
  const queueRef = useRef<PackItem[]>([]);
  // 每个内容包的实时计数（批次事件累加，完成后弹 per-pack 卡片用）；same = 译文与原文相同
  const packCountsRef = useRef<Map<string, { ok: number; empty: number; error: number; error429: number; warn: number; same: number }>>(new Map());
  // 跨包译文复用表：fileKey（fileName|size）→ { entryKey: 译文 }
  const reuseRef = useRef<Map<string, Record<string, string>>>(new Map());
  // 内容包并行：正在翻译的包（key → true）与各包实时进度
  const [translatingKeys, setTranslatingKeys] = useState<Record<string, boolean>>({});
  const [packProgress, setPackProgress] = useState<Record<string, { done: number; total: number }>>({});
  // 取消标志的同步 ref（并行池 worker 内读到最新值，不受闭包捕获限制）
  const cancelRequestedRef = useRef(false);
  // 会话缓存：启动恢复只尝试一次
  const sessionRestoreTriedRef = useRef(false);
  // 主界面模式：free 自由导入（原逻辑）/ gamedir 游戏目录（.minecraft 扫描）
  const [workMode, setWorkMode] = useState<"free" | "gamedir">("free");
  const workModeRef = useRef<"free" | "gamedir">("free");
  if (workModeRef.current !== workMode) workModeRef.current = workMode;
  // 拖入/选择文件夹后自动进入游戏目录模式并扫描（GameDirView 消费后清空）
  const [gamedirAutoScan, setGamedirAutoScan] = useState<string | null>(null);
  // 自由导入：解析完成精简汇总
  // 聚合导入检查弹窗：导入完成后一次弹出（自带中文 / 空文本深度扫描 / 批次提示 / 解析失败）
  const [importReview, setImportReview] = useState<{
    added: number;
    deepFound: number;
    failures: { name: string; reason: string }[];
    zhPacks: { key: string; name: string; zhCount: number }[];
    emptyMods: { key: string; name: string }[];
    emptyInfo: string[];
    gdEmptyMods: { path: string; fileName: string; kind: PackKind }[];
    batchWarn: { names: string; threads: number; perBatch: number } | null;
  } | null>(null);
  const [importReviewOpen, setImportReviewOpen] = useState(false);
  // 导入检查弹窗的勾选状态
  const [reviewContinueZh, setReviewContinueZh] = useState<string[]>([]);
  const [reviewDeepScan, setReviewDeepScan] = useState<string[]>([]);
  const [reviewAutoDeep, setReviewAutoDeep] = useState(false);
  const importReviewResolve = useRef<((v: { deepKeys: string[]; zhKeys: string[]; autoDeep: boolean }) => void) | null>(null);
  // 游戏目录「解析并加入列表」的解析进度（GameDirView 显示）
  const [gdAddProgress, setGdAddProgress] = useState<{ done: number; total: number; current: string } | null>(null);

  // 启动恢复询问：有会话缓存（上次未清空就退出/崩溃）时询问是否恢复内容包列表
  // 优先读 v2 分片缓存；没有则回退旧的整份缓存（旧缓存会在下次落盘时迁移为分片）
  useEffect(() => {
    if (!settings || sessionRestoreTriedRef.current) return;
    sessionRestoreTriedRef.current = true;
    (async () => {
      let raw: string | null = null;
      let ids: string[] = [];
      try {
        raw = await api.sessionV2Load("free");
        if (raw) {
          const parsed = JSON.parse(raw) as { ids?: string[] };
          ids = parsed.ids ?? [];
        }
      } catch {
        raw = null;
      }
      if (!raw) {
        try {
          raw = await api.loadSessionCache("free");
        } catch {
          return;
        }
      }
      if (!raw) return;
      try {
        const data = JSON.parse(raw) as { packs?: PackItem[] };
        const packs = (data.packs ?? []).filter(
          (it) => it && typeof it.key === "string" && Array.isArray(it.entries),
        );
        if (packs.length === 0) return;
        const totalEntries = packs.reduce((n, it) => n + it.entries.length, 0);
        Modal.confirm({
          title: "恢复上次的内容包列表？",
          content: `检测到上次退出（或意外关闭）前有 ${packs.length} 个内容包、共 ${totalEntries} 条条目（含译文与进度）。是否恢复到列表？`,
          okText: "恢复",
          cancelText: "不恢复",
          onOk: () => {
            const restored = packs.map((it) => ({
              ...it,
              entries: (it.entries ?? []).map((e) => ({ ...e, translating: false })),
            }));
            setQueue(restored);
            // 索引与恢复出的包一一对应时才记住分片归属（避免错配后写乱分片）
            if (ids.length === restored.length) {
              restored.forEach((it, i) => shardIdsRef.current.set(it.key, ids[i]));
            }
            message.success(`已恢复 ${packs.length} 个内容包`);
          },
          onCancel: () => {
            void api.clearSessionCache("free");
            void api.sessionV2Clear("free");
          },
        });
      } catch {
        // 缓存损坏：静默清除
        void api.clearSessionCache("free");
        void api.sessionV2Clear("free");
      }
    })().catch(() => {});
  }, [settings]);

  // 队列最新值同步到 ref（身份稳定的回调通过它读取队列）
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  // 设置最新值同步（批量命名任务在异步流程里读）
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // 后台补齐 AI 名称：队列稳定 15s 后启动（导入/恢复/切换偏好都会触发），
  // 翻译期间不启动（避免与翻译抢额度）；失败过的包不反复重试
  useEffect(() => {
    if (!settings || translating) return;
    if ((settings.exportNaming ?? "suffix") !== "ai") return;
    if (queue.length === 0 || aiNameJobRef.current) return;
    const merged = { ...(settings.aiNames ?? {}), ...aiNamesRef.current };
    const todo = queue.filter(
      (it) => !merged[aiKeyOf(it)] && !aiNameFailedRef.current.has(aiKeyOf(it)),
    );
    if (todo.length === 0) return;
    const timer = setTimeout(() => {
      void startAiNameJob(queue);
    }, 15000);
    return () => clearTimeout(timer);
  }, [queue, settings, translating]);

  // ── 会话缓存 v2：按包分片，只重写「发生变化」的包分片 ──────────────────────
  // 为什么：整份快照在上千包时会产生几十 MB 字符串 + IPC 拷贝，主线程被按死数秒、
  // 进程瞬时内存暴涨（白屏根因）。分片后单次写入从秒级降到毫秒级。
  // 分片仍是完整条目数据，因此恢复不依赖原包文件仍在。
  const sessionDirtyRef = useRef(false);
  const sessionSavingRef = useRef(false);
  const sessionIdRef = useRef(`s${Date.now().toString(36)}`);
  const shardSeqRef = useRef(0);
  // packKey → 分片 id（同一会话内稳定）；packKey → 上次写入时的特征签名
  const shardIdsRef = useRef<Map<string, string>>(new Map());
  const writtenSigRef = useRef<Map<string, string>>(new Map());
  const lastPruneRef = useRef(0);

  /** 内容包特征签名：条目数/已译数/勾选数/备注数/包级开关等，用于判断是否需要重写分片。
   *  比对象引用更可靠——深度扫描等操作是就地改 entries，对象身份不变。 */
  const packSignature = useCallback((it: PackItem): string => {
    let translated = 0;
    let selected = 0;
    let notes = 0;
    for (const e of it.entries) {
      if (e.translation) translated += 1;
      if (e.selected ?? true) selected += 1;
      notes += e.notes?.length ?? 0;
    }
    return [
      it.checked ? 1 : 0,
      it.expanded ? 1 : 0,
      it.entries.length,
      translated,
      selected,
      notes,
      it.name,
      it.gameVersion ?? "",
      // 单包深度扫描规则只存内存（不落盘），因此不纳入签名
    ].join("|");
  }, []);

  /** 分片落盘：只写签名变化的包；每轮最多 WRITE_BATCH 个，其余留到下一轮（避免长任务） */
  const persistSession = useCallback(async () => {
    if (sessionSavingRef.current) return;
    const q = queueRef.current;
    if (q.length === 0) {
      void api.clearSessionCache("free");
      void api.sessionV2Clear("free");
      shardIdsRef.current.clear();
      writtenSigRef.current.clear();
      sessionDirtyRef.current = false;
      return;
    }
    sessionSavingRef.current = true;
    try {
      const WRITE_BATCH = 20;
      let written = 0;
      for (const it of q) {
        if (written >= WRITE_BATCH) break;
        const sig = packSignature(it);
        if (writtenSigRef.current.get(it.key) === sig) continue;
        let id = shardIdsRef.current.get(it.key);
        if (!id) {
          id = `${sessionIdRef.current}-${shardSeqRef.current++}`;
          shardIdsRef.current.set(it.key, id);
        }
        await api.sessionV2WriteShard(
          "free",
          id,
          // 单包深度扫描规则只保留在内存中（用户要求不落盘），落盘前剥离
          JSON.stringify({ ...it, deepScanOverride: undefined }),
        );
        writtenSigRef.current.set(it.key, sig);
        written += 1;
      }
      // 索引很小（仅有顺序与分片 id），每次都写；只有还有脏包时才需要继续
      const ids: string[] = [];
      for (const it of q) {
        const id = shardIdsRef.current.get(it.key);
        if (id) ids.push(id);
      }
      await api.sessionV2WriteIndex("free", JSON.stringify({ version: 2, savedAt: Date.now(), ids }));
      let remaining = 0;
      for (const it of q) {
        if (writtenSigRef.current.get(it.key) !== packSignature(it)) remaining += 1;
      }
      sessionDirtyRef.current = remaining > 0;
      // 遗留分片清理（换会话或删包后产生），最多每分钟一次
      if (Date.now() - lastPruneRef.current > 60000) {
        lastPruneRef.current = Date.now();
        void api.sessionV2Prune("free", ids).catch(() => {});
      }
    } catch {
      /* 缓存写入失败不阻断 */
    } finally {
      sessionSavingRef.current = false;
    }
  }, [packSignature]);

  useEffect(() => {
    if (parsing) return;
    sessionDirtyRef.current = true;
    // 空闲 800ms 后落盘；持续变化时由下面的定时器兜底（与防抖不同，不会饿死）
    const timer = setTimeout(() => {
      if (sessionDirtyRef.current) void persistSession();
    }, 800);
    return () => clearTimeout(timer);
  }, [queue, parsing, persistSession]);

  useEffect(() => {
    const id = setInterval(() => {
      if (sessionDirtyRef.current && !parsing) void persistSession();
    }, 5000);
    return () => clearInterval(id);
  }, [parsing, persistSession]);
  // 术语表建议候选（翻译完成后并入汇总弹窗）
  const [glossarySuggest, setGlossarySuggest] = useState<[string, string][] | null>(null);
  const [suggestChecked, setSuggestChecked] = useState<string[]>([]);
  // 本次提取的术语（en→zh），汇总弹窗可勾选加入用户术语表
  const [extractedGlossary, setExtractedGlossary] = useState<[string, string][] | null>(null);
  const [extractedChecked, setExtractedChecked] = useState<string[]>([]);
  // 原文一致过多（本次运行累积，不逐包弹窗；翻译完成后在汇总弹窗统一处理）
  const [sameWarnPacks, setSameWarnPacks] = useState<{ packKey: string; name: string; count: number }[]>([]);
  const [sameWarnChecked, setSameWarnChecked] = useState<string[]>([]);
  // 翻译完成汇总弹窗（原文一致 / 术语表提取 / 术语建议 合并）
  const [transSummaryOpen, setTransSummaryOpen] = useState(false);
  // AI 汉化名称：内存缓冲 + 任务互斥 + 失败集合（后台不反复重试）
  const aiNamesRef = useRef<Record<string, string>>({});
  const aiNameJobRef = useRef<Promise<void> | null>(null);
  const aiNameFailedRef = useRef<Set<string>>(new Set());
  // 首个失败原因（提示用，避免用户只看到"失败"却不知为何）
  const aiNameErrRef = useRef<string | null>(null);
  // 设置的最新快照（异步任务里读，避免闭包过期）
  const settingsRef = useRef<Settings | null>(null);
  // 术语提取结果贯穿运行期的引用（glossary-done 事件异步到达，闭包内 state 会过期）
  const extractedGlossaryRef = useRef<[string, string][]>([]);
  const [currentPackName, setCurrentPackName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 打开设置时要定位到的分组（如翻译参数 params）；undefined = 默认页
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [packMode, setPackMode] = useState<"auto" | "custom">("auto");
  const [customPackFormat, setCustomPackFormat] = useState(15);
  const [deepScanningKey, setDeepScanningKey] = useState<string | null>(null);
  const [exportRiskOpen, setExportRiskOpen] = useState(false);
  const [exportRiskChecked, setExportRiskChecked] = useState<PackItem[]>([]);
  const [paused, setPaused] = useState(false);
  // devtools：网络故障注入生效中（Header 常驻标签文案，null = 无故障）
  const [devFaultSummary, setDevFaultSummary] = useState<string | null>(null);
  // 清除译文对话框：可见性
  const [clearOpen, setClearOpen] = useState(false);
  // 单包深度扫描规则配置（点击卡片齿轮打开，只允许调整规则与自定义规则启用位）
  const [deepRulesFor, setDeepRulesFor] = useState<string | null>(null);

  // devtools：监听开发者工具第二窗口广播的触发事件，在主窗口弹出真实提示
  useEffect(() => {
    if (!__DEVTOOLS__) return;
    const counts: Record<
      Exclude<DevResultKind, "cancel">,
      { ok: CountValue; empty: CountValue; error: CountValue; error429: CountValue; warn: CountValue }
    > = {
      ok: { ok: "XX", empty: 0, error: 0, error429: 0, warn: 0 },
      empty: { ok: "XX", empty: "XX", error: 0, error429: 0, warn: 0 },
      warn: { ok: "XX", empty: 0, error: 0, error429: 0, warn: "XX" },
      error: { ok: "XX", empty: 0, error: "XX", error429: 0, warn: 0 },
      error429: { ok: "XX", empty: 0, error: "XX", error429: "XX", warn: 0 },
    };
    const unlisteners: Promise<UnlistenFn>[] = [
      listen(DEV_SHOW_RESULT_ALERT, (e) => {
        const kind = e.payload as DevResultKind;
        if (kind === "cancel") {
          // 与翻译取消路径同款提示（该路径本身为硬编码文案）
          message.info("已取消，已翻译部分已保留");
          return;
        }
        // 与真实翻译完成卡片同款样式：per-pack 标题，模拟数据全部 XX
        const a = buildResultAlert(counts[kind], t);
        const labels = [t("app.mod"), t("app.shader"), t("app.resourcepack")];
        const label = labels[Math.floor(Math.random() * labels.length)];
        showResultCard(a.type, `翻译 XX ${label}完成`, a.desc);
      }),
      listen(DEV_SHOW_EXPORT_ERROR, (e) => {
        // 与 handleExport 失败路径同款提示格式
        message.error(`「DevTools 测试包」导出失败：${String(e.payload)}`);
      }),
      listen(DEV_FAULT_CHANGED, (e) => {
        const n = e.payload as DevFaultNotice;
        setDevFaultSummary(n.active ? n.summary : null);
        if (n.active) {
          message.warning(`⚠ ${t("devtools.injection.faultTag", { summary: n.summary })}`);
        } else {
          message.info(t("devtools.injection.clearedToast"));
        }
      }),
    ];
    return () => {
      unlisteners.forEach((p) => void p.then((u) => u()));
    };
  }, [t]);


  // 设置加载已提升到外层 App（主题/语言/无字模式需在 ConfigProvider 外层生效）

  // 静默检查更新：失败无感；同一版本只提示一次
  useEffect(() => {
    api
      .checkUpdate()
      .then((u) => {
        if (!u) return;
        const key = `mt-update-notified-${u.latestVersion}`;
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, "1");
        notification.info({
          message: "发现新版本",
          description: `v${u.latestVersion} 已发布，是否前往下载？`,
          duration: 0,
          placement: "bottomRight",
          btn: (
            <Button
              size="small"
              type="primary"
              onClick={() => void openUrl(u.url)}
            >
              前往下载
            </Button>
          ),
        });
      })
      .catch(() => {
        /* 网络失败静默 */
      });
  }, []);

  /** 导出成功提示 + 「打开所在文件夹」按钮 */
  /** 按内容包的来源版本返回导出子目录（游戏目录模式：导出/版本名/…；自由导入：原目录） */
  function vdirFor(dir: string, it: PackItem): string {
    return it.gameVersion ? `${dir}/${it.gameVersion}` : dir;
  }

  function notifyExport(title: string, paths: string[]) {
    notification.success({
      message: title,
      description: paths[0] ?? "",
      placement: "bottomRight",
      duration: 6,
      btn:
        paths.length > 0 ? (
          <Button
            size="small"
            type="primary"
            onClick={() => void revealItemInDir(paths[0])}
          >
            打开所在文件夹
          </Button>
        ) : undefined,
    });
  }

  // 监听拖入文件
  useEffect(() => {
    const unlisten = onFileDropped((paths) => {
      void addFiles(paths);
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // 全窗口拖放高亮
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = () => setDragOver(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // 监听翻译进度：全局一条 + 按包细分（并行翻译时各包独立显示）
  // 上千内容包时进度事件可达上万条，逐条 setState 会造成上万次整树渲染 → 合并提交（~200ms）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latestGlobal: ProgressPayload | null = null;
    const pendingPacks = new Map<string, { done: number; total: number }>();
    const flush = () => {
      timer = null;
      if (latestGlobal) setProgress(latestGlobal);
      if (pendingPacks.size > 0) {
        const snap = new Map(pendingPacks);
        pendingPacks.clear();
        setPackProgress((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [k, v] of snap) {
            const cur = next[k];
            if (!cur || cur.done !== v.done || cur.total !== v.total) {
              next[k] = v;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    };
    const unlisten = onTranslateProgress((p) => {
      latestGlobal = p;
      if (p.packKey) {
        pendingPacks.set(p.packKey as string, { done: p.doneCount, total: p.totalCount });
      }
      if (timer === null) timer = setTimeout(flush, 200);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unlisten.then((f) => f());
    };
  }, []);
  useEffect(() => {
    const unlisten = onGlossaryDone(({ count, glossary }) => {
      // 仅首次提取提示一次（术语详情统一在翻译完成汇总里查看）
      if (count > 0 && extractedGlossaryRef.current.length === 0) {
        message.info(`已提取 ${count} 条术语，用于统一译名（完成后可在汇总中勾选加入术语表）`);
      }
      if (glossary && glossary.length > 0) {
        setExtractedGlossary((prev) => {
          const map = new Map<string, string>();
          (prev ?? []).forEach(([en, zh]) => map.set(en, zh));
          glossary.forEach(([en, zh]) => {
            if (!map.has(en)) map.set(en, zh);
          });
          const merged = [...map.entries()];
          extractedGlossaryRef.current = merged;
          return merged;
        });
        setExtractedChecked((prev) => {
          const set = new Set(prev);
          glossary.forEach(([en]) => set.add(en));
          return [...set];
        });
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // 监听逐批实时翻译结果：实时写入存储（entries 状态）并显示，不等待全部完成
  // 上千个内容包时批次事件可达上万次，若每次都 setQueue 会全量重渲染 → 先累积、每 ~150ms 合并提交一次
  useEffect(() => {
    type BatchItem = { key: string; translation: string; notes: string[]; kind: "ok" | "empty" | "error" };
    const pending = new Map<string, Map<string, BatchItem>>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      if (pending.size === 0) return;
      const snapMap = new Map<string, BatchItem[]>();
      for (const [pk, m] of pending) snapMap.set(pk, [...m.values()]);
      pending.clear();
      setQueue((prev) =>
        prev.map((pack) => {
          const hit = snapMap.get(pack.key);
          if (!hit) return pack;
          const byKey = new Map(hit.map((i) => [i.key, i]));
          let okN = 0,
            emptyN = 0,
            errN = 0,
            err429N = 0,
            warnN = 0,
            sameN = 0;
          const entries = pack.entries.map((e) => {
            const r = byKey.get(e.key);
            if (!r) return e;
            if (r.translation && r.translation === e.source) sameN += 1;
            if (r.kind === "error") {
              errN += 1;
              if (r.notes.some((n) => n.includes("429"))) err429N += 1;
            } else if (r.kind === "empty") {
              emptyN += 1;
            } else {
              okN += 1;
              if (r.notes.length > 0) warnN += 1;
            }
            const status: LangEntry["status"] =
              r.kind === "error"
                ? "aiFailed"
                : r.kind === "empty"
                  ? "aiEmpty"
                  : "aiTranslated";
            return {
              ...e,
              translation: r.translation || null,
              notes: r.notes,
              status,
              translating: false,
            };
          });
          const pc = packCountsRef.current.get(pack.key) ?? { ok: 0, empty: 0, error: 0, error429: 0, warn: 0, same: 0 };
          pc.ok += okN;
          pc.empty += emptyN;
          pc.error += errN;
          pc.error429 += err429N;
          pc.warn += warnN;
          pc.same += sameN;
          packCountsRef.current.set(pack.key, pc);
          return { ...pack, entries };
        }),
      );
    };

    const unlisten = onTranslationBatch(({ packKey, items }) => {
      let m = pending.get(packKey);
      if (!m) {
        m = new Map();
        pending.set(packKey, m);
      }
      for (const it of items) m.set(it.key, it);
      if (timer === null) timer = setTimeout(flush, 150);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unlisten.then((f) => f());
    };
  }, []);

  /** 打开文件选择（点击中央区域） */
  async function pickFiles() {
    const paths = await open({
      multiple: true,
      title: "选择内容包文件（→ 自由导入）或游戏目录 / 版本文件夹（→ 自动扫描）",
    });
    if (paths && paths.length > 0) {
      await addFiles(paths);
    }
  }

  /** 解析单个文件：先探测类型，再按类型解析 */
  async function parseFile(p: string): Promise<PackItem> {
    const kind = await api.detectPackType(p);
    const mkKey = (name: string) =>
      `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (kind === "shader") {
      const shader = await api.parseShaderPack(p);
      return {
        key: mkKey(shader.fileName),
        kind: "shader",
        name: shader.name,
        fileName: shader.fileName,
        sourcePath: p,
        expanded: true,
        checked: true,
        height: 320,
        entries: shader.entries,
        hasZh: shader.hasZh,
        zhCount: shader.zhCount,
      };
    }
    if (kind === "resourcepack") {
      const rp = await api.parseResourcePack(p);
      return {
        key: mkKey(rp.fileName),
        kind: "resourcepack",
        name: rp.name,
        fileName: rp.fileName,
        sourcePath: p,
        expanded: true,
        checked: true,
        height: 320,
        entries: rp.entries,
      };
    }
    if (kind === "plugin") {
      const pf = await api.parsePluginJar(p);
      return {
        key: mkKey(pf.fileName),
        kind: "plugin",
        name: pf.pluginName,
        fileName: pf.fileName,
        sourcePath: p,
        expanded: true,
        checked: true,
        height: 320,
        entries: pf.entries,
        pluginFile: pf,
        hasZh: pf.hasZh,
        zhCount: pf.zhCount,
      };
    }
    const mf = await api.parseJar(p);
    return {
      key: mkKey(mf.fileName),
      kind: "mod",
      name: mf.modName,
      fileName: mf.fileName,
      sourcePath: p,
      expanded: true,
      checked: true,
      height: 320,
      entries: mf.entries,
      modFile: mf,
      langFormat: mf.langFormat,
      hasZh: mf.hasZh,
      zhCount: mf.zhCount,
    };
  }

  /** 执行深度扫描：按「生效规则」扫描并与既有条目合并。
   *  合并策略：同 key 保留已有译文与勾选；新条目按分组默认勾选；规则不再产出但已有译文的条目保留并标记「已排除」 */
  async function applyDeepScan(item: PackItem): Promise<number> {
    const rules = effectiveDeepRules(item, settingsRef.current);
    const res = await api.deepScanJar(
      item.sourcePath,
      item.modFile?.modid ?? item.pluginFile?.pluginName ?? "mod",
      rules ?? undefined,
    );
    const prevDeep = item.entries.filter((e) => deepEntryGroup(e));
    const normal = item.entries.filter((e) => !deepEntryGroup(e));
    const prevByKey = new Map(prevDeep.map((e) => [e.key, e]));
    const checkedByKey = new Map((item.deepScanGroups ?? []).map((g) => [g.key, g.checked]));

    const merged: LangEntry[] = [];
    let added = 0;
    for (const e of res.entries) {
      const old = prevByKey.get(e.key);
      if (old) {
        // 同一条目：保留译文 / 状态 / 勾选，仅刷新分组与备注
        merged.push({
          ...e,
          translation: old.translation,
          status: old.status,
          selected: old.selected,
          translating: false,
        });
        prevByKey.delete(e.key);
      } else {
        const key = e.deepGroup ?? "plain";
        merged.push({ ...e, selected: checkedByKey.get(key) ?? key === "message" });
        added += 1;
      }
    }
    // 规则不再产出：有译文则保留并标记「已排除」（不丢用户成果），无译文直接丢弃
    const kept: LangEntry[] = [];
    for (const old of prevByKey.values()) {
      if (old.translation) {
        kept.push({
          ...old,
          deepGroup: "excluded",
          notes: ["深度扫描·已排除", ...(old.notes ?? []).filter((n) => !n.startsWith("深度扫描·"))],
        });
      }
    }
    item.entries = [...normal, ...merged, ...kept];
    item.deepScanGroups = res.groups.map((g) => ({
      key: g.key,
      label: g.label,
      count: g.count,
      checked: checkedByKey.get(g.key) ?? g.defaultChecked ?? false,
    }));
    setQueue((prev) => [...prev]);
    return added;
  }

  async function addFiles(paths: string[]) {
    // 导入路由：文件夹 → 切换游戏目录并扫描；内容包文件 → 自由导入
    const dirPaths: string[] = [];
    const filePaths: string[] = [];
    for (const p of paths) {
      if (await api.pathIsDir(p)) dirPaths.push(p);
      else filePaths.push(p);
    }
    if (dirPaths.length > 0) {
      setWorkMode("gamedir");
      setGamedirAutoScan(dirPaths[0]);
      if (filePaths.length === 0) return;
    }
    const files = filePaths.filter(
      (p) => p.toLowerCase().endsWith(".jar") || p.toLowerCase().endsWith(".zip"),
    );
    if (files.length === 0) {
      message.error("请选择 .jar 或 .zip 文件");
      return;
    }
    setParsing(true);
    const added: PackItem[] = [];
    const importFailures: { name: string; reason: string }[] = [];
    // 大批量导入时默认收缩卡片：展开会为每个包挂载表格，几百个包时严重卡顿甚至崩溃
    const autoExpand = files.length <= AUTO_EXPAND_MAX;
    let pending: PackItem[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setQueue((prev) => [...prev, ...batch]);
    };
    for (const p of files) {
      try {
        const item = await parseFile(p);
        item.expanded = autoExpand;
        // 条目默认参与汉化
        item.entries = item.entries.map((e) => ({ ...e, selected: e.selected ?? true }));
        added.push(item);
        pending.push(item);
        // 分批入队：每 IMPORT_FLUSH_CHUNK 个刷一次，避免逐包 setQueue 造成 O(n²) 重渲染
        if (pending.length >= IMPORT_FLUSH_CHUNK) {
          flush();
          // 让出主线程，使界面有机会绘制解析进度（否则连续解析会假死）
          await new Promise((r) => setTimeout(r, 0));
        }
      } catch (e) {
        const fileName = p.split(/[\\/]/).pop() ?? p;
        const err = String(e);
        let reason: string;
        if (/zip 读取失败|无法打开文件/.test(err)) {
          reason = t("app.msgParseCorrupt", { name: fileName });
        } else if (/未能识别为可翻译的模组|不是可翻译/.test(err)) {
          reason = t("app.msgParseNotPack", { name: fileName });
        } else {
          reason = t("app.msgParseOther", { name: fileName, error: err });
        }
        importFailures.push({ name: fileName, reason });
      }
    }
    flush();
    // 自动深度扫描：模组与插件分别受「模组深度扫描」「插件深度扫描」开关控制
    let deepFound = 0;
    for (const it of added) {
      if (it.entries.length > 0) continue;
      const rules = effectiveDeepRules(it, settings ?? null);
      if (!rules?.auto) continue;
      try {
        deepFound += await applyDeepScan(it);
      } catch {
        /* 强扫失败不阻断 */
      }
    }
    setParsing(false);
    // ── 聚合导入检查：所有提示合并为单个弹窗，勾选后统一执行（去重精简）──
    const emptyPacks = added.filter((it) => it.entries.length === 0);
    // 深度扫描已开启时，空模组刚才已自动扫过，不再提供重复扫描（归入纯提示）
    // 自动深度扫描已覆盖的类型（其规则集 auto 为开）→ 归入「已扫描仍为空」的纯提示
    const autoScanned = (it: PackItem) => !!effectiveDeepRules(it, settings ?? null)?.auto;
    const modsEmpty = emptyPacks.filter(
      (it) => (it.kind === "mod" || it.kind === "plugin") && !autoScanned(it),
    );
    const scannedEmpty = emptyPacks.filter(
      (it) => (it.kind === "mod" || it.kind === "plugin") && autoScanned(it),
    );
    const otherEmpty = emptyPacks.filter((it) => it.kind !== "mod");
    const zhPacks = added.filter((it) => it.hasZh && (it.zhCount ?? 0) > 0);
    const small = added.filter((it) => it.entries.length > 0 && it.entries.length < 50);
    let batchWarn: { names: string; threads: number; perBatch: number } | null = null;
    if (settings?.threading?.enabled && (settings.batchSizeAuto ?? true)) {
      const threads = settings.threading.threadCount;
      if (threads >= 4 && small.length > 0) {
        // 用循环取最小值：数组展开给 Math.min 传参在包数极多时会触发 RangeError
        let minLen = Number.MAX_SAFE_INTEGER;
        for (const it of small) if (it.entries.length < minLen) minLen = it.entries.length;
        batchWarn = {
          names: small.map((it) => `「${it.name}」${it.entries.length} 条`).join("、"),
          threads,
          perBatch: Math.max(1, Math.ceil(minLen / threads)),
        };
      }
    }
    const needReview =
      importFailures.length > 0 ||
      zhPacks.length > 0 ||
      modsEmpty.length > 0 ||
      otherEmpty.length > 0 ||
      batchWarn !== null;
    if (needReview) {
      const decided = await new Promise<{ deepKeys: string[]; zhKeys: string[]; autoDeep: boolean }>(
        (resolve) => {
          importReviewResolve.current = resolve;
          setImportReview({
            added: added.length,
            deepFound,
            failures: importFailures,
            zhPacks: zhPacks.map((it) => ({ key: it.key, name: it.name, zhCount: it.zhCount ?? 0 })),
            emptyMods: modsEmpty.map((it) => ({ key: it.key, name: it.name })),
            emptyInfo: [
              ...otherEmpty.map((it) => it.name),
              ...scannedEmpty.map((it) => it.name),
            ],
            gdEmptyMods: [],
            batchWarn,
          });
          setReviewContinueZh(zhPacks.map((it) => it.key));
          setReviewDeepScan(modsEmpty.map((it) => it.key));
          setReviewAutoDeep(false);
          setImportReviewOpen(true);
        },
      );
      importReviewResolve.current = null;
      // 执行勾选：对空模组深度扫描
      const deepSet = new Set(decided.deepKeys);
      let found = 0;
      for (const it of modsEmpty) {
        if (!deepSet.has(it.key)) continue;
        try {
          found += await applyDeepScan(it);
        } catch {
          /* 强扫失败不阻断 */
        }
      }
      setQueue((prev) => [...prev]);
      if (found > 0) {
        message.success(`深度扫描发现 ${found} 条内嵌文本（默认未勾选，可在卡片上勾选组）`);
      } else if (deepSet.size > 0) {
        message.info("深度扫描未发现更多可翻译文本，请在卡片上确认文本格式或类型是否受支持");
      }
      // “以后自动深度扫描”写回全局设置
      const cur = settingsRef.current;
      const autoOn = cur?.deepScanRules?.mod?.auto && cur?.deepScanRules?.plugin?.auto;
      if (decided.autoDeep && cur?.deepScanRules && !autoOn) {
        const next = {
          ...cur,
          deepScanRules: {
            mod: { ...cur.deepScanRules.mod, auto: true },
            plugin: { ...cur.deepScanRules.plugin, auto: true },
          },
        };
        try {
          // 增量保存：只覆盖 deepScanRules，不碰其它键（整份写回会覆盖别处刚保存的内容）
          await api.patchSettings({ deepScanRules: next.deepScanRules });
          setSettings(next);
        } catch {
          /* 忽略 */
        }
      }
      // 自带中文：取消勾选的包标记为不参与后续 AI 汉化（保留自带中文）
      if (decided.zhKeys.length < zhPacks.length) {
        const zhSet = new Set(decided.zhKeys);
        setQueue((prev) =>
          prev.map((it) =>
            zhPacks.some((z) => z.key === it.key) && !zhSet.has(it.key)
              ? { ...it, checked: false }
              : it,
          ),
        );
      }
    } else if (added.length > 0) {
      message.success(`已导入 ${added.length} 个内容包`);
    }
  }

  function patchPack(key: string, fn: (it: PackItem) => PackItem) {
    setQueue((prev) => prev.map((it) => (it.key === key ? fn(it) : it)));
  }

  const editTranslation = useCallback(
    (packKey: string, entryKey: string, value: string) => {
      patchPack(packKey, (it) => ({
        ...it,
        entries: it.entries.map((e) => {
          if (e.key !== entryKey) return e;
          const trimmed = value.trim();
          if (trimmed === "") {
            return { ...e, translation: null, status: "untranslated" as const };
          }
          return { ...e, translation: value, status: "userConfirmed" as const };
        }),
      }));
    },
    [],
  );

  const clearTranslation = useCallback((packKey: string, entryKey: string) => {
    patchPack(packKey, (it) => ({
      ...it,
      entries: it.entries.map((e) =>
        e.key === entryKey
          ? { ...e, translation: null, status: "untranslated" as const, notes: [] }
          : e,
      ),
    }));
    message.info("已清除该条译文，下次翻译会重新加入队列");
  }, []);

  /** 切换单条是否参与汉化 */
  const toggleSelected = useCallback(
    (packKey: string, entryKey: string, selected: boolean) => {
      patchPack(packKey, (it) => ({
        ...it,
        entries: it.entries.map((e) =>
          e.key === entryKey ? { ...e, selected } : e,
        ),
      }));
    },
    [],
  );

  /** 批量切换多条是否参与汉化（拖动勾选用，一次提交） */
  const toggleManySelected = useCallback(
    (packKey: string, keys: string[], selected: boolean) => {
      if (keys.length === 0) return;
      const keySet = new Set(keys);
      patchPack(packKey, (it) => ({
        ...it,
        entries: it.entries.map((e) =>
          keySet.has(e.key) ? { ...e, selected } : e,
        ),
      }));
    },
    [],
  );

  /** 当前内容包全部条目参与/不参与汉化 */
  const toggleAllSelected = useCallback(
    (packKey: string, selected: boolean) => {
      patchPack(packKey, (it) => ({
        ...it,
        entries: it.entries.map((e) => ({ ...e, selected })),
      }));
    },
    [],
  );

  const toggleChecked = useCallback((key: string, checked: boolean) => {
    setQueue((prev) => prev.map((it) => (it.key === key ? { ...it, checked } : it)));
  }, []);

  function toggleAll(checked: boolean) {
    // 全选只作用于当前内容类型页（模组/光影包/资源包互不影响）
    setQueue((prev) =>
      prev.map((it) => (it.kind === activeTab ? { ...it, checked } : it)),
    );
  }

  const toggleExpanded = useCallback((key: string) => {
    setQueue((prev) => prev.map((it) => (it.key === key ? { ...it, expanded: !it.expanded } : it)));
  }, []);

  /** 拖动调节展开区高度（直接操作 DOM，避免卡顿） */
  const startResize = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const box = handle.previousElementSibling as HTMLElement | null;
    if (!box) return;
    const startY = e.clientY;
    const startH = box.offsetHeight;
    document.body.style.userSelect = "none";
    let raf = 0;
    const onMove = (ev: MouseEvent) => {
      const h = Math.min(
        Math.max(startH + (ev.clientY - startY), 120),
        window.innerHeight - 180,
      );
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        box.style.height = `${h}px`;
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      const finalH = box.offsetHeight;
      setQueue((prev) =>
        prev.map((it) => (it.key === key ? { ...it, height: finalH } : it)),
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  /** 翻译当前 Tab 下勾选的内容包（按设置的包并行数并发，增量翻译） */
  async function runTranslation() {
    if (!settings) return;
    const targets = queue.filter((it) => it.checked && it.kind === activeTab);
    if (targets.length === 0) {
      message.info("请先勾选要翻译的内容包");
      return;
    }
    if (!settings.provider.apiKey) {
      message.warning(t("app.msgApiKeyRequired"));
      setSettingsOpen(true);
      return;
    }
    const provider = {
      ...settings.provider,
      temperature:
        settings.provider.temperature == null
          ? 0.7
          : Math.round(settings.provider.temperature * 100) / 100,
    };

    setTranslating(true);
    cancelRequestedRef.current = false;
    setPaused(false);
    packCountsRef.current.clear();
    setPackProgress({});
    translateStartRef.current = Date.now();
    // 本次运行累积的「原文一致」告警（不逐包弹窗，结束后汇总）
    const localSameWarn: { packKey: string; name: string; count: number }[] = [];
    // 包数很多时抑制逐包完成通知，改为结束时一条汇总（避免上千条通知堆积）
    let suppressPackCards = false;
    let totalOk = 0,
      totalErr = 0,
      totalEmpty = 0,
      cardsCounted = 0;
    extractedGlossaryRef.current = [];
    // 清空上一轮汇总残留，避免旧数据混入本轮汇总弹窗
    setTransSummaryOpen(false);
    setSameWarnPacks([]);
    setSameWarnChecked([]);
    setExtractedGlossary(null);
    setExtractedChecked([]);
    setGlossarySuggest(null);
    setSuggestChecked([]);
    let doneAny = false;

    // 待翻译任务（无待翻译条目的包直接跳过；preSame = 历史遗留的同原文条数）
    const tasks = targets
      .map((item) => ({
        item,
        untranslated: item.entries.filter((e) => (e.selected ?? true) && !e.translation),
        preSame: item.entries.filter(
          (e) => e.status === "aiTranslated" && e.translation != null && e.translation === e.source,
        ).length,
      }))
      .filter((tk) => tk.untranslated.length > 0);

    suppressPackCards = tasks.length > 20;

    const translateOnePack = async (
      item: PackItem,
      untranslated: BatchItem[],
      preSame: number,
    ): Promise<void> => {
      setTranslatingKeys((prev) => ({ ...prev, [item.key]: true }));
      // 跨包译文复用：同名同大小的包已译过的条目直接预填（不再发请求）
      const reuse = reuseRef.current.get(`${item.fileName}|${item.size ?? 0}`) ?? {};
      const reusedKeys = untranslated.filter((e) => reuse[e.key]).map((e) => e.key);
      if (reusedKeys.length > 0) {
        const ks = new Set(reusedKeys);
        patchPack(item.key, (it) => ({
          ...it,
          entries: it.entries.map((e) =>
            ks.has(e.key) && reuse[e.key]
              ? {
                  ...e,
                  translation: reuse[e.key],
                  status: "aiTranslated" as const,
                  notes: [...e.notes, "跨版本复用译文"],
                  translating: false,
                }
              : e,
          ),
        }));
        // 就地过滤：不用展开语法（超大条目数组展开会触发 RangeError）
        for (let i = untranslated.length - 1; i >= 0; i--) {
          if (ks.has(untranslated[i].key)) untranslated.splice(i, 1);
        }
        message.info(`「${item.name}」复用已翻译译文 ${reusedKeys.length} 条`);
      }
      // 先行将待翻译条目标记为「翻译中」（淡蓝），逐批完成后由实时事件翻为最终态
      patchPack(item.key, (it) => ({
        ...it,
        entries: it.entries.map((e) =>
          (e.selected ?? true) && !e.translation ? { ...e, translating: true } : e,
        ),
      }));
      const items: BatchItem[] = untranslated.map((e) => ({
        key: e.key,
        source: e.source,
      }));
      const ctx: TranslateContext = {
        modName: item.name,
        modid: item.kind === "mod" ? item.modFile?.modid ?? "mod" : item.kind,
        mcVersion: item.modFile?.mcVersion ?? null,
        loader: item.modFile ? LOADER_LABEL[item.modFile.loader] : t(KIND_META[item.kind].labelKey),
        packType: item.kind,
        customPrompt: settings.customPrompts?.[item.kind] ?? null,
        userGlossary: settings.userGlossary,
      };
      setPackProgress((prev) => ({ ...prev, [item.key]: { done: 0, total: items.length } }));
      // 批次大小：跟随线程数取最优（条目数 ÷ 线程数，向上取整），否则用设置值
      const threads = settings.threading?.enabled ? settings.threading.threadCount : 1;
      const effectiveBatch =
        settings.batchSizeAuto ?? true
          ? Math.max(1, Math.ceil(untranslated.length / threads))
          : settings.batchSize;
      try {
        const packLabel = item.gameVersion
          ? `${item.gameVersion}·${item.kind === "mod"
                ? "模组"
                : item.kind === "shader"
                  ? "光影包"
                  : item.kind === "plugin"
                    ? "插件"
                    : "资源包"}·${item.fileName}`
          : undefined;
        const results = await api.runTranslation(
          provider,
          ctx,
          items,
          item.key,
          effectiveBatch,
          settings.extractGlossary,
          settings.threading,
          packLabel,
        );
        const byKey = new Map(results.map((r) => [r.key, r]));
        // 跨包复用表：同名同大小的包共享译文
        if (item.size) {
          const fk = `${item.fileName}|${item.size}`;
          const store = reuseRef.current.get(fk) ?? {};
          for (const r of results) if (r.translation) store[r.key] = r.translation;
          reuseRef.current.set(fk, store);
        }
        patchPack(item.key, (it) => ({
          ...it,
          entries: it.entries.map((e) => {
            const r = byKey.get(e.key);
            if (!r) return e;
            return { ...e, ...entryPatchFromResult(r) };
          }),
        }));
        doneAny = true;
        const c0 = packCountsRef.current.get(item.key) ?? {
          ok: 0, empty: 0, error: 0, error429: 0, warn: 0, same: 0,
        };
        // 每个内容包单独弹出完成卡片；包数很多时改为静默累计，避免上千条通知拖垮界面
        if (suppressPackCards) {
          totalOk += c0.ok;
          totalErr += c0.error;
          totalEmpty += c0.empty;
          cardsCounted += 1;
        } else {
          const a = buildResultAlert(c0, t);
          showResultCard(
            a.type,
            `翻译 ${item.name} ${t(KIND_META[item.kind].labelKey)}完成`,
            a.desc,
          );
        }
        // 汇总「译文与原文相同」：不逐包弹窗，翻译完成后在汇总标签页统一清除
        const sameN = preSame + c0.same;
        if (sameN >= 5) {
          localSameWarn.push({ packKey: item.key, name: item.name, count: sameN });
        }
      } finally {
        setTranslatingKeys((prev) => {
          const next = { ...prev };
          delete next[item.key];
          return next;
        });
        // 同步清理该包进度：否则进度表会累积到上千个键，每次进度更新都要复制整表
        setPackProgress((prev) => {
          if (!prev[item.key]) return prev;
          const next = { ...prev };
          delete next[item.key];
          return next;
        });
      }
    };

    try {
      // 包并行池：同时最多 packLimit 个包在翻译；每个包只入队一次，天然不会重复翻译
      const packLimit = (settings.packParallelEnabled ?? false)
        ? (settings.packParallelCount ?? 2) === 0
          ? Infinity
          : Math.max(1, settings.packParallelCount ?? 2)
        : 1;
      let nextIdx = 0;
      const worker = async (): Promise<void> => {
        while (!cancelRequestedRef.current) {
          const i = nextIdx++;
          if (i >= tasks.length) return;
          const tk = tasks[i];
          await translateOnePack(tk.item, tk.untranslated, tk.preSame);
        }
      };
      await Promise.all(Array.from({ length: Math.min(packLimit, tasks.length) }, () => worker()));

      // 翻译结束：把本轮涉及的包放进后台批量命名（一次请求多个包名，分批间隔执行）
      if ((settings.exportNaming ?? "suffix") === "ai") {
        void startAiNameJob(targets);
      }
      if (cancelRequestedRef.current) {
        message.info("已取消，已翻译部分已保留");
      } else if (doneAny) {
        // 大批量运行：结束时给一条汇总（替代逐包通知）
        if (suppressPackCards && cardsCounted > 0) {
          const parts = [`已完成 ${cardsCounted} 个内容包：成功 ${totalOk} 条`];
          if (totalEmpty > 0) parts.push(`AI 未返回 ${totalEmpty} 条`);
          if (totalErr > 0) parts.push(`失败 ${totalErr} 条`);
          message.success(parts.join("，"));
        }
        // 术语表建议：高频已翻译短语（并入汇总弹窗，不单独弹）
        const sugg = collectSuggestions(
          queue.flatMap((q) => q.entries),
          settings.userGlossary ?? [],
        );
        setSameWarnPacks(localSameWarn);
        setSameWarnChecked(localSameWarn.map((w) => w.packKey));
        if (sugg.length > 0) {
          setGlossarySuggest(sugg);
          setSuggestChecked(sugg.map(([en]) => en));
        }
        // 原文一致 / 术语提取 / 术语建议 → 合并为单个汇总弹窗
        if (localSameWarn.length > 0 || extractedGlossaryRef.current.length > 0 || sugg.length > 0) {
          setTransSummaryOpen(true);
        }
      } else {
        message.info("勾选的内容包没有需要翻译的条目（可能已全部翻译）");
      }
    } catch (e) {
      message.error(`翻译失败：${String(e)}`);
    }
    // 兜底：无论成功/取消/异常，清除所有条目的「翻译中」标记，
    // 避免取消后尚有未完成的条目残留淡蓝底色。
    setQueue((prev) =>
      prev.map((it) => ({
        ...it,
        entries: it.entries.map((e) =>
          e.translating ? { ...e, translating: false } : e,
        ),
      })),
    );
    setTranslating(false);
    setProgress(null);
    setCurrentPackName("");
  }

  function handleCancel() {
    cancelRequestedRef.current = true;
    void api.cancelTranslation();
    message.info("正在停止…当前批次完成后结束");
  }

  function handlePause() {
    setPaused(true);
    void api.pauseTranslation();
    message.info("已暂停，当前批次完成后停止");
  }

  function handleResume() {
    setPaused(false);
    void api.resumeTranslation();
  }

  /** 清除译文：只清除当前页勾选的内容包译文 */
  function handleClear() {
    setClearOpen(true);
  }

  /** 翻译完成汇总：统一执行勾选动作（清除一致译文 + 加入选中术语） */
  async function execTransSummary() {
    if (!settings) return;
    // 1. 清除勾选包的「译文与原文相同」
    const checkedSet = new Set(sameWarnChecked);
    let cleared = 0;
    if (checkedSet.size > 0) {
      for (const it of queue) {
        if (!checkedSet.has(it.key)) continue;
        cleared += it.entries.filter(
          (e) => e.status === "aiTranslated" && e.translation != null && e.translation === e.source,
        ).length;
      }
      setQueue((prev) =>
        prev.map((it) => {
          if (!checkedSet.has(it.key)) return it;
          return {
            ...it,
            entries: it.entries.map((e) =>
              e.status === "aiTranslated" && e.translation != null && e.translation === e.source
                ? { ...e, translation: null, status: "untranslated" as const, notes: [] }
                : e,
            ),
          };
        }),
      );
    }
    // 2. 加入勾选的术语（提取的 + 建议的合并去重，已在术语表中的跳过）
    const picked = new Set([...extractedChecked, ...suggestChecked]);
    const glossaryBase = settingsRef.current ?? settings;
    const already = new Set((glossaryBase.userGlossary ?? []).map(([en]) => en.toLowerCase()));
    const seen = new Map<string, string>();
    for (const [en, zh] of [...(extractedGlossary ?? []), ...(glossarySuggest ?? [])]) {
      if (!picked.has(en) || already.has(en.toLowerCase()) || seen.has(en)) continue;
      seen.set(en, zh);
    }
    if (seen.size > 0) {
      const next = {
        ...glossaryBase,
        userGlossary: [...(glossaryBase.userGlossary ?? []), ...seen.entries()],
      };
      try {
        await api.patchSettings({ userGlossary: next.userGlossary });
        setSettings(next);
      } catch (e) {
        message.error(String(e));
      }
    }
    setTransSummaryOpen(false);
    const parts: string[] = [];
    if (cleared > 0) parts.push(`已清除 ${cleared} 条与原文相同的译文（重新点击翻译可重试）`);
    if (seen.size > 0) parts.push(`已加入 ${seen.size} 条术语到用户术语表`);
    message.success(parts.length > 0 ? parts.join("，") : "未选择任何待处理项");
  }

  function doClear() {
    const checkedKeys = new Set(
      queue.filter((it) => it.kind === activeTab && it.checked).map((it) => it.key),
    );
    setQueue((prev) =>
      prev.map((it) => {
        if (!checkedKeys.has(it.key)) return it;
        return {
          ...it,
          entries: it.entries.map((e) => ({
            ...e,
            translation: null,
            status: "untranslated" as const,
            notes: [],
          })),
        };
      }),
    );
    setClearOpen(false);
    message.success(`已清除 ${checkedKeys.size} 个内容包的译文`);
  }

  /** 清空当前内容类型页的列表（只移除当前类型的包） */
  function handleClearCurrentTab() {
    const kindLabel = t(KIND_META[activeTab].labelKey);
    Modal.confirm({
      title: `清空${kindLabel}页的列表？`,
      content: `将移除${kindLabel}页的全部内容包及其译文（不影响其他页），此操作不可撤销。`,
      okText: "清空",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        setQueue((prev) => prev.filter((it) => it.kind !== activeTab));
        if (selectedKey && queue.find((q) => q.key === selectedKey)?.kind === activeTab) {
          setSelectedKey(null);
        }
        setProgress(null);
        setTranslating(false);
        void api.clearSessionCache("free");
        void api.sessionV2Clear("free");
        message.success(`已清空${kindLabel}页的列表`);
      },
    });
  }

  /** 清除当前内容类型页勾选的内容包 */
  function handleRemoveChecked() {
    const checkedInTab = queue.filter((it) => it.kind === activeTab && it.checked);
    if (checkedInTab.length === 0) {
      message.info("当前页没有勾选的内容包");
      return;
    }
    Modal.confirm({
      title: `清除勾选的 ${checkedInTab.length} 个内容包？`,
      content: "将移除勾选的内容包及其译文（未勾选的保留），此操作不可撤销。",
      okText: "清除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        const removedKeys = new Set(checkedInTab.map((it) => it.key));
        setQueue((prev) => prev.filter((it) => !removedKeys.has(it.key)));
        if (selectedKey && removedKeys.has(selectedKey)) setSelectedKey(null);
        message.success(`已清除 ${checkedInTab.length} 个内容包`);
      },
    });
  }

  /** 卡片「深度扫描」按钮：手动触发 */
  const runDeepScanFromCard = useCallback(
    async (key: string) => {
      // 通过 ref 取最新队列，避免依赖 queue 导致回调身份变化（否则 PackCard 的 memo 全部失效）
      const item = queueRef.current.find((it) => it.key === key);
      if (!item || (item.kind !== "mod" && item.kind !== "plugin")) return;
      setDeepScanningKey(key);
      try {
        const n = await applyDeepScan(item);
        setQueue((prev) => prev.map((it) => (it.key === key ? { ...item } : it)));
        if (n > 0) {
          message.success(`模组深度扫描发现 ${n} 条内嵌文本（默认未勾选，可在卡片上勾选分组）`);
        } else {
          message.info("未发现额外可翻译文本（可能无内嵌文本，或文本在 .class 代码中）");
        }
      } catch (e) {
        message.error(`模组深度扫描失败：${String(e)}`);
      }
      setDeepScanningKey(null);
    },
    [],
  );

  /** 卡片深度扫描入口：稳定身份传给 memo 化的 PackCard */
  const handleCardDeepScan = useCallback((k: string) => void runDeepScanFromCard(k), [runDeepScanFromCard]);

  /** 清除用户数据后：丢弃内存中的列表与各类缓存引用，再从磁盘重新加载默认设置 */
  const handleUserDataCleared = useCallback(async () => {
    cancelRequestedRef.current = true;
    queueRef.current = [];
    setQueue([]);
    shardIdsRef.current.clear();
    writtenSigRef.current.clear();
    sessionDirtyRef.current = false;
    aiNamesRef.current = {};
    packCountsRef.current.clear();
    reuseRef.current.clear();
    lastPruneRef.current = 0;
    setTranslatingKeys({});
    setPackProgress({});
    setProgress(null);
    setTranslating(false);
    await reloadSettings();
  }, [reloadSettings]);

  /** 切换深度扫描分组勾选（勾选组 → 组内条目参与翻译/导出） */
  const toggleDeepGroup = useCallback(
    (packKey: string, groupKey: string, checked: boolean) => {
      patchPack(packKey, (it) => ({
        ...it,
        deepScanGroups: it.deepScanGroups?.map((g) =>
          g.key === groupKey ? { ...g, checked } : g,
        ),
        entries: it.entries.map((e) =>
          deepEntryGroup(e) === groupKey ? { ...e, selected: checked } : e,
        ),
      }));
    },
    [patchPack],
  );

  /** 批量命名：一次请求装多个包名，按编号回填；批次之间加间隔，结果分批落盘 */
  async function runNameBatches(
    list: PackItem[],
    intervalMs: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const BATCH = 20;
    let done = 0;
    let lastSaveAt = 0;
    for (let i = 0; i < list.length; i += BATCH) {
      // 偏好被改掉就立刻停（避免用户切回「原名」后还在偷偷烧 token）
      if ((settingsRef.current?.exportNaming ?? "suffix") !== "ai") break;
      const chunk = list.slice(i, i + BATCH);
      onProgress?.(done, list.length);
      try {
        const res = await api.generateAiNames(
          settingsRef.current!.provider,
          chunk.map((it) => ({
            id: aiKeyOf(it),
            displayName: it.name,
            kind: it.kind,
            gameVersion: it.gameVersion ?? null,
          })),
        );
        for (const [id, name] of Object.entries(res)) {
          if (name && name.trim()) aiNamesRef.current[id] = name.trim();
        }
      } catch (e) {
        // 单批失败：记录原因（首个），这批标记为已尝试，后台不再反复重试
        if (!aiNameErrRef.current) aiNameErrRef.current = String(e);
        for (const it of chunk) aiNameFailedRef.current.add(aiKeyOf(it));
      }
      done += chunk.length;
      onProgress?.(done, list.length);
      // 渐进落盘：最多每 10s 写一次，崩溃也不至于全丢
      if (Date.now() - lastSaveAt > 10000) {
        lastSaveAt = Date.now();
        await persistAiNames();
      }
      if (i + BATCH < list.length) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** 把已生成的名称合并进设置（一次 saveSettings） */
  async function persistAiNames(): Promise<void> {
    const cur = settingsRef.current;
    if (!cur) return;
    const buf = aiNamesRef.current;
    if (Object.keys(buf).length === 0) return;
    const merged = { ...(cur.aiNames ?? {}), ...buf };
    const next = { ...cur, aiNames: merged };
    try {
      await api.patchSettings({ aiNames: merged });
      settingsRef.current = next;
      setSettings(next);
    } catch {
      /* 落盘失败：名称仍在内存里，下次会再试 */
    }
  }

  /** 后台启动批量命名（不阻塞界面；同一时刻只跑一个任务） */
  function startAiNameJob(packs: PackItem[]): Promise<void> {
    const running = aiNameJobRef.current;
    if (running) return running;
    const names = { ...(settingsRef.current?.aiNames ?? {}), ...aiNamesRef.current };
    const todo = packs.filter(
      (it) => !names[aiKeyOf(it)] && !aiNameFailedRef.current.has(aiKeyOf(it)),
    );
    if (todo.length === 0 || (settingsRef.current?.exportNaming ?? "suffix") !== "ai") {
      return Promise.resolve();
    }
    const job = (async () => {
      const key = "ai-name-job";
      try {
        await runNameBatches(todo, 3000, (done, total) => {
          message.loading({ content: t("app.aiNameProgress", { done, total }), key, duration: 0 });
        });
        await persistAiNames();
        const missed = todo.filter((it) => !(settingsRef.current?.aiNames ?? {})[aiKeyOf(it)]).length;
        if (missed > 0) {
          message.warning(
            t("app.aiNameFailed", { n: missed, reason: aiNameErrRef.current ?? "-" }),
            6,
          );
        }
        aiNameErrRef.current = null;
      } finally {
        message.destroy(key);
        aiNameJobRef.current = null;
      }
    })();
    aiNameJobRef.current = job;
    return job;
  }

  /** 导出前确保名称就绪：先等正在跑的后台任务，再同步补齐缺的（供导出使用） */
  async function ensureAiNames(packs: PackItem[]): Promise<{
    naming: "raw" | "suffix" | "ai";
    names: Record<string, string>;
  }> {
    const naming = (settingsRef.current?.exportNaming ?? "suffix") as "raw" | "suffix" | "ai";
    if (naming !== "ai") {
      return { naming, names: { ...(settingsRef.current?.aiNames ?? {}) } };
    }
    if (aiNameJobRef.current) await aiNameJobRef.current.catch(() => {});
    const names = { ...(settingsRef.current?.aiNames ?? {}), ...aiNamesRef.current };
    const missing = packs.filter((it) => !names[aiKeyOf(it)]);
    if (missing.length === 0) return { naming, names };
    if (!settingsRef.current?.provider.apiKey || !settingsRef.current.provider.model) {
      message.warning(t("app.aiNameNoKey", { n: missing.length }));
      return { naming, names };
    }
    const key = "ai-name-job";
    try {
      // 导出时用户就在等：间隔缩短，但仍分批，避免一口气打出几十个请求
      await runNameBatches(missing, 1200, (done, total) => {
        message.loading({ content: t("app.aiNameProgress", { done, total }), key, duration: 0 });
      });
      await persistAiNames();
    } finally {
      message.destroy(key);
    }
    const finalNames = { ...(settingsRef.current?.aiNames ?? {}), ...aiNamesRef.current };
    const missed = packs.filter((it) => !finalNames[aiKeyOf(it)]).length;
    if (missed > 0) {
      message.warning(t("app.aiNameFailed", { n: missed, reason: aiNameErrRef.current ?? "-" }), 6);
    }
    aiNameErrRef.current = null;
    return { naming, names: finalNames };
  }

  /** 导出（按类型分流） */
  async function handleExport() {
    const checked = queue.filter((it) => it.checked);
    if (checked.length === 0) {
      message.info("请先勾选要导出的内容包");
      return;
    }
    const hasGamedir = checked.some((it) => it.gameVersion);
    const kinds = new Set(checked.map((c) => c.kind));
    // AI 命名偏好：先把缺失的名称补齐（含已翻译过、跳过翻译循环的包）
    const { naming, names: aiNameMap } = await ensureAiNames(checked);

    // 混合类型或含游戏目录来源 → 统一按 版本/类别 子文件夹逐包导出
    if (hasGamedir || kinds.size > 1) {
      const dir = asDir(await open({
        directory: true,
        title: "选择导出根目录（自动按 版本/类别 建立子文件夹）",
      }));
      if (!dir) return;
      let ok = 0;
      let skipped = 0;
      let aiFallback = 0;
      const generated: string[] = [];
      const kindFolder: Record<PackKind, string> = {
        mod: "mods",
        shader: "shaderpacks",
        resourcepack: "resourcepacks",
        plugin: "plugins",
      };
      for (const it of checked) {
        const translated = it.entries.filter((e) => (e.selected ?? true) && e.translation);
        if (translated.length === 0) {
          skipped += 1;
          continue;
        }
        try {
          const ver = it.gameVersion ?? "公共目录";
          const nm = exportNameFor(it, naming, aiNameMap);
          if (nm.fallback) aiFallback += 1;
          if (it.kind === "mod") {
            const dest = await uniqueDest(`${vdirFor(dir, it)}/mods`, nm.base, nm.suffix, ".jar");
            await api.exportModJar(it.sourcePath, dest, it.modFile?.modid ?? "mod", translated, it.langFormat ?? "json");
          } else if (it.kind === "shader") {
            const dest = await uniqueDest(`${vdirFor(dir, it)}/shaderpacks`, nm.base, nm.suffix, ".zip");
            await api.exportShaderZh(it.sourcePath, dest, translated);
          } else if (it.kind === "plugin") {
            const dest = await uniqueDest(`${vdirFor(dir, it)}/plugins`, nm.base, nm.suffix, ".jar");
            await api.exportPluginJar(it.sourcePath, dest, pluginItems(translated));
          } else {
            const dest = await uniqueDest(`${vdirFor(dir, it)}/resourcepacks`, nm.base, nm.suffix, ".zip");
            await api.exportResourcePackDesc(it.sourcePath, dest, translated);
          }
          generated.push(`${dir}/${ver}/${kindFolder[it.kind]}/`);
          ok += 1;
        } catch (e) {
          message.error(`「${it.name}」导出失败：${String(e)}`);
        }
      }
      if (ok > 0) notifyExport(`已导出 ${ok} 个内容包（按版本分类）`, [...new Set(generated)]);
      if (aiFallback > 0)
        message.info(`${aiFallback} 个内容包没有 AI 中文名（未翻译或未生成），已回退为原名_zh_cn`);
      if (skipped > 0) message.warning(`${skipped} 个内容包没有可导出的译文（请先翻译）`);
      return;
    }

    // 纯自由导入：保留原有分支（光影 / 资源包直接导出，模组走合并/单包弹窗）
    const kind = checked[0].kind;

    if (kind === "plugin") {
      const dir = asDir(await open({ directory: true, title: "选择导出目录（生成汉化插件 jar）" }));
      if (!dir) return;
      let ok = 0;
      let skipped = 0;
      let aiFallback = 0;
      const generated: string[] = [];
      for (const it of checked) {
        const translated = it.entries.filter((e) => (e.selected ?? true) && e.translation);
        if (translated.length === 0) {
          skipped += 1;
          continue;
        }
        try {
          const nm = exportNameFor(it, naming, aiNameMap);
          if (nm.fallback) aiFallback += 1;
          const dest = await uniqueDest(`${dir}/plugins`, nm.base, nm.suffix, ".jar");
          const msg = await api.exportPluginJar(it.sourcePath, dest, pluginItems(translated));
          if (msg) message.success(msg);
          generated.push(`${dir}/plugins/`);
          ok += 1;
        } catch (e) {
          message.error(`「${it.name}」导出失败：${String(e)}`);
        }
      }
      if (ok > 0) notifyExport(`已导出 ${ok} 个汉化插件`, [...new Set(generated)]);
      if (skipped > 0) message.warning(`${skipped} 个插件没有可导出的译文（请先翻译）`);
      setExportOpen(false);
      return;
    }

    if (kind === "shader") {
      const dir = asDir(await open({ directory: true, title: "选择导出目录（生成汉化光影包）" }));
      if (!dir) return;
      let ok = 0;
      let skipped = 0;
      const generated: string[] = [];
      for (const it of checked) {
        const translated = it.entries.filter(
          (e) => (e.selected ?? true) && e.translation,
        );
        if (translated.length === 0) {
          skipped += 1;
          continue;
        }
        try {
          const nm = exportNameFor(it, naming, aiNameMap);
          const dest = await uniqueDest(dir, nm.base, nm.suffix, ".zip");
          await api.exportShaderZh(it.sourcePath, dest, translated);
          generated.push(dest);
          ok += 1;
        } catch (e) {
          message.error(`「${it.name}」导出失败：${String(e)}`);
        }
      }
      if (ok > 0) notifyExport(`已生成 ${ok} 个汉化光影包`, generated);
      if (skipped > 0)
        message.warning(`${skipped} 个光影包没有可导出的译文（请先翻译，或检查条目勾选状态）`);
      if (ok === 0 && skipped === 0)
        message.warning(
          t("app.noTranslations"),
        );
      return;
    }
    if (kind === "resourcepack") {
      const dir = asDir(await open({ directory: true, title: "选择导出目录（生成改描述的资源包）" }));
      if (!dir) return;
      let ok = 0;
      let skipped = 0;
      const generated: string[] = [];
      for (const it of checked) {
        const translated = it.entries.filter(
          (e) => (e.selected ?? true) && e.translation,
        );
        if (translated.length === 0) {
          skipped += 1;
          continue;
        }
        try {
          const nm = exportNameFor(it, naming, aiNameMap);
          const dest = await uniqueDest(dir, nm.base, nm.suffix, ".zip");
          await api.exportResourcePackDesc(it.sourcePath, dest, translated);
          generated.push(dest);
          ok += 1;
        } catch (e) {
          message.error(`「${it.name}」导出失败：${String(e)}`);
        }
      }
      if (ok > 0) notifyExport(`已生成 ${ok} 个资源包`, generated);
      if (skipped > 0)
        message.warning(`${skipped} 个资源包没有可导出的译文（请先翻译，或检查条目勾选状态）`);
      if (ok === 0 && skipped === 0)
        message.warning(
          t("app.noTranslations"),
        );
      return;
    }
    // 模组：弹窗选合并资源包 / 汉化 jar
    setExportOpen(true);
  }

  async function handleExportPack() {
    const checked = queue.filter((it) => it.checked && it.kind === "mod");
    if (checked.length === 0) return;
    const detected = packFormatForMc(
      checked.map((c) => c.modFile?.mcVersion ?? null).find((v) => v) ?? null,
    );
    setCustomPackFormat(detected ?? 15);
    setPackMode("auto");
    setExportSettingsOpen(true);
  }

  async function doExportPack() {
    const checked = queue.filter((it) => it.checked && it.kind === "mod");
    if (checked.length === 0) return;
    const packFormat =
      packMode === "auto" ? (customPackFormat || 15) : customPackFormat;
    const dir = asDir(await open({
      directory: true,
      title: "选择导出目录（生成 mods_zh_cn.zip 合并资源包）",
    }));
    if (!dir) return;
    try {
      // 按来源版本分组导出（游戏目录模式：每个版本一个合并包；自由导入：单组）
      const groups = new Map<string, PackItem[]>();
      for (const it of checked) {
        const k = it.gameVersion ?? "__all__";
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(it);
      }
      const generated: string[] = [];
      let totalMods = 0;
      for (const [ver, items] of groups) {
        const bundles: ResourcePackBundle[] = items.map((it) => ({
          modid: it.modFile?.modid ?? "mod",
          modName: it.name,
          entries: it.entries.filter((e) => e.selected !== false),
          langFormat: it.langFormat ?? "json",
        }));
        const outDir = ver === "__all__" ? dir : `${dir}/${ver}`;
        const path = await api.exportResourcePackMulti(outDir, bundles, packFormat);
        generated.push(path);
        totalMods += items.length;
      }
      notifyExport(`已导出合并汉化资源包（${totalMods} 个模组）`, generated);
      setExportSettingsOpen(false);
      setExportOpen(false);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleExportJar() {
    const checked = queue.filter((it) => it.checked && it.kind === "mod");
    if (checked.length === 0) return;
    // 含深度扫描条目（已勾选）→ 弹风险确认
    const hasDeep = checked.some((it) =>
      it.entries.some((e) => (e.selected ?? false) && deepEntryGroup(e)),
    );
    if (hasDeep) {
      setExportRiskChecked(checked);
      setExportRiskOpen(true);
      return;
    }
    await doExportJar(checked, true);
  }

  /** 导出汉化 jar（skipDeep = 跳过深度扫描内嵌文本，避免影响模组运行） */
  async function doExportJar(checked: PackItem[], skipDeep: boolean) {
    const dir = asDir(await open({
      directory: true,
      title: `选择目录（将生成 ${checked.length} 个汉化 jar，不覆盖原文件）`,
    }));
    if (!dir) return;
    // AI 命名偏好：缺失的名称在此补齐（与 handleExport 同一逻辑）
    const { naming, names: aiNameMap } = await ensureAiNames(checked);
    let ok = 0;
    const generated: string[] = [];
    for (const it of checked) {
      const translated = it.entries.filter((e) => {
        if (skipDeep && deepEntryGroup(e)) return false;
        return (e.selected ?? true) && e.translation;
      });
      if (translated.length === 0) {
        message.warning(t("app.noExportItem", { name: it.name }));
        continue;
      }
      try {
        const nm = exportNameFor(it, naming, aiNameMap);
        const dest = await uniqueDest(vdirFor(dir, it), nm.base, nm.suffix, ".jar");
        await api.exportModJar(
          it.sourcePath,
          dest,
          it.modFile?.modid ?? "mod",
          translated,
          it.langFormat ?? "json",
        );
        generated.push(dest);
        ok += 1;
      } catch (e) {
        message.error(`「${it.name}」导出失败：${String(e)}`);
      }
    }
    if (ok > 0) {
      notifyExport(`已生成 ${ok} 个汉化 jar`, generated);
      setExportOpen(false);
    } else {
      message.warning(
        t("app.noTranslations"),
      );
    }
  }

  // 以下统计都基于队列全量遍历，memo 化避免每次渲染（进度事件、输入框敲键等）重复计算
  /** 卡片悬停摘要：当前生效规则条数与自动开关状态 */
  const deepScanSummaryOf = useCallback(
    (it: PackItem): string => {
      const r = effectiveDeepRules(it, settingsRef.current);
      if (!r) return "";
      const n = DEEP_RULE_KEYS.filter((k) => r[k]).length + r.custom.filter((c) => c.enabled).length;
      const auto = t(r.auto ? "settings.deepScan.autoOn" : "settings.deepScan.autoOff");
      const overridden = it.deepScanOverride ? `${t("settings.deepScan.packOverridden")} · ` : "";
      return `${overridden}${t("settings.deepScan.summary", { n, auto })}`;
    },
    [t],
  );

  const visibleQueue = useMemo(() => queue.filter((it) => it.kind === activeTab), [queue, activeTab]);
  const allChecked = useMemo(
    () => visibleQueue.length > 0 && visibleQueue.every((it) => it.checked),
    [visibleQueue],
  );
  const checkedInTab = useMemo(
    () => visibleQueue.reduce((n, it) => n + (it.checked ? 1 : 0), 0),
    [visibleQueue],
  );
  const checkedMods = useMemo(
    () => queue.reduce((n, it) => n + (it.checked && it.kind === "mod" ? 1 : 0), 0),
    [queue],
  );
  // 上下文面板的全局条目视图：仅在选中条目（抽屉打开）时才计算，避免每次渲染做 O(N·M) 展开
  const deferredQueue = useDeferredValue(queue);
  const allEntries = useMemo(
    () => (selectedKey ? deferredQueue.flatMap((q) => q.entries) : []),
    [deferredQueue, selectedKey],
  );
  // 分页渲染：只挂载前 packRenderLimit 个卡片，滚动到底/点按钮续加载。
  // 按类型页分别记忆：切回来时保留此前已加载到的数量，不会「重新从 50 个开始」
  const [packRenderLimits, setPackRenderLimits] = useState<Record<string, number>>({});
  const packRenderLimit = packRenderLimits[activeTab] ?? PACK_RENDER_STEP;
  const bumpRenderLimit = useCallback(() => {
    // 挂载新卡片是非紧急更新，放进 transition 让滚动/点击保持跟手
    startTransition(() => {
      setPackRenderLimits((prev) => ({
        ...prev,
        [activeTab]: (prev[activeTab] ?? PACK_RENDER_STEP) + PACK_RENDER_STEP,
      }));
    });
  }, [activeTab]);
  const shownQueue = useMemo(
    () => (visibleQueue.length > packRenderLimit ? visibleQueue.slice(0, packRenderLimit) : visibleQueue),
    [visibleQueue, packRenderLimit],
  );

  const selectedEntry = useMemo(() => {
    if (!selectedKey) return null;
    // 先查当前类型页（命中率最高），再兜底全队列
    for (const it of visibleQueue) {
      const e = it.entries.find((x) => x.key === selectedKey);
      if (e) return e;
    }
    for (const it of queue) {
      if (it.kind === activeTab) continue;
      const e = it.entries.find((x) => x.key === selectedKey);
      if (e) return e;
    }
    return null;
  }, [queue, visibleQueue, activeTab, selectedKey]);

  const progressPercent = progress
    ? Math.round((progress.doneCount / Math.max(1, progress.totalCount)) * 100)
    : 0;

  return (
    <Layout style={{ height: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingInline: 20,
          borderBottom: "1px solid var(--border-color, #E6E8EB)",
        }}
      >
        <Space size="middle">
          <Typography.Title level={4} style={{ margin: 0 }} className="app-title-text">
            <img src="/app-icon.svg" alt="" style={{ height: 26, verticalAlign: "middle" }} />
            <span style={{ marginLeft: 8 }}>{t("app.title")}</span>
          </Typography.Title>
          {queue.length > 0 && <Tag color="blue">{queue.length} {t("app.tag")}</Tag>}
        </Space>
        <Segmented
          value={workMode}
          onChange={(v) => setWorkMode((v as string) === "gamedir" ? "gamedir" : "free")}
          options={[
            { label: "自由导入", value: "free" },
            { label: "游戏目录", value: "gamedir" },
          ]}
        />
        <Space>
          <Button type="text" icon={<GithubOutlined />} onClick={openGithub} className="app-github-btn">
            {t("app.github")}
          </Button>
          <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} className="app-settings-btn">
            {t("app.settings")}
          </Button>
          {__DEVTOOLS__ && devFaultSummary && (
            <Tag color="warning" style={{ marginRight: 0 }}>
              ⚠ {t("devtools.injection.faultTag", { summary: devFaultSummary })}
            </Tag>
          )}
          {__DEVTOOLS__ && (
            <Button
              icon={<ToolOutlined />}
              onClick={() => {
                void invoke("dev_open_devtools_window", { title: t("devtools.title") }).catch(
                  (e) => message.error(String(e)),
                );
              }}
            />
          )}
        </Space>
      </Header>

      <Layout>
        {/* 左侧导航：自由导入 = 内容包类型；游戏目录 = 版本列表（GameDirView 内置） */}
        {workMode === "free" && (
        <Sider width={200} style={{ borderRight: "1px solid var(--border-color, #E6E8EB)", paddingTop: 12 }}>
          <div style={{ padding: "0 12px" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 8 }} className="sider-label-text">
              {t("app.contentKind")}
            </Typography.Text>
            <SlideNav
              items={(Object.keys(KIND_META) as PackKind[]).map((k) => ({
                key: k,
                label: t(KIND_META[k].labelKey),
                icon: KIND_META[k].icon,
              }))}
              activeKey={activeTab}
              onSelect={(k) => {
                // 切换类型页会挂载/卸载整页卡片，放进 transition 让点击反馈保持跟手
                startTransition(() => setActiveTab(k as PackKind));
              }}
            />
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: "block", marginTop: 16, paddingLeft: 8 }}
              className="sider-label-text"
            >
              {visibleQueue.length}
            </Typography.Text>
          </div>
        </Sider>
        )}

        <Content style={{ padding: 12, overflow: "auto" }}>
          <div style={{ display: workMode === "gamedir" ? "block" : "none" }}>
          {settings && (
          <GameDirView
              settings={settings}
              onSettingsUpdate={setSettings}
              autoScanDir={gamedirAutoScan}
              onAutoScanConsumed={() => setGamedirAutoScan(null)}
              addProgress={gdAddProgress}
              onAddToQueue={async (packs) => {
                const added: PackItem[] = [];
                let skipped = 0;
                const existing = new Set(queue.map((x) => x.sourcePath));
                const emptyPacks: typeof packs = [];
                // 解析失败的文件名（此前静默计入 skipped，用户看不到原因）
                const failed: string[] = [];
                for (let i = 0; i < packs.length; i++) {
                  const gp = packs[i];
                  setGdAddProgress({ done: i, total: packs.length, current: gp.fileName });
                  if (existing.has(gp.path)) {
                    skipped += 1;
                    continue;
                  }
                  try {
                    let entries: LangEntry[];
                    let modFile: ModFile | undefined;
                    let pluginFile: PluginFile | undefined;
                    let name: string;
                    let hasZh: boolean | undefined;
                    let zhCount: number | undefined;
                    if (gp.kind === "mod") {
                      const mf = await api.parseJar(gp.path);
                      entries = mf.entries;
                      modFile = mf;
                      name = mf.modName;
                      hasZh = mf.hasZh;
                      zhCount = mf.zhCount;
                    } else if (gp.kind === "plugin") {
                      const pf = await api.parsePluginJar(gp.path);
                      entries = pf.entries;
                      pluginFile = pf;
                      name = pf.pluginName;
                      hasZh = pf.hasZh;
                      zhCount = pf.zhCount;
                    } else if (gp.kind === "shader") {
                      const sp = await api.parseShaderPack(gp.path);
                      entries = sp.entries;
                      name = sp.name;
                    } else {
                      const rp = await api.parseResourcePack(gp.path);
                      entries = rp.entries;
                      name = rp.name;
                    }
                    if (entries.length === 0) {
                      emptyPacks.push(gp);
                      continue;
                    }
                    added.push({
                      key: "gd-" + gp.path,
                      kind: gp.kind,
                      name,
                      fileName: gp.fileName,
                      sourcePath: gp.path,
                      expanded: false,
                      checked: true,
                      height: 480,
                      entries: entries.map((e) => ({ ...e, selected: e.selected ?? true })),
                      modFile,
                      pluginFile,
                      hasZh,
                      zhCount,
                      langFormat: "json",
                      gameVersion: gp.gameVersion,
                    });
                  } catch (e) {
                    skipped += 1;
                    failed.push(`${gp.fileName}：${String(e).slice(0, 80)}`);
                  }
                }
                // 条目为空的包 → 聚合到导入检查弹窗，勾选后统一深度扫描（不再阻塞逐包询问）
                if (emptyPacks.length > 0) {
                  const gdMods = emptyPacks.filter((gp) => gp.kind === "mod");
                  const gdOthers = emptyPacks.filter((gp) => gp.kind !== "mod");
                  const decided = await new Promise<{ deepKeys: string[]; zhKeys: string[]; autoDeep: boolean }>(
                    (resolve) => {
                      importReviewResolve.current = resolve;
                      setImportReview({
                        added: added.length,
                        deepFound: 0,
                        failures: [],
                        zhPacks: [],
                        emptyMods: [],
                        emptyInfo: gdOthers.map((gp) => gp.fileName),
                        gdEmptyMods: gdMods.map((gp) => ({ path: gp.path, fileName: gp.fileName, kind: gp.kind })),
                        batchWarn: null,
                      });
                      setReviewContinueZh([]);
                      setReviewDeepScan(gdMods.map((gp) => gp.path));
                      setReviewAutoDeep(false);
                      setImportReviewOpen(true);
                    },
                  );
                  importReviewResolve.current = null;
                  const deepSet = new Set(decided.deepKeys);
                  for (const gp of gdMods) {
                    if (!deepSet.has(gp.path)) {
                      skipped += 1;
                      continue;
                    }
                    try {
                      const res = await api.deepScanJar(
                        gp.path,
                        gp.fileName.replace(/\.jar$/i, ""),
                        // 与手动深度扫描走同一套生效规则（全局模组规则），避免两处结果不一致
                        settingsRef.current?.deepScanRules?.mod ?? undefined,
                      );
                      if (res.entries.length === 0) {
                        skipped += 1;
                        continue;
                      }
                      added.push({
                        key: "gd-" + gp.path,
                        kind: gp.kind,
                        name: gp.fileName.replace(/\.(jar|zip)$/i, ""),
                        fileName: gp.fileName,
                        sourcePath: gp.path,
                        expanded: false,
                        checked: true,
                        height: 480,
                        entries: res.entries.map((e) => ({
                          ...e,
                          selected: true,
                          notes: [...(e.notes ?? []), "深度扫描"],
                        })),
                        langFormat: "json",
                        gameVersion: gp.gameVersion,
                      });
                    } catch {
                      skipped += 1;
                    }
                  }
                  skipped += gdOthers.length;
                  const gdCur = settingsRef.current;
                  const gdAutoOn =
                    gdCur?.deepScanRules?.mod?.auto && gdCur?.deepScanRules?.plugin?.auto;
                  if (decided.autoDeep && gdCur?.deepScanRules && !gdAutoOn) {
                    const next = {
                      ...gdCur,
                      deepScanRules: {
                        mod: { ...gdCur.deepScanRules.mod, auto: true },
                        plugin: { ...gdCur.deepScanRules.plugin, auto: true },
                      },
                    };
                    try {
                      await api.patchSettings({ deepScanRules: next.deepScanRules });
                      setSettings(next);
                    } catch {
                      /* 忽略 */
                    }
                  }
                }
                if (added.length > 0) setQueue((prev) => [...prev, ...added]);
                setWorkMode("free");
                if (failed.length > 0) {
                  message.warning(`${failed.length} 个内容包解析失败：${failed.slice(0, 3).join("；")}${
                    failed.length > 3 ? ` 等 ${failed.length} 个` : ""
                  }`);
                }
                return { added: added.length, skipped };
              }}
            />
          )}
          </div>
          {workMode === "free" && (
          <>
          {visibleQueue.length === 0 ? (
            <div style={{ height: "100%" }}>
              <DropZone
                dragOver={dragOver}
                parsing={parsing}
                kind={activeTab}
                onPick={() => void pickFiles()}
              />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <Space style={{ marginBottom: 8 }} wrap>
                {translating ? (
                  <>
                    <Button icon={paused ? <PlayCircleOutlined /> : <PauseOutlined />} onClick={paused ? handleResume : handlePause}>
                      {paused ? t("app.resume") : t("app.pause")}
                    </Button>
                    <Button danger icon={<StopOutlined />} onClick={handleCancel}>
                      {t("app.cancelTranslate")}
                    </Button>
                  </>
                ) : (
                  <Button type="primary" icon={<ThunderboltOutlined />} disabled={parsing} onClick={() => void runTranslation()}>
                    {t("app.translate")}
                  </Button>
                )}
                <Button icon={<ExportOutlined />} disabled={translating} onClick={() => void handleExport()}>
                  {t("app.export")}
                </Button>
                <Button danger icon={<ClearOutlined />} disabled={translating} onClick={handleClear}>
                  {t("app.clearTranslations")}
                </Button>
                <Dropdown
                  disabled={translating}
                  menu={{
                    items: [
                      { key: "clearTab", label: `清空${t(KIND_META[activeTab].labelKey)}页列表` },
                      { key: "removeChecked", label: `清除勾选的内容包（${checkedInTab}）` },
                    ],
                    onClick: ({ key }) => {
                      if (key === "clearTab") handleClearCurrentTab();
                      else handleRemoveChecked();
                    },
                  }}
                >
                  <Button danger icon={<DeleteOutlined />}>
                    清除 <DownOutlined />
                  </Button>
                </Dropdown>
                <Button icon={<CloudUploadOutlined />} disabled={translating} onClick={() => void pickFiles()}>
                  {t("app.import")}
                </Button>
                <Checkbox
                  checked={allChecked}
                  indeterminate={visibleQueue.some((it) => it.checked) && !allChecked}
                  onChange={(e) => toggleAll(e.target.checked)}
                  disabled={translating}
                >
                  {t("app.checkAll")}
                </Checkbox>
          </Space>

              {translating && progress && (
                <Space style={{ marginBottom: 8 }} align="center">
                  <Typography.Text type="secondary">{t("app.translating")}{currentPackName}</Typography.Text>
                  <Progress
                    percent={progressPercent}
                    size="small"
                    style={{ width: 320 }}
                    status={paused ? "active" : undefined}
                    format={() => {
                      const elapsed = (Date.now() - translateStartRef.current) / 1000;
                      const rate =
                        elapsed > 1 && progress.doneCount > 0
                          ? progress.doneCount / elapsed
                          : 0;
                      const remain =
                        rate > 0 ? (progress.totalCount - progress.doneCount) / rate : 0;
                      const remainText =
                        remain > 0
                          ? ` 剩余约 ${remain < 60 ? `${Math.ceil(remain)}s` : `${Math.floor(remain / 60)}m${Math.ceil(remain % 60)}s`}`
                          : "";
                      return paused
                        ? `已暂停 ${progress.doneCount}/${progress.totalCount}`
                        : `${progress.doneCount}/${progress.totalCount}${remainText}`;
                    }}
                  />
                </Space>
              )}

              {/* 内容包队列卡片（memo 化：勾选/展开只重渲染对应卡片；分页挂载避免上千卡片卡顿） */}
              <div
                style={{ flex: 1, minHeight: 0, overflow: "auto" }}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  if (
                    packRenderLimit < visibleQueue.length &&
                    el.scrollTop + el.clientHeight >= el.scrollHeight - 400
                  ) {
                    bumpRenderLimit();
                  }
                }}
              >
                {shownQueue.map((it) => (
                  <PackCard
                    key={it.key}
                    item={it}
                    translating={translating}
                    thisTranslating={!!translatingKeys[it.key]}
                    packProgress={packProgress[it.key]}
                    onToggleExpanded={toggleExpanded}
                    onToggleChecked={toggleChecked}
                    onEdit={editTranslation}
                    onSelect={setSelectedKey}
                    onClear={clearTranslation}
                    onToggleSelected={toggleSelected}
                    onToggleAllSelected={toggleAllSelected}
                    onToggleManySelected={toggleManySelected}
                    onResize={startResize}
                    onDeepScan={handleCardDeepScan}
                    onToggleDeepGroup={toggleDeepGroup}
                    deepScanningKey={deepScanningKey}
                    deepScanSummary={deepScanSummaryOf(it)}
                    onOpenDeepRules={setDeepRulesFor}
                  />
                ))}
                {visibleQueue.length > shownQueue.length && (
                  <div style={{ textAlign: "center", padding: "10px 0 16px" }}>
                    <Button size="small" onClick={bumpRenderLimit}>
                      显示更多（已显示 {shownQueue.length} / {visibleQueue.length}）
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          </>
          )}
        </Content>
      </Layout>

      <Footer style={{ padding: "6px 12px", textAlign: "center", borderTop: "1px solid #E6E8EB" }}>
        <Space size="middle" wrap>
          <Typography.Text type="secondary">
            支持模组 jar · 服务器插件 · 光影包 · 资源包 · 勾选要翻译/导出的内容包
          </Typography.Text>
          <Typography.Link onClick={openGithub} style={{ fontWeight: 600 }}>
            <img src="/github.svg" alt="" style={{ height: 14, marginRight: 4, verticalAlign: "middle" }} /> 完全开源免费 · GitHub 项目地址
          </Typography.Link>
        </Space>
      </Footer>

      <Drawer
        title={selectedEntry ? `${selectedEntry.key}` : ""}
        open={!!selectedEntry}
        onClose={() => setSelectedKey(null)}
        width={420}
      >
        {selectedEntry && (
          <ContextPanel entry={selectedEntry} allEntries={allEntries} />
        )}
      </Drawer>

      <Modal title="导出模组" open={exportOpen} onCancel={() => setExportOpen(false)} footer={null} width={480}>
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Typography.Text type="secondary">
            将导出全部勾选的 {checkedMods} 个模组
          </Typography.Text>
          <Button block size="large" icon={<ExportOutlined />} onClick={() => void handleExportPack()}>
            导出合并汉化资源包（一个 .zip 管所有勾选模组）
          </Button>
          <Button block size="large" icon={<SaveOutlined />} onClick={() => void handleExportJar()}>
            生成汉化后的模组 jar（每模组一个，不覆盖原文件）
          </Button>
        </Space>
      </Modal>

      <Modal
        title="导出资源包设置"
        open={exportSettingsOpen}
        onCancel={() => setExportSettingsOpen(false)}
        onOk={() => void doExportPack()}
        okText="选择目录并导出"
        width={440}
      >
        <Typography.Text type="secondary">
          资源包 pack_format（依据 Minecraft Wiki；1.21.9+ 自动使用 min_format/max_format）
        </Typography.Text>
        <Radio.Group value={packMode} onChange={(e) => setPackMode(e.target.value)} style={{ marginTop: 12, width: "100%" }}>
          <Radio value="auto" style={{ display: "block", marginBottom: 12 }}>
            自动匹配 MC 版本（检测到 {customPackFormat}）
          </Radio>
          <Radio value="custom" style={{ display: "block" }}>
            自定义：
            {packMode === "custom" && (
              <InputNumber
                style={{ width: 120, marginLeft: 8 }}
                min={1}
                max={200}
                value={customPackFormat}
                onChange={(v) => setCustomPackFormat(v ?? 15)}
              />
            )}
          </Radio>
        </Radio.Group>
      </Modal>

      {/* 单包深度扫描规则：与设置里同款弹窗，自定义规则区只读，保存为「相对全局的差异」 */}
      {deepRulesFor &&
        (() => {
          const pack = queue.find((x) => x.key === deepRulesFor);
          if (!pack) return null;
          const base =
            pack.kind === "plugin" ? settings?.deepScanRules?.plugin : settings?.deepScanRules?.mod;
          if (!base) return null;
          return (
            <DeepScanRulesModal
              open
              key={pack.key}
              scopeKey={pack.key}
              kind={pack.kind === "plugin" ? "plugin" : "mod"}
              rules={{ ...base, ...(pack.deepScanOverride?.rules ?? {}) }}
              globalRules={base}
              customReadOnly
              customEnabled={pack.deepScanOverride?.customEnabled}
              previewTarget={pack.sourcePath}
              onClose={() => setDeepRulesFor(null)}
              onSave={({ rules: next, customEnabled }) => {
                // 只写入该包相对全局的差异，绝不回写全局设置；且仅存内存
                const diff = diffDeepRules(base, next);
                const baseCustom = new Map((base.custom ?? []).map((r) => [r.id, r.enabled]));
                const changedCustom: Record<string, boolean> = {};
                for (const [id, v] of Object.entries(customEnabled)) {
                  if ((baseCustom.get(id) ?? true) !== v) changedCustom[id] = v;
                }
                // 与全局完全一致 → 视为「跟随全局」，直接清掉覆盖（否则无法取消本包配置）
                const followsGlobal =
                  Object.keys(diff).length === 0 && Object.keys(changedCustom).length === 0;
                patchPack(pack.key, (it) => {
                  if (followsGlobal) {
                    const { deepScanOverride: _dropped, ...rest } = it;
                    return rest;
                  }
                  return {
                    ...it,
                    deepScanOverride: { rules: diff, customEnabled: changedCustom },
                  };
                });
                setDeepRulesFor(null);
                message.success(
                  t(
                    followsGlobal
                      ? "settings.deepScan.packFollowGlobal"
                      : "settings.deepScan.packSaved",
                  ),
                );
              }}
            />
          );
        })()}

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        onSaved={setSettings}
        onUserDataCleared={handleUserDataCleared}
      />

      {/* 聚合导入检查弹窗：导入完成后一次呈现（自带中文 / 空文本深度扫描 / 批次提示 / 解析失败） */}
      <Modal
        title="导入检查"
        open={importReviewOpen}
        onCancel={() => {
          importReviewResolve.current?.({ deepKeys: [], zhKeys: [], autoDeep: false });
          importReviewResolve.current = null;
          setImportReviewOpen(false);
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              importReviewResolve.current?.({ deepKeys: [], zhKeys: [], autoDeep: false });
              importReviewResolve.current = null;
              setImportReviewOpen(false);
            }}
          >
            暂不处理
          </Button>,
          <Button
            key="ok"
            type="primary"
            onClick={() => {
              importReviewResolve.current?.({ deepKeys: reviewDeepScan, zhKeys: reviewContinueZh, autoDeep: reviewAutoDeep });
              importReviewResolve.current = null;
              setImportReviewOpen(false);
            }}
          >
            执行勾选
          </Button>,
        ]}
        width={560}
      >
        {importReview && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              已导入 <b>{importReview.added}</b> 个内容包。
              {importReview.deepFound > 0 && `深度扫描发现 ${importReview.deepFound} 条内嵌文本（默认未勾选）。`}
            </Typography.Paragraph>
            {/* 自带中文 */}
            {importReview.zhPacks.length > 0 && (
              <div>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {importReview.zhPacks.length} 个内容包自带中文（已预填译文）
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "2px 0 4px" }}>
                  勾选 = 继续 AI 汉化剩余部分；取消勾选 = 保留自带中文、不参与后续翻译。
                </Typography.Text>
                <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid #F0F2F5", borderRadius: 8, padding: 8 }}>
                  {importReview.zhPacks.map((p) => (
                    <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                      <Checkbox
                        checked={reviewContinueZh.includes(p.key)}
                        onChange={(e) =>
                          setReviewContinueZh((prev) =>
                            e.target.checked ? [...prev, p.key] : prev.filter((k) => k !== p.key),
                          )
                        }
                      />
                      <Typography.Text style={{ flex: 1, fontSize: 13 }} ellipsis={{ tooltip: p.name }}>
                        {p.name}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {p.zhCount} 条
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* 空文本 + 深度扫描 */}
            {(importReview.emptyMods.length > 0 || importReview.gdEmptyMods.length > 0) && (
              <div>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  以下内容包未发现常规可翻译文本
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "2px 0 4px" }}>
                  勾选将对其启用深度扫描（成就/配置/内嵌文本等）；深度扫描后仍无文本的包不会加入列表。
                </Typography.Text>
                <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid #F0F2F5", borderRadius: 8, padding: 8 }}>
                  {importReview.emptyMods.map((p) => (
                    <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                      <Checkbox
                        checked={reviewDeepScan.includes(p.key)}
                        onChange={(e) =>
                          setReviewDeepScan((prev) =>
                            e.target.checked ? [...prev, p.key] : prev.filter((k) => k !== p.key),
                          )
                        }
                      />
                      <Typography.Text style={{ flex: 1, fontSize: 13 }} ellipsis={{ tooltip: p.name }}>
                        {p.name}
                      </Typography.Text>
                    </div>
                  ))}
                  {importReview.gdEmptyMods.map((p) => (
                    <div key={p.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                      <Checkbox
                        checked={reviewDeepScan.includes(p.path)}
                        onChange={(e) =>
                          setReviewDeepScan((prev) =>
                            e.target.checked ? [...prev, p.path] : prev.filter((k) => k !== p.path),
                          )
                        }
                      />
                      <Typography.Text style={{ flex: 1, fontSize: 13 }} ellipsis={{ tooltip: p.fileName }}>
                        {p.fileName}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <Switch
                    size="small"
                    checked={reviewAutoDeep}
                    onChange={(v) => setReviewAutoDeep(v)}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    以后自动深度扫描空文本模组（不再次询问）
                  </Typography.Text>
                </div>
              </div>
            )}
            {/* 未提取到任何文本（不支持深度扫描的类型） */}
            {importReview.emptyInfo.length > 0 && (
              <div>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  以下内容包未提取到任何文本
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 2 }}>
                  「{importReview.emptyInfo.join("、")}」请确认文件含可汉化内容、文本类型受支持，或文本是否硬编码在代码中无法自动提取。
                </Typography.Text>
              </div>
            )}
            {/* 批次提示 */}
            {importReview.batchWarn && (
              <div style={{ background: "var(--ant-color-warning-bg, #FFFBE6)", borderRadius: 8, padding: "8px 12px" }}>
                <Typography.Text strong style={{ fontSize: 13 }}>内容包条目较少，建议检查批次设置</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: "4px 0" }}>
                  {importReview.batchWarn.names}。当前 {importReview.batchWarn.threads} 线程 + 跟随线程数最优条数，
                  实际每批仅约 {importReview.batchWarn.perBatch} 条——小批次可能影响翻译上下文与准确性。
                </Typography.Paragraph>
                <Button
                  size="small"
                  onClick={() => {
                    setSettingsSection("params");
                    setSettingsOpen(true);
                  }}
                >
                  去设置
                </Button>
              </div>
            )}
            {/* 解析失败 */}
            {importReview.failures.length > 0 && (
              <div>
                <Typography.Text type="danger">解析失败 {importReview.failures.length} 个：</Typography.Text>
                <div style={{ maxHeight: 150, overflowY: "auto", marginTop: 6 }}>
                  {importReview.failures.map((f, i) => (
                    <div key={i} style={{ fontSize: 12, marginBottom: 4 }}>
                      <Typography.Text type="secondary">{f.name}：</Typography.Text>
                      {f.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 清除译文：只清除当前页勾选的内容包 */}
      <Modal
        title="清除译文"
        open={clearOpen}
        onCancel={() => setClearOpen(false)}
        onOk={doClear}
        okText="清除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={420}
      >
        <Typography.Paragraph>
          将清除当前{t(KIND_META[activeTab].labelKey)}页勾选的 {checkedInTab} 个内容包的全部译文（不可撤销）。
        </Typography.Paragraph>
      </Modal>

      {/* 导出 jar 风险提示：含深度扫描内嵌文本 */}
      <Modal
        title="导出风险提示"
        open={exportRiskOpen}
        onCancel={() => setExportRiskOpen(false)}
        footer={null}
        width={520}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="该模组包含深度扫描发现的内嵌文本（非语言文件，直接写在 json/配置文件中）。修改这些字段可能影响模组运行。"
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          已勾选 {exportRiskChecked.length} 个模组的深度扫描文本参与导出。请选择处理方式：
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Button
            block
            type="primary"
            onClick={() => {
              setExportRiskOpen(false);
              void doExportJar(exportRiskChecked, true);
            }}
          >
            跳过深度扫描文本，仅导出语言文件（推荐）
          </Button>
          <Button
            block
            danger
            onClick={() => {
              setExportRiskOpen(false);
              void doExportJar(exportRiskChecked, false);
            }}
          >
            仍导出全部（含内嵌文本，不推荐）
          </Button>
          <Button block onClick={() => setExportRiskOpen(false)}>
            取消
          </Button>
        </Space>
      </Modal>

      {/* 翻译完成汇总：原文一致 / 提取术语 / 术语建议 三合一，勾选后统一执行 */}
      <Modal
        title="翻译完成汇总"
        open={transSummaryOpen}
        onCancel={() => {
          setTransSummaryOpen(false);
          setExtractedGlossary(null);
          setExtractedChecked([]);
          setGlossarySuggest(null);
          setSuggestChecked([]);
          setSameWarnPacks([]);
          setSameWarnChecked([]);
        }}
        onOk={() => void execTransSummary()}
        okText="统一执行"
        cancelText="关闭"
        width={640}
        okButtonProps={{ danger: sameWarnChecked.length > 0 }}
      >
        <Tabs
          items={[
            ...(sameWarnPacks.length > 0
              ? [
                  {
                    key: "same",
                    label: `原文一致（${sameWarnPacks.length}）`,
                    children: (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                            勾选的内容包将清除「译文与原文相同」的条目，便于重新汉化；其他条目不受影响。
                          </Typography.Text>
                          <Button
                            size="small"
                            onClick={() =>
                              setSameWarnChecked((prev) =>
                                prev.length === sameWarnPacks.length
                                  ? []
                                  : sameWarnPacks.map((w) => w.packKey),
                              )
                            }
                          >
                            {sameWarnChecked.length === sameWarnPacks.length ? "全不选" : "全选"}
                          </Button>
                        </div>
                        <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #F0F2F5", borderRadius: 8, padding: 8 }}>
                          {sameWarnPacks.map((w) => (
                            <div
                              key={w.packKey}
                              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #F5F6F8" }}
                            >
                              <Checkbox
                                checked={sameWarnChecked.includes(w.packKey)}
                                onChange={(e) =>
                                  setSameWarnChecked((prev) =>
                                    e.target.checked ? [...prev, w.packKey] : prev.filter((k) => k !== w.packKey),
                                  )
                                }
                              />
                              <Typography.Text style={{ flex: 1, fontSize: 13 }} ellipsis={{ tooltip: w.name }}>
                                {w.name}
                              </Typography.Text>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                {w.count} 条
                              </Typography.Text>
                            </div>
                          ))}
                        </div>
                      </div>
                    ),
                  },
                ]
              : []),
            ...(extractedGlossary && extractedGlossary.length > 0
              ? [
                  {
                    key: "extracted",
                    label: `提取术语（${extractedGlossary.length}）`,
                    children: (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                            本次翻译已自动提取并用于统一译名。勾选可加入用户术语表（全局生效）；不勾选的仅本次使用。
                          </Typography.Text>
                          <Button
                            size="small"
                            onClick={() =>
                              setExtractedChecked((prev) =>
                                prev.length === (extractedGlossary?.length ?? 0)
                                  ? []
                                  : (extractedGlossary ?? []).map(([en]) => en),
                              )
                            }
                          >
                            {extractedChecked.length === (extractedGlossary?.length ?? 0) ? "全不选" : "全选"}
                          </Button>
                        </div>
                        <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #F0F2F5", borderRadius: 8, padding: 8 }}>
                          {extractedGlossary.map(([en, zh]) => (
                            <div
                              key={en}
                              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #F5F6F8" }}
                            >
                              <Checkbox
                                checked={extractedChecked.includes(en)}
                                onChange={(e) =>
                                  setExtractedChecked((prev) =>
                                    e.target.checked ? [...prev, en] : prev.filter((x) => x !== en),
                                  )
                                }
                              />
                              <Typography.Text code style={{ flex: 1 }}>{en}</Typography.Text>
                              <Typography.Text>→ {zh}</Typography.Text>
                            </div>
                          ))}
                        </div>
                      </div>
                    ),
                  },
                ]
              : []),
            ...(glossarySuggest && glossarySuggest.length > 0
              ? [
                  {
                    key: "suggest",
                    label: `术语建议（${glossarySuggest.length}）`,
                    children: (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                            以下高频词汇本次出现多次，加入术语表可让后续翻译译名更统一（可取消不需要的）。
                          </Typography.Text>
                          <Button
                            size="small"
                            onClick={() =>
                              setSuggestChecked((prev) =>
                                prev.length === (glossarySuggest?.length ?? 0)
                                  ? []
                                  : (glossarySuggest ?? []).map(([en]) => en),
                              )
                            }
                          >
                            {suggestChecked.length === (glossarySuggest?.length ?? 0) ? "全不选" : "全选"}
                          </Button>
                        </div>
                        <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #F0F2F5", borderRadius: 8, padding: 8 }}>
                          {glossarySuggest.map(([en, zh]) => (
                            <div
                              key={en}
                              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #F5F6F8" }}
                            >
                              <Checkbox
                                checked={suggestChecked.includes(en)}
                                onChange={(e) =>
                                  setSuggestChecked((prev) =>
                                    e.target.checked ? [...prev, en] : prev.filter((x) => x !== en),
                                  )
                                }
                              />
                              <Typography.Text code style={{ flex: 1 }}>{en}</Typography.Text>
                              <Typography.Text>→ {zh}</Typography.Text>
                            </div>
                          ))}
                        </div>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Modal>
    </Layout>
  );
}

/** 外层 App：持有设置，动态应用主题（亮/暗）、语言（中/英）、无字模式（CSS 类） */
function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const themeMode = settings?.theme ?? "light";
  const language: "zh" | "en" = settings?.language === "en" ? "en" : "zh";
  // 外层组件在 TranslationProvider 之外，用不依赖 context 的 useTranslation
  const { t } = useTranslation(language);

  /** 读取设置并补齐旧配置缺失的字段（初始化与「清除用户数据」后复用） */
  const reloadSettings = useCallback(async () => {
    try {
      const s = await api.loadSettings();
      setSettings({
        ...s,
        threading: s.threading ?? {
          enabled: false,
          threadCount: 2,
          requestIntervalSec: 4,
        },
        customPrompts: s.customPrompts ?? {},
        batchSizeAuto: s.batchSizeAuto ?? true,
        packParallelEnabled: s.packParallelEnabled ?? false,
        recentGameDirs: s.recentGameDirs ?? [],
        closeBehavior: s.closeBehavior === "minimize" ? "minimize" : "exit",
        packParallelCount: s.packParallelCount ?? 2,
        // 深度扫描规则由后端填充默认值；此处仅在缺失时兜底为空对象交由后端归一化
        deepScanRules: s.deepScanRules,
        theme: s.theme === "dark" ? "dark" : "light",
        language: s.language === "en" ? "en" : "zh",
      });
    } catch {
      message.warning(t("app.msgSettingsLoadFailed"));
      setSettings(null);
    }
  }, [t]);

  // 初始化：加载设置（兼容旧配置：补齐新字段默认值）
  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  // 主题 CSS 变量挂在 html 根元素（App.css 的 [data-theme="dark"] 选择器）
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  // devtools：主题/语言变化时广播给开发者工具第二窗口，实现实时联动
  useEffect(() => {
    if (!__DEVTOOLS__) return;
    void emit(DEV_SETTINGS_SYNC, { theme: themeMode, language }).catch(() => {});
  }, [themeMode, language]);

  return (
    <ConfigProvider
      theme={themeMode === "dark" ? darkTheme : lightTheme}
      locale={language === "zh" ? zhCN : enUS}
    >
      <TranslationProvider language={language}>
        <AppInner
          settings={settings}
          setSettings={setSettings}
          reloadSettings={reloadSettings}
        />
      </TranslationProvider>
    </ConfigProvider>
  );
}

export default App;
