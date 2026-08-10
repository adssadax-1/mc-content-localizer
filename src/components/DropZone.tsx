import { InboxOutlined, LoadingOutlined } from "@ant-design/icons";
import { Spin, Typography } from "antd";

interface Props {
  dragOver: boolean;
  parsing: boolean;
  /** 点击选择文件 */
  onPick: () => void;
}

/** 空态导入区：点击选择或拖入 jar */
export function DropZone({ dragOver, parsing, onPick }: Props) {
  return (
    <div
      onClick={onPick}
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `2px dashed ${dragOver ? "#1677ff" : "#d9d9d9"}`,
        borderRadius: 12,
        background: dragOver ? "rgba(22,119,255,0.06)" : "transparent",
        cursor: "pointer",
        transition: "all 0.2s",
        userSelect: "none",
      }}
    >
      {parsing ? (
        <Spin indicator={<LoadingOutlined spin />} tip="正在解析模组..." size="large">
          <div style={{ padding: 48 }} />
        </Spin>
      ) : (
        <div style={{ textAlign: "center", padding: 48 }}>
          <InboxOutlined
            style={{ fontSize: 64, color: dragOver ? "#1677ff" : "#bfbfbf" }}
          />
          <Typography.Title level={4} style={{ marginTop: 16 }}>
            {dragOver
              ? "松开鼠标导入模组"
              : "点击选择或拖入模组 jar"}
          </Typography.Title>
          <Typography.Text type="secondary">
            支持多选，Forge / Fabric / NeoForge 均可，自动识别语言文件与硬编码文本
          </Typography.Text>
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
