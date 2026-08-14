import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckOutlined, CloseCircleOutlined } from "@ant-design/icons";
import { Checkbox, Input, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSelectionContainer } from "@air/react-drag-to-select";
import type { SelectionBox } from "@air/react-drag-to-select";
import type { LangEntry } from "../types";
import { STATUS_COLOR, STATUS_LABEL } from "../types";

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
      render: (s: LangEntry["status"]) => (
        <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Tag>
      ),
      filters: [
        { text: "未翻译", value: "untranslated" },
        { text: "自带中文", value: "existingZh" },
        { text: "AI 翻译", value: "aiTranslated" },
        { text: "人工确认", value: "userConfirmed" },
        { text: "占位符异常", value: "placeholderError" },
      ],
      onFilter: (value, record) => record.status === value,
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
      title: "原文 (en)",
      dataIndex: "source",
      width: 300,
      ellipsis: true,
    },
    {
      title: "译文 (zh_cn)",
      dataIndex: "translation",
      width: 340,
      render: (_, record) => {
        const hasFormat = (record.translation ?? "").includes("§");
        const input = (
          <Input
            value={record.translation ?? ""}
            placeholder="（未翻译）"
            onChange={(e) => onEdit(record.key, e.target.value)}
            suffix={
              record.translation && onClear ? (
                <Tooltip title="清除此条译文，重新加入汉化队列">
                  <CloseCircleOutlined
                    style={{ cursor: "pointer", color: "#ff4d4f" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClear(record.key);
                    }}
                  />
                </Tooltip>
              ) : undefined
            }
          />
        );
        return (
          <span onClick={(e) => e.stopPropagation()}>
            {hasFormat ? (
              <Tooltip
                title={
                  <McFormatPreview text={record.translation ?? ""} />
                }
                placement="topLeft"
              >
                {input}
              </Tooltip>
            ) : (
              input
            )}
          </span>
        );
      },
    },
    {
      title: "备注",
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
          placeholder="搜索 key 或原文..."
          allowClear
          style={{ maxWidth: 360 }}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Typography.Text
          type="secondary"
          style={{ alignSelf: "center", fontSize: 12 }}
        >
          <CheckOutlined /> 勾选 = 参与汉化（未勾选的不翻译、不导出）
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
            onClick: () => {
              // 拖动框选结束时不弹详情；普通点击照常弹出上下文
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onSelect(record.key);
            },
            style: { cursor: "pointer", userSelect: "none" },
          })}
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        提示：从行内空白处按住左键拖动（拖出边缘自动滚动），可批量勾选/取消勾选汉化条目
      </Typography.Text>
    </div>
  );
});
