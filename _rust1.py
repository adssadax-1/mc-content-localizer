# -*- coding: utf-8 -*-
import re

# ── 1) pack.rs：光影语言文件全量大小写无关解析 ────────────────────────────────
p = "src-tauri/src/core/pack.rs"
s = open(p, encoding="utf-8").read()

old = '''    let mut shader_props: Option<Vec<(String, String)>> = None;
    let mut lang_source: Option<(String, Vec<(String, String)>)> = None;
    let mut zh_map: HashMap<String, String> = HashMap::new();

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let entry_name = f.name().to_string();
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
            let is_zh = entry_name.contains("zh_CN") || entry_name.contains("zh_HK") || entry_name.contains("zh_TW");
            if is_zh {
                for (k, v) in pairs {
                    zh_map.insert(k, v);
                }
            } else if lang_source.is_none() {
                lang_source = Some((entry_name.clone(), pairs));
            }
        }
    }'''
new = '''    let mut shader_props: Option<Vec<(String, String)>> = None;
    // 全部语言文件（小写语言名 → 键值对）：大小写无关，zh_cn / zh_CN / ZH_cn 都认
    let mut lang_map: HashMap<String, Vec<(String, String)>> = HashMap::new();

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let entry_name = f.name().to_string();
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
            lang_map.insert(lower_locale, pairs);
        }
    }

    // 自带中文：任何 zh* 变体（大小写无关）；简体优先，繁体仅补缺
    let mut zh_map: HashMap<String, String> = HashMap::new();
    for locale in ["zh_cn", "zh_hk"] {
        if let Some(pairs) = lang_map.get(locale) {
            for (k, v) in pairs {
                zh_map.insert(k.clone(), v.clone());
            }
        }
    }
    for (loc, pairs) in &lang_map {
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
            .map(|(loc, pairs)| (loc.clone(), pairs.clone()))
    };
    let lang_source = pick(&|l: &str| l == "en_us")
        .or_else(|| pick(&|l: &str| l == "en_gb"))
        .or_else(|| pick(&|l: &str| l.starts_with("en")))
        .or_else(|| pick(&|_: &str| true));'''
assert old in s, "pack lang block"
s = s.replace(old, new)

# fallback uses entry_name — synthesize standard path
old = '''        _ => match lang_source {
            Some((p, entries)) => (entries, p),'''
new = '''        _ => match lang_source {
            Some((p, entries)) => (entries, format!("shaders/lang/{}.lang", p)),'''
assert old in s, "fallback"
s = s.replace(old, new)

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("pack.rs done")

# ── 2) jar.rs：quilt.mod.json + BOM 清洗 ─────────────────────────────────────
p = "src-tauri/src/core/jar.rs"
s = open(p, encoding="utf-8").read()

old = '''fn read_mod_metadata(archive: &mut ZipArchive<File>) -> Result<ModMeta, JarError> {'''
new = '''/// 去除 UTF-8 BOM：部分老 mcmod.info / fabric.mod.json 带 BOM，会导致 JSON 解析失败
fn strip_bom(buf: &[u8]) -> &[u8] {
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &buf[3..]
    } else {
        buf
    }
}

fn read_mod_metadata(archive: &mut ZipArchive<File>) -> Result<ModMeta, JarError> {'''
assert old in s, "strip_bom"
s = s.replace(old, new)

old = '''            "fabric.mod.json" => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {'''
new = '''            "quilt.mod.json" => {
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
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(strip_bom(&buf)) {'''
assert old in s, "quilt arm"
s = s.replace(old, new)

old = '''            "mcmod.info" => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf) {'''
new = '''            "mcmod.info" => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(strip_bom(&buf)) {'''
assert old in s, "mcmod bom"
s = s.replace(old, new)
open(p, "w", encoding="utf-8", newline="\n").write(s)
print("jar.rs done")

# ── 3) model.rs：Loader 加 Quilt ─────────────────────────────────────────────
p = "src-tauri/src/core/model.rs"
s = open(p, encoding="utf-8").read()
old = '''    Forge,
    Fabric,
    NeoForge,
    #[default]
    Unknown,
}'''
new = '''    Forge,
    Fabric,
    NeoForge,
    Quilt,
    #[default]
    Unknown,
}'''
assert old in s, "loader"
s = s.replace(old, new)
open(p, "w", encoding="utf-8", newline="\n").write(s)
print("model.rs done")

# ── 4) settings.rs：关闭行为 + 会话缓存路径 + 静态标志 ───────────────────────
p = "src-tauri/src/settings.rs"
s = open(p, encoding="utf-8").read()

old = '''    /// 界面语言：zh（中文）/ en（英文）
    #[serde(default = "default_language")]
    pub language: String,
}'''
new = '''    /// 界面语言：zh（中文）/ en（英文）
    #[serde(default = "default_language")]
    pub language: String,
    /// 主窗口关闭行为：exit（直接退出，默认）/ minimize（最小化到托盘）
    #[serde(default = "default_close_behavior")]
    pub close_behavior: String,
}'''
assert old in s, "close field"
s = s.replace(old, new)

old = '''fn default_batch_size_auto() -> bool {
    true
}'''
new = '''fn default_batch_size_auto() -> bool {
    true
}

fn default_close_behavior() -> String {
    "exit".to_string()
}'''
assert old in s
s = s.replace(old, new)

old = '''            theme: default_theme(),
            language: default_language(),
        }
    }
}'''
new = '''            theme: default_theme(),
            language: default_language(),
            close_behavior: default_close_behavior(),
        }
    }
}'''
assert old in s
s = s.replace(old, new)

# statics + helpers at end of impl Default block area (append after Default impl)
old = '''            close_behavior: default_close_behavior(),
        }
    }
}'''
new = '''            close_behavior: default_close_behavior(),
        }
    }
}

/// 主窗口关闭行为是否为「最小化到托盘」（进程级缓存，启动时与保存设置时刷新）
static CLOSE_MINIMIZE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_close_behavior(settings: &Settings) {
    use std::sync::atomic::Ordering;
    CLOSE_MINIMIZE.store(settings.close_behavior == "minimize", Ordering::Relaxed);
}

pub fn close_minimize_enabled() -> bool {
    CLOSE_MINIMIZE.load(std::sync::atomic::Ordering::Relaxed)
}'''
assert old in s
s = s.replace(old, new)

open(p, "w", encoding="utf-8", newline="\n").write(s)
print("settings.rs done")
