# -*- coding: utf-8 -*-
# ── pack.rs：公共根前缀工具 + 三处应用 ────────────────────────────────────────
p = "src-tauri/src/core/pack.rs"
s = open(p, encoding="utf-8").read()

helper = '''
/// 计算 zip 的公共根目录前缀：所有文件都在单一顶层文件夹内时返回 "X/"，否则 None。
/// 兼容"整个内容包被套了一层文件夹"的 zip（如 Bliss-Shader-Unstable/...）。
/// 顶层名是标准根（assets/shaders/META-INF）时不剥离，杜绝误剥。
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

pub fn detect_pack_type(path: &Path) -> Result<PackType, PackError> {'''
old = "pub fn detect_pack_type(path: &Path) -> Result<PackType, PackError> {"
assert old in s, "detect head"
s = s.replace(old, helper, 1)

old = '''    for i in 0..archive.len() {
        let name = archive.by_index(i)?.name().to_string();
        if name == "shaders/shaders.properties" {'''
new = '''    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = common_root_prefix(&names);
    let norm = |n: &str| n.strip_prefix(root_prefix.as_deref().unwrap_or("")).unwrap_or(n);

    for i in 0..archive.len() {
        let name = norm(&archive.by_index(i)?.name().to_string());
        if name == "shaders/shaders.properties" {'''
assert old in s, "detect loop"
s = s.replace(old, new)

old = '''    let mut lang_map: HashMap<String, (String, Vec<(String, String)>)> = HashMap::new();

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let entry_name = f.name().to_string();'''
new = '''    let mut lang_map: HashMap<String, (String, Vec<(String, String)>)> = HashMap::new();
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = common_root_prefix(&names);
    let norm = |n: &str| n.strip_prefix(root_prefix.as_deref().unwrap_or("")).unwrap_or(n);

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let entry_name = norm(&f.name().to_string());'''
assert old in s, "shader loop"
s = s.replace(old, new)

old = '''    let mut description = String::new();
    let mut found = false;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        if f.name() != "pack.mcmeta" {
            continue;
        }'''
new = '''    let mut description = String::new();
    let mut found = false;
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = common_root_prefix(&names);
    let norm = |n: &str| n.strip_prefix(root_prefix.as_deref().unwrap_or("")).unwrap_or(n);
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        if norm(f.name()) != "pack.mcmeta" {
            continue;
        }'''
assert old in s, "resource loop"
s = s.replace(old, new)
open(p, "w", encoding="utf-8", newline="\n").write(s)
print("pack.rs prefix done")

# ── jar.rs ───────────────────────────────────────────────────────────────────
p = "src-tauri/src/core/jar.rs"
s = open(p, encoding="utf-8").read()

old = '''pub fn parse_jar(path: &Path) -> Result<ModFile, JarError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    let meta = read_mod_metadata(&mut archive)?;'''
new = '''pub fn parse_jar(path: &Path) -> Result<ModFile, JarError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;

    // 顶层文件夹包装兼容：剥离公共根前缀后再做路径匹配
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let root_prefix = super::pack::common_root_prefix(&names);
    let norm = |n: &str| n.strip_prefix(root_prefix.as_deref().unwrap_or("")).unwrap_or(n);

    let meta = read_mod_metadata(&mut archive, root_prefix.as_deref())?;'''
assert old in s, "jar head"
s = s.replace(old, new)

old = '''    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = f.name().to_string();
        let Some(caps) = LANG_PATH_RE.captures(&name) else {'''
new = '''    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = norm(&f.name().to_string());
        let Some(caps) = LANG_PATH_RE.captures(&name) else {'''
assert old in s, "jar pass1"
s = s.replace(old, new)

old = '''fn scan_hardcoded(
    archive: &mut ZipArchive<File>,
    entries: &mut Vec<LangEntry>,
    key_index: &mut HashMap<String, usize>,
    default_modid: &str,
) -> Result<(), JarError> {
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = f.name().to_string();
        if !is_text_scan_target(&name) {
            continue;
        }'''
new = '''fn scan_hardcoded(
    archive: &mut ZipArchive<File>,
    entries: &mut Vec<LangEntry>,
    key_index: &mut HashMap<String, usize>,
    default_modid: &str,
    root_prefix: Option<&str>,
) -> Result<(), JarError> {
    let norm = |n: &str| n.strip_prefix(root_prefix.unwrap_or("")).unwrap_or(n);
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = norm(&f.name().to_string());
        if !is_text_scan_target(&name) {
            continue;
        }'''
assert old in s, "scan_hardcoded sig"
s = s.replace(old, new)

# call site: add root_prefix arg
old = '''    scan_hardcoded(
'''
new = '''    scan_hardcoded(
'''
i = s.index("    scan_hardcoded(")
# find the closing of first arg line to append prefix after default_modid
seg = s[i:i+400]
assert "default_modid" in seg
s = s[:i] + seg.replace("default_modid,\n", "default_modid,\n        root_prefix.as_deref(),\n", 1) + s[i+400:]

old = '''fn read_mod_metadata(archive: &mut ZipArchive<File>) -> Result<ModMeta, JarError> {
    let mut meta = ModMeta::default();

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = f.name().to_string();'''
new = '''fn read_mod_metadata(
    archive: &mut ZipArchive<File>,
    root_prefix: Option<&str>,
) -> Result<ModMeta, JarError> {
    let mut meta = ModMeta::default();
    let norm = |n: &str| n.strip_prefix(root_prefix.unwrap_or("")).unwrap_or(n);

    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = norm(&f.name().to_string());'''
assert old in s, "meta sig"
s = s.replace(old, new)
open(p, "w", encoding="utf-8", newline="\n").write(s)
print("jar.rs prefix done")

# ── deep_scan.rs ─────────────────────────────────────────────────────────────
p = "src-tauri/src/core/deep_scan.rs"
s = open(p, encoding="utf-8").read()
old = '''    let mut nested: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut f = match archive.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let raw_name = f.name().to_string();
        let name = if prefix.is_empty() {
            raw_name
        } else {
            format!("{}/{}", prefix, raw_name)
        };'''
new = '''    let mut nested: Vec<(String, Vec<u8>)> = Vec::new();
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
        };'''
assert old in s, "deep scan"
s = s.replace(old, new)
open(p, "w", encoding="utf-8", newline="\n").write(s)
print("deep_scan prefix done")
