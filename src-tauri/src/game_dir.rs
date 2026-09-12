//! 游戏目录模式：扫描 .minecraft / versions / 任意文件夹（递归向下，只读）。
//!
//! 两段式设计：scan 只读文件清单（不解析内容包），解析由前端按需调用既有命令。
//! 递归规则：从根目录向下查找包含 mods / resourcepacks / shaderpacks 子目录的文件夹，
//! 每个这样的文件夹就是一个"版本分组"（相对路径作为分组名）；跳过库/存档/缓存等无关目录。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static GAME_SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GamePackEntry {
    /// 完整路径（唯一标识）
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// mod | shader | resourcepack
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersionGroup {
    /// 相对根目录的路径（"" = 公共目录）
    pub rel_path: String,
    /// 展示名（最后一段；前端负责重名消歧）
    pub dir_name: String,
    /// 从 json 读取的游戏版本（有才显示）
    pub mc_version: Option<String>,
    /// 是否含版本 jar/json（老判定，仅供参考）
    pub valid: bool,
    pub mods: Vec<GamePackEntry>,
    pub resourcepacks: Vec<GamePackEntry>,
    pub shaderpacks: Vec<GamePackEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDirScan {
    pub root: String,
    /// 相对路径 "" = 公共目录（排最前）
    pub groups: Vec<GameVersionGroup>,
}

fn scan_dir_packs(dir: &std::path::Path, kind: &str) -> Vec<GamePackEntry> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.to_lowercase());
            let ok = match kind {
                "mod" => ext.as_deref() == Some("jar"),
                "shader" | "resourcepack" => ext.as_deref() == Some("zip"),
                _ => false,
            };
            if !ok {
                continue;
            }
            out.push(GamePackEntry {
                path: p.to_string_lossy().to_string(),
                file_name: p
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size: e.metadata().map(|m| m.len()).unwrap_or(0),
                kind: kind.to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    out
}

/// 递归向下扫描：找到所有含 mods / resourcepacks / shaderpacks 的文件夹作为版本分组
fn collect_groups(
    dir: &std::path::Path,
    rel: &str,
    depth: usize,
    app: &AppHandle,
    out: &mut Vec<GameVersionGroup>,
) -> bool {
    if depth > 5 || GAME_SCAN_CANCEL.load(Ordering::Relaxed) {
        return false;
    }
    let mods = scan_dir_packs(&dir.join("mods"), "mod");
    let rps = scan_dir_packs(&dir.join("resourcepacks"), "resourcepack");
    let sps = scan_dir_packs(&dir.join("shaderpacks"), "shader");
    let has = !mods.is_empty() || !rps.is_empty() || !sps.is_empty();

    if has {
        let dir_name = rel.split('/').next_back().unwrap_or(rel).to_string();
        out.push(GameVersionGroup {
            rel_path: rel.to_string(),
            dir_name,
            mc_version: None,
            valid: dir
                .join(format!("{}.json", rel.split('/').next_back().unwrap_or("")))
                .is_file(),
            mods,
            resourcepacks: rps,
            shaderpacks: sps,
        });
        let _ = app.emit(
            "game-scan-progress",
            serde_json::json!({ "done": out.len(), "total": 0, "current": rel }),
        );
    }

    // 继续向下递归（跳过已识别的内容包目录与无关大目录）
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            // 精确跳过无关大目录（不再一刀切跳过隐藏目录——.minecraft 本身就是隐藏名）
            if matches!(
                name.as_str(),
                "libraries"
                    | "saves"
                    | "assets"
                    | "logs"
                    | "crash-reports"
                    | "cache"
                    | "downloads"
                    | "kubejs"
                    | "patchouli_books"
                    | "natives"
                    | ".gradle"
                    | ".cache"
                    | "Cache"
                    | "cococa"
            ) || name.ends_with("-natives")
                || name == ".voxy"
                || name == ".physics_mod_cache"
                || name == ".earlyloadingscreen-transformer-output"
                || name == ".replay_cache"
            {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel, name)
            };
            collect_groups(&p, &child_rel, depth + 1, app, out);
        }
    }
    GAME_SCAN_CANCEL.load(Ordering::Relaxed)
}

/// 从分组文件夹内的 *.json 读取游戏版本（id 字段）
fn read_mc_version(dir: &std::path::Path) -> Option<String> {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.to_lowercase().ends_with(".json") {
                if let Ok(text) = std::fs::read_to_string(e.path()) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                            return Some(id.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// 扫描游戏目录：递归向下找出所有内容包分组（只读清单，不解析内容包）
#[tauri::command]
pub async fn scan_game_dir(app: AppHandle, root: String) -> Result<GameDirScan, String> {
    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        return Err("目录不存在".to_string());
    }
    GAME_SCAN_CANCEL.store(false, Ordering::Relaxed);

    let mut groups: Vec<GameVersionGroup> = Vec::new();
    collect_groups(root_path, "", 0, &app, &mut groups);

    // 空分组（无内容包）不返回；公共目录（""）排最前；其余按路径排序
    groups.retain(|g| {
        !g.mods.is_empty() || !g.resourcepacks.is_empty() || !g.shaderpacks.is_empty()
    });
    for g in &mut groups {
        if !g.rel_path.is_empty() {
            g.mc_version = read_mc_version(root_path.join(&g.rel_path).as_path());
        }
    }
    groups.sort_by(|a, b| {
        if a.rel_path.is_empty() {
            return std::cmp::Ordering::Less;
        }
        if b.rel_path.is_empty() {
            return std::cmp::Ordering::Greater;
        }
        a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase())
    });

    Ok(GameDirScan { root, groups })
}

#[tauri::command]
pub fn cancel_game_scan() {
    GAME_SCAN_CANCEL.store(true, Ordering::Relaxed);
}

/// 判断路径是否为文件夹（前端导入路由：文件夹→游戏目录模式，文件→自由导入）
#[tauri::command]
pub fn path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}
