import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { FolderOpenOutlined, SearchOutlined } from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { api, onGameScanProgress } from "../api";
import type { GameDirScan, GamePackEntry, GameVersionGroup, Settings } from "../types";

interface Props {
  settings: Settings;
  onSettingsUpdate: (s: Settings) => void;
  /** 将勾选的内容包解析并注入原有队列（App 实现：解析 + 去重 + 入队 + 跳转） */
  onAddToQueue: (
    packs: {
      path: string;
      fileName: string;
      size: number;
      kind: "mod" | "shader" | "resourcepack";
      gameVersion: string;
    }[],
  ) => Promise<{ added: number; skipped: number }>;
  /** 拖入/选择文件夹时由 App 传入，自动扫描 */
  autoScanDir?: string | null;
  onAutoScanConsumed?: () => void;
}

type Kind = "mod" | "shader" | "resourcepack";

const KIND_LABEL: Record<Kind, string> = { mod: "模组", shader: "光影包", resourcepack: "资源包" };

function packsOf(g: GameVersionGroup, kind: Kind): GamePackEntry[] {
  if (kind === "mod") return g.mods;
  if (kind === "resourcepack") return g.resourcepacks;
  return g.shaderpacks;
}

export function GameDirView({ settings, onSettingsUpdate, onAddToQueue, autoScanDir, onAutoScanConsumed }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [scan, setScan] = useState<GameDirScan | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [scanSummary, setScanSummary] = useState<{ scan: GameDirScan; packTotal: number; dup: number; versions: number } | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const startScanRef = useRef<(dir: string) => Promise<void>>(async () => {});

  // ── 扫描进度事件 ──
  useEffect(() => {
    const un = onGameScanProgress((p) => setProgress(p));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ── 外部触发的自动扫描（导入文件夹时切页并扫描）──
  useEffect(() => {
    if (autoScanDir) {
      void startScanRef.current(autoScanDir);
      onAutoScanConsumed?.();
    }
  }, [autoScanDir]);

  // ── 扫描 ──
  const persistRecent = useCallback(
    (dir: string) => {
      if (!settings) return;
      const list = [dir, ...(settings.recentGameDirs ?? []).filter((d) => d !== dir)].slice(0, 5);
      const next = { ...settings, recentGameDirs: list };
      void api.saveSettings(next).then(() => onSettingsUpdate(next)).catch(() => {});
    },
    [settings, onSettingsUpdate],
  );

  const startScan = useCallback(
    async (dir: string) => {
      setScanning(true);
      setProgress(null);
      try {
        const result = await api.scanGameDir(dir);
        setScan(result);
        setRoot(dir);
        setSelected({});
        setActiveGroup(null);
        persistRecent(dir);
        const dupKeys = new Map<string, number>();
        const reg = (p: GamePackEntry) => {
          const fk = `${p.fileName}|${p.size}`;
          dupKeys.set(fk, (dupKeys.get(fk) ?? 0) + 1);
        };
        for (const p of result.rootGroup.mods) reg(p);
        for (const p of result.rootGroup.resourcepacks) reg(p);
        for (const p of result.rootGroup.shaderpacks) reg(p);
        for (const v of result.versions) {
          for (const p of v.mods) reg(p);
          for (const p of v.resourcepacks) reg(p);
          for (const p of v.shaderpacks) reg(p);
        }
        let dup = 0;
        for (const n of dupKeys.values()) if (n > 1) dup += n - 1;
        const packTotal =
          result.rootGroup.mods.length +
          result.rootGroup.resourcepacks.length +
          result.rootGroup.shaderpacks.length +
          result.versions.reduce(
            (n, v) => n + v.mods.length + v.resourcepacks.length + v.shaderpacks.length,
            0,
          );
        setScanSummary({ scan: result, packTotal, dup, versions: result.versions.length + 1 });
        setSummaryOpen(true);
      } catch (e) {
        if (String(e).includes("已取消")) message.info("已取消扫描");
        else message.error(String(e));
      } finally {
        setScanning(false);
        setProgress(null);
      }
    },
    [settings, persistRecent],
  );
  startScanRef.current = startScan;

  const pickRoot = useCallback(async () => {
    const dir = await open({ directory: true, title: "选择 .minecraft 目录或任意游戏目录（会自动向下扫描）" });
    if (dir && typeof dir === "string") void startScan(dir);
  }, [startScan]);

  // ── 分组与勾选 ──
  interface GroupRow {
    key: string;
    name: string;
    group: GameVersionGroup;
    isRoot: boolean;
  }
  const groups: GroupRow[] = useMemo(() => {
    if (!scan) return [];
    return [
      { key: "__root__", name: "公共目录", group: scan.rootGroup, isRoot: true },
      ...scan.versions.map((v) => ({ key: "v:" + v.dirName, name: v.dirName, group: v, isRoot: false })),
    ];
  }, [scan]);

  const allPacks = useMemo(() => {
    const out: { group: GroupRow; kind: Kind; pack: GamePackEntry }[] = [];
    for (const g of groups) {
      for (const kind of ["mod", "resourcepack", "shader"] as Kind[]) {
        for (const pack of packsOf(g.group, kind)) out.push({ group: g, kind, pack });
      }
    }
    return out;
  }, [groups]);

  const q = search.trim().toLowerCase();
  const filtered = q ? allPacks.filter(({ pack }) => pack.fileName.toLowerCase().includes(q)) : null;

  const selectedCount = Object.values(selected).filter(Boolean).length;

  const selectAll = () => {
    const next: Record<string, boolean> = { ...selected };
    for (const { pack } of filtered ?? allPacks) next[pack.path] = true;
    setSelected(next);
  };
  const selectNone = () => setSelected({});
  const selectKind = (kind: Kind) => {
    const next: Record<string, boolean> = { ...selected };
    for (const { pack } of filtered ?? allPacks) if (pack.kind === kind) next[pack.path] = true;
    setSelected(next);
  };

  // ── 加入队列：交给 App 解析注入（去重 + 带版本标记），完成后 App 跳转自由导入页 ──
  const addToQueue = useCallback(async () => {
    const ids = Object.keys(selected).filter((id) => selected[id]);
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const packs = allPacks
      .filter(({ pack }) => idSet.has(pack.path))
      .map(({ group, kind, pack }) => ({
        path: pack.path,
        fileName: pack.fileName,
        size: pack.size,
        kind: kind as "mod" | "shader" | "resourcepack",
        gameVersion: group.name,
      }));
    setAdding(true);
    try {
      const { added, skipped } = await onAddToQueue(packs);
      message.success(`已加入列表 ${added} 个内容包${skipped > 0 ? `（跳过已在列表 ${skipped} 个）` : ""}`);
      setSelected({});
    } catch (e) {
      message.error(String(e));
    } finally {
      setAdding(false);
    }
  }, [selected, allPacks, onAddToQueue]);

  const activeGroupRow: GroupRow | null = groups.find((g) => g.key === activeGroup) ?? null;
  const activePacks = useMemo(() => {
    if (!activeGroupRow) return null;
    const qq = search.trim().toLowerCase();
    const out: { kind: Kind; pack: GamePackEntry }[] = [];
    for (const kind of ["mod", "resourcepack", "shader"] as Kind[]) {
      for (const pack of packsOf(activeGroupRow.group, kind)) {
        if (qq && !pack.fileName.toLowerCase().includes(qq)) continue;
        out.push({ kind, pack });
      }
    }
    return { group: activeGroupRow, packs: out };
  }, [activeGroupRow, search]);

  function packRow(group: GroupRow, kind: Kind, pack: GamePackEntry, showOrigin: boolean) {
    return (
      <div key={pack.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px" }}>
        <Checkbox checked={!!selected[pack.path]} onChange={(e) => setSelected((prev) => ({ ...prev, [pack.path]: e.target.checked }))} />
        <Typography.Text style={{ flex: 1, minWidth: 0, fontSize: 13 }} ellipsis={{ tooltip: pack.fileName }}>
          {pack.fileName}
        </Typography.Text>
        {showOrigin && (
          <Tag style={{ marginRight: 0 }}>
            {group.name} · {KIND_LABEL[kind]}
          </Tag>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
          {(pack.size / 1024 / 1024).toFixed(2)} MB
        </Typography.Text>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
      {/* 左侧：版本列表 */}
      <div
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid var(--border-color, #E6E8EB)",
          paddingTop: 12,
          overflowY: "auto",
        }}
      >
        <div style={{ padding: "0 12px" }}>
          <Button block icon={<FolderOpenOutlined />} loading={scanning} onClick={() => void pickRoot()}>
            打开游戏目录
          </Button>
          {(settings.recentGameDirs ?? []).length > 0 && (
            <Select
              placeholder="最近目录"
              style={{ width: "100%", marginTop: 8 }}
              value={root ?? undefined}
              options={(settings.recentGameDirs ?? []).map((d) => ({ label: d, value: d }))}
              onChange={(v) => void startScan(v)}
            />
          )}
        </div>
        {scanning && progress && (
          <div style={{ padding: "12px 12px 0" }}>
            <Progress
              percent={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
              size="small"
              format={() => `${progress.done}/${progress.total}`}
            />
            <Button size="small" danger block onClick={() => void api.cancelGameScan()}>
              取消扫描
            </Button>
          </div>
        )}
        {!scan && !scanning && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: "block", padding: "12px 12px 0", lineHeight: 1.7 }}
          >
            选择 .minecraft 目录（或任意游戏目录 / 版本文件夹），自动向下扫描 mods、resourcepacks、shaderpacks
          </Typography.Text>
        )}
        {scan && (
          <div style={{ marginTop: 10 }}>
            {[
              { key: "__root__", name: "公共目录", g: scan.rootGroup },
              ...scan.versions.map((v) => ({ key: "v:" + v.dirName, name: v.dirName, g: v })),
            ].map((row) => {
              return (
                <div
                  key={row.key}
                  onClick={() => {
                    setActiveGroup(row.key);
                    setSearch("");
                  }}
                  style={{
                    padding: "6px 12px",
                    cursor: "pointer",
                    background: activeGroup === row.key ? "var(--slide-indicator-bg)" : "transparent",
                    color: activeGroup === row.key ? "#fff" : "inherit",
                  }}
                >
                  <div style={{ fontWeight: activeGroup === row.key ? 600 : 400 }}>{row.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.8 }}>
                    模组 {row.g.mods.length} · 资源包 {row.g.resourcepacks.length} · 光影 {row.g.shaderpacks.length}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 右侧主区：勾选要汉化的内容包 */}
      <div style={{ flex: 1, minWidth: 0, padding: 12, overflowY: "auto" }}>
        {!scan && !scanning && <Empty description="先在左侧打开并扫描游戏目录" />}
        {scanning && progress && (
          <div style={{ marginBottom: 12 }}>
            <Progress
              percent={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
              format={() => `扫描版本 ${progress.done}/${progress.total}：${progress.current}`}
            />
          </div>
        )}
        {scan && !activeGroup && <Empty description="在左侧选择一个版本查看内容包" />}

        {scan && activeGroupRow && activePacks && (
          <div>
            <Space wrap style={{ marginBottom: 10 }}>
              <Typography.Text strong>
                {activeGroupRow.name}
                {activeGroupRow.group.mcVersion && (
                  <Tag color="blue" style={{ marginLeft: 6 }}>
                    {activeGroupRow.group.mcVersion}
                  </Tag>
                )}
              </Typography.Text>
              <Input
                prefix={<SearchOutlined />}
                placeholder="搜索内容包"
                style={{ width: 220 }}
                allowClear
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button size="small" onClick={selectAll}>
                全选（含跨版本）
              </Button>
              <Button size="small" onClick={selectNone}>
                全不选
              </Button>
              <Button size="small" onClick={() => selectKind("mod")}>
                选所有模组
              </Button>
              <Button size="small" onClick={() => selectKind("resourcepack")}>
                选所有资源包
              </Button>
              <Button size="small" onClick={() => selectKind("shader")}>
                选所有光影包
              </Button>
            </Space>

            {/* 全局：加入列表 */}
            <div style={{ marginBottom: 12 }}>
              <Button
                type="primary"
                icon={<FolderOpenOutlined />}
                loading={adding}
                disabled={selectedCount === 0}
                onClick={() => void addToQueue()}
              >
                解析并加入列表（{selectedCount}）
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 10 }}>
                加入后切到「自由导入」页开始翻译；跨版本重复的包将自动复用译文
              </Typography.Text>
            </div>

            {filtered ? (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                  搜索"{search}"：{filtered.length} 个结果
                </Typography.Text>
                {filtered.length === 0 ? (
                  <Empty description="没有匹配的内容包" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  filtered.map(({ group, kind, pack }) => packRow(group, kind, pack, true))
                )}
              </>
            ) : (
              groups.map((g) => {
                const total = g.group.mods.length + g.group.resourcepacks.length + g.group.shaderpacks.length;
                const all = [...packsOf(g.group, "mod"), ...packsOf(g.group, "resourcepack"), ...packsOf(g.group, "shader")];
                return (
                  <div
                    key={g.key}
                    style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: "6px 10px", marginBottom: 10 }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Checkbox
                        checked={total > 0 && all.every((p) => selected[p.path])}
                        indeterminate={all.some((p) => selected[p.path]) && !all.every((p) => selected[p.path])}
                        onChange={(e) => {
                          const next = { ...selected };
                          for (const p of all) {
                            if (e.target.checked) next[p.path] = true;
                            else delete next[p.path];
                          }
                          setSelected(next);
                        }}
                        disabled={total === 0}
                      />
                      <Typography.Text strong>
                        {g.name}
                        {g.group.mcVersion && <Tag color="blue" style={{ marginLeft: 6 }}>{g.group.mcVersion}</Tag>}
                      </Typography.Text>
                      {!g.isRoot && !g.group.valid && <Tag color="default">无可翻译文本</Tag>}
                      <Tag>模组 {g.group.mods.length}</Tag>
                      <Tag>资源包 {g.group.resourcepacks.length}</Tag>
                      <Tag>光影 {g.group.shaderpacks.length}</Tag>
                    </div>
                    {total === 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        此版本没有内容包
                      </Typography.Text>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* 扫描汇总弹窗 */}
      <Modal
        title="扫描完成"
        open={summaryOpen}
        onCancel={() => setSummaryOpen(false)}
        onOk={() => setSummaryOpen(false)}
        okText="开始选择"
        cancelText="关闭"
        width={520}
      >
        {scanSummary && (
          <>
            <Typography.Paragraph>
              共 {scanSummary.versions} 个分组（含公共目录）、<b>{scanSummary.packTotal}</b> 个内容包。
              {scanSummary.dup > 0 && (
                <>
                  <br />
                  跨版本重复 {scanSummary.dup} 个（同名同大小），翻译时将自动复用译文。
                </>
              )}
            </Typography.Paragraph>
            {(settings.threading?.enabled ?? false) && (settings.batchSizeAuto ?? true) && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                提示：已开启「跟随线程数最优条数」，条目较少的包批次会偏小，可能影响翻译质量；可在翻译参数中调整。
              </Typography.Paragraph>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
