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
  ResourcePackBundle,
  Settings,
  TranslateContext,
  TranslatedItem,
} from "./types";

export const api = {
  parseJar: (path: string) => invoke<ModFile>("parse_jar", { path }),

  runTranslation: (
    config: ProviderConfig,
    ctx: TranslateContext,
    items: BatchItem[],
    batchSize?: number,
    extractGlossary?: boolean,
  ) =>
    invoke<TranslatedItem[]>("run_translation", {
      config,
      ctx,
      items,
      batchSize,
      extractGlossary,
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
  handler: (count: number) => void,
): Promise<UnlistenFn> {
  return listen<{ count: number }>("glossary-done", (e) => handler(e.payload.count));
}

/** 监听拖入文件事件（Rust 侧转发路径） */
export async function onFileDropped(
  handler: (paths: string[]) => void,
): Promise<UnlistenFn> {
  return listen<string[]>("file-dropped", (e) => handler(e.payload));
}
