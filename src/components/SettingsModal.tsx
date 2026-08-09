import { useEffect, useState } from "react";
import {
  AutoComplete,
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import { DownOutlined, MinusCircleOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { ModelInfo, ProviderConfig, Settings } from "../types";
import { PROVIDER_PRESETS } from "../types";

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
}

export function SettingsModal({ open, settings, onClose, onSaved }: Props) {
  const [form] = Form.useForm<FormValues>();
  const provider = Form.useWatch("provider", form);
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

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
        userGlossary: settings.userGlossary.length ? settings.userGlossary : [],
        providerApiKeys: settings.providerApiKeys ?? {},
        providerModels: settings.providerModels ?? {},
      });
      // 模型列表：用当前服务商缓存的列表（没拉取过则为空）
      const cur = settings.provider.provider;
      setModelOptions(settings.providerModelOptions?.[cur] ?? []);
      setModelOpen(false);
    }
  }, [open, settings, form]);

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
    const v = await form.validateFields();
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
      width={560}
      destroyOnClose
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Typography.Text type="secondary">AI 翻译服务</Typography.Text>

        <Form.Item name="provider" label="服务商" style={{ marginTop: 8 }}>
          <Select
            options={Object.entries(PROVIDER_PRESETS).map(([k, v]) => ({
              value: k,
              label: v.label,
            }))}
            onChange={(p: string) => {
              // 切换服务商：key / 模型 / 模型列表全部联动到该服务商保存的值
              const keys: Record<string, string> =
                form.getFieldValue("providerApiKeys") ?? {};
              const models: Record<string, string> =
                form.getFieldValue("providerModels") ?? {};
              const opts: Record<string, ModelInfo[]> =
                form.getFieldValue("providerModelOptions") ?? {};
              form.setFieldValue("apiKey", keys[p] ?? "");
              form.setFieldValue(
                "model",
                models[p] ?? PROVIDER_PRESETS[p]?.model ?? "",
              );
              setModelOptions(opts[p] ?? []);
              setModelOpen(false);
            }}
          />
        </Form.Item>

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
          <AutoComplete
            options={modelOptions.map((m) => ({
              value: m.id,
              label: (
                <span>
                  {m.id}
                  {m.free && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        color: "#52c41a",
                        fontWeight: "normal",
                      }}
                    >
                      （免费模型）
                    </span>
                  )}
                </span>
              ),
            }))}
            placeholder={
              modelOptions.length === 0
                ? "填写 API Key 后点击「获取模型列表」"
                : provider
                  ? PROVIDER_PRESETS[provider]?.model || "选择或输入模型名"
                  : ""
            }
            open={modelOpen}
            onDropdownVisibleChange={setModelOpen}
          >
            {/* 右侧为下拉箭头（非删除图标）：点击切换开合，中间区域为编辑光标 */}
            <Input
              suffix={
                <DownOutlined
                  style={{ cursor: "pointer", color: "#8c8c8c" }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setModelOpen((v) => !v);
                  }}
                />
              }
            />
          </AutoComplete>
        </Form.Item>

        {provider === "custom" && (
          <Form.Item name="baseUrl" label="Base URL（OpenAI 兼容端点）">
            <Input placeholder="https://..." />
          </Form.Item>
        )}

        <Space size="large" wrap>
          <Form.Item name="temperature" label="温度" style={{ marginBottom: 8 }}>
            <InputNumber min={0} max={2} step={0.01} precision={2} />
          </Form.Item>
          <Form.Item name="batchSize" label="每批条数" style={{ marginBottom: 8 }}>
            <InputNumber min={5} max={200} />
          </Form.Item>
          <Form.Item
            name="extractGlossary"
            label="先提取术语表"
            valuePropName="checked"
            style={{ marginBottom: 8 }}
          >
            <Switch />
          </Form.Item>
        </Space>

        <Divider style={{ margin: "8px 0" }} />

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
      </Form>
    </Modal>
  );
}
