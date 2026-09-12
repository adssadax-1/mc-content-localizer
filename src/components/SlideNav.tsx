import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface SlideNavItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
}

interface SlideNavProps {
  items: SlideNavItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}

/**
 * 垂直滑动指示器导航：选中高亮是列表内唯一的共享元素，
 * 点击时整块平滑滑动并伸缩到目标项（主界面内容包类型 + 设置弹窗分组两处共用）。
 */
export function SlideNav({ items, activeKey, onSelect }: SlideNavProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const posRef = useRef({ top: 0, height: 0, ready: false });
  const [pos, setPos] = useState({ top: 0, height: 0, ready: false });

  useLayoutEffect(() => {
    const el = itemRefs.current[activeKey];
    if (!el) return;
    const top = el.offsetTop;
    const height = el.offsetHeight;
    const prev = posRef.current;
    if (prev.ready && prev.top === top && prev.height === height) return;
    posRef.current = { top, height, ready: prev.ready };
    setPos({ ...posRef.current });
    if (!prev.ready) {
      // 首次渲染：本帧无过渡直接定位，下一帧再启用过渡，避免蓝块飞入
      requestAnimationFrame(() => {
        posRef.current = { ...posRef.current, ready: true };
        setPos({ ...posRef.current });
      });
    }
  }, [activeKey]);

  return (
    <div className="slide-nav">
      <span
        className="slide-nav-indicator"
        style={{
          transform: `translateY(${pos.top}px)`,
          height: pos.height,
          transition: pos.ready
            ? "transform var(--motion-dur-base) var(--motion-ease-slide), height var(--motion-dur-base) var(--motion-ease-slide)"
            : "none",
        }}
      />
      {items.map((it) => (
        <button
          key={it.key}
          ref={(el) => {
            itemRefs.current[it.key] = el;
          }}
          type="button"
          className={`slide-nav-item${it.key === activeKey ? " active" : ""}`}
          onClick={() => onSelect(it.key)}
        >
          {it.icon}
          <span className="slide-nav-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 设置面板错峰淡入块：index 为 DOM 阅读顺序块序号，延迟 40ms 步进、封顶 160ms。
 * 仅当父容器带 .panel-anim-root（面板切换时）才播动画，首次打开弹窗为静态。
 */
export function PanelBlock({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className="panel-anim" style={{ animationDelay: `${Math.min(index, 4) * 40}ms` }}>
      {children}
    </div>
  );
}
