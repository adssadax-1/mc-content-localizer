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
  Typography,
} from "antd";
import {
  ApiOutlined,
  BookOutlined,
  BgColorsOutlined,
  CloudServerOutlined,
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
import { PROVIDER_PRESETS } from "../types";
import { ProviderGrid, PROVIDER_HINTS } from "./ProviderIcon";
import { PromptEditorModal } from "./PromptEditorModal";
import { DeepScanRulesModal } from "./DeepScanRulesModal";
import { DeepScanIcon } from "./DeepScanIcon";
import { SlideNav, PanelBlock } from "./SlideNav";
import { useTranslationContext } from "../i18n";

/** 主题选项的简约 SVG 图标（替代 emoji） */
function SunGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ verticalAlign: "-2px" }} aria-hidden="true">
      <circle cx="12" cy="12" r="4.6" fill="#F9A825" />
      <g stroke="#F9A825" strokeWidth="1.9" strokeLinecap="round">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
          const rad = (a * Math.PI) / 180;
          return (
            <line
              key={a}
              x1={12 + 6.6 * Math.cos(rad)}
              y1={12 + 6.6 * Math.sin(rad)}
              x2={12 + 9 * Math.cos(rad)}
              y2={12 + 9 * Math.sin(rad)}
            />
          );
        })}
      </g>
    </svg>
  );
}

function MoonGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ verticalAlign: "-2px" }} aria-hidden="true">
      <path d="M20.5 14.8A8.8 8.8 0 1 1 9.2 3.5a7.2 7.2 0 1 0 11.3 11.3z" fill="#5B7CFA" />
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
  /** 主题：light / dark */
  theme?: "light" | "dark";
  /** 界面语言：zh / en */
  language?: "zh" | "en";
  /** 关闭行为：exit / minimize */
  closeBehavior?: "exit" | "minimize";
  exportNaming?: "raw" | "suffix" | "ai";
  deepScanPlugin?: boolean;
}

/** 版本号兜底值（实际显示用 Tauri 返回的应用版本，避免与发布版本不一致） */
const FALLBACK_VERSION = "2.1.0";

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

export function SettingsModal({
  open,
  settings,
  initialSection,
  onClose,
  onSaved,
  onUserDataCleared,
}: Props) {
  const { t } = useTranslationContext();
  const [form] = Form.useForm<FormValues>();
  const provider = Form.useWatch("provider", form);
  const selectedModel = Form.useWatch("model", form);
  const threadingEnabled = Form.useWatch("threadingEnabled", form);
  const batchSizeAuto = Form.useWatch("batchSizeAuto", form) ?? true;
  const packParallelEnabled = Form.useWatch("packParallelEnabled", form) ?? false;
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

  /** 清除缓存（第 1 步 / 共 1 步）：只删会话快照与浏览器缓存 */
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
  const panelScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) setActiveSection(initialSection ?? "appearance");
  }, [open, initialSection]);

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
        theme: settings.theme ?? "light",
        language: settings.language ?? "zh",
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
    if (!apiKey) {
      message.warning(t("settings.msg.needKey"));
      return;
    }
    if (!model) {
      message.warning("请先选择或输入模型");
      return;
    }
    const cfg: ProviderConfig = {
      provider: providerName,
      apiKey,
      model,
      baseUrl: providerName === "custom" ? (form.getFieldValue("baseUrl")?.trim() || null) : null,
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
    if (!apiKey) {
      message.warning(t("settings.msg.needKey"));
      return;
    }
    const cfg: ProviderConfig = {
      provider: providerName,
      apiKey,
      model: null,
      baseUrl: null,
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
    // 表单负责的键；深度扫描规则 / 提示词 / AI 命名缓存不在此列（它们各自即时保存）
    const formPart: Omit<
      Settings,
      "deepScanRules" | "customPrompts" | "aiNames" | "recentGameDirs"
    > = {
      provider: {
        provider: v.provider,
        apiKey: v.apiKey.trim(),
        model: v.model?.trim() || null,
        baseUrl: custom ? v.baseUrl?.trim() || null : null,
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
      theme: v.theme === "dark" ? "dark" : "light",
      language: v.language === "en" ? "en" : "zh",
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
      width={760}
      destroyOnClose
    >
      <div style={{ display: "flex", gap: 16 }}>
        {/* 左侧分组导航 */}
        <div
          style={{
            width: 148,
            flexShrink: 0,
            borderRight: "1px solid var(--border-color, #F0F2F5)",
            paddingTop: 4,
          }}
        >
          <SlideNav
            items={SECTIONS.map((s) => ({ key: s.key, label: t(s.labelKey), icon: s.icon }))}
            activeKey={activeSection}
            onSelect={setActiveSection}
          />
        </div>

        {/* 右侧内容区：antd Form 数据存于 form 实例（与 DOM 无关），
            分组切换即时渲染；字段值/校验状态不丢失 */}
        <div
          ref={panelScrollRef}
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
                <Typography.Paragraph
                  type="secondary"
                  style={{ fontSize: 12, marginBottom: 12 }}
                >
                  {t("settings.provider.groupDesc")}
                </Typography.Paragraph>
              </PanelBlock>

              <PanelBlock index={1}>
                <Form.Item name="provider" label={t("settings.provider.label")}>
                  <ProviderGrid />
                </Form.Item>
                {provider && PROVIDER_HINTS[provider] && (
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
                    {t(PROVIDER_HINTS[provider])}
                  </Typography.Paragraph>
                )}
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

              <PanelBlock index={3}>
              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: true, message: t("settings.provider.apiKeyRequired") }]}
              >
                <Input.Password
                  placeholder={
                    provider === "zhipu"
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

              <PanelBlock index={4}>
              <Form.Item
                name="model"
                label="模型"
                extra={
                  provider === "zhipu"
                    ? t("settings.provider.modelExtraZhipu")
                    : t("settings.provider.modelExtra")
                }
              >
                {modelOptions.length === 0 ? (
                  // 未拉取列表：允许自由输入模型名
                  <Input
                    placeholder={
                      provider
                        ? PROVIDER_PRESETS[provider]?.model || t("settings.provider.modelPlaceholderCustom")
                        : t("settings.provider.modelPlaceholderNeedKey")
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

              <PanelBlock index={5}>
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

              <PanelBlock index={6}>
              {/* Base URL 展示：自定义可编辑；预设只读灰色 + 官网跳转 */}
              {provider === "custom" ? (
                <Form.Item name="baseUrl" label={t("settings.provider.baseUrl")}>
                  <Input placeholder="https://..." />
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
            )}

            {/* ===== 分组：翻译参数 ===== */}
            {activeSection === "params" && (
            <div>
              <PanelBlock index={0}>
                <Typography.Text strong>{t("settings.params.groupTitle")}</Typography.Text>
                <Typography.Paragraph
                  type="secondary"
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
                <Typography.Text strong>{t("settings.glossary.groupTitle")}</Typography.Text>
                <Typography.Paragraph
                  type="secondary"
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
              <Typography.Text type="secondary">
                {t("settings.glossary.customDesc")}
              </Typography.Text>
              </PanelBlock>
              <PanelBlock index={3}>
              <Form.List name="userGlossary">
                {(fields, { add, remove }) => (
                  <div style={{ marginTop: 8 }}>
                    {fields.length === 0 && (
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                        {t("settings.glossary.empty")}
                      </Typography.Paragraph>
                    )}
                    {fields.map(({ key, name }) => (
                      <Space key={key} align="baseline" style={{ display: "flex" }}>
                        <Form.Item name={[name, 0]} rules={[{ required: true, message: t("settings.glossary.enRequired") }]}>
                          <Input placeholder={t("settings.glossary.enPlaceholder")} style={{ width: 200 }} />
                        </Form.Item>
                        <Form.Item name={[name, 1]} rules={[{ required: true, message: t("settings.glossary.zhRequired") }]}>
                          <Input placeholder={t("settings.glossary.zhPlaceholder")} style={{ width: 200 }} />
                        </Form.Item>
                        <MinusCircleOutlined onClick={() => remove(name)} />
                      </Space>
                    ))}
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
              </PanelBlock>

              {/* 自定义提示词入口（并入术语表分组：统一译名与翻译风格） */}
              <PanelBlock index={4}>
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
                <Typography.Text strong>{t("settings.deepScan.groupTitle")}</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
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
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
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
                <Alert
                  type="warning"
                  showIcon
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

            {/* ===== 分组：个性化设置（主题 / 语言 / 导出命名 / 关闭行为 / 深度扫描） ===== */}
            {activeSection === "appearance" && (
            <div>
              <PanelBlock index={0}>
                <Typography.Text strong>{t("settings.appearance.groupTitle")}</Typography.Text>
                <Typography.Paragraph
                  type="secondary"
                  style={{ fontSize: 12, marginBottom: 16 }}
                >
                  {t("settings.appearance.groupDesc")}
                </Typography.Paragraph>
              </PanelBlock>
              <PanelBlock index={1}>
              <Space size="large" wrap align="start">
                <Form.Item name="theme" label={t("settings.appearance.theme")} style={{ marginBottom: 8 }}>
                  <Radio.Group optionType="button" buttonStyle="solid">
                    <Radio.Button value="light"><SunGlyph /> {t("settings.appearance.light")}</Radio.Button>
                    <Radio.Button value="dark"><MoonGlyph /> {t("settings.appearance.dark")}</Radio.Button>
                  </Radio.Group>
                </Form.Item>

                <Form.Item name="language" label="语言 / Language" style={{ marginBottom: 8 }}>
                  <Radio.Group optionType="button" buttonStyle="solid">
                    <Radio.Button value="zh">中文</Radio.Button>
                    <Radio.Button value="en">English</Radio.Button>
                  </Radio.Group>
                </Form.Item>
              </Space>

              {/* 两列并排：导出命名偏好 | 关闭行为；模组深度扫描 | 插件深度扫描 */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
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
                <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
                  {t("settings.about.desc")}
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
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
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: "4px 0 8px" }}>
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
                  <Button
                    size="small"
                    loading={storageBusy === "cache"}
                    disabled={storageBusy === "data"}
                    onClick={handleClearCache}
                  >
                    {t("settings.storage.clearCache")}
                  </Button>
                  <Button
                    size="small"
                    danger
                    loading={storageBusy === "data"}
                    disabled={storageBusy === "cache"}
                    onClick={handleClearData}
                  >
                    {t("settings.storage.clearData")}
                  </Button>
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
