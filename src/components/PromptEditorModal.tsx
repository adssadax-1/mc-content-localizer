import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Input,
  message,
  Modal,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AppstoreOutlined,
  CloudServerOutlined,
  PictureOutlined,
  ReloadOutlined,
  SunOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { PromptTemplate, Settings } from "../types";
import { useTranslationContext } from "../i18n";

type PackKind = "mod" | "shader" | "resourcepack" | "plugin";

const KIND_LABEL: Record<PackKind, string> = {
  mod: "promptEditor.tabMod",
  shader: "promptEditor.tabShader",
  resourcepack: "promptEditor.tabResourcepack",
  plugin: "promptEditor.tabPlugin",
};

/** 与内容包类型页（侧栏导航）同款图标，保持视觉一致 */
const KIND_ICON: Record<PackKind, React.ReactNode> = {
  mod: <AppstoreOutlined />,
  shader: <SunOutlined />,
  resourcepack: <PictureOutlined />,
  plugin: <CloudServerOutlined />,
};

interface Props {
  open: boolean;
  settings: Settings | null;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

/** 自定义提示词编辑器：三类型分开设置；可编辑段开放，核心段系统保留（灰底只读） */
export function PromptEditorModal({ open, settings, onClose, onSaved }: Props) {
  const { t } = useTranslationContext();
  const [activeType, setActiveType] = useState<PackKind>("mod");
  const [template, setTemplate] = useState<PromptTemplate | null>(null);
  const [edited, setEdited] = useState("");
  // 模板缓存：切回来直接命中，避免「加载中」闪烁（原实现每次切换都先清空再异步加载）
  const tplCacheRef = useRef<Partial<Record<PackKind, PromptTemplate>>>({});

  // 当前类型的自定义值（无则回退默认文本展示）
  const custom = settings?.customPrompts?.[activeType];

  // 切换类型 / 打开时：加载模板 + 载入该类型的编辑内容
  useEffect(() => {
    if (!open) return;
    const cached = tplCacheRef.current[activeType];
    if (cached) {
      // 命中缓存：同步切换，不闪
      setTemplate(cached);
      setEdited(settings?.customPrompts?.[activeType] ?? cached.editableDefault);
      return;
    }
    // 未命中：保留当前内容直到新模板到达（不先清空，避免整页闪烁）
    api
      .getPromptTemplate(activeType)
      .then((tpl) => {
        tplCacheRef.current[activeType] = tpl;
        setTemplate(tpl);
        setEdited(settings?.customPrompts?.[activeType] ?? tpl.editableDefault);
      })
      .catch(() => {
        setTemplate((prev) => prev ?? null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeType]);

  const isCustomized = !!custom && custom !== template?.editableDefault;

  async function handleSave() {
    if (!settings || !template) return;
    const customPrompts = { ...(settings.customPrompts ?? {}) };
    const trimmed = edited.trim();
    if (!trimmed || trimmed === template.editableDefault) {
      // 等于默认或清空 → 视为使用默认（删掉自定义）
      delete customPrompts[activeType];
    } else {
      customPrompts[activeType] = edited;
    }
    try {
      // 即时落盘：只 patch 提示词这一项，不整份写回（否则会用过期快照覆盖别处刚保存的内容）
      await api.patchSettings({ customPrompts });
    } catch (e) {
      message.error(String(e));
      return;
    }
    onSaved({ ...settings, customPrompts });
    messageSaved();
  }

  function messageSaved() {
    message.success(t("promptEditor.saved"));
  }

  function handleReset() {
    if (!template) return;
    setEdited(template.editableDefault);
  }

  return (
    <Modal
      title={t("promptEditor.title")}
      open={open}
      onCancel={onClose}
      onOk={() => void handleSave()}
      okText={t("promptEditor.save")}
      cancelText={t("promptEditor.cancel")}
      width={860}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("promptEditor.warning")}
      />
      <Tabs
        activeKey={activeType}
        onChange={(k) => setActiveType(k as PackKind)}
        items={(Object.keys(KIND_LABEL) as PackKind[]).map((k) => ({
          key: k,
          label: (
            <Space size={6}>
              {KIND_ICON[k]}
              {t(KIND_LABEL[k])}
            </Space>
          ),
          children: null,
        }))}
      />
      {template ? (
        <div style={{ marginTop: 8 }} key={activeType} className="anim-stagger-root">
          <div className="anim-l">
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Typography.Text strong>{t("promptEditor.editable")}</Typography.Text>
            <Space size={8}>
              {isCustomized && <Tag color="blue">{t("promptEditor.customized")}</Tag>}
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={handleReset}
                title={t("promptEditor.restoreTip")}
              >
                {t("promptEditor.restore")}
              </Button>
            </Space>
          </Space>
          <Input.TextArea
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            autoSize={{ minRows: 12, maxRows: 20 }}
            style={{ marginTop: 8, fontFamily: "monospace", fontSize: 12 }}
          />
          </div>
          <div className="anim-r" style={{ animationDelay: "45ms" }}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
            {t("promptEditor.variables")}
          </Typography.Paragraph>
          </div>

          <div className="anim-l" style={{ animationDelay: "90ms" }}>
          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="secondary">{t("promptEditor.reserved")}</Typography.Text>
          <Tooltip title={t("promptEditor.reservedTip")}>
            <pre
              style={{
                marginTop: 8,
                padding: 12,
                background: "#F5F6F8",
                border: "1px dashed #D9D9D9",
                borderRadius: 8,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                fontSize: 12,
                color: "#999",
                cursor: "not-allowed",
                userSelect: "none",
                fontFamily: "monospace",
              }}
            >
              {template.coreRules}
            </pre>
          </Tooltip>
          </div>
        </div>
      ) : (
        <Typography.Text type="secondary">{t("promptEditor.loading")}</Typography.Text>
      )}
    </Modal>
  );
}
