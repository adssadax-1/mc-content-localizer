import { api } from "./api";
import type { GameDirScan } from "./types";

/**
 * 游戏目录扫描结果的缓存。
 *
 * 动机：`scanGameDir` 是逐版本向下遍历目录的 IO 活，而「最近目录」是个
 * 高频切换入口（来回对比两个整合包的场景很常见）。没有缓存时，每点一次
 * 最近目录就重扫一遍，用户要等进度条重新跑完才能看内容。
 *
 * ## 为什么是「落盘」而不是内存
 * 初版只存内存，结果**一重启就全没了** —— 而重启恰恰是最容易遇到"又要重扫"的
 * 时刻（改完设置要重启、崩溃恢复要重启）。缓存的意义就是省掉重复的一次遍历，
 * 那就必须跨进程存活。所以这里走 Tauri 命令整份读写
 * `app_config_dir/scan-cache-gamedir.json`（Rust 侧只当哑存储，schema 归前端）。
 *
 * ## 三层结构：内存 Map 是读路径，磁盘是持久层
 * `getScanCache` 是**同步**调用（在 `startScan` 里直接用），所以磁盘只能在启动时
 * 一次性 hydrate 进内存 Map，之后读走内存、写穿磁盘。这样调用点一行都不用改。
 *
 * ## 取舍
 * - **LRU + 上限 8**。最近目录最多 5 个，上限取 8 留余量；GameDirScan 在极端
 *   整合包下可能上千条，必须有上限兜底（也是落盘文件体积的上限）。
 * - **路径归一**。Windows 路径大小写不敏感、尾部分隔符可能不一致，
 *   统一 `lower + 去尾部分隔符` 后再做 key，避免同一目录存成两份。
 * - **不设过期时间**。缓存里带着 `scannedAt`，界面常驻显示「扫描于 …」+「缓存」标签，
 *   用户自己就能判断"这份新不新"，想刷新就点「重新扫描」。设 TTL 反而会制造
 *   "为什么这次又重扫了"的不可预测感 —— 用户要的正是"别重扫"。
 * - **写盘失败静默**。缓存是尽力而为，磁盘满 / 权限异常不该影响扫描结果本身的展示。
 */

export interface CachedScan {
  /** Rust 侧返回的原始扫描结果 */
  scan: GameDirScan;
  /** 汇总数字在扫描时一并算好，命中缓存时不必重算 */
  packTotal: number;
  /** 跨版本同名同大小的重复数 */
  dup: number;
  /** 扫描完成时刻（毫秒时间戳），用于界面提示「扫描于 xx:xx」 */
  scannedAt: number;
  /** 原始目录路径（大小写与尾部分隔符按用户输入保留） */
  dir: string;
}

const MAX_ENTRIES = 8;
/** 落盘格式版本：结构一变就抬版本号，让旧文件被安全忽略，而不是解析出一堆错值 */
const FILE_VERSION = 1;

const cache = new Map<string, CachedScan>();

let hydrated = false;

function keyOf(dir: string): string {
  return dir.replace(/[\\/]+$/, "").toLowerCase();
}

/** 内存里的 LRU 顺序即落盘顺序：Map 迭代顺序 = 插入顺序，"先删再插"即"最近用过的排最后" */
function snapshot(): string {
  return JSON.stringify({
    version: FILE_VERSION,
    entries: [...cache.values()],
  });
}

/** 写穿到磁盘。抽成独立函数供 put / drop / clear 三处共用 */
function persistToDisk(): void {
  try {
    void api.saveScanCache(snapshot()).catch(() => {
      /* 缓存写盘失败不打断任何流程 */
    });
  } catch {
    /* 同上 */
  }
}

/**
 * 启动时把磁盘缓存读进内存。App 挂载时调一次即可，重复调用幂等。
 *
 * 不 await 也不会有问题：`getScanCache` 是同步的，用户在 hydrate 完成前就点了目录的
 * 窗口只有几十毫秒，最坏结果就是这一次仍然重扫（与完全没有缓存时一致），不会出错。
 */
export async function hydrateScanCache(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await api.loadScanCache();
    if (!raw) return;
    const parsed = JSON.parse(raw) as { version?: number; entries?: CachedScan[] };
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries)) return;
    for (const e of parsed.entries) {
      // 逐条校验：宁可少恢复一条，也不要让半截数据把界面搞崩
      if (!e || typeof e.dir !== "string" || !e.scan || typeof e.scannedAt !== "number") continue;
      // 先删再插，保持"越靠后越新"，与 putScanCache 的 LRU 语义一致
      const k = keyOf(e.dir);
      cache.delete(k);
      cache.set(k, e);
    }
    // 磁盘档里可能超过当前上限（早期版本写的），按 LRU 截断
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  } catch {
    /* 文件坏 / 版本不符 / IPC 异常：都当作"没有缓存" */
  }
}

export function getScanCache(dir: string): CachedScan | undefined {
  return cache.get(keyOf(dir));
}

export function putScanCache(dir: string, entry: Omit<CachedScan, "dir">): void {
  const k = keyOf(dir);
  // 先删再插：让 Map 的插入顺序等价于 LRU 顺序
  cache.delete(k);
  cache.set(k, { ...entry, dir });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  persistToDisk();
}

/** 丢弃某个目录的缓存（该目录被移出「最近目录」时调用，避免留下回不去的条目） */
export function dropScanCache(dir: string): void {
  if (cache.delete(keyOf(dir))) persistToDisk();
}

/** 清空全部缓存（保留给「目录内容可能已变更」的场景） */
export function clearScanCache(): void {
  if (cache.size === 0) return;
  cache.clear();
  persistToDisk();
}
