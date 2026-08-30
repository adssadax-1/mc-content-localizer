use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 翻译服务配置（前端设置页填写，本地持久化）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// provider 标识：zhipu | gemini | deepseek | qwen | doubao | moonshot | hunyuan
    /// | siliconflow | openrouter | openai | custom
    pub provider: String,
    pub api_key: String,
    /// 自定义模型名（None 时用预设默认）
    pub model: Option<String>,
    /// 自定义 base_url（provider=custom 时使用）
    pub base_url: Option<String>,
    /// 温度（None 用 0.7）
    pub temperature: Option<f32>,
    /// 单批重试次数（None 用 2）
    pub max_retries: Option<u32>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            provider: "zhipu".to_string(),
            api_key: String::new(),
            model: None,
            base_url: None,
            temperature: Some(0.7),
            max_retries: Some(2),
        }
    }
}

/// 预设 provider 的 (base_url, model)
pub const PRESETS: &[(&str, &str, &str)] = &[
    // 智谱 GLM-4-Flash：免费、无需信用卡、国内直连
    ("zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-4-flash-250414"),
    // Google Gemini 免费层（OpenAI 兼容端点）
    ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash"),
    // DeepSeek：便宜，无免费层
    ("deepseek", "https://api.deepseek.com/v1", "deepseek-v4-flash"),
    // 阿里百炼 qwen-flash：极便宜
    ("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-flash"),
    // 火山方舟（豆包）：模型名可为具体模型 ID 或控制台创建的接入点 ID（ep- 开头）
    ("doubao", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-8"),
    // 月之暗面 Kimi：256K 上下文
    ("moonshot", "https://api.moonshot.cn/v1", "kimi-k2"),
    // 腾讯混元
    ("hunyuan", "https://api.hunyuan.cloud.tencent.com/v1", "hunyuan-turbos-latest"),
    // 硅基流动：聚合 100+ 开源模型，部分永久免费，国内直连
    ("siliconflow", "https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3.2"),
    // OpenRouter：聚合网关，一个 Key 调全平台（模型 ID 带 vendor 前缀）
    ("openrouter", "https://openrouter.ai/api/v1", "google/gemini-2.5-flash"),
    // OpenAI：国内访问不稳定
    ("openai", "https://api.openai.com/v1", "gpt-5-mini"),
];

impl ProviderConfig {
    /// 解析出 (base_url, model)
    pub fn resolve_endpoint(&self) -> (String, String) {
        if self.provider == "custom" {
            return (
                self.base_url.clone().unwrap_or_default(),
                self.model.clone().unwrap_or_default(),
            );
        }
        for (id, url, model) in PRESETS {
            if *id == self.provider {
                return (url.to_string(), self.model.clone().unwrap_or_else(|| model.to_string()));
            }
        }
        // 未知 provider 回退到智谱
        ("https://open.bigmodel.cn/api/paas/v4".to_string(), self.model.clone().unwrap_or("glm-4-flash-250414".to_string()))
    }

    pub fn temperature(&self) -> f32 {
        self.temperature.unwrap_or(0.7)
    }

    pub fn max_retries(&self) -> u32 {
        self.max_retries.unwrap_or(2)
    }
}

/// 翻译请求错误
#[derive(Debug, Error)]
pub enum TranslateError {
    #[error("HTTP 请求失败: {0}")]
    Http(#[from] reqwest::Error),
    #[error("服务返回错误状态 {status}: {body}")]
    Api { status: u16, body: String },
    #[error("未配置 API Key")]
    MissingApiKey,
    #[error("未选择模型")]
    MissingModel,
    #[error("模型响应为空")]
    EmptyResponse,
    #[error("响应 JSON 解析失败: {0}")]
    Json(#[from] serde_json::Error),
}

/// 模型信息（列表展示用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// 是否确认为免费模型
    pub free: bool,
}

/// OpenAI 兼容 chat completions 客户端
#[derive(Clone)]
pub struct OpenAiProvider {
    pub config: ProviderConfig,
    client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(config: ProviderConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("failed to build http client");
        Self { config, client }
    }

    /// 单次对话请求，返回模型输出的文本。
    /// 遇到 400 参数类错误时自动降级重试：
    /// 1) 去掉 response_format（JSON 模式）重试
    /// 2) 改用整数温度 1.0 重试（部分模型只接受 0 或 1）
    pub async fn chat(&self, system: &str, user: &str) -> Result<String, TranslateError> {
        let temp = self.config.temperature();
        match self.chat_inner(system, user, temp, true).await {
            Err(TranslateError::Api { status: 400, .. }) => {
                // 400：先去掉 response_format 重试
                match self.chat_inner(system, user, temp, false).await {
                    Ok(r) => Ok(r),
                    Err(_) => {
                        // 仍失败：改用整数温度 1.0 再试一次
                        self.chat_inner(system, user, 1.0, false).await
                    }
                }
            }
            r => r,
        }
    }

    /// 实际发请求（可配置 temperature 与是否启用 JSON 模式）
    async fn chat_inner(
        &self,
        system: &str,
        user: &str,
        temperature: f32,
        json_mode: bool,
    ) -> Result<String, TranslateError> {
        if self.config.api_key.trim().is_empty() {
            return Err(TranslateError::MissingApiKey);
        }
        let (base_url, model) = self.config.resolve_endpoint();
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

        let mut body = serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ],
            "temperature": round_to_2dp(temperature)
        });
        if json_mode {
            body["response_format"] = serde_json::json!({"type": "json_object"});
        }

        let resp = self
            .client
            .post(&url)
            .bearer_auth(self.config.api_key.trim())
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(TranslateError::Api {
                status: status.as_u16(),
                body: text.chars().take(500).collect(),
            });
        }

        let value: serde_json::Value = serde_json::from_str(&text)?;
        let content = value
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
            .ok_or(TranslateError::EmptyResponse)?;

        if content.trim().is_empty() {
            return Err(TranslateError::EmptyResponse);
        }
        Ok(content.trim().to_string())
    }

    /// 拉取可用模型列表（GET /models，OpenAI 兼容），过滤非对话模型
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, TranslateError> {
        if self.config.api_key.trim().is_empty() {
            return Err(TranslateError::MissingApiKey);
        }
        let (base_url, _) = self.config.resolve_endpoint();
        let url = format!("{}/models", base_url.trim_end_matches('/'));

        let resp = self
            .client
            .get(&url)
            .bearer_auth(self.config.api_key.trim())
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(TranslateError::Api {
                status: status.as_u16(),
                body: text.chars().take(300).collect(),
            });
        }

        let value: serde_json::Value = serde_json::from_str(&text)?;
        let mut models: Vec<ModelInfo> = Vec::new();
        if let Some(data) = value.get("data").and_then(|d| d.as_array()) {
            for m in data {
                let Some(id) = m.get("id").and_then(|i| i.as_str()) else {
                    continue;
                };
                let lower = id.to_lowercase();
                // 过滤 embedding/rerank/tts/文生图等非对话模型
                if ["embedding", "rerank", "tts", "codegeex", "image", "text2img"]
                    .iter()
                    .any(|k| lower.contains(k))
                {
                    continue;
                }
                // 名称中带 "free" 的视为免费模型（如 OpenRouter 的 :free 后缀）
                models.push(ModelInfo {
                    id: id.to_string(),
                    free: lower.contains("free"),
                });
            }
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));

        // 智谱的免费模型不在 /models 接口返回里，手动合并（仍可调用且免费）
        if self.config.provider == "zhipu" {
            for free in ["glm-4-flash-250414", "glm-4.7-flash"] {
                if !models.iter().any(|m| m.id == free) {
                    models.push(ModelInfo {
                        id: free.to_string(),
                        free: true,
                    });
                }
            }
            models.sort_by(|a, b| a.id.cmp(&b.id));
        }

        Ok(models)
    }

    /// 验证当前配置（API Key + Base URL + 模型）是否可用：发送一个最小请求并检查响应。
    /// 仅用于设置页「验证连接」，不参与翻译流程。
    pub async fn test_model(&self) -> Result<String, TranslateError> {
        if self.config.api_key.trim().is_empty() {
            return Err(TranslateError::MissingApiKey);
        }
        let (base_url, model) = self.config.resolve_endpoint();
        if model.trim().is_empty() {
            return Err(TranslateError::MissingModel);
        }
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": model,
            "messages": [{"role":"user","content":"ping"}],
            "max_tokens": 5,
            "temperature": 0
        });
        let resp = self
            .client
            .post(&url)
            .bearer_auth(self.config.api_key.trim())
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(TranslateError::Api {
                status: status.as_u16(),
                body: text.chars().take(300).collect(),
            });
        }
        let value: serde_json::Value = serde_json::from_str(&text)?;
        let ok = value
            .get("choices")
            .and_then(|c| c.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if ok {
            Ok(format!("连接成功，模型「{}」可用", model))
        } else {
            Err(TranslateError::EmptyResponse)
        }
    }
}

/// 智谱 API 要求 temperature 最多 2 位小数
fn round_to_2dp(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_temperature_to_2dp() {
        assert_eq!(round_to_2dp(0.7), 0.7);
        assert_eq!(round_to_2dp(0.755), 0.76);
        assert_eq!(round_to_2dp(1.0), 1.0);
        assert_eq!(round_to_2dp(0.33333334), 0.33);
    }

    #[test]
    fn resolve_endpoint_presets() {
        let cfg = ProviderConfig {
            provider: "zhipu".into(),
            ..Default::default()
        };
        let (url, model) = cfg.resolve_endpoint();
        assert!(url.contains("bigmodel.cn"));
        assert_eq!(model, "glm-4-flash-250414");

        let cfg = ProviderConfig {
            provider: "custom".into(),
            base_url: Some("http://localhost:11434/v1".into()),
            model: Some("llama3".into()),
            ..Default::default()
        };
        let (url, model) = cfg.resolve_endpoint();
        assert_eq!(url, "http://localhost:11434/v1");
        assert_eq!(model, "llama3");
    }
}
