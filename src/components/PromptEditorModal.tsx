import { useEffect, useState } from "react";
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
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { PromptTemplate, Settings } from "../types";
import { useTranslationContext } from "../i18n";

type PackKind = "mod" | "shader" | "resourcepack";

const KIND_LABEL: Record<PackKind, string> = {
  mod: "promptEditor.tabMod",
  shader: "promptEditor.tabShader",
  resourcepack: "promptEditor.tabResourcepack",
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

  // 当前类型的自定义值（无则回退默认文本展示）
  const custom = settings?.customPrompts?.[activeType];

  // 切换类型 / 打开时：加载模板 + 载入该类型的编辑内容
  useEffect(() => {
    if (!open) return;
    setTemplate(null);
    api
      .getPromptTemplate(activeType)
      .then((tpl) => {
        setTemplate(tpl);
        setEdited(settings?.customPrompts?.[activeType] ?? tpl.editableDefault);
      })
      .catch(() => {
        setTemplate(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeType]);

  const isCustomized = !!custom && custom !== template?.editableDefault;

  function handleSave() {
    if (!settings || !template) return;
    const next = { ...settings, customPrompts: { ...(settings.customPrompts ?? {}) } };
    const trimmed = edited.trim();
    if (!trimmed || trimmed === template.editableDefault) {
      // 等于默认或清空 → 视为使用默认（删掉自定义）
      delete next.customPrompts[activeType];
    } else {
      next.customPrompts[activeType] = edited;
    }
    onSaved(next);
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
          label: t(KIND_LABEL[k]),
          children: null,
        }))}
      />
      {template ? (
        <div style={{ marginTop: 8 }}>
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
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
            {t("promptEditor.variables")}
          </Typography.Paragraph>

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
      ) : (
        <Typography.Text type="secondary">{t("promptEditor.loading")}</Typography.Text>
      )}
    </Modal>
  );
}
