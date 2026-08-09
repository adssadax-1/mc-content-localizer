import { useMemo, useState } from "react";
import { Input, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { LangEntry } from "../types";
import { STATUS_COLOR, STATUS_LABEL } from "../types";

interface Props {
  entries: LangEntry[];
  onEdit: (key: string, value: string) => void;
  onSelect: (key: string) => void;
}

/** 翻译主表格：状态 / key / 原文 / 可编辑译文 / 备注 */
export function EntryTable({ entries, onEdit, onSelect }: Props) {
  const [filter, setFilter] = useState("");

  const data = useMemo(() => {
    if (!filter) return entries;
    const f = filter.toLowerCase();
    return entries.filter(
      (e) =>
        e.key.toLowerCase().includes(f) || e.source.toLowerCase().includes(f),
    );
  }, [entries, filter]);

  const columns: ColumnsType<LangEntry> = [
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (s: LangEntry["status"]) => (
        <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Tag>
      ),
      filters: [
        { text: "未翻译", value: "untranslated" },
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
      render: (_, record) => (
        <Input
          value={record.translation ?? ""}
          placeholder="（未翻译）"
          onChange={(e) => onEdit(record.key, e.target.value)}
        />
      ),
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Input.Search
        placeholder="搜索 key 或原文..."
        allowClear
        style={{ marginBottom: 8, maxWidth: 360 }}
        onChange={(e) => setFilter(e.target.value)}
      />
      <Table<LangEntry>
        size="small"
        columns={columns}
        dataSource={data}
        rowKey="key"
        pagination={false}
        scroll={{ y: "calc(100vh - 260px)", x: 1200 }}
        virtual
        onRow={(record) => ({
          onClick: () => onSelect(record.key),
          style: { cursor: "pointer" },
        })}
      />
    </div>
  );
}
