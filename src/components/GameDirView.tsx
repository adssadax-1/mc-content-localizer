import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Progress,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { FolderOpenOutlined, SearchOutlined, CloseOutlined, DownOutlined, RightOutlined } from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslationContext } from "../i18n";
// hook 在组件内使用
import { api, onGameScanProgress } from "../api";
import type { GameDirScan, GamePackEntry, GameVersionGroup, Settings } from "../types";

interface Props {
  settings: Settings;
  onSettingsUpdate: (s: Settings) => void;
  /** 「解析并加入列表」的解析进度（App 注入循环回传） */
  addProgress?: { done: number; total: number; current: string } | null;
  /** 将勾选的内容包解析并注入原有队列（App 实现：解析 + 去重 + 入队 + 跳转） */
  onAddToQueue: (
    packs: {
      path: string;
      fileName: string;
      size: number;
      kind: "mod" | "shader" | "resourcepack" | "plugin";
      gameVersion: string;
    }[],
  ) => Promise<{ added: number; skipped: number }>;
  /** 拖入/选择文件夹时由 App 传入，自动扫描 */
  autoScanDir?: string | null;
  onAutoScanConsumed?: () => void;
}

type Kind = "mod" | "shader" | "resourcepack" | "plugin";

const KIND_LABEL_KEY: Record<Kind, string> = {
  mod: "gamedir.kindMod",
  shader: "gamedir.kindShader",
  resourcepack: "gamedir.kindRp",
  plugin: "gamedir.kindPlugin",
};

function packsOf(g: GameVersionGroup, kind: Kind): GamePackEntry[] {
  if (kind === "mod") return g.mods;
  if (kind === "plugin") return g.plugins;
  if (kind === "resourcepack") return g.resourcepacks;
  return g.shaderpacks;
}

function groupAllPacks(g: GameVersionGroup): GamePackEntry[] {
  return [...g.mods, ...g.resourcepacks, ...g.shaderpacks, ...g.plugins];
}

export function GameDirView({ settings, onSettingsUpdate, addProgress, onAddToQueue, autoScanDir, onAutoScanConsumed }: Props) {
  const { t } = useTranslationContext();
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
  // 展开式选择面板：null 关闭 / "all" 全部版本 / 具体类别
  const [selPanel, setSelPanel] = useState<null | "all" | Kind>(null);
  // 折叠状态：版本详情页分类（key = "activeGroup:kind"）
  const [catExpanded, setCatExpanded] = useState<Record<string, boolean>>({});
  // 折叠状态：面板版本分组（key = panel group key）
  const [panelGroupExpanded, setPanelGroupExpanded] = useState<Record<string, boolean>>({});

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
        let packTotal = 0;
        for (const g of result.groups) {
          for (const p of groupAllPacks(g)) {
            reg(p);
            packTotal += 1;
          }
        }
        let dup = 0;
        for (const n of dupKeys.values()) if (n > 1) dup += n - 1;
        setScanSummary({ scan: result, packTotal, dup, versions: result.groups.length });
        // 自动选中第一个有内容包的分组，主界面立即有内容
        const first = result.groups.find((g) => groupAllPacks(g).length > 0);
        setActiveGroup(first ? "g:" + first.relPath : null);
        setSummaryOpen(true);
      } catch (e) {
        if (String(e).includes("已取消")) message.info(t("gamedir.cancel"));
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
    const dir = await open({ directory: true, title: t("gamedir.pickTitle") });
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
    const seen = new Map<string, number>();
    return scan.groups.map((g) => {
      let name = g.relPath === "" ? t("gamedir.publicDir") : g.dirName;
      const c = seen.get(name) ?? 0;
      seen.set(name, c + 1);
      if (c > 0) name = `${name} (${c + 1})`;
      return { key: "g:" + g.relPath, name, group: g, isRoot: g.relPath === "" };
    });
  }, [scan]);

  const allPacks = useMemo(() => {
    const out: { group: GroupRow; kind: Kind; pack: GamePackEntry }[] = [];
    for (const g of groups) {
      for (const kind of ["mod", "resourcepack", "shader", "plugin"] as Kind[]) {
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
      message.success(skipped > 0 ? t("gamedir.addedSkipped", { n: added, m: skipped }) : t("gamedir.added", { n: added }));
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
    for (const kind of ["mod", "resourcepack", "shader", "plugin"] as Kind[]) {
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
            {group.name} · {t(KIND_LABEL_KEY[kind])}
          </Tag>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
          {(pack.size / 1024 / 1024).toFixed(2)} MB
        </Typography.Text>
      </div>
    );
  }

  // 展开式选择面板：面板范围内的包（按版本分组）
  const panelScope = useMemo(() => {
    if (!selPanel) return [];
    const out: { group: GroupRow; kind: Kind; pack: GamePackEntry }[] = [];
    for (const g of groups) {
      const kinds: Kind[] = selPanel === "all" ? ["mod", "resourcepack", "shader", "plugin"] : [selPanel as Kind];
      for (const kind of kinds) {
        for (const pack of packsOf(g.group, kind)) out.push({ group: g, kind, pack });
      }
    }
    return out;
  }, [selPanel, groups]);
  const panelGroups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; packs: GamePackEntry[] }>();
    for (const row of panelScope) {
      if (!m.has(row.group.key)) m.set(row.group.key, { key: row.group.key, name: row.group.name, packs: [] });
      m.get(row.group.key)!.packs.push(row.pack);
    }
    return [...m.values()];
  }, [panelScope]);

  // 当前版本第一个有内容的分类（用于默认展开）
  const firstNonEmptyKind = useMemo<Kind | null>(() => {
    if (!activeGroupRow) return null;
    for (const k of ["mod", "resourcepack", "shader"] as Kind[]) {
      if (packsOf(activeGroupRow.group, k).length > 0) return k;
    }
    return null;
  }, [activeGroupRow]);

  // 面板第一个分组的 key（用于默认展开）
  const firstPanelGroupKey = panelGroups.length > 0 ? panelGroups[0].key : null;

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
            {t("gamedir.open")}
          </Button>
          {(settings.recentGameDirs ?? []).length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {(settings.recentGameDirs ?? []).map((d) => (
                <div
                  key={d}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 4px",
                    borderRadius: 4,
                    cursor: "pointer",
                    background: root === d ? "var(--ant-color-fill-secondary)" : undefined,
                  }}
                  onClick={() => void startScan(d)}
                >
                  <Typography.Text
                    ellipsis
                    style={{ fontSize: 12, flex: 1, minWidth: 0 }}
                    title={d}
                  >
                    {d.split(/[\\/]/).pop() ?? d}
                  </Typography.Text>
                  <Button
                    type="text"
                    size="small"
                    icon={<CloseOutlined />}
                    style={{ flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const list = (settings.recentGameDirs ?? []).filter((x) => x !== d);
                      onSettingsUpdate({ ...settings, recentGameDirs: list });
                      if (root === d) {
                        setScan(null);
                        setRoot(null);
                        setSelected({});
                        setActiveGroup(null);
                      }
                    }}
                  />
                </div>
              ))}
            </div>
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
              {t("gamedir.cancel")}
            </Button>
          </div>
        )}
        {!scan && !scanning && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: "block", padding: "12px 12px 0", lineHeight: 1.7 }}
          >
            {t("gamedir.scanHint")}
          </Typography.Text>
        )}
        {scan && (
          <div style={{ marginTop: 10 }} className="panel-anim">
            {groups.map((row) => {
              const gp = groupAllPacks(row.group);
              const allSel = gp.length > 0 && gp.every((p) => selected[p.path]);
              const someSel = gp.some((p) => selected[p.path]) && !allSel;
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
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: activeGroup === row.key ? "var(--slide-indicator-bg)" : "transparent",
                    color: activeGroup === row.key ? "#fff" : "inherit",
                  }}
                >
                  <Checkbox
                    checked={allSel}
                    indeterminate={someSel}
                    style={{ flexShrink: 0 }}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const next = { ...selected };
                      if (e.target.checked) for (const p of gp) next[p.path] = true;
                      else for (const p of gp) delete next[p.path];
                      setSelected(next);
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: activeGroup === row.key ? 600 : 400 }}>{row.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.8 }}>
                      {t("gamedir.counts", { mods: row.group.mods.length, rp: row.group.resourcepacks.length, sp: row.group.shaderpacks.length, plug: row.group.plugins.length })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 右侧主区：勾选要汉化的内容包 */}
      <div
        key={"m:" + (activeGroup ?? "none")}
        className="gd-main-anim"
        style={{ flex: 1, minWidth: 0, padding: 12, overflowY: "auto" }}
      >
        {!scan && !scanning && <Empty description={t("gamedir.scanHint")} />}
        {scanning && progress && (
          <div style={{ marginBottom: 12 }}>
            <Progress
              percent={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
              format={() => t("gamedir.scanVersionProgress", { done: progress.done, total: progress.total, current: progress.current })}
            />
          </div>
        )}
        {scan && !activeGroup && <Empty description={t("gamedir.pickVersion")} />}

        {scan && activeGroupRow && activePacks && (
          <div>
            <Space wrap style={{ marginBottom: 10 }} className="panel-anim">
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
                placeholder={t("gamedir.search")}
                style={{ width: 220 }}
                allowClear
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button size="small" onClick={() => {
                const allSel = allPacks.length > 0 && allPacks.every((p) => selected[p.pack.path]);
                if (allSel) setSelected({});
                else selectAll();
              }}>
                {(allPacks.length > 0 && allPacks.every((p) => selected[p.pack.path])) ? t("gamedir.btnNone") : t("gamedir.btnAll")}
              </Button>
              {(["mod", "resourcepack", "shader", "plugin"] as Kind[]).map((k) => (
                <Button
                  key={k}
                  size="small"
                  type={selPanel === k ? "primary" : "default"}
                  onClick={() => {
                    setSelPanel((prev) => (prev === k ? null : k));
                  }}
                >
                  {t(KIND_LABEL_KEY[k])}
                </Button>
              ))}
            </Space>

            {/* 展开式选择面板：按版本分组的勾选列表，勾选即时生效 */}
            {selPanel && (
              <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>
                <Space style={{ marginBottom: 6 }} wrap>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    {selPanel === "all" ? t("gamedir.panelAllTitle") : `${t(KIND_LABEL_KEY[selPanel as Kind])} · ${t("gamedir.panelByVersion")}`}
                  </Typography.Text>
                  <Button size="small" onClick={() => {
                    const panelAllPacks = panelGroups.flatMap((row) => row.packs);
                    const allSel = panelAllPacks.length > 0 && panelAllPacks.every((p) => selected[p.path]);
                    const next = { ...selected };
                    if (allSel) for (const p of panelAllPacks) delete next[p.path];
                    else for (const p of panelAllPacks) next[p.path] = true;
                    setSelected(next);
                  }}>
                    {(() => {
                      const panelAllPacks = panelGroups.flatMap((row) => row.packs);
                      return panelAllPacks.length > 0 && panelAllPacks.every((p) => selected[p.path])
                        ? t("gamedir.panelUncheckAll")
                        : t("gamedir.panelCheckAll");
                    })()}
                  </Button>
                </Space>
                {panelGroups.length === 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("gamedir.noPacks")}
                  </Typography.Text>
                )}
                {panelGroups.map((g) => {
                  const allSel = g.packs.length > 0 && g.packs.every((p) => selected[p.path]);
                  const someSel = g.packs.some((p) => selected[p.path]) && !allSel;
                  const isExpanded = panelGroupExpanded[g.key] ?? (g.key === firstPanelGroupKey);
                  return (
                    <div key={g.key} style={{ marginBottom: 8 }}>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "2px 0" }}
                        onClick={() => setPanelGroupExpanded((prev) => ({ ...prev, [g.key]: !isExpanded }))}
                      >
                        <Checkbox
                          checked={allSel}
                          indeterminate={someSel}
                          style={{ flexShrink: 0 }}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const next = { ...selected };
                            if (e.target.checked) for (const p of g.packs) next[p.path] = true;
                            else for (const p of g.packs) delete next[p.path];
                            setSelected(next);
                          }}
                        />
                        <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                          {g.name}（{g.packs.length}）
                        </Typography.Text>
                        {isExpanded ? <DownOutlined style={{ fontSize: 10, color: "var(--ant-color-text-secondary)" }} /> : <RightOutlined style={{ fontSize: 10, color: "var(--ant-color-text-secondary)" }} />}
                      </div>
                      {isExpanded && g.packs.map((pack) => (
                        <div key={pack.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 8px" }}>
                          <Checkbox checked={!!selected[pack.path]} onChange={(e) => setSelected((prev) => ({ ...prev, [pack.path]: e.target.checked }))} />
                          <Typography.Text style={{ flex: 1, minWidth: 0, fontSize: 12 }} ellipsis={{ tooltip: pack.fileName }}>
                            {pack.fileName}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                            {(pack.size / 1024 / 1024).toFixed(2)} MB
                          </Typography.Text>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 全局：加入列表 */}
            <div style={{ marginBottom: 12 }}>
              <Button
                type="primary"
                icon={<FolderOpenOutlined />}
                loading={adding}
                disabled={selectedCount === 0}
                onClick={() => void addToQueue()}
              >
                {t("gamedir.addToQueue", { n: selectedCount })}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 10 }}>
                {t("gamedir.addToQueueHint")}
              </Typography.Text>
              {addProgress && (
                <Typography.Text style={{ fontSize: 12 }}>
                  {t("gamedir.addProgress", { done: addProgress.done, total: addProgress.total, current: addProgress.current })}
                </Typography.Text>
              )}
            </div>

            {filtered ? (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                  {t("gamedir.searchResult", { q: search, n: filtered.length })}
                </Typography.Text>
                {filtered.length === 0 ? (
                  <Empty description={t("gamedir.noMatch")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  filtered.map(({ group, kind, pack }) => packRow(group, kind, pack, true))
                )}
              </>
            ) : (
              activePacks.packs.length === 0 ? (
                <Empty description={t("gamedir.noPacks")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                ["mod", "resourcepack", "shader", "plugin"].map((kind) => {
                  const k = kind as Kind;
                  const list = activePacks.packs.filter((p) => p.kind === k);
                  if (list.length === 0) return null;
                  const catKey = `${activeGroup}:${k}`;
                  const isExpanded = catExpanded[catKey] ?? (k === firstNonEmptyKind);
                  const allSel = list.every(({ pack }) => selected[pack.path]);
                  const someSel = list.some(({ pack }) => selected[pack.path]) && !allSel;
                  return (
                    <div key={kind} style={{ marginBottom: 16 }}>
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "2px 0", marginBottom: 4 }}
                        onClick={() => setCatExpanded((prev) => ({ ...prev, [catKey]: !isExpanded }))}
                      >
                        <Checkbox
                          checked={allSel}
                          indeterminate={someSel}
                          style={{ flexShrink: 0 }}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const next = { ...selected };
                            if (e.target.checked) for (const { pack } of list) next[pack.path] = true;
                            else for (const { pack } of list) delete next[pack.path];
                            setSelected(next);
                          }}
                        />
                        <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                          {t(KIND_LABEL_KEY[k])}（{list.length}）
                        </Typography.Text>
                        {isExpanded ? <DownOutlined style={{ fontSize: 10, color: "var(--ant-color-text-secondary)" }} /> : <RightOutlined style={{ fontSize: 10, color: "var(--ant-color-text-secondary)" }} />}
                      </div>
                      {isExpanded && list.map(({ pack }) => packRow(activeGroupRow, k, pack, false))}
                    </div>
                  );
                })
              )
            )}
          </div>
        )}
      </div>

      {/* 扫描汇总弹窗 */}
      <Modal
        title={t("gamedir.scanDone")}
        open={summaryOpen}
        onCancel={() => setSummaryOpen(false)}
        onOk={() => setSummaryOpen(false)}
        okText={t("gamedir.startSelect")}
        cancelText={t("gamedir.close")}
        width={520}
      >
        {scanSummary && (
          <>
            <Typography.Paragraph>
              {t("gamedir.groups", { n: scanSummary.versions })}、<b>{t("gamedir.packs", { n: scanSummary.packTotal })}</b>。
              {scanSummary.dup > 0 && (
                <>
                  <br />
                  {t("gamedir.dup", { n: scanSummary.dup })}
                </>
              )}
            </Typography.Paragraph>
            {(settings.threading?.enabled ?? false) && (settings.batchSizeAuto ?? true) && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                {t("gamedir.batchHint")}
              </Typography.Paragraph>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
