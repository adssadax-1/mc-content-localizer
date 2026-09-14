//! 服务器插件（Bukkit / Spigot / Paper / BungeeCord / Velocity 等）jar 解析。
//!
//! 普通扫描目标：
//! - 清单 `plugin.yml` / `paper-plugin.yml` / `bungee.yml`：**键级白名单**，仅提取
//!   `description`、`commands.*.description/usage`、`permissions.*.description`；
//!   `main`、`api-version`、`depend`、`libraries` 等纯内部定义一律过滤。
//! - `config.yml` 与 `lang/`、`locale(s)/`、`messages/`、`languages/` 等目录下的
//!   yml / yaml / properties / json 语言与消息配置。
//!
//! 过滤三层：内部键黑名单（软件内部定义）→ 值启发式（与深度扫描 score_text 同思路，
//! 含 CJK / 颜色码 / 占位符 / 含空格短语保留，纯数字布尔路径丢弃）。
//! 自带中文：包内 `*zh*.yml/properties/json` 按键回填，或消息值本身含 CJK。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use yaml_rust2::{Yaml, YamlLoader};

use super::model::{EntryStatus, LangEntry};
use super::pack::PackError;
use super::placeholder::extract_placeholders;

/// 一个服务器插件 jar 的解析结果
pub struct PluginPackInfo {
    pub file_name: String,
    pub plugin_name: String,
    pub version: Option<String>,
    pub has_zh: bool,
    pub zh_count: usize,
    pub entries: Vec<LangEntry>,
}

/// 内部键黑名单：段名精确命中即过滤（插件配置里纯机器用途的键）
const INTERNAL_SEGMENTS: &[&str] = &[
    "mysql", "mariadb", "sqlite", "database", "db", "storage", "host", "hostname", "port",
    "username", "user", "password", "passwd", "pass", "token", "secret", "license", "apikey",
    "api-key", "api_key", "debug", "updater", "update-checker", "updatechecker", "metrics",
    "bstats", "enabled", "disabled", "enable", "cooldown", "cooldowns", "hooks", "jdbc",
    "driver", "table", "retry", "timeout", "thread", "threads",
];

/// 顶层段黑名单：配置的第一段命中即整段过滤
const INTERNAL_TOP: &[&str] = &["mysql", "mariadb", "sqlite", "database", "storage", "connection"];

/// 可见键提示：键路径命中即放宽值判定（如 `messages.ready: Ready` 这种单词消息）
const VISIBLE_KEY_PARTS: &[&str] = &[
    "message", "msg", "lang", "locale", "prefix", "title", "subtitle", "broadcast", "motd",
    "usage", "description", "lore", "notice", "notify", "alert", "tip", "help", "text",
    "welcome", "kick", "ban", "deny", "reason",
];

/// 键路径是否命中可见键提示
fn key_hint_hit(key_path: &str) -> bool {
    let lower = key_path.to_lowercase();
    VISIBLE_KEY_PARTS.iter().any(|k| lower.contains(k))
}

/// 命中可见键提示时的放宽判定：非空、非布尔/数字、含字母、长度合理
fn hinted_value_ok(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > 300 {
        return false;
    }
    let lower = t.to_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "none" | "default") {
        return false;
    }
    if t.parse::<f64>().is_ok() {
        return false;
    }
    t.chars().any(|c| c.is_alphabetic())
}

/// 判断路径的任一段是否命中内部键黑名单
fn internal_hit(key_path: &str) -> bool {
    let segs: Vec<String> = key_path.split('.').map(|s| s.to_lowercase()).collect();
    if let Some(first) = segs.first() {
        if INTERNAL_TOP.contains(&first.as_str()) {
            return true;
        }
    }
    segs.iter().any(|s| INTERNAL_SEGMENTS.contains(&s.as_str()))
}

/// 值启发式：与深度扫描 score_text 同思路，但为插件配置放宽/收紧不同规则
fn value_ok(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    let n = t.chars().count();
    if n > 500 {
        return false;
    }
    // 含 CJK：一定保留（自带中文的配置）
    if t.chars().any(is_cjk) {
        return true;
    }
    let lower = t.to_lowercase();
    // 布尔 / 常量字面量
    if matches!(lower.as_str(), "true" | "false" | "none" | "default" | "yes" | "no") {
        return false;
    }
    if t.parse::<f64>().is_ok() || t.parse::<i64>().is_ok() {
        return false;
    }
    // 链接 / 路径样式
    if lower.starts_with("http") || lower.starts_with("www.") {
        return false;
    }
    if (t.starts_with('/') || t.starts_with("./") || t.starts_with("../")) && !t.contains(' ') {
        return false;
    }
    // 纯 id（小写字母数字与 -_.:，短）
    if n < 40
        && t.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | ':'))
    {
        return false;
    }
    let has_alpha = t.chars().any(|c| c.is_alphabetic());
    let has_marker = !extract_placeholders(t).is_empty();
    let has_space = t.contains(' ');
    (has_marker && has_alpha) || (has_space && has_alpha) || looks_like_word(t)
}

/// 单词/短语样式的可见文本（Welcome / Goodbye! / Ready）：
/// 首字母大写，其余仅字母与常见标点，不含数字与路径分隔符
fn looks_like_word(t: &str) -> bool {
    match t.chars().next() {
        Some(c) if c.is_uppercase() => {}
        _ => return false,
    }
    t.chars().all(|c| {
        c.is_alphabetic() || matches!(c, '!' | '?' | '.' | ',' | ':' | ';' | '\'' | '-' | '…')
    })
}

fn is_cjk(c: char) -> bool {
    let v = c as u32;
    (0x4E00..=0x9FFF).contains(&v)
        || (0x3400..=0x4DBF).contains(&v)
        || (0x3000..=0x303F).contains(&v)
        || (0xFF00..=0xFFEF).contains(&(v))
}

/// yaml-rust2 的标量统一转字符串
fn yaml_to_string(v: &Yaml) -> Option<String> {
    match v {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Real(r) => Some(r.clone()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

/// YAML 展平为（键路径, 值）列表；数组下标作为路径段
fn flatten_yaml(value: &Yaml, prefix: &str, out: &mut Vec<(String, String)>) {
    match value {
        Yaml::Hash(h) => {
            for (k, v) in h {
                let Yaml::String(kstr) = k else { continue };
                let path = if prefix.is_empty() {
                    kstr.clone()
                } else {
                    format!("{prefix}.{kstr}")
                };
                flatten_yaml(v, &path, out);
            }
        }
        Yaml::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                let path = if prefix.is_empty() {
                    i.to_string()
                } else {
                    format!("{prefix}.{i}")
                };
                flatten_yaml(v, &path, out);
            }
        }
        Yaml::String(s) => out.push((prefix.to_string(), s.clone())),
        Yaml::Real(r) => out.push((prefix.to_string(), r.clone())),
        Yaml::Integer(i) => out.push((prefix.to_string(), i.to_string())),
        Yaml::Boolean(b) => out.push((prefix.to_string(), b.to_string())),
        _ => {}
    }
}

/// 解析 YAML 文本；解析失败时退化为行级切分（保证仍能取到条目）
fn parse_yaml_pairs(text: &str, file_path: &str) -> Vec<(String, String)> {
    match YamlLoader::load_from_str(text) {
        Ok(docs) => {
            if let Some(first) = docs.first() {
                let mut out = Vec::new();
                flatten_yaml(first, "", &mut out);
                if !out.is_empty() {
                    return out;
                }
            }
        }
        Err(_) => {}
    }
    // 退化路径：行级切分（跳过注释；只取含冒号的行）
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let t = line.trim_start();
        if t.is_empty() || t.starts_with('#') || t.starts_with("- ") {
            continue;
        }
        if let Some(pos) = t.find(':') {
            let key = format!("line{}", i + 1);
            let val = t[pos + 1..].trim();
            if !val.is_empty() {
                out.push((key, val.to_string()));
            }
        }
    }
    let _ = file_path;
    out
}

/// 解析 properties 文本（Java ResourceBundle 风格：\uXXXX 转义、# ! 注释）
fn parse_properties_pairs(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim_start();
        if t.is_empty() || t.starts_with('#') || t.starts_with('!') {
            continue;
        }
        let pos = match t.find(|c| c == '=' || c == ':') {
            Some(p) => p,
            None => continue,
        };
        let key = t[..pos].trim().trim_end_matches('\\').to_string();
        if key.is_empty() {
            continue;
        }
        out.push((key, unescape_properties(t[pos + 1..].trim())));
    }
    out
}

fn unescape_properties(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if let Ok(cp) = u32::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(cp) {
                            out.push(ch);
                        }
                    }
                }
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// JSON 展平为（键路径, 值）列表
fn flatten_json(value: &serde_json::Value, prefix: &str, out: &mut Vec<(String, String)>) {
    match value {
        serde_json::Value::Object(m) => {
            for (k, v) in m {
                let path = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten_json(v, &path, out);
            }
        }
        serde_json::Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                let path = format!("{prefix}.{i}");
                flatten_json(v, &path, out);
            }
        }
        serde_json::Value::String(s) => out.push((prefix.to_string(), s.clone())),
        _ => {}
    }
}

/// 文件是否为插件扫描候选：消息/语言相关目录或命名，且扩展名匹配
fn candidate_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    let ext_ok = [".yml", ".yaml", ".properties", ".json"]
        .iter()
        .any(|e| lower.ends_with(e));
    if !ext_ok {
        return false;
    }
    if lower.starts_with("meta-inf/") {
        return false;
    }
    let in_dir = [
        "lang/", "locale/", "locales/", "messages/", "languages/", "translations/", "translation/",
    ]
    .iter()
    .any(|d| lower.starts_with(d));
    let name_hit = ["message", "lang", "locale", "translation"]
        .iter()
        .any(|k| lower.contains(k))
        || lower == "config.yml";
    let code_pkg = ["org/", "com/", "net/", "io/", "de/", "fr/", "uk/", "be/", "me/", "es/", "it/", "pl/"]
        .iter()
        .any(|d| lower.starts_with(d));
    if code_pkg && !(in_dir || name_hit) {
        return false;
    }
    in_dir || name_hit
}

/// 文件是否为自带中文语言文件（按文件名）
fn is_zh_file(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name).to_lowercase();
    let stem = base.split('.').next().unwrap_or("");
    stem.starts_with("zh") || stem.contains("_zh") || stem.contains("-zh")
}

/// 清单可见键：plugin.yml / paper-plugin.yml / bungee.yml 的键级白名单
fn manifest_entries(y: &Yaml, out: &mut Vec<(String, String)>) {
    let Some(h) = y.as_hash() else { return };
    if let Some(d) = h.get(&Yaml::from_str("description")).and_then(yaml_to_string) {
        out.push(("description".to_string(), d));
    }
    if let Some(u) = h.get(&Yaml::from_str("usage")).and_then(yaml_to_string) {
        out.push(("usage".to_string(), u));
    }
    // commands.<cmd>.description / usage
    if let Some(cmds) = h.get(&Yaml::from_str("commands")).and_then(|v| v.as_hash()) {
        for (k, v) in cmds {
            let Yaml::String(cmd) = k else { continue };
            let Some(vh) = v.as_hash() else { continue };
            for field in ["description", "usage"] {
                if let Some(d) = vh.get(&Yaml::from_str(field)).and_then(yaml_to_string) {
                    out.push((format!("commands.{cmd}.{field}"), d));
                }
            }
        }
    }
    // permissions.<path>.description（递归；description 可能是字符串或 {text: ...}）
    if let Some(perms) = h.get(&Yaml::from_str("permissions")) {
        walk_permissions(perms, "", out);
    }
}

fn walk_permissions(y: &Yaml, prefix: &str, out: &mut Vec<(String, String)>) {
    let Some(h) = y.as_hash() else { return };
    for (k, v) in h {
        let Yaml::String(kstr) = k else { continue };
        match v {
            Yaml::String(d) => {
                if kstr == "description" {
                    let path = if prefix.is_empty() {
                        kstr.clone()
                    } else {
                        format!("{prefix}.description")
                    };
                    out.push((path, d.clone()));
                }
            }
            Yaml::Hash(_) => {
                if kstr == "description" {
                    if let Some(text) = v
                        .as_hash()
                        .and_then(|h| h.get(&Yaml::from_str("text")))
                        .and_then(yaml_to_string)
                    {
                        let path = if prefix.is_empty() {
                            "description".to_string()
                        } else {
                            format!("{prefix}.description")
                        };
                        out.push((path, text));
                    }
                } else {
                    let path = if prefix.is_empty() {
                        kstr.clone()
                    } else {
                        format!("{prefix}.{kstr}")
                    };
                    walk_permissions(v, &path, out);
                }
            }
            _ => {}
        }
    }
}

/// 解析服务器插件 jar
pub fn parse_plugin_jar(path: &Path) -> Result<PluginPackInfo, PackError> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // 1. 清单：plugin.yml → paper-plugin.yml → bungee.yml
    let mut manifest: Option<Yaml> = None;
    for name in ["plugin.yml", "paper-plugin.yml", "bungee.yml"] {
        if let Ok(mut f) = archive.by_name(name) {
            let mut buf = Vec::new();
            if std::io::Read::read_to_end(&mut f, &mut buf).is_ok() {
                let text = String::from_utf8_lossy(&buf);
                if let Ok(docs) = YamlLoader::load_from_str(&text) {
                    if let Some(first) = docs.first() {
                        manifest = Some(first.clone());
                        break;
                    }
                }
            }
        }
    }
    let (plugin_name, version) = match &manifest {
        Some(y) => {
            let name = y
                .as_hash()
                .and_then(|h| h.get(&Yaml::from_str("name")))
                .and_then(yaml_to_string);
            let ver = y
                .as_hash()
                .and_then(|h| h.get(&Yaml::from_str("version")))
                .and_then(yaml_to_string);
            (name, ver)
        }
        None => (None, None),
    };
    let plugin_name = plugin_name.unwrap_or_else(|| {
        file_name
            .trim_end_matches(".jar")
            .trim_end_matches(".zip")
            .to_string()
    });
    let modid = {
        let mut s: String = plugin_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        if s.chars().next().map_or(true, |c| c.is_ascii_digit()) {
            s.insert(0, '_');
        }
        s.to_lowercase()
    };

    // 2. 收集候选文件（语言 / 消息配置）
    let mut candidates: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut f = match archive.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if !f.is_file() {
            continue;
        }
        let name = f.name().to_string();
        if !candidate_file(&name) || name == "plugin.yml" || name == "paper-plugin.yml" {
            continue;
        }
        let mut buf = Vec::new();
        if std::io::Read::read_to_end(&mut f, &mut buf).is_ok() {
            candidates.push((name, buf));
        }
    }

    // 3. 自带中文映射（文件名带 zh 的候选，键路径 → 值）
    let mut zh_map: HashMap<String, String> = HashMap::new();
    let mut zh_by_leaf: HashMap<String, String> = HashMap::new();
    for (name, buf) in &candidates {
        if !is_zh_file(name) {
            continue;
        }
        let text = String::from_utf8_lossy(buf);
        let pairs = if name.to_lowercase().ends_with(".json") {
            let mut out = Vec::new();
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(buf) {
                flatten_json(&v, "", &mut out);
            }
            out
        } else if name.to_lowercase().ends_with(".properties") {
            parse_properties_pairs(&text)
        } else {
            parse_yaml_pairs(&text, name)
        };
        for (k, v) in pairs {
            // 叶子键索引：插件常见「config.yml 的 messages.welcome」与
            // 「lang/zh_CN.yml 的 welcome」层级不同，用叶子名兜底匹配
            let leaf = k.rsplit('.').next().unwrap_or(&k).to_string();
            if leaf.chars().count() >= 3 && !leaf.chars().all(|c| c.is_ascii_digit()) {
                zh_by_leaf.entry(leaf).or_insert(v.clone());
            }
            zh_map.entry(k).or_insert(v);
        }
    }

    // 4. 条目构建
    let mut entries: Vec<LangEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut has_cjk_source = false;
    let mut push_entry = |file_path: &str, key_path: &str, source: &str| {
        let keep = !internal_hit(key_path)
            && (value_ok(source) || (key_hint_hit(key_path) && hinted_value_ok(source)));
        if !keep {
            return;
        }
        if source.chars().any(is_cjk) {
            has_cjk_source = true;
        }
        let full = format!("{file_path}#{key_path}");
        if !seen.insert(full.clone()) {
            return;
        }
        let existing = zh_map.get(key_path).cloned().or_else(|| {
            let leaf = key_path.rsplit('.').next().unwrap_or(key_path);
            if leaf.chars().count() >= 3 {
                zh_by_leaf.get(leaf).cloned()
            } else {
                None
            }
        });
        let is_zh = existing.is_some();
        entries.push(LangEntry {
            key: full,
            source: source.to_string(),
            file_path: file_path.to_string(),
            modid: modid.clone(),
            translation: existing,
            hardcoded: false,
            status: if is_zh {
                EntryStatus::ExistingZh
            } else {
                EntryStatus::Untranslated
            },
            translating: false,
            placeholders: extract_placeholders(source),
            notes: Vec::new(),
            deep_group: None,
        });
    };

    // 4.1 清单白名单键
    if let Some(y) = &manifest {
        let mut pairs = Vec::new();
        manifest_entries(y, &mut pairs);
        for (k, v) in pairs {
            push_entry("plugin.yml", &k, &v);
        }
    }

    // 4.2 候选配置 / 语言文件
    for (name, buf) in &candidates {
        let pairs: Vec<(String, String)> = if name.to_lowercase().ends_with(".json") {
            let mut out = Vec::new();
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(buf) {
                flatten_json(&v, "", &mut out);
            }
            out
        } else if name.to_lowercase().ends_with(".properties") {
            parse_properties_pairs(&String::from_utf8_lossy(buf))
        } else {
            parse_yaml_pairs(&String::from_utf8_lossy(buf), name)
        };
        for (k, v) in pairs {
            push_entry(name, &k, &v);
        }
    }

    let zh_count = entries.iter().filter(|e| e.translation.is_some()).count();
    Ok(PluginPackInfo {
        file_name,
        plugin_name,
        version,
        has_zh: zh_count > 0 || has_cjk_source,
        zh_count,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_jar(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts =
                zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, content) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(content.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    use std::io::Cursor;

    #[test]
    fn parses_plugin_config_and_filters_internal() {
        let buf = make_jar(&[
            (
                "plugin.yml",
                "name: TestPlugin\nversion: 1.2.3\nmain: com.example.Test\ncommands:\n  spawn:\n    description: Teleport to spawn\n    usage: /spawn",
            ),
            (
                "config.yml",
                "messages:\n  welcome: \"&aWelcome %player%!\"\n  bye: Goodbye!\nmysql:\n  host: localhost\n  password: secret\ndebug: true",
            ),
            ("lang/zh_CN.yml", "welcome: \"&a欢迎 %player%!\"\nbye: 再见"),
        ]);
        std::fs::write("test_plugin.jar", &buf).unwrap();
        let info = parse_plugin_jar(Path::new("test_plugin.jar")).unwrap();
        std::fs::remove_file("test_plugin.jar").ok();

        assert_eq!(info.plugin_name, "TestPlugin");
        assert_eq!(info.version.as_deref(), Some("1.2.3"));
        // mysql.host / debug 被过滤；messages 段与命令描述被提取
        assert!(info.entries.iter().all(|e| !e.key.contains("mysql")));
        assert!(info.entries.iter().all(|e| !e.key.contains("debug")));
        assert!(info
            .entries
            .iter()
            .any(|e| e.key == "plugin.yml#commands.spawn.description"));
        assert!(info.entries.iter().any(|e| e.key == "config.yml#messages.welcome"));
        // 自带中文按键回填
        let welcome = info
            .entries
            .iter()
            .find(|e| e.key == "config.yml#messages.welcome")
            .unwrap();
        assert_eq!(welcome.translation.as_deref(), Some("&a欢迎 %player%!"));
        assert_eq!(welcome.status, EntryStatus::ExistingZh);
        assert!(info.has_zh);
        // 占位符已提取
        assert!(welcome.placeholders.iter().any(|t| t == "%player%"));
    }

    #[test]
    fn internal_keys_are_filtered() {
        assert!(internal_hit("mysql.host"));
        assert!(internal_hit("debug"));
        assert!(!internal_hit("messages.welcome"));
        assert!(value_ok("&aWelcome %player%!"));
        assert!(value_ok("Goodbye!"));
        assert!(!value_ok("true"));
        assert!(!value_ok("localhost:3306"));
        // 单字消息按"词样式"保留（Welcome / Ready / Goodbye!）
        assert!(value_ok("Ready"));
        assert!(value_ok("Goodbye!"));
        assert!(!value_ok("localhost"));
        // 键提示作为补充放宽通道
        assert!(key_hint_hit("messages.ready"));
        assert!(hinted_value_ok("Ready"));
        // 泛化键不因提示误收纯 id
        assert!(!key_hint_hit("storage.engine"));
    }
}
