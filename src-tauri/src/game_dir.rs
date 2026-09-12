//! 游戏目录模式：扫描 .minecraft / versions / 单版本文件夹（只读，不写入游戏目录）。
//!
//! 两段式设计：scan 只读文件清单（不解析内容包），解析由前端按需调用 parse_game_pack。

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
    /// 版本文件夹名（唯一展示名）
    pub dir_name: String,
    /// 从 json 读取的游戏版本（无则取文件夹名）
    pub mc_version: Option<String>,
    /// 版本文件夹是否含版本 jar/json（否则标灰"无可翻译文本"）
    pub valid: bool,
    pub mods: Vec<GamePackEntry>,
    pub resourcepacks: Vec<GamePackEntry>,
    pub shaderpacks: Vec<GamePackEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDirScan {
    pub root: String,
    /// 根目录三文件夹（虚拟"公共目录"分组）
    pub root_group: GameVersionGroup,
    pub versions: Vec<GameVersionGroup>,
}

fn scan_dir_packs(dir: &std::path::Path, kind: &str) -> Vec<GamePackEntry> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let ext = p.extension().and_then(|x| x.to_str()).map(|x| x.to_lowercase());
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
                file_name: p.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(),
                size: e.metadata().map(|m| m.len()).unwrap_or(0),
                kind: kind.to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()));
    out
}

fn sub_dirs_with_version_marker(dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            // 判定规则：含 <文件夹名>.jar / <文件夹名>.json，或任意 <*.jar + *.json> 组合
            let has_named = p.join(format!("{}.jar", name)).is_file() || p.join(format!("{}.json", name)).is_file();
            let has_any = std::fs::read_dir(&p)
                .map(|rd| {
                    let mut jar = false;
                    let mut json = false;
                    for f in rd.flatten() {
                        let n = f.file_name().to_string_lossy().to_lowercase();
                        if n.ends_with(".jar") {
                            jar = true;
                        }
                        if n.ends_with(".json") {
                            json = true;
                        }
                    }
                    jar && json
                })
                .unwrap_or(false);
            if has_named || has_any {
                out.push(name);
            }
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    out
}

/// 从版本文件夹内的 <name>.json 读取游戏版本（id 字段）
fn read_mc_version(vdir: &std::path::Path, dir_name: &str) -> Option<String> {
    let candidates = [
        vdir.join(format!("{}.json", dir_name)),
        vdir.join(format!("{}.json", dir_name.replace(' ', "_"))),
    ];
    for c in candidates {
        if let Ok(text) = std::fs::read_to_string(&c) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    return Some(id.to_string());
                }
            }
        }
    }
    // 兜底：任意 *.json 里带 "id" 字段的第一个
    if let Ok(rd) = std::fs::read_dir(vdir) {
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

fn group_from(dir: &std::path::Path, dir_name: &str, valid: bool) -> GameVersionGroup {
    GameVersionGroup {
        dir_name: dir_name.to_string(),
        mc_version: None,
        valid,
        mods: scan_dir_packs(&dir.join("mods"), "mod"),
        resourcepacks: scan_dir_packs(&dir.join("resourcepacks"), "resourcepack"),
        shaderpacks: scan_dir_packs(&dir.join("shaderpacks"), "shader"),
    }
}

/// 扫描游戏目录：versions 下的各版本 + 根目录三文件夹（虚拟"公共目录"）
#[tauri::command]
pub async fn scan_game_dir(app: AppHandle, root: String) -> Result<GameDirScan, String> {
    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        return Err("目录不存在".to_string());
    }
    GAME_SCAN_CANCEL.store(false, Ordering::Relaxed);

    let versions_dir = root_path.join("versions");
    let version_names = if versions_dir.is_dir() {
        sub_dirs_with_version_marker(&versions_dir)
    } else {
        Vec::new()
    };

    // 根目录公共分组
    let mut root_group = group_from(root_path, "公共目录", true);
    root_group.mc_version = None;

    let total = version_names.len();
    let mut versions: Vec<GameVersionGroup> = Vec::new();
    for (i, name) in version_names.iter().enumerate() {
        if GAME_SCAN_CANCEL.load(Ordering::Relaxed) {
            return Err("已取消".to_string());
        }
        let vdir = versions_dir.join(name);
        let mut g = group_from(&vdir, name, true);
        g.mc_version = read_mc_version(&vdir, name);
        versions.push(g);
        let _ = app.emit(
            "game-scan-progress",
            serde_json::json!({ "done": i + 1, "total": total, "current": name }),
        );
    }

    Ok(GameDirScan {
        root: root.to_string(),
        root_group,
        versions,
    })
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

/// 供前端检查应用配置目录（会话缓存等）
pub fn app_config_dir_exists(app: &AppHandle) -> bool {
    app.path().app_config_dir().is_ok()
}

