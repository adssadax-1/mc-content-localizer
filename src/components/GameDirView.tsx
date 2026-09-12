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
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  ExportOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
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
  LangFormat,
  ResourcePackBundle,
  Settings,
} from "../types";
import { LOADER_LABEL, packFormatForMc } from "../types";
import { EntryTable } from "./EntryTable";

interface Props {
  settings: Settings;
  onSettingsUpdate: (s: Settings) => void;
}

type Kind = "mod" | "shader" | "resourcepack";

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

export function GameDirView({ settings, onSettingsUpdate }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [scan, setScan] = useState<GameDirScan | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedPack, setExpandedPack] = useState<string | null>(null);
  const [parsingPack, setParsingPack] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Record<string, ParsedPack>>({});
  const [packError, setPackError] = useState<Record<string, string>>({});
  const [reuseCount, setReuseCount] = useState<Record<string, number>>({});
  void reuseCount;
  const [packCounts, setPackCounts] = useState<Record<string, PackCount>>({});
  const [translated, setTranslated] = useState<Record<string, Record<string, string>>>({});
  const [translatingKeys, setTranslatingKeys] = useState<Record<string, boolean>>({});
  const [packProgress, setPackProgress] = useState<Record<string, { done: number; total: number }>>({});
  const [reportOpen, setReportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportJars, setExportJars] = useState(false);
  void setExportJars;

  const reuseRef = useRef<Map<string, Record<string, string>>>(new Map());
  const gamedirKeysRef = useRef<Set<string>>(new Set());
  const countsRef = useRef<Record<string, PackCount>>({});
  const translatedRef = useRef<Record<string, Record<string, string>>>({});
  const restoringRef = useRef(false);

  // ── 扫描进度事件 ──
  useEffect(() => {
    const un = onGameScanProgress((p) => setProgress(p));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ── 批次实时事件：按包累计计数与译文 ──
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

  // ── 翻译进度事件 ──
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

  // ── 会话缓存（gamedir）：恢复询问 ──
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
          };
          if (!data.scan || !data.root) return;
          Modal.confirm({
            title: "恢复上次的扫描结果？",
            content: `检测到游戏目录「${data.root}」的扫描与翻译进度（${Object.keys(data.translated ?? {}).length} 个包已有译文），是否恢复？`,
            okText: "恢复",
            cancelText: "不恢复",
            onOk: () => {
              restoringRef.current = true;
              setRoot(data.root!);
              setScan(data.scan!);
              setSelected(data.selected ?? {});
              setTranslated(data.translated ?? {});
              translatedRef.current = data.translated ?? {};
              countsRef.current = data.packCounts ?? {};
              setPackCounts(data.packCounts ?? {});
              // 重建跨版本复用表
              for (const [path, tr] of Object.entries(data.translated ?? {})) {
                const pack = findPack(data.scan!, path);
                if (!pack) continue;
                const fk = fileKey(pack);
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

  // ── 会话缓存：防抖保存 ──
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
        setReuseCount({});
        setExpanded({});
        setExpandedPack(null);
        persistRecent(dir);
        const packTotal =
          result.rootGroup.mods.length +
          result.rootGroup.resourcepacks.length +
          result.rootGroup.shaderpacks.length +
          result.versions.reduce(
            (n, v) => n + v.mods.length + v.resourcepacks.length + v.shaderpacks.length,
            0,
          );
        setSummaryOpen(true);
        setScanSummary({ scan: result, packTotal });
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
  const [scanSummary, setScanSummary] = useState<{ scan: GameDirScan; packTotal: number } | null>(null);

  const pickRoot = useCallback(async () => {
    const dir = await open({ directory: true, title: "选择 .minecraft 目录或任意游戏目录（会自动向下扫描）" });
    if (dir && typeof dir === "string") void startScan(dir);
  }, [startScan]);

  // ── 分组与筛选 ──
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return allPacks.filter(({ pack }) => pack.fileName.toLowerCase().includes(q));
  }, [allPacks, search]);

  const dupFileKeys = useMemo(() => {
    const m = new Map<string, number>();
    for (const { pack } of allPacks) {
      const fk = fileKey(pack);
      m.set(fk, (m.get(fk) ?? 0) + 1);
    }
    let dup = 0;
    for (const n of m.values()) if (n > 1) dup += n - 1;
    return dup;
  }, [allPacks]);

  const donePacks = Object.entries(packCounts).filter(([, c]) => c.ok + c.reused > 0).length;
  const failedPaths = Object.entries(packCounts)
    .filter(([, c]) => c.error > 0)
    .map(([p]) => p);
  const translatingCount = Object.keys(translatingKeys).length;

  // ── 勾选与批量操作 ──
  const setSel = (path: string, v: boolean) => setSelected((prev) => ({ ...prev, [path]: v }));
  const selectAllFiltered = () => {
    const list = filtered ?? allPacks;
    const next = { ...selected };
    for (const { pack } of list) next[pack.path] = true;
    setSelected(next);
  };
  const selectNone = () => setSelected({});
  const selectKind = (kind: Kind) => {
    const list = filtered ?? allPacks;
    const next = { ...selected };
    for (const { pack } of list) if (pack.kind === kind) next[pack.path] = true;
    setSelected(next);
  };
  const selectUntranslated = () => {
    const next: Record<string, boolean> = {};
    for (const { pack } of allPacks) {
      const tr = translated[pack.path] ?? {};
      const data = parsed[pack.path];
      const hasTr = data && data.entries.some((e) => tr[e.key]);
      if (!data || !hasTr) next[pack.path] = true;
    }
    setSelected(next);
    message.info("提示：未展开解析过的包会一并勾选，翻译时自动解析");
  };

  // ── 懒解析 ──
  const ensureParsed = useCallback(
    async (pack: GamePackEntry, group: GroupRow): Promise<ParsedPack | null> => {
      const cached = parsed[pack.path];
      if (cached) return cached;
      if (parsingPack) return null;
      setParsingPack(pack.path);
      try {
        let data: ParsedPack;
        if (pack.kind === "mod") {
          const mf = await api.parseJar(pack.path);
          data = {
            kind: "mod",
            modName: mf.modName,
            modid: mf.modid,
            mcVersion: group.group.mcVersion ?? mf.mcVersion,
            loader: mf.loader,
            entries: mf.entries,
          };
        } else if (pack.kind === "shader") {
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
        setParsed((prev) => ({ ...prev, [pack.path]: data }));
        if (reused > 0) setReuseCount((prev) => ({ ...prev, [pack.path]: reused }));
        return data;
      } catch (e) {
        setPackError((prev) => ({ ...prev, [pack.path]: String(e) }));
        return null;
      } finally {
        setParsingPack(null);
      }
    },
    [parsed, parsingPack],
  );

  const togglePackDetail = (pack: GamePackEntry, group: GroupRow) => {
    if (expandedPack === pack.path) {
      setExpandedPack(null);
      return;
    }
    setExpandedPack(pack.path);
    void ensureParsed(pack, group);
  };

  // ── 翻译（并行池，复用 free 模式机制）──
  const translateSelected = useCallback(async () => {
    if (!settings) return;
    const targets = allPacks.filter(({ pack }) => selected[pack.path]);
    if (targets.length === 0) {
      message.info("请先勾选内容包");
      return;
    }
    const provider = {
      ...settings.provider,
      temperature:
        settings.provider.temperature == null
          ? 0.7
          : Math.round(settings.provider.temperature * 100) / 100,
    };
    // 确保全部已解析（懒解析：翻译时才读语言文件）
    for (const { pack, group } of targets) {
      await ensureParsed(pack, group);
    }
    interface Task {
      path: string;
      name: string;
      kind: Kind;
      ctx: Parameters<typeof api.runTranslation>[1];
      items: { key: string; source: string }[];
      batchN: number;
    }
    const tasks: Task[] = [];
    for (const { pack, group, kind } of targets) {
      const data = parsed[pack.path];
      if (!data || packError[pack.path]) continue;
      const reuse = reuseRef.current.get(fileKey(pack)) ?? {};
      const entries = data.entries.map((e) => {
        const tr = reuse[e.key];
        if (tr && !e.translation) {
          return { ...e, translation: tr, status: "aiTranslated" as const, notes: ["跨版本复用译文"] };
        }
        return e;
      });
      const untranslated = entries.filter((e) => (e.selected ?? true) && !e.translation);
      if (untranslated.length === 0) continue;
      tasks.push({
        path: pack.path,
        name: pack.fileName,
        kind,
        ctx: {
          modName: data.modName,
          modid: data.modid,
          mcVersion: group.group.mcVersion ?? data.mcVersion,
          loader: LOADER_LABEL[data.loader as keyof typeof LOADER_LABEL] ?? "未知",
          packType: kind,
          customPrompt: settings.customPrompts?.[kind] ?? null,
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
    // 初始化计数与翻译中状态
    for (const t of tasks) {
      gamedirKeysRef.current.add(t.path);
      countsRef.current[t.path] ??= { ok: 0, empty: 0, error: 0, error429: 0, warn: 0, reused: 0 };
      setTranslatingKeys((prev) => ({ ...prev, [t.path]: true }));
      setPackProgress((prev) => ({ ...prev, [t.path]: { done: 0, total: t.batchN } }));
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
            t.path,
            effectiveBatch,
            settings.extractGlossary,
            settings.threading,
          );
        } catch (e) {
          const c = (countsRef.current[t.path] ??= { ok: 0, empty: 0, error: 0, error429: 0, warn: 0, reused: 0 });
          c.error += t.items.length;
          countsRef.current[t.path] = c;
          setPackError((prev) => ({ ...prev, [t.path]: String(e) }));
        } finally {
          setTranslatingKeys((prev) => {
            const next = { ...prev };
            delete next[t.path];
            return next;
          });
          setPackCounts({ ...countsRef.current });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(packLimit, tasks.length) }, () => worker()));
    setReportOpen(true);
  }, [settings, allPacks, selected, parsed, packError, ensureParsed]);

  // ── 重试失败项 ──
  const retryFailed = useCallback(() => {
    const failed = Object.entries(packCounts)
      .filter(([, c]) => c.error > 0)
      .map(([p]) => p);
    if (failed.length === 0) return;
    const next: Record<string, boolean> = {};
    for (const p of failed) next[p] = true;
    for (const p of failed) {
      const c = countsRef.current[p];
      if (c) {
        c.error = 0;
        c.error429 = 0;
      }
    }
    countsRef.current = { ...countsRef.current };
    setPackCounts({ ...countsRef.current });
    setSelected(next);
    setReportOpen(false);
    message.info(`已重置 ${failed.length} 个失败包，重新点击「开始翻译勾选项」重试`);
  }, [packCounts]);

  // ── 导出：一个根目录 / 版本子文件夹 / 版本内合并资源包 + 光影 + 资源包 ──
  const exportSelected = useCallback(async () => {
    const targets = allPacks.filter(({ pack }) => selected[pack.path]);
    if (targets.length === 0) {
      message.info("请先勾选内容包");
      return;
    }
    const destRoot = await open({ directory: true, title: "选择导出根目录（将按版本建立子文件夹）" });
    if (!destRoot || typeof destRoot !== "string") return;
    setExporting(true);
    let okVersions = 0;
    try {
      const byGroup = new Map<string, { name: string; group: GroupRow; packs: typeof targets }>();
      for (const t of targets) {
        const key = t.group.key;
        if (!byGroup.has(key)) byGroup.set(key, { name: t.group.name, group: t.group, packs: [] });
        byGroup.get(key)!.packs.push(t);
      }
      for (const [, { name, group, packs }] of byGroup) {
        const verDir = `${destRoot}/${name}`;
        // 模组：合并导出一个资源包
        const bundles: ResourcePackBundle[] = [];
        for (const { pack, kind } of packs) {
          if (kind !== "mod") continue;
          const data = parsed[pack.path];
          const tr = translated[pack.path] ?? {};
          const entries = (data?.entries ?? [])
            .map((e) => ({ ...e, translation: tr[e.key] ?? e.translation }))
            .filter((e) => e.translation && e.translation.trim() !== "");
          if (entries.length === 0) continue;
          bundles.push({
            modid: data?.modid || pack.fileName.replace(/\.jar$/i, ""),
            modName: data?.modName || pack.fileName,
            entries,
            langFormat: "json" as LangFormat,
          });
        }
        const fmt = packFormatForMc(group.group.mcVersion) ?? 15;
        if (bundles.length > 0) {
          await api.exportResourcePackMulti(verDir, bundles, fmt);
        }
        for (const { pack, kind } of packs) {
          const data = parsed[pack.path];
          const tr = translated[pack.path] ?? {};
          const entries = (data?.entries ?? [])
            .map((e) => ({ ...e, translation: tr[e.key] ?? e.translation }))
            .filter((e) => e.translation && e.translation.trim() !== "");
          if (kind === "shader" && entries.length > 0) {
            const dest = `${verDir}/光影包/${pack.fileName.replace(/\.zip$/i, "")}_zh_CN.zip`;
            await api.exportShaderZh(pack.path, dest, entries);
          }
          if (kind === "resourcepack" && entries.length > 0) {
            const dest = `${verDir}/资源包/${pack.fileName.replace(/\.zip$/i, "")}_改描述.zip`;
            await api.exportResourcePackDesc(pack.path, dest, entries);
          }
          if (kind === "mod" && exportJars && entries.length > 0) {
            await api.exportModJar(pack.path, `${verDir}/汉化jar`, data?.modid || "mod", entries, "json");
          }
        }
        okVersions += 1;
      }
      message.success(`已导出 ${okVersions} 个版本的汉化内容到所选目录`);
    } catch (e) {
      message.error(`导出失败：${String(e)}`);
    } finally {
      setExporting(false);
    }
  }, [allPacks, selected, parsed, translated, exportJars]);

  // ── 渲染辅助 ──
  const statusTag = (path: string, pack: GamePackEntry) => {
    if (translatingKeys[path]) {
      const p = packProgress[path];
      return (
        <Tag color="processing" className="dev-pulse-tag">
          翻译中 {p ? `${p.done}/${p.total}` : ""}
        </Tag>
      );
    }
    const c = packCounts[path];
    if (packError[path]) {
      return (
        <Tooltip title={packError[path]}>
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
    const fk = fileKey(pack);
    const reuse = reuseRef.current.get(fk);
    if (parsed[path] && reuse && Object.keys(reuse).length > 0) {
      return <Tag color="cyan">已有可复用译文</Tag>;
    }
    return <Tag>未翻译</Tag>;
  };

  const packRow = (pack: GamePackEntry, group: GroupRow, showOrigin: boolean) => (
    <div
      key={pack.path}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px 3px 20px" }}
    >
      <Checkbox
        checked={!!selected[pack.path]}
        onChange={(e) => setSel(pack.path, e.target.checked)}
      />
      <Typography.Text
        style={{ cursor: "pointer", flex: 1, minWidth: 0, fontSize: 13 }}
        ellipsis={{ tooltip: pack.fileName }}
        onClick={() => togglePackDetail(pack, group)}
      >
        {pack.fileName}
      </Typography.Text>
      {showOrigin && (
        <Tag style={{ marginRight: 0 }}>
          {group.name} · {KIND_LABEL[pack.kind as Kind]}
        </Tag>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
        {(pack.size / 1024 / 1024).toFixed(2)} MB
      </Typography.Text>
      {statusTag(pack.path, pack)}
    </div>
  );

  const kindSection = (group: GroupRow, kind: Kind) => {
    const packs = packsOf(group.group, kind);
    if (packs.length === 0) return null;
    return (
      <div key={kind} style={{ marginTop: 4 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 12 }}>
          {KIND_LABEL[kind]}（{packs.length}）
        </Typography.Text>
        {packs.map((p) => packRow(p, group, false))}
      </div>
    );
  };

  const renderGroup = (g: GroupRow) => {
    const total =
      g.group.mods.length + g.group.resourcepacks.length + g.group.shaderpacks.length;
    return (
      <div key={g.key} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: "6px 10px", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Checkbox
            checked={total > 0 && [...packsOf(g.group, "mod"), ...packsOf(g.group, "resourcepack"), ...packsOf(g.group, "shader")].every((p) => selected[p.path])}
            indeterminate={
              [...packsOf(g.group, "mod"), ...packsOf(g.group, "resourcepack"), ...packsOf(g.group, "shader")].some((p) => selected[p.path]) &&
              ![...packsOf(g.group, "mod"), ...packsOf(g.group, "resourcepack"), ...packsOf(g.group, "shader")].every((p) => selected[p.path])
            }
            onChange={(e) => {
              const next = { ...selected };
              for (const p of [...packsOf(g.group, "mod"), ...packsOf(g.group, "resourcepack"), ...packsOf(g.group, "shader")]) {
                if (e.target.checked) next[p.path] = true;
                else delete next[p.path];
              }
              setSelected(next);
            }}
            disabled={total === 0}
          />
          <span
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={() => setExpanded((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
          >
            <Typography.Text strong>
              {expanded[g.key] ? "▾ " : "▸ "}
              {g.name}
            </Typography.Text>
            {g.group.mcVersion && <Tag color="blue">{g.group.mcVersion}</Tag>}
            {!g.isRoot && !g.group.valid && <Tag color="default">无可翻译文本</Tag>}
            <Tag>模组 {g.group.mods.length}</Tag>
            <Tag>资源包 {g.group.resourcepacks.length}</Tag>
            <Tag>光影 {g.group.shaderpacks.length}</Tag>
          </span>
        </div>
        {expanded[g.key] && (
          <div style={{ marginTop: 4 }}>
            {kindSection(g, "mod")}
            {kindSection(g, "resourcepack")}
            {kindSection(g, "shader")}
            {total === 0 && <Empty description="此版本没有内容包" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: 12 }}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Button icon={<FolderOpenOutlined />} loading={scanning} onClick={() => void pickRoot()}>
          打开游戏目录
        </Button>
        {(settings.recentGameDirs ?? []).length > 0 && (
          <Select
            placeholder="最近打开的目录"
            style={{ width: 280 }}
            value={root ?? undefined}
            options={(settings.recentGameDirs ?? []).map((d) => ({ label: d, value: d }))}
            onChange={(v) => void startScan(v)}
          />
        )}
        {scan && (
          <Button icon={<ReloadOutlined />} disabled={scanning} onClick={() => void startScan(root!)}>
            重新扫描
          </Button>
        )}
        {scanning && (
          <Button danger onClick={() => void api.cancelGameScan()}>
            取消扫描
          </Button>
        )}
        {scan && (
          <>
            <Button
              type="primary"
              icon={<TranslationOutlined />}
              loading={translatingCount > 0}
              disabled={Object.keys(selected).length === 0}
              onClick={() => void translateSelected()}
            >
              开始翻译勾选项（{Object.keys(selected).length}）
            </Button>
            <Button
              icon={<ExportOutlined />}
              loading={exporting}
              disabled={Object.keys(selected).length === 0 || translatingCount > 0}
              onClick={() => void exportSelected()}
            >
              导出勾选项
            </Button>
          </>
        )}
      </Space>

      {scan && (
        <Space wrap style={{ marginBottom: 12 }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索内容包（结果显示所属版本）"
            style={{ width: 260 }}
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button size="small" onClick={selectAllFiltered}>
            全选
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
          <Button size="small" onClick={selectUntranslated}>
            只选未翻译的
          </Button>
          <Checkbox
            checked={exportJars}
            onChange={(e) => setExportJars(e.target.checked)}
          >
            导出时同时生成单个汉化 jar
          </Checkbox>
        </Space>
      )}

      {scanning && progress && (
        <div style={{ marginBottom: 12 }}>
          <Progress
            percent={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
            format={() => `扫描版本 ${progress.done}/${progress.total}：${progress.current}`}
          />
        </div>
      )}

      {translatingCount > 0 && (
        <div
          onClick={() => setReportOpen(true)}
          style={{
            marginBottom: 12,
            padding: "6px 12px",
            border: "1px solid var(--border-color)",
            borderLeft: "3px solid var(--slide-indicator-bg)",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          翻译中：进行中 {translatingCount} 包 · 完成 {donePacks} 包 ·{" "}
          {Object.values(packCounts).reduce((n, c) => n + c.ok + c.reused, 0)} 条成功 ·{" "}
          {Object.values(packCounts).reduce((n, c) => n + c.error, 0)} 条失败（点击查看报告）
        </div>
      )}

      {!scan && !scanning && (
        <Empty description="选择 .minecraft 目录（或任意游戏目录 / 版本文件夹），自动向下扫描 mods、resourcepacks、shaderpacks" />
      )}

      {scan && filtered && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
            搜索"{search}"：{filtered.length} 个结果
          </Typography.Text>
          {filtered.length === 0 ? (
            <Empty description="没有匹配的内容包" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            filtered.map(({ group, pack }) => packRow(pack, group, true))
          )}
        </div>
      )}

      {scan && !filtered && (
        <div>
          {groups.map(renderGroup)}
        </div>
      )}

      {expandedPack && parsed[expandedPack] && (
        <Modal
          title={`内容包详情：${expandedPack.split(/[\\/]/).pop()}`}
          open
          width={960}
          footer={null}
          destroyOnClose
          onCancel={() => setExpandedPack(null)}
        >
          <EntryTable
            entries={parsed[expandedPack].entries.map((e) => ({
              ...e,
              translation: translated[expandedPack]?.[e.key] ?? e.translation,
            }))}
            onEdit={(key, v) => {
              setTranslated((prev) => ({
                ...prev,
                [expandedPack]: { ...(prev[expandedPack] ?? {}), [key]: v },
              }));
              translatedRef.current[expandedPack] = {
                ...(translatedRef.current[expandedPack] ?? {}),
                [key]: v,
              };
            }}
            onSelect={() => {}}
            onClear={(key) => {
              const next = { ...(translated[expandedPack] ?? {}) };
              delete next[key];
              setTranslated({ ...translated, [expandedPack]: next });
              const tr = (translatedRef.current[expandedPack] ??= {});
              delete tr[key];
            }}
            scrollY={420}
          />
        </Modal>
      )}

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
              {dupFileKeys > 0 && (
                <>
                  <br />
                  跨版本重复 {dupFileKeys} 个（同名同大小），翻译时将自动复用译文。
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

      {/* 翻译报告弹窗（实时/结束后均可查看） */}
      <Modal
        title="翻译报告"
        open={reportOpen}
        onCancel={() => setReportOpen(false)}
        footer={[
          failedPaths.length > 0 && (
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
            {allPacks
              .filter(({ pack }) => packCounts[pack.path])
              .map(({ pack, group }) => {
                const err = packError[pack.path];
                return (
                  <div key={pack.path} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <Tag style={{ marginRight: 0 }}>{group.name}</Tag>
                    <Typography.Text style={{ flex: 1, minWidth: 0 }} ellipsis={{ tooltip: pack.fileName }}>
                      {pack.fileName}
                    </Typography.Text>
                    {statusTag(pack.path, pack)}
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

function findPack(scan: GameDirScan, path: string): GamePackEntry | null {
  const all = [scan.rootGroup, ...scan.versions];
  for (const g of all) {
    for (const p of [...g.mods, ...g.resourcepacks, ...g.shaderpacks]) {
      if (p.path === path) return p;
    }
  }
  return null;
}
