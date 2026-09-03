use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Read, Seek};
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::lang;
use super::model::{EntryStatus, LangEntry};
use super::placeholder;

/// 分组摘要（供前端分组勾选视图）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepGroup {
    pub key: String,
    pub label: String,
    pub count: usize,
    /// 默认不勾选（保守：用户主动勾选才参与翻译/导出）
    pub default_checked: bool,
}

/// 深度扫描结果：条目（与普通硬编码同构，回写机制复用）+ 分组摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepScanResult {
    pub entries: Vec<LangEntry>,
    pub groups: Vec<DeepGroup>,
}

struct ScanItem {
    source: String,
    file: String,
    json_path: String,
    score: i32,
}

fn group_label(g: &str) -> &'static str {
    match g {
        "achievement" => "成就",
        "config" => "配置文件",
        "data" => "数据文件",
        "nested" => "嵌套模组",
        _ => "其他文本",
    }
}

fn group_of(file: &str) -> &'static str {
    if file.starts_with("META-INF/jars/") {
        "nested"
    } else if file.contains("/advancement") || file.starts_with("advancement") {
        "achievement"
    } else if file.starts_with("config/") {
        "config"
    } else if file.starts_with("data/") {
        "data"
    } else {
        "other"
    }
}

fn is_binary(name: &str) -> bool {
    let l = name.to_lowercase();
    [
        ".class", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".ogg",
        ".mp3", ".wav", ".bin", ".dat", ".nbt", ".zip", ".jar", ".gz",
    ]
    .iter()
    .any(|s| l.ends_with(s))
}

/// 判定一条文本是否可翻译，返回分数（< 阈值不采用）
fn score_text(text: &str, json_path: &str) -> Option<i32> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let len = t.chars().count();
    if !(3..=200).contains(&len) {
        return None;
    }
    let lower = t.to_lowercase();
    // 黑名单
    if lower.starts_with("minecraft:")
        || lower.starts_with("http")
        || lower.starts_with('#')
        || lower.starts_with('/')
        || lower.starts_with('$')
    {
        return None;
    }
    if t.contains('/') && !t.contains(' ') {
        return None; // 路径样式
    }
    if !t.chars().any(|c| c.is_alphabetic()) {
        return None;
    }
    // 纯 kebab/snake id（小写 + 数字 + 分隔符）
    if len < 40
        && t.chars()
            .all(|c| c.is_lowercase() || c.is_numeric() || c == '-' || c == '_' || c == '.')
    {
        return None;
    }
    // 纯符号/数字
    if t.chars().all(|c| c.is_numeric() || " .,-/:;()!?".contains(c)) {
        return None;
    }

    let mut score = 0;
    let jp = json_path.to_lowercase();
    if jp.contains("display") && (jp.ends_with(".title") || jp.ends_with(".description")) {
        score += 3;
    } else if jp.ends_with(".title") || jp.ends_with(".subtitle") {
        score += 2;
    }
    if t.contains(' ') {
        score += 2;
    }
    if t.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
        score += 1;
    }
    if t.contains('%') || t.contains('§') {
        score += 1;
    }
    if score >= 2 {
        Some(score)
    } else {
        None
    }
}

fn consider(text: &str, json_path: &str, file: &str, out: &mut Vec<ScanItem>) {
    if let Some(score) = score_text(text, json_path) {
        out.push(ScanItem {
            source: text.trim().to_string(),
            file: file.to_string(),
            json_path: json_path.to_string(),
            score,
        });
    }
}

fn walk_json(v: &serde_json::Value, path: &str, name: &str, out: &mut Vec<ScanItem>) {
    match v {
        serde_json::Value::String(s) => consider(s, path, name, out),
        serde_json::Value::Object(map) => {
            for (k, vv) in map {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", path, k)
                };
                walk_json(vv, &p, name, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for (i, vv) in arr.iter().enumerate() {
                walk_json(vv, &format!("{}[{}]", path, i), name, out);
            }
        }
        _ => {}
    }
}

fn scan_file(name: &str, buf: &[u8], out: &mut Vec<ScanItem>) {
    if name.ends_with(".json")
        || name.ends_with(".mcmeta")
        || name.ends_with(".bbmodel")
    {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(buf) {
            walk_json(&v, "", name, out);
        }
    } else if name.ends_with(".lang") {
        if let Ok(pairs) = lang::parse_lang(buf) {
            for (k, v) in pairs {
                consider(&v, &format!("line:{}", k), name, out);
            }
        }
    } else if name.ends_with(".properties") {
        let text = String::from_utf8_lossy(buf);
        if let Ok(pairs) = lang::parse_properties_utf8(&text) {
            for (k, v) in pairs {
                consider(&v, &format!("line:{}", k), name, out);
            }
        }
    } else if [".toml", ".cfg", ".conf", ".ini", ".yaml", ".yml", ".txt", ".md"]
        .iter()
        .any(|s| name.ends_with(s))
    {
        let text = String::from_utf8_lossy(buf);
        for (i, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") || line.starts_with(';') {
                continue;
            }
            let value = if line.contains('=') {
                line.splitn(2, '=').nth(1).map(|s| s.trim().to_string())
            } else if line.contains(':') {
                line.splitn(2, ':').nth(1).map(|s| s.trim().to_string())
            } else {
                Some(line.to_string())
            };
            if let Some(v) = value {
                consider(&v, &format!("line:{}", i + 1), name, out);
            }
        }
    }
}

/// 递归扫描一个 zip（主 jar 或嵌套 jar）
fn scan_zip<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    prefix: &str,
    out: &mut Vec<ScanItem>,
    depth: usize,
) {
    if depth > 3 {
        return; // 防止恶意深嵌套
    }
    let mut nested: Vec<(String, Vec<u8>)> = Vec::new();
    // 顶层 zip：兼容"整个内容被套一层文件夹"的包装结构
    let root_prefix: Option<String> = if prefix.is_empty() {
        let names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
            .collect();
        super::pack::common_root_prefix(&names)
    } else {
        None
    };
    for i in 0..archive.len() {
        let mut f = match archive.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let raw_name = f.name().to_string();
        let stripped = raw_name
            .strip_prefix(root_prefix.as_deref().unwrap_or(""))
            .unwrap_or(&raw_name);
        let name = if prefix.is_empty() {
            stripped.to_string()
        } else {
            format!("{}/{}", prefix, raw_name)
        };
        let upper = name.to_uppercase();
        // 嵌套 jar：先于二进制判断处理（.jar 属于二进制扩展名）
        if name.starts_with("META-INF/jars/") && name.ends_with(".jar") {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                nested.push((name.clone(), buf));
            }
            continue;
        }
        // 跳过二进制 / 语言文件 / 许可协议 / 更新日志（语言文件已走常规流程）
        if is_binary(&name) {
            continue;
        }
        if upper.contains("LICENSE") || upper.contains("CHANGELOG") {
            continue;
        }
        if name.starts_with("META-INF/") && !name.starts_with("META-INF/jars/") {
            continue;
        }
        if name.contains("/lang/") && (name.ends_with(".json") || name.ends_with(".lang")) {
            continue;
        }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            continue;
        }
        scan_file(&name, &buf, out);
    }
    for (nname, buf) in nested {
        if let Ok(mut nested_arc) = ZipArchive::new(Cursor::new(buf)) {
            scan_zip(&mut nested_arc, &nname, out, depth + 1);
        }
    }
}

/// 深度扫描 jar：全文本文件启发式提取可翻译文本（含嵌套 jar 递归）
pub fn deep_scan_jar(path: &Path, default_modid: &str) -> Result<DeepScanResult, String> {
    let file = File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut collected: Vec<ScanItem> = Vec::new();
    scan_zip(&mut archive, "", &mut collected, 0);

    // 按 source 去重合并（保留第一个位置，count = 出现次数）
    let mut map: HashMap<String, Vec<ScanItem>> = HashMap::new();
    for it in collected {
        map.entry(it.source.clone()).or_default().push(it);
    }

    let mut entries: Vec<LangEntry> = Vec::new();
    let mut group_counts: HashMap<&'static str, usize> = HashMap::new();
    for (source, items) in map {
        let first = &items[0];
        let group = group_of(&first.file);
        *group_counts.entry(group).or_insert(0) += 1;
        let mut notes = vec![format!("模组深度扫描·{}", group_label(group))];
        if items.len() > 1 {
            notes.push(format!("重复出现 ×{}", items.len()));
        }
        let placeholders = placeholder::extract_placeholders(&source);
        entries.push(LangEntry {
            key: format!("{}#{}", first.file, first.json_path),
            source,
            file_path: first.file.clone(),
            modid: default_modid.to_string(),
            translation: None,
            hardcoded: true,
            status: EntryStatus::Untranslated,
            translating: false,
            placeholders,
            notes,
        });
    }
    // 稳定排序：分组顺序固定，组内按文件路径
    let order = |g: &str| match g {
        "achievement" => 0,
        "config" => 1,
        "data" => 2,
        "nested" => 3,
        _ => 4,
    };
    entries.sort_by(|a, b| {
        let ga = order(group_of(&a.file_path));
        let gb = order(group_of(&b.file_path));
        ga.cmp(&gb).then_with(|| a.file_path.cmp(&b.file_path))
    });

    let groups = group_counts
        .into_iter()
        .map(|(key, count)| DeepGroup {
            key: key.to_string(),
            label: group_label(key).to_string(),
            count,
            default_checked: false,
        })
        .collect();

    Ok(DeepScanResult { entries, groups })
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn build_jar(buf: &mut Vec<u8>, files: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(content).unwrap();
        }
        w.finish().unwrap();
    }

    fn tmp(buf: &[u8], name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(name);
        std::fs::write(&p, buf).unwrap();
        p
    }

    #[test]
    fn scans_advancement_and_config_and_txt() {
        let mut buf: Vec<u8> = Vec::new();
        build_jar(
            &mut buf,
            &[
                ("data/testmod/advancement/mobs/boss.json",
                 br#"{"display":{"title":"Final Boss","description":"Defeat the ancient one"}}"#),
                ("config/options.json", br#"{"welcome":"Welcome to the server"}"#),
                ("readme.txt", b"How to install this mod
step one
"),
                ("assets/testmod/lang/en_us.json", br#"{"item.test.name":"Test Item"}"#),
                ("LICENSE", b"MIT License text here"),
                ("data/testmod/recipe/x.json", br#"{"result":"minecraft:stone"}"#),
            ],
        );
        let p = tmp(&buf, "deep_test.jar");
        let res = deep_scan_jar(&p, "testmod").unwrap();
        let _ = std::fs::remove_file(&p);

        // 成就 title/description + config + txt 都被扫到
        let sources: Vec<&str> = res.entries.iter().map(|e| e.source.as_str()).collect();
        assert!(sources.contains(&"Final Boss"));
        assert!(sources.contains(&"Defeat the ancient one"));
        assert!(sources.contains(&"Welcome to the server"));
        assert!(sources.contains(&"How to install this mod"));
        // lang 文件不重复扫描；LICENSE 排除；纯 id 不收
        assert!(!sources.contains(&"Test Item"));
        assert!(!sources.iter().any(|s| s.contains("MIT License")));
        assert!(!sources.iter().any(|s| s.contains("minecraft:stone")));
        // 分组正确
        let adv = res.groups.iter().find(|g| g.key == "achievement").unwrap();
        assert_eq!(adv.count, 2);
        let cfg = res.groups.iter().find(|g| g.key == "config").unwrap();
        assert!(cfg.count >= 1);
        assert!(!adv.default_checked, "分组默认不勾选");
    }

    #[test]
    fn scans_nested_jar() {
        // 构造嵌套 jar 字节
        let mut inner: Vec<u8> = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut inner));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("config/inner.json", opts).unwrap();
            w.write_all(br#"{"tip":"Nested text inside wrapper"}"#).unwrap();
            w.finish().unwrap();
        }
        let mut outer: Vec<u8> = Vec::new();
        build_jar(&mut outer, &[("META-INF/jars/inner.jar", &inner)]);
        let p = tmp(&outer, "nested_test.jar");
        let res = deep_scan_jar(&p, "wrapper").unwrap();
        let _ = std::fs::remove_file(&p);
        assert!(
            res.entries.iter().any(|e| e.source.contains("Nested text")),
            "嵌套 jar 内文本应被扫到"
        );
        assert!(res.groups.iter().any(|g| g.key == "nested"));
    }

    #[test]
    fn scans_ini_mcmeta_bbmodel() {
        let mut buf: Vec<u8> = Vec::new();
        build_jar(
            &mut buf,
            &[
                // .ini：键=值，含 [section] 头部与注释，应只取 value
                (
                    "config/mod.ini",
                    b"[General]\n# comment\nDisplayName=Hello World\n",
                ),
                // .mcmeta：JSON 结构（如 pack.mcmeta 的描述）
                (
                    "pack.mcmeta",
                    br#"{"pack":{"description":"Ancient Relics Pack"}}"#,
                ),
                // .bbmodel：BlockBench 模型 JSON
                (
                    "models/block.bbmodel",
                    br#"{"name":"Magic Cube","elements":[{"name":"base"}]}"#,
                ),
            ],
        );
        let p = tmp(&buf, "fmts_test.jar");
        let res = deep_scan_jar(&p, "testmod").unwrap();
        let _ = std::fs::remove_file(&p);

        let sources: Vec<&str> = res.entries.iter().map(|e| e.source.as_str()).collect();
        assert!(
            sources.contains(&"Hello World"),
            ".ini 的 value 应被扫到"
        );
        assert!(
            sources.contains(&"Ancient Relics Pack"),
            ".mcmeta 的 JSON 文本应被扫到"
        );
        assert!(
            sources.contains(&"Magic Cube"),
            ".bbmodel 的 JSON 文本应被扫到"
        );
    }
}
