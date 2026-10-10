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
///
/// `rewrite_class` = true 时额外处理**代码内嵌文本**：写死在 `.class` 常量池里的
/// 字面量（`ldc "Player Render"` 这类）只有把字节改掉才能汉化，语言文件和资源包
/// 都够不着它。默认 false —— 不开启时产物与历史版本逐字节一致。
pub fn export_mod_jar(
    source: &Path,
    dest: &Path,
    modid: &str,
    entries: &[LangEntry],
    lang_format: LangFormat,
    rewrite_class: bool,
) -> Result<String, String> {
    let translated: Vec<&LangEntry> = entries
        .iter()
        .filter(|e| e.translation.as_ref().is_some_and(|t| !t.is_empty()))
        .collect();
    if translated.is_empty() {
        return Err("没有可导出的内容：当前勾选项中没有\"已翻译完成\"的条目。请确认：① 已勾选要导出的条目；② 这些条目的翻译状态不是红色（失败）。".to_string());
    }

    let lang_rel = format!(
        "assets/{}/lang/zh_cn.{}",
        modid,
        if lang_format == LangFormat::LegacyLang {
            "lang"
        } else {
            "json"
        }
    );

    // 硬编码条目分两条通道：
    //   · 数据文件里的文本（json/toml/…）→ 按 json 路径替换原值；
    //   · **代码内嵌文本**（.class 常量池）→ 走字节码改写，键里的
    //     `const:N` 只是个记号，真正靠"原文内容"去常量池里匹配。
    // 两者判据就是宿主文件后缀：写在代码里的只有改字节码一途，
    // 写在数据文件里的本来就该直接改文件。
    let mut hardcoded_changes: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut class_tables: HashMap<String, HashMap<Vec<u8>, String>> = HashMap::new();
    for e in translated.iter() {
        if !e.hardcoded {
            continue;
        }
        let Some(tr) = e.translation.clone() else {
            continue;
        };
        if e.file_path.to_lowercase().ends_with(".class") {
            if rewrite_class {
                // 用修改版 UTF-8 编码去匹配常量池里的原始字节：
                // BMP 无 NUL 时与标准 UTF-8 一致，非 BMP 才会分叉（那时本来就匹配不上）。
                class_tables
                    .entry(e.file_path.clone())
                    .or_default()
                    .insert(crate::core::class_pool::mutf8_encode(&e.source), tr);
            }
            continue;
        }
        let Some((path, json_path)) = e.key.split_once('#') else {
            continue;
        };
        hardcoded_changes
            .entry(path.to_string())
            .or_default()
            .push((json_path.to_string(), tr));
    }

    let src_file = File::open(source).map_err(|e| format!("无法打开源 jar: {}", e))?;
    let mut src = zip::ZipArchive::new(src_file).map_err(|e| e.to_string())?;
    // 扫描侧存的是**归一化后**的路径（"整个内容套一层文件夹"的 jar 会剥掉公共前缀），
    // 而导出侧此前比对的是 zip 里的原始名字 → 前缀一非空就永不命中，
    // 该 jar 的全部硬编码条目静默失效。这里用同一套口径（core::pack）对齐两边。
    let all_names: Vec<String> = (0..src.len())
        .filter_map(|i| src.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = crate::core::pack::common_root_prefix(&all_names);
    let lang_path = format!("{}{}", root_prefix.as_deref().unwrap_or(""), lang_rel);

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

    let mut cls_rewritten = 0usize;
    let mut cls_shadowed = 0usize;
    let mut cls_unmatched = 0usize;

    // 复制原 jar 全部条目（跳过将写入的 zh_cn，防止重复）
    for i in 0..src.len() {
        let mut f = src.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = f.name().to_string();
        let name = crate::core::pack::strip_root(&raw_name, root_prefix.as_deref());
        if name == lang_rel {
            continue;
        }
        let opts = SimpleFileOptions::default().compression_method(f.compression());
        out.start_file(raw_name, opts).map_err(|e| e.to_string())?;
        let class_hit = class_tables.get(&name);
        let json_hit = hardcoded_changes.get(&name);

        if class_hit.is_none() && json_hit.is_none() {
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
            continue;
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;

        // ① 代码内嵌文本：字节码常量池改写。任何一步不放心就写回原字节，
        //    绝不产出一个"半改"的 class（那会让游戏 ClassFormatError）。
        if let Some(table) = class_hit {
            let (new_bytes, stat) = crate::core::class_pool::apply_translations(&buf, table);
            cls_rewritten += stat.rewritten;
            cls_shadowed += stat.shadowed;
            cls_unmatched += stat.unmatched;
            out.write_all(&new_bytes).map_err(|e| e.to_string())?;
            continue;
        }

        // ② 数据文件里的硬编码文本：JSON 路径替换
        if let Some(changes) = json_hit {
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
        }
        out.write_all(&buf).map_err(|e| e.to_string())?;
    }

    // 写入 zh_cn 语言文件（有公共前缀时写在前缀内，否则会落在包外）
    //
    // 开启代码内嵌改写时，把 `.class` 条目的 `路径#const:N` 从语言文件里去掉：
    // 它本来就不是语言键（是工具为"把译文找个地方存"造出来的记号），
    // 交给字节码后端之后留在语言文件里只会变成一堆没人查的死键。
    // 开关关闭时**不做**这层过滤 —— 保证产物与历史版本逐字节一致。
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let pairs: Vec<(String, String)> = translated
        .iter()
        .filter(|e| !(rewrite_class && e.hardcoded && e.file_path.to_lowercase().ends_with(".class")))
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
    if rewrite_class && (cls_rewritten + cls_shadowed + cls_unmatched) > 0 {
        crate::logging::info(&format!(
            "汉化 jar：字节码改写 {cls_rewritten} 处常量池字面量（跳过 {cls_shadowed} 处兼作标识符、{cls_unmatched} 处未匹配）"
        ));
    }
    Ok(dest.to_string_lossy().to_string())
}

/// 按 json 路径（`.` 分隔，数组下标为数字）设置字符串值，成功返回 true。
///
/// ⚠️ **点号未必是分隔符**。模组的 `config/*.json` 里扁平点号键很常见
/// （`{"msg.welcome": "..."}`），而扫描侧的路径是拿 `{父路径}.{键名}` 拼出来的
/// （`jar.rs::collect_json_strings`），两者在字符串上完全同形 —— 同一串
/// `msg.welcome` 既可能是"键名带点"，也可能是"两层嵌套"。
///
/// 旧实现一律按 `.` 硬切：扁平键被当成两层 → 父键不存在 → 返回 false →
/// 调用方静默写回原字节。用户看到的就是"扫出来了、翻译了，但就是没生效"。
///
/// 现在的策略是**整段优先 + 全切分点回溯**：
/// 1. 先看当前对象里有没有一个键**就叫整条路径**（扁平点号键的解法）；
/// 2. 再在每个 `.` 处切 head/tail 递归下钻（真嵌套的解法）；
/// 3. 单段路径沿用旧行为（对象上直接写，键不存在则新建）。
/// 路径确实不存在时仍然返回 false，**不会凭空造键**。
fn set_json_path(value: &mut serde_json::Value, path: &str, new_val: &str) -> bool {
    set_json_path_at(value, path, new_val, 0)
}

/// 递归深度上限：路径段数本来就是个位数，这里只是防止病态输入把回溯放大。
const JSON_PATH_MAX_DEPTH: usize = 24;

fn set_json_path_at(
    value: &mut serde_json::Value,
    path: &str,
    new_val: &str,
    depth: usize,
) -> bool {
    if depth > JSON_PATH_MAX_DEPTH {
        return false;
    }
    let single = !path.contains('.');
    match value {
        serde_json::Value::Object(obj) => {
            // 整段命中（含扁平点号键），单段时无论存在与否都写（沿用旧行为）
            if single || obj.contains_key(path) {
                obj.insert(
                    path.to_string(),
                    serde_json::Value::String(new_val.to_string()),
                );
                return true;
            }
        }
        serde_json::Value::Array(arr) => {
            if single {
                if let Ok(idx) = path.parse::<usize>() {
                    if idx < arr.len() {
                        arr[idx] = serde_json::Value::String(new_val.to_string());
                        return true;
                    }
                }
            }
            return false;
        }
        _ => return false,
    }
    // 多段：对每个 `.` 位置尝试 head / tail 切分
    for (i, b) in path.bytes().enumerate() {
        if b != b'.' {
            continue;
        }
        let head = &path[..i];
        let tail = &path[i + 1..];
        if head.is_empty() || tail.is_empty() {
            continue;
        }
        let child = match value {
            serde_json::Value::Object(m) => m.get_mut(head),
            serde_json::Value::Array(a) => head.parse::<usize>().ok().and_then(|ix| a.get_mut(ix)),
            _ => None,
        };
        if let Some(c) = child {
            if set_json_path_at(c, tail, new_val, depth + 1) {
                return true;
            }
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
        export_mod_jar(&src, &dest, "testmod", &entries, LangFormat::Json, false).unwrap();

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
        let e1 = sample_entry("item.x.name", "Sword", Some("剑"));
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
        export_mod_jar(&src, &dest, "hcmod", &[e1, e2], LangFormat::Json, false).unwrap();
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
    #[test]
    fn set_json_path_handles_flat_dotted_keys() {
        // 扁平点号键：整段就是键名（旧实现按 `.` 硬切 → 永远找不到）
        let mut v = serde_json::json!({"msg.welcome": "old", "other": 1});
        assert!(set_json_path(&mut v, "msg.welcome", "新"));
        assert_eq!(v["msg.welcome"], "新");
        // 真嵌套照旧可用
        let mut v2 = serde_json::json!({"a": {"b": {"c": "old"}}});
        assert!(set_json_path(&mut v2, "a.b.c", "新"));
        assert_eq!(v2["a"]["b"]["c"], "新");
        // 嵌套里再带点号键
        let mut v3 = serde_json::json!({"a": {"b.c": "old"}});
        assert!(set_json_path(&mut v3, "a.b.c", "新"));
        assert_eq!(v3["a"]["b.c"], "新");
        // 点号键在父层
        let mut v4 = serde_json::json!({"a.b": {"c": "old"}});
        assert!(set_json_path(&mut v4, "a.b.c", "新"));
        assert_eq!(v4["a.b"]["c"], "新");
        // 数组下标
        let mut v5 = serde_json::json!({"a": {"b": ["x", "y"]}});
        assert!(set_json_path(&mut v5, "a.b.1", "新"));
        assert_eq!(v5["a"]["b"][1], "新");
        // 确实不存在 → false，绝不凭空造键
        let mut v6 = serde_json::json!({"a": 1});
        assert!(!set_json_path(&mut v6, "nope.deep", "x"));
    }

    /// 代码内嵌文本（`.class` 常量池）的导出：开关关掉必须与历史版本一致，
    /// 打开才改字节码，且"兼作标识符"的字面量一律不动。
    #[test]
    fn export_mod_jar_rewrites_class_literals() {
        use crate::core::class_pool;
        let cls = class_pool::sample_class();
        let src = std::env::temp_dir().join("cls_source.jar");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            w.start_file("assets/clsmod/lang/en_us.json", opts).unwrap();
            w.write_all(br#"{"item.x.name":"Sword"}"#).unwrap();
            w.start_file("haage/T.class", opts).unwrap();
            w.write_all(&cls).unwrap();
            w.finish().unwrap();
        }
        let lang = sample_entry("item.x.name", "Sword", Some("剑"));
        let mut cls_entry = sample_entry("haage/T.class#const:4", "Player Render", Some("玩家渲染"));
        cls_entry.file_path = "haage/T.class".into();
        cls_entry.hardcoded = true;
        cls_entry.deep_group = Some("class_text".into());
        // 兼作字段名 → 安全策略必须拒绝改写
        let mut shadowed = sample_entry("haage/T.class#const:6", "Armour", Some("护甲"));
        shadowed.file_path = "haage/T.class".into();
        shadowed.hardcoded = true;
        shadowed.deep_group = Some("class_text".into());

        let all = vec![lang, cls_entry, shadowed];

        // ── 开关关闭：产物与历史版本一致 ──
        let dest_off = std::env::temp_dir().join("cls_off.jar");
        export_mod_jar(&src, &dest_off, "clsmod", &all, LangFormat::Json, false).unwrap();
        {
            let f = File::open(&dest_off).unwrap();
            let mut a = zip::ZipArchive::new(f).unwrap();
            let mut got = Vec::new();
            a.by_name("haage/T.class").unwrap().read_to_end(&mut got).unwrap();
            assert_eq!(got, cls, "开关关闭时 class 必须逐字节不变");
            let mut zh = String::new();
            a.by_name("assets/clsmod/lang/zh_cn.json")
                .unwrap()
                .read_to_string(&mut zh)
                .unwrap();
            assert!(zh.contains("const:"), "关闭时保留历史行为：记号仍写进语言文件");
        }

        // ── 开关打开：真的改字节码 ──
        let dest_on = std::env::temp_dir().join("cls_on.jar");
        export_mod_jar(&src, &dest_on, "clsmod", &all, LangFormat::Json, true).unwrap();
        {
            let f = File::open(&dest_on).unwrap();
            let mut a = zip::ZipArchive::new(f).unwrap();
            let mut got = Vec::new();
            a.by_name("haage/T.class").unwrap().read_to_end(&mut got).unwrap();
            assert!(got.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]), "魔数必须完好");
            let strings = class_pool::scan_strings(&got);
            assert!(strings.iter().any(|s| s == "玩家渲染"), "字面量应被改写");
            assert!(strings.iter().any(|s| s == "Armour"), "兼作字段名的字面量必须原样");
            assert!(!strings.iter().any(|s| s == "护甲"));
            // 改写后仍是一个结构完好、可安全再改的 class
            let cp = class_pool::ClassPool::parse(&got).unwrap();
            cp.name_owned().unwrap();
            let mut zh = String::new();
            a.by_name("assets/clsmod/lang/zh_cn.json")
                .unwrap()
                .read_to_string(&mut zh)
                .unwrap();
            assert!(!zh.contains("const:"), "开启后不再把这些记号写进语言文件");
            assert!(zh.contains("剑"));
        }

        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dest_off).ok();
        std::fs::remove_file(&dest_on).ok();
    }

    /// 「整个内容套一层文件夹」的 jar：扫描侧存归一化路径、导出侧也必须归一化，
    /// 否则 `hardcoded_changes` 永不命中 → 该 jar 的硬编码条目全部静默失效。
    #[test]
    fn export_mod_jar_matches_hardcoded_under_root_prefix() {
        let src = std::env::temp_dir().join("wrap_source.jar");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            w.start_file("wrapper/config/demo.json", opts).unwrap();
            w.write_all(br#"{"message":"Welcome"}"#).unwrap();
            w.start_file("wrapper/fabric.mod.json", opts).unwrap();
            w.write_all(br#"{"id":"wrapmod"}"#).unwrap();
            w.finish().unwrap();
        }
        let mut e = sample_entry("config/demo.json#message", "Welcome", Some("欢迎"));
        e.file_path = "config/demo.json".into(); // 扫描侧存的就是归一化后的路径
        e.hardcoded = true;

        let dest = std::env::temp_dir().join("wrap_dest.jar");
        export_mod_jar(&src, &dest, "wrapmod", &[e], LangFormat::Json, false).unwrap();
        let f = File::open(&dest).unwrap();
        let mut a = zip::ZipArchive::new(f).unwrap();
        let mut cfg = String::new();
        a.by_name("wrapper/config/demo.json")
            .unwrap()
            .read_to_string(&mut cfg)
            .unwrap();
        assert!(cfg.contains("欢迎"), "带顶层包裹的 jar 也必须命中: {cfg}");
        // 语言文件必须写在包裹内，否则等于落在包外、游戏读不到
        assert!(a.by_name("wrapper/assets/wrapmod/lang/zh_cn.json").is_ok());
        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dest).ok();
    }
    /// 全链路探针（默认跳过，靠环境变量触发）：
    ///
    /// ```text
    /// MCL_E2E_PROBE=<源 jar> MCL_E2E_PROBE_OUT=<输出 jar> cargo test
    /// ```
    ///
    /// 走一遍真实链路「深度扫描 → 填译文 → 导出汉化 jar（开字节码改写）」。
    /// 单测里的夹具是手搓的，探针的意义在于用**真实的第三方 jar** 验证
    /// 扫描侧产出的 `file_path` 与导出侧的匹配口径确实对得上 —— 这是
    /// "扫出来了却改不到"最容易出问题的地方。
    #[test]
    fn end_to_end_probe_on_real_jar() {
        let (Ok(src), Ok(dst)) = (
            std::env::var("MCL_E2E_PROBE"),
            std::env::var("MCL_E2E_PROBE_OUT"),
        ) else {
            return;
        };
        let rules = crate::core::scan_rules::DeepScanRules::full(false);
        let res = crate::core::deep_scan::deep_scan_jar(std::path::Path::new(&src), "probe", &rules)
            .expect("深度扫描失败");
        let mut entries = res.entries;
        let mut n_class = 0usize;
        for e in entries.iter_mut() {
            e.translation = Some(format!("〔{}〕", e.source));
            e.status = crate::core::model::EntryStatus::AiTranslated;
            if e.file_path.to_lowercase().ends_with(".class") {
                n_class += 1;
            }
        }
        assert!(n_class > 0, "深度扫描应当产出 .class 内嵌文本条目");
        export_mod_jar(
            std::path::Path::new(&src),
            std::path::Path::new(&dst),
            "probe",
            &entries,
            LangFormat::Json,
            true,
        )
        .expect("导出失败");
        std::fs::write(
            format!("{dst}.info"),
            format!("entries={} class_items={n_class}\n", entries.len()),
        )
        .ok();

        // 第二段：同一批条目、开关**关闭**再导一次。产物必须与"今天的行为"逐字节一致 ——
        // 即 `.class` 成员一个字节都不动、语言文件仍照旧带 `#const:N` 伪键。
        // 这是用户划的界限（"原本能汉化的就不改动，算是极端情况的兜底"）的回归证据。
        if let Ok(dst_off) = std::env::var("MCL_E2E_PROBE_OUT_OFF") {
            export_mod_jar(
                std::path::Path::new(&src),
                std::path::Path::new(&dst_off),
                "probe",
                &entries,
                LangFormat::Json,
                false,
            )
            .expect("关档导出失败");
        }
    }
}

#[cfg(test)]
mod serde_tests {
    use super::*;

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

/// 插件导出条目：jar 内文件 + 键路径 + 译文 +（`.class` 内嵌文本用）原文
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExportItem {
    pub file_path: String,
    pub key_path: String,
    pub translation: String,
    /// 原文。只有「代码内嵌文本」（`.class` 常量池）用得上 —— 它靠**内容**去常量池里
    /// 匹配字面量，而不是靠 `key_path` 里的 `const:N` 序号（序号会随版本漂移）。
    /// 老前端不传时为空串，此时该类条目按"未匹配"跳过，不会改错。
    #[serde(default)]
    pub source: String,
}

/// 能安全地当文本重写的成员扩展名 —— **白名单**，与插件常规扫描的收口一致
/// （`core/plugin.rs` 只收 `.yml/.yaml/.properties/.json`）。其余一律原字节复制。
///
/// 之所以要立这条规矩：旧实现对所有被翻译的成员都走 `String::from_utf8_lossy`
/// 再写回，`.class` 落到最后一档"yaml 文本替换"里，有损转换把魔数
/// `CA FE BA BE` 变成 `EF BF BD EF BF BD`，插件直接 `ClassFormatError`。
const TEXT_MEMBER_EXTS: &[&str] = &[
    ".json", ".yml", ".yaml", ".properties", ".lang", ".toml", ".txt",
];

fn is_text_member(name_lower: &str) -> bool {
    TEXT_MEMBER_EXTS.iter().any(|e| name_lower.ends_with(e))
}

/// 导出汉化插件 jar：复制原 jar，仅替换被翻译的成员；其余成员原字节保留
/// （不重压缩、不破坏插件完整性）。返回摘要（写入/跳过/改写条数）。
///
/// 成员按类型分流：
/// * `.class` → 「代码内嵌文本」字节码改写（`rewrite_class` 为真时），否则原字节写回；
/// * 白名单里的文本扩展 **且** 内容确是合法 UTF-8 → 文本级替换；
/// * 其余一律原字节写回（二进制永远不碰）。
pub fn export_plugin_jar(
    source: &Path,
    dest: &Path,
    items: &[PluginExportItem],
    rewrite_class: bool,
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
    let mut cls_rewritten = 0usize;
    let mut cls_skipped = 0usize;
    let mut cls_disabled = 0usize;

    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let Some(list) = by_file.get(name.as_str()).cloned() else {
            // 未翻译的成员：原字节复制（不重压缩）
            w.raw_copy_file(f).map_err(|e| e.to_string())?;
            continue;
        };

        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut buf).map_err(|e| e.to_string())?;
        let compression = f.compression();
        let unix_mode = f.unix_mode();
        let lower = name.to_lowercase();

        let payload: Vec<u8> = if lower.ends_with(".class") {
            if rewrite_class {
                let mut table: HashMap<Vec<u8>, String> = HashMap::new();
                for it in &list {
                    if it.source.is_empty() {
                        continue;
                    }
                    table.insert(
                        crate::core::class_pool::mutf8_encode(&it.source),
                        it.translation.clone(),
                    );
                }
                let asked = table.len();
                let (new_bytes, stat) = crate::core::class_pool::apply_translations(&buf, &table);
                cls_rewritten += stat.rewritten;
                cls_skipped += asked.saturating_sub(stat.rewritten);
                new_bytes
            } else {
                cls_disabled += 1;
                buf
            }
        } else if !is_text_member(&lower) || std::str::from_utf8(&buf).is_err() {
            // 非文本成员，或自称文本其实不是合法 UTF-8 → 原字节写回
            buf
        } else {
            let text = String::from_utf8_lossy(&buf).into_owned();
            let (new_text, rep, miss) = if lower.ends_with(".json") {
                rewrite_json_text(&text, &list)
            } else if lower.ends_with(".properties") {
                rewrite_properties_text(&text, &list)
            } else {
                rewrite_yaml_text(&text, &list)
            };
            written += rep;
            skipped += miss;
            new_text.into_bytes()
        };

        let opts = SimpleFileOptions::default()
            .compression_method(compression)
            .unix_permissions(unix_mode.unwrap_or(0o644));
        w.start_file(name, opts).map_err(|e| e.to_string())?;
        w.write_all(&payload).map_err(|e| e.to_string())?;
    }
    w.finish().map_err(|e| e.to_string())?;

    let mut msg = format!("已写入 {written} 条译文");
    if skipped > 0 {
        msg.push_str(&format!("，跳过 {skipped} 条（原文件中未找到对应键）"));
    }
    if cls_rewritten > 0 {
        msg.push_str(&format!("；字节码改写 {cls_rewritten} 处代码内嵌文本"));
    }
    if cls_skipped > 0 {
        msg.push_str(&format!("（{cls_skipped} 处未匹配或不可改写，已原样保留）"));
    }
    if cls_disabled > 0 {
        msg.push_str(&format!(
            "；{cls_disabled} 个 .class 成员未改写（设置 →「个性化设置」里开启「改写代码内嵌文本」后可用）"
        ));
    }
    Ok(msg)
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
            source: String::new(),
        }
    }

    /// 带原文的条目（`.class` 内嵌文本走内容匹配，必须有 source）
    fn item_src(fp: &str, kp: &str, src: &str, tr: &str) -> PluginExportItem {
        PluginExportItem {
            file_path: fp.into(),
            key_path: kp.into(),
            translation: tr.into(),
            source: src.into(),
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
        let summary = export_plugin_jar(&src, &dst, &items, false).unwrap();
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

    /// 回归：`from_utf8_lossy` 曾经把 `.class` 写坏（`CA FE BA BE` →
    /// `EF BF BD EF BF BD`）。二进制成员**永远**原字节保留，无论是否被翻译。
    #[test]
    fn plugin_export_never_corrupts_class_members() {
        use crate::core::class_pool;
        let cls = class_pool::sample_class();
        let src = std::env::temp_dir().join("plug_cls_src.jar");
        let dst = std::env::temp_dir().join("plug_cls_dst.jar");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            w.start_file("config.yml", opts).unwrap();
            w.write_all(b"messages:\n  welcome: Hi\n").unwrap();
            w.start_file("com/example/T.class", opts).unwrap();
            w.write_all(&cls).unwrap();
            w.finish().unwrap();
        }
        // 老前端不传 source 的条目：会被当成"未匹配"跳过，但绝不能写坏文件
        let items = vec![
            item("config.yml", "messages.welcome", "你好"),
            item("com/example/T.class", "const:4", "玩家渲染"),
        ];
        let summary = export_plugin_jar(&src, &dst, &items, false).unwrap();
        assert!(summary.contains("已写入 1"), "{summary}");
        let f = File::open(&dst).unwrap();
        let mut a = zip::ZipArchive::new(f).unwrap();
        let mut got = Vec::new();
        a.by_name("com/example/T.class").unwrap().read_to_end(&mut got).unwrap();
        assert_eq!(got, cls, "二进制成员必须逐字节保留");
        assert!(got.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]), "魔数不得损坏");
        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }

    /// 开关打开时，插件的 `.class` 也走字节码改写（不再走文本替换）。
    #[test]
    fn plugin_export_rewrites_class_literals_when_enabled() {
        use crate::core::class_pool;
        let cls = class_pool::sample_class();
        let src = std::env::temp_dir().join("plug_cls2_src.jar");
        let dst = std::env::temp_dir().join("plug_cls2_dst.jar");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            w.start_file("com/example/T.class", opts).unwrap();
            w.write_all(&cls).unwrap();
            w.finish().unwrap();
        }
        let items = vec![
            item_src("com/example/T.class", "const:4", "Player Render", "玩家渲染"),
            item_src("com/example/T.class", "const:6", "Armour", "护甲"), // 兼作字段名 → 拒改
        ];
        let summary = export_plugin_jar(&src, &dst, &items, true).unwrap();
        assert!(summary.contains("字节码改写 1"), "{summary}");
        let f = File::open(&dst).unwrap();
        let mut a = zip::ZipArchive::new(f).unwrap();
        let mut got = Vec::new();
        a.by_name("com/example/T.class").unwrap().read_to_end(&mut got).unwrap();
        let strings = class_pool::scan_strings(&got);
        assert!(strings.iter().any(|s| s == "玩家渲染"));
        assert!(strings.iter().any(|s| s == "Armour"));
        assert!(!strings.iter().any(|s| s == "护甲"));
        class_pool::ClassPool::parse(&got).unwrap().name_owned().unwrap();
        std::fs::remove_file(&src).ok();
        std::fs::remove_file(&dst).ok();
    }
}
