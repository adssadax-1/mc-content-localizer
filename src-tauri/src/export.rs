use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::core::model::{LangEntry, LangFormat};

/// 单个模组的导出数据（合并资源包用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePackBundle {
    pub modid: String,
    pub mod_name: String,
    pub entries: Vec<LangEntry>,
    pub lang_format: LangFormat,
}

/// Windows 文件名非法字符清洗（* ? : < > | / \ "）→ _，并截断超过 100 字符。
/// 防止 modid 含非法字符时 File::create 触发 os error 123（文件名语法不正确）。
pub fn sanitize_file_stem(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '*' | '?' | ':' | '<' | '>' | '|' | '/' | '\\' | '"' => '_',
            _ => c,
        })
        .collect();
    cleaned.chars().take(100).collect()
}

/// 多模组合并导出汉化资源包 zip（一个资源包管所有模组中文）。
/// 只包含 lang 条目（硬编码文本无法通过资源包覆盖，需回写 jar）。
pub fn export_resource_pack_multi(
    dest_dir: &Path,
    bundles: &[ResourcePackBundle],
    pack_format: u32,
) -> Result<String, String> {
    let file_name = "mods_zh_cn.zip".to_string();
    let zip_path = dest_dir.join(&file_name);
    let _ = std::fs::create_dir_all(dest_dir);
    let file = File::create(&zip_path).map_err(|e| {
        format!(
            "无法将翻译结果保存到「{}」：可能原因：磁盘空间不足 / 无写入权限 / 文件被其他程序占用。请排查后重试。（原始错误：{}）",
            zip_path.display(),
            e
        )
    })?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let description = format!("§a[模组汉化] §r共 {} 个模组的中文汉化包", bundles.len());
    let pack_obj = if pack_format > 64 {
        serde_json::json!({
            "min_format": [pack_format, 0],
            "max_format": [pack_format, 0],
            "description": description,
        })
    } else {
        serde_json::json!({
            "pack_format": pack_format,
            "description": description,
        })
    };
    let mcmeta = serde_json::json!({ "pack": pack_obj });
    zip.start_file("pack.mcmeta", options).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&mcmeta).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    let mut wrote_any = false;
    for b in bundles {
        let translated: Vec<&LangEntry> = b
            .entries
            .iter()
            .filter(|e| !e.hardcoded && e.translation.as_ref().is_some_and(|t| !t.is_empty()))
            .collect();
        if translated.is_empty() {
            continue;
        }
        let pairs: Vec<(String, String)> = translated
            .iter()
            .map(|e| (e.key.clone(), e.translation.clone().unwrap()))
            .collect();
        if b.lang_format == LangFormat::LegacyLang {
            let bytes = crate::core::lang::encode_lang(&pairs);
            zip.start_file(format!("assets/{}/lang/zh_cn.lang", sanitize_file_stem(&b.modid)), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        } else {
            let text =
                crate::core::json_lang::encode_json_lang(&pairs).map_err(|e| e.to_string())?;
            zip.start_file(format!("assets/{}/lang/zh_cn.json", sanitize_file_stem(&b.modid)), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        wrote_any = true;
    }

    if !wrote_any {
        return Err("没有可导出的内容：当前勾选项中没有\"已翻译完成\"的条目。请确认：① 已勾选要导出的条目；② 这些条目的翻译状态不是红色（失败）。".to_string());
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(zip_path.to_string_lossy().to_string())
}

/// 将已翻译条目导出为汉化资源包 zip（可直接放入 resourcepacks 目录）
///
/// 结构：
/// - pack.mcmeta
/// - assets/<modid>/lang/zh_cn.json   （1.13+）
/// - assets/<modid>/lang/zh_cn.lang   （1.12.2，ISO-8859-1 + \uXXXX）
pub fn export_resource_pack(
    dest_dir: &Path,
    modid: &str,
    mod_name: &str,
    entries: &[LangEntry],
    lang_format: LangFormat,
    pack_format: u32,
) -> Result<String, String> {
    let translated: Vec<&LangEntry> = entries
        .iter()
        .filter(|e| e.translation.as_ref().is_some_and(|t| !t.is_empty()))
        .collect();

    if translated.is_empty() {
        return Err("没有可导出的内容：当前勾选项中没有\"已翻译完成\"的条目。请确认：① 已勾选要导出的条目；② 这些条目的翻译状态不是红色（失败）。".to_string());
    }

    let file_name = format!("{}_zh_cn.zip", sanitize_file_stem(modid));
    let zip_path = dest_dir.join(&file_name);
    let file = File::create(&zip_path).map_err(|e| {
        format!(
            "无法将翻译结果保存到「{}」：可能原因：磁盘空间不足 / 无写入权限 / 文件被其他程序占用。请排查后重试。（原始错误：{}）",
            zip_path.display(),
            e
        )
    })?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // pack.mcmeta：1.21.9+（格式 > 64）改用 min_format/max_format，其余用 pack_format
    let description = format!("§a[模组汉化] §r{} 中文汉化包", mod_name);
    let pack_obj = if pack_format > 64 {
        serde_json::json!({
            "min_format": [pack_format, 0],
            "max_format": [pack_format, 0],
            "description": description,
        })
    } else {
        serde_json::json!({
            "pack_format": pack_format,
            "description": description,
        })
    };
    let mcmeta = serde_json::json!({ "pack": pack_obj });
    zip.start_file("pack.mcmeta", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&mcmeta).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;

    let pairs: Vec<(String, String)> = translated
        .iter()
        .map(|e| (e.key.clone(), e.translation.clone().unwrap()))
        .collect();

    if lang_format == LangFormat::LegacyLang {
        let bytes = crate::core::lang::encode_lang(&pairs);
        zip.start_file(format!("assets/{}/lang/zh_cn.lang", modid), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    } else {
        let text = crate::core::json_lang::encode_json_lang(&pairs).map_err(|e| e.to_string())?;
        zip.start_file(format!("assets/{}/lang/zh_cn.json", modid), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(zip_path.to_string_lossy().to_string())
}

/// 将已翻译条目写回模组 jar，生成新的汉化 jar（不覆盖原文件）。
///
/// 复制原 jar 全部内容，在 assets/<modid>/lang/ 下新增 zh_cn.json / zh_cn.lang，
/// 若原 jar 已有同名文件则替换。
pub fn export_mod_jar(
    source: &Path,
    dest: &Path,
    modid: &str,
    entries: &[LangEntry],
    lang_format: LangFormat,
) -> Result<String, String> {
    let translated: Vec<&LangEntry> = entries
        .iter()
        .filter(|e| e.translation.as_ref().is_some_and(|t| !t.is_empty()))
        .collect();
    if translated.is_empty() {
        return Err("没有可导出的内容：当前勾选项中没有\"已翻译完成\"的条目。请确认：① 已勾选要导出的条目；② 这些条目的翻译状态不是红色（失败）。".to_string());
    }

    let lang_path = format!(
        "assets/{}/lang/zh_cn.{}",
        modid,
        if lang_format == LangFormat::LegacyLang {
            "lang"
        } else {
            "json"
        }
    );

    // 硬编码条目：按 (文件路径 -> [(json路径, 译文)]) 组织，写 jar 时替换原 json 值
    let mut hardcoded_changes: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for e in translated.iter() {
        if !e.hardcoded {
            continue;
        }
        let Some((path, json_path)) = e.key.split_once('#') else {
            continue;
        };
        let tr = e.translation.clone().unwrap();
        hardcoded_changes
            .entry(path.to_string())
            .or_default()
            .push((json_path.to_string(), tr));
    }

    let src_file = File::open(source).map_err(|e| format!("无法打开源 jar: {}", e))?;
    let mut src = zip::ZipArchive::new(src_file).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let dest_file = File::create(dest).map_err(|e| {
        format!(
            "无法将翻译结果保存到「{}」：可能原因：磁盘空间不足 / 无写入权限 / 文件被其他程序占用。请排查后重试。（原始错误：{}）",
            dest.display(),
            e
        )
    })?;
    let mut out = zip::ZipWriter::new(dest_file);

    // 复制原 jar 全部条目（跳过将写入的 zh_cn，防止重复）
    for i in 0..src.len() {
        let mut f = src.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name == lang_path {
            continue;
        }
        let opts = SimpleFileOptions::default().compression_method(f.compression());
        out.start_file(name.clone(), opts).map_err(|e| e.to_string())?;
        // 硬编码目标 json：应用替换后写回
        if let Some(changes) = hardcoded_changes.get(&name) {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&buf) {
                let mut modified = false;
                for (jp, tr) in changes {
                    if set_json_path(&mut value, jp, tr) {
                        modified = true;
                    }
                }
                if modified {
                    let text = serde_json::to_string_pretty(&value)
                        .map_err(|e| e.to_string())?;
                    out.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                    continue;
                }
            }
            out.write_all(&buf).map_err(|e| e.to_string())?;
        } else {
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        }
    }

    // 写入 zh_cn 语言文件
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let pairs: Vec<(String, String)> = translated
        .iter()
        .map(|e| (e.key.clone(), e.translation.clone().unwrap()))
        .collect();
    out.start_file(lang_path, options).map_err(|e| e.to_string())?;
    if lang_format == LangFormat::LegacyLang {
        let bytes = crate::core::lang::encode_lang(&pairs);
        out.write_all(&bytes).map_err(|e| e.to_string())?;
    } else {
        let text = crate::core::json_lang::encode_json_lang(&pairs).map_err(|e| e.to_string())?;
        out.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }

    out.finish().map_err(|e| e.to_string())?;
    // 验证文件真实生成，避免静默失败
    let meta = std::fs::metadata(dest).map_err(|e| format!("导出文件写入后无法读取: {}", e))?;
    if meta.len() == 0 {
        return Err("导出文件为空（写入异常）".to_string());
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 按 json 路径（"." 分隔，数组下标为数字）设置字符串值，成功返回 true
fn set_json_path(value: &mut serde_json::Value, path: &str, new_val: &str) -> bool {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = value;
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            // 最后一段：设置叶子值
            if let Some(obj) = cur.as_object_mut() {
                obj.insert(
                    part.to_string(),
                    serde_json::Value::String(new_val.to_string()),
                );
                return true;
            }
            if let Ok(idx) = part.parse::<usize>() {
                if let Some(arr) = cur.as_array_mut() {
                    if idx < arr.len() {
                        arr[idx] = serde_json::Value::String(new_val.to_string());
                        return true;
                    }
                }
            }
            return false;
        }
        // 中间段下钻
        let found: Option<&mut serde_json::Value> = match cur {
            serde_json::Value::Object(m) => m.get_mut(*part),
            serde_json::Value::Array(a) => {
                part.parse::<usize>().ok().and_then(|idx| a.get_mut(idx))
            }
            _ => None,
        };
        match found {
            Some(next) => cur = next,
            None => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn sample_entry(key: &str, source: &str, translation: Option<&str>) -> LangEntry {
        LangEntry {
            key: key.to_string(),
            source: source.to_string(),
            file_path: "assets/testmod/lang/en_us.json".to_string(),
            modid: "testmod".to_string(),
            translation: translation.map(String::from),
            hardcoded: false,
            status: crate::core::model::EntryStatus::AiTranslated,
            translating: false,
            placeholders: Vec::new(),
            notes: Vec::new(),
            deep_group: None,
        }
    }

    #[test]
    fn exports_json_resource_pack() {
        let entries = vec![
            sample_entry("item.a.name", "Diamond", Some("钻石")),
            sample_entry("item.a.desc", "Shiny %s", Some("闪亮的 %s")),
            sample_entry("item.b.name", "Untranslated", None), // 未翻译的不应导出
        ];
        let out = export_resource_pack(
            &std::env::temp_dir(),
            "testmod",
            "Test Mod",
            &entries,
            LangFormat::Json,
            15,
        )
        .unwrap();

        let f = File::open(&out).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        assert_eq!(archive.len(), 2);

        let mut mcmeta = String::new();
        archive.by_name("pack.mcmeta").unwrap().read_to_string(&mut mcmeta).unwrap();
        assert!(mcmeta.contains("\"pack_format\": 15"));
        let mut lang = String::new();
        archive
            .by_name("assets/testmod/lang/zh_cn.json")
            .unwrap()
            .read_to_string(&mut lang)
            .unwrap();
        assert!(lang.contains("钻石"));
        assert!(lang.contains("闪亮的 %s"));
        assert!(!lang.contains("Untranslated"));

        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn exports_legacy_lang_escaped() {
        let entries = vec![sample_entry("item.a.name", "Sword", Some("钻石剑"))];
        let out = export_resource_pack(
            &std::env::temp_dir(),
            "legacymod",
            "Legacy",
            &entries,
            LangFormat::LegacyLang,
            4,
        )
        .unwrap();

        let f = File::open(&out).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let mut lang = Vec::new();
        archive
            .by_name("assets/legacymod/lang/zh_cn.lang")
            .unwrap()
            .read_to_end(&mut lang)
            .unwrap();
        let text = crate::core::lang::decode_lang(&lang).unwrap();
        // 中文必须写为 \uXXXX 转义，读回仍是钻石剑
        assert!(text.contains("钻石剑"));
        assert!(lang.iter().all(|&b| b.is_ascii()));

        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn exports_mod_jar_replaces_lang() {
        // 构造一个带 en_us 的源 jar
        let src = std::env::temp_dir().join("testmod_source.jar");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            w.start_file("fabric.mod.json", opts).unwrap();
            w.write_all(br#"{"id":"testmod"}"#).unwrap();
            w.start_file("assets/testmod/lang/en_us.json", opts).unwrap();
            w.write_all(br#"{"item.a.name":"Diamond Sword"}"#).unwrap();
            // 已存在的旧 zh_cn（应被替换）
            w.start_file("assets/testmod/lang/zh_cn.json", opts).unwrap();
            w.write_all(br#"{"item.a.name":"\u65e7\u7ffb\u8bd1"}"#).unwrap();
            w.finish().unwrap();
        }

        let entries = vec![sample_entry("item.a.name", "Diamond Sword", Some("钻石剑"))];
        let dest = std::env::temp_dir().join("testmod_zh_cn.jar");
        export_mod_jar(&src, &dest, "testmod", &entries, LangFormat::Json).unwrap();

        // 验证：en_us 保留、zh_cn 被新译文替换、fabric.mod.json 保留
        let f = File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        assert_eq!(archive.len(), 3);
        let mut en = String::new();
        archive
            .by_name("assets/testmod/lang/en_us.json")
            .unwrap()
            .read_to_string(&mut en)
            .unwrap();
        assert!(en.contains("Diamond Sword"));
        let mut zh = String::new();
        archive
            .by_name("assets/testmod/lang/zh_cn.json")
            .unwrap()
            .read_to_string(&mut zh)
            .unwrap();
        assert!(zh.contains("钻石剑"));
        assert!(!zh.contains("旧翻译"));

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn exports_multi_mod_resource_pack() {
        let b1 = ResourcePackBundle {
            modid: "moda".into(),
            mod_name: "Mod A".into(),
            entries: vec![sample_entry("item.a.name", "Diamond", Some("钻石"))],
            lang_format: LangFormat::Json,
        };
        let b2 = ResourcePackBundle {
            modid: "modb".into(),
            mod_name: "Mod B".into(),
            entries: vec![sample_entry("item.b.name", "Ruby", Some("红宝石"))],
            lang_format: LangFormat::LegacyLang,
        };
        let out = export_resource_pack_multi(&std::env::temp_dir(), &[b1, b2], 15).unwrap();
        let f = File::open(&out).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        assert_eq!(archive.len(), 3);
        let mut zh = String::new();
        archive.by_name("assets/moda/lang/zh_cn.json").unwrap().read_to_string(&mut zh).unwrap();
        assert!(zh.contains("钻石"));
        let mut lang2 = Vec::new();
        archive.by_name("assets/modb/lang/zh_cn.lang").unwrap().read_to_end(&mut lang2).unwrap();
        assert!(crate::core::lang::decode_lang(&lang2).unwrap().contains("红宝石"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn set_json_path_works() {
        let mut v = serde_json::json!({"a": {"b": ["x", "y"]}, "c": "old"});
        assert!(set_json_path(&mut v, "a.b.1", "新值"));
        assert!(set_json_path(&mut v, "c", "new"));
        assert_eq!(v["a"]["b"][1], "新值");
        assert_eq!(v["c"], "new");
        // 不存在的路径返回 false
        assert!(!set_json_path(&mut v, "nope.deep", "x"));
    }

    #[test]
    fn exports_mod_jar_with_hardcoded() {
        let src = std::env::temp_dir().join("hc_source.jar");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            w.start_file("config/demo.json", opts).unwrap();
            w.write_all(br#"{"message":"Welcome","tip":"Be careful"}"#).unwrap();
            w.start_file("assets/hcmod/lang/en_us.json", opts).unwrap();
            w.write_all(br#"{"item.x.name":"Sword"}"#).unwrap();
            w.finish().unwrap();
        }
        let mut e1 = sample_entry("item.x.name", "Sword", Some("剑"));
        let e2 = LangEntry {
            key: "config/demo.json#message".into(),
            source: "Welcome".into(),
            file_path: "config/demo.json".into(),
            modid: "hcmod".into(),
            translation: Some("欢迎".into()),
            hardcoded: true,
            status: crate::core::model::EntryStatus::AiTranslated,
            translating: false,
            placeholders: vec![],
            notes: vec![],
            deep_group: None,
        };
        let dest = std::env::temp_dir().join("hc_dest.jar");
        export_mod_jar(&src, &dest, "hcmod", &[e1, e2], LangFormat::Json).unwrap();
        let f = File::open(&dest).unwrap();
        let mut archive = zip::ZipArchive::new(f).unwrap();
        let mut cfg = String::new();
        archive.by_name("config/demo.json").unwrap().read_to_string(&mut cfg).unwrap();
        assert!(cfg.contains("欢迎"), "硬编码 json 应被替换: {}", cfg);
        assert!(!cfg.contains("\"Welcome\""));
        let mut en = String::new();
        archive.by_name("assets/hcmod/lang/en_us.json").unwrap().read_to_string(&mut en).unwrap();
        assert!(en.contains("Sword"));
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }
}

#[cfg(test)]
mod serde_tests {
    use super::*;
    use crate::core::model::{EntryStatus, LangEntry};

    #[test]
    fn deserializes_bundle_camel_case() {
        // 前端传 camelCase（modName/langFormat）
        let json = r#"{"modid":"testmod","modName":"测试模组","langFormat":"json","entries":[]}"#;
        let b: ResourcePackBundle = serde_json::from_str(json).unwrap();
        assert_eq!(b.mod_name, "测试模组");
        assert_eq!(b.lang_format, LangFormat::Json);
        // 序列化回来也是 camelCase
        let out = serde_json::to_string(&b).unwrap();
        assert!(out.contains("modName"));
        assert!(out.contains("langFormat"));
    }

    #[test]
    fn deserializes_bundle_with_entries() {
        let json = r#"{"modid":"m","modName":"M","langFormat":"legacyLang","entries":[{"key":"a","source":"Hello","filePath":"f","modid":"m","translation":"你好","status":"aiTranslated","placeholders":[],"notes":[]}]}"#;
        let b: ResourcePackBundle = serde_json::from_str(json).unwrap();
        assert_eq!(b.entries.len(), 1);
        assert_eq!(b.entries[0].translation.as_deref(), Some("你好"));
        assert_eq!(b.lang_format, LangFormat::LegacyLang);
    }
}

// ── 服务器插件导出 ────────────────────────────────────────────────────────────

/// 插件导出条目：jar 内文件 + 键路径 + 译文
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExportItem {
    pub file_path: String,
    pub key_path: String,
    pub translation: String,
}

/// 导出汉化插件 jar：复制原 jar，仅替换被翻译的成员；其余成员原字节保留
/// （不重压缩、不破坏插件完整性）。返回摘要（写入/跳过条数）。
pub fn export_plugin_jar(
    source: &Path,
    dest: &Path,
    items: &[PluginExportItem],
) -> Result<String, String> {
    use zip::{ZipArchive, ZipWriter};

    let mut by_file: HashMap<&str, Vec<&PluginExportItem>> = HashMap::new();
    for it in items {
        by_file.entry(it.file_path.as_str()).or_default().push(it);
    }

    let file = File::open(source).map_err(|e| format!("无法打开原插件: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let out_file = File::create(dest).map_err(|e| format!("无法创建目标文件: {e}"))?;
    let mut w = ZipWriter::new(out_file);

    let mut written = 0usize;
    let mut skipped = 0usize;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        if let Some(list) = by_file.get(name.as_str()).cloned() {
            // 被翻译的成员：读出 → 文本级替换 → 保留原压缩方式与权限写回
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut f, &mut buf).map_err(|e| e.to_string())?;
            let compression = f.compression();
            let unix_mode = f.unix_mode();
            let text = String::from_utf8_lossy(&buf).into_owned();
            let lower = name.to_lowercase();
            let (new_text, rep, miss) = if lower.ends_with(".json") {
                rewrite_json_text(&text, &list)
            } else if lower.ends_with(".properties") {
                rewrite_properties_text(&text, &list)
            } else {
                rewrite_yaml_text(&text, &list)
            };
            written += rep;
            skipped += miss;
            let opts = SimpleFileOptions::default()
                .compression_method(compression)
                .unix_permissions(unix_mode.unwrap_or(0o644));
            w.start_file(name.clone(), opts).map_err(|e| e.to_string())?;
            w.write_all(new_text.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            // 未翻译的成员：原字节复制（不重压缩）
            w.raw_copy_file(f).map_err(|e| e.to_string())?;
        }
    }
    w.finish().map_err(|e| e.to_string())?;
    Ok(format!(
        "已写入 {written} 条译文{}",
        if skipped > 0 {
            format!("（跳过 {skipped} 条：原文件中未找到对应键）")
        } else {
            String::new()
        }
    ))
}

/// YAML 保格式回写：文本级行替换，保留注释、键序、缩进与引号风格。
/// 块标量（| 或 >）整块替换为双引号单行（\n 转义），内容不丢。
fn rewrite_yaml_text(text: &str, items: &[&PluginExportItem]) -> (String, usize, usize) {
    let mut map: HashMap<String, String> = HashMap::new();
    for it in items {
        map.insert(it.key_path.clone(), it.translation.clone());
    }
    let mut replaced = 0usize;
    let mut out = String::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut block_body_indent: Option<usize> = None;
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let indent = line.len() - line.trim_start().len();
        let t = line.trim_start();
        // 处于被替换块标量的体内：丢弃（内容已并入单行引号标量）
        if block_body_indent.map_or(false, |ind| t.is_empty() || indent > ind) {
            i += 1;
            continue;
        }
        block_body_indent = None;
        if t.is_empty() || t.starts_with('#') || t == "---" {
            out.push_str(line);
            out.push('\n');
            i += 1;
            continue;
        }
        while let Some((ind, _)) = stack.last() {
            if *ind >= indent {
                stack.pop();
            } else {
                break;
            }
        }
        match t.find(':') {
            Some(pos) => {
                let key_raw = &t[..pos];
                let key = key_raw.trim().trim_matches('"').trim_matches('\'');
                let raw_value = t[pos + 1..].trim();
                if raw_value.is_empty() || raw_value.starts_with('#') {
                    // 父键或键后直接注释：入栈，等待子键
                    stack.push((indent, key.to_string()));
                    out.push_str(line);
                    out.push('\n');
                    i += 1;
                    continue;
                }
                stack.push((indent, key.to_string()));
                let full = stack
                    .iter()
                    .map(|(_, k)| k.as_str())
                    .collect::<Vec<_>>()
                    .join(".");
                if let Some(tr) = map.get(&full).cloned() {
                    if raw_value == "|" || raw_value == "|-" || raw_value == ">" || raw_value == ">-" {
                        block_body_indent = Some(indent);
                        out.push_str(&format!(
                            "{}{}: {}\n",
                            " ".repeat(indent),
                            key_raw.trim(),
                            yaml_quote(&tr)
                        ));
                    } else {
                        out.push_str(&format!(
                            "{}{}: {}\n",
                            " ".repeat(indent),
                            key_raw.trim(),
                            yaml_value(&tr, raw_value)
                        ));
                    }
                    replaced += 1;
                    map.remove(&full);
                } else {
                    out.push_str(line);
                    out.push('\n');
                }
            }
            None => {
                out.push_str(line);
                out.push('\n');
            }
        }
        i += 1;
    }
    let skipped = map.len();
    (out, replaced, skipped)
}

/// 译文是否必须加引号才符合 YAML 纯量规则
fn yaml_needs_quote(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    if s != s.trim() {
        return true;
    }
    if s.contains('\n') || s.contains(": ") || s.contains(" #") || s.contains('"') {
        return true;
    }
    matches!(
        s.chars().next(),
        Some(
            '-' | '?'
                | ':'
                | ','
                | '['
                | ']'
                | '{'
                | '}'
                | '#'
                | '&'
                | '*'
                | '!'
                | '|'
                | '>'
                | '\''
                | '"'
                | '%'
                | '@'
                | '`'
        )
    ) || matches!(s.chars().next_back(), Some(':'))
}

/// 按原值的引号风格写出译文
fn yaml_value(tr: &str, raw_value: &str) -> String {
    if raw_value.starts_with('"') {
        yaml_quote(tr)
    } else if raw_value.starts_with('\'') {
        format!("'{}'", tr.replace('\'', "''"))
    } else if yaml_needs_quote(tr) {
        yaml_quote(tr)
    } else {
        tr.to_string()
    }
}

/// 双引号 YAML 标量（转义 \ " 与换行）
fn yaml_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// properties 保序回写：仅替换命中键的值，注释与键原样保留（UTF-8 直写）
fn rewrite_properties_text(text: &str, items: &[&PluginExportItem]) -> (String, usize, usize) {
    let mut map: HashMap<String, String> = HashMap::new();
    for it in items {
        map.insert(it.key_path.clone(), it.translation.clone());
    }
    let mut replaced = 0usize;
    let mut skipped = map.len();
    let mut out = String::new();
    for line in text.lines() {
        let t = line.trim_start();
        let indent_len = line.len() - t.len();
        if t.is_empty() || t.starts_with('#') || t.starts_with('!') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let pos = match t.find(|c| c == '=' || c == ':') {
            Some(p) => p,
            None => {
                out.push_str(line);
                out.push('\n');
                continue;
            }
        };
        let key = t[..pos].trim().to_string();
        if let Some(tr) = map.remove(&key) {
            // 保留 "key = value" 这类原始分隔符与空白
            let after = &t[pos + 1..];
            let lead_ws: String = after.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
            let lead = if lead_ws.is_empty() { " " } else { &lead_ws };
            out.push_str(&format!("{}{}{}", &line[..indent_len + pos + 1], lead, tr));
            out.push('\n');
            replaced += 1;
            skipped -= 1;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    (out, replaced, skipped)
}

/// JSON 回写：顶层键替换（插件语言 json 通常为扁平键值），pretty(2) 输出
fn rewrite_json_text(text: &str, items: &[&PluginExportItem]) -> (String, usize, usize) {
    let mut v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return (text.to_string(), 0, items.len()),
    };
    let obj = match v.as_object_mut() {
        Some(o) => o,
        None => return (text.to_string(), 0, items.len()),
    };
    let mut replaced = 0usize;
    let mut missing = items.len();
    for it in items {
        if let Some(slot) = obj.get_mut(&it.key_path) {
            if slot.is_string() {
                *slot = serde_json::Value::String(it.translation.clone());
                replaced += 1;
                missing -= 1;
            }
        }
    }
    let out = serde_json::to_string_pretty(&v).unwrap_or_else(|_| text.to_string());
    (out, replaced, missing)
}

#[cfg(test)]
mod plugin_export_tests {
    use super::*;

    fn item(fp: &str, kp: &str, tr: &str) -> PluginExportItem {
        PluginExportItem {
            file_path: fp.into(),
            key_path: kp.into(),
            translation: tr.into(),
        }
    }

    #[test]
    fn yaml_rewrite_preserves_format() {
        let text = "# 主配置\nmessages:\n  welcome: \"&aWelcome!\"\n  bye: Goodbye\n  motd: |\n    line one\n    line two\nmysql:\n  host: localhost\n";
        let items = vec![
            item("config.yml", "messages.welcome", "&a欢迎！"),
            item("config.yml", "messages.bye", "再见: 下次见"),
            item("config.yml", "messages.motd", "第一行\n第二行"),
            item("config.yml", "nope.missing", "x"),
        ];
        let refs: Vec<&PluginExportItem> = items.iter().collect();
        let (out, replaced, skipped) = rewrite_yaml_text(text, &refs);
        assert_eq!(replaced, 3);
        assert_eq!(skipped, 1);
        assert!(out.contains("# 主配置")); // 注释保留
        assert!(out.contains("welcome: \"&a欢迎！\"")); // 原引号风格保留
        assert!(out.contains("bye: \"再见: 下次见\"")); // 含冒号 → 自动加引号
        assert!(out.contains("motd: \"第一行\\n第二行\"")); // 块标量转单行
        assert!(!out.contains("line one")); // 原块体已替换
        assert!(out.contains("mysql:") && out.contains("host: localhost")); // 未涉及部分原样
    }

    #[test]
    fn plugin_export_round_trip_keeps_other_members() {
        use std::io::Write;
        use zip::ZipArchive;

        // 构造插件 jar：配置（含注释与内部键）+ 二进制成员（须原样保留）
        let src = std::env::temp_dir().join("plug_rt_src.jar");
        let dst = std::env::temp_dir().join("plug_rt_dst.jar");
        let binary: Vec<u8> = (0..512u32).map(|i| (i % 251) as u8).collect();
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            w.start_file("plugin.yml", opts).unwrap();
            w.write_all(b"name: RtPlugin
version: 1.0
description: A test plugin
").unwrap();
            w.start_file("config.yml", opts).unwrap();
            w.write_all("# 头部注释
messages:
  welcome: \"&aWelcome!\"
mysql:
  host: localhost
".as_bytes()).unwrap();
            w.start_file("com/example/Test.class", opts).unwrap();
            w.write_all(&binary).unwrap();
            w.finish().unwrap();
        }

        let items = vec![
            item("config.yml", "messages.welcome", "&a欢迎！"),
            item("plugin.yml", "description", "测试插件"),
        ];
        let summary = export_plugin_jar(&src, &dst, &items).unwrap();
        assert!(summary.contains("已写入 2"), "{}", summary);

        // 校验产物：译文写入、注释保留、二进制成员字节一致、成员数不变
        let f = File::open(&dst).unwrap();
        let mut a = ZipArchive::new(f).unwrap();
        let mut cfg = String::new();
        a.by_name("config.yml").unwrap().read_to_string(&mut cfg).unwrap();
        assert!(cfg.contains("# 头部注释"));
        assert!(cfg.contains("welcome: \"&a欢迎！\""));
        assert!(cfg.contains("host: localhost"));
        let mut man = String::new();
        a.by_name("plugin.yml").unwrap().read_to_string(&mut man).unwrap();
        assert!(man.contains("description: 测试插件"));
        let mut bin = Vec::new();
        a.by_name("com/example/Test.class").unwrap().read_to_end(&mut bin).unwrap();
        assert_eq!(bin, binary);
        assert_eq!(a.len(), 3);

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }

    #[test]
    fn properties_rewrite_hits_key() {
        let text = "# msg\nwelcome = Hello\nprefix: [Server]\n";
        let items = vec![
            item("messages.properties", "welcome", "欢迎"),
            item("messages.properties", "missing", "x"),
        ];
        let refs: Vec<&PluginExportItem> = items.iter().collect();
        let (out, replaced, skipped) = rewrite_properties_text(text, &refs);
        assert_eq!(replaced, 1);
        assert_eq!(skipped, 1);
        assert!(out.contains("welcome = 欢迎"));
        assert!(out.contains("prefix: [Server]"));
        assert!(out.contains("# msg"));
    }
}
