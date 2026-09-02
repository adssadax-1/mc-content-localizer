import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  Button,
  Card,
  Collapse,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Tree,
  Typography,
  message,
} from "antd";
import { ClearOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslationContext } from "../i18n";
import { api } from "../api";
import {
  DEV_INVOKE_LOG,
  DEV_SHOW_RESULT_ALERT,
  DEV_SHOW_EXPORT_ERROR,
  DEV_FAULT_CHANGED,
  type DevResultKind,
  type DevFaultNotice,
} from "../devtools/bus";

// ── devApi: invoke logging proxy ──────────────────────────────────────────────
// 当 __DEVTOOLS__ 为 true 时，导出 devApi 代理包装 api 对象，每次 invoke 记录到 ring buffer。
// 生产构建（__DEVTOOLS__=false）整个模块被 tree-shake，零开销。

export interface InvokeLogEntry {
  id: number;
  timestamp: number;
  command: string;
  args: unknown;
  result: unknown;
  error: string | null;
  durationMs: number;
}

export interface EventLogEntry {
  id: number;
  timestamp: number;
  event: string;
  payload: unknown;
}

export interface HttpRequestEntry {
  id: number;
  timestamp: number;
  url: string;
  model: string;
  temperature: number;
  jsonMode: boolean;
  purpose?: string;
  systemHead: string;
  userHead: string;
  response?: HttpResponseEntry;
}

export interface HttpResponseEntry {
  id: number;
  timestamp: number;
  status: number;
  bodyHead: string;
}

export interface RetryEntry {
  id: number;
  timestamp: number;
  attempt: number;
  maxRetries: number;
  is429: boolean;
  errorMsg: string;
  waitSecs: number;
}

export interface DegradationEntry {
  id: number;
  timestamp: number;
  stage: string;
  temp?: number;
}

export interface ThreadAssignEntry {
  id: number;
  timestamp: number;
  workerId: number;
  chunkCount: number;
  packKey?: string;
  packName?: string;
}

export interface BatchStartEntry {
  id: number;
  timestamp: number;
  packKey?: string;
  workerId: number;
}

export interface BatchDoneEntry {
  id: number;
  timestamp: number;
  ok: number;
  error: string;
  durationMs: number;
  packKey?: string;
  workerId: number;
}

export interface ThrottleEntry {
  id: number;
  timestamp: number;
  workerId: number;
  intervalSec: number;
  packKey?: string;
}

// ── 环形缓冲 store（简化版，面板内自洽） ──────────────────────────────────────
const MAX_LOGS = 1000;

interface DevStore {
  /** 每次变更自增（useMemo 依赖它重算：数组都是原地 push，引用不变） */
  version: number;
  events: EventLogEntry[];
  invokes: InvokeLogEntry[];
  // 派生集合：从 events 中提取的 dev-* 专用条目
  httpRequests: HttpRequestEntry[];
  httpResponses: HttpResponseEntry[];
  retries: RetryEntry[];
  degradations: DegradationEntry[];
  threadAssigns: ThreadAssignEntry[];
  batchStarts: BatchStartEntry[];
  batchDones: BatchDoneEntry[];
  throttles: ThrottleEntry[];
  nextId: number;
}

const store: DevStore = {
  version: 0,
  events: [],
  invokes: [],
  httpRequests: [],
  httpResponses: [],
  retries: [],
  degradations: [],
  threadAssigns: [],
  batchStarts: [],
  batchDones: [],
  throttles: [],
  nextId: 0,
};

// 简单的发布订阅，让组件能感知 store 变化
type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  store.version += 1;
  listeners.forEach((l) => l());
}
function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function pushEvent(event: string, payload: unknown) {
  const id = store.nextId++;
  const timestamp = Date.now();
  store.events.push({ id, timestamp, event, payload });
  if (store.events.length > MAX_LOGS) store.events.shift();

  // 路由 dev-* 事件到专用集合
  const p = payload as Record<string, unknown>;
  switch (event) {
    case "dev-http-request":
      store.httpRequests.push({
        id, timestamp,
        url: String(p.url ?? ""),
        model: String(p.model ?? ""),
        temperature: Number(p.temperature ?? 0),
        jsonMode: Boolean(p.jsonMode),
        purpose: p.purpose ? String(p.purpose) : undefined,
        systemHead: String(p.systemHead ?? ""),
        userHead: String(p.userHead ?? ""),
      });
      if (store.httpRequests.length > MAX_LOGS) store.httpRequests.shift();
      break;
    case "dev-http-response": {
      const resp: HttpResponseEntry = {
        id, timestamp,
        status: Number(p.status ?? 0),
        bodyHead: String(p.bodyHead ?? ""),
      };
      store.httpResponses.push(resp);
      if (store.httpResponses.length > MAX_LOGS) store.httpResponses.shift();
      // 尝试配对到最近的未配对 request
      for (let i = store.httpRequests.length - 1; i >= 0; i--) {
        if (!store.httpRequests[i].response) {
          store.httpRequests[i].response = resp;
          break;
        }
      }
      break;
    }
    case "dev-retry":
      store.retries.push({
        id, timestamp,
        attempt: Number(p.attempt ?? 0),
        maxRetries: Number(p.maxRetries ?? 0),
        is429: Boolean(p.is429),
        errorMsg: String(p.errorMsg ?? ""),
        waitSecs: Number(p.waitSecs ?? 0),
      });
      if (store.retries.length > MAX_LOGS) store.retries.shift();
      break;
    case "dev-degradation":
      store.degradations.push({
        id, timestamp,
        stage: String(p.stage ?? ""),
        temp: p.temp !== undefined ? Number(p.temp) : undefined,
      });
      if (store.degradations.length > MAX_LOGS) store.degradations.shift();
      break;
    case "dev-thread-assign":
      store.threadAssigns.push({
        id, timestamp,
        workerId: Number(p.workerId ?? 0),
        chunkCount: Number(p.chunkCount ?? 0),
        packKey: p.packKey ? String(p.packKey) : undefined,
        packName: p.packName ? String(p.packName) : undefined,
      });
      if (store.threadAssigns.length > MAX_LOGS) store.threadAssigns.shift();
      break;
    case "dev-batch-start":
      store.batchStarts.push({
        id, timestamp,
        packKey: p.packKey ? String(p.packKey) : undefined,
        workerId: Number(p.workerId ?? 0),
      });
      if (store.batchStarts.length > MAX_LOGS) store.batchStarts.shift();
      break;
    case "dev-batch-done":
      store.batchDones.push({
        id, timestamp,
        ok: Number(p.ok ?? 0),
        error: String(p.error ?? ""),
        durationMs: Number(p.durationMs ?? 0),
        packKey: p.packKey ? String(p.packKey) : undefined,
        workerId: Number(p.workerId ?? 0),
      });
      if (store.batchDones.length > MAX_LOGS) store.batchDones.shift();
      break;
    case "dev-thread-throttle":
      store.throttles.push({
        id, timestamp,
        workerId: Number(p.workerId ?? 0),
        intervalSec: Number(p.intervalSec ?? 0),
        packKey: p.packKey ? String(p.packKey) : undefined,
      });
      if (store.throttles.length > MAX_LOGS) store.throttles.shift();
      break;
  }
  notify();
}

/** 本地入队（不广播）。开发者工具窗口通过 dev-invoke-log 事件收到后调用此函数。 */
export function pushInvokeLocal(entry: Omit<InvokeLogEntry, "id" | "timestamp">) {
  store.invokes.push({ ...entry, id: store.nextId++, timestamp: Date.now() });
  if (store.invokes.length > MAX_LOGS) store.invokes.shift();
  notify();
}

/**
 * 主窗口 devApi 代理调用：本地入队 + 广播给开发者工具窗口。
 * 仅主窗口调用（invoke 都发生在主窗口）；开发者工具窗口只监听不入队广播，避免回环。
 */
export function pushInvoke(entry: Omit<InvokeLogEntry, "id" | "timestamp">) {
  pushInvokeLocal(entry);
  void emit(DEV_INVOKE_LOG, { ...entry }).catch(() => {});
}

export function clearEvents() {
  store.events = [];
  store.httpRequests = [];
  store.httpResponses = [];
  store.retries = [];
  store.degradations = [];
  store.threadAssigns = [];
  store.batchStarts = [];
  store.batchDones = [];
  store.throttles = [];
  notify();
}

export function clearInvokes() {
  store.invokes = [];
  notify();
}

// React hook：订阅 store 变化
function useDevStore() {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((v) => v + 1)), []);
  return store;
}

// ── 通用 JSON 预览组件（全文显示，maxHeight 内滚动，不省略） ──────────────────
function JsonPre({ data }: { data: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);
  return (
    <div style={{ position: "relative" }}>
      <pre
        style={{
          margin: 0,
          padding: 8,
          background: "rgba(0,0,0,0.04)",
          borderRadius: 4,
          fontSize: 12,
          overflowX: "auto",
          maxHeight: 300,
          overflowY: "auto",
        }}
      >
        {text}
      </pre>
      <Typography.Paragraph
        copyable={{ text }}
        style={{ position: "absolute", top: 4, right: 8, margin: 0, fontSize: 12 }}
      >
        {" "}
      </Typography.Paragraph>
    </div>
  );
}

// ── 事件流监视器 tab ──────────────────────────────────────────────────────────
function EventStreamTab() {
  const { t } = useTranslationContext();
  const store = useDevStore();
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<string>("");

  const eventNames = useMemo(
    () => [...new Set(store.events.map((e) => e.event))].sort(),
    [store.version]
  );
  const filtered = useMemo(
    () => (filter ? store.events.filter((e) => e.event === filter) : store.events),
    [store.version, filter]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filtered, autoScroll]);

  const eventColor = (name: string): string => {
    if (name.startsWith("dev-")) return "purple";
    if (name.includes("error") || name.includes("fail")) return "red";
    if (name.includes("progress")) return "blue";
    if (name.includes("batch")) return "green";
    if (name.includes("done")) return "gold";
    return "default";
  };

  return (
    <div style={{ height: "calc(100vh - 280px)", display: "flex", flexDirection: "column" }}>
      <Space style={{ marginBottom: 8 }} wrap>
        <Select
          style={{ width: 200 }}
          placeholder={t("devtools.eventStream.filterAll")}
          allowClear
          value={filter || undefined}
          onChange={(v) => setFilter(v ?? "")}
          options={eventNames.map((n) => ({ label: n, value: n }))}
        />
        <Switch
          checkedChildren={t("devtools.common.autoScroll")}
          unCheckedChildren={t("devtools.common.autoScroll")}
          checked={autoScroll}
          onChange={setAutoScroll}
        />
        <Button icon={<ClearOutlined />} onClick={clearEvents}>
          {t("devtools.common.clear")}
        </Button>
        <Typography.Text type="secondary">
          {filtered.length} {t("devtools.common.count")}
        </Typography.Text>
      </Space>
      <div ref={containerRef} style={{ flex: 1, overflowY: "auto" }}>
        {filtered.length === 0 ? (
          <Empty description={t("devtools.eventStream.noData")} />
        ) : (
          <Timeline
            items={filtered.map((e) => ({
              color: eventColor(e.event),
              children: (
                <div>
                  <Space>
                    <Tag color={eventColor(e.event)}>{e.event}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </Typography.Text>
                  </Space>
                  <div style={{ marginTop: 4 }}>
                    {/* 载荷默认收起，展开显示全文（可滚动，不省略） */}
                    <Collapse
                      ghost
                      size="small"
                      items={[
                        {
                          key: "payload",
                          label: (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              {t("devtools.eventStream.payload")}
                            </Typography.Text>
                          ),
                          children: <JsonPre data={e.payload} />,
                        },
                      ]}
                    />
                  </div>
                </div>
              ),
            }))}
          />
        )}
      </div>
    </div>
  );
}

// ── 命令调用记录器 tab ─────────────────────────────────────────────────────────
function InvokeLogTab() {
  const { t } = useTranslationContext();
  const store = useDevStore();

  const columns = [
    {
      title: t("devtools.invokeLog.colTime"),
      dataIndex: "timestamp",
      width: 90,
      render: (v: number) => (
        <Typography.Text style={{ fontSize: 11 }} type="secondary">
          {new Date(v).toLocaleTimeString()}
        </Typography.Text>
      ),
    },
    {
      title: t("devtools.invokeLog.colCommand"),
      dataIndex: "command",
      width: 160,
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    {
      title: t("devtools.invokeLog.colStatus"),
      dataIndex: "error",
      width: 70,
      render: (err: string | null) =>
        err ? <Tag color="red">✗ {t("devtools.invokeLog.failed")}</Tag> : <Tag color="green">✓ {t("devtools.invokeLog.success")}</Tag>,
    },
    {
      title: t("devtools.invokeLog.colDuration"),
      dataIndex: "durationMs",
      width: 80,
      render: (v: number) => `${v}ms`,
      sorter: (a: InvokeLogEntry, b: InvokeLogEntry) => a.durationMs - b.durationMs,
    },
    {
      title: t("devtools.invokeLog.colArgs"),
      dataIndex: "args",
      render: (args: unknown) => {
        const s = (() => {
          try {
            return JSON.stringify(args);
          } catch {
            return String(args);
          }
        })();
        return (
          <Typography.Text style={{ fontSize: 11 }} ellipsis>
            {s.length > 80 ? s.slice(0, 80) + "…" : s}
          </Typography.Text>
        );
      },
    },
  ];

  return (
    <div style={{ height: "calc(100vh - 280px)", display: "flex", flexDirection: "column" }}>
      <Space style={{ marginBottom: 8 }}>
        <Button icon={<ClearOutlined />} onClick={clearInvokes}>
          {t("devtools.common.clear")}
        </Button>
        <Typography.Text type="secondary">
          {store.invokes.length} {t("devtools.common.count")}
        </Typography.Text>
      </Space>
      <div style={{ flex: 1 }}>
        {store.invokes.length === 0 ? (
          <Empty description={t("devtools.invokeLog.noData")} />
        ) : (
          <Table<InvokeLogEntry>
            rowKey="id"
            columns={columns}
            dataSource={store.invokes}
            size="small"
            pagination={{ pageSize: 50, size: "small" }}
            expandable={{
              expandedRowRender: (record) => (
                <div>
                  <Typography.Text strong>{t("devtools.invokeLog.colArgs")}:</Typography.Text>
                  <JsonPre data={record.args} />
                  <Typography.Text strong style={{ marginTop: 8, display: "block" }}>
                    {record.error ? t("devtools.invokeLog.failed") : "Result"}:
                  </Typography.Text>
                  <JsonPre data={record.error ?? record.result} />
                </div>
              ),
            }}
            scroll={{ y: "calc(100vh - 380px)" }}
          />
        )}
      </div>
    </div>
  );
}

// ── 请求/响应 viewer tab（Phase 3） ──────────────────────────────────────────
function RequestResponseTab() {
  const { t } = useTranslationContext();
  const store = useDevStore();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const pairs = store.httpRequests;
  const selected = selectedId ? pairs.find((p) => p.id === selectedId) : pairs[pairs.length - 1];

  return (
    <div style={{ height: "calc(100vh - 280px)", display: "flex", flexDirection: "column", gap: 8 }}>
      <Space>
        <Select
          style={{ flex: 1, minWidth: 300 }}
          placeholder={t("devtools.requestResponse.selectBatch")}
          value={selected?.id}
          onChange={(v) => setSelectedId(v)}
          options={pairs.map((p, i) => ({
            label: `#${i + 1} ${new Date(p.timestamp).toLocaleTimeString()} ${
              p.purpose === "glossary" ? `[${t("devtools.requestResponse.glossary")}]` : ""
            } ${p.response ? `(${p.response.status})` : "..."}`,
            value: p.id,
          }))}
        />
        <Typography.Text type="secondary">
          {pairs.length} {t("devtools.common.count")}
        </Typography.Text>
      </Space>
      {selected ? (
        <div style={{ display: "flex", gap: 12, flex: 1, overflow: "hidden" }}>
          {/* 请求 */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <Typography.Text strong>{t("devtools.requestResponse.request")}</Typography.Text>
            <div style={{ marginBottom: 4 }}>
              {selected.purpose && (
                <Tag color={selected.purpose === "translate" ? "geekblue" : "gold"}>
                  {selected.purpose === "glossary"
                    ? t("devtools.requestResponse.glossary")
                    : t("devtools.requestResponse.translate")}
                </Tag>
              )}
              <Tag>{selected.model}</Tag>
              <Tag color={selected.jsonMode ? "blue" : "default"}>
                {selected.jsonMode ? "JSON" : "plain"}
              </Tag>
              <Tag>temp={selected.temperature}</Tag>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {t("devtools.requestResponse.system")}:
            </Typography.Text>
            <pre style={preStyle}>{selected.systemHead}</pre>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {t("devtools.requestResponse.user")}:
            </Typography.Text>
            <pre style={preStyle}>{selected.userHead}</pre>
          </div>
          {/* 响应 */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <Typography.Text strong>{t("devtools.requestResponse.response")}</Typography.Text>
            {selected.response ? (
              <>
                <div style={{ marginBottom: 4 }}>
                  <Tag color={selected.response.status < 400 ? "green" : "red"}>
                    {t("devtools.requestResponse.status")}: {selected.response.status}
                  </Tag>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {t("devtools.requestResponse.body")}:
                </Typography.Text>
                <pre style={preStyle}>{selected.response.bodyHead}</pre>
              </>
            ) : (
              <Empty description="..." />
            )}
          </div>
        </div>
      ) : (
        <Empty description={t("devtools.requestResponse.noPairs")} />
      )}
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  background: "rgba(0,0,0,0.04)",
  borderRadius: 4,
  fontSize: 11,
  overflowX: "auto",
  flex: 1,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

// ── 重试/降级链 tab（Phase 3） ────────────────────────────────────────────────
function RetryChainTab() {
  const { t } = useTranslationContext();
  const store = useDevStore();

  // 合并 retries + degradations，按时间排序
  const timeline = useMemo(() => {
    const items: { timestamp: number; kind: "retry" | "degradation"; data: RetryEntry | DegradationEntry }[] = [
      ...store.retries.map((r) => ({ timestamp: r.timestamp, kind: "retry" as const, data: r })),
      ...store.degradations.map((d) => ({ timestamp: d.timestamp, kind: "degradation" as const, data: d })),
    ];
    return items.sort((a, b) => a.timestamp - b.timestamp);
  }, [store.version]);

  return (
    <div style={{ height: "calc(100vh - 280px)", overflowY: "auto" }}>
      {timeline.length === 0 ? (
        <Empty description={t("devtools.retryChain.noData")} />
      ) : (
        <Timeline
          items={timeline.map((item) => {
            if (item.kind === "retry") {
              const r = item.data as RetryEntry;
              return {
                color: r.is429 ? "red" : "orange",
                children: (
                  <div>
                    <Space>
                      <Tag color={r.is429 ? "red" : "orange"}>
                        {r.is429 ? t("devtools.retryChain.is429") : t("devtools.retryChain.retry")}
                      </Tag>
                      <Typography.Text strong>
                        {t("devtools.retryChain.attempt", { n: r.attempt })} / {r.maxRetries}
                      </Typography.Text>
                    </Space>
                    <div style={{ marginTop: 2 }}>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {new Date(r.timestamp).toLocaleTimeString()}
                      </Typography.Text>
                    </div>
                    <div style={{ fontSize: 11 }}>{r.errorMsg}</div>
                    <Tag color="blue">{t("devtools.retryChain.waitSecs", { n: r.waitSecs })}</Tag>
                  </div>
                ),
              };
            }
            const d = item.data as DegradationEntry;
            return {
              color: "purple",
              children: (
                <div>
                  <Space>
                    <Tag color="purple">{t("devtools.retryChain.degradation")}</Tag>
                    <Typography.Text strong>{d.stage}</Typography.Text>
                    {d.temp !== undefined && <Tag>temp={d.temp}</Tag>}
                  </Space>
                  <div style={{ marginTop: 2 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {new Date(d.timestamp).toLocaleTimeString()}
                    </Typography.Text>
                  </div>
                </div>
              ),
            };
          })}
        />
      )}
    </div>
  );
}

// ── 多线程调度 tab（Phase 3） ────────────────────────────────────────────────
function ThreadScheduleTab() {
  const { t } = useTranslationContext();
  const store = useDevStore();

  // 两级分组：内容包（packKey）→ 线程（workerId）
  const packs = useMemo(() => {
    type W = { chunkCount: number; dones: BatchDoneEntry[]; starts: number; throttles: number[] };
    const map = new Map<string, { packName: string; workers: Map<number, W> }>();
    const ensure = (key: string, name?: string) => {
      if (!map.has(key)) map.set(key, { packName: name && name !== key ? name : key, workers: new Map() });
      return map.get(key)!;
    };
    const workerOf = (g: { workers: Map<number, W> }, wid: number): W => {
      if (!g.workers.has(wid)) g.workers.set(wid, { chunkCount: 0, dones: [], starts: 0, throttles: [] });
      return g.workers.get(wid)!;
    };
    for (const a of store.threadAssigns) {
      const g = ensure(a.packKey ?? "__default__", a.packName);
      workerOf(g, a.workerId).chunkCount += a.chunkCount;
    }
    for (const st of store.batchStarts) {
      const g = map.get(st.packKey ?? "__default__");
      if (g) workerOf(g, st.workerId).starts += 1;
    }
    for (const d of store.batchDones) {
      const g = map.get(d.packKey ?? "__default__");
      if (g) workerOf(g, d.workerId).dones.push(d);
    }
    for (const th of store.throttles) {
      const g = map.get(th.packKey ?? "__default__");
      if (g) workerOf(g, th.workerId).throttles.push(th.intervalSec);
    }
    return [...map.entries()];
  }, [store.version]);

  if (packs.length === 0) {
    return (
      <div style={{ height: "calc(100vh - 280px)" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
          {t("devtools.threadSchedule.desc")}
        </Typography.Text>
        <Empty description={t("devtools.threadSchedule.noData")} />
      </div>
    );
  }

  const blockColor = (b: { ok: number; error: string }) => {
    if (b.error) return "#ff4d4f";
    if (b.ok === 0) return "#faad14";
    return "#52c41a";
  };

  return (
    <div style={{ height: "calc(100vh - 280px)", overflowY: "auto" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
        {t("devtools.threadSchedule.desc")}
      </Typography.Text>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong>{t("devtools.threadSchedule.legend")}:</Typography.Text>
        <Tag color="#1677ff" className="dev-pulse-tag">{t("devtools.threadSchedule.active")}</Tag>
        <Tag color="#52c41a">OK</Tag>
        <Tag color="#faad14">Empty</Tag>
        <Tag color="#ff4d4f">Error</Tag>
        <Tag color="#8c8c8c">{t("devtools.threadSchedule.throttleTag")}</Tag>
      </Space>

      {packs.map(([pk, g]) => {
        const workers = [...g.workers.entries()].sort((a, b) => a[0] - b[0]);
        const allDone = workers.every(([, w]) => w.starts > 0 && w.dones.length >= w.starts);
        return (
          <div
            key={pk}
            style={{
              marginBottom: 14,
              border: "1px solid var(--border-color, #303030)",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>{g.packName}</Typography.Text>
              {allDone ? (
                <Tag color="green">{t("devtools.threadSchedule.done")}</Tag>
              ) : (
                <Tag color="processing" className="dev-pulse-tag">
                  {t("devtools.threadSchedule.active")}
                </Tag>
              )}
            </div>
            {workers.map(([wid, w]) => {
              const inProg = Math.max(0, w.starts - w.dones.length);
              return (
                <div key={wid} style={{ display: "flex", alignItems: "center", marginBottom: 6, gap: 8 }}>
                  <Typography.Text style={{ width: 84, fontSize: 12, flexShrink: 0 }}>
                    {t("devtools.threadSchedule.worker", { n: wid })}
                  </Typography.Text>
                  <div style={{ flex: 1, display: "flex", gap: 2, alignItems: "center", minHeight: 22, flexWrap: "wrap" }}>
                    {w.dones.map((d, i) => (
                      <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                        <Tooltip
                          title={
                            <div>
                              <div>{t("devtools.threadSchedule.duration", { n: d.durationMs })}</div>
                              <div>ok: {d.ok}</div>
                              {d.error && <div style={{ color: "#ffccc7" }}>{d.error}</div>}
                            </div>
                          }
                        >
                          <div
                            style={{
                              width: Math.max(34, Math.min(110, d.durationMs / 50 + 20)),
                              height: 18,
                              background: blockColor(d),
                              borderRadius: 3,
                              fontSize: 10,
                              color: "#fff",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: "0 4px",
                            }}
                          >
                            {d.durationMs}ms
                          </div>
                        </Tooltip>
                        {(w.throttles[i] ?? 0) > 0 && i < w.dones.length && (
                          <Tooltip title={t("devtools.threadSchedule.throttle", { n: w.throttles[i] })}>
                            <div
                              style={{
                                width: Math.max(8, w.throttles[i] * 3),
                                height: 6,
                                background: "#8c8c8c",
                                borderRadius: 2,
                              }}
                            />
                          </Tooltip>
                        )}
                      </span>
                    ))}
                    {inProg > 0 && (
                      <Tooltip title={t("devtools.threadSchedule.activeTip", { n: inProg })}>
                        <div
                          className="dev-block-active"
                          style={{
                            width: 48,
                            height: 18,
                            borderRadius: 3,
                            fontSize: 10,
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          ×{inProg}
                        </div>
                      </Tooltip>
                    )}
                    {w.dones.length === 0 && inProg === 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {t("devtools.threadSchedule.waiting")}
                      </Typography.Text>
                    )}
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                    {w.dones.length}/{w.chunkCount}
                  </Typography.Text>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── 故障注入 tab（Phase 4） ───────────────────────────────────────────────────

/** 六类结果弹窗触发：广播事件给主窗口，由主窗口走真实 buildResultAlert 渲染路径 */
function ErrorPopupSubPanel() {
  const { t } = useTranslationContext();
  const kinds: { kind: DevResultKind; label: string }[] = [
    { kind: "ok", label: "OK" },
    { kind: "empty", label: "Empty" },
    { kind: "warn", label: "Warn" },
    { kind: "error", label: "Error" },
    { kind: "error429", label: "429" },
    { kind: "cancel", label: "Cancel" },
  ];
  return (
    <Card size="small" title={t("devtools.injection.errorPopups")} style={{ marginBottom: 16 }}>
      <Space wrap>
        {kinds.map(({ kind, label }) => (
          <Button key={kind} onClick={() => void emit(DEV_SHOW_RESULT_ALERT, kind)}>
            {label}
          </Button>
        ))}
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
        {t("devtools.injection.errorPopupHint")}
      </Typography.Paragraph>
    </Card>
  );
}

/** 网络故障注入表单：设置 fault config → 下次翻译生效 */
function NetworkFaultSubPanel() {
  const { t } = useTranslationContext();
  const [delayMs, setDelayMs] = useState<number | null>(null);
  const [forceTimeout, setForceTimeout] = useState(false);
  const [mockStatus, setMockStatus] = useState<number | null>(null);
  const [mockBody, setMockBody] = useState("");
  const [disconnect, setDisconnect] = useState(false);

  // 按当前语言拼故障摘要（主窗口直接展示，两个窗口语言一致）
  const summary = useCallback(() => {
    const parts: string[] = [];
    if (disconnect) parts.push(t("devtools.injection.disconnect"));
    if (forceTimeout) parts.push(t("devtools.injection.forceTimeout"));
    if (mockStatus != null) parts.push(`${t("devtools.injection.mockStatus")} ${mockStatus}`);
    if (delayMs != null && delayMs > 0) parts.push(`${t("devtools.injection.delayMs").replace("(", "")} ${delayMs}`);
    return parts.join(" + ");
  }, [disconnect, forceTimeout, mockStatus, delayMs, t]);

  const apply = useCallback(async () => {
    try {
      await api.devSetFault({ delayMs, forceTimeout, mockStatus, mockBody: mockBody || null, disconnect });
      // 提示与常驻标签都在主窗口弹出（广播），与导出失败注入同一机制
      void emit(DEV_FAULT_CHANGED, { active: true, summary: summary() } satisfies DevFaultNotice);
    } catch (e) {
      message.error(String(e));
    }
  }, [delayMs, forceTimeout, mockStatus, mockBody, disconnect, summary]);

  const clear = useCallback(async () => {
    try {
      await api.devClearFault();
      void emit(DEV_FAULT_CHANGED, { active: false, summary: "" } satisfies DevFaultNotice);
    } catch (e) {
      message.error(String(e));
    }
  }, []);

  return (
    <Card size="small" title={t("devtools.injection.networkFault")} style={{ marginBottom: 16 }}>
      <Form layout="inline" style={{ flexWrap: "wrap", gap: 8 }}>
        <Form.Item label={t("devtools.injection.delayMs")}>
          <InputNumber
            value={delayMs ?? undefined}
            placeholder="—"
            min={0}
            style={{ width: 100 }}
            onChange={(v) => setDelayMs(v ?? null)}
          />
        </Form.Item>
        <Form.Item label={t("devtools.injection.forceTimeout")}>
          <Switch checked={forceTimeout} onChange={setForceTimeout} />
        </Form.Item>
        <Form.Item label={t("devtools.injection.disconnect")}>
          <Switch checked={disconnect} onChange={setDisconnect} />
        </Form.Item>
        <Form.Item label={t("devtools.injection.mockStatus")}>
          <InputNumber
            value={mockStatus ?? undefined}
            placeholder="—"
            min={100}
            max={599}
            style={{ width: 80 }}
            onChange={(v) => setMockStatus(v ?? null)}
          />
        </Form.Item>
        <Form.Item label={t("devtools.injection.mockBody")}>
          <Input
            value={mockBody}
            placeholder='{"error":{"message":"rate limit"}}'
            style={{ width: 240 }}
            onChange={(e) => setMockBody(e.target.value)}
          />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" onClick={apply}>
              {t("devtools.injection.apply")}
            </Button>
            <Button onClick={clear} icon={<ClearOutlined />}>
              {t("devtools.injection.clearFault")}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  );
}

/** 取消/暂停/恢复时序测试：setTimeout 编排 cancel/pause/resume */
function TimingTestSubPanel() {
  const { t } = useTranslationContext();
  const [cancelDelay, setCancelDelay] = useState(3000);
  const [pauseAfter, setPauseAfter] = useState(1000);
  const [resumeAfter, setResumeAfter] = useState(3000);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const addLog = useCallback((s: string) => {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${s}`]);
  }, []);

  const start = useCallback(() => {
    // 清理旧计时器
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setLog([]);
    setRunning(true);
    addLog("Timing test started — pause/resume/cancel will fire per schedule");

    if (pauseAfter > 0) {
      timersRef.current.push(
        setTimeout(() => {
          addLog(`→ pauseTranslation() after ${pauseAfter}ms`);
          api.pauseTranslation().catch((e) => addLog(`pause error: ${e}`));
        }, pauseAfter),
      );
    }
    if (resumeAfter > 0) {
      timersRef.current.push(
        setTimeout(() => {
          addLog(`→ resumeTranslation() after ${resumeAfter}ms`);
          api.resumeTranslation().catch((e) => addLog(`resume error: ${e}`));
        }, resumeAfter),
      );
    }
    if (cancelDelay > 0) {
      timersRef.current.push(
        setTimeout(() => {
          addLog(`→ cancelTranslation() after ${cancelDelay}ms`);
          api.cancelTranslation().catch((e) => addLog(`cancel error: ${e}`));
          setRunning(false);
        }, cancelDelay),
      );
    } else {
      setRunning(false);
    }
  }, [cancelDelay, pauseAfter, resumeAfter, addLog]);

  // 卸载时清理
  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
    };
  }, []);

  return (
    <Card size="small" title={t("devtools.injection.timingTest")} style={{ marginBottom: 16 }}>
      <Form layout="inline" style={{ flexWrap: "wrap", gap: 8 }}>
        <Form.Item label={t("devtools.injection.pauseAfterMs")}>
          <InputNumber value={pauseAfter} min={0} style={{ width: 100 }} onChange={(v) => setPauseAfter(v ?? 0)} />
        </Form.Item>
        <Form.Item label={t("devtools.injection.resumeAfterMs")}>
          <InputNumber value={resumeAfter} min={0} style={{ width: 100 }} onChange={(v) => setResumeAfter(v ?? 0)} />
        </Form.Item>
        <Form.Item label={t("devtools.injection.cancelDelayMs")}>
          <InputNumber value={cancelDelay} min={0} style={{ width: 100 }} onChange={(v) => setCancelDelay(v ?? 0)} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" onClick={start} loading={running}>
            {t("devtools.injection.startTiming")}
          </Button>
        </Form.Item>
      </Form>
      {log.length > 0 && (
        <div style={{ marginTop: 8, maxHeight: 120, overflow: "auto", background: "rgba(0,0,0,0.04)", padding: 8, borderRadius: 4 }}>
          {log.map((l, i) => (
            <div key={i} style={{ fontFamily: "monospace", fontSize: 12 }}>{l}</div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** 导出失败注入：用非法 modid / 无权限目录真实触发 export 报错 */
function ExportFaultSubPanel() {
  const { t } = useTranslationContext();
  const [error, setError] = useState<string | null>(null);

  const triggerIllegal = useCallback(async () => {
    setError(null);
    try {
      // 非法字符 modid → sanitize 后仍可能导致 zip path 问题或文件名异常
      await api.exportResourcePack(
        "C:/Users/Public",
        '<a>:b?c|d*',
        "TestMod",
        [{ key: "test.key", source: "Test", filePath: "test.json", modid: "<a>:b?c|d*", translation: "测试", selected: true, status: "aiTranslated", placeholders: [], notes: [] }],
        "json",
        15,
      );
      setError("Unexpected: export succeeded (sanitization may have handled it)");
    } catch (e) {
      const err = String(e);
      setError(err);
      // 广播给主窗口，用软件自身的格式弹出真实错误提示
      void emit(DEV_SHOW_EXPORT_ERROR, err);
    }
  }, []);

  const triggerDiskPerm = useCallback(async () => {
    setError(null);
    try {
      // 无权限目录 → 真实 File::create 失败
      await api.exportResourcePack(
        "C:/Windows/System32/test_devtools_perm/",
        "testmod",
        "TestMod",
        [{ key: "test.key", source: "Test", filePath: "test.json", modid: "testmod", translation: "测试", selected: true, status: "aiTranslated", placeholders: [], notes: [] }],
        "json",
        15,
      );
      setError("Unexpected: export succeeded");
    } catch (e) {
      const err = String(e);
      setError(err);
      void emit(DEV_SHOW_EXPORT_ERROR, err);
    }
  }, []);

  return (
    <Card size="small" title={t("devtools.injection.exportFault")}>
      <Space>
        <Button onClick={triggerIllegal}>{t("devtools.injection.illegalChar")}</Button>
        <Button onClick={triggerDiskPerm}>{t("devtools.injection.diskPermission")}</Button>
      </Space>
      {error && (
        <div style={{ marginTop: 8 }}>
          <Typography.Paragraph copyable>
            <pre style={{ background: "rgba(0,0,0,0.04)", padding: 8, borderRadius: 4, maxHeight: 150, overflow: "auto", fontSize: 12 }}>
              {error}
            </pre>
          </Typography.Paragraph>
        </div>
      )}
    </Card>
  );
}

function InjectionTab() {
  return (
    <div style={{ height: "calc(100vh - 280px)", overflow: "auto", paddingRight: 4 }}>
      <ErrorPopupSubPanel />
      <NetworkFaultSubPanel />
      <TimingTestSubPanel />
      <ExportFaultSubPanel />
    </div>
  );
}

// ── 解析器测试台 tab（Phase 5） ──────────────────────────────────────────────
interface DevParseResult {
  pairs: [string, string][];
  placeholders: string[];
  error: string | null;
}

function ParserTestbedTab() {
  const { t } = useTranslationContext();
  const [format, setFormat] = useState("json");
  const [text, setText] = useState("");
  const [result, setResult] = useState<DevParseResult | null>(null);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 导入文件：dialog 选路径 → dev 命令读内容 → 填入文本框自动解析（按扩展名切格式）
  const importFile = useCallback(async () => {
    const path = await open({
      title: t("devtools.parserTestbed.importFile"),
      filters: [{ name: "Lang files", extensions: ["json", "lang", "properties"] }],
    });
    if (!path || typeof path !== "string") return;
    try {
      const content = await api.devReadTextFile(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "json";
      setFormat(ext === "lang" ? "lang" : ext === "properties" ? "properties" : "json");
      setText(content);
    } catch (e) {
      message.error(String(e));
    }
  }, [t]);

  // 导出文件：dialog 可命名 → 复用生产编码器生成内容 → 写盘
  const exportFile = useCallback(async () => {
    if (!result || result.pairs.length === 0) return;
    setBusy(true);
    try {
      const target = await save({
        title: t("devtools.parserTestbed.exportFile"),
        defaultPath: format === "lang" ? "zh_cn.lang" : format === "properties" ? "zh_cn.properties" : "zh_cn.json",
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "Legacy lang", extensions: ["lang"] },
          { name: "Properties", extensions: ["properties"] },
        ],
      });
      if (!target) return;
      // 用户填了译文的用译文，没填的用原文
      const pairs = result.pairs.map(([k, src]) => [k, translations[k] || src] as [string, string]);
      const content = await api.devEncodePairs(format, pairs);
      await api.devWriteTextFile(target, content);
      message.success(t("devtools.parserTestbed.exported", { path: target }));
    } catch (e) {
      message.error(String(e));
    } finally {
      setBusy(false);
    }
  }, [result, translations, format, t]);

  // 防抖 300ms 调用 dev_parse_text
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) {
      setResult(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await invoke<DevParseResult>("dev_parse_text", { format, text });
        setResult(res);
        setTranslations({});
      } catch (e) {
        setResult({ pairs: [], placeholders: [], error: e instanceof Error ? e.message : String(e) });
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text, format]);

  const columns = [
    {
      title: t("devtools.parserTestbed.key"),
      dataIndex: 0,
      width: 200,
      render: (v: string) => <Typography.Text code style={{ fontSize: 11 }}>{v}</Typography.Text>,
    },
    {
      title: t("devtools.parserTestbed.source"),
      dataIndex: 1,
      render: (v: string) => <Typography.Text style={{ fontSize: 12 }}>{v}</Typography.Text>,
    },
    {
      title: t("devtools.parserTestbed.translation"),
      dataIndex: 0,
      width: 200,
      render: (key: string) => {
        const tr = translations[key] ?? "";
        return (
          <Input
            size="small"
            value={tr}
            onChange={(e) => {
              const next = { ...translations, [key]: e.target.value };
              setTranslations(next);
            }}
            placeholder="…"
          />
        );
      },
    },
    {
      title: t("devtools.parserTestbed.validate"),
      dataIndex: 0,
      width: 120,
      render: (key: string) => {
        const tr = translations[key];
        if (!tr) return null;
        // 同步校验（前端不调后端，简单比对占位符数量）
        const src = result?.pairs.find((p) => p[0] === key)?.[1] ?? "";
        const srcPh = src.match(/%\d*\$?[a-zA-Z%]|\\[nt]|§[0-9a-fk-or]/g) ?? [];
        const trPh = tr.match(/%\d*\$?[a-zA-Z%]|\\[nt]|§[0-9a-fk-or]/g) ?? [];
        if (srcPh.length === trPh.length) {
          return <Tag color="green" style={{ fontSize: 10 }}>✓</Tag>;
        }
        return (
          <Tooltip title={`${t("devtools.parserTestbed.placeholderWarning")}: ${srcPh.length} → ${trPh.length}`}>
            <Tag color="orange" style={{ fontSize: 10 }}>⚠ {trPh.length}/{srcPh.length}</Tag>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div style={{ height: "calc(100vh - 280px)", display: "flex", flexDirection: "column", gap: 8 }}>
      <Space wrap>
        <Select
          value={format}
          onChange={setFormat}
          style={{ width: 200 }}
          options={[
            { label: t("devtools.parserTestbed.json"), value: "json" },
            { label: t("devtools.parserTestbed.lang"), value: "lang" },
            { label: t("devtools.parserTestbed.properties"), value: "properties" },
          ]}
        />
        <Button size="small" onClick={() => void importFile()}>
          {t("devtools.parserTestbed.importFile")}
        </Button>
        <Button
          size="small"
          loading={busy}
          disabled={!result || result.pairs.length === 0}
          onClick={() => void exportFile()}
        >
          {t("devtools.parserTestbed.exportFile")}
        </Button>
        <Typography.Text type="secondary">
          {result?.pairs.length ?? 0} {t("devtools.common.count")}
        </Typography.Text>
      </Space>
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("devtools.parserTestbed.pasteHere")}
        style={{ minHeight: 120, fontFamily: "monospace", fontSize: 12 }}
      />
      {result?.error && (
        <Typography.Text type="danger">
          {t("devtools.parserTestbed.error", { msg: result.error })}
        </Typography.Text>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {result && result.pairs.length > 0 ? (
          <Table
            rowKey={(r) => r[0]}
            columns={columns}
            dataSource={result.pairs.map((p) => ({ 0: p[0], 1: p[1] }))}
            size="small"
            pagination={false}
          />
        ) : (
          !result?.error && <Empty description={t("devtools.parserTestbed.noResult")} />
        )}
      </div>
    </div>
  );
}

// ── 导出预览器 tab（Phase 6） ────────────────────────────────────────────────
interface DevExportPreview {
  file_name: string;
  sanitized_modid: string;
  original_modid: string;
  uses_min_max_format: boolean;
  mcmeta_json: string;
  lang_path: string;
  lang_content_preview: string;
  zip_tree: string[];
  entry_count: number;
}

function ExportPreviewTab() {
  const { t } = useTranslationContext();
  const [modid, setModid] = useState("minecraft");
  const [modName, setModName] = useState("Minecraft");
  const [packFormat, setPackFormat] = useState(15);
  const [langFormat, setLangFormat] = useState("json");
  const [entries, setEntries] = useState("item.sword.name=Diamond Sword\nitem.sword.desc=Sharp blade");
  const [preview, setPreview] = useState<DevExportPreview | null>(null);
  const [loading, setLoading] = useState(false);

  const handlePreview = useCallback(async () => {
    setLoading(true);
    try {
      // 解析用户输入的条目为 LangEntry 格式
      const lines = entries.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      const langEntries = lines.map((line) => {
        const eq = line.indexOf("=");
        if (eq < 0) return { key: line, source: line, translation: line, hardcoded: false };
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        return { key, source: val, translation: val, hardcoded: false };
      });
      const res = await invoke<DevExportPreview>("dev_preview_export", {
        modid,
        modName,
        entries: langEntries,
        langFormat,
        packFormat,
      });
      setPreview(res);
    } catch (e) {
      setPreview(null);
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [modid, modName, entries, langFormat, packFormat]);

  const treeData = useMemo(() => {
    if (!preview) return [];
    return [
      {
        title: (
          <span>
            <Typography.Text strong>{preview.file_name}</Typography.Text>
          </span>
        ),
        key: "root",
        children: [
          { title: "pack.mcmeta", key: "mcmeta" },
          { title: preview.lang_path, key: "lang" },
        ],
      },
    ];
  }, [preview]);

  return (
    <div style={{ height: "calc(100vh - 280px)", display: "flex", flexDirection: "column", gap: 8, overflowY: "auto" }}>
      <Space wrap>
        <Input
          addonBefore={t("devtools.exportPreview.modid")}
          value={modid}
          onChange={(e) => setModid(e.target.value)}
          style={{ width: 200 }}
        />
        <Input
          addonBefore={t("devtools.exportPreview.modName")}
          value={modName}
          onChange={(e) => setModName(e.target.value)}
          style={{ width: 200 }}
        />
        <InputNumber
          addonBefore={t("devtools.exportPreview.packFormat")}
          value={packFormat}
          onChange={(v) => setPackFormat(v ?? 15)}
          min={1}
          max={999}
        />
        <Select
          value={langFormat}
          onChange={setLangFormat}
          style={{ width: 120 }}
          options={[
            { label: "JSON", value: "json" },
            { label: "Legacy", value: "legacy" },
          ]}
        />
        <Button type="primary" onClick={handlePreview} loading={loading}>
          {t("devtools.exportPreview.preview")}
        </Button>
      </Space>
      <Input.TextArea
        value={entries}
        onChange={(e) => setEntries(e.target.value)}
        placeholder="key=value (one per line, value becomes both source and translation)"
        style={{ minHeight: 60, fontFamily: "monospace", fontSize: 12 }}
      />
      {preview && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* sanitize 对比 */}
          <div>
            <Typography.Text strong>{t("devtools.exportPreview.fileName")}: </Typography.Text>
            <Typography.Text code>{preview.file_name}</Typography.Text>
            {preview.original_modid !== preview.sanitized_modid && (
              <Space style={{ marginLeft: 8 }}>
                <Tag color="orange">
                  {t("devtools.exportPreview.sanitizeBefore")}: {preview.original_modid}
                </Tag>
                <Tag color="green">
                  {t("devtools.exportPreview.sanitizeAfter")}: {preview.sanitized_modid}
                </Tag>
              </Space>
            )}
          </div>

          {/* pack_format 决策 */}
          <div>
            <Typography.Text strong>{t("devtools.exportPreview.formatDecision")}: </Typography.Text>
            {preview.uses_min_max_format ? (
              <Tag color="purple">{t("devtools.exportPreview.usesMinMax")}</Tag>
            ) : (
              <Tag color="blue">{t("devtools.exportPreview.usesPackFormat")}</Tag>
            )}
          </div>

          {/* ZIP 结构树 */}
          <div>
            <Typography.Text strong>{t("devtools.exportPreview.zipStructure")}</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <Tree treeData={treeData} defaultExpandAll selectable={false} />
            </div>
          </div>

          {/* mcmeta 内容 */}
          <div>
            <Typography.Text strong>{t("devtools.exportPreview.mcmetaContent")}</Typography.Text>
            <JsonPre data={preview.mcmeta_json} />
          </div>

          {/* lang 内容预览 */}
          <div>
            <Typography.Text strong>{t("devtools.exportPreview.langContent")}</Typography.Text>
            <pre
              style={{
                margin: 0,
                padding: 8,
                background: "rgba(0,0,0,0.04)",
                borderRadius: 4,
                fontSize: 12,
                overflowX: "auto",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {preview.lang_content_preview || "(empty)"}
            </pre>
          </div>

          <Typography.Text type="secondary">
            {t("devtools.exportPreview.entries")}: {preview.entry_count}
          </Typography.Text>
        </div>
      )}
      {!preview && (
        <Empty description={t("devtools.exportPreview.noEntries")} />
      )}
    </div>
  );
}

// ── 主面板 ────────────────────────────────────────────────────────────────────
/**
 * 开发者工具窗口内容（渲染在独立第二窗口中，见 src/devtools/DevToolsRoot.tsx）。
 * 独立窗口有自己的 React 实例：主题/语言由 DevToolsRoot 单独接线；
 * Tauri 事件（含 dev-*）是 app 级广播，本窗口能直接收到；
 * invoke 日志由主窗口通过 dev-invoke-log 事件桥接过来。
 */
export function DevToolsWindow() {
  const { t } = useTranslationContext();

  // 订阅 Tauri 事件（挂载即注册，卸载时清理）
  useEffect(() => {
    const unlisten: UnlistenFn[] = [];
    const eventNames = [
      "translate-progress",
      "translation-batch",
      "glossary-done",
      "file-dropped",
      // dev-* events (Phase 3+)
      "dev-http-request",
      "dev-http-response",
      "dev-degradation",
      "dev-retry",
      "dev-batch-start",
      "dev-batch-done",
      "dev-thread-assign",
      "dev-thread-throttle",
    ];
    eventNames.forEach((name) => {
      listen(name, (event) => {
        pushEvent(name, event.payload);
      }).then((un) => unlisten.push(un));
    });
    // 主窗口桥接过来的 invoke 日志
    listen(DEV_INVOKE_LOG, (event) => {
      pushInvokeLocal(event.payload as Omit<InvokeLogEntry, "id" | "timestamp">);
    }).then((un) => unlisten.push(un));
    return () => {
      unlisten.forEach((u) => u());
    };
  }, []);

  const tabItems = useMemo(
    () => [
      { key: "eventStream", label: t("devtools.tab.eventStream"), children: <EventStreamTab /> },
      { key: "invokeLog", label: t("devtools.tab.invokeLog"), children: <InvokeLogTab /> },
      { key: "requestResponse", label: t("devtools.tab.requestResponse"), children: <RequestResponseTab /> },
      { key: "retryChain", label: t("devtools.tab.retryChain"), children: <RetryChainTab /> },
      { key: "threadSchedule", label: t("devtools.tab.threadSchedule"), children: <ThreadScheduleTab /> },
      { key: "injection", label: t("devtools.tab.injection"), children: <InjectionTab /> },
      { key: "parserTestbed", label: t("devtools.tab.parserTestbed"), children: <ParserTestbedTab /> },
      { key: "exportPreview", label: t("devtools.tab.exportPreview"), children: <ExportPreviewTab /> },
    ],
    [t]
  );

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "10px 16px 0" }}>
        <Tabs items={tabItems} size="small" style={{ height: "100%" }} />
      </div>
    </div>
  );
}
