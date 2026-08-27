use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};

use crate::core::model::{LangEntry, LangFormat, ModFile};
use crate::settings::{Settings, ThreadingConfig};
use crate::translate::pipeline::{self, BatchItem, TranslateContext, TranslatedItem};
use crate::translate::provider::{OpenAiProvider, ProviderConfig};

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("settings.json")
}

/// 翻译取消标志：前端调用 cancel_translation 置位，翻译循环每批检查
static CANCEL_TRANSLATION: AtomicBool = AtomicBool::new(false);
/// 翻译暂停标志：置位后翻译循环在批次间等待，直到恢复或取消
static PAUSE_TRANSLATION: AtomicBool = AtomicBool::new(false);

/// 单条实时翻译结果事件（逐批推送到前端，供实时显示与存储）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryTranslatedEvent {
    pub key: String,
    pub translation: String,
    pub notes: Vec<String>,
    /// 结果类型：ok 成功 / empty AI 未返回 / error 翻译失败
    pub kind: String,
}

/// 将一批翻译结果推送到前端（实时写入，不等待全部完成）
fn emit_batch(app: &AppHandle, pack_key: &str, results: &[TranslatedItem]) {
    let items: Vec<EntryTranslatedEvent> = results
        .iter()
        .map(|t| {
            let kind = if !t.translation.trim().is_empty() {
                "ok".to_string()
            } else if t.notes.iter().any(|n| n.starts_with("翻译失败")) {
                "error".to_string()
            } else {
                "empty".to_string()
            };
            EntryTranslatedEvent {
                key: t.key.clone(),
                translation: t.translation.clone(),
                notes: t.notes.clone(),
                kind,
            }
        })
        .collect();
    let _ = app.emit(
        "translation-batch",
        serde_json::json!({ "packKey": pack_key, "items": items }),
    );
}

/// 取消当前翻译任务
#[tauri::command]
pub fn cancel_translation() {
    CANCEL_TRANSLATION.store(true, Ordering::Relaxed);
}

/// 暂停当前翻译（当前批次完成后暂停）
#[tauri::command]
pub fn pause_translation() {
    PAUSE_TRANSLATION.store(true, Ordering::Relaxed);
}

/// 继续被暂停的翻译
#[tauri::command]
pub fn resume_translation() {
    PAUSE_TRANSLATION.store(false, Ordering::Relaxed);
}

/// 解析模组 jar，返回模组信息与全部语言条目
#[tauri::command]
pub fn parse_jar(path: String) -> Result<ModFile, String> {
    crate::core::jar::parse_jar(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// 执行 AI 翻译：提取术语表 → 分批翻译 → 占位符校验。
/// 支持多线程并行（实验性，见 Settings.threading）。
/// 进度通过 "translate-progress" / "glossary-done" 事件推送到前端。
#[tauri::command]
pub async fn run_translation(
    app: AppHandle,
    config: ProviderConfig,
    ctx: TranslateContext,
    items: Vec<BatchItem>,
    pack_key: String,
    batch_size: Option<usize>,
    extract_glossary: Option<bool>,
    threading: Option<ThreadingConfig>,
) -> Result<Vec<TranslatedItem>, String> {
    let provider = OpenAiProvider::new(config);
    // 诊断信息：报错时附上实际请求参数，方便定位
    let diag = format!(
        "model={}, temperature={}",
        provider.config.resolve_endpoint().1,
        provider.config.temperature()
    );
    let batch_size = batch_size.unwrap_or(40).clamp(5, 200);
    let threading = threading.unwrap_or_default();
    let threads = if threading.enabled {
        threading.thread_count.max(1)
    } else {
        1
    };
    let mut glossary: Vec<(String, String)> = Vec::new();

    // 第一轮：提取术语表
    if extract_glossary.unwrap_or(true) {
        let samples = pipeline::pick_glossary_samples(&items, 120);
        if !samples.is_empty() {
            match pipeline::extract_glossary(&provider, &samples).await {
                Ok(g) => {
                    glossary = g;
                    let _ = app.emit(
                        "glossary-done",
                        serde_json::json!({
                            "count": glossary.len(),
                            "glossary": glossary,
                        }),
                    );
                }
                Err(_) => {}
            }
        }
    }

    let total = items.len();
    let batch_count = items.chunks(batch_size).count();
    // 开始翻译前重置取消/暂停标志
    CANCEL_TRANSLATION.store(false, Ordering::Relaxed);
    PAUSE_TRANSLATION.store(false, Ordering::Relaxed);

    // 单线程：串行批处理（保持原有行为）
    if threads <= 1 {
        let mut results: Vec<TranslatedItem> = Vec::with_capacity(total);
        let mut done = 0;
        for (idx, chunk) in items.chunks(batch_size).enumerate() {
            // 暂停：在批次间等待，直到继续或取消
            wait_pause().await;
            // 用户取消：停止后续批次，保留已翻译部分
            if CANCEL_TRANSLATION.load(Ordering::Relaxed) {
                break;
            }
            let translated = process_chunk(&provider, &ctx, &glossary, chunk, &diag).await;
            emit_batch(&app, &pack_key, &translated);
            done += chunk.len();
            results.extend(translated);
            let _ = app.emit(
                "translate-progress",
                serde_json::json!({
                    "batchIndex": idx + 1,
                    "batchTotal": batch_count,
                    "doneCount": done,
                    "totalCount": total,
                }),
            );
        }
        // 结束（完成/取消/暂停遗留）后复位标志
        CANCEL_TRANSLATION.store(false, Ordering::Relaxed);
        PAUSE_TRANSLATION.store(false, Ordering::Relaxed);
        return Ok(results);
    }

    // 多线程并行（实验性）：把批次分给 N 个 worker，每个 worker 独立请求模型
    let chunks: Vec<Vec<BatchItem>> = items.chunks(batch_size).map(|c| c.to_vec()).collect();
    let mut worker_chunks = vec![Vec::new(); threads];
    for (i, ch) in chunks.into_iter().enumerate() {
        worker_chunks[i % threads].push(ch);
    }

    let results: Arc<Mutex<Vec<TranslatedItem>>> = Arc::new(Mutex::new(Vec::new()));
    let done_count = Arc::new(AtomicUsize::new(0));
    let interval = std::time::Duration::from_secs(threading.request_interval_sec.max(1));

    let mut handles = Vec::new();
    for wchunks in worker_chunks {
        if wchunks.is_empty() {
            continue;
        }
        let provider = provider.clone();
        let ctx = ctx.clone();
        let glossary = glossary.clone();
        let app = app.clone();
        let results = results.clone();
        let done_count = done_count.clone();
        let diag = diag.clone();
        let pack_key = pack_key.clone();
        let total = total;
        let batch_count = batch_count;
        handles.push(tokio::spawn(async move {
            let mut processed = 0usize;
            for chunk in wchunks {
                wait_pause().await;
                if CANCEL_TRANSLATION.load(Ordering::Relaxed) {
                    return;
                }
                let translated = process_chunk(&provider, &ctx, &glossary, &chunk, &diag).await;
                emit_batch(&app, &pack_key, &translated);
                {
                    let mut lock = results.lock().unwrap();
                    lock.extend(translated);
                }
                let done = done_count.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len();
                processed += 1;
                let _ = app.emit(
                    "translate-progress",
                    serde_json::json!({
                        "batchIndex": processed,
                        "batchTotal": batch_count,
                        "doneCount": done,
                        "totalCount": total,
                    }),
                );
                // 线程间请求间隔：降低限流概率
                tokio::time::sleep(interval).await;
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    CANCEL_TRANSLATION.store(false, Ordering::Relaxed);
    PAUSE_TRANSLATION.store(false, Ordering::Relaxed);
    let final_results = Arc::try_unwrap(results)
        .map_err(|_| "并发结果收集失败".to_string())?
        .into_inner()
        .map_err(|_| "并发结果锁失败".to_string())?;
    Ok(final_results)
}

/// 等待暂停解除（暂停期间每 300ms 检查一次取消）
async fn wait_pause() {
    while PAUSE_TRANSLATION.load(Ordering::Relaxed) {
        if CANCEL_TRANSLATION.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
}

/// 翻译单个批次并合并结果（成功 / 缺失 / 失败）
async fn process_chunk(
    provider: &OpenAiProvider,
    ctx: &TranslateContext,
    glossary: &[(String, String)],
    chunk: &[BatchItem],
    diag: &str,
) -> Vec<TranslatedItem> {
    match pipeline::translate_batch(provider, ctx, glossary, chunk).await {
        Ok(res) => {
            let mut out = res.translated;
            for key in res.missing {
                out.push(TranslatedItem {
                    key,
                    translation: String::new(),
                    notes: vec!["AI 未返回该条目".to_string()],
                });
            }
            out
        }
        Err(e) => chunk
            .iter()
            .map(|i| TranslatedItem {
                key: i.key.clone(),
                translation: String::new(),
                notes: vec![format!("翻译失败：{}（请求参数：{}）", e, diag)],
            })
            .collect(),
    }
}

/// 导出汉化资源包 zip，返回生成的文件路径
#[tauri::command]
pub fn export_resource_pack(
    dest_dir: String,
    modid: String,
    mod_name: String,
    entries: Vec<LangEntry>,
    lang_format: LangFormat,
    pack_format: u32,
) -> Result<String, String> {
    crate::export::export_resource_pack(
        std::path::Path::new(&dest_dir),
        &modid,
        &mod_name,
        &entries,
        lang_format,
        pack_format,
    )
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Settings {
    let path = settings_path(&app);
    Settings::load(&path)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app);
    settings.save(&path)
}

/// 拉取所选 provider 的可用模型列表
#[tauri::command]
pub async fn list_models(config: ProviderConfig) -> Result<Vec<crate::translate::provider::ModelInfo>, String> {
    let provider = OpenAiProvider::new(config);
    provider.list_models().await.map_err(|e| e.to_string())
}

/// 多模组合并导出汉化资源包（一个 zip 管所有模组），返回生成的文件路径
#[tauri::command]
pub fn export_resource_pack_multi(
    dest_dir: String,
    bundles: Vec<crate::export::ResourcePackBundle>,
    pack_format: u32,
) -> Result<String, String> {
    crate::export::export_resource_pack_multi(
        std::path::Path::new(&dest_dir),
        &bundles,
        pack_format,
    )
}

/// 生成汉化后的模组 jar（复制原 jar + 写入 zh_cn，不覆盖原文件）
#[tauri::command]
pub fn export_mod_jar(
    source: String,
    dest: String,
    modid: String,
    entries: Vec<LangEntry>,
    lang_format: LangFormat,
) -> Result<String, String> {
    crate::export::export_mod_jar(
        std::path::Path::new(&source),
        std::path::Path::new(&dest),
        &modid,
        &entries,
        lang_format,
    )
}

/// 更新信息（供前端检查更新提示）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub latest_version: String,
    pub url: String,
}

/// 静默检查 GitHub 最新 Release：
/// - Ok(Some) 有新版本
/// - Ok(None) 已是最新
/// - Err(消息) 网络失败/访问不了 GitHub
#[tauri::command]
pub async fn check_update() -> Result<Option<UpdateInfo>, String> {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Err("无法初始化网络请求".to_string()),
    };
    let resp = match client
        .get("https://api.github.com/repos/adssadax-1/mc-content-localizer/releases/latest")
        .header("User-Agent", "mc-content-localizer")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Err("连接不到 GitHub，无法检查更新".to_string()),
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Err("GitHub 响应解析失败".to_string()),
    };
    let tag = json
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let url = json
        .get("html_url")
        .and_then(|u| u.as_str())
        .unwrap_or("https://github.com/adssadax-1/mc-content-localizer/releases")
        .to_string();
    let current = env!("CARGO_PKG_VERSION");
    if tag.is_empty() || tag == current {
        return Ok(None);
    }
    Ok(Some(UpdateInfo {
        latest_version: tag,
        url,
    }))
}

/// 获取某类型提示词模板（默认可编辑段 + 系统保留核心段），供前端编辑器展示
#[tauri::command]
pub fn get_prompt_template(
    pack_type: String,
) -> Result<crate::translate::pipeline::PromptTemplate, String> {
    Ok(crate::translate::pipeline::prompt_template(&pack_type))
}

/// 深度扫描 jar 内的所有可能文本（含嵌套 jar 递归）
#[tauri::command]
pub fn deep_scan_jar(
    path: String,
    modid: String,
) -> Result<crate::core::deep_scan::DeepScanResult, String> {
    crate::core::deep_scan::deep_scan_jar(std::path::Path::new(&path), &modid)
        .map_err(|e| e.to_string())
}

/// 扫描 zip 判定内容包类型（mod/shader/resourcepack）
#[tauri::command]
pub fn detect_pack_type(path: String) -> Result<crate::core::pack::PackType, String> {
    crate::core::pack::detect_pack_type(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// 解析光影包（shaders.properties / shaders/lang/en_US.lang + zh_CN.lang）
#[tauri::command]
pub fn parse_shader_pack(path: String) -> Result<crate::core::pack::ShaderPack, String> {
    crate::core::pack::parse_shader_pack(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// 解析资源包（pack.mcmeta description）
#[tauri::command]
pub fn parse_resource_pack(path: String) -> Result<crate::core::pack::ResourcePackInfo, String> {
    crate::core::pack::parse_resource_pack(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

/// 导出汉化光影包（复制原 zip + 写入 shaders/lang/zh_CN.lang）
#[tauri::command]
pub fn export_shader_zh(
    source: String,
    dest: String,
    entries: Vec<LangEntry>,
) -> Result<String, String> {
    crate::core::pack::export_shader_zh(
        std::path::Path::new(&source),
        std::path::Path::new(&dest),
        &entries,
    )
}

/// 导出改描述后的资源包（更新 pack.mcmeta description）
#[tauri::command]
pub fn export_resource_pack_desc(
    source: String,
    dest: String,
    entries: Vec<LangEntry>,
) -> Result<String, String> {
    crate::core::pack::export_resource_pack_desc(
        std::path::Path::new(&source),
        std::path::Path::new(&dest),
        &entries,
    )
}
