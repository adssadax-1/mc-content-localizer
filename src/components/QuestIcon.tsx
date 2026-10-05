/** 任务书图标（自绘 SVG：翻开的书 + 书签带，与深度扫描/日志图标同一套线稿风格） */
export function QuestIcon({
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
      {/* 翻开的书页：左右两片 */}
      <path d="M12 5.6C10.4 4.2 8 3.6 4.5 3.7v14.9c3.5-.1 5.9.5 7.5 1.9" />
      <path d="M12 5.6c1.6-1.4 4-2 7.5-1.9v14.9c-3.5-.1-5.9.5-7.5 1.9" />
      {/* 中缝 */}
      <path d="M12 5.6v14.9" />
      {/* 书签带（从书脊上方垂下） */}
      <path d="M12 3.2v4.4l2-1.5 2 1.5V4.1" />
    </svg>
  );
}
