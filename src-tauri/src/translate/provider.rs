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
    #[error("未配置 API Key（请在设置中填写）")]
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

    /// devtools 故障注入（provider 全部 HTTP 请求共用）：
    /// 断网/模拟状态码 → 返回 Some(伪造错误)；延迟 → sleep 后返回 None 继续正常发送。
    #[cfg(feature = "devtools")]
    async fn dev_fault(&self) -> Option<TranslateError> {
        let fc = crate::dev::get_fault()?;
        use std::time::Duration;

        // disconnect → 直接返回伪造连接错误
        if fc.disconnect {
            crate::dev::dev_emit(
                "dev-http-response",
                serde_json::json!({
                    "status": 0u16,
                    "bodyHead": "dev: disconnect fault (no request sent)",
                }),
            );
            return Some(TranslateError::Api {
                status: 0,
                body: "dev: disconnect fault".to_string(),
            });
        }

        // mockStatus → 不发真请求，直接返回伪造响应
        if let Some(ms) = fc.mock_status {
            let mb = fc
                .mock_body
                .clone()
                .unwrap_or_else(|| "dev: mock fault".to_string());
            crate::dev::dev_emit(
                "dev-http-response",
                serde_json::json!({
                    "status": ms,
                    "bodyHead": mb,
                }),
            );
            return Some(TranslateError::Api {
                status: ms,
                body: mb.chars().take(500).collect(),
            });
        }

        // delayMs → 发送前 sleep
        if let Some(d) = fc.delay_ms {
            tokio::time::sleep(Duration::from_millis(d)).await;
        }
        None
    }

    /// devtools forceTimeout：注入生效时用 1s 超时的临时 client，否则用正常 client
    #[cfg(feature = "devtools")]
    fn dev_send_client(&self) -> reqwest::Client {
        if crate::dev::get_fault()
            .map(|fc| fc.force_timeout)
            .unwrap_or(false)
        {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(1))
                .build()
                .unwrap_or_else(|_| self.client.clone())
        } else {
            self.client.clone()
        }
    }

    /// 单次对话请求，返回模型输出的文本。
    /// purpose: 请求用途标记（"translate" 翻译 / "glossary" 术语提取），仅 devtools 事件里使用。
    /// 遇到 400 参数类错误时自动降级重试：
    /// 1) 去掉 response_format（JSON 模式）重试
    /// 2) 改用整数温度 1.0 重试（部分模型只接受 0 或 1）
    pub async fn chat(&self, system: &str, user: &str, purpose: &str) -> Result<String, TranslateError> {
        let temp = self.config.temperature();
        match self.chat_inner(system, user, temp, true, purpose).await {
            Err(TranslateError::Api { status: 400, .. }) => {
                // 400：先去掉 response_format 重试
                #[cfg(feature = "devtools")]
                crate::dev::dev_emit("dev-degradation", serde_json::json!({"stage": "json-off"}));
                match self.chat_inner(system, user, temp, false, purpose).await {
                    Ok(r) => Ok(r),
                    Err(_) => {
                        // 仍失败：改用整数温度 1.0 再试一次
                        #[cfg(feature = "devtools")]
                        crate::dev::dev_emit("dev-degradation", serde_json::json!({"stage": "temp-integer", "temp": 1.0}));
                        self.chat_inner(system, user, 1.0, false, purpose).await
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
        purpose: &str,
    ) -> Result<String, TranslateError> {
        #[cfg(not(feature = "devtools"))]
        let _ = purpose;
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

        // devtools 插桩：发送前 emit 请求详情（全文，dev 构建专用不受体积限制）
        #[cfg(feature = "devtools")]
        crate::dev::dev_emit("dev-http-request", serde_json::json!({
            "url": &url,
            "model": model,
            "temperature": temperature,
            "jsonMode": json_mode,
            "purpose": purpose,
            "systemHead": system,
            "userHead": user,
        }));

        // devtools 故障注入：整个 provider 层生效（翻译/术语提取/拉模型/测试模型共用）
        #[cfg(feature = "devtools")]
        if let Some(e) = self.dev_fault().await {
            return Err(e);
        }

        // devtools forceTimeout → 用 1s 超时 client 发送
        #[cfg(feature = "devtools")]
        let send_client = self.dev_send_client();
        #[cfg(not(feature = "devtools"))]
        let send_client = self.client.clone();

        let resp = send_client
            .post(&url)
            .bearer_auth(self.config.api_key.trim())
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        // devtools 插桩：收到后 emit 响应详情（全文）
        #[cfg(feature = "devtools")]
        crate::dev::dev_emit("dev-http-response", serde_json::json!({
            "status": status.as_u16(),
            "bodyHead": text,
        }));

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

        // devtools 故障注入：拉取模型同样受影响
        #[cfg(feature = "devtools")]
        if let Some(e) = self.dev_fault().await {
            return Err(e);
        }
        #[cfg(feature = "devtools")]
        let send_client = self.dev_send_client();
        #[cfg(not(feature = "devtools"))]
        let send_client = self.client.clone();

        let resp = send_client
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

    /// 批量让模型给内容包起简洁的中文名（用于导出文件名）。
    /// 走统一的 chat() 链路：规则放 system、编号列表放 user，温度取设置值，
    /// 并自动获得 JSON 模式与 400 参数错误降级重试（与翻译请求同一套约定）。
    /// 返回（按入参位置对齐的结果, 模型原始输出），解析严格按编号回填、不做位置猜测。
    pub async fn generate_pack_names_batch(
        &self,
        items: &[(String, String, Option<String>)],
    ) -> Result<(Vec<Option<String>>, String), TranslateError> {
        if items.is_empty() {
            return Ok((Vec::new(), String::new()));
        }
        let mut user = String::from("内容包列表：
");
        for (i, (display, kind, ver)) in items.iter().enumerate() {
            let kind_cn = match kind.as_str() {
                "mod" => "模组",
                "plugin" => "服务器插件",
                "shader" => "光影包",
                "resourcepack" => "资源包",
                _ => "内容包",
            };
            let ver_part = ver
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .map(|v| format!("；游戏版本：{v}"))
                .unwrap_or_default();
            user.push_str(&format!("{}. 类型：{}；原名：{}{}
", i + 1, kind_cn, display, ver_part));
        }
        let raw = self.chat(NAME_SYSTEM_PROMPT, &user, "name").await?;
        let parsed = parse_indexed_names(&raw, items.len());
        let out = (0..items.len())
            .map(|i| parsed.get(&(i + 1)).cloned())
            .collect();
        Ok((out, raw))
    }

    /// 验证当前配置（API Key + Base URL + 模型）是否可用：发送一个最小请求并检查响应。
    /// 仅用于设置页「验证连接」，不参与翻译流程。
    #[allow(dead_code)]
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

        // devtools 插桩：连通性测试也进「请求/响应」面板（purpose = test）
        #[cfg(feature = "devtools")]
        crate::dev::dev_emit("dev-http-request", serde_json::json!({
            "url": &url,
            "model": &model,
            "temperature": 0,
            "jsonMode": false,
            "purpose": "test",
            "systemHead": "",
            "userHead": "ping",
        }));

        // devtools 故障注入：测试模型同样受影响
        #[cfg(feature = "devtools")]
        if let Some(e) = self.dev_fault().await {
            return Err(e);
        }
        #[cfg(feature = "devtools")]
        let send_client = self.dev_send_client();
        #[cfg(not(feature = "devtools"))]
        let send_client = self.client.clone();

        let resp = send_client
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
/// 内容包命名的 system 提示词：规则固定放这里，编号列表由 user 提供
const NAME_SYSTEM_PROMPT: &str = r#"你是《我的世界》(Minecraft) 本地化命名助手。用户会给出一份带编号的内容包列表，请为每个内容包给出一个简洁的中文名，用作导出文件名。

规则：
1. 每个名字 4-12 个汉字，优先采用玩家社区通用译名（如 Create → 机械动力，Complementary Shaders → 互补光影）
2. 不要引号、不要解释、不要结尾标点；不要出现 / : * ? < > | 等字符
3. 编号必须与输入一一对应，不得增删、合并或改动编号
4. 只输出一个 JSON 对象，格式为 {"names":[{"i":1,"n":"机械动力"},{"i":2,"n":"互补光影"}]}
5. 类型与游戏版本仅作参考，不要写进名字里"#;

fn round_to_2dp(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// 解析模型返回的「编号 → 中文名」。只按编号回填，不做位置猜测：
/// 编号缺失/越界/重复的一律丢弃（宁可不命名，也不给错名字）。
fn parse_indexed_names(text: &str, count: usize) -> std::collections::HashMap<usize, String> {
    use std::collections::HashMap;
    let mut out: HashMap<usize, String> = HashMap::new();

    let mut put = |idx: usize, raw: &str, out: &mut HashMap<usize, String>| {
        if idx == 0 || idx > count || out.contains_key(&idx) {
            return;
        }
        let name = clean_pack_name(raw);
        if !name.is_empty() {
            out.insert(idx, name);
        }
    };

    // 两种 JSON 形态都要认：裸数组 `[{...}]`，或对象包裹 `{"names":[{...}]}`
    let arr_slice = match (text.find('['), text.rfind(']')) {
        (Some(a), Some(b)) if b > a => serde_json::from_str::<serde_json::Value>(&text[a..=b]).ok(),
        _ => None,
    };
    let obj_slice = match (text.find('{'), text.rfind('}')) {
        (Some(a), Some(b)) if b > a => serde_json::from_str::<serde_json::Value>(&text[a..=b]).ok(),
        _ => None,
    };
    let array_value = arr_slice
        .as_ref()
        .filter(|v| v.is_array())
        .cloned()
        .or_else(|| {
            obj_slice.as_ref().and_then(|v| {
                ["names", "items", "list", "result", "data"]
                    .iter()
                    .find_map(|k| v.get(k).filter(|x| x.is_array()).cloned())
            })
        });

    // 1) 优先按 JSON 数组解析（i/n 或 index/name；编号允许字符串形式）
    if let Some(arr) = array_value.as_ref().and_then(|v| v.as_array()) {
        for item in arr {
            let idx = ["i", "index", "id"]
                .iter()
                .find_map(|k| item.get(k))
                .and_then(|x| {
                    x.as_u64()
                        .map(|n| n as usize)
                        .or_else(|| x.as_str().and_then(|s| s.trim().parse::<usize>().ok()))
                });
            let name = ["n", "name", "zh", "cn"]
                .iter()
                .find_map(|k| item.get(k))
                .and_then(|x| x.as_str());
            if let (Some(i), Some(n)) = (idx, name) {
                put(i, n, &mut out);
            }
        }
    }

    // 1.5) 数字键映射形式：{"1":"机械动力","2":"互补光影"}（键即编号，同样不会错位）
    if out.is_empty() {
        if let Some(obj) = obj_slice.as_ref().and_then(|v| v.as_object()) {
            for (k, v) in obj {
                if let (Ok(i), Some(n)) = (k.trim().parse::<usize>(), v.as_str()) {
                    put(i, n, &mut out);
                }
            }
        }
    }

    // 2) 逐个对象正则（JSON 被截断/夹杂文字时）
    if out.is_empty() {
        if let Ok(re) = regex::Regex::new(r#"\{\s*"(?:i|index)"\s*:\s*(\d+)[^}]*?"(?:n|name)"\s*:\s*"([^"]*)""#) {
            for cap in re.captures_iter(text) {
                if let (Ok(i), Some(n)) = (cap[1].parse::<usize>(), cap.get(2)) {
                    put(i, n.as_str(), &mut out);
                }
            }
        }
    }

    // 3) 行式兜底：`1. 机械动力` / `1、机械动力` / `1：机械动力`
    if out.is_empty() {
        for line in text.lines() {
            let t = line.trim().trim_start_matches(['-', '*', ' ']).trim_start();
            let t = t.trim_start_matches("```json").trim_start_matches("```").trim();
            let Some(pos) = t.find(['.', '、', ':', '：', ')', '）']) else {
                continue;
            };
            // 分隔符可能是多字节字符（如 、：）→ 按字符长度跳过，避免字节切片越界
            let sep_len = t[pos..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
            let head = t[..pos].trim().trim_start_matches(['"', 'i', 'n']);
            if let Ok(i) = head.trim().parse::<usize>() {
                put(i, t[pos + sep_len..].trim(), &mut out);
            }
        }
    }

    out
}

/// 清洗模型返回的名称：取首行、去引号与首尾标点、去非法字符、限长
fn clean_pack_name(raw: &str) -> String {
    let first = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut s: String = first
        .trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’' | '《' | '》' | '【' | '】'))
        .trim()
        .to_string();
    // 去掉常见前缀式说明
    for prefix in ["中文名：", "中文名:", "名称：", "名称:", "名字：", "名字:"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim().to_string();
        }
    }
    s = s
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let s = s.trim().trim_end_matches(['。', '，', '.', ',', '!', '！']).trim().to_string();
    s.chars().take(20).collect()
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

    #[test]
    fn cleans_model_generated_pack_name() {
        assert_eq!(clean_pack_name("机械动力"), "机械动力");
        assert_eq!(clean_pack_name("\"机械动力\"
解释：xxx"), "机械动力");
        assert_eq!(clean_pack_name("中文名：机械动力"), "机械动力");
        assert_eq!(clean_pack_name("机械动力_汉化。"), "机械动力_汉化");
        assert_eq!(clean_pack_name("机械/动力: 汉化"), "机械动力 汉化");
        assert_eq!(clean_pack_name(""), "");
        assert_eq!(clean_pack_name("《Complementary 光影》"), "Complementary 光影");
        // 超长截断到 20 字
        let long = "机械动力超级无敌长名字测试用例";
        assert!(clean_pack_name(&long).chars().count() <= 20);
    }

    #[test]
    fn parses_indexed_names_by_index_not_position() {
        use std::collections::HashMap;
        // 正常 JSON 数组
        let a = parse_indexed_names(
            r#"[{"i":1,"n":"机械动力"},{"i":2,"n":"互补光影"}]"#,
            2,
        );
        assert_eq!(a.get(&1).map(|s| s.as_str()), Some("机械动力"));
        assert_eq!(a.get(&2).map(|s| s.as_str()), Some("互补光影"));

        // 模型乱序返回：必须按编号回填（不得按顺序）
        let b = parse_indexed_names(r#"[{"i":2,"n":"互补光影"},{"i":1,"n":"机械动力"}]"#, 2);
        assert_eq!(b.get(&1).map(|s| s.as_str()), Some("机械动力"));
        assert_eq!(b.get(&2).map(|s| s.as_str()), Some("互补光影"));

        // 越界编号被丢弃；缺编号的包保持未命名（不得张冠李戴）
        let c = parse_indexed_names(r#"[{"i":1,"n":"机械动力"},{"i":9,"n":"越界"}]"#, 2);
        assert_eq!(c.len(), 1);
        assert!(!c.contains_key(&2));

        // 夹杂说明文字 / 代码块围栏
        let d = parse_indexed_names(
            "好的：
```json
[{\"i\":1,\"n\":\"机械动力\"}]
```
完成",
            1,
        );
        assert_eq!(d.get(&1).map(|s| s.as_str()), Some("机械动力"));

        // 行式兜底
        let e = parse_indexed_names("1. 机械动力
2、互补光影", 2);
        assert_eq!(e.get(&1).map(|s| s.as_str()), Some("机械动力"));
        assert_eq!(e.get(&2).map(|s| s.as_str()), Some("互补光影"));

        // 无编号内容 → 全部丢弃（宁可不命名）
        let f = parse_indexed_names("机械动力
互补光影", 2);
        assert!(f.is_empty(), "无编号时不得回填");

        // 重复编号只取首个
        let g = parse_indexed_names(r#"[{"i":1,"n":"甲"},{"i":1,"n":"乙"}]"#, 1);
        assert_eq!(g.get(&1).map(|s| s.as_str()), Some("甲"));

        let _: HashMap<usize, String> = a;

        // 对象包裹数组（JSON 模式下要求顶层为对象，模型最可能这么返回）
        let h = parse_indexed_names(
            r#"{"names":[{"i":1,"n":"机械动力"},{"i":2,"n":"互补光影"}]}"#,
            2,
        );
        assert_eq!(h.get(&1).map(|s| s.as_str()), Some("机械动力"));
        assert_eq!(h.get(&2).map(|s| s.as_str()), Some("互补光影"));

        // 数字键映射形式
        let i = parse_indexed_names(r#"{"1":"机械动力","2":"互补光影"}"#, 2);
        assert_eq!(i.get(&1).map(|s| s.as_str()), Some("机械动力"));
        assert_eq!(i.get(&2).map(|s| s.as_str()), Some("互补光影"));

        // 字符串编号 / 别名键
        let j = parse_indexed_names(r#"[{"index":"2","name":"互补光影"}]"#, 2);
        assert_eq!(j.get(&2).map(|s| s.as_str()), Some("互补光影"));
        let k = parse_indexed_names(r#"[{"id":1,"zh":"机械动力"}]"#, 1);
        assert_eq!(k.get(&1).map(|s| s.as_str()), Some("机械动力"));
    }
}
