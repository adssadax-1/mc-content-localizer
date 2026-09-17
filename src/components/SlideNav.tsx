import { Fragment, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Tooltip } from "antd";

export interface SlideNavItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
}

/**
 * 共享元素滑动指示器：把高亮块命令式写到目标项的位置与高度。
 *
 * 位置不走 React state——首次定位先关 transition、强制 reflow 后恢复
 * （否则首次会从上一个位置"飞入"），保证后续切换才是真实的滑动过渡。
 *
 * 宿主容器需 `position: relative`，指示器需 `position: absolute`（见
 * `.slide-nav` / `.gd-ver-list`）。抽出来是为了让「主界面内容包类型」
 * 「设置弹窗分组」「游戏目录版本列表」三处共用同一套手感。
 */
export function useSlideIndicator<T extends HTMLElement>(
  activeKey: string | null,
  itemRefs: RefObject<Record<string, T | null>>,
  indRef: RefObject<HTMLElement | null>,
) {
  const armedRef = useRef(false);

  useLayoutEffect(() => {
    if (activeKey === null) return;
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
  }, [activeKey, itemRefs, indRef]);
}

interface SlideNavProps {
  items: SlideNavItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  /**
   * 无字模式：文字被 CSS 原地收起后，可发现性与无障碍名都会一起消失
   * （零宽内容部分读屏会跳过，属公认灰区），因此在这一档补两手——
   * `Tooltip` 给鼠标用户、`aria-label` 给读屏。两者都复用 label 本身，
   * 同一份 i18n 文案，不新增任何译文。
   */
  iconOnly?: boolean;
  /**
   * 条目档位：
   * · `sm`（默认）主界面侧栏与游戏目录版本列表——行内还有计数、勾选框等次级信息，
   *   拉高反而松散；
   * · `lg` 设置弹窗的分组导航——那里条目就是纯"导航按钮"，需要撑起一整栏。
   */
  size?: "sm" | "lg";
}

/**
 * 垂直滑动指示器导航：选中高亮是列表内唯一的共享元素，
 * 点击时整块平滑滑动并伸缩到目标项（主界面内容包类型 + 设置弹窗分组两处共用）。
 */
export function SlideNav({ items, activeKey, onSelect, iconOnly = false, size = "sm" }: SlideNavProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const indRef = useRef<HTMLSpanElement>(null);

  useSlideIndicator(activeKey, itemRefs, indRef);

  return (
    <div className={`slide-nav${size === "lg" ? " slide-nav-lg" : ""}`}>
      <span ref={indRef} className="slide-nav-indicator" />
      {items.map((it) => {
        // label 在调用处都是 `t(...)` 的字符串；万一将来传了节点就退化为不挂 Tooltip
        const labelText = typeof it.label === "string" ? it.label : undefined;
        const btn = (
          <button
            ref={(el) => {
              itemRefs.current[it.key] = el;
            }}
            type="button"
            className={`slide-nav-item${it.key === activeKey ? " active" : ""}`}
            aria-label={iconOnly ? labelText : undefined}
            onClick={() => onSelect(it.key)}
          >
            {it.icon}
            <span className="slide-nav-label ui-label">{it.label}</span>
          </button>
        );
        // 条件渲染而非改 Tooltip 的 visible：常规模式不给几十个按钮白挂一层组件
        return iconOnly && labelText ? (
          <Tooltip key={it.key} title={labelText} placement="right" mouseEnterDelay={0.2}>
            {btn}
          </Tooltip>
        ) : (
          <Fragment key={it.key}>{btn}</Fragment>
        );
      })}
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
