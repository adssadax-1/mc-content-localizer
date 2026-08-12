// 与 Rust 侧模型对应的 TypeScript 类型（serde camelCase）

export type EntryStatus =
  | "untranslated"
  | "tmHit"
  | "existingZh"
  | "aiTranslated"
  | "userConfirmed"
  | "placeholderError";

export type LangFormat = "legacyLang" | "json";
export type Loader = "forge" | "fabric" | "neoForge" | "unknown";

export interface LangEntry {
  key: string;
  source: string;
  filePath: string;
  modid: string;
  translation: string | null;
  /** 是否为硬编码文本（非 lang 文件，如 advancements/config） */
  hardcoded?: boolean;
  /** 是否参与汉化（前端勾选，默认 true；导出时未选中的条目不导出） */
  selected?: boolean;
  status: EntryStatus;
  placeholders: string[];
  notes: string[];
}

/** 内容包类型 */
export type PackType = "mod" | "shader" | "resourcepack";

export interface ModFile {
  fileName: string;  modName: string;
  modid: string;
  version: string | null;
  loader: Loader;
  mcVersion: string | null;
  langFormat: LangFormat;
  /** 是否自带中文（zh_cn） */
  hasZh?: boolean;
  /** 自带中文条数 */
  zhCount?: number;
  entries: LangEntry[];
}

/** 多模组合并导出资源包时的单模组数据 */
export interface ResourcePackBundle {
  modid: string;
  modName: string;
  entries: LangEntry[];
  langFormat: LangFormat;
}

/** 光影包解析结果 */
export interface ShaderPack {
  fileName: string;
  name: string;
  hasZh: boolean;
  zhCount: number;
  entries: LangEntry[];
}

/** 资源包解析结果 */
export interface ResourcePackInfo {
  fileName: string;
  name: string;
  entries: LangEntry[];
}

export interface BatchItem {
  key: string;
  source: string;
}

export interface TranslateContext {
  modName: string;
  modid: string;
  mcVersion: string | null;
  loader: string;
  /** 内容包类型：mod / shader / resourcepack（决定翻译提示词） */
  packType: "mod" | "shader" | "resourcepack";
  userGlossary: [string, string][];
}

export interface TranslatedItem {
  key: string;
  translation: string;
  notes: string[];
}

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  model: string | null;
  baseUrl: string | null;
  temperature: number | null;
  maxRetries: number | null;
}

/** 模型列表项（拉取自服务商 /models，free = 官方确认免费） */
export interface ModelInfo {
  id: string;
  free: boolean;
}

export interface Settings {
  provider: ProviderConfig;
  /** 各服务商分别保存的 API Key（切换服务商不串 key） */
  providerApiKeys: Record<string, string>;
  /** 各服务商分别保存的模型（切换服务商显示各自选择的模型） */
  providerModels: Record<string, string>;
  /** 各服务商分别缓存的模型列表（拉取过的显示对应服务商的，没拉取过则提示） */
  providerModelOptions: Record<string, ModelInfo[]>;
  userGlossary: [string, string][];
  batchSize: number;
  extractGlossary: boolean;
  /** 多线程翻译配置（实验性） */
  threading: ThreadingConfig;
}

/** 多线程翻译配置（实验性） */
export interface ThreadingConfig {
  enabled: boolean;
  threadCount: number;
  requestIntervalSec: number;
}

export interface ProgressPayload {
  batchIndex: number;
  batchTotal: number;
  doneCount: number;
  totalCount: number;
}

// 翻译状态的中文标签
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const STATUS_LABEL: Record<EntryStatus, string> = {
  untranslated: "未翻译",
  tmHit: "TM 命中",
  existingZh: "自带中文",
  aiTranslated: "AI 翻译",
  userConfirmed: "人工确认",
  placeholderError: "占位符异常",
};

export const STATUS_COLOR: Record<EntryStatus, string> = {
  untranslated: "default",
  tmHit: "geekblue",
  existingZh: "cyan",
  aiTranslated: "green",
  userConfirmed: "purple",
  placeholderError: "volcano",
};

export const LOADER_LABEL: Record<Loader, string> = {
  forge: "Forge",
  fabric: "Fabric",
  neoForge: "NeoForge",
  unknown: "未知",
};

export const PROVIDER_PRESETS: Record<string, { label: string; model: string; baseUrl: string }> = {
  zhipu: {
    label: "智谱 GLM-4-Flash（免费）",
    model: "glm-4-flash-250414",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  gemini: {
    label: "Google Gemini（免费层）",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  deepseek: {
    label: "DeepSeek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  },
  qwen: {
    label: "阿里百炼 Qwen",
    model: "qwen-flash",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  custom: {
    label: "自定义（OpenAI 兼容）",
    model: "",
    baseUrl: "",
  },
};

/**
 * 按 Minecraft 版本匹配资源包 pack_format（依据 Minecraft Wiki 资源包格式历史）。
 * 输入 mcVersion 可为 "1.20.1" 或范围如 "[1.20.1,1.21)" / ">=1.20.1"，
 * 取其中最低版本匹配；无法识别返回 null。
 * 注意：1.21.9+（格式 > 64）的资源包不再用 pack_format 字段，而用 min_format/max_format。
 */
export function packFormatForMc(mcVersion: string | null | undefined): number | null {
  if (!mcVersion) return null;
  // 兼容 1.x 与 26.x 系列
  const m = mcVersion.match(/(1|26)\.(\d{1,2})(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = m[3] ? parseInt(m[3], 10) : 0;

  if (major === 26) {
    // 26.1 / 26.1.1 / 26.1.2 = 84，26.2 = 88
    if (minor === 1) return 84;
    if (minor >= 2) return 88;
    return null;
  }
  // 1.x 系列
  if (minor <= 8) return 1;
  if (minor === 9 || minor === 10) return 2;
  if (minor === 11 || minor === 12) return 3;
  if (minor === 13 || minor === 14) return 4;
  if (minor === 15) return 5;
  if (minor === 16) return 6;
  if (minor === 17) return 7;
  if (minor === 18) return 8;
  if (minor === 19) {
    if (patch === 3) return 12;
    if (patch === 4) return 13;
    return 9; // 1.19 - 1.19.2
  }
  if (minor === 20) {
    if (patch === 2) return 18;
    if (patch === 3 || patch === 4) return 22;
    if (patch === 5 || patch === 6) return 32;
    return 15; // 1.20 - 1.20.1
  }
  if (minor === 21) {
    if (patch === 2 || patch === 3) return 42;
    if (patch === 4) return 46;
    if (patch === 5) return 55;
    if (patch === 6 || patch === 7) return 63;
    if (patch === 8) return 64;
    if (patch === 9) return 68;
    if (patch === 10) return 69;
    if (patch >= 11) return 75;
    return 34; // 1.21 - 1.21.1
  }
  return 15;
}
