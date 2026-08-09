use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::translate::provider::{ModelInfo, ProviderConfig};

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
    /// 是否先让 AI 提取模组术语表
    pub extract_glossary: bool,
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
            extract_glossary: true,
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, text).map_err(|e| e.to_string())
    }
}
