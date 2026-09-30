/** 日志图标（自绘 SVG：文档 + 文本行，替代 emoji） */
export function LogIcon({
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
      {/* 纸张（右上角折角） */}
      <path d="M6 2.8h8.2L19.5 8v13.2H6z" />
      <path d="M14 3v5.2h5.3" />
      {/* 文本行 */}
      <path d="M9 12h6.4" />
      <path d="M9 15.4h6.4" />
      <path d="M9 18.8h4" />
    </svg>
  );
}
