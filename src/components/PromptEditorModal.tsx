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

type PackKind = "mod" | "shader" | "resourcepack";

const KIND_LABEL: Record<PackKind, string> = {
  mod: "🎮 模组",
  shader: "☀️ 光影包",
  resourcepack: "🎨 资源包",
};

interface Props {
  open: boolean;
  settings: Settings | null;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

/** 自定义提示词编辑器：三类型分开设置；可编辑段开放，核心段系统保留（灰底只读） */
export function PromptEditorModal({ open, settings, onClose, onSaved }: Props) {
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
      .then((t) => {
        setTemplate(t);
        setEdited(settings?.customPrompts?.[activeType] ?? t.editableDefault);
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
    message.success("提示词已保存");
  }

  function handleReset() {
    if (!template) return;
    setEdited(template.editableDefault);
  }

  return (
    <Modal
      title="自定义提示词"
      open={open}
      onCancel={onClose}
      onOk={() => void handleSave()}
      okText="保存"
      cancelText="取消"
      width={860}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="自定义内容可能影响翻译质量。以下「可编辑区」可自由修改；底部「系统保留段」不可修改（删除会导致输出解析失败或占位符错乱）。"
      />
      <Tabs
        activeKey={activeType}
        onChange={(k) => setActiveType(k as PackKind)}
        items={(Object.keys(KIND_LABEL) as PackKind[]).map((k) => ({
          key: k,
          label: KIND_LABEL[k],
          children: null,
        }))}
      />
      {template ? (
        <div style={{ marginTop: 8 }}>
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Typography.Text strong>可编辑区（角色 / 语境规则 / 参考术语）</Typography.Text>
            <Space size={8}>
              {isCustomized && <Tag color="blue">已自定义</Tag>}
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={handleReset}
                title="恢复为默认内容"
              >
                恢复默认
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
            可用变量：{`{mod_name}`}（名称）、{`{modid}`}、{`{mc_version}`}（仅模组）、
            {`{loader}`}（仅模组）
          </Typography.Paragraph>

          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="secondary">系统保留段（不可修改，翻译时自动追加）</Typography.Text>
          <Tooltip title="系统保留：删除会导致输出解析失败或占位符错乱">
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
        <Typography.Text type="secondary">加载中...</Typography.Text>
      )}
    </Modal>
  );
}
