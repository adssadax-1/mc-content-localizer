use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use thiserror::Error;
use zip::ZipArchive;

use super::json_lang;
use super::lang;
use super::model::{EntryStatus, LangEntry, LangFormat, Loader, ModFile};

#[derive(Debug, Error)]
pub enum JarError {
    #[error("无法打开文件: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip 读取失败: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("未能识别为可翻译的模组：jar 内找到 {lang_count} 个语言文件、{json_count} 个文本 json，但没有可翻译的内容")]
    NotAMod { lang_count: usize, json_count: usize },
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

/// 判断字符串是否含中文字符
fn contains_chinese(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// 将一条 zh* 翻译写入 map：繁转简 + 过滤空值/不含中文的值
fn insert_zh(map: &mut HashMap<String, String>, key: &str, value: &str) {
    let v = zhconv::zhconv(value, zhconv::Variant::ZhHans);
    if v.trim().is_empty() || !contains_chinese(&v) {
        return;
    }
    map.insert(key.to_string(), v);
}

/// 解析一个模组 jar
pub fn parse_jar(path: &Path) -> Result<ModFile, JarError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    // 顶层文件夹包装兼容：剥离公共根前缀后再做路径匹配
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = super::pack::common_root_prefix(&names);

    let meta = read_mod_metadata(&mut archive, root_prefix.as_deref())?;
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let meta_modid = meta.modid.clone();

    // ---- 第一遍：收集全部语言文件，识别源语言与自带中文 ----
    // (modid, lang_name, is_legacy, pairs)
    let mut lang_entries: Vec<(String, String, bool, Vec<(String, String)>)> = Vec::new();
    let mut zh_map: HashMap<String, String> = HashMap::new();
    // 收集的中文语言文件 (lang_name, pairs)，稍后按简体优先处理
    let mut zh_files: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut lang_count = 0;
    let mut json_count = 0;

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = norm_name(f.name(), root_prefix.as_deref());
        let Some(caps) = LANG_PATH_RE.captures(&name) else {
            if name.ends_with(".json") && is_text_scan_target(&name) {
                json_count += 1;
            }
            continue;
        };
        lang_count += 1;
        let modid = caps[1].to_string();
        let lang_name = caps[2].to_string();
        let is_legacy = &caps[3] == "lang";

        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        let pairs: Vec<(String, String)> = if is_legacy {
            lang::parse_lang(&buf)?
        } else {
            let text = String::from_utf8_lossy(&buf);
            json_lang::parse_json_lang(&text)?
        };

        let lower = lang_name.to_ascii_lowercase();
        if is_zh_lang(&lower) {
            // 收集所有 zh*（zh_cn/zh_tw/zh_hk），稍后按"简体优先、繁体补缺"处理
            zh_files.push((lower, pairs));
        } else {
            lang_entries.push((modid, lang_name, is_legacy, pairs));
        }
    }

    // ---- 自带中文：简体优先，繁体仅补缺（都转简体）----
    // 第一遍：简体方言（zh_cn / zh_hk）直接写入
    for (lang, pairs) in &zh_files {
        if lang == "zh_cn" || lang == "zh_hk" || lang.starts_with("zh_c") {
            for (k, v) in pairs {
                insert_zh(&mut zh_map, k, v);
            }
        }
    }
    // 第二遍：繁体等（zh_tw 等）只补充简体没有的 key
    for (lang, pairs) in &zh_files {
        if lang == "zh_cn" || lang == "zh_hk" || lang.starts_with("zh_c") {
            continue;
        }
        for (k, v) in pairs {
            if zh_map.contains_key(k) {
                continue;
            }
            insert_zh(&mut zh_map, k, v);
        }
    }

    // 选择源语言：en_us/en_gb 优先，其次第一个非中文语言
    let source = pick_source_lang(&lang_entries);
    let source_name = source.map(|s| s.1.clone());
    let source_pairs: Vec<(String, String)> = match source {
        Some((_, _, _, pairs)) => pairs.clone(),
        None => Vec::new(),
    };

    let first_modid = source
        .map(|s| s.0.clone())
        .or_else(|| lang_entries.first().map(|e| e.0.clone()));

    // ---- 组装语言条目（填充已有中文）----
    let mut entries: Vec<LangEntry> = Vec::new();
    let mut key_index: HashMap<String, usize> = HashMap::new();
    let mut lang_format = LangFormat::Json;

    for (k, v) in source_pairs {
        let placeholders = super::placeholder::extract_placeholders(&v);
        let existing = zh_map.get(&k).cloned();
        if let Some(&idx) = key_index.get(&k) {
            entries[idx].source = v;
            entries[idx].placeholders = placeholders;
            continue;
        }
        let idx = entries.len();
        key_index.insert(k.clone(), idx);
        let modid = first_modid.clone().unwrap_or_default();
        entries.push(LangEntry {
            key: k,
            source: v,
            file_path: format!(
                "assets/{}/lang/{}.{}",
                modid,
                source_name.clone().unwrap_or_else(|| "en_us".into()),
                "json"
            ),
            modid,
            translation: existing.clone(),
            hardcoded: false,
            status: if existing.is_some() {
                EntryStatus::ExistingZh
            } else {
                EntryStatus::Untranslated
            },
            translating: false,
            placeholders,
            notes: if existing.is_some() {
                vec!["模组自带中文".to_string()]
            } else {
                Vec::new()
            },
        });
    }

    // 源语言是 .lang 时记录格式
    if let Some((_, _, is_legacy, _)) = source {
        lang_format = if *is_legacy {
            LangFormat::LegacyLang
        } else {
            LangFormat::Json
        };
    }

    // ---- 硬编码文本扫描（advancements / patchouli / config）----
    scan_hardcoded(
        &mut archive,
        &mut entries,
        &mut key_index,
        first_modid.as_deref().unwrap_or("unknown"),
        root_prefix.as_deref(),
    )?;

    if entries.is_empty() {
        // 有模组元数据但没有任何可翻译文本 → 返回空条目（交由深度扫描流程处理）
        // 完全没有元数据才报错
        if meta.modid.is_none() && meta.name.is_none() {
            return Err(JarError::NotAMod {
                lang_count,
                json_count,
            });
        }
        return Ok(ModFile {
            file_name,
            mod_name: meta
                .name
                .clone()
                .unwrap_or_else(|| meta.modid.clone().unwrap_or_default()),
            modid: meta.modid.clone().unwrap_or("unknown".to_string()),
            loader: meta.loader,
            version: meta.version,
            mc_version: meta.mc_version,
            lang_format,
            has_zh: false,
            zh_count: 0,
            entries: Vec::new(),
        });
    }

    let zh_count = entries
        .iter()
        .filter(|e| e.status == EntryStatus::ExistingZh)
        .count();
    Ok(ModFile {
        file_name,
        mod_name: meta
            .name
            .clone()
            .unwrap_or_else(|| meta_modid.clone().unwrap_or_default()),
        modid: meta_modid.or(first_modid).unwrap_or_else(|| "unknown".to_string()),
        version: meta.version,
        loader: meta.loader,
        mc_version: meta.mc_version,
        lang_format,
        has_zh: zh_count > 0,
        zh_count,
        entries,
    })
}

/// 语言名是否为中文
fn is_zh_lang(lang_name: &str) -> bool {
    lang_name.starts_with("zh")
}

/// 语言名是否为英文源语言
fn is_en_lang(lang_name: &str) -> bool {
    lang_name.starts_with("en_")
}

/// 选择源语言：en_us/en_gb 优先，其次第一个非中文语言
fn pick_source_lang(
    langs: &[(String, String, bool, Vec<(String, String)>)],
) -> Option<&(String, String, bool, Vec<(String, String)>)> {
    langs
        .iter()
        .find(|(_, n, _, _)| is_en_lang(&n.to_ascii_lowercase()))
        .or_else(|| langs.first())
}

/// 是否为硬编码文本扫描目标（高概率含显示文本的 json 位置）
fn is_text_scan_target(name: &str) -> bool {
    name.ends_with(".json")
        && (name.starts_with("config/")
            || (name.starts_with("data/")
                && (name.contains("/advancements/") || name.contains("/patchouli_books/"))))
}

/// 从 data/<modid>/ 或 assets/<modid>/ 路径中提取 modid（config 等无 modid 的返回默认值）
fn extract_modid_from_path(name: &str, default: &str) -> String {
    let parts: Vec<&str> = name.split('/').collect();
    if parts.len() >= 2 && (parts[0] == "data" || parts[0] == "assets") {
        return parts[1].to_string();
    }
    default.to_string()
}

/// 启发式过滤：是否为值得翻译的英文文本
fn looks_like_translatable(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 3 || t.len() > 300 {
        return false;
    }
    if !t.chars().any(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    // 排除明显是 id / 路径 / namespace 的值
    if t.contains(':') || t.contains('/') || t.contains('{') || t.contains('}') {
        return false;
    }
    if t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
        return false;
    }
    // 短单词/短 id（无空格且不长）视为非句子，跳过
    if !t.contains(' ') && t.len() <= 8 {
        return false;
    }
    true
}

/// 递归收集 JSON 叶子字符串，json_path 用 "." 连接（数组下标为数字）
fn collect_json_strings(value: &serde_json::Value, path: &str, out: &mut Vec<(String, String)>) {
    match value {
        serde_json::Value::String(s) => {
            out.push((path.to_string(), s.clone()));
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", path, k)
                };
                collect_json_strings(v, &p, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for (i, v) in arr.iter().enumerate() {
                let p = format!("{}.{}", path, i);
                collect_json_strings(v, &p, out);
            }
        }
        _ => {}
    }
}

/// 扫描硬编码文本（advancements / patchouli / config json）
fn scan_hardcoded(
    archive: &mut ZipArchive<File>,
    entries: &mut Vec<LangEntry>,
    key_index: &mut HashMap<String, usize>,
    default_modid: &str,
    root_prefix: Option<&str>,
) -> Result<(), JarError> {
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = norm_name(f.name(), root_prefix);
        if !is_text_scan_target(&name) {
            continue;
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buf) else {
            continue;
        };

        let mut strings: Vec<(String, String)> = Vec::new();
        collect_json_strings(&value, "", &mut strings);

        let modid = extract_modid_from_path(&name, default_modid);
        for (json_path, s) in strings {
            if !looks_like_translatable(&s) {
                continue;
            }
            let key = format!("{}#{}", name, json_path);
            if key_index.contains_key(&key) {
                continue;
            }
            let placeholders = super::placeholder::extract_placeholders(&s);
            let idx = entries.len();
            key_index.insert(key.clone(), idx);
            entries.push(LangEntry {
                key,
                source: s,
                file_path: name.to_string(),
                modid: modid.clone(),
                translation: None,
                hardcoded: true,
                status: EntryStatus::Untranslated,
                translating: false,
                placeholders,
                notes: vec!["硬编码文本（非 lang 文件）".to_string()],
            });
        }
    }
    Ok(())
}

/// 读取模组元数据，识别加载器
/// 去除 UTF-8 BOM：部分老 mcmod.info / fabric.mod.json 带 BOM，会导致 JSON 解析失败
fn strip_bom(buf: &[u8]) -> &[u8] {
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &buf[3..]
    } else {
        buf
    }
}

/// 剥离顶层文件夹前缀（无前缀时原样返回）
fn norm_name(n: &str, prefix: Option<&str>) -> String {
    n.strip_prefix(prefix.unwrap_or("")).unwrap_or(n).to_string()
}

fn read_mod_metadata(
    archive: &mut ZipArchive<File>,
    root_prefix: Option<&str>,
) -> Result<ModMeta, JarError> {
    let mut meta = ModMeta::default();

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = norm_name(f.name(), root_prefix);
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
            "quilt.mod.json" => {
                // Quilt：{ "quilt_loader": { id/version/depends[], metadata.name } }
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(strip_bom(&buf)) {
                    let loader_obj = v.get("quilt_loader");
                    let parsed = ModMeta {
                        modid: loader_obj
                            .and_then(|l| l.get("id"))
                            .and_then(|x| x.as_str())
                            .map(String::from),
                        name: loader_obj
                            .and_then(|l| l.get("metadata"))
                            .and_then(|m| m.get("name"))
                            .and_then(|x| x.as_str())
                            .map(String::from),
                        version: loader_obj
                            .and_then(|l| l.get("version"))
                            .and_then(|x| x.as_str())
                            .map(String::from),
                        mc_version: loader_obj
                            .and_then(|l| l.get("depends"))
                            .and_then(|d| d.as_array())
                            .and_then(|arr| {
                                arr.iter().find(|d| {
                                    d.get("id").and_then(|x| x.as_str()) == Some("minecraft")
                                })
                            })
                            .and_then(|d| d.get("versions"))
                            .and_then(|x| x.as_str())
                            .map(String::from),
                        loader: Loader::Quilt,
                    };
                    merge_meta(&mut meta, parsed, Loader::Quilt);
                }
            }
            "fabric.mod.json" => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(strip_bom(&buf)) {
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
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(strip_bom(&buf)) {
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
    fn parses_indented_legacy_lang_in_wrapped_jar() {
        // 模组 legacy .lang：带缩进 + 多字节字符（§/中文），jar 套顶层文件夹 → 三重兼容
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("MyMod-1.16/META-INF/mods.toml", opts).unwrap();
            w.write_all(b"modLoader=\"javafml\"\n[[mods]]\nmodId=\"mymod\"\n").unwrap();
            w.start_file("MyMod-1.16/assets/mymod/lang/en_us.lang", opts).unwrap();
            w.write_all("    option.a=Hello\n    option.b=§cWarning!§r\n".as_bytes()).unwrap();
            w.start_file("MyMod-1.16/assets/mymod/lang/zh_cn.lang", opts).unwrap();
            w.write_all("    option.a=你好\n".as_bytes()).unwrap();
            w.finish().unwrap();
        }
        let tmp = std::env::temp_dir().join("wrapped_mod.jar");
        std::fs::write(&tmp, &buf).unwrap();
        let mod_file = parse_jar(&tmp).unwrap();
        let _ = std::fs::remove_file(&tmp);

        assert_eq!(mod_file.entries.len(), 2);
        let a = mod_file.entries.iter().find(|e| e.key == "option.a").unwrap();
        assert_eq!(a.source, "Hello");
        assert_eq!(a.translation.as_deref(), Some("你好"));
        let b = mod_file.entries.iter().find(|e| e.key == "option.b").unwrap();
        assert_eq!(b.source, "§cWarning!§r");
        assert_eq!(b.status, EntryStatus::Untranslated);
        assert_eq!(mod_file.modid, "mymod");
    }

    #[test]
    fn detects_language_kinds() {
        assert!(is_en_lang("en_us"));
        assert!(is_en_lang("en_GB"));
        assert!(is_zh_lang("zh_cn"));
        assert!(is_zh_lang("zh_CN"));
        assert!(!is_zh_lang("de_de"));
        assert!(!is_en_lang("de_de"));
    }

    #[test]
    fn translatable_filter() {
        assert!(looks_like_translatable("Diamond Sword"));
        assert!(looks_like_translatable("A shiny sword with %s"));
        assert!(!looks_like_translatable("minecraft:item/sword"));
        assert!(!looks_like_translatable("abc123"));
        assert!(!looks_like_translatable("ITEM_SWORD"));
        assert!(!looks_like_translatable("a"));
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

    fn build_jar(buf: &mut Vec<u8>, files: &[(&str, &str)]) {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    fn parse_buf(buf: &[u8], name: &str) -> ModFile {
        let tmp = std::env::temp_dir().join(name);
        std::fs::write(&tmp, buf).unwrap();
        let mf = parse_jar(&tmp).unwrap();
        let _ = std::fs::remove_file(&tmp);
        mf
    }

    #[test]
    fn parses_fabric_jar_with_zh_fill() {
        let mut buf: Vec<u8> = Vec::new();
        build_jar(
            &mut buf,
            &[
                (
                    "fabric.mod.json",
                    r#"{"id":"testmod","name":"Test Mod","version":"1.0.0","depends":{"minecraft":"1.20.1"}}"#,
                ),
                (
                    "assets/testmod/lang/en_us.json",
                    r#"{"item.a.name":"Diamond Sword","item.a.desc":"Shiny %s power\\nCareful!"}"#,
                ),
                (
                    "assets/testmod/lang/zh_cn.json",
                    r#"{"item.a.name":"钻石剑"}"#,
                ),
                (
                    "data/testmod/advancements/main.json",
                    r#"{"display":{"title":"Start of Adventure","description":"Begin your journey"},"criteria":{"c":{"trigger":"x"}}}"#,
                ),
            ],
        );
        let mf = parse_buf(&buf, "testmod_zh_fill.jar");

        assert_eq!(mf.modid, "testmod");
        assert_eq!(mf.has_zh, true);
        assert_eq!(mf.zh_count, 1);
        // lang 条目 2 条：name 已有中文，desc 无
        let name_entry = mf.entries.iter().find(|e| e.key == "item.a.name").unwrap();
        assert_eq!(name_entry.status, EntryStatus::ExistingZh);
        assert_eq!(name_entry.translation.as_deref(), Some("钻石剑"));
        let desc_entry = mf.entries.iter().find(|e| e.key == "item.a.desc").unwrap();
        assert_eq!(desc_entry.status, EntryStatus::Untranslated);
        assert_eq!(desc_entry.translation, None);
        // 硬编码扫描出 advancements title/description
        assert!(mf.entries.iter().any(|e| e.hardcoded && e.source == "Start of Adventure"));
        assert!(mf.entries.iter().any(|e| e.hardcoded && e.source == "Begin your journey"));
        // 噪音过滤：trigger "x" 应被忽略
        assert!(!mf.entries.iter().any(|e| e.source == "x"));
    }

    #[test]
    fn parses_non_standard_jar_without_metadata() {
        // 无 fabric.mod.json 等元数据，但有 lang 文件 → 应正常解析
        let mut buf: Vec<u8> = Vec::new();
        build_jar(
            &mut buf,
            &[(
                "assets/foo/lang/en_us.lang",
                "item.foo.name=Golden Axe\nitem.foo.desc=Chops trees",
            )],
        );
        let mf = parse_buf(&buf, "nostandard.jar");
        assert_eq!(mf.modid, "foo");
        assert_eq!(mf.loader, Loader::Unknown);
        assert_eq!(mf.lang_format, LangFormat::LegacyLang);
        assert_eq!(mf.entries.len(), 2);
    }

    #[test]
    fn parses_jar_with_only_hardcoded() {
        // 没有 lang 文件，只有 config 英文 → 也能解析
        let mut buf: Vec<u8> = Vec::new();
        build_jar(
            &mut buf,
            &[(
                "config/example.json",
                r#"{"message":"Welcome to the server"}"#,
            )],
        );
        let mf = parse_buf(&buf, "hardcoded_only.jar");
        assert_eq!(mf.modid, "unknown");
        assert!(mf.entries.iter().any(|e| e.hardcoded && e.source == "Welcome to the server"));
    }

    #[test]
    fn zh_fill_handles_traditional_and_empty() {
        // en_us + zh_cn(含空值和英文占位) + zh_tw(繁体) → 繁体转简体、空值/英文不填
        let mut buf: Vec<u8> = Vec::new();
        build_jar(
            &mut buf,
            &[
                (
                    "assets/t/lang/en_us.json",
                    r#"{"a.name":"Diamond","b.name":"Sword","c.name":"Pickaxe","d.name":"Ruby"}"#,
                ),
                (
                    // zh_cn：b 是空串，c 还是英文（占位），都不应算自带中文
                    "assets/t/lang/zh_cn.json",
                    r#"{"a.name":"钻石","b.name":"","c.name":"Pickaxe"}"#,
                ),
                (
                    // zh_tw：繁体 → 应转为简体填入 d
                    "assets/t/lang/zh_tw.json",
                    r#"{"d.name":"紅寶石"}"#,
                ),
            ],
        );
        let mf = parse_buf(&buf, "zh_traditional.jar");
        let a = mf.entries.iter().find(|e| e.key == "a.name").unwrap();
        assert_eq!(a.status, EntryStatus::ExistingZh);
        assert_eq!(a.translation.as_deref(), Some("钻石"));
        let b = mf.entries.iter().find(|e| e.key == "b.name").unwrap();
        assert_eq!(b.status, EntryStatus::Untranslated, "空值不应算自带中文");
        let c = mf.entries.iter().find(|e| e.key == "c.name").unwrap();
        assert_eq!(c.status, EntryStatus::Untranslated, "英文占位不应算自带中文");
        let d = mf.entries.iter().find(|e| e.key == "d.name").unwrap();
        assert_eq!(d.status, EntryStatus::ExistingZh);
        assert_eq!(d.translation.as_deref(), Some("红宝石"), "繁体应转简体");
        assert_eq!(mf.has_zh, true);
        assert_eq!(mf.zh_count, 2);
    }

    #[test]
    fn parses_jar_with_jsonc_lang() {
        // Carpet 风格：带 // 注释的 lang json
        let mut buf: Vec<u8> = Vec::new();
        build_jar(
            &mut buf,
            &[(
                "assets/carpet/lang/en_us.json",
                "{\n  // TODO Rules\n  \"carpet.rule.a\": \"Value A\",\n}",
            )],
        );
        let mf = parse_buf(&buf, "jsonc_lang.jar");
        assert_eq!(mf.modid, "carpet");
        assert_eq!(mf.entries.len(), 1);
        assert_eq!(mf.entries[0].key, "carpet.rule.a");
    }
}
