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
  Tooltip,
  Typography,
  message,
} from "antd";
import { CheckSquareOutlined, CloseOutlined, CloseSquareOutlined, DownOutlined, ImportOutlined, ReloadOutlined, RightOutlined, SearchOutlined } from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslationContext } from "../i18n";
// hook 在组件内使用
import { api, onGameScanProgress } from "../api";
import { KIND_META, KIND_ORDER, MODE_ICON, type PackKind } from "../kindMeta";
import { useSlideIndicator } from "./SlideNav";
import { dropScanCache, getScanCache, putScanCache } from "../gameDirScanCache";
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

type Kind = PackKind;

const KIND_LABEL_KEY: Record<Kind, string> = {
  mod: "gamedir.kindMod",
  shader: "gamedir.kindShader",
  resourcepack: "gamedir.kindRp",
  plugin: "gamedir.kindPlugin",
};

/**
 * 分类小标题：图标 + 文案（数字后缀由调用处拼）。
 * 图标取自全局唯一的 KIND_META —— 与侧栏导航、内容包卡片标签同源，
 * 同一个类型在哪个页面都不该长成两副样子。
 *
 * 无字模式下只留图标：名称与数量一起收起，名称改由图标的 hover 承担。
 * 这一行是"某个版本的内容包分类"，勾选框在左、图标在右，收掉文字后
 * 正好剩一条干净的分类勾选列表。
 */
function KindHeading({ kind, suffix, iconOnly }: { kind: Kind; suffix?: string; iconOnly?: boolean }) {
  const { t } = useTranslationContext();
  const name = t(KIND_LABEL_KEY[kind]);
  const icon = (
    <span style={{ color: KIND_META[kind].color, display: "inline-flex", fontSize: 13 }}>
      {KIND_META[kind].icon}
    </span>
  );
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {iconOnly ? <Tooltip title={name}>{icon}</Tooltip> : icon}
      <span className="io-hide">
        {name}
        {suffix ?? ""}
      </span>
    </span>
  );
}

function packsOf(g: GameVersionGroup, kind: Kind): GamePackEntry[] {
  if (kind === "mod") return g.mods;
  if (kind === "plugin") return g.plugins;
  if (kind === "resourcepack") return g.resourcepacks;
  return g.shaderpacks;
}

function groupAllPacks(g: GameVersionGroup): GamePackEntry[] {
  return [...g.mods, ...g.resourcepacks, ...g.shaderpacks, ...g.plugins];
}

/**
 * 扫描时刻 → 界面文案。同一天给 "HH:MM"；不是同一天补上 "M-D HH:MM"。
 *
 * 缓存落盘之后结果可能**跨天存活**（这正是它的目的）—— 只显示 "14:52" 的话，
 * 三天前的结果和五分钟前的结果长得一模一样，用户就没法判断该不该点「重新扫描」。
 */
function fmtScanTime(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

export function GameDirView({ settings, onSettingsUpdate, addProgress, onAddToQueue, autoScanDir, onAutoScanConsumed }: Props) {
  const { t } = useTranslationContext();
  /** 无字模式：这一页的按钮与分类行只留图标（作用域见 App.css 的 .gd-io） */
  const iconOnly = settings.iconOnly ?? false;
  const [root, setRoot] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [scan, setScan] = useState<GameDirScan | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [scanSummary, setScanSummary] = useState<{ scan: GameDirScan; packTotal: number; dup: number; versions: number } | null>(null);
  /** 当前结果来源：命中缓存 / 本次实测，以及扫描时刻（界面提示用） */
  const [scanMeta, setScanMeta] = useState<{ fromCache: boolean; scannedAt: number } | null>(null);
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
  // 最近目录：正在播离场动画的项（存路径），动画结束才真正移除
  const [leavingRecent, setLeavingRecent] = useState<string[]>([]);

  // 版本列表共享滑动指示器：与左侧「内容包类型」导航复用同一套逻辑，
  // 消掉原先选中项 background 的硬切（见 App.css 的 .gd-ver-list / .gd-ver-row）
  const verRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const verIndRef = useRef<HTMLSpanElement>(null);
  useSlideIndicator(activeGroup, verRowRefs, verIndRef);

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
      void api
        .patchSettings({ recentGameDirs: list })
        .then(() => onSettingsUpdate(next))
        .catch(() => {});
    },
    [settings, onSettingsUpdate],
  );

  /**
   * 真正移除最近目录。由行上的离场动画结束时调用（不是点击当帧）：
   * 若删的正好是当前扫描目录，右侧主区也会一起变空，先播完离场再统一重置，
   * 免得左边还在滑出、右边已经开始播空态动画，两处动效打架。
   * 同时丢弃该目录的扫描缓存：条目都没了，留着也没入口，白占内存。
   */
  const removeRecent = useCallback(
    (dir: string) => {
      const list = (settings.recentGameDirs ?? []).filter((x) => x !== dir);
      onSettingsUpdate({ ...settings, recentGameDirs: list });
      dropScanCache(dir);
      if (root === dir) {
        setScan(null);
        setScanMeta(null);
        setRoot(null);
        setSelected({});
        setActiveGroup(null);
      }
    },
    [settings, onSettingsUpdate, root],
  );

  /** 把一份扫描结果落到界面状态上——新扫与命中缓存共用同一条落地路径 */
  const applyScan = useCallback(
    (dir: string, result: GameDirScan, fromCache: boolean, scannedAt: number) => {
      setScan(result);
      setRoot(dir);
      setSelected({});
      setScanMeta({ fromCache, scannedAt });
      // 自动选中第一个有内容包的分组，主界面立即有内容
      const first = result.groups.find((g) => groupAllPacks(g).length > 0);
      setActiveGroup(first ? "g:" + first.relPath : null);
      persistRecent(dir);
    },
    [persistRecent],
  );

  const startScan = useCallback(
    async (dir: string, force = false) => {
      // 命中缓存：瞬时恢复，不重跑扫描、不弹「扫描完成」汇总
      // （那是一份一次性报告，切目录时反复弹出反而碍事；时间与来源在左栏有常驻提示）
      if (!force) {
        const hit = getScanCache(dir);
        if (hit) {
          applyScan(dir, hit.scan, true, hit.scannedAt);
          setScanSummary({
            scan: hit.scan,
            packTotal: hit.packTotal,
            dup: hit.dup,
            versions: hit.scan.groups.length,
          });
          return;
        }
      }
      setScanning(true);
      setProgress(null);
      try {
        const result = await api.scanGameDir(dir);
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
        const scannedAt = Date.now();
        // 先写缓存再落界面，保证「界面上看到的那份」就是缓存里存的那份
        putScanCache(dir, { scan: result, packTotal, dup, scannedAt });
        applyScan(dir, result, false, scannedAt);
        setScanSummary({ scan: result, packTotal, dup, versions: result.groups.length });
        setSummaryOpen(true);
      } catch (e) {
        // 重新扫描失败或被取消时，旧结果与旧缓存都保留，右侧不会闪成空态
        if (String(e).includes("已取消")) message.info(t("gamedir.cancel"));
        else message.error(String(e));
      } finally {
        setScanning(false);
        setProgress(null);
      }
    },
    [applyScan, t],
  );
  startScanRef.current = startScan;

  /** 忽略缓存重扫当前目录 */
  const rescan = useCallback(() => {
    if (root) void startScan(root, true);
  }, [root, startScan]);

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
      for (const kind of KIND_ORDER) {
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
    for (const kind of KIND_ORDER) {
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
      const kinds: Kind[] = selPanel === "all" ? KIND_ORDER : [selPanel as Kind];
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
    for (const k of KIND_ORDER.slice(0, 3)) {
      if (packsOf(activeGroupRow.group, k).length > 0) return k;
    }
    return null;
  }, [activeGroupRow]);

  // 面板第一个分组的 key（用于默认展开）
  const firstPanelGroupKey = panelGroups.length > 0 ? panelGroups[0].key : null;

  return (
    /* gd-io：无字模式下这一页的按钮/分类行只留图标（App.css 里按这个类收窄）。
       挂在根节点上覆盖整页，规则内部再用 :has(> .ui-label) 限定到"文字可折叠"的按钮。 */
    <div className="gd-io" style={{ display: "flex", minHeight: 0, flex: 1 }}>
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
          {/* 「打开目录」与「重新扫描」同一行：重扫只作用于当前目录，和"把目录选进来"
              是同一个语义单元；放这个面板里也最顺——目录就是从这儿选的。
              不用 Space.Compact：它的紧凑圆角是靠 clone Button 子元素实现的，
              中间夹一层 Tooltip 就认不出 Button 了，圆角会还原成两个独立按钮。 */}
          <div style={{ display: "flex", gap: 6 }}>
            {/* 无字模式下只留图标：文字包进 .ui-label 交给 .gd-io 规则收窄，
                按钮本身再靠 .gd-open-btn 松开 flex:1（否则会拉成一条空长条）。
                这里用 title={iconOnly ? … : undefined} 而不是包一层 span ——
                Button 上的 flex:1 得让它自己继续当 flex item 才生效。 */}
            <Tooltip title={iconOnly ? t("gamedir.open") : undefined}>
              <Button
                className="gd-open-btn"
                icon={MODE_ICON.gamedir}
                loading={scanning}
                onClick={() => void pickRoot()}
                style={{ flex: 1, minWidth: 0 }}
              >
                <span className="ui-label">{t("gamedir.open")}</span>
              </Button>
            </Tooltip>
            <Tooltip title={t("gamedir.rescanTip")}>
              <Button
                className="gd-rescan-btn"
                icon={<ReloadOutlined />}
                disabled={!root || scanning}
                onClick={rescan}
                style={{ flexShrink: 0 }}
              />
            </Tooltip>
          </div>
          {(settings.recentGameDirs ?? []).length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {(settings.recentGameDirs ?? []).map((d) => {
                const leaving = leavingRecent.includes(d);
                return (
                <div
                  key={d}
                  className={`anim-list-item anim-collapse${leaving ? " is-leaving" : ""}`}
                >
                <div
                  className={leaving ? "anim-item-slide-out" : undefined}
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
                  onAnimationEnd={(e) => {
                    // 入场动画同样会冒泡 animationend：只认离场关键帧
                    if (e.target !== e.currentTarget || e.animationName !== "motion-slide-out") return;
                    setLeavingRecent((s) => s.filter((x) => x !== d));
                    removeRecent(d);
                  }}
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
                      // 只标记离场；真正的移除交给 onAnimationEnd
                      setLeavingRecent((s) => (s.includes(d) ? s : [...s, d]));
                    }}
                  />
                </div>
                </div>
                );
              })}
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
          /* 无字模式：这段"怎么选目录"的引导灰字整块收起（左栏本来就窄，
             它一折行就占掉三行高度）。常规模式一字不动。 */
          <Typography.Text
            type="secondary"
            className="io-hide"
            style={{ fontSize: 12, display: "block", padding: "12px 12px 0", lineHeight: 1.7 }}
          >
            {t("gamedir.scanHint")}
          </Typography.Text>
        )}
        {scan && (
          <>
            {/* 常驻提示当前结果的来源与时间：命中缓存时明确标出来，
                用户才知道"这份不是刚扫的"、以及该不该点重新扫描 */}
            {scanMeta && (
              <div style={{ padding: "10px 12px 0", display: "flex", alignItems: "center", gap: 4 }}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {t("gamedir.scannedAt", { time: fmtScanTime(scanMeta.scannedAt) })}
                </Typography.Text>
                {scanMeta.fromCache && (
                  <Tag style={{ marginRight: 0, fontSize: 10, lineHeight: "15px", padding: "0 4px" }}>
                    {t("gamedir.cacheTag")}
                  </Tag>
                )}
              </div>
            )}
          <div style={{ marginTop: 10 }} className="gd-ver-list">
            {/* 共享元素指示器：选中态由"行背景硬切"改为整块滑动 + 伸缩。
                没有可对齐的行时隐藏（避免留下一个错位的蓝块）。 */}
            <span
              ref={verIndRef}
              className="slide-nav-indicator"
              style={{ visibility: activeGroupRow ? "visible" : "hidden" }}
            />
            {groups.map((row) => {
              const gp = groupAllPacks(row.group);
              const allSel = gp.length > 0 && gp.every((p) => selected[p.path]);
              const someSel = gp.some((p) => selected[p.path]) && !allSel;
              return (
                <div
                  key={row.key}
                  ref={(el) => {
                    verRowRefs.current[row.key] = el;
                  }}
                  onClick={() => {
                    setActiveGroup(row.key);
                    setSearch("");
                  }}
                  className={`gd-ver-row${activeGroup === row.key ? " active" : ""}`}
                  style={{
                    padding: "6px 12px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
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
          </>
        )}
      </div>

      {/* 右侧主区：勾选要汉化的内容包 */}
      <div
        key={"m:" + (activeGroup ?? "none")}
        className="gd-main-anim"
        style={{ flex: 1, minWidth: 0, padding: 12, overflowY: "auto" }}
      >
        {/* 空态那句灰字同样只在常规模式出现。传 **null** 而不是 undefined：
            antd 的判据是 `typeof description !== "undefined" ? description : locale.description`，
            传 undefined 会退回默认的「暂无数据」，传 null 才真的不渲染那个描述 div（连边距一起省掉）。 */}
        {!scan && !scanning && <Empty description={iconOnly ? null : t("gamedir.scanHint")} />}
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
            {/* 不用再加动效类：父级 .gd-main-anim 已按 activeGroup 重挂载带动画，
                叠加会变成"父块滑入 + 子块再滑一次"的双层动画 */}
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
                placeholder={t("gamedir.search")}
                style={{ width: 220 }}
                allowClear
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {/* 「全选 / 全不选」原本是纯文字按钮 —— 无字模式下没有图标可留，
                  所以给它补一个图标（勾选框）。这也是这一页里"为了能无字化"
                  而新增图标的唯一一处：其余按钮本来就有图标。 */}
              {(() => {
                const allSel = allPacks.length > 0 && allPacks.every((p) => selected[p.pack.path]);
                const label = allSel ? t("gamedir.btnNone") : t("gamedir.btnAll");
                return (
                  <Tooltip title={iconOnly ? label : undefined}>
                    <Button
                      size="small"
                      icon={allSel ? <CloseSquareOutlined /> : <CheckSquareOutlined />}
                      onClick={() => {
                        if (allSel) setSelected({});
                        else selectAll();
                      }}
                    >
                      <span className="ui-label">{label}</span>
                    </Button>
                  </Tooltip>
                );
              })()}
              {KIND_ORDER.map((k) => (
                <Tooltip key={k} title={iconOnly ? t(KIND_LABEL_KEY[k]) : undefined}>
                  <Button
                    size="small"
                    icon={KIND_META[k].icon}
                    type={selPanel === k ? "primary" : "default"}
                    onClick={() => {
                      setSelPanel((prev) => (prev === k ? null : k));
                    }}
                  >
                    <span className="ui-label">{t(KIND_LABEL_KEY[k])}</span>
                  </Button>
                </Tooltip>
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
              {(() => {
                const btn = (
                  <Button
                    type="primary"
                    icon={<ImportOutlined />}
                    loading={adding}
                    disabled={selectedCount === 0}
                    onClick={() => void addToQueue()}
                  >
                    {t("gamedir.addToQueue", { n: selectedCount })}
                  </Button>
                );
                return iconOnly ? (
                  /* 无字模式下右边的灰字说明收起，内容改挂这里。外面那层 span 是必需的：
                     没勾任何包时按钮是禁用态，而 <button disabled> 不派发 mouse 事件，
                     Tooltip 直接挂在按钮上会静默失效。 */
                  <Tooltip title={t("gamedir.addToQueueTip")}>
                    <span style={{ display: "inline-flex" }}>{btn}</span>
                  </Tooltip>
                ) : (
                  btn
                );
              })()}
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 10 }} className="io-hide">
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
                KIND_ORDER.map((kind) => {
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
                          <KindHeading kind={k} suffix={`（${list.length}）`} iconOnly={iconOnly} />
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
