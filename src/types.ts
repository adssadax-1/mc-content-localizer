// 与 Rust 侧模型对应的 TypeScript 类型（serde camelCase）

export type EntryStatus =
  | "untranslated"
  | "tmHit"
  | "existingZh"
  | "aiTranslated"
  | "userConfirmed"
  | "placeholderError"
  | "aiEmpty"
  | "aiFailed";

export type LangFormat = "legacyLang" | "json";
export type Loader = "forge" | "fabric" | "neoForge" | "quilt" | "unknown";

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
  /** 翻译进行中（前端实时着色用，仅运行期） */
  translating?: boolean;
  placeholders: string[];
  notes: string[];
  /** 深度扫描分组 key（仅深度扫描条目有；前端按 key 做分组勾选，不依赖文案） */
  deepGroup?: string;
}

/** 内容包类型 */
export type PackType = "mod" | "shader" | "resourcepack" | "plugin";

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

/** 深度扫描：一条自定义规则 */
export interface CustomRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: "ext" | "fileGlob" | "pathGlob" | "textRegex";
  pattern: string;
  action: "include" | "exclude";
  source?: "user" | "imported";
}

/** 深度扫描：一套规则 */
export interface DeepScanRules {
  /** 总开关：导入时对解析为空的内容包自动强化扫描 */
  auto: boolean;
  scopeJson: boolean;
  scopeLang: boolean;
  scopeText: boolean;
  scopeNested: boolean;
  scopeClass: boolean;
  skipMeta: boolean;
  /** 不可关闭（语言文件由常规解析处理） */
  skipLangfiles: boolean;
  skipLibs: boolean;
  onlySourceLocale: boolean;
  /** 不可关闭（含中文一律保留） */
  keepCjk: boolean;
  dropSql: boolean;
  dropDescriptor: boolean;
  dropLog: boolean;
  dropIdent: boolean;
  classNeedsMarker: boolean;
  custom: CustomRule[];
}

/** 深度扫描：模组 / 插件两套 */
export interface DeepScanSettings {
  mod: DeepScanRules;
  plugin: DeepScanRules;
}

/** 内置规则元数据（由后端下发，避免规则名前后端漂移） */
export interface RuleMetaItem {
  id: keyof DeepScanRules | string;
  group: "scope" | "path" | "filter";
  key: string;
  locked: boolean;
  defaultMod: boolean;
  defaultPlugin: boolean;
}

export interface RuleMeta {
  rules: RuleMetaItem[];
  templates: string[];
  maxCustom: number;
  maxPatternLen: number;
}

/** 规则测试台预览结果 */
export interface DeepScanPreview {
  total: number;
  groups: { key: string; label: string; count: number; defaultChecked: boolean }[];
  samples: { source: string; filePath: string; group: string }[];
}

/** 单包级深度扫描覆盖（只存与全局规则的差异） */
export interface DeepScanOverride {
  rules?: Partial<DeepScanRules>;
  /** 单包处只允许切换自定义规则的启用状态，不能新增/编辑 */
  customEnabled?: Record<string, boolean>;
}

/** 服务器插件 jar 解析结果 */
export interface PluginFile {
  fileName: string;
  /** 插件名（plugin.yml 的 name） */
  pluginName: string;
  version: string | null;
  hasZh: boolean;
  zhCount: number;
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
  /** 内容包类型：mod / shader / resourcepack / plugin（决定翻译提示词） */
  packType: "mod" | "shader" | "resourcepack" | "plugin";
  /** 用户自定义可编辑提示词段（null = 用默认） */
  customPrompt: string | null;
  userGlossary: [string, string][];
}

/** 提示词模板（供自定义提示词编辑器展示） */
export interface PromptTemplate {
  editableDefault: string;
  coreRules: string;
}

/** 更新信息（静默检查 GitHub Release） */
export interface UpdateInfo {
  latestVersion: string;
  url: string;
}

/** 软件自身数据的一项（「关于」页的存储明细） */
export interface StorageItem {
  group: "cache" | "user";
  /** 文件名 / 目录名（相对软件数据目录） */
  name: string;
  path: string;
  bytes: number;
}

/** 软件自身数据占用（缓存与用户数据分开统计） */
export interface StorageUsage {
  configDir: string;
  localDir: string;
  /** WebView2 配置目录（浏览器缓存与界面状态的存放处） */
  profileDir: string;
  cacheBytes: number;
  userBytes: number;
  cacheItems: StorageItem[];
  userItems: StorageItem[];
}

/** 清理结果 */
export interface ClearResult {
  freedBytes: number;
  removed: string[];
  /** 被占用而跳过的条目（正常关闭软件后再清一次即可） */
  skipped: string[];
}

/** 深度扫描分组（前端分组勾选视图） */
export interface DeepGroup {
  key: string;
  label: string;
  count: number;
  defaultChecked: boolean;
}

/** 深度扫描结果 */
export interface DeepScanResult {
  entries: LangEntry[];
  groups: DeepGroup[];
}

export interface TranslatedItem {
  key: string;
  translation: string;
  notes: string[];
}

/** 逐批实时推送的单条翻译结果事件（前端实时写入存储并显示） */
export interface EntryTranslatedEvent {
  /** 所属内容包 key（前端据此定位到具体队列项） */
  packKey: string;
  items: {
    key: string;
    translation: string;
    notes: string[];
    /** 结果类型：ok 成功 / empty AI 未返回 / error 翻译失败 */
    kind: "ok" | "empty" | "error";
  }[];
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
  /** 每批条数跟随线程数自动取最优（条目数 ÷ 线程数，向上取整）；false 时用 batchSize */
  batchSizeAuto: boolean;
  /** 内容包并行翻译开关 */
  packParallelEnabled: boolean;
  /** 同时翻译的内容包数（0 = 无限制） */
  packParallelCount: number;
  extractGlossary: boolean;
  /** 多线程翻译配置（实验性） */
  threading: ThreadingConfig;
  /** 自定义提示词（key: mod/shader/resourcepack → 用户自定义的可编辑段） */
  customPrompts: Record<string, string>;
  /** 深度文本扫描：普通解析为空时自动启用强化扫描 */
  /** 深度扫描规则：模组与插件各自独立（旧 deepScan/deepScanPlugin 布尔已迁移进 rules.auto） */
  deepScanRules?: DeepScanSettings;
  /** 主题模式：light（亮色）/ dark（暗色） */
  theme: 'light' | 'dark';
  /** 界面语言：zh（中文）/ en（英文） */
  language: 'zh' | 'en';
  /** 无字模式：隐藏外壳（顶栏/侧栏/工具栏/页脚）文字，只留图标；内容区不受影响 */
  iconOnly?: boolean;
  /** 主窗口关闭行为：exit 直接退出 / minimize 最小化到托盘 */
  closeBehavior: 'exit' | 'minimize';
  /** 导出命名偏好：raw 原名 / suffix 原名_zh_cn（默认）/ ai AI 汉化名称 */
  exportNaming?: 'raw' | 'suffix' | 'ai';
  /** AI 汉化名称缓存（key = "文件名|大小"） */
  aiNames?: Record<string, string>;
  /** 最近打开的游戏目录（游戏目录模式快速重选） */
  recentGameDirs: string[];
}

/** 游戏目录模式：扫描结果 */
export interface GamePackEntry {
  path: string;
  fileName: string;
  size: number;
  kind: 'mod' | 'shader' | 'resourcepack' | 'plugin';
}

export interface GameVersionGroup {
  /** 相对游戏目录的路径（"" = 公共目录），唯一标识 */
  relPath: string;
  /** 展示名（路径最后一段） */
  dirName: string;
  mcVersion: string | null;
  /** 是否含版本 jar/json（仅供参考） */
  valid: boolean;
  mods: GamePackEntry[];
  resourcepacks: GamePackEntry[];
  shaderpacks: GamePackEntry[];
  /** 服务器插件（服务器根目录 plugins/ 下） */
  plugins: GamePackEntry[];
}

export interface GameDirScan {
  root: string;
  /** 相对路径 "" = 公共目录（排最前） */
  groups: GameVersionGroup[];
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
  /** 所属内容包 key（并行翻译时区分各包进度） */
  packKey?: string;
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
  aiEmpty: "AI 未返回",
  aiFailed: "翻译失败",
};

export const STATUS_COLOR: Record<EntryStatus, string> = {
  untranslated: "default",
  tmHit: "geekblue",
  existingZh: "cyan",
  aiTranslated: "green",
  userConfirmed: "purple",
  placeholderError: "volcano",
  aiEmpty: "gold",
  aiFailed: "red",
};

export const LOADER_LABEL: Record<Loader, string> = {
  forge: "Forge",
  fabric: "Fabric",
  neoForge: "NeoForge",
  quilt: "Quilt",
  unknown: "未知",
};

/** 服务商预设（与 Rust 侧 PRESETS 一一对应；label 用于网格卡片展示，website 为官网便于跳转） */
export const PROVIDER_PRESETS: Record<string, { label: string; model: string; baseUrl: string; website: string }> = {
  zhipu: {
    label: "智谱 GLM",
    model: "glm-4-flash-250414",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    website: "https://open.bigmodel.cn",
  },
  qwen: {
    label: "通义 Qwen",
    model: "qwen-flash",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    website: "https://bailian.console.aliyun.com",
  },
  deepseek: {
    label: "DeepSeek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/v1",
    website: "https://platform.deepseek.com",
  },
  doubao: {
    label: "火山豆包",
    model: "doubao-seed-1-8",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    website: "https://www.volcengine.com/product/ark",
  },
  moonshot: {
    label: "Kimi 月之暗面",
    model: "kimi-k2",
    baseUrl: "https://api.moonshot.cn/v1",
    website: "https://platform.moonshot.cn",
  },
  hunyuan: {
    label: "腾讯混元",
    model: "hunyuan-turbos-latest",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    website: "https://cloud.tencent.com/product/hunyuan",
  },
  siliconflow: {
    label: "硅基流动",
    model: "deepseek-ai/DeepSeek-V3.2",
    baseUrl: "https://api.siliconflow.cn/v1",
    website: "https://siliconflow.cn",
  },
  gemini: {
    label: "Google Gemini",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    website: "https://aistudio.google.com",
  },
  openai: {
    label: "OpenAI",
    model: "gpt-5-mini",
    baseUrl: "https://api.openai.com/v1",
    website: "https://platform.openai.com",
  },
  openrouter: {
    label: "OpenRouter",
    model: "google/gemini-2.5-flash",
    baseUrl: "https://openrouter.ai/api/v1",
    website: "https://openrouter.ai",
  },
  // 本地推理服务：无需 API Key。model 留空是刻意的 —— 本地模型由用户自己
  // pull / --alias 决定，预设一个名字只会在没拉取时报"模型不存在"。
  ollama: {
    label: "Ollama",
    model: "",
    baseUrl: "http://localhost:11434/v1",
    website: "https://ollama.com",
  },
  llamacpp: {
    label: "llama.cpp",
    model: "",
    baseUrl: "http://127.0.0.1:8080/v1",
    website: "https://github.com/ggml-org/llama.cpp",
  },
  custom: {
    label: "自定义",
    model: "",
    baseUrl: "",
    website: "",
  },
};

/** 本地推理服务标识（与 Rust 侧 LOCAL_PROVIDERS 一一对应） */
export const LOCAL_PROVIDERS = ["ollama", "llamacpp"] as const;

/**
 * base_url 是否指向本机 —— 与 Rust 侧 `is_local_url` 保持同一套判据：
 * 只认真实回环（localhost / 127.0.0.1 / 0.0.0.0 / [::1] / *.localhost），
 * `localhost.evil.com` 这类不算。
 */
export function isLocalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const u = url.trim().toLowerCase();
  const afterScheme = u.includes("://") ? u.slice(u.indexOf("://") + 3) : u;
  const authority = afterScheme.split(/[/?#]/)[0] ?? "";
  const hostPort = authority.split("@").pop() ?? "";
  const host = hostPort.startsWith("[")
    ? hostPort.slice(1, hostPort.indexOf("]"))
    : hostPort.split(":")[0];
  return (
    ["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"].includes(host) ||
    host.endsWith(".localhost")
  );
}

/**
 * 是否为本地推理服务 —— 与 Rust 侧 `ProviderConfig::is_local` 同一套判据：
 * provider 标识命中，或**自定义**端点的地址落在本机。
 *
 * 刻意不看预设档的 Base URL：云端预设会忽略它（请求照样发往云端），
 * 而表单里的 baseUrl 可能是上一任「自定义」留下的残留值 ——
 * 拿它判断会让云端档误判成免 Key。
 */
export function isLocalProvider(
  id: string | undefined | null,
  baseUrl?: string | null,
): boolean {
  if (!id) return false;
  if ((LOCAL_PROVIDERS as readonly string[]).includes(id)) return true;
  if (id === "custom") return isLocalUrl(baseUrl);
  return false;
}

/**
 * 本地档自动批次的封顶值。
 *
 * 自动档原本按「待译条数 ÷ 线程数」算，线程为 1 时**等于整包一批** ——
 * 云端模型吃得下，本地推理服务（默认单并发 + 默认 2K/4K 上下文）会直接崩。
 * 只封顶自动档，用户手动设的 batchSize 一字不动。
 */
export const LOCAL_AUTO_BATCH_CAP = 8;

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
