import { LoadingOutlined, SunOutlined, PictureOutlined, AppstoreOutlined } from "@ant-design/icons";
import { Spin, Typography } from "antd";

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
    title: "点击选择或拖入模组 jar",
    dragTitle: "松开鼠标导入模组",
    desc: "支持多选，Forge / Fabric / NeoForge 均可，自动识别语言文件与硬编码文本",
  },
  shader: {
    icon: <SunOutlined />,
    title: "点击选择或拖入光影包",
    dragTitle: "松开鼠标导入光影包",
    desc: "支持 .zip 光影包（Complementary、BSL 等），自动解析界面文本与自带中文",
  },
  resourcepack: {
    icon: <PictureOutlined />,
    title: "点击选择或拖入资源包",
    dragTitle: "松开鼠标导入资源包",
    desc: "支持 .zip 资源包，自动解析 pack.mcmeta 的描述文本",
  },
};

/** 空态导入区：按内容包类型显示对应文案 */
export function DropZone({ dragOver, parsing, kind, onPick }: Props) {
  const t = KIND_TEXT[kind];
  return (
    <div
      onClick={onPick}
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `2px dashed ${dragOver ? "#4A90D9" : "#d9d9d9"}`,
        borderRadius: 12,
        background: dragOver ? "rgba(74,144,217,0.06)" : "transparent",
        cursor: "pointer",
        transition: "all 0.2s",
        userSelect: "none",
      }}
    >
      {parsing ? (
        <Spin indicator={<LoadingOutlined spin />} tip="正在解析内容包..." size="large">
          <div style={{ padding: 48 }} />
        </Spin>
      ) : (
        <div style={{ textAlign: "center", padding: 48 }}>
          <span style={{ fontSize: 64, color: dragOver ? "#4A90D9" : "#bfbfbf" }}>
            {t.icon}
          </span>
          <Typography.Title level={4} style={{ marginTop: 16 }}>
            {dragOver ? t.dragTitle : t.title}
          </Typography.Title>
          <Typography.Text type="secondary">{t.desc}</Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              也可点击右上角「设置」先配置 AI 翻译服务
            </Typography.Text>
          </div>
        </div>
      )}
    </div>
  );
}
