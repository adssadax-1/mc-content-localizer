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

/// 多模组合并导出汉化资源包 zip（一个资源包管所有模组中文）。
/// 只包含 lang 条目（硬编码文本无法通过资源包覆盖，需回写 jar）。
pub fn export_resource_pack_multi(
    dest_dir: &Path,
    bundles: &[ResourcePackBundle],
    pack_format: u32,
) -> Result<String, String> {
    let file_name = "mods_zh_cn.zip".to_string();
    let zip_path = dest_dir.join(&file_name);
    let file = File::create(&zip_path).map_err(|e| format!("无法创建文件: {}", e))?;
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
            zip.start_file(format!("assets/{}/lang/zh_cn.lang", b.modid), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        } else {
            let text =
                crate::core::json_lang::encode_json_lang(&pairs).map_err(|e| e.to_string())?;
            zip.start_file(format!("assets/{}/lang/zh_cn.json", b.modid), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        wrote_any = true;
    }

    if !wrote_any {
        return Err("没有已翻译的条目可导出".to_string());
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
        return Err("没有已翻译的条目可导出".to_string());
    }

    let file_name = format!("{}_zh_cn.zip", modid);
    let zip_path = dest_dir.join(&file_name);
    let file = File::create(&zip_path).map_err(|e| format!("无法创建文件: {}", e))?;
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
        return Err("没有已翻译的条目可写回".to_string());
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
    let dest_file = File::create(dest).map_err(|e| format!("无法创建文件: {}", e))?;
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
            placeholders: Vec::new(),
            notes: Vec::new(),
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
            placeholders: vec![],
            notes: vec![],
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
