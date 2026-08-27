/** 镐子图标（MC 汉化工坊品牌 SVG，用于标题栏与关于面板，替代 emoji） */
export function PickaxeIcon({ size = 20, color = "#4A90D9" }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ verticalAlign: "middle", flexShrink: 0 }}
      aria-hidden="true"
    >
      {/* 镐头：弧形 */}
      <path
        d="M3 9 C6 4, 14 2, 20 5 C15 5, 9 7, 6.5 12 Z"
        fill={color}
      />
      {/* 镐柄：斜杆 */}
      <rect
        x="10.2"
        y="8.2"
        width="2.6"
        height="13"
        rx="1.2"
        transform="rotate(45 12 14)"
        fill={color}
        opacity="0.85"
      />
    </svg>
  );
}
