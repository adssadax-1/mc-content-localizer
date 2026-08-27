import { LoadingOutlined, SunOutlined, PictureOutlined, AppstoreOutlined } from "@ant-design/icons";
import { Spin, Typography } from "antd";
import { useTranslationContext } from "../i18n";

export type DropKind = "mod" | "shader" | "resourcepack";

interface Props {
  dragOver: boolean;
  parsing: boolean;
  kind: DropKind;
  /** 点击选择文件 */
  onPick: () => void;
}

const KIND_TEXT: Record<
  DropKind,
  { icon: React.ReactNode; title: string; dragTitle: string; desc: string }
> = {
  mod: {
    icon: <AppstoreOutlined />,
    title: "app.clickSelectMod",
    dragTitle: "app.dragOverMod",
    desc: "app.modDesc",
  },
  shader: {
    icon: <SunOutlined />,
    title: "app.clickSelectShader",
    dragTitle: "app.dragOverShader",
    desc: "app.shaderDesc",
  },
  resourcepack: {
    icon: <PictureOutlined />,
    title: "app.clickSelectResource",
    dragTitle: "app.dragOverResource",
    desc: "app.resourceDesc",
  },
};

/** 空态导入区：按内容包类型显示对应文案；无字模式下仅保留大图标 */
export function DropZone({ dragOver, parsing, kind, onPick }: Props) {
  const { t } = useTranslationContext();
  const k = KIND_TEXT[kind];
  return (
    <div
      onClick={onPick}
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `2px dashed ${dragOver ? "#4A90D9" : "var(--border-color, #d9d9d9)"}`,
        borderRadius: 12,
        background: dragOver ? "rgba(74,144,217,0.06)" : "transparent",
        cursor: "pointer",
        transition: "all 0.2s",
        userSelect: "none",
      }}
    >
      {parsing ? (
        <Spin indicator={<LoadingOutlined spin />} tip={t("app.parsing")} size="large">
          <div style={{ padding: 48 }} />
        </Spin>
      ) : (
        <div style={{ textAlign: "center", padding: 48 }}>
          <span style={{ fontSize: 64, color: dragOver ? "#4A90D9" : "#bfbfbf" }}>
            {k.icon}
          </span>
          <Typography.Title level={4} style={{ marginTop: 16 }} className="dropzone-text">
            {t(dragOver ? k.dragTitle : k.title)}
          </Typography.Title>
          <Typography.Text type="secondary" className="dropzone-text">
            {t(k.desc)}
          </Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }} className="dropzone-text">
              {t("app.tipSettings")}
            </Typography.Text>
          </div>
        </div>
      )}
    </div>
  );
}
