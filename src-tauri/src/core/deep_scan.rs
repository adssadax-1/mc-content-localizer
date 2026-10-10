use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Read, Seek};
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::lang;
use super::model::{EntryStatus, LangEntry};
use super::placeholder;
use super::scan_rules::{DeepScanRules, Globs};

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
    /// 稳定分组 key（message/config/data/achievement/nested/class_text/lib_text/other_locale/plain）
    group: &'static str,
}

/// 一次扫描的上下文：规则 + 编译后的自定义规则（避免重复编译正则）
pub struct ScanCtx {
    pub rules: DeepScanRules,
    pub globs: Globs,
}

impl ScanCtx {
    pub fn new(rules: &DeepScanRules) -> Self {
        Self {
            rules: rules.clone(),
            globs: Globs::build(rules),
        }
    }
}

/// 分组 key → 展示名（前端也会按 key 覆盖为 i18n 文案，label 仅作兜底）
pub fn group_label(g: &str) -> &'static str {
    match g {
        "message" => "消息文本",
        "achievement" => "成就",
        "config" => "配置文件",
        "data" => "数据文件",
        "nested" => "嵌套内容包",
        "class_text" => "代码内嵌·其他",
        "lib_text" => "库文本",
        "other_locale" => "其他语种",
        "plain" => "普通文本",
        _ => "其他文本",
    }
}

/// 该分组是否默认勾选：仅当开启「分级默认勾选」（class_needs_marker）时才勾选消息组；
/// 关闭时保持旧行为——全部默认不勾选
fn group_default_checked(g: &str, ctx: &ScanCtx) -> bool {
    ctx.rules.class_needs_marker && g == "message"
}

/// 分组排序（固定顺序，便于用户定位）
fn group_order(g: &str) -> usize {
    match g {
        "message" => 0,
        "achievement" => 1,
        "config" => 2,
        "data" => 3,
        "nested" => 4,
        "plain" => 5,
        "class_text" => 6,
        "lib_text" => 7,
        "other_locale" => 8,
        _ => 9,
    }
}

/// 被 shade 进来的第三方库：命中即视为「库文本」（仅当关闭 skip_libs 时才可能被扫到）
fn is_lib_path(file: &str) -> bool {
    const LIBS: &[&str] = &[
        "org/bukkit/", "org/spigotmc/", "io/papermc/", "com/google/", "org/yaml/", "kotlin/",
        "net/kyori/", "org/bstats/", "org/intellij/", "org/jetbrains/", "com/zaxxer/",
        "org/apache/", "com/fasterxml/", "org/json/", "net/md_5/", "com/mojang/", "joptsimple/",
        "org/slf4j/", "ch/qos/", "org/checkerframework/", "com/destroystokyo/", "io/netty/",
        "net/minecraft/", "org/spongepowered/", "net/fabricmc/", "net/minecraftforge/",
        "net/neoforged/", "it/unimi/", "org/joml/", "org/objectweb/", "org/ow2/",
    ];
    let f = file.to_lowercase();
    LIBS.iter().any(|l| f.starts_with(l))
}

/// 语言文件名里的语种代码（en_us / zh_cn / de_de / ja_jp …）；非语言文件返回 None
fn locale_of(file: &str) -> Option<String> {
    const LANGS: &[&str] = &[
        "en", "zh", "de", "fr", "ja", "ko", "ru", "es", "pt", "it", "nl", "pl", "tr", "sv", "cs",
        "uk", "vi", "th", "id", "hi", "ar", "da", "fi", "no", "el", "he", "hu", "ro", "sk", "bg",
    ];
    let stem = file.rsplit('/').next().unwrap_or(file);
    let stem = stem.rsplit_once('.').map(|(a, _)| a).unwrap_or(stem);
    let parts: Vec<String> = stem
        .split(|c| c == '_' || c == '-')
        .map(|p| p.to_lowercase())
        .collect();
    for i in (0..parts.len()).rev() {
        let p = &parts[i];
        if p.len() == 2 && LANGS.contains(&p.as_str()) {
            if i + 1 < parts.len() && parts[i + 1].len() == 2 {
                return Some(format!("{}_{}", p, parts[i + 1]));
            }
            return Some(p.clone());
        }
    }
    None
}

fn is_source_or_zh_locale(code: &str) -> bool {
    let lang = code.split('_').next().unwrap_or(code);
    matches!(lang, "en" | "zh")
}

/// 分组判定：语种 → 代码内嵌 → 库文本 → 路径 → 普通/消息文本
///
/// `allow_labels` ＝ 单字标签闸门（见 [`class_has_label_prefix`]）；**只对 `const:` 条目有意义**，
/// 其余来源一律传 `true`。标签前缀不受闸门限制（它本身就是"这个类在做 UI"的证据）。
fn group_key(file: &str, json_path: &str, text: &str, ctx: &ScanCtx, allow_labels: bool) -> &'static str {
    if ctx.rules.only_source_locale {
        if let Some(code) = locale_of(file) {
            if !is_source_or_zh_locale(&code) {
                return "other_locale";
            }
        }
    }
    if json_path.starts_with("const:") {
        // 代码内嵌：开启「需可见标记」时，像消息的归入消息组（默认勾选），其余归代码组。
        // 单词型标签（`Armour` / `Shown`）与标签前缀（`Scope: `）本身就是玩家可见的按钮
        // 文本，与「成句」「带颜色码」同级看待 —— 否则它们会落进默认不勾的
        // 「代码内嵌·其他」，扫到了也等于没翻，界面照样是英文。
        if ctx.rules.class_needs_marker {
            return if has_visible_marker(text)
                || looks_like_sentence(text)
                || (allow_labels && looks_like_label(text))
                || is_label_prefix(text, json_path)
            {
                "message"
            } else {
                "class_text"
            };
        }
        return "class_text";
    }
    if is_lib_path(file) {
        return "lib_text";
    }
    if file.starts_with("META-INF/jars/") || file.contains("/jars/") {
        return "nested";
    }
    if file.contains("/advancement") || file.starts_with("advancement") {
        return "achievement";
    }
    if file.starts_with("config/") || file.contains("/config/") {
        return "config";
    }
    if file.starts_with("data/") || file.contains("/data/") {
        return "data";
    }
    if has_visible_marker(text) || looks_like_sentence(text) {
        return "message";
    }
    "plain"
}

/// 含颜色码 / 占位符（约等于玩家可见文本）
fn has_visible_marker(t: &str) -> bool {
    if t.contains('§') {
        return true;
    }
    let b: Vec<char> = t.chars().collect();
    if b.windows(2).any(|w| {
        w[0] == '&' && "0123456789abcdefklmnorABCDEFKLMNOR".chars().any(|c| c == w[1])
    }) {
        return true;
    }
    t.contains('%') || t.contains('{') || t.contains('<')
}

/// 成句：含空格、至少两个词、长度足够
fn looks_like_sentence(t: &str) -> bool {
    let t = t.trim();
    t.chars().count() >= 8 && t.contains(' ') && t.split_whitespace().count() >= 2
}

/// 形态上是界面标签、实际是数据/格式名的词，一律不碰（宁可漏翻不可错翻）
const RESERVED_LABELS: &[&str] = &[
    "True", "False", "Null", "None", "Yes", "No", "On", "Off", "Auto", "Default", "Nan", "Inf",
    "Utf", "Utf8", "Ascii", "Json", "Yaml", "Xml", "Csv", "Md5", "Sha1", "Sha256",
];

/// 单词型 UI 标签：`Armour` / `Shown` / `Hidden` / `Glint` / `Helmet` / `Nametags` ——
/// 按钮文字与枚举显示名的主力形态。
///
/// 它们没有空格、没有颜色码也没有占位符，靠原有打分最多只拿得到「首字母大写」那 1 分，
/// 被 `score >= 2` 的门槛**整条丢掉** —— 注意这不是解析失败，是压根没进条目列表。
/// 典型症状就是「浮窗都汉化了、按钮还是英文」：浮窗文本成句能过门槛，按钮是单个词过不了；
/// 而按钮文字又常常由 `literal(label).append(literal("Shown"))` 拼出来，两半都是短词。
///
/// 判定刻意收紧成「Title 词」这一种形态：
/// - **纯 ASCII 字母** —— 排掉 `Ljava/…`、`a.b.c` 这类描述符与键名；
/// - **首字母大写且含小写字母** —— 排掉全大写常量（`ENABLED` / `ALL`，多是枚举名或字段名）
///   与全小写数据串（`elytra` / `status`）；
/// - **3~24 字** —— 排掉 `X`、`✔` 这类符号与超长文本。
///
/// 「首字母大写」这一条同时是最关键的安全阀：布尔与空值字面量是 `"true"` / `"false"` /
/// `"null"` / `"on"` / `"off"`，**全是小写**，天然进不来。它们在常量池里与按钮标签长得
/// 一模一样（都是只被 `CONSTANT_String` 引用的 Utf8），但一旦被改写就会让
/// `"true".equals(x)` 这类比较静默失配 —— 宁可漏翻不可错翻。
fn looks_like_label(t: &str) -> bool {
    let t = t.trim();
    let n = t.chars().count();
    if !(3..=24).contains(&n) || !t.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    if !t.chars().next().map_or(false, |c| c.is_ascii_uppercase()) {
        return false;
    }
    if !t.chars().any(|c| c.is_ascii_lowercase()) {
        return false;
    }
    !RESERVED_LABELS.iter().any(|w| t.eq_ignore_ascii_case(w))
}

/// 标签前缀的**形态**判据：`Scope: ` / `Armour: ` —— 去尾空格、剥掉尾部冒号后若是个标签词，
/// 就按标签处理。（是否开口子由调用方按来源决定，见 [`is_label_prefix`]。）
fn looks_like_prefix(t: &str) -> bool {
    let head = t.trim_end().trim_end_matches(':').trim_end();
    head.len() < t.len() && looks_like_label(head)
}

/// 标签前缀：`Scope: ` / `Armour: ` —— 形态像键名，其实是拼在值前面的显示文本
/// （`literal("Scope: ").append(literal("Self"))` → 界面上的「Scope: Self」）。
/// **只在代码内嵌文本上开这个口子**，常规 JSON 的「含冒号即键名」判定一字不动。
fn is_label_prefix(t: &str, json_path: &str) -> bool {
    json_path.starts_with("const:") && looks_like_prefix(t)
}

/// 单字标签的**放行闸门**：同一个 `.class` 里必须还存在 `Xxx: ` 形式的标签前缀。
///
/// 理由（实测，13 个真模组）：去掉闸门后 `Armour`/`Shown` 这类按钮词能过关，但
/// **NBT / 数据键会同批通关** —— `Name`×20、`SkullOwner`×16、`Color`×13、`Lore`×13、
/// `SpawnData`、`Patterns`、`EntityTag`、`Enchantments`… 合计 +930 条，单模组最多 +736。
/// 它们全都通过了安全过滤，也就是**真会被改写**，一旦翻成中文，
/// `stack.getTag().getString("Name")` 这类查表就会静默失配。
///
/// 三种收敛手段的实测对比（同一批模组 + hiddenarmour 回归）：
/// - NBT 键 denylist（手写 192 词）→ 只砍 **27%**，尾巴太长，不划算；
/// - 「同文件需存在句子/标记文本」→ 砍 **0%**，数据类里同样有成句文本，无区分度；
/// - **本闸门** → 砍 **95%（888/930）**，且 hiddenarmour 两个 UI 类的标签 **100% 保住**。
///
/// 另一条本可更准的路是"看调用点"（该字面量是否被 `Component.literal(...)` 消费），
/// 但 Fabric 产物里是 **intermediary 名**（`net/minecraft/class_XXXX`），按名字匹配
/// 找不到 `Component`，故不可行。
///
/// 语义上也说得通：真实的 GUI 标签总是成组出现（一个 `Armour: ` 前缀拖着一个
/// `Shown`/`Hidden` 值）；数据键则从不带这种前缀。付出的代价是"前缀与标签分处两个类"
/// 的模组会漏翻这几个词 —— 属于「宁可漏翻不可错翻」。
fn class_has_label_prefix(items: &[(usize, String)]) -> bool {
    items.iter().any(|(_, s)| looks_like_prefix(s))
}

/// 解析 .class 常量池中**可安全改写**的 `CONSTANT_Utf8` 文本（代码内嵌文本的来源）。
/// 只读常量池，不做类加载；格式参考 JVM 规范第 4 章。
///
/// 返回 `(Utf8 序号, 文本)`，序号与「池内第几个 Utf8」一一对应。
///
/// 实现放在 `core::class_pool`，与**导出侧的字节码改写**共用同一套解析 ——
/// 这是硬要求：扫描时看到的"第 N 个 Utf8"必须与改写时定位的那个是同一个，
/// 否则条目键里的 `#const:N` 就会指到别的常量上去。两边各写一遍解析必然漂移。
///
/// 顺带修掉旧实现的一个计数 bug：旧 walk 里 Utf8 每项被计了**两次**槽位、
/// `long`/`double` 又完全不占槽，于是循环条件提前满足、半个常量池读不到
/// （实测 `HiddenArmourClient.class` 只扫出 62 个 Utf8，实际有 101 个）。
///
/// 同时把"只被 `CONSTANT_String` 引用、且不被当作名字"这一条**提到扫描侧**：
/// JVM 内部名（`Code` / `LineNumberTable` / `SourceFile` / `StackMapTable` …）在池里
/// 同样是 Utf8，形态与按钮标签一模一样，能过打分门槛混进列表，却注定在改写时被
/// 按名字拒绝。让用户为这些永远落不了地的条目花 API 钱，正是"已翻译覆盖率"虚高的
/// 来源之一。过滤条件与 [`super::class_pool::ClassPool::safe_literals`] 完全一致。
fn extract_class_strings(buf: &[u8]) -> Vec<(usize, String)> {
    super::class_pool::scan_safe_strings(buf)
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

/// 判定一条文本是否可翻译，返回分数（< 阈值不采用）。
/// 先按规则做剔除（SQL / 类型描述符 / 日志句 / 标识符 / 自定义正则），再过原有黑名单与打分。
///
/// `allow_labels` ＝ 单字标签闸门，见 [`class_has_label_prefix`]。
fn score_text(text: &str, json_path: &str, ctx: &ScanCtx, allow_labels: bool) -> Option<i32> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    // 含中文：一律保留（已有中文，优先级最高，不受降噪规则影响）
    if t.chars().any(is_cjk) {
        return Some(10);
    }
    // 自定义文本规则（exclude 优先；存在 include 时必须命中其一）
    if !ctx.globs.text_allowed(t) {
        return None;
    }
    let has_marker = has_visible_marker(t);
    // 代码内嵌的单词型标签 / 标签前缀，先算出来：它们既要豁免「含冒号即键名」的误杀，
    // 又要在下面补分。
    let is_class = json_path.starts_with("const:");
    let class_label = is_class && allow_labels && looks_like_label(t);
    let class_label_prefix = is_class && is_label_prefix(t, json_path);
    // 降噪规则（有可见标记的文本通常面向玩家，不做丢弃）
    if !has_marker {
        if ctx.rules.drop_sql && looks_like_sql(t) {
            return None;
        }
        if ctx.rules.drop_descriptor && looks_like_descriptor(t) {
            return None;
        }
        if ctx.rules.drop_log && looks_like_log_line(t) {
            return None;
        }
        // 标签前缀（`Scope: `）会被 looks_like_identifier 的「含冒号即键名」误杀
        if ctx.rules.drop_ident && looks_like_identifier(t) && !class_label_prefix {
            return None;
        }
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
    // 打分
    let jp = json_path.to_lowercase();
    let mut score = 0;
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
    // 单词型标签没有空格也没有标记，原本只拿得到「首字母大写」那 1 分，到不了门槛。
    // 补 2 分让它进来；**只对代码内嵌条目生效**，常规 JSON / 语言文件 / 配置文件的分词
    // 与打分一个字节都不动。
    if class_label || class_label_prefix {
        score += 2;
    }
    if score >= 2 {
        Some(score)
    } else {
        None
    }
}

fn is_cjk(c: char) -> bool {
    let v = c as u32;
    (0x4E00..=0x9FFF).contains(&v) || (0x3400..=0x4DBF).contains(&v) || (0x3000..=0x303F).contains(&v)
}

/// 形如 SQL 语句（首词为全大写 SQL 关键字，或含明显 SQL 子句）
fn looks_like_sql(t: &str) -> bool {
    const KW: &[&str] = &[
        "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "REPLACE", "TRUNCATE",
        "PRAGMA", "EXPLAIN",
    ];
    let first = t.split_whitespace().next().unwrap_or("");
    if KW.contains(&first) {
        return true; // 首词本身就是全大写关键字
    }
    let lower = t.to_lowercase();
    let ci_kw = KW.iter().any(|k| first.eq_ignore_ascii_case(k));
    ci_kw
        && (lower.contains(" from ")
            || lower.contains(" into ")
            || lower.contains(" table ")
            || lower.contains(" values")
            || lower.contains(" where "))
}

/// 方法签名 / 类型描述符（JVM 内部串，无翻译价值）
fn looks_like_descriptor(t: &str) -> bool {
    let no_space = !t.contains(' ');
    if no_space && (t.contains(';') || (t.contains('(') && t.contains(')')) || t.contains('[')) {
        return true;
    }
    (t.starts_with('L') && t.ends_with(';'))
        || t.ends_with("()V")
        || t.ends_with(")V")
        || t.ends_with(")I")
        || t.contains("Ljava/")
}

/// 日志 / 控制台句式（面向服主而非玩家）
fn looks_like_log_line(t: &str) -> bool {
    let lower = t.to_lowercase();
    if lower.contains("exception")
        || lower.contains("stacktrace")
        || lower.contains("stack trace")
        || lower.contains("caused by")
        || (lower.contains(".java:") && lower.contains(" at "))
    {
        return true;
    }
    const PREFIX: &[&str] = &[
        "failed", "could not", "unable to", "error", "warning", "loading", "enabling",
        "disabling", "registering", "unregistering", "initializing", "shutting down", "reloading",
    ];
    if PREFIX.iter().any(|p| lower.starts_with(p)) && t.chars().count() >= 10 {
        return true;
    }
    // 「xxx 已启用/已禁用」这类生命周期提示
    if (lower.ends_with("enabled") || lower.ends_with("disabled") || lower.ends_with("enabled.") || lower.ends_with("disabled."))
        && !t.contains(' ')
    {
        return true;
    }
    false
}

/// 纯标识符 / 键名 / 权限节点（无空格且带分隔符、或全小写、或全大写常量）
fn looks_like_identifier(t: &str) -> bool {
    if t.contains(' ') || t.chars().count() > 60 {
        return false;
    }
    if t.contains('.') || t.contains(':') || t.contains('_') || t.contains('$') {
        return true;
    }
    if t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) && t.chars().count() >= 3 {
        return true; // 常量 / 枚举名
    }
    t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn consider(text: &str, json_path: &str, file: &str, ctx: &ScanCtx, out: &mut Vec<ScanItem>) {
    // 非 .class 来源没有闸门概念（单字标签规则本身就只对 const: 生效）
    consider_inner(text, json_path, file, ctx, true, out);
}

/// `.class` 常量池条目的入口：`allow_labels` 由该类的 [`class_has_label_prefix`] 决定。
fn consider_class(
    text: &str,
    json_path: &str,
    file: &str,
    ctx: &ScanCtx,
    allow_labels: bool,
    out: &mut Vec<ScanItem>,
) {
    consider_inner(text, json_path, file, ctx, allow_labels, out);
}

fn consider_inner(
    text: &str,
    json_path: &str,
    file: &str,
    ctx: &ScanCtx,
    allow_labels: bool,
    out: &mut Vec<ScanItem>,
) {
    let trimmed = text.trim();
    // score_text 的分值只用于「是否保留」门槛（>=2），本身不参与后续排序/分组
    if score_text(trimmed, json_path, ctx, allow_labels).is_some() {
        let group = group_key(file, json_path, trimmed, ctx, allow_labels);
        out.push(ScanItem {
            source: trimmed.to_string(),
            file: file.to_string(),
            json_path: json_path.to_string(),
            group,
        });
    }
}

fn walk_json(v: &serde_json::Value, path: &str, name: &str, ctx: &ScanCtx, out: &mut Vec<ScanItem>) {
    match v {
        serde_json::Value::String(s) => consider(s, path, name, ctx, out),
        serde_json::Value::Object(map) => {
            for (k, vv) in map {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", path, k)
                };
                walk_json(vv, &p, name, ctx, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for (i, vv) in arr.iter().enumerate() {
                walk_json(vv, &format!("{}[{}]", path, i), name, ctx, out);
            }
        }
        _ => {}
    }
}

/// 文件扩展名（小写，不含点）
fn ext_of(name: &str) -> &str {
    name.rsplit_once('.').map(|(_, e)| e).unwrap_or("")
}

/// 该文件是否属于某类可扫文本（受 scope 规则与自定义扩展名规则影响）
fn scannable_kind(name: &str, ctx: &ScanCtx) -> Option<&'static str> {
    let ext = ext_of(name).to_lowercase();
    // 自定义扩展名规则：显式排除优先，显式包含则按配置文件处理
    if ctx.globs.ext_excluded(&ext) {
        return None;
    }
    if ctx.globs.ext_included(&ext) {
        return Some("custom");
    }
    match ext.as_str() {
        "json" | "mcmeta" | "bbmodel" => ctx.rules.scope_json.then_some("json"),
        "lang" => ctx.rules.scope_lang.then_some("lang"),
        "properties" => ctx.rules.scope_lang.then_some("properties"),
        "toml" | "cfg" | "conf" | "ini" | "yaml" | "yml" | "txt" | "md" => {
            ctx.rules.scope_text.then_some("text")
        }
        _ => None,
    }
}

fn scan_file(name: &str, buf: &[u8], ctx: &ScanCtx, out: &mut Vec<ScanItem>) {
    match scannable_kind(name, ctx) {
        Some("json") => {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(buf) {
                walk_json(&v, "", name, ctx, out);
            }
        }
        Some("lang") => {
            if let Ok(pairs) = lang::parse_lang(buf) {
                for (k, v) in pairs {
                    consider(&v, &format!("line:{}", k), name, ctx, out);
                }
            }
        }
        Some("properties") => {
            let text = String::from_utf8_lossy(buf);
            if let Ok(pairs) = lang::parse_properties_utf8(&text) {
                for (k, v) in pairs {
                    consider(&v, &format!("line:{}", k), name, ctx, out);
                }
            }
        }
        // 文本类（含自定义扩展名加入的类型）：行级取值
        Some("text") | Some("custom") => {
            let text = String::from_utf8_lossy(buf);
            // 大文件只取前 4000 行，避免异常文件拖慢扫描
            for (i, line) in text.lines().take(4000).enumerate() {
                let line = line.trim();
                if line.is_empty()
                    || line.starts_with('#')
                    || line.starts_with("//")
                    || line.starts_with(';')
                {
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
                    consider(&v, &format!("line:{}", i + 1), name, ctx, out);
                }
            }
        }
        _ => {}
    }
}

/// 递归扫描一个 zip（主 jar 或嵌套 jar）：全部跳过与提取行为都由 ScanCtx 的规则决定
fn scan_zip<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    prefix: &str,
    ctx: &ScanCtx,
    out: &mut Vec<ScanItem>,
    depth: usize,
) {
    if depth > 3 {
        return; // 防止恶意深嵌套（固定上限，不对外暴露）
    }
    let mut nested: Vec<(String, Vec<u8>)> = Vec::new();
    // 顶层 zip：兼容「整个内容被套一层文件夹」的包装结构
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
        let file_name = name.rsplit('/').next().unwrap_or(&name).to_string();

        // 自定义规则：路径/文件名排除优先；存在白名单时未命中即跳过
        if ctx.globs.file_excluded(&name, &file_name) || !ctx.globs.path_allowed(&name, &file_name) {
            continue;
        }
        // 扩展名规则在此统一生效（.class 与嵌套 jar 也走这条），否则自定义扩展名规则对它们无效
        if ctx.globs.ext_excluded(ext_of(&name)) {
            continue;
        }
        // 嵌套 jar：先于二进制判断处理（.jar 属于二进制扩展名）
        if name.starts_with("META-INF/jars/") && name.ends_with(".jar") {
            if !ctx.rules.scope_nested {
                continue;
            }
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                nested.push((name.clone(), buf));
            }
            continue;
        }
        // 代码内嵌：.class 常量池文本（聊天前缀 / GUI 标题 / 计分板等）
        if name.to_lowercase().ends_with(".class") {
            if !ctx.rules.scope_class {
                continue;
            }
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                let strings = extract_class_strings(&buf);
                // 单字标签闸门：先看这个类有没有 `Xxx: ` 前缀，再决定要不要放行裸标签
                let allow_labels = class_has_label_prefix(&strings);
                for (i, s) in strings {
                    consider_class(&s, &format!("const:{}", i), &name, ctx, allow_labels, out);
                }
            }
            continue;
        }
        // 二进制一律不可读
        if is_binary(&name) {
            continue;
        }
        // 元数据 / 许可 / 更新日志
        if ctx.rules.skip_meta
            && (upper.contains("LICENSE")
                || upper.contains("CHANGELOG")
                || (name.starts_with("META-INF/") && !name.starts_with("META-INF/jars/")))
        {
            continue;
        }
        // 语言文件本体：由常规解析处理（锁定规则，避免与常规条目重复）
        if ctx.rules.skip_langfiles
            && name.contains("/lang/")
            && (name.ends_with(".json") || name.ends_with(".lang"))
        {
            continue;
        }
        // 被 shade 的第三方库（保留规则，用户关闭后归入「库文本」组）
        if ctx.rules.skip_libs && is_lib_path(&name) {
            continue;
        }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            continue;
        }
        scan_file(&name, &buf, ctx, out);
    }
    for (nname, buf) in nested {
        if let Ok(mut nested_arc) = ZipArchive::new(Cursor::new(buf)) {
            scan_zip(&mut nested_arc, &nname, ctx, out, depth + 1);
        }
    }
}

/// 深度扫描 jar：全文本文件启发式提取可翻译文本（含嵌套 jar 递归）
pub fn deep_scan_jar(
    path: &Path,
    default_modid: &str,
    rules: &DeepScanRules,
) -> Result<DeepScanResult, String> {
    let mut rules = rules.clone();
    rules.normalize();
    let ctx = ScanCtx::new(&rules);

    let file = File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut collected: Vec<ScanItem> = Vec::new();
    scan_zip(&mut archive, "", &ctx, &mut collected, 0);

    // 按 source 去重合并（保留首个位置，记录出现次数）。同文本取最优分组：
    // 优先级按 group_order（消息组优先），避免同一句在不同文件里被判成低价值组
    let mut map: HashMap<String, Vec<ScanItem>> = HashMap::new();
    for it in collected {
        map.entry(it.source.clone()).or_default().push(it);
    }

    let mut entries: Vec<LangEntry> = Vec::new();
    let mut group_counts: HashMap<&'static str, usize> = HashMap::new();
    for (source, items) in map {
        let first = items
            .iter()
            .min_by_key(|it| group_order(it.group))
            .unwrap_or(&items[0]);
        let group = first.group;
        *group_counts.entry(group).or_insert(0) += 1;
        let mut notes = vec![format!("深度扫描·{}", group_label(group))];
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
            deep_group: Some(group.to_string()),
        });
    }
    // 稳定排序：分组顺序固定，组内按文件路径
    entries.sort_by(|a, b| {
        let ga = group_of_entry(a);
        let gb = group_of_entry(b);
        group_order(ga)
            .cmp(&group_order(gb))
            .then_with(|| a.file_path.cmp(&b.file_path))
    });

    let groups = group_counts
        .into_iter()
        .map(|(key, count)| DeepGroup {
            key: key.to_string(),
            label: group_label(key).to_string(),
            count,
            default_checked: group_default_checked(key, &ctx),
        })
        .collect::<Vec<_>>();
    let mut groups = groups;
    groups.sort_by_key(|g| group_order(&g.key));

    Ok(DeepScanResult { entries, groups })
}

/// 从条目备注里取回分组 key（备注形如「深度扫描·配置文件」）
fn group_of_entry(e: &LangEntry) -> &str {
    const PREFIX: &str = "深度扫描·";
    let label = e
        .notes
        .first()
        .and_then(|n| n.strip_prefix(PREFIX))
        .unwrap_or("");
    for key in [
        "message",
        "achievement",
        "config",
        "data",
        "nested",
        "plain",
        "class_text",
        "lib_text",
        "other_locale",
    ] {
        if group_label(key) == label {
            return key;
        }
    }
    "plain"
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
        let res = deep_scan_jar(&p, "testmod", &DeepScanRules::full(false)).unwrap();
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
        let res = deep_scan_jar(&p, "wrapper", &DeepScanRules::full(false)).unwrap();
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
        let res = deep_scan_jar(&p, "testmod", &DeepScanRules::full(false)).unwrap();
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

    /// 构造一个极简 .class：仅含常量池两个 Utf8 字符串（解析器读到常量池结束即停）
    /// 构造极简 .class 夹具。交给 `class_pool` 统一实现 —— 扫描侧现在只认
    /// 「被 CONSTANT_String 引用且不被当作名字」的 Utf8，手搓裸常量池会一个都扫不出来。
    fn fake_class(strings: &[&str]) -> Vec<u8> {
        super::super::class_pool::fake_class(strings)
    }

    #[test]
    fn rules_change_scan_output() {
        use super::super::scan_rules::DeepScanRules;
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file("config.yml", opts).unwrap();
            w.write_all(b"welcome: \"&aWelcome to the server!\"
max-players: 20
").unwrap();
            // 德语音阶文件：only_source_locale 开启时应归入「其他语种」而不是当原文
            w.start_file("lang/lang_de_DE.properties", opts).unwrap();
            w.write_all(b"welcome=Willkommen auf dem Server
").unwrap();
            // 文本文件里的日志句式：drop_log 开启时应被丢弃
            w.start_file("notes.md", opts).unwrap();
            w.write_all(b"Failed to load the config file
This sword deals extra damage
").unwrap();
            // 代码内嵌：一条 SQL、一条玩家可见消息
            w.start_file("data/Store.class", opts).unwrap();
            w.write_all(&fake_class(&["SELECT * FROM players WHERE id = ?"])).unwrap();
            w.start_file("gui/Shop.class", opts).unwrap();
            w.write_all(&fake_class(&["&aShop opened! Click to continue"])).unwrap();
            w.finish().unwrap();
        }
        let dir = std::env::temp_dir().join("deep_scan_rules_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rules.jar");
        std::fs::write(&p, buf.into_inner()).unwrap();

        let srcs = |r: &DeepScanResult| -> Vec<String> {
            let mut v: Vec<String> = r.entries.iter().map(|e| e.source.clone()).collect();
            v.sort();
            v
        };
        let group_of_src = |r: &DeepScanResult, needle: &str| -> Option<(String, bool)> {
            r.entries
                .iter()
                .find(|e| e.source.contains(needle))
                .map(|e| (e.notes.first().cloned().unwrap_or_default(), e.key.clone()))
                .map(|(n, _)| {
                    let g = r
                        .groups
                        .iter()
                        .find(|g| n.ends_with(&g.label))
                        .map(|g| (g.key.clone(), g.default_checked))
                        .unwrap_or_default();
                    (g.0, g.1)
                })
        };

        // ① 推荐模板（模组）：不扫代码内嵌
        let rec_mod = deep_scan_jar(&p, "m", &DeepScanRules::recommended(false)).unwrap();
        assert!(
            !srcs(&rec_mod).iter().any(|s| s.contains("Shop opened")),
            "模组推荐模板下不应扫出 .class 文本"
        );

        // ② 推荐模板（插件）：扫代码内嵌，但 SQL 被丢、日志句被丢
        let rec_plug = deep_scan_jar(&p, "m", &DeepScanRules::recommended(true)).unwrap();
        let plug_srcs = srcs(&rec_plug);
        assert!(plug_srcs.iter().any(|s| s.contains("Shop opened")), "插件应扫出代码内消息");
        assert!(!plug_srcs.iter().any(|s| s.contains("SELECT")), "SQL 应被丢弃");
        assert!(
            !plug_srcs.iter().any(|s| s.contains("Failed to load")),
            "日志句式应被丢弃"
        );
        // 玩家可见消息归入「消息文本」且默认勾选
        let (g, checked) = group_of_src(&rec_plug, "Shop opened").unwrap();
        assert_eq!(g, "message");
        assert!(checked, "消息组应默认勾选");
        // 德语音阶归入「其他语种」（保留可查，但不默认勾选、不当作原文）
        let (g_de, checked_de) = group_of_src(&rec_plug, "Willkommen").unwrap();
        assert_eq!(g_de, "other_locale");
        assert!(!checked_de);

        // ③ 全量模板（= 旧行为）：SQL、日志句、德语音阶都进来
        let full = deep_scan_jar(&p, "m", &DeepScanRules::full(true)).unwrap();
        let full_srcs = srcs(&full);
        assert!(full_srcs.iter().any(|s| s.contains("SELECT")), "全量模板保留 SQL");
        assert!(full_srcs.iter().any(|s| s.contains("Failed to load")), "全量模板保留日志句");
        assert!(full_srcs.iter().any(|s| s.contains("Willkommen")), "全量模板保留其他语种");
        assert!(
            full.groups.iter().all(|g| !g.default_checked),
            "全量模板下不应有默认勾选的分组（等价旧行为）"
        );

        // ④ 自定义规则：扩展名把 .langx 当文本；文本正则的 exclude / include 两个方向
        let ext_rule = |pat: &str| super::super::scan_rules::CustomRule {
            id: format!("ext-{pat}"),
            name: "langx".into(),
            enabled: true,
            kind: super::super::scan_rules::RuleKind::Ext,
            pattern: pat.into(),
            action: super::super::scan_rules::RuleAction::Include,
            source: super::super::scan_rules::RuleSource::User,
        };
        let text_rule = |pat: &str, action: super::super::scan_rules::RuleAction| {
            super::super::scan_rules::CustomRule {
                id: format!("tx-{pat}"),
                name: format!("文本规则 {pat}"),
                enabled: true,
                kind: super::super::scan_rules::RuleKind::TextRegex,
                pattern: pat.into(),
                action,
                source: super::super::scan_rules::RuleSource::User,
            }
        };
        let mut buf2 = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf2);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file("quests.langx", opts).unwrap();
            w.write_all(
                b"hint=Talk to the village elder
price=100 coins
other=Bring me 3 apples
",
            )
            .unwrap();
            w.finish().unwrap();
        }
        let p2 = dir.join("custom.jar");
        std::fs::write(&p2, buf2.into_inner()).unwrap();

        // 仅扩展名规则：三条都被当作文本扫出来
        let mut r_ext = DeepScanRules::recommended(true);
        r_ext.custom.push(ext_rule("langx"));
        let base = srcs(&deep_scan_jar(&p2, "m", &r_ext).unwrap());
        assert_eq!(base.len(), 3, "自定义扩展名应把 .langx 当文本扫描：{base:?}");

        // 叠加 exclude 文本规则：coins 那条被剔除
        let mut r_ex = r_ext.clone();
        r_ex.custom.push(text_rule("coins", super::super::scan_rules::RuleAction::Exclude));
        let ex = srcs(&deep_scan_jar(&p2, "m", &r_ex).unwrap());
        assert!(!ex.iter().any(|s| s.contains("coins")), "exclude 正则应剔除条目：{ex:?}");
        assert_eq!(ex.len(), 2);

        // 改成 include 白名单：只保留命中 village 的条目
        let mut r_in = DeepScanRules::recommended(true);
        r_in.custom.push(ext_rule("langx"));
        r_in.custom.push(text_rule("village", super::super::scan_rules::RuleAction::Include));
        let inc = srcs(&deep_scan_jar(&p2, "m", &r_in).unwrap());
        assert_eq!(inc.len(), 1, "include 白名单应只留命中项：{inc:?}");
        assert!(inc[0].contains("village elder"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 单词型按钮标签（`Armour` / `Shown` / `Scope: `）过去被打分门槛整条丢掉 ——
    /// 表现为「浮窗都汉化了、按钮还是英文」。此测试把判据、打分与分组一起钉住。
    #[test]
    fn class_label_words_are_scanned_and_default_checked() {
        // ① 形态判据：只有「Title 词」才算标签
        for ok in ["Armour", "Shown", "Hidden", "Glint", "Nametags", "Elytra", "All"] {
            assert!(looks_like_label(ok), "「{ok}」应判为标签");
        }
        // 全大写常量（多是枚举名 / 字段名）、全小写数据串、描述符、键名、纯符号一律不是
        for no in [
            "ENABLED", "DISABLED", "ALL", "true", "false", "off", "elytra", "status",
            "Ljava/lang/Object;", "key.hiddenarmour.toggle", "a.b.c", "X", "✔", "a b",
        ] {
            assert!(!looks_like_label(no), "「{no}」不应判为标签");
        }
        // 保留词：形态像标签，但常被拿去和 equals / valueOf 比较，宁可漏翻
        assert!(!looks_like_label("True"));
        assert!(!looks_like_label("Null"));
        // 已知边界：不含斜杠的 TitleCase 类名（理论上会命中）。实际常量池里的类名都带
        // 包路径（`haage/hiddenarmour/...`），命不中；这是刻意接受的极小过匹配面。
        assert!(looks_like_label("HiddenArmourScreen"));

        // ② 标签前缀只在代码内嵌条目上开口子
        assert!(is_label_prefix("Scope: ", "const:344"));
        assert!(is_label_prefix("Armour: ", "const:309"));
        assert!(!is_label_prefix("Scope: ", "button.armour"), "非 const 路径不开口子");
        assert!(!is_label_prefix("minecraft:", "const:1"), "全小写 → 不是标签");
        assert!(!is_label_prefix("Scope", "const:344"), "没有冒号可剥");

        // ③ 打分：过去只拿 1 分被丢，现在补 2 分能过门槛；**非 const 路径一字不改**
        let ctx = ScanCtx::new(&DeepScanRules::recommended(true));
        for s in ["Armour", "Shown", "Scope: "] {
            assert!(
                score_text(s, "const:344", &ctx, true).is_some(),
                "「{s}」应被保留"
            );
            assert!(
                score_text(s, "button.armour", &ctx, true).is_none(),
                "「{s}」在常规 JSON 路径下不应被放行（新规则只作用于 const: 条目）"
            );
        }

        // ③b 闸门：裸标签必须在「同类里还有 Xxx: 前缀」时才放行；**前缀本身不受闸门限制**
        for lab in ["Armour", "Shown"] {
            assert!(
                score_text(lab, "const:344", &ctx, false).is_none(),
                "「{lab}」在无前缀的 class 里不应被放行（否则 NBT 键会成批通关）"
            );
        }
        assert!(
            score_text("Scope: ", "const:344", &ctx, false).is_some(),
            "标签前缀是『这个类在做 UI』的证据，自己不受闸门限制"
        );
        assert!(class_has_label_prefix(&[(1, "Armour".to_string()), (2, "Scope: ".to_string())]));
        assert!(!class_has_label_prefix(&[(1, "Name".to_string()), (2, "Lore".to_string())]));

        // ④ 分组：标签与标签前缀都归「消息文本」（默认勾选），
        //    否则会落进默认不勾的「代码内嵌·其他」，扫到了也等于没翻
        assert_eq!(
            group_key("HiddenArmourScreen.class", "const:309", "Armour", &ctx, true),
            "message"
        );
        assert_eq!(
            group_key("HiddenArmourScreen.class", "const:344", "Scope: ", &ctx, true),
            "message"
        );
        assert_eq!(
            group_key("HiddenArmourScreen.class", "const:1", "Ljava/lang/Object;", &ctx, true),
            "class_text"
        );
        assert_eq!(
            group_key("SomeData.class", "const:309", "Armour", &ctx, false),
            "class_text",
            "闸门关闭时裸标签不得进默认勾选组"
        );
    }

    /// 拿**真模组目录**把「标签闸门」收紧前后的条目数 A/B 出来（默认静默跳过）。
    ///
    /// 设 `MCL_MODS_PROBE` = 存放若干 jar 的目录，可选 `MCL_MODS_PROBE_OUT` = 落一份文本，
    /// 因为 libtest 吞 println、`mcl.sh test` 又不透传 `--nocapture`。
    ///
    /// 口径说明：两侧都只统计 **`.class` 常量池里被保留的条目**（`const:N`），
    /// 左边＝不装闸门（`allow_labels = true`，即本轮之前的行为），右边＝装了闸门。
    /// 期望：右侧显著更少，且真 UI 类（同类带 `Xxx: ` 前缀）的标签一个不丢。
    #[test]
    fn probes_real_mods_label_gate_when_requested() {
        let Ok(dir) = std::env::var("MCL_MODS_PROBE") else {
            return; // 未设环境变量 → 静默跳过
        };
        let out_path = std::env::var("MCL_MODS_PROBE_OUT").ok();
        let mut lines: Vec<String> = Vec::new();

        let ctx = ScanCtx::new(&DeepScanRules::recommended(true));
        let mut jars: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .expect("无法读取模组目录")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map_or(false, |x| x.eq_ignore_ascii_case("jar")))
            .collect();
        jars.sort();

        let (mut sum_open, mut sum_gated) = (0usize, 0usize);
        let mut dropped_words: std::collections::HashMap<String, usize> = Default::default();
        let mut kept_words: std::collections::HashMap<String, usize> = Default::default();

        for jar in &jars {
            let Ok(f) = std::fs::File::open(jar) else { continue };
            let Ok(mut z) = zip::ZipArchive::new(f) else { continue };
            let (mut n_open, mut n_gated) = (0usize, 0usize);
            for i in 0..z.len() {
                let Ok(mut e) = z.by_index(i) else { continue };
                let name = e.name().to_string();
                if !name.to_lowercase().ends_with(".class") {
                    continue;
                }
                let mut buf = Vec::new();
                if std::io::Read::read_to_end(&mut e, &mut buf).is_err() {
                    continue;
                }
                let strings = extract_class_strings(&buf);
                let allow = class_has_label_prefix(&strings);
                for (ord, s) in &strings {
                    let jp = format!("const:{}", ord);
                    let open = score_text(s, &jp, &ctx, true).is_some();
                    let gated = score_text(s, &jp, &ctx, false).is_some();
                    if open {
                        n_open += 1;
                    }
                    if gated {
                        n_gated += 1;
                    }
                    if open && !gated {
                        *dropped_words.entry(s.clone()).or_default() += 1;
                    }
                    if allow && looks_like_label(s) {
                        *kept_words.entry(s.clone()).or_default() += 1;
                    }
                }
            }
            sum_open += n_open;
            sum_gated += n_gated;
            lines.push(format!(
                "{:34} 不装闸门 {:>5}  装闸门 {:>5}  砍掉 {:>5}",
                jar.file_name().unwrap_or_default().to_string_lossy(),
                n_open,
                n_gated,
                n_open as i64 - n_gated as i64
            ));
        }

        lines.push(format!(
            "\n合计（{} 个模组）：不装闸门 {} → 装闸门 {}（砍掉 {}）",
            jars.len(),
            sum_open,
            sum_gated,
            sum_open as i64 - sum_gated as i64
        ));
        let mut dropped: Vec<_> = dropped_words.into_iter().collect();
        dropped.sort_by(|a, b| b.1.cmp(&a.1));
        lines.push("\n被闸门砍掉的，出现最多的（前 25）：".into());
        for (w, c) in dropped.iter().take(25) {
            lines.push(format!("  {c:>5}×  {w:?}"));
        }
        lines.push("\n带前缀的类里被放行的标签（前 25）：".into());
        let mut kept: Vec<_> = kept_words.into_iter().collect();
        kept.sort_by(|a, b| b.1.cmp(&a.1));
        for (w, c) in kept.iter().take(25) {
            lines.push(format!("  {c:>5}×  {w:?}"));
        }

        let text = lines.join("\n");
        if let Some(p) = out_path {
            let _ = std::fs::write(p, &text);
        }
        println!("{text}");
    }
}
