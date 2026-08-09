use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use regex::Regex;
use std::sync::LazyLock;
use thiserror::Error;
use zip::ZipArchive;

use super::json_lang;
use super::lang;
use super::model::{LangEntry, LangFormat, Loader, ModFile};

#[derive(Debug, Error)]
pub enum JarError {
    #[error("无法打开文件: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip 读取失败: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("这不是一个 Minecraft 模组 jar（缺少 mods.toml / fabric.mod.json / mcmod.info）")]
    NotAMod,
    #[error("语言文件解析失败: {0}")]
    Lang(#[from] lang::LangError),
    #[error("语言 JSON 解析失败: {0}")]
    JsonLang(#[from] json_lang::JsonLangError),
}

/// 模组元数据（从 mods.toml / fabric.mod.json / mcmod.info 提取）
#[derive(Debug, Default)]
struct ModMeta {
    modid: Option<String>,
    name: Option<String>,
    version: Option<String>,
    mc_version: Option<String>,
    loader: Loader,
}

/// 语言文件路径匹配：assets/<modid>/lang/<name>.<ext>
static LANG_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^assets/([^/]+)/lang/([A-Za-z_]+)\.(json|lang)$").unwrap()
});

/// 解析一个模组 jar
pub fn parse_jar(path: &Path) -> Result<ModFile, JarError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    let meta = read_mod_metadata(&mut archive)?;
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut entries: Vec<LangEntry> = Vec::new();
    let mut key_index: HashMap<String, usize> = HashMap::new();
    let mut lang_format: Option<LangFormat> = None;
    let mut first_modid: Option<String> = None;

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = f.name().to_string();
        let Some(caps) = LANG_PATH_RE.captures(&name) else {
            continue;
        };
        let modid = caps[1].to_string();
        let lang_name = caps[2].to_string();
        let is_legacy = &caps[3] == "lang";

        // 只处理源语言（en_us / en_US / en_GB）
        if !is_source_lang(&lang_name) {
            continue;
        }
        if first_modid.is_none() {
            first_modid = Some(modid.clone());
        }
        lang_format = Some(if is_legacy {
            LangFormat::LegacyLang
        } else {
            LangFormat::Json
        });

        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;

        let pairs: Vec<(String, String)> = if is_legacy {
            lang::parse_lang(&buf)?
        } else {
            let text = String::from_utf8_lossy(&buf);
            json_lang::parse_json_lang(&text)?
        };

        for (k, v) in pairs {
            let placeholders = super::placeholder::extract_placeholders(&v);
            // 重复 key：后值覆盖前值（与 MC 加载行为一致）
            if let Some(&idx) = key_index.get(&k) {
                entries[idx].source = v;
                entries[idx].placeholders = placeholders;
                continue;
            }
            let idx = entries.len();
            key_index.insert(k.clone(), idx);
            entries.push(LangEntry {
                key: k,
                source: v,
                file_path: name.clone(),
                modid: modid.clone(),
                translation: None,
                status: super::model::EntryStatus::Untranslated,
                placeholders,
                notes: Vec::new(),
            });
        }
    }

    if entries.is_empty() {
        return Err(JarError::NotAMod);
    }

    Ok(ModFile {
        file_name,
        mod_name: meta
            .name
            .clone()
            .unwrap_or_else(|| meta.modid.clone().unwrap_or_default()),
        modid: meta
            .modid
            .clone()
            .or(first_modid)
            .unwrap_or_else(|| "unknown".to_string()),
        version: meta.version,
        loader: meta.loader,
        mc_version: meta.mc_version,
        lang_format: lang_format.unwrap_or(LangFormat::Json),
        entries,
    })
}

fn is_source_lang(lang_name: &str) -> bool {
    matches!(
        lang_name.to_ascii_lowercase().as_str(),
        "en_us" | "en_gb"
    )
}

/// 读取模组元数据，识别加载器
fn read_mod_metadata(archive: &mut ZipArchive<File>) -> Result<ModMeta, JarError> {
    let mut meta = ModMeta::default();

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = f.name().to_string();
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;

        match name.as_str() {
            "META-INF/neoforge.mods.toml" => {
                let parsed = parse_mods_toml(&buf);
                merge_meta(&mut meta, parsed, Loader::NeoForge);
            }
            "META-INF/mods.toml" => {
                let parsed = parse_mods_toml(&buf);
                merge_meta(&mut meta, parsed, Loader::Forge);
            }
            "fabric.mod.json" => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
                    let parsed = ModMeta {
                        modid: v.get("id").and_then(|x| x.as_str()).map(String::from),
                        name: v.get("name").and_then(|x| x.as_str()).map(String::from),
                        version: v.get("version").and_then(|x| x.as_str()).map(String::from),
                        mc_version: v
                            .get("depends")
                            .and_then(|d| d.get("minecraft"))
                            .and_then(|m| m.as_str())
                            .map(String::from),
                        loader: Loader::Fabric,
                    };
                    merge_meta(&mut meta, parsed, Loader::Fabric);
                }
            }
            "mcmod.info" => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {
                    if let Some(arr) = v.as_array() {
                        if let Some(first) = arr.first() {
                            let parsed = ModMeta {
                                modid: first.get("modid").and_then(|x| x.as_str()).map(String::from),
                                name: first.get("name").and_then(|x| x.as_str()).map(String::from),
                                version: first
                                    .get("version")
                                    .and_then(|x| x.as_str())
                                    .map(String::from),
                                mc_version: None,
                                loader: Loader::Forge,
                            };
                            merge_meta(&mut meta, parsed, Loader::Forge);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(meta)
}

/// 解析 mods.toml（TOML 子集）：只提取 modId/displayName/version/versionRange
fn parse_mods_toml(buf: &[u8]) -> ModMeta {
    let text = String::from_utf8_lossy(buf);
    let mut meta = ModMeta::default();
    let mut in_mods = false;
    let mut dep_mod_id: Option<String> = None;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("[[mods]]") {
            in_mods = true;
            dep_mod_id = None;
            continue;
        }
        if let Some(rest) = line.strip_prefix("[[dependencies.") {
            in_mods = false;
            dep_mod_id = Some(rest.trim_end_matches(']').to_string());
            continue;
        }
        if in_mods {
            if let Some(v) = kv(line, "modId") {
                meta.modid.get_or_insert(v);
            } else if let Some(v) = kv(line, "displayName") {
                meta.name.get_or_insert(v);
            } else if let Some(v) = kv(line, "version") {
                meta.version.get_or_insert(v);
            }
        } else if let Some(dep) = dep_mod_id.clone() {
            // 依赖块内：modId 行更新当前依赖，minecraft 依赖记录版本范围
            if let Some(v) = kv(line, "modId") {
                dep_mod_id = Some(v);
            } else if dep == "minecraft" {
                if let Some(v) = kv(line, "versionRange") {
                    meta.mc_version = Some(v);
                }
            }
        }
    }
    meta
}

fn kv(line: &str, key: &str) -> Option<String> {
    let line = line.strip_prefix(key)?;
    let line = line.trim_start();
    let line = line.strip_prefix('=')?;
    let v = line.trim().trim_matches('"').to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn merge_meta(meta: &mut ModMeta, parsed: ModMeta, loader: Loader) {
    if meta.modid.is_none() {
        meta.modid = parsed.modid;
    }
    if meta.name.is_none() {
        meta.name = parsed.name;
    }
    if meta.version.is_none() {
        meta.version = parsed.version;
    }
    if meta.mc_version.is_none() {
        meta.mc_version = parsed.mc_version;
    }
    if meta.loader == Loader::Unknown {
        meta.loader = loader;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn detects_source_lang() {
        assert!(is_source_lang("en_us"));
        assert!(is_source_lang("en_US"));
        assert!(is_source_lang("en_GB"));
        assert!(!is_source_lang("zh_cn"));
        assert!(!is_source_lang("de_de"));
    }

    #[test]
    fn parses_toml_subset() {
        let toml = br#"
modLoader="javafml"
loaderVersion="[47,)"
[[mods]]
modId="examplemod"
version="1.0.0"
displayName="Example Mod"
[[dependencies.examplemod]]
modId="minecraft"
versionRange="[1.20.1,1.21)"
"#;
        let meta = parse_mods_toml(toml);
        assert_eq!(meta.modid.as_deref(), Some("examplemod"));
        assert_eq!(meta.name.as_deref(), Some("Example Mod"));
        assert_eq!(meta.version.as_deref(), Some("1.0.0"));
        assert_eq!(meta.mc_version.as_deref(), Some("[1.20.1,1.21)"));
    }

    #[test]
    fn parses_fabric_jar_end_to_end() {
        // 构造一个内存中的 Fabric 模组 jar
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("fabric.mod.json", opts).unwrap();
            w.write_all(
                br#"{"schemaVersion":1,"id":"testmod","name":"Test Mod","version":"1.0.0","depends":{"minecraft":"1.20.1"}}"#,
            )
            .unwrap();
            w.start_file("assets/testmod/lang/en_us.json", opts).unwrap();
            w.write_all(br#"{"item.a.name":"Diamond Sword","item.a.desc":"Shiny %s power\\nCareful!"}"#)
                .unwrap();
            w.start_file("assets/testmod/lang/zh_cn.json", opts).unwrap();
            w.write_all(br#"{"item.a.name":"\u94bb\u77f3\u5251"}"#).unwrap();
            w.finish().unwrap();
        }

        // 写入临时文件后走完整 parse_jar 路径
        let tmp = std::env::temp_dir().join("testmod_parse_test.jar");
        std::fs::write(&tmp, &buf).unwrap();
        let mf = parse_jar(&tmp).unwrap();
        let _ = std::fs::remove_file(&tmp);

        assert_eq!(mf.modid, "testmod");
        assert_eq!(mf.mod_name, "Test Mod");
        assert_eq!(mf.loader, Loader::Fabric);
        assert_eq!(mf.mc_version.as_deref(), Some("1.20.1"));
        assert_eq!(mf.lang_format, LangFormat::Json);
        // 只收集 en_us 源语言，zh_cn 被忽略；占位符被提取
        assert_eq!(mf.entries.len(), 2);
        assert_eq!(mf.entries[0].key, "item.a.name");
        assert!(mf.entries[1].placeholders.contains(&"%s".to_string()));
        assert!(mf.entries[1].source.contains("\\n"));
    }
}
