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
  EntryTranslatedEvent,
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
    packKey: string,
    batchSize?: number,
    extractGlossary?: boolean,
    threading?: ThreadingConfig,
  ) =>
    invoke<TranslatedItem[]>("run_translation", {
      config,
      ctx,
      items,
      packKey,
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

  /** 验证所选模型连接是否可用（发送最小请求） */
  testModel: (config: ProviderConfig) => invoke<string>("test_model", { config }),

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

  // ── devtools 专用命令（仅 __DEVTOOLS__ 时调用；生产构建后端无此命令） ──────
  devParseText: (format: string, text: string) =>
    invoke<{ pairs: [string, string][]; placeholders: string[]; error: string | null }>(
      "dev_parse_text",
      { format, text },
    ),
  devValidatePlaceholders: (source: string, translation: string) =>
    invoke<string[]>("dev_validate_placeholders", { source, translation }),
  devPreviewExport: (
    modid: string,
    modName: string,
    entries: LangEntry[],
    langFormat: string,
    packFormat: number,
  ) =>
    invoke<{
      file_name: string;
      sanitized_modid: string;
      original_modid: string;
      uses_min_max_format: boolean;
      mcmeta_json: string;
      lang_path: string;
      lang_content_preview: string;
      zip_tree: string[];
      entry_count: number;
    }>("dev_preview_export", { modid, modName, entries, langFormat, packFormat }),
  devSetFault: (config: {
    delayMs: number | null;
    forceTimeout: boolean;
    mockStatus: number | null;
    mockBody: string | null;
    disconnect: boolean;
  }) =>
    invoke<void>("dev_set_fault", {
      // Tauri 命令参数必须与 Rust 侧形参一一对应（camelCase 顶层键），不能嵌套
      delayMs: config.delayMs,
      forceTimeout: config.forceTimeout,
      mockStatus: config.mockStatus,
      mockBody: config.mockBody,
      disconnect: config.disconnect,
    }),
  devClearFault: () => invoke<void>("dev_clear_fault"),
  devReadTextFile: (path: string) => invoke<string>("dev_read_text_file", { path }),
  devEncodePairs: (format: string, pairs: [string, string][]) =>
    invoke<string>("dev_encode_pairs", { format, pairs }),
  devWriteTextFile: (path: string, content: string) =>
    invoke<void>("dev_write_text_file", { path, content }),
};

/** 监听翻译进度事件 */
export async function onTranslateProgress(
  handler: (p: ProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<ProgressPayload>("translate-progress", (e) => handler(e.payload));
}

/** 监听逐批实时翻译结果事件（实时写入存储并显示） */
export async function onTranslationBatch(
  handler: (payload: EntryTranslatedEvent) => void,
): Promise<UnlistenFn> {
  return listen<EntryTranslatedEvent>("translation-batch", (e) => handler(e.payload));
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

// ── devApi: invoke 日志代理（仅 __DEVTOOLS__ 时生效） ──────────────────────────
// 当 __DEVTOOLS__ 为 true 时，devApi 是 api 的 Proxy 包装：每次 invoke 记录
// {command, args, result, error, durationMs} 到 DevToolsPanel 的 ring buffer。
// 生产构建 __DEVTOOLS__=false → devApi === api，零开销。

export function createDevApi(
  base: typeof api,
  logger: (entry: { command: string; args: unknown; result: unknown; error: string | null; durationMs: number }) => void,
): typeof api {
  return new Proxy(base, {
    get(target, prop: string) {
      const orig = (target as Record<string, unknown>)[prop];
      if (typeof orig !== "function") return orig;
      return (...args: unknown[]) => {
        const start = performance.now();
        const command = prop;
        return (orig as (...a: unknown[]) => Promise<unknown>)(...args).then(
          (result) => {
            logger({ command, args: args.length === 1 ? args[0] : args, result, error: null, durationMs: Math.round(performance.now() - start) });
            return result;
          },
          (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger({ command, args: args.length === 1 ? args[0] : args, result: null, error: msg, durationMs: Math.round(performance.now() - start) });
            throw err;
          },
        );
      };
    },
  }) as typeof api;
}
