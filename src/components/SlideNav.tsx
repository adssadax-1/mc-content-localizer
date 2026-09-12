import { useLayoutEffect, useRef, type ReactNode } from "react";

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
 *
 * 指示器位置用命令式 DOM 写入（不走 React state）：首次定位先关 transition、
 * 强制 reflow 后恢复（报告 §1 要求），保证后续点击是真实的滑动过渡。
 */
export function SlideNav({ items, activeKey, onSelect }: SlideNavProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const indRef = useRef<HTMLSpanElement>(null);
  const armedRef = useRef(false);

  useLayoutEffect(() => {
    const el = itemRefs.current[activeKey];
    const ind = indRef.current;
    if (!el || !ind) return;
    const top = el.offsetTop;
    const height = el.offsetHeight;
    if (!armedRef.current) {
      // 首次渲染：关过渡 → 写定位 → 强制 reflow → 恢复过渡（蓝块原地出现，不飞入）
      ind.style.transition = "none";
      ind.style.transform = `translateY(${top}px)`;
      ind.style.height = `${height}px`;
      void ind.offsetHeight;
      ind.style.transition = "";
      armedRef.current = true;
      return;
    }
    ind.style.transform = `translateY(${top}px)`;
    ind.style.height = `${height}px`;
  }, [activeKey]);

  return (
    <div className="slide-nav">
      <span ref={indRef} className="slide-nav-indicator" />
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
 * 仅当父容器带 .panel-anim-root（面板切换的同一帧渲染）才播动画，首次打开为静态。
 */
export function PanelBlock({ index, children }: { index: number; children: ReactNode }) {
  return (
    <div className="panel-anim" style={{ animationDelay: `${Math.min(index, 4) * 40}ms` }}>
      {children}
    </div>
  );
}
