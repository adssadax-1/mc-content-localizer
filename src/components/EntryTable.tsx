import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckOutlined, CloseCircleOutlined } from "@ant-design/icons";
import { Checkbox, Input, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSelectionContainer } from "@air/react-drag-to-select";
import type { SelectionBox } from "@air/react-drag-to-select";
import { useTranslationContext } from "../i18n";
import type { LangEntry } from "../types";
import { STATUS_COLOR } from "../types";

interface Props {
  entries: LangEntry[];
  onEdit: (key: string, value: string) => void;
  onSelect: (key: string) => void;
  /** 单条清除译文（重新加入汉化队列） */
  onClear?: (key: string) => void;
  /** 切换单条是否参与汉化 */
  onToggleSelected?: (key: string, selected: boolean) => void;
  /** 全选 / 全不选汉化 */
  onToggleAllSelected?: (selected: boolean) => void;
  /** 批量切换（拖动框选，一次提交多条） */
  onToggleManySelected?: (keys: string[], selected: boolean) => void;
  /** 表格可视高度（启用虚拟滚动后内部滚动） */
  scrollY?: number;
}

/** § 格式码配色表（Minecraft 颜色码） */
const MC_COLORS: Record<string, string> = {
  "0": "#000000", "1": "#0000AA", "2": "#00AA00", "3": "#00AAAA",
  "4": "#AA0000", "5": "#AA00AA", "6": "#FFAA00", "7": "#AAAAAA",
  "8": "#555555", "9": "#5555FF", a: "#55FF55", b: "#55FFFF",
  c: "#FF5555", d: "#FF55FF", e: "#FFFF55", f: "#FFFFFF",
};

/** 按条目状态/翻译中标记返回表格行底色（CSS 变量，亮暗主题自适应） */
function rowBg(e: LangEntry): string | undefined {
  if (e.translating) return "var(--row-translating)"; // 淡蓝：正在汉化
  switch (e.status) {
    case "aiTranslated":
      return "var(--row-translated)"; // 淡绿：已汉化完成
    case "aiEmpty":
      return "var(--row-empty)"; // 淡黄：AI 未返回译文
    case "aiFailed":
      return "var(--row-failed)"; // 淡红：429 限流 / 翻译失败
    default:
      return undefined;
  }
}

/** 按 § 格式码渲染文本效果（颜色/粗体/斜体/下划线/删除线），深色背景便于预览 */
function McFormatPreview({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  const tokens = text.split(/(§[0-9a-fklmnor])/i);
  let style: React.CSSProperties = { color: "#FFFFFF" };
  let key = 0;
  for (const tok of tokens) {
    const m = /^§([0-9a-fklmnor])$/i.exec(tok);
    if (m) {
      const c = m[1].toLowerCase();
      if (MC_COLORS[c]) {
        style = { ...style, color: MC_COLORS[c], fontWeight: "normal", fontStyle: "normal", textDecoration: "none" };
      } else if (c === "l") style = { ...style, fontWeight: "bold" };
      else if (c === "o") style = { ...style, fontStyle: "italic" };
      else if (c === "n") style = { ...style, textDecoration: "underline" };
      else if (c === "m") style = { ...style, textDecoration: "line-through" };
      else if (c === "k") style = { ...style, opacity: 0.4 };
      else if (c === "r") style = { color: "#FFFFFF", fontWeight: "normal", fontStyle: "normal", textDecoration: "none" };
    } else if (tok) {
      nodes.push(
        <span key={key++} style={style}>
          {tok}
        </span>,
      );
    }
  }
  return (
    <div
      style={{
        background: "#1a1a1a",
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 13,
        minWidth: 140,
      }}
    >
      {nodes.length ? nodes : text}
    </div>
  );
}

/**
 * 可编辑译文输入框：本地 state 受控 + 防抖提交。
 *
 * 一处改动同时修复三类问题：
 * 1) 长按退格卡顿：打字/删除/粘贴只更新本地 state，不触发全局 queue 重渲染，
 *    避免整表随每个按键反复重渲染而"视觉卡顿"（单帧渲染虽快，但长按自动重复
 *    约 30Hz 的连续重渲染会抢占输入绘制，造成输入滞后感）。
 * 2) 空条目右键粘贴回顶 / 3) 编辑删除至空列表跳顶：因不再逐键提交全局 state，
 *    编辑过程中 entries/dataSource 引用不变、虚拟列表不会因逐键重渲染而重置
 *    scrollTop；清空按钮(×)显隐基于本地值，避免"变空/变非空"时行高变化引发滚动跳动。
 */
function TranslationInput({
  value,
  onChange,
  onClear,
}: {
  value: string | null;
  onChange: (v: string) => void;
  onClear?: () => void;
}) {
  const { t } = useTranslationContext();
  const clearTip = t("components.clearTranslation");
  const [local, setLocal] = useState(value ?? "");
  const timerRef = useRef<number | null>(null);
  const focusedRef = useRef(false);

  // 外部值变化（AI 翻译回填 / 列表重置 / 清空）时同步本地显示；
  // 用户正在该框输入时不覆盖，避免打断输入。
  useEffect(() => {
    if (!focusedRef.current) {
      setLocal(value ?? "");
    }
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const commit = (v: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => onChange(v), 250);
  };

  const input = (
    <Input
      value={local}
      placeholder={undefined}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
      }}
      onChange={(e) => {
        const v = e.target.value;
        setLocal(v);
        commit(v);
      }}
      suffix={
        onClear ? (
          <Tooltip title={clearTip}>
            <CloseCircleOutlined
              style={{
                cursor: local || value ? "pointer" : "default",
                color: "#ff4d4f",
                // 始终保留 suffix 占位（空时隐藏而非移除），避免「空→非空」时
                // antd 在原生 <input> 与 <span.ant-input-affix-wrapper> 之间切换
                // 根节点，从而卸载重建聚焦中的输入框、丢失焦点；右键粘贴时浏览器
                // 会重新聚焦该节点，触发虚拟列表 scrollTop 归零、界面回顶。
                // Ctrl+V 时输入框本就持有焦点，无此重建/重聚焦过程，故不回顶。
                display: local || value ? "inline-block" : "none",
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (local || value) {
                  if (timerRef.current) clearTimeout(timerRef.current);
                  setLocal("");
                  onClear();
                }
              }}
            />
          </Tooltip>
        ) : undefined
      }
    />
  );

  const hasFormat = local.includes("§");
  return hasFormat ? (
    <Tooltip title={<McFormatPreview text={local} />} placement="topLeft">
      {input}
    </Tooltip>
  ) : (
    input
  );
}

/** 翻译主表格：汉化勾选 / 状态 / key / 原文 / 可编辑译文 / 备注 */
export const EntryTable = memo(function EntryTable({
  entries,
  onEdit,
  onSelect,
  onClear,
  onToggleSelected,
  onToggleAllSelected,
  onToggleManySelected,
  scrollY,
}: Props) {
  const { t: tr } = useTranslationContext();
  const [filter, setFilter] = useState("");
  // 条目多时启用虚拟滚动（只渲染可视行，大幅降低渲染成本）
  const useVirtual = entries.length > 200 && (scrollY ?? 0) > 100;

  // 行级 memo：record 引用不变的行不重渲染（勾选/编辑只重渲染目标行）
  // record 通过 onRow 传入（antd 默认不传给行组件）
  const MemoRow = useMemo(
    () =>
      memo(
        ({ record: _record, ...rest }: React.ComponentProps<"tr"> & { record?: LangEntry }) => (
          <tr {...rest} />
        ),
        (prev, next) => prev.record === next.record,
      ),
    [],
  );

  // ==================== 拖动框选（基于 @air/react-drag-to-select）====================
  // 库负责原生事件监听与框选矩形计算（视口坐标）；我们负责：行命中（矩形相交）、
  // 行高亮（DOM 直改，不触发 React 渲染）、边界自动滚动、松手批量应用。
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const valueRef = useRef(true);
  const startKeyRef = useRef<string | null>(null);
  const lastBoxRef = useRef<SelectionBox | null>(null);
  const suppressClickRef = useRef(false);
  const autoScrollRafRef = useRef(0);
  const lastMouseYRef = useRef(0);
  // 记录行内 mousedown 起点（用于区分"点击打开详情"与"拖拽/文本选择"）
  const downInfoRef = useRef<{ x: number; y: number; inEditable: boolean } | null>(null);

  /** 清除全部行高亮 */
  const clearHighlight = useCallback(() => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;
    wrap
      .querySelectorAll("tr.drag-highlight")
      .forEach((el) => el.classList.remove("drag-highlight"));
  }, []);

  /** 框选矩形与可视行相交 → 收集命中行（整行垂直相交即算命中） */
  const applyHits = useCallback((box: SelectionBox) => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;
    const rows = wrap.querySelectorAll("tr[data-row-key]");
    const bottom = box.top + box.height;
    for (const tr of rows) {
      const r = tr.getBoundingClientRect();
      if (r.top < bottom && r.bottom > box.top) {
        const key = tr.getAttribute("data-row-key");
        if (key && !keysRef.current.has(key)) {
          keysRef.current.add(key);
          tr.classList.add("drag-highlight");
        }
      }
    }
  }, []);

  /** 拖动边界自动滚动：鼠标靠近表格可视区上下边缘时持续滚动 */
  const startAutoScroll = useCallback(() => {
    const loop = () => {
      const wrap = tableWrapRef.current;
      if (!wrap) return;
      const scroller = (wrap.querySelector(
        ".ant-table-body, .ant-table-content, .rc-virtual-list-holder, .ant-table-container",
      ) as HTMLElement | null) ?? wrap;
      const rect = scroller.getBoundingClientRect();
      const y = lastMouseYRef.current;
      let speed = 0;
      const edge = 40;
      if (y < rect.top + edge) {
        speed = -Math.max((rect.top + edge - y) * 1.5, 8);
      } else if (y > rect.bottom - edge) {
        speed = Math.max((y - (rect.bottom - edge)) * 1.5, 8);
      }
      if (speed !== 0) {
        scroller.scrollTop += speed;
        if (lastBoxRef.current) applyHits(lastBoxRef.current);
      }
      autoScrollRafRef.current = requestAnimationFrame(loop);
    };
    autoScrollRafRef.current = requestAnimationFrame(loop);
  }, [applyHits]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current) cancelAnimationFrame(autoScrollRafRef.current);
  }, []);

  const { DragSelection } = useSelectionContainer({
    // 仅允许从普通单元格区域开始框选；按钮/复选框/标签/输入框等交互元素
    // 不触发框选，其原有点击功能完全不受影响
    shouldStartSelecting: (target) => {
      if (!(target instanceof HTMLElement)) return false;
      if (
        target.closest(
          "input, textarea, select, button, .ant-btn, .ant-checkbox, .ant-select, .ant-input, .ant-input-number, .ant-tag",
        )
      ) {
        return false;
      }
      // 记录起点行（用于决定勾选/取消模式）
      const tr = target.closest("tr[data-row-key]");
      startKeyRef.current = tr
        ? (tr.getAttribute("data-row-key") ?? null)
        : null;
      return true;
    },
    // 框面积大于 100px²（约 3x40 行高）才视为拖动，避免点击手抖误触
    isValidSelectionStart: (box) => box.width * box.height > 100,
    onSelectionStart: () => {
      // 起点行已勾选 → 拖动为取消模式；否则为勾选模式
      const rec = entries.find((e) => e.key === startKeyRef.current);
      valueRef.current = rec ? !(rec.selected !== false) : true;
      keysRef.current = new Set();
      lastBoxRef.current = null;
      startAutoScroll();
    },
    onSelectionChange: (box) => {
      lastBoxRef.current = box;
      applyHits(box);
    },
    onSelectionEnd: () => {
      stopAutoScroll();
      const keys = [...keysRef.current];
      const value = valueRef.current;
      clearHighlight();
      lastBoxRef.current = null;
      // 选中多行（真拖动）才抑制一次行点击；单行点击（手抖）照常弹详情
      if (keys.length > 1) {
        suppressClickRef.current = true;
      }
      if (keys.length > 0) {
        onToggleManySelected?.(keys, value);
      }
    },
    selectionProps: { style: { display: "none" } },
  });

  // 记录拖动中的鼠标 Y（供自动滚动判断边界）
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastMouseYRef.current = e.clientY;
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

  const data = useMemo(() => {
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter(
      (e) =>
        e.key.toLowerCase().includes(f) || e.source.toLowerCase().includes(f),
    );
  }, [entries, filter]);

  const allSelected = entries.length > 0 && entries.every((e) => e.selected !== false);

  const columns: ColumnsType<LangEntry> = [
    {
      title: (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && entries.some((e) => e.selected !== false)}
            onChange={(e) => onToggleAllSelected?.(e.target.checked)}
            title="全选/全不选汉化"
          />
        </span>
      ),
      dataIndex: "selected",
      width: 46,
      align: "center",
      render: (selected: boolean, record) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected !== false}
            onChange={(e) => onToggleSelected?.(record.key, e.target.checked)}
          />
        </span>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (s: LangEntry["status"], record) =>
        record.translating ? (
          <Tag color="processing">{tr("components.translating")}</Tag>
        ) : (
          <Tag color={STATUS_COLOR[s]}>{tr(`status.${s}`)}</Tag>
        ),
      filters: [
        { text: tr("components.statusUntranslated"), value: "untranslated" },
        { text: tr("components.statusExistingZh"), value: "existingZh" },
        { text: tr("components.statusAiTranslated"), value: "aiTranslated" },
        { text: tr("components.statusUserConfirmed"), value: "userConfirmed" },
        { text: tr("components.statusPlaceholderError"), value: "placeholderError" },
        { text: tr("components.translating"), value: "__translating__" },
        { text: tr("components.statusAiEmpty"), value: "aiEmpty" },
        { text: tr("components.statusAiFailed"), value: "aiFailed" },
      ],
      onFilter: (value, record) =>
        value === "__translating__"
          ? !!record.translating
          : record.status === value,
    },
    {
      title: "key",
      dataIndex: "key",
      width: 280,
      ellipsis: true,
      render: (k: string) => <Typography.Text code>{k}</Typography.Text>,
      sorter: (a, b) => a.key.localeCompare(b.key),
    },
    {
      title: tr("components.colOriginal"),
      dataIndex: "source",
      width: 300,
      ellipsis: true,
    },
    {
      title: tr("components.colTranslation"),
      dataIndex: "translation",
      width: 340,
      render: (_, record) => (
        <span onClick={(e) => e.stopPropagation()}>
          <TranslationInput
            value={record.translation}
            onChange={(v) => onEdit(record.key, v)}
            onClear={onClear ? () => onClear(record.key) : undefined}
          />
        </span>
      ),
    },
    {
      title: tr("components.colNotes"),
      dataIndex: "notes",
      width: 200,
      render: (notes: string[], record) => (
        <div>
          {record.placeholders.length > 0 && (
            <Tag style={{ marginBottom: 2 }}>{record.placeholders.join(" ")}</Tag>
          )}
          {notes.map((n, i) => (
            <Tooltip title={n} key={i}>
              <Tag color="orange" style={{ marginBottom: 2, maxWidth: 160 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", display: "inline-block" }}>
                  {n}
                </span>
              </Tag>
            </Tooltip>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <Input.Search
          placeholder={tr("components.searchPlaceholder")}
          allowClear
          style={{ maxWidth: 360 }}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Typography.Text
          type="secondary"
          style={{ alignSelf: "center", fontSize: 12 }}
          className="sider-label-text"
        >
          <CheckOutlined /> {tr("components.checkHint")}
        </Typography.Text>
      </div>
      <div style={{ position: "relative" }} ref={tableWrapRef}>
        <DragSelection />
        <Table<LangEntry>
          size="small"
          columns={columns}
          dataSource={data}
          rowKey="key"
          pagination={false}
          virtual={useVirtual}
          scroll={useVirtual ? { y: scrollY } : undefined}
          components={{ body: { row: MemoRow } }}
          onRow={(record) => ({
            // record 传给行组件供 memo 比较（渲染时被丢弃）
            record,
            onMouseDown: (e) => {
              const t = e.target as HTMLElement;
              downInfoRef.current = {
                x: e.clientX,
                y: e.clientY,
                // 起点在输入框/按钮/复选框等可编辑控件内 → 视为编辑操作，不弹详情
                inEditable: !!t.closest(
                  "input, textarea, .ant-input, .ant-btn, .ant-checkbox, .ant-select",
                ),
              };
            },
            onClick: (e) => {
              // 拖动框选结束时不弹详情；普通点击照常弹出上下文
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              const d = downInfoRef.current;
              downInfoRef.current = null;
              // 文本选择中（如在框内选词后松手）→ 不打开详情
              const sel = window.getSelection?.();
              if (sel && sel.toString().length > 0) return;
              // 起点在可编辑控件内（编辑译文）→ 不打开详情
              if (d && d.inEditable) return;
              // 按下到松开位移过大（拖拽/选择衍生到外面）→ 不打开详情
              if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
              onSelect(record.key);
            },
            style: { cursor: "pointer", userSelect: "none", background: rowBg(record) },
          })}
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        提示：从行内空白处按住左键拖动（拖出边缘自动滚动），可批量勾选/取消勾选汉化条目
      </Typography.Text>
    </div>
  );
});
