import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  notification,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ApiOutlined,
  BookOutlined,
  BgColorsOutlined,
  ClearOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SlidersOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "../api";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  ClearResult,
  DeepScanRules,
  ModelInfo,
  ProviderConfig,
  Settings,
  StorageUsage,
} from "../types";
import { PROVIDER_PRESETS, isLocalProvider, LOCAL_PROVIDERS } from "../types";
import { ProviderGrid, PROVIDER_HINTS } from "./ProviderIcon";
import { PromptEditorModal } from "./PromptEditorModal";
import { DeepScanRulesModal } from "./DeepScanRulesModal";
import { DeepScanIcon } from "./DeepScanIcon";
import { SlideNav, PanelBlock } from "./SlideNav";
import { useTranslationContext } from "../i18n";
import { clearScanCache } from "../gameDirScanCache";

/* 主题选项的太阳/月亮图标已随「主题」一起搬到顶栏快捷开关（用 antd 的
   SunOutlined / MoonOutlined，跟随按钮文字色）；这里的彩色 SVG 版本、
   以及它所在的整块「主题 / 语言 / 无字模式」表单，本轮一并移除。 */

/* ── 表单标签用的简约 SVG ──────────────────────────────────────────
   为什么标签换成图标：这几个字段的名字（API Key / 模型）在输入框的 placeholder
   与右侧按钮里本来就重复出现了，标签再写一遍纯属占宽。换成图标后悬停仍可看全名，
   横向空间还给输入框本身。描边用 currentColor → 亮/暗主题自动跟色，不用两套。 */
function KeyGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: "-2px" }}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="4.2" />
      <path d="M11.2 11.2 20.5 20.5" />
      <path d="M17.4 17.4 15.2 19.6" />
      <path d="M19.6 15.2 17.4 17.4" />
    </svg>
  );
}

/** 模型：立方体（"模型"一词最直观的图形，不用 emoji 以免跨平台观感不一） */
function ModelGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: "-2px" }}
      aria-hidden="true"
    >
      <path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z" />
      <path d="M12 12 20 7.6" />
      <path d="M12 12v8.8" />
      <path d="M12 12 4 7.6" />
    </svg>
  );
}

interface Props {
  open: boolean;
  settings: Settings | null;
  /** 打开时定位到的设置分组（如 "params" 翻译参数）；undefined = 默认页 */
  initialSection?: string;
  onClose: () => void;
  onSaved: (s: Settings) => void;
  /** 清除用户数据成功后触发：外层需清空内存中的列表与缓存引用并重新加载设置 */
  onUserDataCleared?: () => void | Promise<void>;
}

interface FormValues {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature: number;
  batchSize: number;
  batchSizeAuto: boolean;
  extractGlossary: boolean;
  packFormat: number;
  userGlossary: [string, string][];
  /** 各服务商保存的 key（隐藏字段） */
  providerApiKeys?: Record<string, string>;
  /** 各服务商保存的模型（隐藏字段） */
  providerModels?: Record<string, string>;
  /** 各服务商缓存的模型列表（隐藏字段） */
  providerModelOptions?: Record<string, ModelInfo[]>;
  /** 多线程翻译 */
  threadingEnabled?: boolean;
  threadCount?: number;
  requestIntervalSec?: number;
  /** 内容包并行翻译 */
  packParallelEnabled?: boolean;
  packParallelCount?: number;
  /** 深度文本扫描 */
  deepScan?: boolean;
  /* theme / language / iconOnly 已移出表单：由顶栏快捷开关即时写盘，
     本弹窗不再读写这三项（字段留着会让人以为保存路径还在弹窗里）。 */
  /** 关闭行为：exit / minimize */
  closeBehavior?: "exit" | "minimize";
  exportNaming?: "raw" | "suffix" | "ai";
  deepScanPlugin?: boolean;
}

/** 版本号兜底值：正常走 Tauri 的 getVersion()（读 tauri.conf.json），
 *  只有它的 Promise 失败时才会显示这个值。
 *  **升版本时要跟 tauri.conf.json / package.json / Cargo.toml 一起改** ——
 *  它曾经长期停在旧版本号上，一旦 getVersion() 失败就会在「关于」里显示一个假版本。 */
const FALLBACK_VERSION = "3.1.1";

/** 字节数 → 可读体积 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 项目 GitHub 地址 */
const GITHUB_URL = "https://github.com/adssadax-1/mc-content-localizer";

/** 设置分组（NAV / section 结构）：个性化设置置顶为默认分组 */
const SECTIONS: { key: string; labelKey: string; icon: React.ReactNode }[] = [
  { key: "appearance", labelKey: "settings.section.appearance", icon: <BgColorsOutlined /> },
  { key: "provider", labelKey: "settings.section.provider", icon: <CloudServerOutlined /> },
  { key: "params", labelKey: "settings.section.params", icon: <SlidersOutlined /> },
  { key: "glossary", labelKey: "settings.section.glossary", icon: <BookOutlined /> },
  { key: "deepscan", labelKey: "settings.section.deepscan", icon: <DeepScanIcon /> },
  { key: "threading", labelKey: "settings.section.threading", icon: <ThunderboltOutlined /> },
  { key: "about", labelKey: "settings.section.about", icon: <InfoCircleOutlined /> },
];

/** 上次**关闭设置弹窗时**停留的分组。刻意只存在内存里（模块级变量，进程退出即重置）：
 *  · 不落盘 —— 它只决定"再打开时停在哪一页"，不是用户数据，没必要写进 settings.json；
 *  · **不参与保存** —— 记录它不会触发任何写盘动作，设置依旧只有点「确定」才会保存。
 *    这两件事（记住页面 / 保存设置）在需求里被明确区分过，别把它们合并。 */
let lastSectionInMemory: string | null = null;

export function SettingsModal({
  open,
  settings,
  initialSection,
  onClose,
  onSaved,
  onUserDataCleared,
}: Props) {
  const { t } = useTranslationContext();
  /* 无字模式取**已保存**的设置（不是表单里的临时值）：它与驱动
     <html data-icon-only> 的是同一个来源，页面已经是无字态了这个分支才成立。
     表单里刚改还没保存时，页面尚未切换，这里也跟着不切 —— 两者始终一致。 */
  const iconOnly = settings?.iconOnly ?? false;
  const [form] = Form.useForm<FormValues>();
  const provider = Form.useWatch("provider", form);
  const selectedModel = Form.useWatch("model", form);
  const threadingEnabled = Form.useWatch("threadingEnabled", form);
  const batchSizeAuto = Form.useWatch("batchSizeAuto", form) ?? true;
  const packParallelEnabled = Form.useWatch("packParallelEnabled", form) ?? false;
  /* 本地推理档（Ollama / llama.cpp）：API Key 非必填、不发 Authorization 头、
     Base URL 可改端口。判据与 Rust 侧 is_local 一致 —— provider 标识命中，
     或 Base URL 落在本机（自定义端点指回 localhost 也算本地）。 */
  const baseUrlValue = Form.useWatch("baseUrl", form);
  const isLocal = isLocalProvider(provider, baseUrlValue);
  /* 该服务商的 preset 是不是本地档（与"当前 Base URL 是否本地"分开：
     用户把本地档的地址改成局域网地址后，isLocal 会变 false，
     但 Base URL 仍然必须可编辑 —— 否则改完就再也改不回来）。 */
  const isLocalPreset = !!provider && (LOCAL_PROVIDERS as readonly string[]).includes(provider);
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingModel, setTestingModel] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  // 深度扫描规则弹窗（模组 / 插件）
  const [deepScanEditor, setDeepScanEditor] = useState<"mod" | "plugin" | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  /** 软件自身数据占用（缓存 / 用户数据），仅在「关于」分组可见时拉取 */
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [storageBusy, setStorageBusy] = useState<"cache" | "data" | null>(null);
  /** 清除用户数据的第二步（危险确认）：0 = 未开始，2 = 等待勾选 */
  const [wipeStage, setWipeStage] = useState<0 | 2>(0);
  const [wipeAck, setWipeAck] = useState(false);
  /** 应用版本号：从 Tauri 运行时读取（= tauri.conf.json version） */
  const [appVersion, setAppVersion] = useState(FALLBACK_VERSION);
  useEffect(() => {
    if (open) {
      getVersion().then(setAppVersion).catch(() => {});
    }
  }, [open]);
  /** 重新统计软件自身数据占用 */
  const loadStorage = useCallback(async () => {
    try {
      setStorage(await api.storageUsage());
    } catch {
      /* 统计失败不打断设置页 */
    }
  }, []);

  /** 清除缓存（第 1 步 / 共 1 步）：只删会话快照、游戏目录扫描缓存与浏览器缓存 */
  const handleClearCache = useCallback(() => {
    Modal.confirm({
      title: t("settings.storage.clearCacheTitle"),
      icon: <InfoCircleOutlined style={{ color: "#1677ff" }} />,
      content: (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t("settings.storage.clearCacheDesc")}
        </Typography.Text>
      ),
      okText: t("settings.storage.ok"),
      cancelText: t("settings.storage.cancel"),
      onOk: async () => {
        setStorageBusy("cache");
        try {
          const res: ClearResult = await api.clearAppCache();
          // 扫描缓存是**落盘 + 内存两层**：上面那句只删了磁盘那一份，
          // 内存 Map 才是 `getScanCache` 的读路径 —— 不清它的话，本次运行里
          // 命中缓存照旧、而且下一次 put/drop 会把整份快照**又写回磁盘**，
          // 表现为"点了清除缓存却没清掉"。两边必须一起清。
          clearScanCache();
          message.success(t("settings.storage.cacheCleared", { size: fmtBytes(res.freedBytes) }));
          if (res.skipped.length > 0) {
            message.info(t("settings.storage.skipped", { n: res.skipped.length }));
          }
          await loadStorage();
        } catch (e) {
          message.error(String(e));
        } finally {
          setStorageBusy(null);
        }
      },
    });
  }, [t, loadStorage]);

  /** 清除用户数据的第 1 步：说明范围，确认后进入「危险确认」第 2 步 */
  const handleClearData = useCallback(() => {
    Modal.confirm({
      title: t("settings.storage.clearDataTitle"),
      icon: <InfoCircleOutlined style={{ color: "#ff4d4f" }} />,
      content: (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t("settings.storage.clearDataDesc")}
        </Typography.Text>
      ),
      okText: t("settings.storage.goOn"),
      okButtonProps: { danger: true },
      cancelText: t("settings.storage.cancel"),
      onOk: () => {
        setWipeAck(false);
        setWipeStage(2);
      },
    });
  }, [t]);

  /** 第 2 步真正执行：必须已勾选确认 */
  const runWipe = useCallback(async () => {
    if (!wipeAck) return;
    setStorageBusy("data");
    try {
      const res: ClearResult = await api.clearAppData();
      setWipeStage(0);
      setWipeAck(false);
      // 与「清除缓存」同理：扫描缓存是落盘 + 内存两层，磁盘那份由 Rust 侧一并删掉
      // （storage.rs 的 is_cache_file_name 同时匹配 session-* 与 scan-cache-*），
      // 内存这份必须自己清，否则会写穿回一个已经"被清除"的文件。
      clearScanCache();
      message.success(t("settings.storage.dataCleared", { size: fmtBytes(res.freedBytes) }));
      if (res.skipped.length > 0) {
        message.info(t("settings.storage.skipped", { n: res.skipped.length }));
      }
      // 让外层清空内存中的内容包列表 / 术语缓存等，并重新加载设置（此时磁盘上已是默认值）
      await onUserDataCleared?.();
      await loadStorage();
      notification.info({
        message: t("settings.storage.restartTitle"),
        description: t("settings.storage.restartDesc"),
        duration: 0,
        placement: "bottomRight",
        btn: (
          <Button
            size="small"
            type="primary"
            onClick={() =>
              void api.restartApp().catch(() => message.error(t("settings.storage.restartFailed")))
            }
          >
            {t("settings.storage.restartNow")}
          </Button>
        ),
      });
    } catch (e) {
      message.error(String(e));
    } finally {
      setStorageBusy(null);
    }
  }, [wipeAck, t, onUserDataCleared, loadStorage]);

  /** 当前展示的设置分组（默认个性化设置；打开时按 initialSection 定位） */
  const [activeSection, setActiveSection] = useState<string>("appearance");
  /** 面板错峰动画：渲染期同步带类（同帧提交不闪烁）；开关粘性，关闭弹窗时复位 */
  const [prevSection, setPrevSection] = useState<string | null>(null);
  const [panelAnim, setPanelAnim] = useState(false);
  if (open) {
    if (prevSection !== activeSection) {
      if (prevSection !== null) setPanelAnim(true);
      setPrevSection(activeSection);
    }
  } else if (prevSection !== null || panelAnim) {
    setPrevSection(null);
    setPanelAnim(false);
  }

  /** 服务商切换错峰动画：与面板切换同款做法（渲染期同步带类，同帧提交不闪烁）。
      粘性开关，离开该分组或关闭弹窗时复位，保证"首次进入不播、之后每次切换重播"。 */
  const [prevProvider, setPrevProvider] = useState<string | undefined>(undefined);
  const [providerAnim, setProviderAnim] = useState(false);
  if (open && activeSection === "provider") {
    if (prevProvider !== provider) {
      if (prevProvider !== undefined) setProviderAnim(true);
      setPrevProvider(provider);
    }
  } else if (prevProvider !== undefined || providerAnim) {
    setPrevProvider(undefined);
    setProviderAnim(false);
  }

  /** 术语表：正在播离场动画的行（存 Form.List 的 field key）。
      动画结束后才真正 remove，避免空态文案与离场行叠在一起。 */
  const [leavingGlossary, setLeavingGlossary] = useState<number[]>([]);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  /* 打开时定位到：外部显式指定的分组 > 上次关闭时停留的分组 > 默认页。
     **只在 open 翻转时执行**（依赖里刻意没有 activeSection）—— 否则用户在弹窗里
     点别的分组会被这条 effect 拉回原处。 */
  useEffect(() => {
    if (open) setActiveSection(initialSection ?? lastSectionInMemory ?? "appearance");
  }, [open, initialSection]);

  /* 关闭时记下停留的分组（只写内存变量，不落盘、不触发保存）。
     注意这个是"只在 !open 时写"：开着的时候不写，所以它不会跟用户的点击打架。 */
  useEffect(() => {
    if (!open) lastSectionInMemory = activeSection;
  }, [open, activeSection]);

  // 打开「关于」分组时统计一次本地数据占用
  useEffect(() => {
    if (open && activeSection === "about") void loadStorage();
  }, [open, activeSection, loadStorage]);

  // 切换分组时复位右侧滚动位置（提交后立即执行）
  useLayoutEffect(() => {
    if (open && panelScrollRef.current) {
      panelScrollRef.current.scrollTop = 0;
    }
  }, [open, activeSection]);
  /** 服务商切换联动：切换时载入该服务商保存的 key / 模型 / 模型列表 */
  const prevProviderRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const prev = prevProviderRef.current;
    prevProviderRef.current = provider;
    if (prev === undefined || provider === undefined || provider === prev) return;
    // 切换服务商：key / 模型 / 模型列表全部联动到该服务商保存的值
    const keys: Record<string, string> = form.getFieldValue("providerApiKeys") ?? {};
    const models: Record<string, string> = form.getFieldValue("providerModels") ?? {};
    const opts: Record<string, ModelInfo[]> = form.getFieldValue("providerModelOptions") ?? {};
    form.setFieldValue("apiKey", keys[provider] ?? "");
    form.setFieldValue("model", models[provider] ?? PROVIDER_PRESETS[provider]?.model ?? "");
    setModelOptions(opts[provider] ?? []);
  }, [provider, open, form]);

  /** 手动检查更新：有新版 → 确认跳转 Release；已最新 → 提示；连不上 → 明确报错 */
  async function handleCheckUpdate() {
    setCheckingUpdate(true);
    try {
      const info = await api.checkUpdate();
      if (info) {
        Modal.confirm({
          title: t("settings.msg.updateFound"),
          content: t("settings.msg.updateContent", { cur: appVersion, latest: info.latestVersion }),
          okText: t("settings.msg.goDownload"),
          cancelText: "取消",
          onOk: () => void openUrl(info.url),
        });
      } else {
        message.success(t("settings.msg.latest", { version: appVersion }));
      }
    } catch (e) {
      message.error(String(e) || t("settings.msg.updateCheckFailed"));
    } finally {
      setCheckingUpdate(false);
    }
  }

  useEffect(() => {
    if (open && settings) {
      form.setFieldsValue({
        provider: settings.provider.provider,
        apiKey: settings.provider.apiKey,
        model: settings.provider.model ?? "",
        baseUrl: settings.provider.baseUrl ?? "",
        temperature: settings.provider.temperature ?? 0.7,
        batchSize: settings.batchSize,
        batchSizeAuto: settings.batchSizeAuto ?? true,
        extractGlossary: settings.extractGlossary,
        threadingEnabled: settings.threading?.enabled ?? false,
        threadCount: settings.threading?.threadCount ?? 2,
        requestIntervalSec: settings.threading?.requestIntervalSec ?? 4,
        packParallelEnabled: settings.packParallelEnabled ?? false,
        packParallelCount: settings.packParallelCount ?? 2,
        userGlossary: settings.userGlossary.length ? settings.userGlossary : [],
        providerApiKeys: settings.providerApiKeys ?? {},
        providerModels: settings.providerModels ?? {},
        // 主题 / 语言 / 无字模式不在这里：它们已搬到顶栏快捷开关（点一下即写盘）。
        // 表单不持有这三项，「确定」时就不会拿一份可能过期的快照把它们覆盖回去。
        closeBehavior: settings.closeBehavior === "minimize" ? "minimize" : "exit",
        exportNaming: settings.exportNaming ?? "suffix",
      });
      // 模型列表：用当前服务商缓存的列表（没拉取过则为空）
      const cur = settings.provider.provider;
      setModelOptions(settings.providerModelOptions?.[cur] ?? []);
    }
  }, [open, settings, form]);

  /** Select 下拉选项：当前选中模型不在列表中时前置，保证可见可选 */
  const selectOptions = useMemo(() => {
    const list = [...modelOptions];
    const cur = (selectedModel ?? "").trim();
    if (cur && !list.some((m) => m.id === cur)) {
      list.unshift({ id: cur, free: cur.toLowerCase().includes("free") });
    }
    return list;
  }, [modelOptions, selectedModel]);

  /** 验证所选模型连接是否可用：发送最小请求并反馈结果 */
  async function handleTestModel() {
    const apiKey = form.getFieldValue("apiKey")?.trim() as string | undefined;
    const providerName = form.getFieldValue("provider") as string;
    const model = form.getFieldValue("model")?.trim() as string | undefined;
    const baseUrlRaw = form.getFieldValue("baseUrl")?.trim() as string | undefined;
    const localNow = isLocalProvider(providerName, baseUrlRaw);
    // 本地档不要求 Key（后端同样放行），云端档缺 Key 直接提示
    if (!apiKey && !localNow) {
      message.warning(t("settings.msg.needKey"));
      return;
    }
    if (!model) {
      message.warning(t("settings.provider.modelRequired"));
      return;
    }
    const cfg: ProviderConfig = {
      provider: providerName,
      apiKey: apiKey ?? "",
      model,
      baseUrl:
        providerName === "custom" || localNow ? baseUrlRaw || null : null,
      temperature: 0,
      maxRetries: 0,
    };
    setTestingModel(true);
    try {
      const msg = await api.testModel(cfg);
      message.success(msg);
    } catch (e) {
      message.error(t("settings.msg.testFailed", { error: String(e) }));
    }
    setTestingModel(false);
  }

  async function handleFetchModels() {
    const apiKey = form.getFieldValue("apiKey")?.trim() as string | undefined;
    const providerName = form.getFieldValue("provider") as string;
    const baseUrlRaw = form.getFieldValue("baseUrl")?.trim() as string | undefined;
    const localNow = isLocalProvider(providerName, baseUrlRaw);
    if (!apiKey && !localNow) {
      message.warning(t("settings.msg.needKey"));
      return;
    }
    const cfg: ProviderConfig = {
      provider: providerName,
      apiKey: apiKey ?? "",
      model: null,
      // 本地档要带上用户填的地址（留空则后端回退到预设端口）
      baseUrl:
        providerName === "custom" || localNow ? baseUrlRaw || null : null,
      temperature: 0.7,
      maxRetries: 2,
    };
    setLoadingModels(true);
    try {
      const models = await api.listModels(cfg);
      setModelOptions(models);
      // 拉取结果存入该服务商，切换服务商时各自显示
      const opts = {
        ...(form.getFieldValue("providerModelOptions") ?? {}),
        [providerName]: models,
      };
      form.setFieldValue("providerModelOptions", opts);
      if (models.length > 0) {
        message.success(t("settings.msg.fetched", { n: models.length }));
        const cur = form.getFieldValue("model");
        if (!cur) {
          form.setFieldValue("model", models[0].id);
        }
      } else {
        message.info(t("settings.msg.fetchEmpty"));
      }
    } catch (e) {
      message.error(t("settings.msg.fetchFailed", { error: String(e) }));
    }
    setLoadingModels(false);
  }

  async function handleSave() {
    // 分组为条件渲染：validateFields 只能校验当前挂载（当前分组）的字段，
    // 用于拦截可见的填写错误；保存值必须从 form store 取全量
    // （未挂载字段的值因 preserve 仍保留在 store 中，getFieldsValue(true) 全量返回）。
    try {
      await form.validateFields();
    } catch {
      return; // 当前分组有校验错误（如 API Key 为空），antd 已在字段下方标红
    }
    const v = form.getFieldsValue(true) as FormValues;
    if (!v.provider || v.apiKey === undefined) {
      message.error(t("settings.msg.providerMissing"));
      return;
    }
    const custom = v.provider === "custom";
    // Base URL 只对「自定义」与「本地档」有意义：本地档需要它来换端口 /
    // 指向局域网里的另一台机器。云端预设仍不接受（防历史遗留值把请求打歪）。
    const keepBaseUrl = custom || isLocalProvider(v.provider, v.baseUrl);
    // 温度强制 2 位小数（智谱要求），防多位小数入库
    const temperature = Math.round((v.temperature ?? 0.7) * 100) / 100;
    // 该服务商的 key / 模型单独保存，切换服务商不串
    const providerApiKeys = {
      ...(v.providerApiKeys ?? {}),
      [v.provider]: v.apiKey.trim(),
    };
    const providerModels = {
      ...(v.providerModels ?? {}),
      [v.provider]: v.model?.trim() ?? "",
    };
    // 当前服务商的模型列表单独保存
    const providerModelOptions = {
      ...(v.providerModelOptions ?? {}),
      [v.provider]: modelOptions,
    };
    // 本弹窗负责的键；不在这个类型里的都归别的入口写：
    //   深度扫描规则 / 提示词 / AI 命名缓存 → 各自即时保存
    //   主题 / 语言 / 无字模式 → 顶栏快捷开关即时保存（已从表单移除）
    const formPart: Omit<
      Settings,
      "deepScanRules" | "customPrompts" | "aiNames" | "recentGameDirs" | "theme" | "language" | "iconOnly"
    > = {
      provider: {
        provider: v.provider,
        apiKey: v.apiKey.trim(),
        model: v.model?.trim() || null,
        baseUrl: keepBaseUrl ? v.baseUrl?.trim() || null : null,
        temperature,
        maxRetries: 2,
      },
      providerApiKeys,
      providerModels,
      providerModelOptions,
      userGlossary: (v.userGlossary ?? [])
        .filter(([en, zh]) => en.trim() && zh.trim())
        .map(([en, zh]) => [en.trim(), zh.trim()] as [string, string]),
      batchSize: v.batchSize,
      batchSizeAuto: v.batchSizeAuto ?? true,
      extractGlossary: v.extractGlossary,
      threading: {
        enabled: v.threadingEnabled ?? false,
        threadCount: Math.min(Math.max(v.threadCount ?? 1, 1), 8),
        requestIntervalSec: Math.min(Math.max(v.requestIntervalSec ?? 4, 1), 60),
      },
      packParallelEnabled: v.packParallelEnabled ?? false,
      packParallelCount: Math.max(v.packParallelCount ?? 2, 0),
      // theme / language / iconOnly 刻意不写：它们由顶栏快捷开关即时写盘，
      // 本弹窗只保存自己持有的字段（增量保存原则，见下方注释）
      closeBehavior: v.closeBehavior === "minimize" ? "minimize" : "exit",
      exportNaming:
        v.exportNaming === "raw" || v.exportNaming === "ai" ? v.exportNaming : "suffix",
    };
    try {
      // 增量保存：只写表单里的这些键。深度扫描规则、提示词、AI 命名缓存由各自的
      // 入口即时保存，绝不在这里整份写回（否则会用过期的内存快照把它们覆盖掉）
      await api.patchSettings(formPart as unknown as Record<string, unknown>);
      message.success(t("settings.msg.saved"));
      if (settings) onSaved({ ...settings, ...formPart });
      onClose();
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <Modal
      title={t("settings.title")}
      open={open}
      onCancel={onClose}
      onOk={() => void handleSave()}
      width={880}
      className="settings-modal"
      destroyOnClose
    >
      <div style={{ display: "flex", gap: 16 }}>
        {/* 左侧分组导航：做成真正的侧边栏——整栏铺满内容高度、条目抬高，
            不再是一列挤在顶部的窄按钮。宽度与主界面侧栏(200)对齐，
            两处导航的"手"才一致。 */}
        <div className="settings-nav">
          <SlideNav
            items={SECTIONS.map((s) => ({ key: s.key, label: t(s.labelKey), icon: s.icon }))}
            activeKey={activeSection}
            iconOnly={iconOnly}
            size="lg"
            onSelect={setActiveSection}
          />
        </div>

        {/* 右侧内容区：antd Form 数据存于 form 实例（与 DOM 无关），
            分组切换即时渲染；字段值/校验状态不丢失 */}
        <div
          ref={panelScrollRef}
          className="settings-panel"
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 480,
            overflowY: "auto",
            overflowX: "hidden",
            paddingTop: 4,
          }}
        >
          <Form form={form} layout="vertical">
            <div key={activeSection} className={panelAnim ? "panel-anim-root" : undefined}>
            {/* ===== 分组：服务商与模型 ===== */}
            {activeSection === "provider" && (
            <div>
              <PanelBlock index={0}>
                <Typography.Text strong>{t("settings.provider.groupTitle")}</Typography.Text>
                {/* 分组介绍：无字模式下收起 —— 它只是"介绍这个软件的行为"，
                    用户不会因为它而改变任何操作（判定报告 ①#7） */}
                <Typography.Paragraph
                  type="secondary"
                  className="io-hide"
                  style={{ fontSize: 12, marginBottom: 12 }}
                >
                  {t("settings.provider.groupDesc")}
                </Typography.Paragraph>
              </PanelBlock>

              <PanelBlock index={1}>
                <Form.Item name="provider" label={t("settings.provider.label")}>
                  <ProviderGrid iconOnly={iconOnly} />
                </Form.Item>
              </PanelBlock>

              {/* 隐藏字段：各服务商保存的 key / 模型 / 模型列表 */}
              <Form.Item name="providerApiKeys" hidden>
                <Input />
              </Form.Item>
              <Form.Item name="providerModels" hidden>
                <Input />
              </Form.Item>
              <Form.Item name="providerModelOptions" hidden>
                <Input />
              </Form.Item>

              {/* 服务商联动内容：provider 一变就整块重挂载 → 入场错峰重播。
                  字段值存于 form 实例（apiKey/model 按服务商分别保存在 providerApiKeys /
                  providerModels），重挂载不会丢；上面的隐藏字段留在外层，不参与重挂载。 */}
              <div key={provider ?? "none"} className={providerAnim ? "panel-anim-root" : undefined}>
              <PanelBlock index={0}>
                {/* 服务商补充说明：无字模式下整段收起（与 .io-hide 其余 14 处同一处置）。
                    这些段落是"第一次配置时的引导"，逐条都在讲怎么把服务跑起来；
                    无字模式下用户要的就是省地方，成段说明只会把表单往下推。
                    句句仍是**常规模式**的首屏引导，一个字没删。 */}
                {provider && PROVIDER_HINTS[provider] && (
                  <Typography.Paragraph
                    type="secondary"
                    className="io-hide"
                    style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}
                  >
                    {t(PROVIDER_HINTS[provider])}
                  </Typography.Paragraph>
                )}
              </PanelBlock>

              <PanelBlock index={1}>
              <Form.Item
                name="apiKey"
                label={
                  /* 无字模式：标签换成钥匙图标（名字仍可悬停看全）；
                     常规模式回退成原来的文字标签 —— 这一处改动只服务无字模式 */
                  iconOnly ? (
                    <Tooltip title={isLocal ? t("settings.provider.apiKeyOptionalTip") : "API Key"}>
                      <span><KeyGlyph /></span>
                    </Tooltip>
                  ) : (
                    "API Key"
                  )
                }
                /* 本地档不校验必填：Ollama 的服务端会忽略 Key、llama.cpp 默认免鉴权，
                   拦在这里只会让用户被迫随便填一串无用字符。 */
                rules={
                  isLocal
                    ? []
                    : [{ required: true, message: t("settings.provider.apiKeyRequired") }]
                }
              >
                <Input.Password
                  placeholder={
                    isLocal
                      ? t("settings.provider.apiKeyPlaceholderLocal")
                      : provider === "zhipu"
                        ? t("settings.provider.apiKeyPlaceholderZhipu")
                        : t("settings.provider.apiKeyPlaceholder")
                  }
                  addonAfter={
                    <Button
                      type="text"
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={loadingModels}
                      disabled={!provider}
                      onClick={() => void handleFetchModels()}
                    >
                      {t("settings.provider.fetchModels")}
                    </Button>
                  }
                />
              </Form.Item>
              </PanelBlock>

              <PanelBlock index={2}>
              <Form.Item
                name="model"
                label={
                  /* 同上：无字模式用立方体图标，常规模式回退文字「模型」 */
                  iconOnly ? (
                    <Tooltip title={t("settings.provider.modelLabel")}>
                      <span><ModelGlyph /></span>
                    </Tooltip>
                  ) : (
                    "模型"
                  )
                }
                extra={
                  /* 无字模式收起：右侧按钮本身就写着「获取模型列表」，是重复表述（判定报告 ①#8）。
                     用条件渲染而不是 CSS 隐藏 —— antd 的 Form.Item extra 没有稳定的外部类名可挂钩。 */
                  iconOnly
                    ? undefined
                    : provider === "zhipu"
                      ? t("settings.provider.modelExtraZhipu")
                      : t("settings.provider.modelExtra")
                }
              >
                {modelOptions.length === 0 ? (
                  // 未拉取列表：允许自由输入模型名
                  <Input
                    placeholder={
                      !provider
                        ? t("settings.provider.modelPlaceholderNeedKey")
                        : isLocal && !PROVIDER_PRESETS[provider]?.model
                          ? /* 本地档刻意不预设模型名：本地有哪些模型只有用户自己知道，
                               指个具体模型名只会在没拉取时报"模型不存在" */
                            t("settings.provider.modelPlaceholderLocal")
                          : PROVIDER_PRESETS[provider]?.model || t("settings.provider.modelPlaceholderCustom")
                    }
                  />
                ) : (
                  // 已拉取列表：Select 自带搜索，原生虚拟化支持数百项
                  <Select
                    showSearch
                    placeholder={t("settings.provider.modelSearch")}
                    optionFilterProp="label"
                    filterOption={(input, option) => {
                      const v = String(option?.value ?? "").toLowerCase();
                      const l = String(option?.label ?? "").toLowerCase();
                      const q = input.toLowerCase();
                      return v.includes(q) || l.includes(q);
                    }}
                    filterSort={(a, b) => {
                      // 免费模型优先，再按 id 升序
                      const va = String(a?.value ?? "").toLowerCase();
                      const vb = String(b?.value ?? "").toLowerCase();
                      const fa = va.includes("free") ? 1 : 0;
                      const fb = vb.includes("free") ? 1 : 0;
                      if (fa !== fb) return fb - fa;
                      return va.localeCompare(vb);
                    }}
                    optionRender={(option) => {
                      const id = String(option.value ?? "");
                      const free = id.toLowerCase().includes("free");
                      return (
                        <span
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={id}
                          >
                            {id}
                          </span>
                          {free && (
                            <Tag
                              color="green"
                              style={{
                                marginInline: 0,
                                flexShrink: 0,
                                fontSize: 11,
                                lineHeight: "18px",
                              }}
                            >
                              {t("settings.provider.free")}
                            </Tag>
                          )}
                        </span>
                      );
                    }}
                    options={selectOptions.map((m) => ({
                      value: m.id,
                      label: m.id,
                    }))}
                  />
                )}
              </Form.Item>
              </PanelBlock>

              <PanelBlock index={3}>
              {/* 连接验证（链接样式小按钮）+ 选中模型为免费时标注 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginTop: -4,
                  marginBottom: 12,
                }}
              >
                <Button
                  type="link"
                  size="small"
                  icon={<ApiOutlined />}
                  loading={testingModel}
                  onClick={() => void handleTestModel()}
                  style={{ paddingInline: 0 }}
                >
                  {t("settings.provider.testConnection")}
                </Button>
              </div>
              </PanelBlock>

              <PanelBlock index={4}>
              {/* Base URL 展示：自定义与本地档可编辑；其余预设只读灰色 + 官网跳转。
                  本地档必须可编辑 —— 换端口（11434→11500）或把服务跑在另一台机器上
                  是常见用法，锁死就只能改用「自定义」重配一遍。 */}
              {provider === "custom" || isLocalPreset ? (
                <Form.Item
                  name="baseUrl"
                  label={t("settings.provider.baseUrl")}
                  /* 无字模式收起：本地档（Ollama / llama.cpp）专属的灰字说明，
                     与上面那条服务商说明同属"引导性灰字"。用条件渲染而不是 CSS ——
                     antd 的 Form.Item extra 没有稳定的外部类名可挂钩（同 model 那条）。 */
                  extra={
                    isLocalPreset && !iconOnly
                      ? t("settings.provider.baseUrlLocalExtra")
                      : undefined
                  }
                >
                  <Input
                    placeholder={PROVIDER_PRESETS[provider]?.baseUrl || "https://..."}
                  />
                </Form.Item>
              ) : (
                provider && PROVIDER_PRESETS[provider]?.baseUrl && (
                  <Form.Item label={t("settings.provider.baseUrl")}>
                    <Input
                      disabled
                      value={PROVIDER_PRESETS[provider].baseUrl}
                      addonAfter={
                        PROVIDER_PRESETS[provider]?.website ? (
                          <Typography.Link
                            onClick={() =>
                              void openUrl(PROVIDER_PRESETS[provider].website)
                            }
                            style={{ fontSize: 12 }}
                          >
                            <LinkOutlined /> {t("settings.provider.website")}
                          </Typography.Link>
                        ) : undefined
                      }
                    />
                  </Form.Item>
                )
              )}
              </PanelBlock>
              </div>
            </div>
            )}

            {/* ===== 分组：翻译参数 ===== */}
            {activeSection === "params" && (
            <div>
              <PanelBlock index={0}>
                <Typography.Text strong>{t("settings.params.groupTitle")}</Typography.Text>
                {/* 无字模式收起：两个字段各自已有 tooltip 在讲同一件事（判定报告 ①#9） */}
                <Typography.Paragraph
                  type="secondary"
                  className="io-hide"
                  style={{ fontSize: 12, marginBottom: 12 }}
                >
                  {t("settings.params.groupDesc")}
                </Typography.Paragraph>
              </PanelBlock>
              <PanelBlock index={1}>
              <Space size="large" wrap>
                <Form.Item name="temperature" label={t("settings.params.temperature")} style={{ marginBottom: 8 }}>
                  <InputNumber min={0} max={2} step={0.01} precision={2} />
                </Form.Item>
                <Form.Item
                  name="batchSizeAuto"
                  label={t("settings.params.batchSizeAuto")}
                  valuePropName="checked"
                  style={{ marginBottom: 8 }}
                  tooltip={t("settings.params.batchSizeAutoTooltip")}
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  name="batchSize"
                  label={t("settings.params.batchSize")}
                  style={{ marginBottom: 8 }}
                  tooltip={t("settings.params.batchSizeTooltip")}
                >
                  <InputNumber min={1} max={200} disabled={batchSizeAuto} />
                </Form.Item>
              </Space>
              </PanelBlock>
            </div>
            )}

            {/* ===== 分组：术语表 ===== */}
            {activeSection === "glossary" && (
            <div>
              <PanelBlock index={0}>
                {/* 分组标题：无字模式下格式约定改挂这里（判定报告 ②#4）。
                    常规档不加 Tooltip —— 下方灰字原件还在，重复提示没有意义。 */}
                <Tooltip title={iconOnly ? t("settings.glossary.customDescTip") : undefined}>
                  <Typography.Text strong>{t("settings.glossary.groupTitle")}</Typography.Text>
                </Tooltip>
                {/* 无字模式收起：纯介绍（判定报告 ①#10） */}
                <Typography.Paragraph
                  type="secondary"
                  className="io-hide"
                  style={{ fontSize: 12, marginBottom: 12 }}
                >
                  {t("settings.glossary.groupDesc")}
                </Typography.Paragraph>
              </PanelBlock>

              <PanelBlock index={1}>
              <Form.Item
                name="extractGlossary"
                label={t("settings.glossary.extract")}
                valuePropName="checked"
                style={{ marginBottom: 12 }}
                tooltip={t("settings.glossary.extractTooltip")}
              >
                <Switch />
              </Form.Item>
              </PanelBlock>

              <PanelBlock index={2}>
              <Typography.Text type="secondary" className="io-hide">
                {t("settings.glossary.customDesc")}
              </Typography.Text>
              </PanelBlock>
              {/* 行外壳负责入场 + 高度收拢，行内容负责横向滑出（见 App.css 的
                  .anim-list-item / .anim-collapse / .anim-item-slide-out）。
                  这里刻意不再套 PanelBlock —— 否则容器与行会叠两层同向动画。
                  删除走"先播离场、动画结束再 remove"，空态文案与离场行不会叠在一起。 */}
              <div>
              <Form.List name="userGlossary">
                {(fields, { add, remove }) => (
                  <div style={{ marginTop: 8 }}>
                    {fields.length === 0 && (
                      /* 无字模式收起：空列表 + 下面一个大虚线「+」按钮本身已经说明一切（判定报告 ①#11） */
                      <Typography.Paragraph type="secondary" className="io-hide" style={{ marginBottom: 8 }}>
                        {t("settings.glossary.empty")}
                      </Typography.Paragraph>
                    )}
                    {fields.map(({ key, name }) => {
                      const leaving = leavingGlossary.includes(key);
                      return (
                      <div
                        key={key}
                        className={`anim-list-item anim-collapse${leaving ? " is-leaving" : ""}`}
                      >
                        <Space
                          align="baseline"
                          className={leaving ? "anim-item-slide-out" : undefined}
                          style={{ display: "flex" }}
                          onAnimationEnd={(e) => {
                            // 入场动画同样会冒泡 animationend：只认离场关键帧
                            if (e.target !== e.currentTarget || e.animationName !== "motion-slide-out") return;
                            setLeavingGlossary((s) => s.filter((k) => k !== key));
                            remove(name);
                          }}
                        >
                          <Form.Item name={[name, 0]} rules={[{ required: true, message: t("settings.glossary.enRequired") }]}>
                            <Input placeholder={t("settings.glossary.enPlaceholder")} style={{ width: 200 }} />
                          </Form.Item>
                          <Form.Item name={[name, 1]} rules={[{ required: true, message: t("settings.glossary.zhRequired") }]}>
                            <Input placeholder={t("settings.glossary.zhPlaceholder")} style={{ width: 200 }} />
                          </Form.Item>
                          <MinusCircleOutlined
                            onClick={() => setLeavingGlossary((s) => (s.includes(key) ? s : [...s, key]))}
                          />
                        </Space>
                      </div>
                      );
                    })}
                    <Button
                      type="dashed"
                      onClick={() => add(["", ""])}
                      block
                      icon={<PlusOutlined />}
                    >
                      {t("settings.glossary.add")}
                    </Button>
                  </div>
                )}
              </Form.List>
              </div>

              {/* 自定义提示词入口（并入术语表分组：统一译名与翻译风格） */}
              <PanelBlock index={3}>
              <Divider style={{ margin: "12px 0 8px" }} />
              <Button
                block
                icon={<EditOutlined />}
                onClick={() => setPromptEditorOpen(true)}
                style={{ marginBottom: 8 }}
              >
                {t("settings.glossary.openPrompts")}
              </Button>
              </PanelBlock>
            </div>
            )}

            {/* ===== 分组：深度扫描（模组 / 插件各自独立规则） ===== */}
            {activeSection === "deepscan" && (
            <div>
              <PanelBlock index={0}>
                {/* 分组标题：无字模式下模板说明改挂这里（判定报告 ②#5） */}
                <Tooltip title={iconOnly ? t("settings.deepScan.groupHintTip") : undefined}>
                  <Typography.Text strong>{t("settings.deepScan.groupTitle")}</Typography.Text>
                </Tooltip>
                {/* 无字模式收起：纯介绍，真正的规则说明在规则弹窗里逐条写着（判定报告 ①#12） */}
                <Typography.Paragraph type="secondary" className="io-hide" style={{ fontSize: 12, marginBottom: 12 }}>
                  {t("settings.deepScan.groupDesc")}
                </Typography.Paragraph>
              </PanelBlock>
              <PanelBlock index={1}>
                {(["mod", "plugin"] as const).map((k) => {
                  const r = settings?.deepScanRules?.[k];
                  const enabled = r
                    ? [
                        r.scopeJson, r.scopeLang, r.scopeText, r.scopeNested, r.scopeClass,
                        r.skipMeta, r.skipLangfiles, r.skipLibs, r.onlySourceLocale, r.keepCjk,
                        r.dropSql, r.dropDescriptor, r.dropLog, r.dropIdent, r.classNeedsMarker,
                      ].filter(Boolean).length
                    : 0;
                  const customOn = r?.custom.filter((c) => c.enabled).length ?? 0;
                  return (
                    <div key={k} style={{ marginBottom: 16 }}>
                      <Button
                        block
                        icon={<DeepScanIcon />}
                        onClick={() => setDeepScanEditor(k)}
                      >
                        {t(k === "plugin" ? "settings.deepScan.titlePlugin" : "settings.deepScan.titleMod")}
                      </Button>
                      <Space size={6} wrap style={{ marginTop: 4 }}>
                        <Tag color={r?.auto ? "green" : "default"}>
                          {t(r?.auto ? "settings.deepScan.autoOn" : "settings.deepScan.autoOff")}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t("settings.deepScan.summary", { n: enabled, auto: "" }).replace(" · ", "")}
                          {customOn > 0 ? ` · ${t("settings.deepScan.customOn", { n: customOn })}` : ""}
                        </Typography.Text>
                      </Space>
                    </div>
                  );
                })}
              </PanelBlock>
              <PanelBlock index={2}>
                {/* 无字模式收起：整段都是"怎么用"的说明（模板约定 + 改完要重扫的提醒），
                    没有可保留的图标；规则本身在点开的规则弹窗里逐条写着。
                    本轮按用户点名隐藏 —— 常规模式照旧显示。 */}
                <Typography.Paragraph type="secondary" className="io-hide" style={{ fontSize: 12, marginBottom: 0 }}>
                  {t("settings.deepScan.groupHint")}
                </Typography.Paragraph>
              </PanelBlock>
            </div>
            )}

            {/* ===== 分组：翻译加速 ===== */}
            {activeSection === "threading" && (
            <div>
              <PanelBlock index={0}>
                <Typography.Text strong>{t("settings.threading.groupTitle")}</Typography.Text>
                {/* 无字模式收起整条橙色警告（用户点名）。信息没有丢：
                    「请求间隔」这一项自己挂着 tooltip，写着"间隔越大越不容易触发限流"，
                    429 的现实含义也由占位/默认值（4 秒）承担；整块 Alert 留成空盒子更难看。 */}
                <Alert
                  type="warning"
                  showIcon
                  className="io-hide"
                  style={{ margin: "8px 0 12px" }}
                  message={
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      {t("settings.threading.warn")}
                    </div>
                  }
                />
              </PanelBlock>
              <PanelBlock index={1}>
              <Space size="large" wrap align="start">
                <Form.Item
                  name="threadingEnabled"
                  label={t("settings.threading.enable")}
                  valuePropName="checked"
                  style={{ marginBottom: 4 }}
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  name="threadCount"
                  label={t("settings.threading.threads")}
                  style={{ marginBottom: 4 }}
                >
                  <Select
                    style={{ width: 120 }}
                    options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
                      value: n,
                      label: `${t("settings.threading.threadLabel", { n })}${n === 1 ? t("settings.threading.threadSingle") : ""}`,
                    }))}
                    disabled={!threadingEnabled}
                  />
                </Form.Item>
                <Form.Item
                  name="requestIntervalSec"
                  label={t("settings.threading.interval")}
                  style={{ marginBottom: 4 }}
                  tooltip={t("settings.threading.intervalTooltip")}
                >
                  <InputNumber
                    min={1}
                    max={60}
                    step={1}
                    addonAfter={t("settings.threading.seconds")}
                    disabled={!threadingEnabled}
                  />
                </Form.Item>
              </Space>
              </PanelBlock>

              <PanelBlock index={2}>
              <Divider style={{ margin: "8px 0 12px" }} />

              {/* 内容包并行翻译（与上面单包线程并行相互独立） */}
              <Space size="large" wrap align="start">
                <Form.Item
                  name="packParallelEnabled"
                  label={t("settings.threading.packEnable")}
                  valuePropName="checked"
                  style={{ marginBottom: 4 }}
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  name="packParallelCount"
                  label={t("settings.threading.packCount")}
                  style={{ marginBottom: 4 }}
                >
                  <Select
                    style={{ width: 190 }}
                    disabled={!packParallelEnabled}
                    options={[
                      { value: 2, label: t("settings.threading.packCount2") },
                      { value: 4, label: t("settings.threading.packCount4") },
                      { value: 8, label: t("settings.threading.packCount8") },
                      { value: 0, label: t("settings.threading.packCountInf") },
                    ]}
                  />
                </Form.Item>
              </Space>
              <Alert
                type="warning"
                showIcon
                className="io-hide"
                style={{ marginBottom: 12 }}
                message={
                  <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                    {t("settings.threading.packWarn")}
                  </div>
                }
              />
              </PanelBlock>

            </div>
            )}

            {/* ===== 分组：个性化设置（导出命名 / 关闭行为） =====
                主题 / 语言 / 无字模式已搬到顶栏右上角的快捷开关（点一下即改、无需保存），
                这里只留"需要想一下、且适合一并保存"的两项。 */}
            {activeSection === "appearance" && (
            <div>
              <PanelBlock index={0}>
                <Typography.Text strong>{t("settings.appearance.groupTitle")}</Typography.Text>
                {/* 无字模式收起：分组标题已把内容列全（判定报告 ①#14） */}
                <Typography.Paragraph
                  type="secondary"
                  className="io-hide"
                  style={{ fontSize: 12, marginBottom: 16 }}
                >
                  {t("settings.appearance.groupDesc")}
                </Typography.Paragraph>
              </PanelBlock>
              <PanelBlock index={1}>

              {/* 两列并排：导出命名偏好 | 关闭行为
                  第一列必须用 **max-content**（而不是 1fr）：命名偏好有三个按钮
                  （原名 / 原名_zh_cn / AI 汉化名称），等分列宽时放不下就会把第三个
                  挤到第二行 —— 而 antd 的 Radio.Button 靠 `:not(:first-child) { margin-left: -1px }`
                  共享边框，单独一行的那颗会缺左边框、圆角也对不上，看起来就是"错位"。
                  改成按内容定宽后第一列拿到完整空间，永不折行；第二列仍可伸缩，
                  极窄窗口下优先牺牲它，而不是去拆命名那一组。 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content minmax(0, 1fr)",
                  gap: "4px 32px",
                  marginTop: 4,
                }}
              >
                <Form.Item
                  name="exportNaming"
                  label={t("settings.appearance.exportNaming")}
                  style={{ marginBottom: 8 }}
                  tooltip={t("settings.appearance.exportNamingTip")}
                >
                  <Radio.Group optionType="button" buttonStyle="solid">
                    <Radio.Button value="raw">{t("settings.appearance.namingRaw")}</Radio.Button>
                    <Radio.Button value="suffix">{t("settings.appearance.namingSuffix")}</Radio.Button>
                    <Radio.Button value="ai">{t("settings.appearance.namingAi")}</Radio.Button>
                  </Radio.Group>
                </Form.Item>

                <Form.Item
                  name="closeBehavior"
                  label={t("settings.appearance.closeBehavior")}
                  style={{ marginBottom: 8 }}
                  tooltip={t("settings.appearance.closeBehaviorTip")}
                >
                  <Radio.Group optionType="button" buttonStyle="solid">
                    <Radio.Button value="exit">{t("settings.appearance.closeExit")}</Radio.Button>
                    <Radio.Button value="minimize">{t("settings.appearance.closeMinimize")}</Radio.Button>
                  </Radio.Group>
                </Form.Item>

              </div>
              </PanelBlock>
            </div>
            )}

            {/* ===== 分组：关于 ===== */}
            {activeSection === "about" && (
            <div>
              {/* about:author：作者 / 项目信息（纯展示） */}
              <PanelBlock index={0}>
              <div style={{ textAlign: "center", paddingTop: 24 }}>
                <Typography.Title level={5} style={{ marginBottom: 4 }}>
                  <img src="/app-icon.svg" alt="" style={{ height: 22, marginRight: 8, verticalAlign: "middle" }} /> {t("settings.about.title")} v{appVersion}
                </Typography.Title>
                {/* 软件简介 + 作者署名：无字模式下收起（用户点名）。
                    标题行（图标 + 版本号）与下方 GitHub 链接保留 —— 一个"关于"页
                    在无字模式下面仍要有身份与入口，这两行是身份，不是说明。 */}
                <Typography.Paragraph type="secondary" className="io-hide" style={{ marginBottom: 4 }}>
                  {t("settings.about.desc")}
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary" className="io-hide" style={{ marginBottom: 8 }}>
                  {t("settings.about.author")}
                </Typography.Paragraph>
                <Typography.Link
                  onClick={() => void openUrl(GITHUB_URL)}
                  style={{ fontWeight: 600 }}
                >
                  <img src="/github.svg" alt="" style={{ height: 14, marginRight: 4, verticalAlign: "middle" }} /> GitHub：github.com/adssadax-1/mc-content-localizer
                </Typography.Link>
              </div>
              </PanelBlock>

              <PanelBlock index={1}>
              <Divider style={{ margin: "16px 0 12px" }} />

              {/* about:storage：本地数据统计与清理（只动软件自己的数据目录） */}
              <div style={{ textAlign: "center" }}>
                <Typography.Text strong>{t("settings.storage.title")}</Typography.Text>
                {/* 无字模式收起：范围说明（用户点名）。下方两组数字 Tag 与两个按钮
                    自己就把"这里管什么"表达清楚了；数据目录那行是**读数**，照旧保留。 */}
                <Typography.Paragraph type="secondary" className="io-hide" style={{ fontSize: 12, margin: "4px 0 8px" }}>
                  {t("settings.storage.desc")}
                </Typography.Paragraph>
                <Space size={6} wrap style={{ justifyContent: "center", width: "100%" }}>
                  <Tag color="default">
                    {t("settings.storage.cacheTag", { size: fmtBytes(storage?.cacheBytes ?? 0) })}
                  </Tag>
                  <Tag color="default">
                    {t("settings.storage.userTag", { size: fmtBytes(storage?.userBytes ?? 0) })}
                  </Tag>
                  <Button
                    size="small"
                    type="text"
                    icon={<ReloadOutlined />}
                    loading={storageBusy !== null}
                    onClick={() => void loadStorage()}
                  >
                    {t("settings.storage.refresh")}
                  </Button>
                </Space>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    justifyContent: "center",
                  }}
                >
                  {/* 这两个按钮在无字模式下文字收起、只留图标（用户点名）。
                      文字包 .ui-label 折叠，尺寸由 App.css 的 .settings-modal 规则兜住 ——
                      折叠后只剩图标，若不兜 min-width 会缩成比图标还窄的小方块。
                      图标本身（垃圾桶 / 清除）不足以区分"清缓存"和"清用户数据"，
                      所以补 Tooltip 给名字。 */}
                  <Tooltip title={iconOnly ? t("settings.storage.clearCache") : undefined}>
                    <Button
                      size="small"
                      icon={<ClearOutlined />}
                      loading={storageBusy === "cache"}
                      disabled={storageBusy === "data"}
                      onClick={handleClearCache}
                    >
                      <span className="ui-label">{t("settings.storage.clearCache")}</span>
                    </Button>
                  </Tooltip>
                  <Tooltip title={iconOnly ? t("settings.storage.clearData") : undefined}>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      loading={storageBusy === "data"}
                      disabled={storageBusy === "cache"}
                      onClick={handleClearData}
                    >
                      <span className="ui-label">{t("settings.storage.clearData")}</span>
                    </Button>
                  </Tooltip>
                </div>
                <Typography.Paragraph
                  type="secondary"
                  style={{ fontSize: 11, marginTop: 8, marginBottom: 0, wordBreak: "break-all" }}
                  copyable={{ text: `${storage?.configDir ?? ""}
${storage?.profileDir ?? ""}` }}
                >
                  {t("settings.storage.paths")}：{storage?.configDir || "—"}
                  <br />
                  {storage?.profileDir || "—"}
                </Typography.Paragraph>
              </div>

              <Divider style={{ margin: "16px 0 12px" }} />

              {/* about:update：检查更新 */}
              <div style={{ textAlign: "center" }}>
                <Button
                  size="small"
                  type="link"
                  loading={checkingUpdate}
                  onClick={() => void handleCheckUpdate()}
                >
                  <img src="/refresh.svg" alt="" style={{ height: 12, marginRight: 4, verticalAlign: "middle" }} /> {t("settings.about.checkUpdate", { version: appVersion })}
                </Button>
              </div>
              </PanelBlock>
            </div>
            )}
            </div>
            </Form>
        </div>
      </div>

      {/* 清除用户数据第 2 步：明确询问「你确定你在干什么吗」，勾选后才允许执行 */}
      <Modal
        open={wipeStage === 2}
        title={
          <Space size={6}>
            <span style={{ color: "#ff4d4f" }}>⚠</span>
            {t("settings.storage.confirmTitle")}
          </Space>
        }
        okText={t("settings.storage.exec")}
        okButtonProps={{ danger: true, disabled: !wipeAck, loading: storageBusy === "data" }}
        cancelText={t("settings.storage.cancel")}
        onOk={() => void runWipe()}
        onCancel={() => {
          setWipeStage(0);
          setWipeAck(false);
        }}
        width={460}
        maskClosable={false}
      >
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("settings.storage.willDelete")}
          description={t("settings.storage.clearDataDesc")}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t("settings.storage.confirmDesc")}
        </Typography.Paragraph>
        <Checkbox checked={wipeAck} onChange={(e) => setWipeAck(e.target.checked)}>
          {t("settings.storage.ack")}
        </Checkbox>
      </Modal>

      <DeepScanRulesModal
        open={deepScanEditor !== null}
        scopeKey={`global.${deepScanEditor ?? "mod"}`}
        kind={deepScanEditor ?? "mod"}
        rules={
          (deepScanEditor === "plugin"
            ? settings?.deepScanRules?.plugin
            : settings?.deepScanRules?.mod) as DeepScanRules
        }
        onClose={() => setDeepScanEditor(null)}
        onSave={async ({ rules }) => {
          if (!rules || !settings) return;
          if (!settings.deepScanRules) {
            message.error(t("settings.deepScan.missingRules"));
            return;
          }
          const next =
            deepScanEditor === "plugin"
              ? { ...settings, deepScanRules: { ...settings.deepScanRules, plugin: rules } }
              : { ...settings, deepScanRules: { ...settings.deepScanRules, mod: rules } };
          try {
            // 增量保存：只覆盖这一侧的规则（含自定义规则），其它设置一律不动
            await api.patchSettings({
              deepScanRules: { [deepScanEditor ?? "mod"]: rules },
            });
            onSaved(next);
            message.success(t("settings.msg.saved"));
          } catch (e) {
            message.error(String(e));
          }
          setDeepScanEditor(null);
        }}
      />

      <PromptEditorModal
        open={promptEditorOpen}
        settings={settings}
        onClose={() => setPromptEditorOpen(false)}
        onSaved={(s) => {
          onSaved(s);
          setPromptEditorOpen(false);
        }}
      />
    </Modal>
  );
}
