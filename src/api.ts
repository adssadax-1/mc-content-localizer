import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  BatchItem,
  LangEntry,
  LangFormat,
  ModelInfo,
  ModFile,
  ProgressPayload,
  ProviderConfig,
  PackType,
  PromptTemplate,
  DeepScanResult,
  ResourcePackBundle,
  ResourcePackInfo,
  Settings,
  ShaderPack,
  ThreadingConfig,
  TranslateContext,
  TranslatedItem,
  UpdateInfo,
} from "./types";

export const api = {
  parseJar: (path: string) => invoke<ModFile>("parse_jar", { path }),

  runTranslation: (
    config: ProviderConfig,
    ctx: TranslateContext,
    items: BatchItem[],
    batchSize?: number,
    extractGlossary?: boolean,
    threading?: ThreadingConfig,
  ) =>
    invoke<TranslatedItem[]>("run_translation", {
      config,
      ctx,
      items,
      batchSize,
      extractGlossary,
      threading,
    }),

  exportResourcePack: (
    destDir: string,
    modid: string,
    modName: string,
    entries: LangEntry[],
    langFormat: LangFormat,
    packFormat: number,
  ) =>
    invoke<string>("export_resource_pack", {
      destDir,
      modid,
      modName,
      entries,
      langFormat,
      packFormat,
    }),

  /** 多模组合并导出资源包（一个 zip 管所有模组） */
  exportResourcePackMulti: (
    destDir: string,
    bundles: ResourcePackBundle[],
    packFormat: number,
  ) =>
    invoke<string>("export_resource_pack_multi", {
      destDir,
      bundles,
      packFormat,
    }),

  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),

  /** 判定内容包类型（mod/shader/resourcepack） */
  detectPackType: (path: string) => invoke<PackType>("detect_pack_type", { path }),
  /** 静默检查 GitHub 最新版本（网络失败返回 null，不打扰） */
  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),

  /** 深度扫描 jar 内所有可能文本（含嵌套 jar 递归） */
  deepScanJar: (path: string, modid: string) =>
    invoke<DeepScanResult>("deep_scan_jar", { path, modid }),

  /** 获取某类型提示词模板（默认可编辑段 + 核心段） */
  getPromptTemplate: (packType: string) =>
    invoke<PromptTemplate>("get_prompt_template", { packType }),

  /** 解析光影包（shaders.properties + zh_CN.lang） */
  parseShaderPack: (path: string) => invoke<ShaderPack>("parse_shader_pack", { path }),
  /** 解析资源包（pack.mcmeta description） */
  parseResourcePack: (path: string) =>
    invoke<ResourcePackInfo>("parse_resource_pack", { path }),
  /** 导出汉化光影包（写入 shaders/lang/zh_CN.lang） */
  exportShaderZh: (source: string, dest: string, entries: LangEntry[]) =>
    invoke<string>("export_shader_zh", { source, dest, entries }),
  /** 导出改描述后的资源包 */
  exportResourcePackDesc: (source: string, dest: string, entries: LangEntry[]) =>
    invoke<string>("export_resource_pack_desc", { source, dest, entries }),

  listModels: (config: ProviderConfig) => invoke<ModelInfo[]>("list_models", { config }),

  cancelTranslation: () => invoke<void>("cancel_translation"),
  pauseTranslation: () => invoke<void>("pause_translation"),
  resumeTranslation: () => invoke<void>("resume_translation"),

  exportModJar: (
    source: string,
    dest: string,
    modid: string,
    entries: LangEntry[],
    langFormat: LangFormat,
  ) =>
    invoke<string>("export_mod_jar", {
      source,
      dest,
      modid,
      entries,
      langFormat,
    }),
};

/** 监听翻译进度事件 */
export async function onTranslateProgress(
  handler: (p: ProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<ProgressPayload>("translate-progress", (e) => handler(e.payload));
}

/** 监听术语表提取完成事件 */
export async function onGlossaryDone(
  handler: (payload: { count: number; glossary: [string, string][] }) => void,
): Promise<UnlistenFn> {
  return listen<{ count: number; glossary: [string, string][] }>(
    "glossary-done",
    (e) => handler(e.payload),
  );
}

/** 监听拖入文件事件（Rust 侧转发路径） */
export async function onFileDropped(
  handler: (paths: string[]) => void,
): Promise<UnlistenFn> {
  return listen<string[]>("file-dropped", (e) => handler(e.payload));
}
