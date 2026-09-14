/**
 * 深度扫描图标（自绘 SVG，替代与「翻译加速」共用的闪电图标）。
 *
 * 语义：放大镜里向下钻取 —— 不止扫表面文本，而是往内容包内部继续挖掘
 * （成就 / 配置 / 代码常量等常规解析之外的内嵌文本）。
 * 用 currentColor 描边，跟随按钮与导航的字体色（含禁用、主色按钮反白）。
 */
export function DeepScanIcon({
  size = 14,
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
      {/* 镜片 */}
      <circle cx="10.2" cy="10.2" r="6.4" />
      {/* 镜内：向下钻取的箭头（上横线 + 箭头），表达「往深处扫」 */}
      <path d="M7.6 7.4h5.2" />
      <path d="M10.2 10.1v3.4" />
      <path d="M8.6 11.9l1.6 1.6 1.6-1.6" />
      {/* 镜柄 */}
      <path d="M14.9 14.9L20.4 20.4" strokeWidth="2.2" />
    </svg>
  );
}
