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
    /// 服务器插件（服务器根目录 plugins/ 下）
    pub plugins: Vec<GamePackEntry>,
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
                "mod" | "plugin" => ext.as_deref() == Some("jar"),
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

/// 按 jar 清单内容判定类型（文件夹名仅作为识别失败时的兜底）：
/// 插件清单 → plugin；模组清单 → mod。避免把插件当模组解析导致后续失败
fn detect_jar_kind(p: &std::path::Path, hint: &str) -> &'static str {
    match crate::core::pack::detect_pack_type(p) {
        Ok(crate::core::pack::PackType::Plugin) => "plugin",
        Ok(crate::core::pack::PackType::Mod) => "mod",
        _ => {
            if hint == "plugins" {
                "plugin"
            } else {
                "mod"
            }
        }
    }
}

/// 扫描目录下的 jar，按内容拆分为（模组, 插件）两组。
/// mods/ 里误放的插件、plugins/ 里误放的模组都能被正确打标签。
fn scan_dir_jars_typed(
    dir: &std::path::Path,
    hint: &str,
) -> (Vec<GamePackEntry>, Vec<GamePackEntry>) {
    let mut mods = Vec::new();
    let mut plugins = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let is_jar = p
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("jar"))
                .unwrap_or(false);
            if !is_jar {
                continue;
            }
            let kind = detect_jar_kind(&p, hint);
            let entry = GamePackEntry {
                path: p.to_string_lossy().to_string(),
                file_name: p
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size: e.metadata().map(|m| m.len()).unwrap_or(0),
                kind: kind.to_string(),
            };
            if kind == "plugin" {
                plugins.push(entry);
            } else {
                mods.push(entry);
            }
        }
    }
    let cmp = |a: &GamePackEntry, b: &GamePackEntry| {
        a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase())
    };
    mods.sort_by(cmp);
    plugins.sort_by(cmp);
    (mods, plugins)
}

/// 直接扫描目录内的内容包文件（文件夹名作为分类提示，名称不匹配时读 zip 内容判定）
fn scan_dir_packs_direct(
    dir: &std::path::Path,
) -> (
    Vec<GamePackEntry>,
    Vec<GamePackEntry>,
    Vec<GamePackEntry>,
    Vec<GamePackEntry>,
) {
    let name_hint = dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let mut mods = Vec::new();
    let mut rps = Vec::new();
    let mut sps = Vec::new();
    let mut pls = Vec::new();

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

            let kind: &str = match (name_hint.as_str(), ext.as_deref()) {
                // 任意文件夹下的 .jar：读清单判定模组 / 插件（文件名不可靠时以内容为准）
                (hint, Some("jar")) => detect_jar_kind(&p, hint),
                // 文件夹名为 resourcepacks → .zip = resourcepack
                ("resourcepacks", Some("zip")) => "resourcepack",
                // 文件夹名为 shaderpacks → .zip = shader
                ("shaderpacks", Some("zip")) => "shader",
                // 通用文件夹：.zip → 读 zip 中央目录判定类型
                (_, Some("zip")) => {
                    match crate::core::pack::detect_pack_type(&p) {
                        Ok(crate::core::pack::PackType::Shader) => "shader",
                        Ok(crate::core::pack::PackType::ResourcePack) => "resourcepack",
                        Ok(crate::core::pack::PackType::Mod) => "mod",
                        Ok(crate::core::pack::PackType::Plugin) => "plugin",
                        Err(_) => "resourcepack", // 无法识别时默认资源包
                    }
                }
                _ => continue,
            };

            let entry = GamePackEntry {
                path: p.to_string_lossy().to_string(),
                file_name: p
                    .file_name()
                    .map(|x| x.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size: e.metadata().map(|m| m.len()).unwrap_or(0),
                kind: kind.to_string(),
            };
            match kind {
                "mod" => mods.push(entry),
                "resourcepack" => rps.push(entry),
                "shader" => sps.push(entry),
                "plugin" => pls.push(entry),
                _ => {}
            }
        }
    }

    let cmp = |a: &GamePackEntry, b: &GamePackEntry| {
        a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase())
    };
    mods.sort_by(cmp);
    rps.sort_by(cmp);
    sps.sort_by(cmp);
    pls.sort_by(cmp);

    (mods, rps, sps, pls)
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
    let (mut mods, mut pls) = scan_dir_jars_typed(&dir.join("mods"), "mods");
    let (extra_mods, extra_pls) = scan_dir_jars_typed(&dir.join("plugins"), "plugins");
    mods.extend(extra_mods);
    pls.extend(extra_pls);
    let mut rps = scan_dir_packs(&dir.join("resourcepacks"), "resourcepack");
    let mut sps = scan_dir_packs(&dir.join("shaderpacks"), "shader");
    // 仅扫描根目录：把根文件夹直接包含的 .jar/.zip 并入根分组
    // （用户直接指向 mods 等内容包文件夹时也能识别；子层级不扫描，避免把
    //   processedMods 等杂文件夹误判为版本分组）
    if depth == 0 {
        let (dm, dr, ds, dp) = scan_dir_packs_direct(dir);
        if !dm.is_empty() || !dr.is_empty() || !ds.is_empty() || !dp.is_empty() {
            mods.extend(dm);
            rps.extend(dr);
            sps.extend(ds);
            pls.extend(dp);
            let cmp = |a: &GamePackEntry, b: &GamePackEntry| {
                a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase())
            };
            mods.sort_by(cmp);
            rps.sort_by(cmp);
            sps.sort_by(cmp);
            pls.sort_by(cmp);
        }
    }
    let has = !mods.is_empty() || !rps.is_empty() || !sps.is_empty() || !pls.is_empty();

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
            plugins: pls,
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
            // 精确跳过无关大目录 + 内容包子目录（父级已扫描，防止重复）
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
                    | "mods"
                    | "resourcepacks"
                    | "shaderpacks"
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
        !g.mods.is_empty()
            || !g.resourcepacks.is_empty()
            || !g.shaderpacks.is_empty()
            || !g.plugins.is_empty()
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


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_jar(path: &std::path::Path, files: &[(&str, &str)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, content) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    /// 回归：文件夹名与内容不一致时以内容为准
    /// （用户把插件放在名为"下载"的文件夹里，此前被当成模组，导致解析失败后包丢失）
    #[test]
    fn direct_scan_detects_plugin_by_manifest_not_folder_name() {
        let dir = std::env::temp_dir().join("gd_scan_plugin_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_jar(
            &dir.join("LuckPerms.jar"),
            &[("plugin.yml", "name: LuckPerms
version: 5.4
main: me.lucko.Main
")],
        );
        write_jar(
            &dir.join("RealMod.jar"),
            &[(
                "fabric.mod.json",
                r#"{"id":"realmod","name":"Real Mod","version":"1.0"}"#,
            )],
        );

        let (mods, rps, sps, plugins) = scan_dir_packs_direct(&dir);
        assert_eq!(plugins.len(), 1, "插件应被识别为插件");
        assert_eq!(plugins[0].file_name, "LuckPerms.jar");
        assert_eq!(mods.len(), 1, "模组仍识别为模组");
        assert_eq!(mods[0].file_name, "RealMod.jar");
        assert!(rps.is_empty() && sps.is_empty());

        // mods/ 里误放的插件：也要归到插件组
        let mods_dir = dir.join("mods");
        std::fs::create_dir_all(&mods_dir).unwrap();
        write_jar(
            &mods_dir.join("Misplaced.jar"),
            &[("plugin.yml", "name: Misplaced
main: x.Y
")],
        );
        let (m2, p2) = scan_dir_jars_typed(&mods_dir, "mods");
        assert_eq!(m2.len(), 0);
        assert_eq!(p2.len(), 1);
        assert_eq!(p2[0].kind, "plugin");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
