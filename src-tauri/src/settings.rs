use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::translate::provider::{ModelInfo, ProviderConfig};

/// 多线程翻译配置（实验性功能）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadingConfig {
    /// 是否启用多线程并行翻译
    #[serde(default)]
    pub enabled: bool,
    /// 线程数（1-8，免费模型建议 1-2，付费模型 4-8）
    #[serde(default = "default_thread_count")]
    pub thread_count: usize,
    /// 每个线程请求之间的间隔秒数（默认 4s，保险防限流）
    #[serde(default = "default_request_interval")]
    pub request_interval_sec: u64,
}

fn default_thread_count() -> usize {
    2
}

fn default_request_interval() -> u64 {
    4
}

fn default_theme() -> String {
    "light".to_string()
}

fn default_language() -> String {
    "zh".to_string()
}

fn default_batch_size_auto() -> bool {
    true
}

fn default_close_behavior() -> String {
    "exit".to_string()
}

impl Default for ThreadingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            thread_count: 2,
            request_interval_sec: 4,
        }
    }
}

/// 应用设置（本地持久化到 app_config_dir/settings.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 当前选中的 AI 翻译服务配置（api_key 为当前 provider 的 key）
    pub provider: ProviderConfig,
    /// 各服务商分别保存的 API Key（切换服务商不串 key）
    #[serde(default)]
    pub provider_api_keys: HashMap<String, String>,
    /// 各服务商分别保存的模型（切换服务商显示各自选择的模型）
    #[serde(default)]
    pub provider_models: HashMap<String, String>,
    /// 各服务商分别缓存的模型列表（拉取过的显示对应服务商的，没拉取过则提示）
    #[serde(default)]
    pub provider_model_options: HashMap<String, Vec<ModelInfo>>,
    /// 用户自定义术语表 [(英文, 中文)]
    pub user_glossary: Vec<(String, String)>,
    /// 每批翻译条数
    pub batch_size: usize,
    /// 每批条数自动按线程数取最优（条目数 ÷ 线程数，向上取整）；false 时用 batch_size
    #[serde(default = "default_batch_size_auto")]
    pub batch_size_auto: bool,
    /// 是否先让 AI 提取模组术语表
    pub extract_glossary: bool,
    /// 多线程翻译配置
    #[serde(default)]
    pub threading: ThreadingConfig,
    /// 内容包并行翻译开关
    #[serde(default)]
    pub pack_parallel_enabled: bool,
    /// 同时翻译的内容包数（0 = 无限制）
    #[serde(default)]
    pub pack_parallel_count: u32,
  /// 自定义提示词（key: mod / shader / resourcepack → 用户自定义的可编辑段）
  #[serde(default)]
  pub custom_prompts: HashMap<String, String>,
  /// 主题模式：light（亮色）/ dark（暗色）
  #[serde(default = "default_theme")]
  pub theme: String,
  /// 界面语言：zh（中文）/ en（英文）
  #[serde(default = "default_language")]
  pub language: String,
  /// 无字模式：隐藏外壳（顶栏/侧栏/工具栏/页脚）的文字，只保留图标
  #[serde(default)]
  pub icon_only: bool,
  /// 主窗口关闭行为：exit（直接退出，默认）/ minimize（最小化到托盘）
  #[serde(default = "default_close_behavior")]
  pub close_behavior: String,
  /// 最近打开的游戏目录（游戏目录模式快速重选，最多保留 5 个）
  #[serde(default)]
  pub recent_game_dirs: Vec<String>,
  /// 深度扫描规则：模组与插件各自独立（JSON 键 `deepScanRules.{mod,plugin}`，
  /// 与历史布尔键 `deepScan` / `deepScanPlugin` 分属不同命名空间，避免升级时键冲突）
  #[serde(default)]
  pub deep_scan_rules: DeepScanSettings,
  /// 迁移用：旧版本遗留的布尔开关（读入后合并进规则集，不再写回）
  #[serde(default, rename = "deepScan", skip_serializing)]
  pub legacy_deep_scan: Option<bool>,
  #[serde(default, rename = "deepScanPlugin", skip_serializing)]
  pub legacy_deep_scan_plugin: Option<bool>,
  /// 导出命名偏好：raw（原名）/ suffix（原名_zh_cn，默认）/ ai（AI 汉化名称）
  #[serde(default = "default_export_naming")]
  pub export_naming: String,
  /// AI 汉化名称缓存（key = "文件名|大小"），仅在选择 AI 命名偏好时生成
  #[serde(default)]
  pub ai_names: HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: ProviderConfig::default(),
            provider_api_keys: HashMap::new(),
            provider_models: HashMap::new(),
            provider_model_options: HashMap::new(),
            user_glossary: Vec::new(),
            batch_size: 40,
            batch_size_auto: true,
            extract_glossary: true,
            threading: ThreadingConfig::default(),
            pack_parallel_enabled: false,
            pack_parallel_count: 2,
            custom_prompts: HashMap::new(),
            theme: default_theme(),
            language: default_language(),
            icon_only: false,
            close_behavior: default_close_behavior(),
            recent_game_dirs: Vec::new(),
            export_naming: default_export_naming(),
            deep_scan_rules: DeepScanSettings::default(),
            legacy_deep_scan: None,
            legacy_deep_scan_plugin: None,
            ai_names: HashMap::new(),
        }
    }
}

/// 主窗口关闭行为是否为「最小化到托盘」（进程级缓存，启动时与保存设置时刷新）
static CLOSE_MINIMIZE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 深度扫描规则容器：模组与插件各自一套
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepScanSettings {
    #[serde(rename = "mod", default = "default_rules_mod")]
    pub mod_rules: crate::core::scan_rules::DeepScanRules,
    #[serde(default = "default_rules_plugin")]
    pub plugin: crate::core::scan_rules::DeepScanRules,
}

impl Default for DeepScanSettings {
    fn default() -> Self {
        Self {
            mod_rules: default_rules_mod(),
            plugin: default_rules_plugin(),
        }
    }
}

fn default_rules_mod() -> crate::core::scan_rules::DeepScanRules {
    crate::core::scan_rules::DeepScanRules::recommended(false)
}

fn default_rules_plugin() -> crate::core::scan_rules::DeepScanRules {
    crate::core::scan_rules::DeepScanRules::recommended(true)
}

fn default_export_naming() -> String {
    "suffix".to_string()
}

pub fn set_close_behavior(settings: &Settings) {
    use std::sync::atomic::Ordering;
    CLOSE_MINIMIZE.store(settings.close_behavior == "minimize", Ordering::Relaxed);
}

pub fn close_minimize_enabled() -> bool {
    CLOSE_MINIMIZE.load(std::sync::atomic::Ordering::Relaxed)
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        let text = fs::read_to_string(path).ok();
        let mut s: Self = match text.as_deref().map(serde_json::from_str::<Self>) {
            Some(Ok(v)) => v,
            Some(Err(_)) => {
                // 文件存在但解析失败（旧版本写过不兼容的结构、或文件被外部改坏）：
                // 先把原文件改名留档，再退回默认值。否则后续任何一次保存都会把
                // 用户的 API Key / 规则 / 术语表永久覆盖掉，且无从察觉。
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = path.with_file_name(format!("settings.corrupt-{stamp}.json"));
                let _ = fs::rename(path, &backup);
                Self::default()
            }
            None => Self::default(),
        };
        s.migrate();
        s
    }

    /// 旧设置迁移：把历史布尔开关并入规则集（auto），并归一化规则（锁定项强制开启）
    pub fn migrate(&mut self) {
        // 旧字段名：deepScan（模组，前端曾写入但此前 Rust 未声明 → 一直被丢弃）、
        // deepScanPlugin（插件，历史确实落盘过）
        if let Some(v) = self.legacy_deep_scan {
            if v {
                self.deep_scan_rules.mod_rules.auto = true;
            }
        }
        if let Some(v) = self.legacy_deep_scan_plugin {
            if v {
                self.deep_scan_rules.plugin.auto = true;
            }
        }
        self.deep_scan_rules.mod_rules.normalize();
        self.deep_scan_rules.plugin.normalize();
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, text).map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 损坏的设置文件必须被改名留档（否则一次读取失败 + 一次保存就把用户数据清空）
    #[test]
    fn corrupt_settings_file_is_backed_up_not_overwritten() {
        let dir = std::env::temp_dir().join("settings_corrupt_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, "{ this is not json ").unwrap();

        let loaded = Settings::load(&path);
        assert_eq!(loaded.theme, Settings::default().theme, "解析失败应退回默认值");
        assert!(!path.exists(), "原文件应被移走留档");
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("settings.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "应生成一个留档文件，实际：{backups:?}");
        let kept = fs::read_to_string(dir.join(&backups[0])).unwrap();
        assert!(kept.contains("not json"), "留档内容必须是原始文本");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_flags_into_rules() {
        // 以「完整默认设置」为基底，注入历史遗留的布尔键（真实升级场景：
        // 老文件里有 deepScan / deepScanPlugin，没有 deepScanRules）
        let mut val = serde_json::to_value(Settings::default()).unwrap();
        val["deepScan"] = serde_json::json!(true);
        val["deepScanPlugin"] = serde_json::json!(true);
        let mut s: Settings = serde_json::from_value(val).unwrap();
        s.migrate();

        assert!(s.deep_scan_rules.mod_rules.auto, "历史 deepScan 应迁移为模组自动扫描");
        assert!(s.deep_scan_rules.plugin.auto, "历史 deepScanPlugin 应迁移为插件自动扫描");
        // 锁定项：即使设置文件里写成 false，也要被拉回 true
        assert!(s.deep_scan_rules.mod_rules.skip_langfiles && s.deep_scan_rules.mod_rules.keep_cjk);
        // 模组与插件的规则互相独立
        assert!(!s.deep_scan_rules.mod_rules.scope_class, "模组推荐模板默认不扫代码内嵌");
        assert!(s.deep_scan_rules.plugin.scope_class, "插件推荐模板默认扫代码内嵌");
        // 旧布尔键不再写回；规则落在独立命名空间
        let out = serde_json::to_string(&s).unwrap();
        assert!(out.contains("deepScanRules"));
        assert!(!out.contains("\"deepScan\":"), "旧键不应再写回：{out}");
    }

    #[test]
    fn tolerates_fresh_defaults() {
        // 全新安装：无规则字段 → 取推荐模板；两个 auto 默认关
        let mut s: Settings = serde_json::from_value(serde_json::json!({})).unwrap_or_default();
        s.migrate();
        assert!(!s.deep_scan_rules.mod_rules.auto && !s.deep_scan_rules.plugin.auto);
        assert!(s.deep_scan_rules.mod_rules.scope_json, "推荐模板默认开启 JSON 扫描");
        assert!(s.deep_scan_rules.plugin.scope_class, "插件推荐模板默认扫代码内嵌");
    }

    #[test]
    fn rules_survive_round_trip() {
        let mut s = Settings::default();
        s.deep_scan_rules.plugin.auto = true;
        s.deep_scan_rules.plugin.scope_class = false;
        s.deep_scan_rules.plugin.custom.push(crate::core::scan_rules::CustomRule {
            id: "c1".into(),
            name: "langx".into(),
            enabled: true,
            kind: crate::core::scan_rules::RuleKind::Ext,
            pattern: "langx".into(),
            action: crate::core::scan_rules::RuleAction::Include,
            source: crate::core::scan_rules::RuleSource::User,
        });
        // 从规则档案导入的规则（source = imported）也必须原样往返：
        // 导入后保存 → 重启读取时若被丢掉，界面就会出现「外面有统计、里面是空的」
        s.deep_scan_rules.plugin.custom.push(crate::core::scan_rules::CustomRule {
            id: "p1".into(),
            name: "只看语言目录".into(),
            enabled: true,
            kind: crate::core::scan_rules::RuleKind::PathGlob,
            pattern: "lang/**".into(),
            action: crate::core::scan_rules::RuleAction::Include,
            source: crate::core::scan_rules::RuleSource::Imported,
        });
        let text = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&text).unwrap();
        assert!(back.deep_scan_rules.plugin.auto);
        assert!(!back.deep_scan_rules.plugin.scope_class);
        assert_eq!(back.deep_scan_rules.plugin.custom.len(), 2);
        assert_eq!(back.deep_scan_rules.plugin.custom[0].pattern, "langx");
        let imported = &back.deep_scan_rules.plugin.custom[1];
        assert_eq!(imported.pattern, "lang/**");
        assert!(imported.enabled, "导入的规则启用状态不能被重置");
        assert_eq!(
            imported.source,
            crate::core::scan_rules::RuleSource::Imported,
            "导入来源标记必须保留",
        );
        // 落盘后再走一次 load（含迁移/归一化），确保不会被归一化吃掉
        let dir = std::env::temp_dir().join("settings_round_trip_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        s.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.deep_scan_rules.plugin.custom.len(), 2);
        assert_eq!(loaded.deep_scan_rules.plugin.custom[1].pattern, "lang/**");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
