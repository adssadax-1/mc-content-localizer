import { useEffect, useMemo, useState } from "react";
import { Button, Input, message, Modal, Segmented, Space, Tag, Typography } from "antd";
import { save as pickSave } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { LogEntry } from "../types";
import { LogIcon } from "./LogIcon";
import { useTranslationContext } from "../i18n";

type LevelFilter = "all" | "info" | "warn" | "error";

const LEVEL_COLOR: Record<string, string> = {
  info: "blue",
  warn: "gold",
  error: "red",
};

/** 导出文件名：软件名 + 日志 + 时间戳（跟随界面语言，英文档下用英文名） */
function stamp(appName: string, logsName: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${appName}_${logsName}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.log`;
}

/**
 * 「日志」页：查看 / 筛选 / 搜索当前会话日志，导出本次会话，打开日志文件夹。
 * 数据来自后端内存缓冲（会话内），打开期间每 1.5s 轮询一次保持实时。
 */
export function LogsModal({
  open,
  autoLog,
  onClose,
}: {
  open: boolean;
  autoLog: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslationContext();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  // 打开期间轮询（1.5s）：新日志自动出现，关闭弹窗即停止
  useEffect(() => {
    if (!open) return;
    const tick = () => void api.logRecent().then(setEntries).catch(() => {});
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (level === "all" || e.level === level) &&
        (!q || e.message.toLowerCase().includes(q)),
    );
  }, [entries, level, query]);

  const exportLog = async () => {
    const path = await pickSave({
      defaultPath: stamp(t("app.title"), t("app.logs.title")),
      filters: [{ name: "LOG", extensions: ["log"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const n = await api.logExport(path);
      message.success(t("app.logs.exported", { n }));
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  /* 打开文件夹由后端直接完成（它自己调 opener，绕开前端 ACL 限制），
     这里只负责提示：成功给一句带路径的提示，失败给后端返回的原因。 */
  const openDir = async () => {
    try {
      const dir = await api.logOpenDir();
      message.success(`${t("app.logs.opened")}：${dir}`);
    } catch (e) {
      message.error(`${t("app.logs.folderFailed")}：${String(e)}`);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={760}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Space size={6}>
            {/* 整句走 i18n（不在 JSX 里拼全角冒号，否则英文档会变成 "Auto logging：paused"） */}
            <Tag color={autoLog ? "green" : "default"}>
              {t(autoLog ? "app.logs.autoOn" : "app.logs.autoOff")}
            </Tag>
          </Space>
          <Space size={8}>
            <Button loading={busy} onClick={() => void exportLog()}>
              {t("app.logs.export")}
            </Button>
            <Button type="primary" onClick={() => void openDir()}>
              {t("app.logs.openDir")}
            </Button>
          </Space>
        </div>
      }
      title={
        <Space size={6}>
          <LogIcon size={15} />
          <span>{t("app.logs.title")}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {t("app.logs.session")}
          </Typography.Text>
        </Space>
      }
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <Segmented
          value={level}
          onChange={(v) => setLevel(v as LevelFilter)}
          options={[
            { value: "all", label: t("app.logs.all") },
            { value: "info", label: "INFO" },
            { value: "warn", label: "WARN" },
            { value: "error", label: "ERROR" },
          ]}
        />
        <Input
          allowClear
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("app.logs.search")}
          style={{ flex: 1, minWidth: 180 }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {t("app.logs.count", { n: shown.length })}
        </Typography.Text>
      </div>

      <div
        style={{
          height: "52vh",
          overflowY: "auto",
          border: "1px solid var(--border-color, #F0F2F5)",
          borderRadius: 8,
          padding: "8px 12px",
          fontFamily: "Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.7,
        }}
      >
        {shown.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <Typography.Text type="secondary">
              {t("app.logs.empty")}
              {!autoLog && t("app.logs.autoOffHint")}
            </Typography.Text>
          </div>
        ) : (
          shown.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
                {e.time}
              </Typography.Text>
              <Tag color={LEVEL_COLOR[e.level] ?? "default"} style={{ flexShrink: 0, marginInlineEnd: 0 }}>
                {e.level.toUpperCase()}
              </Tag>
              <span style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>{e.message}</span>
            </div>
          ))
        )}
      </div>

      {/* 脱敏说明：日志会被拿去贴给作者/发 issue，必须先让用户放心"里面没有我的 Key" */}
      <Typography.Paragraph
        type="secondary"
        className="io-hide"
        style={{ fontSize: 11, margin: "8px 0 0" }}
      >
        {t("app.logs.sensitive")}
      </Typography.Paragraph>
    </Modal>
  );
}
