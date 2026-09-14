//! 深度扫描规则体系：内置规则开关 + 自定义规则 + 规则模板 + 前端元数据。
//!
//! 设计目标：把原先硬编码在 `deep_scan.rs` 里的扫描策略全部变成**可开关的规则**，
//! 模组与插件各持一套；前端只按后端下发的元数据渲染，避免前后端规则漂移。
//!
//! 两条规则**不可关闭**（normalize 会强制打开）：
//! - `skip_langfiles`：语言文件本体由常规解析处理，重复扫会产生重复条目；
//! - `keep_cjk`：含中文的文本一律保留，否则会丢失已汉化内容。

use serde::{Deserialize, Serialize};

/// 模板名
pub const TEMPLATE_RECOMMENDED: &str = "recommended";
pub const TEMPLATE_LITE: &str = "lite";
pub const TEMPLATE_FULL: &str = "full";

/// 自定义规则类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleKind {
    /// 扩展名：把该类型当作可扫文本（include）或永不扫描（exclude）
    Ext,
    /// 文件名通配（如 `*disabled*`）
    FileGlob,
    /// 路径通配（如 `Addons/**`、`config/*.yml`）
    PathGlob,
    /// 文本正则
    TextRegex,
}

/// 规则动作
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleAction {
    Include,
    Exclude,
}

/// 规则来源（用户手写 / 从档案导入）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RuleSource {
    #[default]
    User,
    Imported,
}

/// 一条自定义规则
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRule {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub kind: RuleKind,
    /// 模式：扩展名不带点（snbt）、通配支持 * 与 **、正则按 Rust regex 语法
    pub pattern: String,
    pub action: RuleAction,
    #[serde(default)]
    pub source: RuleSource,
}

fn default_true() -> bool {
    true
}

/// 自定义规则上限（防止规则过多拖慢扫描）
pub const MAX_CUSTOM_RULES: usize = 20;
/// 单条模式长度上限
pub const MAX_PATTERN_LEN: usize = 200;

/// 一套深度扫描规则
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepScanRules {
    /// 总开关：导入时对「解析为空」的内容包自动执行深度扫描
    #[serde(default)]
    pub auto: bool,
    // ── 扫描范围（扫哪些文件类型）──
    #[serde(default)]
    pub scope_json: bool,
    #[serde(default)]
    pub scope_lang: bool,
    #[serde(default)]
    pub scope_text: bool,
    #[serde(default)]
    pub scope_nested: bool,
    #[serde(default)]
    pub scope_class: bool,
    // ── 路径与语种 ──
    #[serde(default)]
    pub skip_meta: bool,
    /// 不可关闭（normalize 强制 true）
    #[serde(default)]
    pub skip_langfiles: bool,
    #[serde(default)]
    pub skip_libs: bool,
    #[serde(default)]
    pub only_source_locale: bool,
    /// 不可关闭（normalize 强制 true）
    #[serde(default)]
    pub keep_cjk: bool,
    // ── 文本过滤 ──
    #[serde(default)]
    pub drop_sql: bool,
    #[serde(default)]
    pub drop_descriptor: bool,
    #[serde(default)]
    pub drop_log: bool,
    #[serde(default)]
    pub drop_ident: bool,
    /// 代码内嵌文本需含颜色码/占位符或成句，才归入「消息」组并默认勾选
    #[serde(default)]
    pub class_needs_marker: bool,
    // ── 自定义 / 导入规则 ──
    #[serde(default)]
    pub custom: Vec<CustomRule>,
}

impl Default for DeepScanRules {
    fn default() -> Self {
        Self::recommended(false)
    }
}

impl DeepScanRules {
    /// 推荐模板（默认档）：噪声类默认关闭
    pub fn recommended(is_plugin: bool) -> Self {
        Self {
            auto: false,
            scope_json: true,
            scope_lang: true,
            scope_text: true,
            scope_nested: true,
            // 代码内嵌文本：插件的主要文本来源；模组噪声大，默认关
            scope_class: is_plugin,
            skip_meta: true,
            skip_langfiles: true,
            skip_libs: true,
            only_source_locale: true,
            keep_cjk: true,
            drop_sql: true,
            drop_descriptor: true,
            drop_log: true,
            drop_ident: true,
            class_needs_marker: true,
            custom: Vec::new(),
        }
    }

    /// 精简模板：只做常规文本，不碰嵌套与代码
    pub fn lite(is_plugin: bool) -> Self {
        let mut r = Self::recommended(is_plugin);
        r.scope_nested = false;
        r.scope_class = false;
        r
    }

    /// 全量模板（等价改造前的旧行为）：含代码内嵌，关闭全部降噪过滤
    pub fn full(is_plugin: bool) -> Self {
        Self {
            auto: false,
            scope_json: true,
            scope_lang: true,
            scope_text: true,
            scope_nested: true,
            scope_class: true,
            skip_meta: true,
            skip_langfiles: true,
            skip_libs: false,
            only_source_locale: false,
            keep_cjk: true,
            drop_sql: false,
            drop_descriptor: false,
            drop_log: false,
            drop_ident: false,
            class_needs_marker: false,
            custom: Vec::new(),
        }
    }

    pub fn apply_template(&mut self, name: &str, is_plugin: bool) {
        let custom = std::mem::take(&mut self.custom);
        *self = match name {
            TEMPLATE_LITE => Self::lite(is_plugin),
            TEMPLATE_FULL => Self::full(is_plugin),
            _ => Self::recommended(is_plugin),
        };
        self.custom = custom; // 模板只改内置规则，不丢自定义规则
    }

    /// 当前规则对应哪个模板（都不同则 None，用于前端提示「已自定义」）
    pub fn template_of(&self, is_plugin: bool) -> Option<&'static str> {
        for (name, tpl) in [
            (TEMPLATE_RECOMMENDED, Self::recommended(is_plugin)),
            (TEMPLATE_LITE, Self::lite(is_plugin)),
            (TEMPLATE_FULL, Self::full(is_plugin)),
        ] {
            if self.same_builtin(&tpl) {
                return Some(name);
            }
        }
        None
    }

    fn same_builtin(&self, other: &Self) -> bool {
        self.scope_json == other.scope_json
            && self.scope_lang == other.scope_lang
            && self.scope_text == other.scope_text
            && self.scope_nested == other.scope_nested
            && self.scope_class == other.scope_class
            && self.skip_meta == other.skip_meta
            && self.skip_langfiles == other.skip_langfiles
            && self.skip_libs == other.skip_libs
            && self.only_source_locale == other.only_source_locale
            && self.keep_cjk == other.keep_cjk
            && self.drop_sql == other.drop_sql
            && self.drop_descriptor == other.drop_descriptor
            && self.drop_log == other.drop_log
            && self.drop_ident == other.drop_ident
            && self.class_needs_marker == other.class_needs_marker
    }

    /// 归一化：锁定项强制开启、自定义规则裁剪到上限
    pub fn normalize(&mut self) {
        self.skip_langfiles = true;
        self.keep_cjk = true;
        if self.custom.len() > MAX_CUSTOM_RULES {
            self.custom.truncate(MAX_CUSTOM_RULES);
        }
        for r in &mut self.custom {
            if r.pattern.chars().count() > MAX_PATTERN_LEN {
                r.pattern = r.pattern.chars().take(MAX_PATTERN_LEN).collect();
            }
        }
    }

    /// 生效的内置规则条数（用于设置页摘要）
    pub fn enabled_builtin_count(&self) -> usize {
        [
            self.scope_json,
            self.scope_lang,
            self.scope_text,
            self.scope_nested,
            self.scope_class,
            self.skip_meta,
            self.skip_langfiles,
            self.skip_libs,
            self.only_source_locale,
            self.keep_cjk,
            self.drop_sql,
            self.drop_descriptor,
            self.drop_log,
            self.drop_ident,
            self.class_needs_marker,
        ]
        .iter()
        .filter(|b| **b)
        .count()
    }

    /// 启用的自定义规则（含导入的）
    pub fn active_custom(&self) -> Vec<&CustomRule> {
        self.custom.iter().filter(|r| r.enabled).collect()
    }
}

/// 校验自定义规则（新增/导入共用）：返回错误信息
pub fn validate_custom_rule(rule: &CustomRule) -> Result<(), String> {
    if rule.name.trim().is_empty() {
        return Err("规则名称不能为空".into());
    }
    if rule.name.chars().count() > 40 {
        return Err("规则名称过长（≤40 字）".into());
    }
    let pat = rule.pattern.trim();
    if pat.is_empty() {
        return Err("规则模式不能为空".into());
    }
    if pat.chars().count() > MAX_PATTERN_LEN {
        return Err(format!("规则模式过长（≤{} 字符）", MAX_PATTERN_LEN));
    }
    match rule.kind {
        RuleKind::Ext => {
            // 扩展名只允许字母数字（不含点），且不做二进制类型的文本扫描
            if !pat.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Err("扩展名规则只允许字母与数字（不要带点）".into());
            }
            if is_dangerous_ext(&pat.to_lowercase()) {
                return Err(format!("「{}」属于二进制/压缩格式，不能作为文本类型扫描", pat));
            }
        }
        RuleKind::FileGlob | RuleKind::PathGlob => {
            if !pat.contains('*') && rule.kind == RuleKind::FileGlob {
                return Err("文件名通配建议包含 *（例如 *disabled*）".into());
            }
        }
        RuleKind::TextRegex => {
            // Rust regex 为线性时间引擎（无回溯），天然免疫 ReDoS；此处只校验语法。
            // 默认忽略大小写（用户可用 (?-i) 局部改回），避免「写了 price 匹配不到 Price」
            regex::Regex::new(&format!("(?i){pat}")).map_err(|e| format!("正则语法错误：{e}"))?;
        }
    }
    Ok(())
}

/// 二进制/压缩扩展名：不允许被自定义规则当作文本扫描
fn is_dangerous_ext(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "icns" | "ogg" | "mp3" | "wav" | "bin"
            | "dat" | "nbt" | "zip" | "jar" | "gz" | "class" | "so" | "dll" | "exe" | "ttf"
            | "otf" | "woff" | "woff2" | "ogg"
    )
}

/// 通配匹配（`*` 匹配段内任意、`**` 匹配任意含 `/`）：转成正则实现
pub struct Globs {
    path_includes: Vec<regex::Regex>,
    path_excludes: Vec<regex::Regex>,
    file_includes: Vec<regex::Regex>,
    file_excludes: Vec<regex::Regex>,
    text_includes: Vec<regex::Regex>,
    text_excludes: Vec<regex::Regex>,
    ext_includes: Vec<String>,
    ext_excludes: Vec<String>,
    pub whitelist_paths: bool,
    pub whitelist_text: bool,
    pub any: bool,
}

fn glob_to_regex(pat: &str) -> regex::Regex {
    let mut re = String::from("^");
    let chars: Vec<char> = pat.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    re.push_str(".*");
                    i += 1;
                } else {
                    re.push_str("[^/]*");
                }
            }
            c => {
                if "\\.+?()[]{}^$|".contains(c) {
                    re.push('\\');
                }
                re.push(c);
            }
        }
        i += 1;
    }
    re.push('$');
    regex::Regex::new(&re).unwrap_or_else(|_| regex::Regex::new("$^").unwrap())
}

impl Globs {
    /// 编译启用的自定义规则；非法规则直接跳过（normalize 阶段已校验过一次）
    pub fn build(rules: &DeepScanRules) -> Self {
        let mut g = Self {
            path_includes: Vec::new(),
            path_excludes: Vec::new(),
            file_includes: Vec::new(),
            file_excludes: Vec::new(),
            text_includes: Vec::new(),
            text_excludes: Vec::new(),
            ext_includes: Vec::new(),
            ext_excludes: Vec::new(),
            whitelist_paths: false,
            whitelist_text: false,
            any: false,
        };
        for r in rules.active_custom() {
            let pat = r.pattern.trim();
            let (inc, exc) = (r.action == RuleAction::Include, r.action == RuleAction::Exclude);
            g.any = true;
            match r.kind {
                RuleKind::Ext => {
                    let e = pat.to_lowercase();
                    if inc {
                        g.ext_includes.push(e);
                    } else if exc {
                        g.ext_excludes.push(e);
                    }
                }
                RuleKind::FileGlob => {
                    let re = glob_to_regex(&pat.to_lowercase());
                    if inc {
                        g.file_includes.push(re);
                    } else if exc {
                        g.file_excludes.push(re);
                    }
                }
                RuleKind::PathGlob => {
                    let re = glob_to_regex(&pat.to_lowercase());
                    if inc {
                        g.path_includes.push(re);
                    } else if exc {
                        g.path_excludes.push(re);
                    }
                }
                RuleKind::TextRegex => {
                    if let Ok(re) = regex::Regex::new(&format!("(?i){pat}")) {
                        if inc {
                            g.text_includes.push(re);
                        } else if exc {
                            g.text_excludes.push(re);
                        }
                    }
                }
            }
        }
        g.whitelist_paths = !g.path_includes.is_empty() || !g.file_includes.is_empty();
        g.whitelist_text = !g.text_includes.is_empty();
        g
    }

    /// 自定义规则：该文件是否被排除（exclude 优先）
    pub fn file_excluded(&self, file_path: &str, file_name: &str) -> bool {
        if !self.any {
            return false;
        }
        let path = file_path.to_lowercase();
        let name = file_name.to_lowercase();
        if self.path_excludes.iter().any(|r| r.is_match(&path))
            || self.file_excludes.iter().any(|r| r.is_match(&name))
        {
            return true;
        }
        false
    }

    /// 自定义规则：白名单路径是否命中（没有任何路径 include 规则时恒为 true）
    pub fn path_allowed(&self, file_path: &str, file_name: &str) -> bool {
        if !self.whitelist_paths {
            return true;
        }
        let path = file_path.to_lowercase();
        let name = file_name.to_lowercase();
        self.path_includes.iter().any(|r| r.is_match(&path))
            || self.file_includes.iter().any(|r| r.is_match(&name))
    }

    /// 自定义规则：文本是否通过（exclude 命中即丢；有 include 时必须命中其一）
    pub fn text_allowed(&self, text: &str) -> bool {
        if !self.any {
            return true;
        }
        if self
            .text_excludes
            .iter()
            .any(|r| r.is_match(text))
        {
            return false;
        }
        if self.whitelist_text {
            return self.text_includes.iter().any(|r| r.is_match(text));
        }
        true
    }

    /// 扩展名是否被显式排除
    pub fn ext_excluded(&self, ext: &str) -> bool {
        let e = ext.to_lowercase();
        self.ext_excludes.iter().any(|x| *x == e)
    }

    /// 扩展名是否被显式加入可扫文本类型
    pub fn ext_included(&self, ext: &str) -> bool {
        let e = ext.to_lowercase();
        self.ext_includes.iter().any(|x| *x == e)
    }

    pub fn ext_includes_list(&self) -> &[String] {
        &self.ext_includes
    }
}

/// 一条内置规则的元数据（前端据此渲染，避免规则名前后端漂移）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMetaItem {
    pub id: &'static str,
    /// scope（扫描范围）/ path（路径与语种）/ filter（文本过滤）
    pub group: &'static str,
    /// i18n key 后缀，前端拼 `settings.deepScan.rule.<key>`
    pub key: &'static str,
    /// 是否不可关闭（skip_langfiles / keep_cjk）
    pub locked: bool,
    pub default_mod: bool,
    pub default_plugin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMeta {
    pub rules: Vec<RuleMetaItem>,
    pub templates: Vec<&'static str>,
    pub max_custom: usize,
    pub max_pattern_len: usize,
}

/// 内置规则清单（顺序即界面顺序）
pub fn rule_meta() -> RuleMeta {
    let m = DeepScanRules::recommended(false);
    let p = DeepScanRules::recommended(true);
    let items = vec![
        RuleMetaItem { id: "scopeJson", group: "scope", key: "scopeJson", locked: false, default_mod: m.scope_json, default_plugin: p.scope_json },
        RuleMetaItem { id: "scopeLang", group: "scope", key: "scopeLang", locked: false, default_mod: m.scope_lang, default_plugin: p.scope_lang },
        RuleMetaItem { id: "scopeText", group: "scope", key: "scopeText", locked: false, default_mod: m.scope_text, default_plugin: p.scope_text },
        RuleMetaItem { id: "scopeNested", group: "scope", key: "scopeNested", locked: false, default_mod: m.scope_nested, default_plugin: p.scope_nested },
        RuleMetaItem { id: "scopeClass", group: "scope", key: "scopeClass", locked: false, default_mod: m.scope_class, default_plugin: p.scope_class },
        RuleMetaItem { id: "skipMeta", group: "path", key: "skipMeta", locked: false, default_mod: m.skip_meta, default_plugin: p.skip_meta },
        RuleMetaItem { id: "skipLangfiles", group: "path", key: "skipLangfiles", locked: true, default_mod: true, default_plugin: true },
        RuleMetaItem { id: "skipLibs", group: "path", key: "skipLibs", locked: false, default_mod: m.skip_libs, default_plugin: p.skip_libs },
        RuleMetaItem { id: "onlySourceLocale", group: "path", key: "onlySourceLocale", locked: false, default_mod: m.only_source_locale, default_plugin: p.only_source_locale },
        RuleMetaItem { id: "keepCjk", group: "path", key: "keepCjk", locked: true, default_mod: true, default_plugin: true },
        RuleMetaItem { id: "dropSql", group: "filter", key: "dropSql", locked: false, default_mod: m.drop_sql, default_plugin: p.drop_sql },
        RuleMetaItem { id: "dropDescriptor", group: "filter", key: "dropDescriptor", locked: false, default_mod: m.drop_descriptor, default_plugin: p.drop_descriptor },
        RuleMetaItem { id: "dropLog", group: "filter", key: "dropLog", locked: false, default_mod: m.drop_log, default_plugin: p.drop_log },
        RuleMetaItem { id: "dropIdent", group: "filter", key: "dropIdent", locked: false, default_mod: m.drop_ident, default_plugin: p.drop_ident },
        RuleMetaItem { id: "classNeedsMarker", group: "filter", key: "classNeedsMarker", locked: false, default_mod: m.class_needs_marker, default_plugin: p.class_needs_marker },
    ];
    RuleMeta {
        rules: items,
        templates: vec![TEMPLATE_RECOMMENDED, TEMPLATE_LITE, TEMPLATE_FULL],
        max_custom: MAX_CUSTOM_RULES,
        max_pattern_len: MAX_PATTERN_LEN,
    }
}

/// 规则档案（导出/导入格式）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProfile {
    pub version: u32,
    /// mod / plugin：导入时校验是否与当前类型一致
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub note: Option<String>,
    pub rules: DeepScanRules,
}

pub const PROFILE_VERSION: u32 = 1;

/// 校验并归一化一个导入的规则档案
pub fn validate_profile(json: &str, expect_kind: &str) -> Result<(ScanProfile, Vec<String>), String> {
    let profile: ScanProfile = serde_json::from_str(json)
        .map_err(|e| format!("规则档案解析失败：{e}"))?;
    if profile.version > PROFILE_VERSION {
        return Err(format!(
            "规则档案版本过新（档案 v{}，当前支持 v{}）",
            profile.version, PROFILE_VERSION
        ));
    }
    if profile.kind != expect_kind {
        return Err(format!(
            "规则档案类型不匹配（档案为 {}，当前为 {}）",
            profile.kind, expect_kind
        ));
    }
    let mut warnings = Vec::new();
    let mut rules = profile.rules.clone();
    // 逐条校验自定义规则：非法规则剔除并告警（不整体拒绝，保证可用性）
    let mut kept = Vec::new();
    for r in rules.custom.drain(..) {
        match validate_custom_rule(&r) {
            Ok(()) => kept.push(r),
            Err(e) => warnings.push(format!("已跳过无效规则「{}」：{e}", r.name)),
        }
    }
    if kept.len() > MAX_CUSTOM_RULES {
        warnings.push(format!(
            "自定义规则超过上限（{} 条），仅保留前 {} 条",
            MAX_CUSTOM_RULES, MAX_CUSTOM_RULES
        ));
        kept.truncate(MAX_CUSTOM_RULES);
    }
    rules.custom = kept;
    rules.normalize();
    Ok((
        ScanProfile {
            version: PROFILE_VERSION,
            kind: profile.kind,
            name: if profile.name.trim().is_empty() {
                "社区规则档案".to_string()
            } else {
                profile.name
            },
            note: profile.note,
            rules,
        },
        warnings,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_and_locked_rules() {
        let mut r = DeepScanRules::recommended(false);
        assert!(!r.scope_class, "模组推荐模板下代码内嵌默认关闭");
        assert!(DeepScanRules::recommended(true).scope_class, "插件推荐模板默认开启");
        // 锁定项即使被改成 false，normalize 也会拉回 true
        r.skip_langfiles = false;
        r.keep_cjk = false;
        r.normalize();
        assert!(r.skip_langfiles && r.keep_cjk);
        // 模板识别
        assert_eq!(r.template_of(false), Some(TEMPLATE_RECOMMENDED));
        r.scope_json = false;
        assert_eq!(r.template_of(false), None);
        // 全量模板等价旧行为：代码内嵌开、降噪全关
        let f = DeepScanRules::full(true);
        assert!(f.scope_class && !f.only_source_locale && !f.skip_libs && !f.drop_sql);
        assert_eq!(f.template_of(true), Some(TEMPLATE_FULL));
        // 模板切换不丢自定义规则
        let mut t = DeepScanRules::recommended(false);
        t.custom.push(CustomRule {
            id: "c1".into(),
            name: "测试".into(),
            enabled: true,
            kind: RuleKind::Ext,
            pattern: "snbt".into(),
            action: RuleAction::Include,
            source: RuleSource::User,
        });
        t.apply_template(TEMPLATE_FULL, false);
        assert_eq!(t.custom.len(), 1);
    }

    #[test]
    fn template_enabled_counts() {
        // 与界面显示一致：全量 8、模组推荐 14、精简 13、插件推荐 15
        assert_eq!(DeepScanRules::full(false).enabled_builtin_count(), 8);
        assert_eq!(DeepScanRules::full(true).enabled_builtin_count(), 8);
        assert_eq!(DeepScanRules::recommended(false).enabled_builtin_count(), 14);
        assert_eq!(DeepScanRules::recommended(true).enabled_builtin_count(), 15);
        assert_eq!(DeepScanRules::lite(false).enabled_builtin_count(), 13);
        assert_eq!(DeepScanRules::lite(true).enabled_builtin_count(), 13);
        // 规则 id 必须与 DeepScanRules 的 JSON 键一致（camelCase），否则前端按 id 索引会全空
        let json = serde_json::to_value(DeepScanRules::recommended(true)).unwrap();
        let obj = json.as_object().unwrap();
        for item in rule_meta().rules {
            assert!(
                obj.contains_key(item.id),
                "规则 id「{}」在 DeepScanRules 的 JSON 键里不存在（前端会读不到值）",
                item.id
            );
        }
    }

    #[test]
    fn custom_rule_validation_and_globs() {
        let bad = CustomRule {
            id: "x".into(),
            name: "".into(),
            enabled: true,
            kind: RuleKind::Ext,
            pattern: "snbt".into(),
            action: RuleAction::Include,
            source: RuleSource::User,
        };
        assert!(validate_custom_rule(&bad).is_err(), "空名称应被拒绝");

        let dangerous = CustomRule {
            name: "png".into(),
            kind: RuleKind::Ext,
            pattern: "png".into(),
            ..bad.clone()
        };
        assert!(validate_custom_rule(&dangerous).is_err(), "二进制扩展名应被拒绝");

        let bad_regex = CustomRule {
            name: "正则".into(),
            kind: RuleKind::TextRegex,
            pattern: "([unclosed".into(),
            ..bad.clone()
        };
        assert!(validate_custom_rule(&bad_regex).is_err());

        // glob 构建与匹配
        let mut rules = DeepScanRules::recommended(false);
        rules.custom = vec![
            CustomRule { id: "1".into(), name: "限定目录".into(), enabled: true, kind: RuleKind::PathGlob, pattern: "addons/**".into(), action: RuleAction::Include, source: RuleSource::User },
            CustomRule { id: "2".into(), name: "排除禁用".into(), enabled: true, kind: RuleKind::FileGlob, pattern: "*disabled*".into(), action: RuleAction::Exclude, source: RuleSource::User },
            CustomRule { id: "3".into(), name: "文本含 price".into(), enabled: true, kind: RuleKind::TextRegex, pattern: "price".into(), action: RuleAction::Exclude, source: RuleSource::User },
            CustomRule { id: "4".into(), name: "snbt".into(), enabled: true, kind: RuleKind::Ext, pattern: "snbt".into(), action: RuleAction::Include, source: RuleSource::User },
        ];
        let g = Globs::build(&rules);
        assert!(g.file_excluded("addons/foo.json", "foo_disabled.json"), "exclude 优先");
        assert!(g.path_allowed("addons/quests/a.json", "a.json"));
        assert!(!g.path_allowed("config/b.json", "b.json"), "白名单未命中");
        assert!(!g.text_allowed("Price: 10"), "文本 exclude 命中");
        assert!(g.text_allowed("Welcome"), "未命中任意文本规则时通过");
        assert!(g.ext_included("snbt") && g.ext_includes_list().len() == 1);
    }

    #[test]
    fn profile_validation_rejects_wrong_kind_and_bad_rules() {
        let mut rules = DeepScanRules::recommended(true);
        rules.custom = vec![
            CustomRule { id: "ok".into(), name: "好规则".into(), enabled: true, kind: RuleKind::Ext, pattern: "snbt".into(), action: RuleAction::Include, source: RuleSource::Imported },
            CustomRule { id: "bad".into(), name: "坏正则".into(), enabled: true, kind: RuleKind::TextRegex, pattern: "((".into(), action: RuleAction::Include, source: RuleSource::Imported },
        ];
        let profile = ScanProfile { version: PROFILE_VERSION, kind: "plugin".into(), name: "社区包".into(), note: None, rules };
        let json = serde_json::to_string(&profile).unwrap();

        // 类型不匹配 → 拒绝
        assert!(validate_profile(&json, "mod").is_err());
        // 类型匹配 → 通过，且无效规则被剔除并给出告警
        let (p, warnings) = validate_profile(&json, "plugin").unwrap();
        assert_eq!(p.rules.custom.len(), 1);
        assert_eq!(p.rules.custom[0].name, "好规则");
        assert_eq!(warnings.len(), 1);
        // 版本过新 → 拒绝
        let future = json.replace("\"version\":1", "\"version\":99");
        assert!(validate_profile(&future, "plugin").is_err());
    }
}
