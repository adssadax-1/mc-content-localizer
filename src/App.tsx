import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  ConfigProvider,
  Drawer,
  InputNumber,
  Layout,
  message,
  Modal,
  notification,
  Progress,
  Radio,
  Space,
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
  ToolOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";

import { api as rawApi, createDevApi, onFileDropped, onGlossaryDone, onTranslateProgress, onTranslationBatch } from "./api";
import { DropZone } from "./components/DropZone";
import { EntryTable } from "./components/EntryTable";
import { ContextPanel } from "./components/ContextPanel";
import { SettingsModal } from "./components/SettingsModal";
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

/** Windows 文件名非法字符清洗（* ? : < > | / \ "）→ _，并截断超过 100 字符。
 *  防止 modid / 文件名含非法字符时导出触发 os error 123（文件名语法不正确）。 */
function sanitizeFileName(s: string): string {
  return s.replace(/[*?:<>|\\/"]/g, "_").slice(0, 100);
}

/** 内容包类型 */
type PackKind = "mod" | "shader" | "resourcepack";

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
}: PackCardProps) {
  const { t } = useTranslationContext();
  const total = item.entries.length;
  const translated = item.entries.filter((e) => e.translation).length;
  const meta = KIND_META[item.kind];
  return (
    <div
      className="pack-card"
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
        {thisTranslating && (
          <Tag color="processing" className="dev-pulse-tag">
            {t("components.translating")}
            {packProgress ? ` ${packProgress.done}/${packProgress.total}` : ""}
          </Tag>
        )}
        <Typography.Text type="secondary" style={{ marginLeft: "auto" }}>
          {translated}/{total} {t("app.translatedCount")}
        </Typography.Text>
        {item.kind === "mod" && onDeepScan && (
          <Tooltip title={t("app.deepScanDesc")}>
            <Button
              size="small"
              type={item.deepScanGroups ? "default" : "dashed"}
              loading={deepScanningKey === item.key}
              onClick={(e) => {
                e.stopPropagation();
                onDeepScan(item.key);
              }}
            >
              {item.deepScanGroups
                ? `${t("app.deepScan")} ${item.deepScanGroups.reduce((a, g) => a + g.count, 0)}`
                : t("app.deepScan")}
            </Button>
          </Tooltip>
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
                  key={g.label}
                  checked={g.checked}
                  onChange={(e) =>
                    onToggleDeepGroup?.(item.key, g.label, e.target.checked)
                  }
                  style={{ fontSize: 12 }}
                >
                  {g.label}({g.count})
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
              onEdit={(k, v) => onEdit(item.key, k, v)}
              onSelect={onSelect}
              onClear={(k) => onClear(item.key, k)}
              onToggleSelected={(k, s) => onToggleSelected(item.key, k, s)}
              onToggleAllSelected={(s) => onToggleAllSelected(item.key, s)}
              onToggleManySelected={(keys, s) =>
                onToggleManySelected(item.key, keys, s)
              }
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

const DEEP_PREFIX = "模组深度扫描·";

/** 判断条目是否为深度扫描条目，返回其分组名 */
function deepEntryGroup(e: LangEntry): string | null {
  const n = e.notes?.[0];
  return n?.startsWith(DEEP_PREFIX) ? n.slice(DEEP_PREFIX.length) : null;
}

/** 队列中的单个内容包（模组 / 光影包 / 资源包统一结构） */
interface PackItem {
  key: string;
  kind: PackKind;
  name: string;
  fileName: string;
  sourcePath: string;
  expanded: boolean;
  checked: boolean;
  height: number;
  entries: LangEntry[];
  /** 深度扫描分组状态（{label,count,checked}） */
  deepScanGroups?: { label: string; count: number; checked: boolean }[];
  // 模组额外信息
  modFile?: ModFile;
  langFormat?: LangFormat;
  hasZh?: boolean;
  zhCount?: number;
}

function AppInner({
  settings,
  setSettings,
}: {
  settings: Settings | null;
  setSettings: (s: Settings | null) => void;
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
  // 每个内容包的实时计数（批次事件累加，完成后弹 per-pack 卡片用）；same = 译文与原文相同
  const packCountsRef = useRef<Map<string, { ok: number; empty: number; error: number; error429: number; warn: number; same: number }>>(new Map());
  // 内容包并行：正在翻译的包（key → true）与各包实时进度
  const [translatingKeys, setTranslatingKeys] = useState<Record<string, boolean>>({});
  const [packProgress, setPackProgress] = useState<Record<string, { done: number; total: number }>>({});
  // 取消标志的同步 ref（并行池 worker 内读到最新值，不受闭包捕获限制）
  const cancelRequestedRef = useRef(false);
  // 术语表建议候选（翻译完成后一次性弹出）
  const [glossarySuggest, setGlossarySuggest] = useState<[string, string][] | null>(null);
  const [suggestChecked, setSuggestChecked] = useState<string[]>([]);
  // 本次提取的术语（en→zh），弹窗可勾选加入用户术语表
  const [extractedGlossary, setExtractedGlossary] = useState<[string, string][] | null>(null);
  const [extractedChecked, setExtractedChecked] = useState<string[]>([]);
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
  // 清除译文对话框：可见性 + 勾选的备注标签（空 = 清除全部）
  const [clearOpen, setClearOpen] = useState(false);
  const [clearTags, setClearTags] = useState<string[]>([]);
  const clearTagOptions = useMemo(() => {
    const set = new Set<string>();
    queue.forEach((it) => it.entries.forEach((e) => (e.notes ?? []).forEach((n) => set.add(n))));
    return [...set];
  }, [queue, clearOpen]);

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
  useEffect(() => {
    const unlisten = onTranslateProgress((p) => {
      setProgress(p);
      if (p.packKey) {
        setPackProgress((prev) => ({
          ...prev,
          [p.packKey as string]: { done: p.doneCount, total: p.totalCount },
        }));
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  useEffect(() => {
    const unlisten = onGlossaryDone(({ count, glossary }) => {
      if (count > 0) message.info(`已提取 ${count} 条术语，用于统一译名`);
      if (glossary && glossary.length > 0) {
        setExtractedGlossary((prev) => {
          const map = new Map<string, string>();
          (prev ?? []).forEach(([en, zh]) => map.set(en, zh));
          glossary.forEach(([en, zh]) => {
            if (!map.has(en)) map.set(en, zh);
          });
          return [...map.entries()];
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
  useEffect(() => {
    const unlisten = onTranslationBatch(({ packKey, items }) => {
      setQueue((prev) =>
        prev.map((pack) => {
          if (pack.key !== packKey) return pack;
          const byKey = new Map(items.map((i) => [i.key, i]));
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
          const pc = packCountsRef.current.get(packKey) ?? { ok: 0, empty: 0, error: 0, error429: 0, warn: 0, same: 0 };
          pc.ok += okN;
          pc.empty += emptyN;
          pc.error += errN;
          pc.error429 += err429N;
          pc.warn += warnN;
          pc.same += sameN;
          packCountsRef.current.set(packKey, pc);
          return { ...pack, entries };
        }),
      );
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /** 打开文件选择（点击中央区域） */
  async function pickFiles() {
    const paths = await open({
      multiple: true,
      title: "选择文件（模组 jar / 光影包 zip / 资源包 zip，可多选）",
      filters: [{ name: "Minecraft 内容包", extensions: ["jar", "zip"] }],
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

  /** 导入文件到队列 */
  /** 执行深度扫描：合并条目（默认不勾选）+ 设置分组状态；返回发现条数 */
  async function applyDeepScan(item: PackItem): Promise<number> {
    const res = await api.deepScanJar(item.sourcePath, item.modFile?.modid ?? "mod");
    if (res.entries.length === 0) return 0;
    item.entries = [
      ...item.entries,
      ...res.entries.map((e) => ({ ...e, selected: false as const })),
    ];
    item.deepScanGroups = res.groups.map((g) => ({
      label: g.label,
      count: g.count,
      checked: g.defaultChecked ?? false,
    }));
    return res.entries.length;
  }

  async function addFiles(paths: string[]) {
    const files = paths.filter(
      (p) => p.toLowerCase().endsWith(".jar") || p.toLowerCase().endsWith(".zip"),
    );
    if (files.length === 0) {
      message.error("请选择 .jar 或 .zip 文件");
      return;
    }
    setParsing(true);
    const added: PackItem[] = [];
    let zhHits = 0;
    let zhTotal = 0;
    for (const p of files) {
      try {
        const item = await parseFile(p);
        // 条目默认参与汉化
        item.entries = item.entries.map((e) => ({ ...e, selected: e.selected ?? true }));
        added.push(item);
        if (item.hasZh) {
          zhHits += 1;
          zhTotal += item.zhCount ?? 0;
        }
      } catch (e) {
        const fileName = p.split(/[\\/]/).pop() ?? p;
        const err = String(e);
        if (/zip 读取失败|无法打开文件/.test(err)) {
          message.error(t("app.msgParseCorrupt", { name: fileName }));
        } else if (/未能识别为可翻译的模组|不是可翻译/.test(err)) {
          message.error(t("app.msgParseNotPack", { name: fileName }));
        } else {
          message.error(t("app.msgParseOther", { name: fileName, error: err }));
        }
      }
    }
    // 自动深度扫描（设置开关开启时）：普通解析为空的模组
    let deepFound = 0;
    if (settings?.deepScan) {
      for (const it of added) {
        if (it.kind === "mod" && it.entries.length === 0) {
          try {
            deepFound += await applyDeepScan(it);
          } catch {
            /* 强扫失败不阻断 */
          }
        }
      }
    }
    setQueue((prev) => [...prev, ...added]);
    setParsing(false);
    // 自动批次 + 多线程时，条目过少的内容包会切出很小的批次（可能影响翻译质量），主动询问
    if (settings?.threading?.enabled && (settings.batchSizeAuto ?? true)) {
      const threads = settings.threading.threadCount;
      const small = added.filter((it) => it.entries.length > 0 && it.entries.length < 50);
      if (threads >= 4 && small.length > 0) {
        const minLen = Math.min(...small.map((it) => it.entries.length));
        const names = small.map((it) => `「${it.name}」${it.entries.length} 条`).join("、");
        Modal.confirm({
          title: "内容包条目较少，建议检查批次设置",
          content: `${names}。当前 ${threads} 线程 + 跟随线程数最优条数，实际每批仅约 ${Math.max(1, Math.ceil(minLen / threads))} 条——小批次可能影响翻译上下文与准确性。是否前往设置调整？`,
          okText: "去设置",
          cancelText: "保持现状",
          onOk: () => {
            setSettingsSection("params");
            setSettingsOpen(true);
          },
        });
      }
    }
    if (added.length > 0) {
      message.success(
        `已导入 ${added.length} 个内容包${deepFound > 0 ? `（模组深度扫描发现 ${deepFound} 条内嵌文本，默认未勾选）` : ""}`,
      );
    }
    // 导入后校验：解析为空的内容包，给出明确、可操作的提示
    const emptyPacks = added.filter((it) => it.entries.length === 0);
    if (emptyPacks.length > 0) {
      const modsEmpty = emptyPacks.filter((it) => it.kind === "mod");
      const otherEmpty = emptyPacks.filter((it) => it.kind !== "mod");
      if (modsEmpty.length > 0 && !settings?.deepScan && settings) {
        Modal.confirm({
          title: "未发现常规可翻译文本",
          content: `${modsEmpty.length} 个模组在常规位置（语言文件）未找到文本，可能将文本写在内嵌文件（成就/配置/嵌套 jar）中。是否启用模组深度扫描重试？也可在模组卡片上手动点击「模组深度扫描」。\n\n若仍为空，请确认：① 该文件确实包含可汉化文本；② 文本格式当前版本是否支持；③ 文本是否硬编码在 .class 代码（无法自动提取，需手动处理）。`,
          okText: "启用并重新扫描",
          cancelText: "暂不",
          onOk: async () => {
            const next = { ...settings, deepScan: true };
            try {
              await api.saveSettings(next);
              setSettings(next);
            } catch {
              /* 忽略 */
            }
            let found = 0;
            for (const it of modsEmpty) {
              try {
                found += await applyDeepScan(it);
              } catch {
                /* 忽略 */
              }
            }
            setQueue((prev) => [...prev]);
            if (found > 0) {
              message.success(`模组深度扫描发现 ${found} 条内嵌文本（默认未勾选，可在卡片上勾选组）`);
            } else {
              message.info("仍未发现可翻译文本：请确认文件含文本、文本类型受支持，或文本是否硬编码在 .class 代码中");
            }
          },
        });
      } else if (otherEmpty.length > 0) {
        Modal.info({
          title: "未发现可翻译文本",
          content: `「${otherEmpty.map((it) => it.name).join("、")}」未提取到任何语言/文本。请确认：① 导入的文件确实包含可汉化的内容；② 该文本类型（如光影/资源包的 .json/.mcmeta/.txt）当前版本是否支持；③ 文本是否硬编码在代码中无法自动提取。`,
        });
      } else if (modsEmpty.length > 0 && settings?.deepScan) {
        Modal.info({
          title: "未发现可翻译文本",
          content: `${modsEmpty.length} 个模组普通解析与深度扫描均未找到文本。请确认：① 文件确实包含可提取文本；② 文本类型受支持；③ 文本是否硬编码在 .class 代码（无法自动提取，需手动处理）。`,
        });
      }
    }
    if (zhHits > 0) {
      Modal.confirm({
        title: "检测到自带中文",
        content: `${zhHits} 个内容包自带中文（共 ${zhTotal} 条），已自动填入对应译文。是否继续汉化未翻译的部分？`,
        okText: "继续汉化",
        cancelText: "暂不",
        onOk: () => void runTranslation(),
      });
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
    setQueue((prev) => prev.map((it) => ({ ...it, checked })));
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

    const translateOnePack = async (
      item: PackItem,
      untranslated: BatchItem[],
      preSame: number,
    ): Promise<void> => {
      setTranslatingKeys((prev) => ({ ...prev, [item.key]: true }));
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
        const results = await api.runTranslation(
          provider,
          ctx,
          items,
          item.key,
          effectiveBatch,
          settings.extractGlossary,
          settings.threading,
        );
        const byKey = new Map(results.map((r) => [r.key, r]));
        patchPack(item.key, (it) => ({
          ...it,
          entries: it.entries.map((e) => {
            const r = byKey.get(e.key);
            if (!r) return e;
            return { ...e, ...entryPatchFromResult(r) };
          }),
        }));
        doneAny = true;
        // 每个内容包单独弹出完成卡片（真实数据）
        const c = packCountsRef.current.get(item.key) ?? {
          ok: 0, empty: 0, error: 0, error429: 0, warn: 0, same: 0,
        };
        const a = buildResultAlert(c, t);
        showResultCard(
          a.type,
          `翻译 ${item.name} ${t(KIND_META[item.kind].labelKey)}完成`,
          a.desc,
        );
        // 检测：某包大量译文与原文相同（批次内内容相似时模型易原样返回）→ 询问清除重译
        const sameN = preSame + c.same;
        if (sameN >= 5) {
          const pk = item.key;
          Modal.confirm({
            title: "检测到大量译文与原文相同",
            content: `「${item.name}」有 ${sameN} 条译文与原文相同（可能未翻译，常见于批次内内容高度相似）。是否清除这些译文以便重新汉化？其他条目不受影响。`,
            okText: "清除这些译文",
            okButtonProps: { danger: true },
            cancelText: "保留",
            onOk: () => {
              setQueue((prev) =>
                prev.map((it) =>
                  it.key !== pk
                    ? it
                    : {
                        ...it,
                        entries: it.entries.map((e) =>
                          e.status === "aiTranslated" && e.translation != null && e.translation === e.source
                            ? { ...e, translation: null, status: "untranslated" as const, notes: [] }
                            : e,
                        ),
                      },
                ),
              );
              message.success(`已清除 ${sameN} 条与原文相同的译文，重新点击翻译即可重试`);
            },
          });
        }
      } finally {
        setTranslatingKeys((prev) => {
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

      if (cancelRequestedRef.current) {
        message.info("已取消，已翻译部分已保留");
      } else if (doneAny) {
        // 术语表建议：高频已翻译短语一次性提示（不打断）
        const sugg = collectSuggestions(
          queue.flatMap((q) => q.entries),
          settings.userGlossary ?? [],
        );
        if (sugg.length > 0) {
          setGlossarySuggest(sugg);
          setSuggestChecked(sugg.map(([en]) => en));
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

  /** 清除译文对话框：勾选备注标签时只清除带对应标签的条目；全不勾选 = 清除全部 */
  function handleClear() {
    setClearTags([]);
    setClearOpen(true);
  }

  function doClear() {
    const useTags = clearTags.length > 0;
    setQueue((prev) =>
      prev.map((it) => ({
        ...it,
        entries: it.entries.map((e) => {
          if (useTags && !(e.notes ?? []).some((n) => clearTags.includes(n))) return e;
          return { ...e, translation: null, status: "untranslated" as const, notes: [] };
        }),
      })),
    );
    setClearOpen(false);
    message.success(useTags ? "已清除带所选标签的译文" : "已清除全部译文");
  }

  function handleClearQueue() {
    Modal.confirm({
      title: "清空内容包列表？",
      content: "将移除全部内容包及其译文（不影响已保存的设置），此操作不可撤销。",
      okText: "清空列表",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        setQueue([]);
        setSelectedKey(null);
        setProgress(null);
        setTranslating(false);
        message.success("已清空列表");
      },
    });
  }

  /** 卡片「深度扫描」按钮：手动触发 */
  const runDeepScanFromCard = useCallback(
    async (key: string) => {
      const item = queue.find((it) => it.key === key);
      if (!item || item.kind !== "mod") return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue],
  );

  /** 切换深度扫描分组勾选（勾选组 → 组内条目参与翻译/导出） */
  const toggleDeepGroup = useCallback(
    (packKey: string, label: string, checked: boolean) => {
      patchPack(packKey, (it) => ({
        ...it,
        deepScanGroups: it.deepScanGroups?.map((g) =>
          g.label === label ? { ...g, checked } : g,
        ),
        entries: it.entries.map((e) =>
          deepEntryGroup(e) === label ? { ...e, selected: checked } : e,
        ),
      }));
    },
    [],
  );

  /** 导出（按类型分流） */
  async function handleExport() {
    const checked = queue.filter((it) => it.checked);
    if (checked.length === 0) {
      message.info("请先勾选要导出的内容包");
      return;
    }
    const kinds = new Set(checked.map((c) => c.kind));
    if (kinds.size > 1) {
      message.warning("请在同一类型内勾选导出（模组/光影包/资源包分开导出）");
      return;
    }
    const kind = checked[0].kind;
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
          const base = it.fileName.replace(/\.(zip|jar)$/i, "");
          const dest = `${dir}/${sanitizeFileName(base)}_zh_CN.zip`;
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
          const base = it.fileName.replace(/\.(zip|jar)$/i, "");
          const dest = `${dir}/${sanitizeFileName(base)}_zh_CN.zip`;
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
    const bundles: ResourcePackBundle[] = checked.map((it) => ({
      modid: it.modFile?.modid ?? "mod",
      modName: it.name,
      entries: it.entries.filter((e) => e.selected !== false),
      langFormat: it.langFormat ?? "json",
    }));
    try {
      const path = await api.exportResourcePackMulti(dir, bundles, packFormat);
      notifyExport(`已导出合并汉化资源包（${checked.length} 个模组）`, [path]);
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
        const dest = `${dir}/${sanitizeFileName(it.modFile?.modid ?? "mod")}_zh_cn.jar`;
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

  const selectedEntry = useMemo(() => {
    for (const it of queue) {
      const e = it.entries.find((x) => x.key === selectedKey);
      if (e) return e;
    }
    return null;
  }, [queue, selectedKey]);


  const visibleQueue = queue.filter((it) => it.kind === activeTab);
  const allChecked = visibleQueue.length > 0 && visibleQueue.every((it) => it.checked);
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
        {/* 左侧导航：三类内容包 */}
        <Sider width={200} style={{ borderRight: "1px solid var(--border-color, #E6E8EB)", paddingTop: 12 }}>
          <div style={{ padding: "0 12px" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 8 }} className="sider-label-text">
              {t("app.contentKind")}
            </Typography.Text>
            {(Object.keys(KIND_META) as PackKind[]).map((k) => (
              <Button
                key={k}
                block
                className="sider-nav-btn"
                type={activeTab === k ? "primary" : "text"}
                icon={KIND_META[k].icon}
                style={{
                  marginTop: 6,
                  justifyContent: "flex-start",
                  textAlign: "left",
                }}
                onClick={() => setActiveTab(k)}
              >
                {t(KIND_META[k].labelKey)}
              </Button>
            ))}
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: "block", marginTop: 16, paddingLeft: 8 }}
              className="sider-label-text"
            >
              {visibleQueue.length}
            </Typography.Text>
          </div>
        </Sider>

        <Content style={{ padding: 12, overflow: "auto" }}>
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
                <Button danger icon={<DeleteOutlined />} disabled={translating} onClick={handleClearQueue}>
                  {t("app.clearList")}
                </Button>
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

              {/* 内容包队列卡片（memo 化：勾选只重渲染对应卡片） */}
              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                {visibleQueue.map((it) => (
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
                    onDeepScan={(k) => void runDeepScanFromCard(k)}
                    onToggleDeepGroup={toggleDeepGroup}
                    deepScanningKey={deepScanningKey}
                  />
                ))}
              </div>
            </div>
          )}
        </Content>
      </Layout>

      <Footer style={{ padding: "6px 12px", textAlign: "center", borderTop: "1px solid #E6E8EB" }}>
        <Space size="middle" wrap>
          <Typography.Text type="secondary">
            支持模组 jar · 光影包 · 资源包 · 勾选要翻译/导出的内容包
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
          <ContextPanel entry={selectedEntry} allEntries={queue.flatMap((q) => q.entries)} />
        )}
      </Drawer>

      <Modal title="导出模组" open={exportOpen} onCancel={() => setExportOpen(false)} footer={null} width={480}>
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Typography.Text type="secondary">
            将导出全部勾选的 {queue.filter((it) => it.checked && it.kind === "mod").length} 个模组
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

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        onSaved={setSettings}
      />

      {/* 清除译文：按备注标签勾选清除；全不勾选 = 清除全部 */}
      <Modal
        title="清除译文"
        open={clearOpen}
        onCancel={() => setClearOpen(false)}
        onOk={doClear}
        okText="清除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={520}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          勾选标签：只清除带所选标签的条目；全部不勾选：清除全部译文（不可撤销）。
        </Typography.Paragraph>
        {clearTagOptions.length > 0 ? (
          <Checkbox.Group
            value={clearTags}
            onChange={(v) => setClearTags(v as string[])}
            options={clearTagOptions.map((tg) => ({ label: tg, value: tg }))}
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          />
        ) : (
          <Typography.Text type="secondary">当前没有带备注标签的条目，将清除全部译文。</Typography.Text>
        )}
      </Modal>

      {/* 提取到的术语：弹窗勾选加入用户术语表（不阻塞翻译） */}
      <Modal
        title="提取到的术语"
        open={!!extractedGlossary}
        onCancel={() => setExtractedGlossary(null)}
        onOk={async () => {
          if (!extractedGlossary || !settings) return;
          const checkedSet = new Set(extractedChecked);
          const selected = extractedGlossary.filter(([en]) => checkedSet.has(en));
          if (selected.length === 0) {
            message.info("未选择任何术语");
            return;
          }
          const next = {
            ...settings,
            userGlossary: [...(settings.userGlossary ?? []), ...selected],
          };
          try {
            await api.saveSettings(next);
            setSettings(next);
            message.success(`已加入 ${selected.length} 条术语到用户术语表`);
          } catch (e) {
            message.error(String(e));
          }
          setExtractedGlossary(null);
        }}
        okText="加入用户术语表"
        cancelText="仅本次使用"
        width={520}
      >
        <Typography.Paragraph type="secondary">
          以下术语已自动提取并用于本次翻译。勾选可**加入用户术语表**（全局生效，后续翻译统一译名）；不勾选的仅本次使用：
        </Typography.Paragraph>
        <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid #F0F2F5", borderRadius: 8, padding: 8 }}>
          {extractedGlossary?.map(([en, zh]) => (
            <div
              key={en}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                borderBottom: "1px solid #F5F6F8",
              }}
            >
              <Checkbox
                checked={extractedChecked.includes(en)}
                onChange={(e) =>
                  setExtractedChecked((prev) =>
                    e.target.checked
                      ? [...prev, en]
                      : prev.filter((x) => x !== en),
                  )
                }
              />
              <Typography.Text code style={{ flex: 1 }}>{en}</Typography.Text>
              <Typography.Text>→ {zh}</Typography.Text>
            </div>
          ))}
        </div>
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

      {/* 术语表建议：翻译完成后一次性弹出，勾选加入术语表 */}
      <Modal
        title="术语表建议"
        open={!!glossarySuggest}
        onCancel={() => setGlossarySuggest(null)}
        onOk={async () => {
          if (!glossarySuggest || !settings) return;
          const checkedSet = new Set(suggestChecked);
          const selected = glossarySuggest.filter(([en]) => checkedSet.has(en));
          if (selected.length === 0) {
            message.info("未选择任何术语");
            return;
          }
          const next = {
            ...settings,
            userGlossary: [...(settings.userGlossary ?? []), ...selected],
          };
          try {
            await api.saveSettings(next);
            setSettings(next);
            message.success(`已加入 ${selected.length} 条术语`);
          } catch (e) {
            message.error(String(e));
          }
          setGlossarySuggest(null);
        }}
        okText="加入术语表"
        cancelText="暂不"
        width={520}
      >
        <Typography.Paragraph type="secondary">
          以下高频词汇在本次翻译中出现多次，加入术语表可让后续翻译译名更统一（可取消不需要的）：
        </Typography.Paragraph>
        <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #F0F2F5", borderRadius: 8, padding: 8 }}>
          {glossarySuggest?.map(([en, zh]) => (
            <div
              key={en}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                borderBottom: "1px solid #F5F6F8",
              }}
            >
              <Checkbox
                checked={suggestChecked.includes(en)}
                onChange={(e) =>
                  setSuggestChecked((prev) =>
                    e.target.checked
                      ? [...prev, en]
                      : prev.filter((x) => x !== en),
                  )
                }
              />
              <Typography.Text code style={{ flex: 1 }}>{en}</Typography.Text>
              <Typography.Text>→ {zh}</Typography.Text>
            </div>
          ))}
        </div>
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

  // 初始化：加载设置（兼容旧配置：补齐新字段默认值）
  useEffect(() => {
    api
      .loadSettings()
      .then((s) =>
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
          packParallelCount: s.packParallelCount ?? 2,
          deepScan: s.deepScan ?? false,
          theme: s.theme === "dark" ? "dark" : "light",
          language: s.language === "en" ? "en" : "zh",
        }),
      )
      .catch(() => {
        message.warning(t("app.msgSettingsLoadFailed"));
        setSettings(null);
      });
  }, []);

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
        <AppInner settings={settings} setSettings={setSettings} />
      </TranslationProvider>
    </ConfigProvider>
  );
}

export default App;
