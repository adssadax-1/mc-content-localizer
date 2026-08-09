import { InboxOutlined, LoadingOutlined } from "@ant-design/icons";
import { Spin, Typography } from "antd";

interface Props {
  dragOver: boolean;
  parsing: boolean;
}

/** 空态拖放导入区：拖入 jar 高亮，解析时显示 loading */
export function DropZone({ dragOver, parsing }: Props) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `2px dashed ${dragOver ? "#1677ff" : "#d9d9d9"}`,
        borderRadius: 12,
        background: dragOver ? "rgba(22,119,255,0.06)" : "transparent",
        transition: "all 0.2s",
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
            {dragOver ? "松开鼠标导入模组" : "将模组 jar 拖入此处"}
          </Typography.Title>
          <Typography.Text type="secondary">
            支持 Forge / Fabric / NeoForge 模组，自动识别 en_us.json 与
            .lang 语言文件
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
