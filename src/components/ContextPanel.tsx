import { useMemo } from "react";
import { Divider, Tag, Typography } from "antd";
import type { LangEntry } from "../types";
import { STATUS_COLOR, STATUS_LABEL } from "../types";

interface Props {
  entry: LangEntry;
  allEntries: LangEntry[];
}

/** 选中条目的上下文面板：模组信息、占位符、同前缀条目（帮助理解语境） */
export function ContextPanel({ entry, allEntries }: Props) {
  // 同前缀条目：如 item.modid. 下的其他条目，帮助模型/用户理解语境
  const prefix = useMemo(() => {
    const parts = entry.key.split(".");
    return parts.length > 2 ? parts.slice(0, 2).join(".") : entry.key;
  }, [entry.key]);

  const siblings = useMemo(
    () =>
      allEntries
        .filter((e) => e.key !== entry.key && e.key.startsWith(prefix + "."))
        .slice(0, 30),
    [allEntries, entry.key, prefix],
  );

  return (
    <div>
      <Typography.Paragraph>
        <Tag color={STATUS_COLOR[entry.status]}>{STATUS_LABEL[entry.status]}</Tag>
        <Typography.Text code>{entry.key}</Typography.Text>
      </Typography.Paragraph>

      <Typography.Text type="secondary">来源文件</Typography.Text>
      <Typography.Paragraph>{entry.filePath}</Typography.Paragraph>

      <Divider style={{ margin: "12px 0" }} />

      <Typography.Text type="secondary">原文</Typography.Text>
      <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
        {entry.source}
      </Typography.Paragraph>

      <Typography.Text type="secondary">译文</Typography.Text>
      <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
        {entry.translation ?? "（未翻译）"}
      </Typography.Paragraph>

      {entry.placeholders.length > 0 && (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="secondary">占位符（翻译时必须保留）</Typography.Text>
          <div style={{ marginTop: 4 }}>
            {entry.placeholders.map((p, i) => (
              <Tag key={i} color="geekblue">
                {p}
              </Tag>
            ))}
          </div>
        </>
      )}

      {entry.notes.length > 0 && (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="warning">注意事项</Typography.Text>
          {entry.notes.map((n, i) => (
            <Typography.Paragraph key={i} type="warning" style={{ marginBottom: 4 }}>
              • {n}
            </Typography.Paragraph>
          ))}
        </>
      )}

      {siblings.length > 0 && (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="secondary">
            同组条目（{prefix}.*，共 {siblings.length} 条，前 30 条）——
            上下文语境
          </Typography.Text>
          {siblings.map((s) => (
            <div key={s.key} style={{ margin: "4px 0" }}>
              <Typography.Text code style={{ fontSize: 12 }}>
                {s.key}
              </Typography.Text>
              <Typography.Text style={{ marginLeft: 8, fontSize: 12 }}>
                {s.source}
              </Typography.Text>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
