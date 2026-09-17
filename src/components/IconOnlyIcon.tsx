/**
 * 无字模式图标（自绘 SVG，替代 antd 的 CompressOutlined）。
 *
 * 语义：一个窗口，左侧一列被压成窄条、窄条里留着一个图标点 ——
 * 即"外壳的侧栏收成图标列，内容区不动"，比 CompressOutlined 的
 * "向内挤压"更贴近这个模式实际做的事。
 * 用 currentColor 描边，跟随按钮的字体色（含禁用、强调态的蓝色）。
 */
export function IconOnlyIcon({
  size = 15,
  color = "currentColor",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ verticalAlign: "-2px", flexShrink: 0 }}
      aria-hidden="true"
    >
      {/* 窗口外框 */}
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      {/* 左侧窄条与右侧内容区的分界 */}
      <path d="M9.5 4.5v15" />
      {/* 窄条里保留的那个图标点。
          半径按**缩小后的实际尺寸**定：本组件默认 15px（顶栏这套按钮的字号是 13，
          取 15 是为了让这个点的笔画不糊），24 的 viewBox 缩到 15 只有 0.625 倍，
          所以在 viewBox 里给到 1.4 —— 落到屏幕上约 1.75px，肉眼刚好认得出是个点。 */}
      <circle cx="6.5" cy="12" r="1.4" fill={color} stroke="none" />
    </svg>
  );
}
