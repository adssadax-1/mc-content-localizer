//! 软件自身数据的统计与清理（「关于」页的「清除缓存 / 清除用户数据」）。
//!
//! 安全准则（**任何改动都必须维持**，这是用户明确要求的前提）：
//! 1. 只使用 Tauri 依据应用标识符解析出的目录（`app_config_dir` / `app_local_data_dir`），
//!    不接受前端传入的任何路径，也不猜测、不硬编码目录名；
//! 2. 删除前逐个校验目标位于根目录之内（规范化后前缀比较），**根目录本身永不删除**；
//! 3. 全程 best-effort：被占用/无权限的条目跳过并如实回报，绝不为“删干净”而扩大范围；
//! 4. 游戏目录、导出目录、其他软件目录、旧版本留下的同名目录一律不出现、不触碰。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// WebView2 / Chromium 的缓存类目录名（可随时重建，属「缓存」）
const CACHE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GrShaderCache",
    "ShaderCache",
    "component_crx_cache",
    "extensions_crx_cache",
];

/// 名字是否属于「可随时重建的缓存/诊断数据」。
/// 除固定名单外，统一按「以 cache 结尾」兜底——Chromium 的缓存目录命名都遵循这一点
/// （GPUPersistentCache / old_ShaderCache_* / 各语言变体的 *Cache），避免漏掉新版本改名。
fn is_cache_entry(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    CACHE_DIRS.contains(&name)
        || lower.ends_with("cache")
        || lower.starts_with("old_shadercache")
        || lower == "crashpad"
        || lower == "browsermetrics"
}

/// 会话缓存文件/目录的命名规则（仅在我们自己的配置目录内按名匹配）
fn is_session_cache_name(name: &str) -> bool {
    (name.starts_with("session-cache-") && name.ends_with(".json"))
        || (name.starts_with("session-") && name.ends_with("-shards"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    /// cache / user
    pub group: &'static str,
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub config_dir: String,
    pub local_dir: String,
    pub profile_dir: String,
    pub cache_bytes: u64,
    pub user_bytes: u64,
    pub cache_items: Vec<StorageItem>,
    pub user_items: Vec<StorageItem>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub freed_bytes: u64,
    /// 成功删除的条目（相对路径，供 UI 展示）
    pub removed: Vec<String>,
    /// 被占用/无权限而跳过的条目（正常关闭软件后再清一次即可）
    pub skipped: Vec<String>,
}

/// 目标条目（删除计划的元素）
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    path: PathBuf,
    group: &'static str,
    name: String,
    is_dir: bool,
}

/// 根目录必须「以应用标识符命名」：万一解析结果没带上标识符（极端情况），
/// 宁可不统计、不清理，也绝不把整个 AppData 当成软件数据。
fn root_is_scoped(path: &Path, identifier: &str) -> bool {
    !identifier.is_empty() && path.file_name().map(|n| n == identifier).unwrap_or(false)
}

/// 软件数据根目录：配置目录（设置与服务缓存）+ 本地数据目录（WebView2 配置）
fn roots(app: &AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    let identifier = app.config().identifier.clone();
    let scoped = |p: PathBuf| if root_is_scoped(&p, &identifier) { Some(p) } else { None };
    let cfg = app.path().app_config_dir().ok().and_then(scoped);
    let local = app.path().app_local_data_dir().ok().and_then(scoped);
    (cfg, local)
}

/// WebView2 的配置目录：Tauri 默认落在本地数据目录下的 EBWebView（也兼容直接使用本地数据目录的情况）
fn profile_dir(local: &Path) -> PathBuf {
    let eb = local.join("EBWebView");
    if eb.is_dir() {
        eb
    } else {
        local.to_path_buf()
    }
}

/// 规范化路径：Windows 上 `canonicalize` 会加 `\\?\` 前缀，因此**比较双方必须同源**。
/// 目标可能已被前一步删除（父目录整体删除后子项就没了），此时逐级向上找到仍存在的
/// 祖先目录规范化后再拼回剩余部分，保证与根目录是同一种表示。
fn canon(path: &Path) -> PathBuf {
    if let Ok(c) = path.canonicalize() {
        return c;
    }
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    while let Some(name) = cur.file_name().map(|n| n.to_os_string()) {
        let parent = match cur.parent() {
            Some(p) => p.to_path_buf(),
            None => break,
        };
        rest.push(name);
        if let Ok(cp) = parent.canonicalize() {
            let mut out = cp;
            for n in rest.iter().rev() {
                out.push(n);
            }
            return out;
        }
        cur = parent;
    }
    path.to_path_buf()
}

/// 校验目标确实位于根目录之内，且不是根目录本身（防 `..`、防符号链接逃逸）
fn inside(candidate: &Path, root: &Path) -> bool {
    let c = canon(candidate);
    let r = canon(root);
    c != r && c.starts_with(&r)
}

/// 目录/文件体积（best-effort，不跟随符号链接）
fn size_of(path: &Path) -> u64 {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten() {
            total += size_of(&e.path());
        }
    }
    total
}

/// 列出清理计划：配置文件（设置 / 会话缓存）+ WebView2 配置目录下的缓存与用户数据
fn plan(config: Option<&Path>, local: Option<&Path>) -> Vec<Target> {
    let mut out = Vec::new();

    if let Some(cfg) = config {
        if let Ok(rd) = std::fs::read_dir(cfg) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let is_dir = e.file_type().map(|f| f.is_dir()).unwrap_or(false);
                let group = if is_session_cache_name(&name) { "cache" } else { "user" };
                out.push(Target {
                    path: e.path(),
                    group,
                    name,
                    is_dir,
                });
            }
        }
    }

    if let Some(local) = local {
        let profile = profile_dir(local);
        if let Ok(rd) = std::fs::read_dir(&profile) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let is_dir = e.file_type().map(|f| f.is_dir()).unwrap_or(false);
                let group = if is_cache_entry(&name) { "cache" } else { "user" };
                out.push(Target {
                    path: e.path(),
                    group,
                    name: name.clone(),
                    is_dir,
                });
                // 网页缓存实际落在 <profile>/Default/{Cache, Code Cache, GPUCache…}，
                // 只多看一眼这一层：命中的单列为缓存，其余仍随父目录归入用户数据
                if is_dir && group == "user" {
                    if let Ok(inner) = std::fs::read_dir(e.path()) {
                        for g in inner.flatten() {
                            let gname = g.file_name().to_string_lossy().to_string();
                            if !is_cache_entry(&gname) {
                                continue;
                            }
                            let g_is_dir = g.file_type().map(|f| f.is_dir()).unwrap_or(false);
                            out.push(Target {
                                path: g.path(),
                                group: "cache",
                                name: format!("{}/{}", name, gname),
                                is_dir: g_is_dir,
                            });
                        }
                    }
                }
            }
        }
    }

    // 最后一道护栏：任何不在根目录内的条目直接剔除，永不进入删除流程
    let keep = |t: &Target| -> bool {
        (config.map(|c| inside(&t.path, c)).unwrap_or(false))
            || (local.map(|l| inside(&t.path, l)).unwrap_or(false))
    };
    out.retain(keep);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn to_usage(config: Option<&Path>, local: Option<&Path>, targets: &[Target]) -> StorageUsage {
    let mut usage = StorageUsage {
        config_dir: config.map(|p| p.display().to_string()).unwrap_or_default(),
        local_dir: local.map(|p| p.display().to_string()).unwrap_or_default(),
        profile_dir: local
            .map(|l| profile_dir(l).display().to_string())
            .unwrap_or_default(),
        ..Default::default()
    };
    for t in targets {
        let bytes = size_of(&t.path);
        let item = StorageItem {
            group: t.group,
            name: t.name.clone(),
            path: t.path.display().to_string(),
            bytes,
        };
        if t.group == "cache" {
            usage.cache_bytes += bytes;
            usage.cache_items.push(item);
        } else {
            usage.user_bytes += bytes;
            usage.user_items.push(item);
        }
    }
    usage
}

/// 统计软件自身占用的磁盘空间（缓存 / 用户数据分开）
#[tauri::command]
pub fn storage_usage(app: AppHandle) -> Result<StorageUsage, String> {
    let (cfg, local) = roots(&app);
    let targets = plan(cfg.as_deref(), local.as_deref());
    Ok(to_usage(cfg.as_deref(), local.as_deref(), &targets))
}

/// 执行删除：只删计划内条目，逐个再校验一次归属，失败即跳过（best-effort）
fn run_clear(targets: Vec<Target>, roots_for_check: Vec<PathBuf>) -> ClearResult {
    let mut res = ClearResult::default();
    for t in targets {
        // 删除前再校验：任一时刻路径不在根目录内 → 跳过（不删、不计入）
        if !roots_for_check.iter().any(|r| inside(&t.path, r)) {
            res.skipped.push(t.name);
            continue;
        }
        // 父目录已连带删除（同名条目顺序执行）：视为已完成，不再报「被占用」
        if !t.path.exists() {
            continue;
        }
        let before = size_of(&t.path);
        let ok = if t.is_dir {
            std::fs::remove_dir_all(&t.path).is_ok()
        } else {
            std::fs::remove_file(&t.path).is_ok()
        };
        if ok {
            res.freed_bytes += before;
            res.removed.push(t.name);
        } else {
            // 目录整体删除失败时退化为「清空内容、保留目录」，让还占用中的条目留到下次
            if t.is_dir {
                let mut partial = 0u64;
                if let Ok(rd) = std::fs::read_dir(&t.path) {
                    for e in rd.flatten() {
                        let p = e.path();
                        let b = size_of(&p);
                        let ok_child = if p.is_dir() {
                            std::fs::remove_dir_all(&p).is_ok()
                        } else {
                            std::fs::remove_file(&p).is_ok()
                        };
                        if ok_child {
                            partial += b;
                        }
                    }
                }
                if partial > 0 {
                    res.freed_bytes += partial;
                    res.removed.push(format!("{}（部分）", t.name));
                    continue;
                }
            }
            res.skipped.push(t.name);
        }
    }
    res
}

/// 清除缓存：会话缓存（上次的内容包列表快照）与 WebView2 浏览器缓存。
/// 不影响设置、API Key 与译文产物。
#[tauri::command]
pub fn clear_app_cache(app: AppHandle) -> Result<ClearResult, String> {
    let (cfg, local) = roots(&app);
    let targets: Vec<Target> = plan(cfg.as_deref(), local.as_deref())
        .into_iter()
        .filter(|t| t.group == "cache")
        .collect();
    let check: Vec<PathBuf> = [cfg, local].into_iter().flatten().collect();
    Ok(run_clear(targets, check))
}

/// 清除用户数据：设置（含 API Key、术语表、AI 命名缓存）、会话缓存与 WebView2 配置。
/// 软件目录之外的任何内容都不会被触碰。
#[tauri::command]
pub fn clear_app_data(app: AppHandle) -> Result<ClearResult, String> {
    let (cfg, local) = roots(&app);
    let targets = plan(cfg.as_deref(), local.as_deref());
    let check: Vec<PathBuf> = [cfg, local].into_iter().flatten().collect();
    Ok(run_clear(targets, check))
}

/// 重启软件（清除用户数据后让 WebView2 配置与设置回到全新状态）。
/// 拉起新进程失败时**不退出**，把错误交给界面提示，避免把软件关掉却起不来。
#[tauri::command]
pub fn restart_app(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .spawn()
        .map_err(|e| format!("无法重新启动：{e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path, bytes: usize) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    /// 造一个假的「配置目录 + WebView2 配置目录」树
    fn fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("storage_test_{}", tag));
        let _ = std::fs::remove_dir_all(&base);
        let cfg = base.join("cfg");
        let local = base.join("local");
        let profile = local.join("EBWebView");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::create_dir_all(&profile).unwrap();

        // 配置目录：设置（用户数据）+ 会话缓存（缓存）+ 陈旧遗留文件
        touch(&cfg.join("settings.json"), 100);
        touch(&cfg.join("session-cache-free.json"), 50);
        touch(&cfg.join("session-free-shards/shard-1.json"), 20);
        touch(&cfg.join("legacy-note.txt"), 5);

        // WebView2 配置目录：根层缓存 + 用户数据，以及 Default 一层里的网页缓存
        touch(&profile.join("GPUCache/data_0"), 200);
        touch(&profile.join("ShaderCache/js/x"), 100);
        touch(&profile.join("Local State"), 10);
        touch(&profile.join("Default/Cache/data_1"), 300);
        touch(&profile.join("Default/Code Cache/js/y"), 150);
        touch(&profile.join("Default/Local Storage/leveldb/000001.log"), 80);

        (base, cfg, local)
    }

    #[test]
    fn plan_partitions_cache_and_user_within_roots() {
        let (base, cfg, local) = fixture("plan");
        let targets = plan(Some(&cfg), Some(&local));
        let by_group = |g: &str| -> Vec<String> {
            targets
                .iter()
                .filter(|t| t.group == g)
                .map(|t| t.name.clone())
                .collect()
        };
        let cache = by_group("cache");
        let user = by_group("user");

        assert!(cache.contains(&"session-cache-free.json".to_string()));
        assert!(cache.contains(&"session-free-shards".to_string()));
        assert!(cache.contains(&"GPUCache".to_string()));
        assert!(cache.contains(&"ShaderCache".to_string()));
        // Default 一层的网页缓存必须归入缓存，否则「清除缓存」会漏掉上百 MB
        assert!(cache.contains(&"Default/Cache".to_string()));
        assert!(cache.contains(&"Default/Code Cache".to_string()));

        assert!(user.contains(&"settings.json".to_string()));
        assert!(user.contains(&"legacy-note.txt".to_string()));
        assert!(user.contains(&"Default".to_string()));
        assert!(user.contains(&"Local State".to_string()));

        // 计划内的每一条都必须位于两个根目录之内（绝不越界）
        for t in &targets {
            assert!(
                inside(&t.path, &cfg) || inside(&t.path, &local),
                "计划里的条目越界：{}",
                t.path.display()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn inside_guard_rejects_root_and_escape() {
        let base = std::env::temp_dir().join("storage_test_guard");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("inner")).unwrap();
        std::fs::write(base.join("inner/a.txt"), b"x").unwrap();
        std::fs::create_dir_all(base.join("sibling")).unwrap();

        assert!(inside(&base.join("inner"), &base));
        assert!(inside(&base.join("inner/a.txt"), &base));
        // 根目录本身永不可删
        assert!(!inside(&base, &base));
        // 越过根目录的路径被拒
        assert!(!inside(&base.join("..").join("sibling"), &base));
        assert!(!inside(&base.parent().unwrap(), &base));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn clear_cache_keeps_user_data_and_never_touches_outside() {
        let (base, cfg, local) = fixture("cache");
        // 根目录之外放一个“别人的”文件，删除后必须毫发无损
        let outsider = base.join("outsider.txt");
        std::fs::write(&outsider, b"keep me").unwrap();

        let targets: Vec<Target> = plan(Some(&cfg), Some(&local))
            .into_iter()
            .filter(|t| t.group == "cache")
            .collect();
        let res = run_clear(targets, vec![cfg.clone(), local.clone()]);

        assert!(res.freed_bytes >= 750, "应统计到释放的缓存字节");
        assert!(res.skipped.is_empty(), "正常文件不应被跳过：{:?}", res.skipped);
        // 缓存清了（含 Default 层里的网页缓存）
        assert!(!cfg.join("session-cache-free.json").exists());
        assert!(!cfg.join("session-free-shards").exists());
        assert!(!local.join("EBWebView/GPUCache").exists());
        assert!(!local.join("EBWebView/Default/Cache").exists());
        assert!(!local.join("EBWebView/Default/Code Cache").exists());
        // 设置与 WebView2 里的用户数据保留（Default 目录本身保留，其余内容仍在）
        assert!(cfg.join("settings.json").exists());
        assert!(local.join("EBWebView/Default").exists());
        assert!(local
            .join("EBWebView/Default/Local Storage/leveldb/000001.log")
            .exists());
        // 根目录外的文件不受影响
        assert!(outsider.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn clear_all_removes_app_data_only() {
        let (base, cfg, local) = fixture("all");
        let outsider = base.join("outsider.txt");
        std::fs::write(&outsider, b"keep me").unwrap();

        let res = run_clear(plan(Some(&cfg), Some(&local)), vec![cfg.clone(), local.clone()]);

        assert!(res.freed_bytes >= 840);
        assert!(res.skipped.is_empty(), "跳过项：{:?}", res.skipped);
        assert!(!cfg.join("settings.json").exists());
        assert!(!local.join("EBWebView/Default").exists());
        assert!(!local.join("EBWebView/Local State").exists());
        assert!(outsider.exists(), "软件目录之外的文件绝不能被删");
        // 根目录本身仍然存在（只清内容，不删目录）
        assert!(cfg.exists() && local.join("EBWebView").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn session_cache_name_matching() {
        assert!(is_session_cache_name("session-cache-free.json"));
        assert!(is_session_cache_name("session-cache-gamedir.json"));
        assert!(is_session_cache_name("session-free-shards"));
        assert!(!is_session_cache_name("settings.json"));
        assert!(!is_session_cache_name("session-cache-free.json.bak"));
        assert!(!is_session_cache_name("session-"));
    }

    #[test]
    fn cache_entry_recognition() {
        for n in ["Cache", "Code Cache", "GPUCache", "ShaderCache", "DawnGraphiteCache", "GPUPersistentCache", "old_ShaderCache_000", "component_crx_cache", "Crashpad", "BrowserMetrics"] {
            assert!(is_cache_entry(n), "{n} 应被识别为缓存");
        }
        for n in ["Default", "Local State", "Local Storage", "Session Storage", "IndexedDB", "Preferences", "Network", "lockfile"] {
            assert!(!is_cache_entry(n), "{n} 不应被识别为缓存");
        }
    }

    /// 根目录必须以应用标识符结尾：否则一律不清理（防「整个 AppData 被当成软件数据」）
    #[test]
    fn roots_must_end_with_identifier() {
        let id = "com.administrator.mod-translator";
        assert!(root_is_scoped(
            Path::new("C:/Users/x/AppData/Roaming/com.administrator.mod-translator"),
            id
        ));
        assert!(root_is_scoped(
            Path::new("C:/Users/x/AppData/Local/com.administrator.mod-translator"),
            id
        ));
        // 未附加标识符的共享目录 / 空标识符：一律拒绝
        assert!(!root_is_scoped(Path::new("C:/Users/x/AppData/Roaming"), id));
        assert!(!root_is_scoped(Path::new("C:/Users/x/AppData/Local"), id));
        assert!(!root_is_scoped(
            Path::new("C:/Users/x/AppData/Local/com.administrator.mod-translator"),
            ""
        ));
    }
}
