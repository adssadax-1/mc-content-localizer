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
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  ExportOutlined,
  FolderOpenOutlined,
  SearchOutlined,
  TranslationOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { api, onGameScanProgress, onTranslationBatch, onTranslateProgress } from "../api";
import type {
  GameDirScan,
  GamePackEntry,
  GameVersionGroup,
  LangEntry,
  Settings,
} from "../types";
import { LOADER_LABEL, packFormatForMc } from "../types";
import type { PackItem } from "../App";

interface Props {
  settings: Settings;
  onSettingsUpdate: (s: Settings) => void;
  /** 外部（拖入/选择文件夹）请求自动扫描的目录；消费后由 App 置回 null */
  autoScanDir?: string | null;
  onAutoScanConsumed?: () => void;
  /** App 提供：用自由导入同款 PackCard 渲染内容包详情（全功能 EntryTable） */
  renderPackCard: (
    item: PackItem,
    handlers: GamePackHandlers,
    opts: { thisTranslating: boolean; packProgress?: { done: number; total: number } },
  ) => React.ReactNode;
}

type Kind = "mod" | "shader" | "resourcepack";

export interface GamePackHandlers {
  onToggleExpanded: (key: string) => void;
  onToggleChecked: (key: string, v: boolean) => void;
  onEdit: (packKey: string, entryKey: string, value: string) => void;
  onSelect: (key: string) => void;
  onClear: (packKey: string, entryKey: string) => void;
  onToggleSelected: (packKey: string, entryKey: string, sel: boolean) => void;
  onToggleAllSelected: (packKey: string, sel: boolean) => void;
  onToggleManySelected: (packKey: string, keys: string[], sel: boolean) => void;
  onResize: (key: string, e: React.MouseEvent) => void;
}

interface ParsedPack {
  kind: Kind;
  modName: string;
  modid: string;
  mcVersion: string | null;
  loader: string;
  entries: LangEntry[];
}

interface PackCount {
  ok: number;
  empty: number;
  error: number;
  error429: number;
  warn: number;
  reused: number;
}

const KIND_LABEL: Record<Kind, string> = { mod: "模组", shader: "光影包", resourcepack: "资源包" };

function packsOf(g: GameVersionGroup, kind: Kind): GamePackEntry[] {
  if (kind === "mod") return g.mods;
  if (kind === "resourcepack") return g.resourcepacks;
  return g.shaderpacks;
}

const fileKey = (p: GamePackEntry) => `${p.fileName}|${p.size}`;

export function GameDirView({ settings, onSettingsUpdate, autoScanDir, onAutoScanConsumed, renderPackCard }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [scan, setScan] = useState<GameDirScan | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [scanSummary, setScanSummary] = useState<{ scan: GameDirScan; packTotal: number; dup: number } | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Record<string, ParsedPack>>({});
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [packError, setPackError] = useState<Record<string, string>>({});
  const [packCounts, setPackCounts] = useState<Record<string, PackCount>>({});
  const [translated, setTranslated] = useState<Record<string, Record<string, string>>>({});
  const [translatingKeys, setTranslatingKeys] = useState<Record<string, boolean>>({});
  const [packProgress, setPackProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [reportOpen, setReportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportJars, setExportJars] = useState(false);
  const [reuseCount, setReuseCount] = useState<Record<string, number>>({});
  void reuseCount;

  const reuseRef = useRef<Map<string, Record<string, string>>>(new Map());
  const gamedirKeysRef = useRef<Set<string>>(new Set());
  const countsRef = useRef<Record<string, PackCount>>({});
  const translatedRef = useRef<Record<string, Record<string, string>>>({});
  const fileKeysRef = useRef<Record<string, string>>({});
  const startScanRef = useRef<(dir: string) => Promise<void>>(async () => {});

  // ── 事件监听 ──
  useEffect(() => {
    const un = onGameScanProgress((p) => setProgress(p));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const un = onTranslationBatch(({ packKey, items }) => {
      if (!gamedirKeysRef.current.has(packKey)) return;
      const c =
        countsRef.current[packKey] ??
        { ok: 0, empty: 0, error: 0, error429: 0, warn: 0, reused: 0 };
      for (const r of items) {
        if (r.kind === "error") {
          c.error += 1;
          if (r.notes.some((n) => n.includes("429"))) c.error429 += 1;
        } else if (r.kind === "empty") {
          c.empty += 1;
        } else {
          c.ok += 1;
          if (r.notes.length > 0) c.warn += 1;
        }
        if (r.translation) {
          const tr = (translatedRef.current[packKey] ??= {});
          tr[r.key] = r.translation;
        }
      }
      countsRef.current[packKey] = c;
      setPackCounts({ ...countsRef.current });
      setTranslated({ ...translatedRef.current });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const un = onTranslateProgress((p) => {
      if (p.packKey && translatingKeys[p.packKey]) {
        setPackProgress((prev) => ({
          ...prev,
          [p.packKey as string]: { done: p.doneCount, total: p.totalCount },
        }));
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [translatingKeys]);

  // 外部触发的自动扫描（导入文件夹时切页并扫描）
  useEffect(() => {
    if (autoScanDir) {
      void startScanRef.current(autoScanDir);
      onAutoScanConsumed?.();
    }
  }, [autoScanDir]);

  // ── 会话缓存恢复（gamedir 独立缓存）──
  useEffect(() => {
    api
      .loadSessionCache("gamedir")
      .then((raw) => {
        if (!raw) return;
        try {
          const data = JSON.parse(raw) as {
            root?: string;
            scan?: GameDirScan;
            selected?: Record<string, boolean>;
            translated?: Record<string, Record<string, string>>;
            packCounts?: Record<string, PackCount>;
            fileKeys?: Record<string, string>;
          };
          if (!data.scan || !data.root) return;
          Modal.confirm({
            title: "恢复上次的扫描结果？",
            content: `检测到游戏目录「${data.root}」的扫描与翻译进度（${Object.keys(data.translated ?? {}).length} 个包已有译文），是否恢复？`,
            okText: "恢复",
            cancelText: "不恢复",
            onOk: () => {
              setRoot(data.root!);
              setScan(data.scan!);
              setSelected(data.selected ?? {});
              setTranslated(data.translated ?? {});
              translatedRef.current = data.translated ?? {};
              countsRef.current = data.packCounts ?? {};
              setPackCounts(data.packCounts ?? {});
              fileKeysRef.current = data.fileKeys ?? {};
              for (const [id, tr] of Object.entries(data.translated ?? {})) {
                const fk = (data.fileKeys ?? {})[id];
                if (!fk) continue;
                const store = reuseRef.current.get(fk) ?? {};
                for (const [k, v] of Object.entries(tr)) store[k] = v;
                reuseRef.current.set(fk, store);
              }
              message.success("已恢复上次的扫描与翻译进度");
            },
            onCancel: () => void api.clearSessionCache("gamedir"),
          });
        } catch {
          void api.clearSessionCache("gamedir");
        }
      })
      .catch(() => {});
  }, []);

  // ── 会话缓存防抖保存 ──
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!scan || !root) return;
      void api
        .saveSessionCache(
          "gamedir",
          JSON.stringify({
            version: 1,
            root,
            scan,
            selected,
            translated: translatedRef.current,
            packCounts: countsRef.current,
            fileKeys: fileKeysRef.current,
          }),
        )
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [scan, root, selected, translated]);

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
        setParsed({});
        setTranslated({});
        translatedRef.current = {};
        countsRef.current = {};
        setPackCounts({});
        setDetailId(null);
        setActiveGroupKey(null);
        gamedirKeysRef.current.clear();
        fileKeysRef.current = {};
        persistRecent(dir);
        const dupKeys = new Map<string, number>();
        const reg = (p: GamePackEntry) => {
          const fk = fileKey(p);
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
        setScanSummary({ scan: result, packTotal, dup });
        setSummaryOpen(true);
      } catch (e) {
        if (String(e).includes("已取消")) message.info("已取消扫描");
        else message.error(String(e));
      } finally {
        setScanning(false);
        setProgress(null);
      }
    },
    [persistRecent],
  );
  startScanRef.current = startScan;

  const pickRoot = useCallback(async () => {
    const dir = await open({ directory: true, title: "选择 .minecraft 目录或任意游戏目录（会自动向下扫描）" });
    if (dir && typeof dir === "string") void startScan(dir);
  }, [startScan]);

  // ── 分组与 displayId ──
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
      ...scan.versions.map((v) => ({ key: "v:" + v.dirName, name: v.dirName ?? v.dirName, group: v, isRoot: false })),
    ];
  }, [scan]);

  const dispId = (g: GroupRow, kind: Kind, pack: GamePackEntry) =>
    `${g.name}·${KIND_LABEL[kind]}·${pack.fileName}`;

  const packByDisp = useMemo(() => {
    const m = new Map<string, { pack: GamePackEntry; group: GroupRow; kind: Kind }>();
    for (const g of groups) {
      for (const kind of ["mod", "resourcepack", "shader"] as Kind[]) {
        for (const pack of packsOf(g.group, kind)) {
          const id = dispId(g, kind, pack);
          fileKeysRef.current[id] = fileKey(pack);
          m.set(id, { pack, group: g, kind });
        }
      }
    }
    return m;
  }, [groups]);

  const selectedIds = useMemo(
    () => new Set(Object.keys(selected).filter((id) => selected[id] && packByDisp.has(id))),
    [selected, packByDisp],
  );


  // ── 懒解析 ──
  const ensureParsed = useCallback(
    async (id: string): Promise<ParsedPack | null> => {
      const cached = parsed[id];
      if (cached) return cached;
      const hit = packByDisp.get(id);
      if (!hit || parsingId) return null;
      setParsingId(id);
      const { pack, group, kind } = hit;
      try {
        let data: ParsedPack;
        if (kind === "mod") {
          const mf = await api.parseJar(pack.path);
          data = {
            kind: "mod",
            modName: mf.modName,
            modid: mf.modid,
            mcVersion: group.group.mcVersion ?? mf.mcVersion,
            loader: mf.loader,
            entries: mf.entries,
          };
        } else if (kind === "shader") {
          const sp = await api.parseShaderPack(pack.path);
          data = {
            kind: "shader",
            modName: sp.name,
            modid: "shader",
            mcVersion: group.group.mcVersion,
            loader: "unknown",
            entries: sp.entries,
          };
        } else {
          const rp = await api.parseResourcePack(pack.path);
          data = {
            kind: "resourcepack",
            modName: rp.name,
            modid: "resourcepack",
            mcVersion: group.group.mcVersion,
            loader: "unknown",
            entries: rp.entries,
          };
        }
        // 跨版本复用：同名同大小的包直接填入已有译文
        const reuse = reuseRef.current.get(fileKey(pack)) ?? {};
        let reused = 0;
        if (Object.keys(reuse).length > 0) {
          data.entries = data.entries.map((e) => {
            const r = reuse[e.key];
            if (r && !e.translation) {
              reused += 1;
              return { ...e, translation: r, status: "aiTranslated" as const, notes: ["跨版本复用译文"] };
            }
            return e;
          });
        }
        setParsed((prev) => ({ ...prev, [id]: data }));
        if (reused > 0) setReuseCount((prev) => ({ ...prev, [id]: reused }));
        return data;
      } catch (e) {
        setPackError((prev) => ({ ...prev, [id]: String(e) }));
        return null;
      } finally {
        setParsingId(null);
      }
    },
    [parsed, parsingId, packByDisp],
  );

  // ── 翻译（并行池）──
  const translateIds = useCallback(
    async (ids: string[]) => {
      if (!settings || ids.length === 0) return;
      const provider = {
        ...settings.provider,
        temperature:
          settings.provider.temperature == null
            ? 0.7
            : Math.round(settings.provider.temperature * 100) / 100,
      };
      interface Task {
        id: string;
        ctx: Parameters<typeof api.runTranslation>[1];
        items: { key: string; source: string }[];
        batchN: number;
      }
      const tasks: Task[] = [];
      for (const id of ids) {
        const hit = packByDisp.get(id);
        const data = parsed[id];
        if (!hit || !data || packError[id]) continue;
        const reuse = reuseRef.current.get(fileKey(hit.pack)) ?? {};
        const entries = data.entries.map((e) => {
          const r = reuse[e.key];
          if (r && !e.translation) {
            return { ...e, translation: r, status: "aiTranslated" as const, notes: ["跨版本复用译文"] };
          }
          return e;
        });
        const untranslated = entries.filter((e) => (e.selected ?? true) && !e.translation);
        if (untranslated.length === 0) continue;
        tasks.push({
          id,
          ctx: {
            modName: data.modName,
            modid: data.modid,
            mcVersion: data.mcVersion,
            loader: LOADER_LABEL[data.loader as keyof typeof LOADER_LABEL] ?? "未知",
            packType: hit.kind,
            customPrompt: settings.customPrompts?.[hit.kind] ?? null,
            userGlossary: settings.userGlossary,
          },
          items: untranslated.map((e) => ({ key: e.key, source: e.source })),
          batchN: untranslated.length,
        });
      }
      if (tasks.length === 0) {
        message.info("勾选的内容包没有需要翻译的条目（可能已全部翻译或复用译文）");
        return;
      }
      for (const t of tasks) {
        gamedirKeysRef.current.add(t.id);
        countsRef.current[t.id] ??= { ok: 0, empty: 0, error: 0, error429: 0, warn: 0, reused: 0 };
        setTranslatingKeys((prev) => ({ ...prev, [t.id]: true }));
        setPackProgress((prev) => ({ ...prev, [t.id]: { done: 0, total: t.batchN } }));
      }
      const threads = settings.threading?.enabled ? settings.threading.threadCount : 1;
      const packLimit = (settings.packParallelEnabled ?? false)
        ? (settings.packParallelCount ?? 2) === 0
          ? Infinity
          : Math.max(1, settings.packParallelCount ?? 2)
        : 1;
      let nextIdx = 0;
      const worker = async (): Promise<void> => {
        while (nextIdx < tasks.length) {
          const t = tasks[nextIdx++];
          const effectiveBatch =
            settings.batchSizeAuto ?? true
              ? Math.max(1, Math.ceil(t.items.length / threads))
              : settings.batchSize;
          try {
            await api.runTranslation(
              provider,
              t.ctx,
              t.items,
              t.id,
              effectiveBatch,
              settings.extractGlossary,
              settings.threading,
              t.id, // packLabel：开发者工具显示 版本·类别·包名
            );
          } catch (e) {
            const c = (countsRef.current[t.id] ??= { ok: 0, empty: 0, error: 0, error429: 0, warn: 0, reused: 0 });
            c.error += t.items.length;
            countsRef.current[t.id] = c;
            setPackError((prev) => ({ ...prev, [t.id]: String(e) }));
          } finally {
            setTranslatingKeys((prev) => {
              const next = { ...prev };
              delete next[t.id];
              return next;
            });
            setPackCounts({ ...countsRef.current });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(packLimit, tasks.length) }, () => worker()));
      setReportOpen(true);
    },
    [settings, packByDisp, parsed, packError],
  );

  const retryFailed = useCallback(() => {
    const failed = Object.entries(packCounts)
      .filter(([, c]) => c.error > 0)
      .map(([id]) => id);
    if (failed.length === 0) return;
    for (const id of failed) {
      const c = countsRef.current[id];
      if (c) {
        c.error = 0;
        c.error429 = 0;
      }
    }
    countsRef.current = { ...countsRef.current };
    setPackCounts({ ...countsRef.current });
    setReportOpen(false);
    void translateIds(failed);
  }, [packCounts, translateIds]);

  // ── 导出 ──
  const exportSelected = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const destRoot = await open({ directory: true, title: "选择导出根目录（将按版本建立子文件夹）" });
    if (!destRoot || typeof destRoot !== "string") return;
    setExporting(true);
    let okVersions = 0;
    try {
      const byGroup = new Map<string, { name: string; group: GroupRow; ids: string[] }>();
      for (const id of ids) {
        const hit = packByDisp.get(id);
        if (!hit) continue;
        const gk = hit.group.key;
        if (!byGroup.has(gk)) byGroup.set(gk, { name: hit.group.name, group: hit.group, ids: [] });
        byGroup.get(gk)!.ids.push(id);
      }
      for (const [, { name, group, ids: gIds }] of byGroup) {
        const verDir = `${destRoot}/${name}`;
        const bundles: Parameters<typeof api.exportResourcePackMulti>[1] = [];
        for (const id of gIds) {
          const hit = packByDisp.get(id);
          const data = parsed[id];
          const tr = translated[id] ?? {};
          if (!hit || !data) continue;
          const entries = data.entries
            .map((e) => ({ ...e, translation: tr[e.key] ?? e.translation }))
            .filter((e) => e.translation && e.translation.trim() !== "");
          if (hit.kind === "mod" && entries.length > 0) {
            bundles.push({ modid: data.modid, modName: data.modName, entries, langFormat: "json" });
          }
          if (hit.kind === "shader" && entries.length > 0) {
            const dest = `${verDir}/光影包/${hit.pack.fileName.replace(/\.zip$/i, "")}_zh_CN.zip`;
            await api.exportShaderZh(hit.pack.path, dest, entries);
          }
          if (hit.kind === "resourcepack" && entries.length > 0) {
            const dest = `${verDir}/资源包/${hit.pack.fileName.replace(/\.zip$/i, "")}_改描述.zip`;
            await api.exportResourcePackDesc(hit.pack.path, dest, entries);
          }
          if (hit.kind === "mod" && exportJars && entries.length > 0) {
            await api.exportModJar(hit.pack.path, `${verDir}/汉化jar`, data.modid, entries, "json");
          }
        }
        if (bundles.length > 0) {
          await api.exportResourcePackMulti(verDir, bundles, packFormatForMc(group.group.mcVersion) ?? 15);
        }
        okVersions += 1;
      }
      message.success(`已导出 ${okVersions} 个版本的汉化内容到所选目录`);
    } catch (e) {
      message.error(`导出失败：${String(e)}`);
    } finally {
      setExporting(false);
    }
  }, [selectedIds, packByDisp, parsed, translated, exportJars]);

  // ── 渲染辅助 ──
  const statusTag = (id: string) => {
    if (translatingKeys[id]) {
      const p = packProgress[id];
      return (
        <Tag color="processing" className="dev-pulse-tag">
          翻译中 {p ? `${p.done}/${p.total}` : ""}
        </Tag>
      );
    }
    const c = packCounts[id];
    if (packError[id]) {
      return (
        <Tooltip title={packError[id]}>
          <Tag color="red">失败</Tag>
        </Tooltip>
      );
    }
    if (c && (c.ok > 0 || c.reused > 0)) {
      return (
        <Tag color="green">
          完成 {c.ok + c.reused} 条{c.reused > 0 ? `（复用 ${c.reused}）` : ""}
          {c.empty > 0 ? ` · 未返回 ${c.empty}` : ""}
        </Tag>
      );
    }
    return <Tag>未翻译</Tag>;
  };

  const activeGroupRow: GroupRow | null = groups.find((g) => g.key === activeGroupKey) ?? null;

  const activePacks = useMemo(() => {
    if (!activeGroupRow) return null;
    const q = search.trim().toLowerCase();
    const out: { kind: Kind; pack: GamePackEntry }[] = [];
    for (const kind of ["mod", "resourcepack", "shader"] as Kind[]) {
      for (const pack of packsOf(activeGroupRow.group, kind)) {
        if (q && !pack.fileName.toLowerCase().includes(q)) continue;
        out.push({ kind, pack });
      }
    }
    return { group: activeGroupRow, packs: out };
  }, [activeGroupRow, search]);

  const translatingCount = Object.keys(translatingKeys).length;
  const detailData = detailId ? parsed[detailId] : null;
  const detailHit = detailId ? packByDisp.get(detailId) : null;

  const buildDetailItem = (): PackItem | null => {
    if (!detailId || !detailData || !detailHit) return null;
    const tr = translated[detailId] ?? {};
    return {
      key: detailId,
      kind: detailData.kind,
      name: detailHit.pack.fileName,
      fileName: detailHit.pack.fileName,
      sourcePath: detailHit.pack.path,
      expanded: true,
      checked: selectedIds.has(detailId),
      height: 480,
      entries: detailData.entries.map((e) => ({ ...e, translation: tr[e.key] ?? e.translation })),
      modFile: {
        fileName: detailHit.pack.fileName,
        modName: detailData.modName,
        modid: detailData.modid,
        version: null,
        loader: (detailData.loader as "forge" | "fabric" | "neoForge" | "quilt" | "unknown") ?? "unknown",
        mcVersion: detailData.mcVersion,
        langFormat: "json",
        entries: detailData.entries,
      },
      langFormat: "json",
      hasZh: false,
      zhCount: 0,
    };
  };

  const detailHandlers: GamePackHandlers = {
    onToggleExpanded: () => setDetailId(null), // 收起 = 返回列表
    onToggleChecked: (id, v) => setSelected((prev) => ({ ...prev, [id]: v })),
    onEdit: (id, key, v) => {
      setTranslated((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: v } }));
      translatedRef.current[id] = { ...(translatedRef.current[id] ?? {}), [key]: v };
    },
    onSelect: () => {},
    onClear: (id, key) => {
      setTranslated((prev) => {
        const inner = { ...(prev[id] ?? {}) };
        delete inner[key];
        return { ...prev, [id]: inner };
      });
      const tr = (translatedRef.current[id] ??= {});
      delete tr[key];
    },
    onToggleSelected: (id, key, sel) => {
      setParsed((prev) => {
        const d = prev[id];
        if (!d) return prev;
        return { ...prev, [id]: { ...d, entries: d.entries.map((e) => (e.key === key ? { ...e, selected: sel } : e)) } };
      });
    },
    onToggleAllSelected: (id, sel) => {
      setParsed((prev) => {
        const d = prev[id];
        if (!d) return prev;
        return { ...prev, [id]: { ...d, entries: d.entries.map((e) => ({ ...e, selected: sel })) } };
      });
    },
    onToggleManySelected: (id, keys, sel) => {
      setParsed((prev) => {
        const d = prev[id];
        if (!d) return prev;
        const ks = new Set(keys);
        return { ...prev, [id]: { ...d, entries: d.entries.map((e) => (ks.has(e.key) ? { ...e, selected: sel } : e)) } };
      });
    },
    onResize: () => {},
  };

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
            ].map((row) => (
              <div
                key={row.key}
                onClick={() => {
                  setActiveGroupKey(row.key);
                  setDetailId(null);
                }}
                style={{
                  padding: "6px 12px",
                  cursor: "pointer",
                  background: activeGroupKey === row.key ? "var(--slide-indicator-bg)" : "transparent",
                  color: activeGroupKey === row.key ? "#fff" : "inherit",
                }}
              >
                <div style={{ fontWeight: activeGroupKey === row.key ? 600 : 400 }}>{row.name}</div>
                <div style={{ fontSize: 11, opacity: 0.8 }}>
                  模组 {row.g.mods.length} · 资源包 {row.g.resourcepacks.length} · 光影 {row.g.shaderpacks.length}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右侧主区 */}
      <div style={{ flex: 1, minWidth: 0, padding: 12, overflowY: "auto" }}>
        {!scan && !scanning && <Empty description="先在左侧打开并扫描游戏目录" />}
        {scanning && !progress && <Spin style={{ display: "block", margin: "60px auto" }} />}
        {scan && !activeGroupRow && <Empty description="在左侧选择一个版本查看内容包" />}

        {scan && activeGroupRow && activePacks && !detailId && (
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
              <Button
                size="small"
                onClick={() => {
                  const next = { ...selected };
                  for (const { pack } of activePacks.packs)
                    next[dispId(activeGroupRow, pack.kind, pack)] = true;
                  setSelected(next);
                }}
              >
                全选本版本
              </Button>
              <Button size="small" onClick={() => setSelected({})}>
                全不选
              </Button>
              <Button
                type="primary"
                size="small"
                icon={<TranslationOutlined />}
                disabled={selectedIds.size === 0}
                loading={translatingCount > 0}
                onClick={() => {
                  const ids = activePacks.packs
                    .map((p) => dispId(activeGroupRow, p.kind, p.pack))
                    .filter((id) => selectedIds.has(id));
                  void translateIds(ids);
                }}
              >
                翻译本版本勾选项
              </Button>
              <Button
                size="small"
                icon={<ExportOutlined />}
                loading={exporting}
                disabled={selectedIds.size === 0 || translatingCount > 0}
                onClick={() => void exportSelected()}
              >
                导出勾选项
              </Button>
              <Checkbox
                checked={exportJars}
                onChange={(e) => setExportJars(e.target.checked)}
              >
                同时导出单个汉化 jar
              </Checkbox>
            </Space>
            {activePacks.packs.length === 0 ? (
              <Empty description="此版本没有内容包" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              ["mod", "resourcepack", "shader"].map((kind) => {
                const list = activePacks.packs.filter((p) => p.kind === (kind as Kind));
                if (list.length === 0) return null;
                return (
                  <div key={kind} style={{ marginBottom: 14 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {KIND_LABEL[kind as Kind]}（{list.length}）
                    </Typography.Text>
                    {list.map(({ pack }) => {
                      const kindK = kind as Kind;
                      const id = dispId(activeGroupRow, kindK, pack);
                      return (
                        <div key={pack.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" }}>
                          <Checkbox
                            checked={selectedIds.has(id)}
                            onChange={(e) => setSelected((prev) => ({ ...prev, [id]: e.target.checked }))}
                          />
                          <Typography.Text
                            style={{ cursor: "pointer", flex: 1, minWidth: 0, fontSize: 13 }}
                            ellipsis={{ tooltip: pack.fileName }}
                            onClick={() => {
                              setDetailId(id);
                              void ensureParsed(id);
                            }}
                          >
                            {pack.fileName}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                            {(pack.size / 1024 / 1024).toFixed(2)} MB
                          </Typography.Text>
                          {statusTag(id)}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        )}

        {detailId && (
          <div>
            <Space wrap style={{ marginBottom: 8 }} align="center">
              <Button onClick={() => setDetailId(null)}>← 返回列表</Button>
              <Typography.Text strong>{detailHit?.pack.fileName}</Typography.Text>
              <Tag color="blue">{activeGroupRow?.name}</Tag>
              {statusTag(detailId)}
              <Button
                type="primary"
                size="small"
                icon={<TranslationOutlined />}
                loading={!!translatingKeys[detailId]}
                onClick={() => void translateIds([detailId])}
              >
                翻译此包
              </Button>
            </Space>
            {packError[detailId] && (
              <Typography.Paragraph type="danger">{packError[detailId]}</Typography.Paragraph>
            )}
            {!detailData && <Spin style={{ display: "block", margin: "40px auto" }} />}
            {detailData && detailHit && (
              <div>
                {renderPackCard(
                  buildDetailItem()!,
                  detailHandlers,
                  { thisTranslating: !!translatingKeys[detailId], packProgress: packProgress[detailId] },
                )}
              </div>
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
              共 {scanSummary.scan.versions.length + 1} 个分组（含公共目录）、
              <b>{scanSummary.packTotal}</b> 个内容包。
              {scanSummary.dup > 0 && (
                <>
                  <br />
                  跨版本重复 {scanSummary.dup} 个（同名同大小），翻译时将自动复用译文。
                </>
              )}
            </Typography.Paragraph>
            {(settings.threading?.enabled ?? false) && (settings.batchSizeAuto ?? true) && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                提示：已开启「跟随线程数最优条数」，条目较少的包批次会偏小，可能影响翻译质量；
                可在翻译参数中调整。
              </Typography.Paragraph>
            )}
          </>
        )}
      </Modal>

      {/* 翻译报告弹窗 */}
      <Modal
        title="翻译报告"
        open={reportOpen}
        onCancel={() => setReportOpen(false)}
        footer={[
          Object.entries(packCounts).some(([, c]) => c.error > 0) && (
            <Button key="retry" onClick={retryFailed}>
              重试失败项
            </Button>
          ),
          <Button key="close" type="primary" onClick={() => setReportOpen(false)}>
            关闭
          </Button>,
        ]}
        width={560}
      >
        {Object.keys(packCounts).length === 0 ? (
          <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {Object.entries(packCounts).map(([id, c]) => {
              const err = packError[id];
              return (
                <div key={id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <Typography.Text style={{ flex: 1, minWidth: 0, fontSize: 12 }} ellipsis={{ tooltip: id }}>
                    {id}
                  </Typography.Text>
                  {statusTag(id)}
                  <Tag color="green" style={{ marginRight: 0 }}>
                    {c.ok + c.reused} 条
                  </Tag>
                  {err && (
                    <Typography.Text type="danger" style={{ fontSize: 11 }}>
                      {err.slice(0, 60)}
                    </Typography.Text>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    </div>
  );
}
