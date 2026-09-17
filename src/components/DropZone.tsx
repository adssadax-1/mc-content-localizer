import { useState } from "react";
import { LoadingOutlined, SunOutlined, PictureOutlined, AppstoreOutlined, CloudServerOutlined } from "@ant-design/icons";
import { Spin, Tooltip, Typography } from "antd";
import { useTranslationContext } from "../i18n";

export type DropKind = "mod" | "shader" | "resourcepack" | "plugin";

interface Props {
  dragOver: boolean;
  parsing: boolean;
  kind: DropKind;
  /** 点击选择文件 */
  onPick: () => void;
  /** 无字模式：两段灰字说明收起，内容改为悬停中央大图标查看 */
  iconOnly?: boolean;
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
  plugin: {
    icon: <CloudServerOutlined />,
    title: "app.clickSelectPlugin",
    dragTitle: "app.dragOverPlugin",
    desc: "app.pluginDesc",
  },
};

/** 空态导入区：按内容包类型显示对应文案；无字模式下仅保留大图标 */
export function DropZone({ dragOver, parsing, kind, onPick, iconOnly }: Props) {
  const { t } = useTranslationContext();
  const k = KIND_TEXT[kind];
  // 错峰动画：渲染期同步带类（同帧提交不闪烁）；开关粘性保持，重播靠 key 重挂载
  const [prevKind, setPrevKind] = useState(kind);
  const [staggerOn, setStaggerOn] = useState(false);
  if (prevKind !== kind) {
    setPrevKind(kind);
    setStaggerOn(true);
  }
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
        <div
          key={kind}
          className={staggerOn ? "dz-stagger" : undefined}
          style={{
            textAlign: "center",
            padding: 48,
            maxWidth: 420,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          {/* 中央大图标：无字模式下两段灰字说明都收起了，能力说明改由它的 hover 承担。
              mouseEnterDelay 给足 0.25s —— 64px 的图标命中区很大，鼠标一进页面就弹会刷屏。 */}
          {(() => {
            const bigIcon = (
              <span className="dz-layer" style={{ fontSize: 64, color: dragOver ? "#4A90D9" : "#bfbfbf" }}>
                {k.icon}
              </span>
            );
            return iconOnly ? (
              <Tooltip title={t(k.desc)} placement="top" mouseEnterDelay={0.25}>
                {bigIcon}
              </Tooltip>
            ) : (
              bigIcon
            );
          })()}
          <Typography.Title level={4} style={{ marginTop: 16 }} className="dropzone-text dz-layer dz-delay-1">
            {t(dragOver ? k.dragTitle : k.title)}
          </Typography.Title>
          <div className="dz-layer dz-delay-2">
            <Typography.Text type="secondary" className="dropzone-text io-hide">
              {t(k.desc)}
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }} className="dropzone-text io-hide">
                {t("app.tipSettings")}
              </Typography.Text>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
