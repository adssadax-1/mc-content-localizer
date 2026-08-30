import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
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
import { api } from "../api";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ModelInfo, ProviderConfig, Settings } from "../types";
import { PROVIDER_PRESETS } from "../types";
import { ProviderGrid, PROVIDER_HINTS } from "./ProviderIcon";
import { PromptEditorModal } from "./PromptEditorModal";

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
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

interface FormValues {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature: number;
  batchSize: number;
  extractGlossary: boolean;
  packFormat: number;
  userGlossary: [string, string][];
  /** 各服务商保存的 key（隐藏字段） */
  providerApiKeys?: Record<string, string>;
  /** 各服务商保存的模型（隐藏字段） */
  providerModels?: Record<string, string>;
  /** 各服务商缓存的模型列表（隐藏字段） */
  providerModelOptions?: Record<string, ModelInfo[]>;
  /** 多线程翻译（实验性） */
  threadingEnabled?: boolean;
  threadCount?: number;
  requestIntervalSec?: number;
  /** 深度文本扫描 */
  deepScan?: boolean;
  /** 主题：light / dark */
  theme?: "light" | "dark";
  /** 界面语言：zh / en */
  language?: "zh" | "en";
}

/** 当前版本号（与 package.json / tauri.conf.json 一致） */
const CURRENT_VERSION = "2.0.1";

/** 项目 GitHub 地址 */
const GITHUB_URL = "https://github.com/adssadax-1/mc-content-localizer";

/** 设置分组（NAV / section 结构）：页面设置置顶为默认分组 */
const SECTIONS: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: "appearance", label: "页面设置", icon: <BgColorsOutlined /> },
  { key: "provider", label: "服务商与模型", icon: <CloudServerOutlined /> },
  { key: "params", label: "翻译参数", icon: <SlidersOutlined /> },
  { key: "glossary", label: "术语表", icon: <BookOutlined /> },
  { key: "threading", label: "翻译加速", icon: <ThunderboltOutlined /> },
  { key: "about", label: "关于", icon: <InfoCircleOutlined /> },
];

export function SettingsModal({ open, settings, onClose, onSaved }: Props) {
  const [form] = Form.useForm<FormValues>();
  const provider = Form.useWatch("provider", form);
  const selectedModel = Form.useWatch("model", form);
  const threadingEnabled = Form.useWatch("threadingEnabled", form);
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingModel, setTestingModel] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  /** 当前展示的设置分组（默认页面设置） */
  const [activeSection, setActiveSection] = useState<string>("appearance");

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
          title: "发现新版本",
          content: `当前 v${CURRENT_VERSION}，最新 v${info.latestVersion}。是否前往 GitHub 下载更新？`,
          okText: "前往下载",
          cancelText: "取消",
          onOk: () => void openUrl(info.url),
        });
      } else {
        message.success(`已是最新版本（v${CURRENT_VERSION}）`);
      }
    } catch (e) {
      message.error(String(e) || "连接不到 GitHub，无法检查更新");
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
        extractGlossary: settings.extractGlossary,
        threadingEnabled: settings.threading?.enabled ?? false,
        deepScan: settings.deepScan ?? false,
        threadCount: settings.threading?.threadCount ?? 2,
        requestIntervalSec: settings.threading?.requestIntervalSec ?? 4,
        userGlossary: settings.userGlossary.length ? settings.userGlossary : [],
        providerApiKeys: settings.providerApiKeys ?? {},
        providerModels: settings.providerModels ?? {},
        theme: settings.theme ?? "light",
        language: settings.language ?? "zh",
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
      message.warning("请先填写 API Key");
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
      message.error(`连接验证失败：${String(e)}`);
    }
    setTestingModel(false);
  }

  async function handleFetchModels() {
    const apiKey = form.getFieldValue("apiKey")?.trim() as string | undefined;
    const providerName = form.getFieldValue("provider") as string;
    if (!apiKey) {
      message.warning("请先填写 API Key");
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
        message.success(`获取到 ${models.length} 个模型（免费模型已标注）`);
        const cur = form.getFieldValue("model");
        if (!cur) {
          form.setFieldValue("model", models[0].id);
        }
      } else {
        message.info("未获取到模型列表，可手动输入模型名");
      }
    } catch (e) {
      message.error(`获取模型列表失败：${String(e)}`);
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
      message.error("服务商配置缺失，请先到「服务商与模型」分组检查");
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
    const next: Settings = {
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
      extractGlossary: v.extractGlossary,
      threading: {
        enabled: v.threadingEnabled ?? false,
        threadCount: Math.min(Math.max(v.threadCount ?? 1, 1), 8),
        requestIntervalSec: Math.min(Math.max(v.requestIntervalSec ?? 4, 1), 60),
      },
      deepScan: v.deepScan ?? false,
      theme: v.theme === "dark" ? "dark" : "light",
      language: v.language === "en" ? "en" : "zh",
      customPrompts: settings?.customPrompts ?? {},
    };
    try {
      await api.saveSettings(next);
      message.success("设置已保存");
      onSaved(next);
      onClose();
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <Modal
      title="设置"
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
          {SECTIONS.map((s) => (
            <Button
              key={s.key}
              block
              className="sider-nav-btn"
              type={activeSection === s.key ? "primary" : "text"}
              icon={s.icon}
              style={{
                justifyContent: "flex-start",
                textAlign: "left",
                marginTop: 6,
              }}
              onClick={() => setActiveSection(s.key)}
            >
              {s.label}
            </Button>
          ))}
        </div>

        {/* 右侧内容区：antd Form 数据存于 form 实例（与 DOM 无关），
            分组切换即时渲染；字段值/校验状态不丢失 */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 480,
            overflowY: "auto",
            paddingTop: 4,
          }}
        >
          <Form form={form} layout="vertical">
            <div key={activeSection}>
            {/* ===== 分组：服务商与模型 ===== */}
            {activeSection === "provider" && (
            <div>
              <Typography.Text strong>AI 翻译服务</Typography.Text>
              <Typography.Paragraph
                type="secondary"
                style={{ fontSize: 12, marginBottom: 12 }}
              >
                各服务商的 API Key 与模型选择分别保存，切换服务商不串配置
              </Typography.Paragraph>

              <Form.Item name="provider" label="服务商">
                <ProviderGrid />
              </Form.Item>
              {provider && PROVIDER_HINTS[provider] && (
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
                  {PROVIDER_HINTS[provider]}
                </Typography.Paragraph>
              )}

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

              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: true, message: "请输入 API Key" }]}
              >
                <Input.Password
                  placeholder={
                    provider === "zhipu"
                      ? "在 bigmodel.cn 控制台创建（免费）"
                      : "粘贴你的 API Key"
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
                      获取模型列表
                    </Button>
                  }
                />
              </Form.Item>

              <Form.Item
                name="model"
                label="模型"
                extra={
                  provider === "zhipu"
                    ? "免费模型，也可拉取列表选择其他模型"
                    : "可点击「获取模型列表」拉取，或手动输入"
                }
              >
                {modelOptions.length === 0 ? (
                  // 未拉取列表：允许自由输入模型名
                  <Input
                    placeholder={
                      provider
                        ? PROVIDER_PRESETS[provider]?.model || "选择或输入模型名"
                        : "填写 API Key 后点击「获取模型列表」"
                    }
                  />
                ) : (
                  // 已拉取列表：Select 自带搜索，原生虚拟化支持数百项
                  <Select
                    showSearch
                    placeholder="搜索模型名称或 ID..."
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
                              免费
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
                  验证连接
                </Button>
              </div>

              {/* Base URL 展示：自定义可编辑；预设只读灰色 + 官网跳转 */}
              {provider === "custom" ? (
                <Form.Item name="baseUrl" label="Base URL（OpenAI 兼容端点）">
                  <Input placeholder="https://..." />
                </Form.Item>
              ) : (
                provider && PROVIDER_PRESETS[provider]?.baseUrl && (
                  <Form.Item label="Base URL（OpenAI 兼容端点）">
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
                            <LinkOutlined /> 官网
                          </Typography.Link>
                        ) : undefined
                      }
                    />
                  </Form.Item>
                )
              )}
            </div>
            )}

            {/* ===== 分组：翻译参数 ===== */}
            {activeSection === "params" && (
            <div>
              <Typography.Text strong>翻译参数</Typography.Text>
              <Typography.Paragraph
                type="secondary"
                style={{ fontSize: 12, marginBottom: 12 }}
              >
                温度越低译文越稳定；每批条数影响单次请求规模与实时推送粒度
              </Typography.Paragraph>
              <Space size="large" wrap>
                <Form.Item name="temperature" label="温度" style={{ marginBottom: 8 }}>
                  <InputNumber min={0} max={2} step={0.01} precision={2} />
                </Form.Item>
                <Form.Item
                  name="batchSize"
                  label="每批条数"
                  style={{ marginBottom: 8 }}
                  tooltip="每批翻译的条目数，5-200 条；实时译文按批推送"
                >
                  <InputNumber min={5} max={200} />
                </Form.Item>
              </Space>
            </div>
            )}

            {/* ===== 分组：术语表 ===== */}
            {activeSection === "glossary" && (
            <div>
              <Typography.Text strong>术语表</Typography.Text>
              <Typography.Paragraph
                type="secondary"
                style={{ fontSize: 12, marginBottom: 12 }}
              >
                统一译名与翻译风格：术语表锁定专有名词译法，提示词定义翻译角色与规则
              </Typography.Paragraph>

              <Form.Item
                name="extractGlossary"
                label="先提取术语表"
                valuePropName="checked"
                style={{ marginBottom: 12 }}
                tooltip="翻译前先让 AI 从条目中提取专有名词术语表，用于统一译名"
              >
                <Switch />
              </Form.Item>

              <Typography.Text type="secondary">
                自定义术语表（统一译名，如 Diamond → 钻石；格式：英文 → 中文）
              </Typography.Text>
              <Form.List name="userGlossary">
                {(fields, { add, remove }) => (
                  <div style={{ marginTop: 8 }}>
                    {fields.length === 0 && (
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                        暂无自定义术语，可点击下方按钮添加
                      </Typography.Paragraph>
                    )}
                    {fields.map(({ key, name }) => (
                      <Space key={key} align="baseline" style={{ display: "flex" }}>
                        <Form.Item name={[name, 0]} rules={[{ required: true, message: "英文" }]}>
                          <Input placeholder="英文原文" style={{ width: 200 }} />
                        </Form.Item>
                        <Form.Item name={[name, 1]} rules={[{ required: true, message: "中文" }]}>
                          <Input placeholder="中文译名" style={{ width: 200 }} />
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
                      添加术语
                    </Button>
                  </div>
                )}
              </Form.List>

              {/* 自定义提示词入口（并入术语表分组：统一译名与翻译风格） */}
              <Divider style={{ margin: "12px 0 8px" }} />
              <Button
                block
                icon={<EditOutlined />}
                onClick={() => setPromptEditorOpen(true)}
                style={{ marginBottom: 8 }}
              >
                自定义提示词（模组 / 光影包 / 资源包）
              </Button>
            </div>
            )}

            {/* ===== 分组：翻译加速 ===== */}
            {activeSection === "threading" && (
            <div>
              <Space align="center" style={{ marginBottom: 8 }}>
                <Typography.Text strong>翻译加速（实验性）</Typography.Text>
                <Tag color="volcano">实验性</Tag>
              </Space>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={
                  <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                    多线程并行会同时向模型发送多个翻译请求以提升速度，但存在以下风险与限制：
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      <li>
                        免费模型（glm-4-flash / 4.7-flash）有<b>账号级速率限制</b>
                        （实测约 15~30 请求/分钟），多线程容易触发限流（429），程序会自动退避重试；
                      </li>
                      <li>
                        <b>具体线程数以各服务商官网限速为准</b>：同一模型不同厂商额度差异较大，
                        例如 OpenRouter 的免费模型可开 8 线程，而智谱免费模型（glm-4-flash 系列）建议 1-2 线程；
                        付费模型（glm-4.5 等）一般可开 4-8 线程提速明显；
                      </li>
                      <li>线程之间按「请求间隔」错开发送，降低限流概率，间隔越大越稳（推荐 ≥ 4 秒）；</li>
                      <li>不同模型同时翻译时，译名风格可能不完全一致，建议用同一模型。</li>
                    </ul>
                  </div>
                }
              />
              <Space size="large" wrap align="start">
                <Form.Item
                  name="threadingEnabled"
                  label="启用并行翻译"
                  valuePropName="checked"
                  style={{ marginBottom: 4 }}
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  name="threadCount"
                  label="线程数"
                  style={{ marginBottom: 4 }}
                >
                  <Select
                    style={{ width: 120 }}
                    options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
                      value: n,
                      label: `${n} 线程${n === 1 ? "（=不并行）" : ""}`,
                    }))}
                    disabled={!threadingEnabled}
                  />
                </Form.Item>
                <Form.Item
                  name="requestIntervalSec"
                  label="请求间隔（秒）"
                  style={{ marginBottom: 4 }}
                  tooltip="每个线程每次请求之间的间隔，间隔越大越不容易触发限流"
                >
                  <InputNumber
                    min={1}
                    max={60}
                    step={1}
                    addonAfter="秒"
                    disabled={!threadingEnabled}
                  />
                </Form.Item>
              </Space>

              <Divider style={{ margin: "8px 0 12px" }} />
              <Form.Item
                name="deepScan"
                label="模组深度扫描"
                valuePropName="checked"
                style={{ marginBottom: 4 }}
                tooltip="解析模组中普通扫描可能遗漏的内嵌文本（配置文件/成就/手册/嵌套 jar 等）。已编译的 .class 代码内文本暂不支持。"
              >
                <Switch />
              </Form.Item>
              <Typography.Paragraph
                type="secondary"
                style={{ fontSize: 12, marginBottom: 0 }}
              >
                开启后，普通解析为空的模组会自动启用强化扫描；也可在模组卡片上手动点击「模组深度扫描」
              </Typography.Paragraph>
            </div>
            )}

            {/* ===== 分组：页面设置（主题 / 语言，两项独立配置互不影响） ===== */}
            {activeSection === "appearance" && (
            <div>
              <Typography.Text strong>页面设置</Typography.Text>
              <Typography.Paragraph
                type="secondary"
                style={{ fontSize: 12, marginBottom: 16 }}
              >
                主题与语言互相独立，可任意组合；保存后立即生效
              </Typography.Paragraph>

              <Space size="large" wrap align="start">
                <Form.Item name="theme" label="主题" style={{ marginBottom: 8 }}>
                  <Radio.Group optionType="button" buttonStyle="solid">
                    <Radio.Button value="light"><SunGlyph /> 亮色</Radio.Button>
                    <Radio.Button value="dark"><MoonGlyph /> 暗色</Radio.Button>
                  </Radio.Group>
                </Form.Item>

                <Form.Item name="language" label="语言 / Language" style={{ marginBottom: 8 }}>
                  <Radio.Group optionType="button" buttonStyle="solid">
                    <Radio.Button value="zh">中文</Radio.Button>
                    <Radio.Button value="en">English</Radio.Button>
                  </Radio.Group>
                </Form.Item>
              </Space>
            </div>
            )}

            {/* ===== 分组：关于 ===== */}
            {activeSection === "about" && (
            <div>
              {/* about:author：作者 / 项目信息（纯展示） */}
              <div style={{ textAlign: "center", paddingTop: 24 }}>
                <Typography.Title level={5} style={{ marginBottom: 4 }}>
                  <img src="/app-icon.svg" alt="" style={{ height: 22, marginRight: 8, verticalAlign: "middle" }} /> MC 汉化工坊 v{CURRENT_VERSION}
                </Typography.Title>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
                  面向《我的世界》模组 / 光影包 / 资源包的 AI 汉化桌面工具
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  作者：adssadax-1 · 完全开源免费（MIT 协议）
                </Typography.Paragraph>
                <Typography.Link
                  onClick={() => void openUrl(GITHUB_URL)}
                  style={{ fontWeight: 600 }}
                >
                  <img src="/github.svg" alt="" style={{ height: 14, marginRight: 4, verticalAlign: "middle" }} /> GitHub：github.com/adssadax-1/mc-content-localizer
                </Typography.Link>
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
                  <img src="/refresh.svg" alt="" style={{ height: 12, marginRight: 4, verticalAlign: "middle" }} /> 检查更新（当前 v{CURRENT_VERSION}）
                </Button>
              </div>
            </div>
            )}
            </div>
            </Form>
        </div>
      </div>

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
