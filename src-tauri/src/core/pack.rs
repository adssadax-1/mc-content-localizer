use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use zip::ZipArchive;

use super::lang;
use super::model::{EntryStatus, LangEntry};
use super::placeholder;

/// 内容包类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PackType {
    /// 模组 jar
    Mod,
    /// 光影包 zip
    Shader,
    /// 资源包 zip
    ResourcePack,
}

/// 光影包解析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderPack {
    pub file_name: String,
    pub name: String,
    pub has_zh: bool,
    pub zh_count: usize,
    pub entries: Vec<LangEntry>,
}

/// 资源包解析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePackInfo {
    pub file_name: String,
    pub name: String,
    pub entries: Vec<LangEntry>,
}

#[derive(Debug, Error)]
pub enum PackError {
    #[error("无法打开文件: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip 读取失败: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("光影包内没有找到 shaders.properties（可能不是光影包）")]
    NotShaderPack,
    #[error("资源包内没有找到 pack.mcmeta（可能不是资源包）")]
    NotResourcePack,
    #[error("pack.mcmeta 中没有可翻译的描述文本（description 为空或缺失）")]
    NoDescription,
    #[error("无法识别的内容包类型（不是模组/光影包/资源包）")]
    UnknownPack,
    #[error("properties 解析失败: {0}")]
    Lang(#[from] lang::LangError),
    #[error("JSON 解析失败: {0}")]
    Json(#[from] serde_json::Error),
}

/// 扫描 zip 目录结构，判定内容包类型（不解析内容，杜绝误判）

/// 计算 zip 的公共根目录前缀：所有文件都在单一顶层文件夹内时返回 "X/"，否则 None。
/// 兼容"整个内容包被套了一层文件夹"的 zip（如 Bliss-Shader-Unstable/...）。
/// 顶层名是标准根（assets/shaders/META-INF）时不剥离，杜绝误剥。
/// 剥离顶层文件夹前缀（无前缀时原样返回，返回 owned 避免临时值生命周期问题）
pub fn strip_root(n: &str, prefix: Option<&str>) -> String {
    n.strip_prefix(prefix.unwrap_or("")).unwrap_or(n).to_string()
}

pub fn common_root_prefix(names: &[String]) -> Option<String> {
    if names.len() < 2 {
        return None;
    }
    let mut prefix: Option<String> = None;
    for n in names {
        if n.ends_with('/') {
            continue; // 目录条目
        }
        let first = n.split('/').next()?;
        if first.is_empty() || !n.contains('/') {
            return None; // 存在根级散文件 → 不是文件夹包装
        }
        match &prefix {
            None => prefix = Some(format!("{}/", first)),
            Some(p) => {
                if !n.starts_with(p.as_str()) {
                    return None;
                }
            }
        }
    }
    let p = prefix?;
    let top = p.trim_end_matches('/');
    if ["assets", "shaders", "META-INF"].contains(&top) {
        return None;
    }
    Some(p)
}

pub fn detect_pack_type(path: &Path) -> Result<PackType, PackError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    let mut has_shader_props = false;
    let mut has_shader_lang = false;
    let mut has_mcmeta = false;
    let mut has_mod_meta = false;
    let mut has_jar_assets = false;

    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = common_root_prefix(&names);

    for i in 0..archive.len() {
        let name = strip_root(archive.by_index(i)?.name(), root_prefix.as_deref());
        if name == "shaders/shaders.properties" {
            has_shader_props = true;
        } else if name.starts_with("shaders/lang/") && name.ends_with(".lang") {
            has_shader_lang = true;
        } else if name == "pack.mcmeta" {
            has_mcmeta = true;
        } else if name == "fabric.mod.json"
            || name == "quilt.mod.json"
            || name == "META-INF/mods.toml"
            || name == "META-INF/neoforge.mods.toml"
        {
            has_mod_meta = true;
        } else if name.starts_with("META-INF/")
            || (name.starts_with("assets/") && name.contains("/lang/") && name.ends_with(".json"))
        {
            has_jar_assets = true;
        }
    }

    // 优先级：光影 > 模组（有 mod 元数据，即使带 pack.mcmeta 也是模组）> 资源包 > 模组（assets lang）
    if has_shader_props || has_shader_lang {
        return Ok(PackType::Shader);
    }
    if has_mod_meta {
        return Ok(PackType::Mod);
    }
    if has_mcmeta {
        return Ok(PackType::ResourcePack);
    }
    if has_jar_assets {
        return Ok(PackType::Mod);
    }
    Err(PackError::UnknownPack)
}

/// 解析光影包：
/// - 文本来源：shaders/shaders.properties 优先；缺失时回退 shaders/lang/en_US.lang（新版光影结构）
/// - shaders/lang/zh_CN.lang（或 zh_CN.properties）作为自带中文
pub fn parse_shader_pack(path: &Path) -> Result<ShaderPack, PackError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut shader_props: Option<Vec<(String, String)>> = None;
    // 全部语言文件（小写语言名 → 键值对）：大小写无关，zh_cn / zh_CN / ZH_cn 都认
    // 小写语言名 → (原始文件名, 键值对)：大小写无关，zh_cn / zh_CN / ZH_cn 都认
    let mut lang_map: HashMap<String, (String, Vec<(String, String)>)> = HashMap::new();
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = common_root_prefix(&names);

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let entry_name = strip_root(f.name(), root_prefix.as_deref());
        if entry_name == "shaders/shaders.properties" {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            let text = String::from_utf8_lossy(&buf);
            shader_props = Some(lang::parse_properties_utf8(&text)?);
            continue;
        }
        if entry_name.starts_with("shaders/lang/") && entry_name.ends_with(".lang") {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            let text = String::from_utf8_lossy(&buf);
            let pairs = lang::parse_properties_utf8(&text)?;
            let lower_locale = entry_name
                .rsplit_once('/')
                .map(|(_, f)| f.trim_end_matches(".lang").to_ascii_lowercase())
                .unwrap_or_default();
            lang_map.insert(lower_locale, (entry_name.to_string(), pairs));
        }
    }

    // 自带中文：任何 zh* 变体（大小写无关）；简体优先，繁体仅补缺
    let mut zh_map: HashMap<String, String> = HashMap::new();
    for locale in ["zh_cn", "zh_hk"] {
        if let Some((_, pairs)) = lang_map.get(locale) {
            for (k, v) in pairs {
                zh_map.insert(k.clone(), v.clone());
            }
        }
    }
    for (loc, (_, pairs)) in &lang_map {
        if loc.starts_with("zh") {
            for (k, v) in pairs {
                zh_map.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
    }

    // 源语言：en_us / en_gb 优先，其次其他 en*，最后第一个非中文语言
    let pick = |pred: &dyn Fn(&str) -> bool| -> Option<(String, Vec<(String, String)>)> {
        lang_map
            .iter()
            .find(|(loc, _)| !loc.starts_with("zh") && pred(loc))
            .map(|(_, (name, pairs))| (name.clone(), pairs.clone()))
    };
    let lang_source = pick(&|l: &str| l == "en_us")
        .or_else(|| pick(&|l: &str| l == "en_gb"))
        .or_else(|| pick(&|l: &str| l.starts_with("en")))
        .or_else(|| pick(&|_: &str| true));

    // 文本来源：shaders/lang/*.lang 优先（option/value/screen 键即 OptiFine 可翻译文本）；
    // 无语言文件时回退 shaders/shaders.properties（老结构光影）
    let (props, source_path) = match lang_source {
        Some((p, entries)) => (entries, p),
        None => match shader_props {
            Some(p) => (p, "shaders/shaders.properties".to_string()),
            None => return Err(PackError::NotShaderPack),
        },
    };

    // 光影名：取 zip 注释，否则文件名去扩展名（先算好再 move file_name）
    let name = file_name
        .rsplit_once('.')
        .map(|(n, _)| n.to_string())
        .unwrap_or_else(|| file_name.clone());
    let file_name_final = file_name;

    // 组装条目：值看起来像可翻译文本的才收（过滤纯内部 id）
    let mut entries: Vec<LangEntry> = Vec::new();
    let mut zh_count = 0;
    for (k, v) in props {
        if v.trim().is_empty() {
            continue;
        }
        let existing = zh_map.get(&k).cloned();
        let has_existing = existing.is_some();
        let placeholders = placeholder::extract_placeholders(&v);
        entries.push(LangEntry {
            key: k,
            source: v,
            file_path: source_path.clone(),
            modid: "shader".to_string(),
            translation: existing,
            hardcoded: false,
            status: if has_existing {
                EntryStatus::ExistingZh
            } else {
                EntryStatus::Untranslated
            },
            translating: false,
            placeholders,
            notes: if has_existing {
                vec!["光影自带中文".to_string()]
            } else {
                Vec::new()
            },
        });
        if has_existing {
            zh_count += 1;
        }
    }

    Ok(ShaderPack {
        file_name: file_name_final,
        name,
        has_zh: zh_count > 0,
        zh_count,
        entries,
    })
}

/// 解析资源包：提取 pack.mcmeta 的 pack.description（多行按 \n 拆分为条目）
pub fn parse_resource_pack(path: &Path) -> Result<ResourcePackInfo, PackError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut description = String::new();
    let mut found = false;
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = common_root_prefix(&names);
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        if strip_root(f.name(), root_prefix.as_deref()) != "pack.mcmeta" {
            continue;
        }
        found = true;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        let value: serde_json::Value = serde_json::from_slice(&buf)?;
        description = value
            .pointer("/pack/description")
            .map(extract_description_text)
            .unwrap_or_default();
    }
    if !found {
        return Err(PackError::NotResourcePack);
    }
    if description.trim().is_empty() {
        return Err(PackError::NoDescription);
    }

    let mut entries: Vec<LangEntry> = Vec::new();
    for (i, line) in description.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        entries.push(LangEntry {
            key: format!("pack.description.line{}", i + 1),
            source: line.to_string(),
            file_path: "pack.mcmeta".to_string(),
            modid: "resourcepack".to_string(),
            translation: None,
            hardcoded: false,
            status: EntryStatus::Untranslated,
            translating: false,
            placeholders: placeholder::extract_placeholders(line),
            notes: vec!["资源包描述".to_string()],
        });
    }

    Ok(ResourcePackInfo {
        name: file_name
            .rsplit_once('.')
            .map(|(n, _)| n.to_string())
            .unwrap_or_else(|| file_name.clone()),
        file_name,
        entries,
    })
}

/// 从 description JSON 值中递归提取纯文本（支持字符串 / {text,extra} 对象 / 多语言格式）
fn extract_description_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(map) => {
            // 多语言格式：{"en_us": "...", "zh_cn": "..."} → 优先取英文作为源文本
            for lang in ["en_us", "en", "en_uk", "en_gb", "en_us_old"] {
                if let Some(serde_json::Value::String(s)) = map.get(lang) {
                    if !s.trim().is_empty() {
                        return s.clone();
                    }
                }
            }
            // 普通对象：text + extra 递归拼接
            let mut out = String::new();
            if let Some(serde_json::Value::String(t)) = map.get("text") {
                out.push_str(t);
            }
            if let Some(extra) = map.get("extra").and_then(|e| e.as_array()) {
                for e in extra {
                    out.push_str(&extract_description_text(e));
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// 导出汉化光影包：复制原 zip + 写入 shaders/lang/zh_CN.lang（不修改原 properties）
pub fn export_shader_zh(source: &Path, dest: &Path, entries: &[LangEntry]) -> Result<String, String> {
    let translated: Vec<&LangEntry> = entries
        .iter()
        .filter(|e| e.translation.as_ref().is_some_and(|t| !t.is_empty()))
        .collect();
    if translated.is_empty() {
        return Err("没有可导出的内容：当前勾选项中没有\"已翻译完成\"的条目。请确认：① 已勾选要导出的条目；② 这些条目的翻译状态不是红色（失败）。".to_string());
    }

    let src_file = File::open(source).map_err(|e| format!("无法打开源光影包: {}", e))?;
    let mut src = ZipArchive::new(src_file).map_err(|e| e.to_string())?;
    let dest_file = File::create(dest).map_err(|e| {
        format!(
            "无法将翻译结果保存到「{}」：可能原因：磁盘空间不足 / 无写入权限 / 文件被其他程序占用。请排查后重试。（原始错误：{}）",
            dest.display(),
            e
        )
    })?;
    let mut out = zip::ZipWriter::new(dest_file);

    for i in 0..src.len() {
        let mut f = src.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name.starts_with("shaders/lang/") && name.contains("zh_CN") {
            continue; // 替换旧的中文覆盖文件
        }
        let opts = SimpleFileOptions::default().compression_method(f.compression());
        out.start_file(name, opts).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
    }

    // 写入 zh_CN.lang（properties 编码：UTF-8）
    let pairs: Vec<(String, String)> = translated
        .iter()
        .map(|e| (e.key.clone(), e.translation.clone().unwrap()))
        .collect();
    let mut lang_text = String::new();
    for (k, v) in &pairs {
        lang_text.push_str(&escape_properties_value(k));
        lang_text.push('=');
        lang_text.push_str(&escape_properties_value(v));
        lang_text.push('\n');
    }
    out.start_file(
        "shaders/lang/zh_CN.lang",
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )
    .map_err(|e| e.to_string())?;
    out.write_all(lang_text.as_bytes()).map_err(|e| e.to_string())?;

    out.finish().map_err(|e| e.to_string())?;
    // 验证文件真实生成，避免静默失败
    verify_zip_written(dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// 验证导出 zip 已真实写入磁盘（存在且非空）
fn verify_zip_written(dest: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(dest).map_err(|e| format!("导出文件写入后无法读取: {}", e))?;
    if meta.len() == 0 {
        return Err("导出文件为空（写入异常）".to_string());
    }
    Ok(())
}

/// 导出改描述后的资源包：复制原 zip + 更新 pack.mcmeta 的 description
pub fn export_resource_pack_desc(
    source: &Path,
    dest: &Path,
    entries: &[LangEntry],
) -> Result<String, String> {
    let translated: Vec<&LangEntry> = entries
        .iter()
        .filter(|e| e.translation.as_ref().is_some_and(|t| !t.is_empty()))
        .collect();
    if translated.is_empty() {
        return Err("没有可导出的内容：当前勾选项中没有\"已翻译完成\"的条目。请确认：① 已勾选要导出的条目；② 这些条目的翻译状态不是红色（失败）。".to_string());
    }

    let src_file = File::open(source).map_err(|e| format!("无法打开源资源包: {}", e))?;
    let mut src = ZipArchive::new(src_file).map_err(|e| e.to_string())?;
    let dest_file = File::create(dest).map_err(|e| {
        format!(
            "无法将翻译结果保存到「{}」：可能原因：磁盘空间不足 / 无写入权限 / 文件被其他程序占用。请排查后重试。（原始错误：{}）",
            dest.display(),
            e
        )
    })?;
    let mut out = zip::ZipWriter::new(dest_file);

    let mut new_description: Option<String> = None;
    for i in 0..src.len() {
        let mut f = src.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        let opts = SimpleFileOptions::default().compression_method(f.compression());
        out.start_file(name.clone(), opts).map_err(|e| e.to_string())?;
        if name == "pack.mcmeta" {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            let mut value: serde_json::Value =
                serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
            // 组装新 description（多行）
            let mut lines: Vec<String> = Vec::new();
            for e in translated.iter() {
                lines.push(e.translation.clone().unwrap());
            }
            let desc = lines.join("\\n");
            if let Some(pack) = value.get_mut("pack") {
                if let Some(d) = pack.get_mut("description") {
                    *d = serde_json::Value::String(desc.clone());
                    new_description = Some(desc);
                }
            }
            let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
            out.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            std::io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
        }
    }

    if new_description.is_none() {
        return Err("pack.mcmeta 中没有 description 字段".to_string());
    }
    out.finish().map_err(|e| e.to_string())?;
    verify_zip_written(dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// properties 值转义（: = # ! 前加反斜杠，\n 转义）
fn escape_properties_value(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '=' => out.push_str("\\="),
            ':' => out.push_str("\\:"),
            '#' => out.push_str("\\#"),
            '!' => out.push_str("\\!"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_zip(buf: &mut Vec<u8>, files: &[(&str, &str)]) {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    fn parse_buf(buf: &[u8], name: &str) -> (Vec<u8>, std::path::PathBuf) {
        let tmp = std::env::temp_dir().join(name);
        std::fs::write(&tmp, buf).unwrap();
        (buf.to_vec(), tmp)
    }

    #[test]
    fn detects_pack_types() {
        // 光影（en_US.lang 结构，无 shaders.properties）
        let mut buf: Vec<u8> = Vec::new();
        build_zip(&mut buf, &[("shaders/lang/en_US.lang", "screen.x=Hello"), ("shaders/lang/zh_CN.lang", "screen.x=你好")]);
        let (_b, path) = parse_buf(&buf, "detect_shader.zip");
        assert_eq!(detect_pack_type(&path).unwrap(), PackType::Shader);
        let _ = std::fs::remove_file(&path);

        // 资源包
        let mut buf2: Vec<u8> = Vec::new();
        build_zip(&mut buf2, &[("pack.mcmeta", r#"{"pack":{"pack_format":15,"description":"hi"}}"#), ("assets/minecraft/lang/en_us.json", "{}")]);
        let (_b2, path2) = parse_buf(&buf2, "detect_rp.zip");
        assert_eq!(detect_pack_type(&path2).unwrap(), PackType::ResourcePack);
        let _ = std::fs::remove_file(&path2);

        // 模组
        let mut buf3: Vec<u8> = Vec::new();
        build_zip(&mut buf3, &[("META-INF/mods.toml", "modLoader='javafml'"), ("assets/modid/lang/en_us.json", "{}")]);
        let (_b3, path3) = parse_buf(&buf3, "detect_mod.zip");
        assert_eq!(detect_pack_type(&path3).unwrap(), PackType::Mod);
        let _ = std::fs::remove_file(&path3);
    }

    #[test]
    fn parses_wrapped_folder_shader() {
        // 整个内容包被套一层顶层文件夹（如 Bliss-Shader-Unstable/...）→ 应剥离前缀正常解析
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.add_directory("Bliss-Shader-Unstable/shaders/lang/", opts).unwrap();
            w.start_file("Bliss-Shader-Unstable/shaders/lang/en_us.lang", opts).unwrap();
            w.write_all(b"option.x=Hello Shader\n").unwrap();
            w.start_file("Bliss-Shader-Unstable/shaders/lang/zh_cn.lang", opts).unwrap();
            w.write_all("option.x=你好着色\n".as_bytes()).unwrap();
            w.start_file("Bliss-Shader-Unstable/shaders/shaders.properties", opts).unwrap();
            w.write_all(b"sliders=a\n").unwrap();
            w.finish().unwrap();
        }
        let (_b, path) = parse_buf(&buf, "wrapped_shader.zip");
        assert_eq!(detect_pack_type(&path).unwrap(), PackType::Shader);
        let pack = parse_shader_pack(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(pack.entries.len(), 1);
        assert_eq!(pack.entries[0].source, "Hello Shader");
        assert_eq!(pack.entries[0].status, EntryStatus::ExistingZh);
        assert_eq!(pack.zh_count, 1);
    }

    #[test]
    fn parses_shader_from_en_us_lang_fallback() {
        // 新版光影结构：无 shaders.properties，文本在 shaders/lang/en_US.lang
        let mut buf: Vec<u8> = Vec::new();
        build_zip(
            &mut buf,
            &[
                (
                    "shaders/lang/en_US.lang",
                    "screen.title=Complementary Shaders\noption.info1=How to get more performance\nprofile.HIGH=§eHigh\n",
                ),
                ("shaders/lang/zh_CN.lang", "screen.title=互补光影\n"),
            ],
        );
        let (_b, path) = parse_buf(&buf, "complementary_style.zip");
        let pack = parse_shader_pack(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(pack.entries.len(), 3);
        let title = pack.entries.iter().find(|e| e.key == "screen.title").unwrap();
        assert_eq!(title.source, "Complementary Shaders");
        assert_eq!(title.status, EntryStatus::ExistingZh);
        assert_eq!(title.translation.as_deref(), Some("互补光影"));
        let info = pack.entries.iter().find(|e| e.key == "option.info1").unwrap();
        assert_eq!(info.status, EntryStatus::Untranslated);
        assert!(pack.entries.iter().all(|e| e.file_path == "shaders/lang/en_US.lang"));
    }

    #[test]
    fn parses_shader_pack_with_zh() {
        let mut buf: Vec<u8> = Vec::new();
        build_zip(
            &mut buf,
            &[
                (
                    "shaders/shaders.properties",
                    "screen.title=My Shader Settings\nscreen.fps=Show FPS\nscreen.blur=Blur Amount\n",
                ),
                (
                    "shaders/lang/zh_CN.lang",
                    "screen.title=我的光影设置\nscreen.fps=显示帧率\n",
                ),
                ("shaders/shaders/basic.frag", "void main(){}"),
            ],
        );
        let (_b, path) = parse_buf(&buf, "test_shader.zip");
        let pack = parse_shader_pack(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(pack.name, "test_shader");
        assert_eq!(pack.entries.len(), 3);
        let title = pack.entries.iter().find(|e| e.key == "screen.title").unwrap();
        assert_eq!(title.status, EntryStatus::ExistingZh);
        assert_eq!(title.translation.as_deref(), Some("我的光影设置"));
        let blur = pack.entries.iter().find(|e| e.key == "screen.blur").unwrap();
        assert_eq!(blur.status, EntryStatus::Untranslated);
        assert_eq!(pack.has_zh, true);
        assert_eq!(pack.zh_count, 2);
    }

    #[test]
    fn parses_resource_pack_object_and_multilang_description() {
        // {text, extra} 对象格式
        let mut buf: Vec<u8> = Vec::new();
        build_zip(
            &mut buf,
            &[(
                "pack.mcmeta",
                r#"{"pack":{"pack_format":15,"description":{"text":"Cool Pack","extra":[{"text":" v2"},{"text":"!"}]}}}"#,
            )],
        );
        let (_b, path) = parse_buf(&buf, "rp_obj.zip");
        let info = parse_resource_pack(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(info.entries.len(), 1);
        assert_eq!(info.entries[0].source, "Cool Pack v2!");

        // 多语言格式：优先 en_us
        let mut buf2: Vec<u8> = Vec::new();
        build_zip(
            &mut buf2,
            &[(
                "pack.mcmeta",
                r#"{"pack":{"pack_format":15,"description":{"en_us":"English text","zh_cn":"中文"}}}"#,
            )],
        );
        let (_b2, path2) = parse_buf(&buf2, "rp_ml.zip");
        let info2 = parse_resource_pack(&path2).unwrap();
        let _ = std::fs::remove_file(&path2);
        assert_eq!(info2.entries.len(), 1);
        assert_eq!(info2.entries[0].source, "English text");

        // 空描述 → 明确错误
        let mut buf3: Vec<u8> = Vec::new();
        build_zip(
            &mut buf3,
            &[("pack.mcmeta", r#"{"pack":{"pack_format":15,"description":""}}"#)],
        );
        let (_b3, path3) = parse_buf(&buf3, "rp_empty.zip");
        let err = parse_resource_pack(&path3).unwrap_err();
        let _ = std::fs::remove_file(&path3);
        assert!(err.to_string().contains("没有可翻译的描述文本"));
    }

    #[test]
    fn parses_resource_pack_description() {
        let mut buf: Vec<u8> = Vec::new();
        build_zip(
            &mut buf,
            &[(
                "pack.mcmeta",
                r#"{"pack":{"pack_format":15,"description":"A nice pack\nSecond line"}}"#,
            )],
        );
        let (_b, path) = parse_buf(&buf, "test_rp.zip");
        let info = parse_resource_pack(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(info.entries.len(), 2);
        assert_eq!(info.entries[0].source, "A nice pack");
        assert_eq!(info.entries[1].source, "Second line");
    }

    #[test]
    fn exports_shader_zh_lang() {
        let src = std::env::temp_dir().join("sh_src.zip");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("shaders/shaders.properties", opts).unwrap();
            w.write_all(b"screen.title=Title").unwrap();
            w.start_file("shaders/shaders/basic.frag", opts).unwrap();
            w.write_all(b"void main(){}").unwrap();
            w.finish().unwrap();
        }
        let e = LangEntry {
            key: "screen.title".into(),
            source: "Title".into(),
            file_path: "shaders/shaders.properties".into(),
            modid: "shader".into(),
            translation: Some("标题".into()),
            hardcoded: false,
            status: EntryStatus::AiTranslated,
            translating: false,
            placeholders: vec![],
            notes: vec![],
        };
        let dest = std::env::temp_dir().join("sh_dest.zip");
        export_shader_zh(&src, &dest, &[e]).unwrap();

        let f = File::open(&dest).unwrap();
        let mut archive = ZipArchive::new(f).unwrap();
        let mut lang = String::new();
        archive
            .by_name("shaders/lang/zh_CN.lang")
            .unwrap()
            .read_to_string(&mut lang)
            .unwrap();
        assert!(lang.contains("screen.title=标题"));
        let mut frag = String::new();
        archive
            .by_name("shaders/shaders/basic.frag")
            .unwrap()
            .read_to_string(&mut frag)
            .unwrap();
        assert!(frag.contains("void main"));
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }

    #[test]
    fn exports_resource_pack_description() {
        let src = std::env::temp_dir().join("rp_src.zip");
        {
            let f = File::create(&src).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("pack.mcmeta", opts).unwrap();
            w.write_all(br#"{"pack":{"pack_format":15,"description":"Old desc"}}"#).unwrap();
            w.finish().unwrap();
        }
        let e = LangEntry {
            key: "pack.description.line1".into(),
            source: "Old desc".into(),
            file_path: "pack.mcmeta".into(),
            modid: "resourcepack".into(),
            translation: Some("新描述".into()),
            hardcoded: false,
            status: EntryStatus::AiTranslated,
            translating: false,
            placeholders: vec![],
            notes: vec![],
        };
        let dest = std::env::temp_dir().join("rp_dest.zip");
        export_resource_pack_desc(&src, &dest, &[e]).unwrap();

        let f = File::open(&dest).unwrap();
        let mut archive = ZipArchive::new(f).unwrap();
        let mut mcmeta = String::new();
        archive.by_name("pack.mcmeta").unwrap().read_to_string(&mut mcmeta).unwrap();
        assert!(mcmeta.contains("新描述"));
        assert!(!mcmeta.contains("Old desc"));
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dest);
    }
}

