import { useMemo } from "react";
import { Divider, Tag, Typography } from "antd";
import { useTranslationContext } from "../i18n";
import type { LangEntry } from "../types";
import { STATUS_COLOR } from "../types";

interface Props {
  entry: LangEntry;
  allEntries: LangEntry[];
}

/** 选中条目的上下文面板：模组信息、占位符、同前缀条目（帮助理解语境） */
export function ContextPanel({ entry, allEntries }: Props) {
  const { t } = useTranslationContext();
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
        <Tag color={STATUS_COLOR[entry.status]}>{t(`status.${entry.status}`)}</Tag>
        <Typography.Text code>{entry.key}</Typography.Text>
      </Typography.Paragraph>

      <Typography.Text type="secondary">{t("components.sourceFile")}</Typography.Text>
      <Typography.Paragraph>{entry.filePath}</Typography.Paragraph>

      <Divider style={{ margin: "12px 0" }} />

      <Typography.Text type="secondary">{t("components.source")}</Typography.Text>
      <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
        {entry.source}
      </Typography.Paragraph>

      <Typography.Text type="secondary">{t("components.translation")}</Typography.Text>
      <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
        {entry.translation ?? t("components.untranslatedText")}
      </Typography.Paragraph>

      {entry.placeholders.length > 0 && (
        <>
          <Divider style={{ margin: "12px 0" }} />
          <Typography.Text type="secondary">{t("components.placeholders")}</Typography.Text>
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
          <Typography.Text type="warning">{t("components.notes")}</Typography.Text>
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
            {t("components.sameGroup")}（{prefix}.*，{siblings.length}）—— {t("components.sameGroupSuffix")}
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
