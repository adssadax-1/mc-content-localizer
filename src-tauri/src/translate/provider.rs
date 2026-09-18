use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 翻译服务配置（前端设置页填写，本地持久化）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// provider 标识：zhipu | gemini | deepseek | qwen | doubao | moonshot | hunyuan
    /// | siliconflow | openrouter | openai | ollama | llamacpp | custom
    pub provider: String,
    pub api_key: String,
    /// 自定义模型名（None 时用预设默认）
    pub model: Option<String>,
    /// 自定义 base_url（provider=custom 或本地档时使用）
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
    // Ollama：本地推理，默认监听 11434，无需 API Key（模型名取自 `ollama list`）
    ("ollama", "http://localhost:11434/v1", ""),
    // llama.cpp llama-server：本地推理，默认监听 8080，默认免鉴权
    ("llamacpp", "http://127.0.0.1:8080/v1", ""),
];

/// 本地推理服务标识：不需要 API Key，也不应发送 Authorization 头
pub const LOCAL_PROVIDERS: &[&str] = &["ollama", "llamacpp"];

/// 是否按 provider 标识判定为本地推理服务
pub fn is_local_provider_id(id: &str) -> bool {
    LOCAL_PROVIDERS.contains(&id)
}

/// base_url 是否指向本机（localhost / 127.0.0.1 / [::1] / *.localhost）。
/// 只认真实回环地址，`localhost.evil.com` 这类不匹配。
pub fn is_local_url(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    let after_scheme = u
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(u.as_str());
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    // 去掉 userinfo（http://user:pass@host/…）
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        // IPv6 字面量：[::1]:8080
        rest.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "::")
        || host.ends_with(".localhost")
}

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
                // 本地档允许覆盖 base_url（换端口、局域网部署）；云端档不接受，
                // 避免历史遗留的 base_url 把请求打到意料之外的地址。
                let base = if is_local_provider_id(id) {
                    self.base_url
                        .as_deref()
                        .map(str::trim)
                        .filter(|u| !u.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| url.to_string())
                } else {
                    url.to_string()
                };
                return (
                    base,
                    self.model.clone().unwrap_or_else(|| model.to_string()),
                );
            }
        }
        // 未知 provider 回退到智谱
        ("https://open.bigmodel.cn/api/paas/v4".to_string(), self.model.clone().unwrap_or("glm-4-flash-250414".to_string()))
    }

    /// 是否指向本地推理服务：provider 标识命中，或**自定义**端点的地址落在本机。
    ///
    /// 注意这里刻意不看云端预设档的 base_url —— `resolve_endpoint` 会忽略它，
    /// 真正发出去的请求仍指向云端。若按残留值判断，"先用自定义指过 localhost、
    /// 再切回 DeepSeek"就会让空 Key 蒙混过关，变成一次注定 401 的请求。
    pub fn is_local(&self) -> bool {
        if is_local_provider_id(&self.provider) {
            return true;
        }
        if self.provider == "custom" {
            return self.base_url.as_deref().map(is_local_url).unwrap_or(false);
        }
        false
    }

    /// API Key 校验：本地档允许留空（服务端根本不校验），云端档必须填。
    pub fn ensure_key(&self) -> Result<(), TranslateError> {
        if self.api_key.trim().is_empty() && !self.is_local() {
            return Err(TranslateError::MissingApiKey);
        }
        Ok(())
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

/// 云端接口单请求超时（秒）
const REQUEST_TIMEOUT_SECS: u64 = 180;
/// 本地推理服务单请求超时（秒）：冷启动要加载权重，单并发下还要排队，
/// 沿用 180s 会让"能跑但慢"的本地模型频繁超时。
const LOCAL_REQUEST_TIMEOUT_SECS: u64 = 600;

/// OpenAI 兼容 chat completions 客户端
#[derive(Clone)]
pub struct OpenAiProvider {
    pub config: ProviderConfig,
    client: reqwest::Client,
    /// 本地推理服务专用：超时放宽（见 LOCAL_REQUEST_TIMEOUT_SECS）
    local_client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(config: ProviderConfig) -> Self {
        // bypass_proxy：本地推理服务**绝不走代理**。
        // reqwest 默认会读 HTTP_PROXY / HTTPS_PROXY 环境变量（Clash、公司代理都会设），
        // 于是连 `http://127.0.0.1:11434` 的请求也被代理接走 —— 本地模型莫名其妙连不上，
        // 实测表现是 hyper 的 IncompleteMessage 或干脆超时。自建推理服务直连即可。
        let build = |secs: u64, bypass_proxy: bool| {
            let mut b = reqwest::Client::builder().timeout(std::time::Duration::from_secs(secs));
            if bypass_proxy {
                b = b.no_proxy();
            }
            b.build().expect("failed to build http client")
        };
        Self {
            config,
            client: build(REQUEST_TIMEOUT_SECS, false),
            local_client: build(LOCAL_REQUEST_TIMEOUT_SECS, true),
        }
    }

    /// 按目标选 client：本地推理放宽超时
    fn base_client(&self) -> reqwest::Client {
        if self.config.is_local() {
            self.local_client.clone()
        } else {
            self.client.clone()
        }
    }

    /// 附加鉴权头：**Key 非空才发**。
    /// 本地服务默认免鉴权；Ollama 的 OpenAI 兼容层虽然"要求" api_key，
    /// 但服务端会忽略它 —— 我们直接不发，比塞一个假串干净。
    fn with_auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let key = self.config.api_key.trim();
        if key.is_empty() {
            rb
        } else {
            rb.bearer_auth(key)
        }
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
            self.base_client()
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
        // 本地推理服务允许空 Key；云端服务必须有 Key
        self.config.ensure_key()?;
        let (base_url, model) = self.config.resolve_endpoint();
        // 本地预设不带默认模型（模型由用户 `ollama list` / `--alias` 决定）：
        // 这里给出明确提示，比发一个空 model 让服务端报 400 更好定位
        if model.trim().is_empty() {
            return Err(TranslateError::MissingModel);
        }
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
        let send_client = self.base_client();

        let resp = self
            .with_auth(send_client.post(&url))
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
        self.config.ensure_key()?;
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
        let send_client = self.base_client();

        let resp = self.with_auth(send_client.get(&url)).send().await?;
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
        self.config.ensure_key()?;
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
        let send_client = self.base_client();

        let resp = self
            .with_auth(send_client.post(&url))
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

    /// 本地档：预设地址正确、允许空 Key、允许改端口（改到非本机则不再算本地）
    #[test]
    fn local_providers_allow_empty_key_and_port_override() {
        let ollama = ProviderConfig {
            provider: "ollama".into(),
            ..Default::default()
        };
        assert_eq!(ollama.resolve_endpoint().0, "http://localhost:11434/v1");
        assert!(ollama.is_local());
        assert!(
            ollama.ensure_key().is_ok(),
            "本地档空 Key 必须放行（服务端根本不校验）"
        );

        // 局域网部署：preset 档也要认用户填的 base_url，且**仍按本地处理** ——
        // 自己家另一台机器上的 Ollama 同样不校验 Key
        let lan = ProviderConfig {
            provider: "ollama".into(),
            base_url: Some("http://192.168.1.9:11435/v1".into()),
            model: Some("qwen2.5:7b".into()),
            ..Default::default()
        };
        assert_eq!(
            lan.resolve_endpoint().0,
            "http://192.168.1.9:11435/v1",
            "本地档应允许覆盖 base_url"
        );
        assert!(lan.is_local(), "本地档指向局域网仍算本地");
        assert!(lan.ensure_key().is_ok(), "本地档不应因空 Key 被拦");

        // 自定义端点没有身份可依，只看地址：非本机就必须给 Key
        let custom_lan = ProviderConfig {
            provider: "custom".into(),
            base_url: Some("http://192.168.1.9:11434/v1".into()),
            model: Some("qwen2.5:7b".into()),
            ..Default::default()
        };
        assert!(!custom_lan.is_local(), "自定义端点指向非本机时不算本地");
        assert!(custom_lan.ensure_key().is_err(), "非本机端点仍需 Key");

        let llama = ProviderConfig {
            provider: "llamacpp".into(),
            ..Default::default()
        };
        assert_eq!(llama.resolve_endpoint().0, "http://127.0.0.1:8080/v1");
        assert!(llama.is_local());

        // 云端档不受影响
        let cloud = ProviderConfig {
            provider: "deepseek".into(),
            base_url: Some("http://localhost:11434/v1".into()),
            ..Default::default()
        };
        assert_eq!(
            cloud.resolve_endpoint().0,
            "https://api.deepseek.com/v1",
            "云端档不接受 base_url 覆盖"
        );
        assert!(!cloud.is_local());
        assert!(cloud.ensure_key().is_err(), "云端档空 Key 必须报错");
    }

    /// 回环地址识别：只认真实回环，域名里带 localhost 的不算
    #[test]
    fn detects_loopback_base_url_only() {
        for url in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:8080/v1",
            "http://[::1]:8080/v1",
            "localhost:1234/v1",
            "http://127.0.0.1:11434/v1?x=1",
            "http://user:pass@127.0.0.1:8080/v1",
        ] {
            assert!(is_local_url(url), "{url} 应识别为本地");
        }
        for url in [
            "https://api.deepseek.com/v1",
            "https://open.bigmodel.cn/api/paas/v4",
            "http://localhost.evil.com/v1",
            "http://127.0.0.1.evil.com/v1",
            "",
        ] {
            assert!(!is_local_url(url), "{url} 不应识别为本地");
        }
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

    /// 起一个只接受一次连接、回固定 chat completions 响应的回环服务。
    /// 返回 (端口, 线程句柄) —— 线程结束时 yield 出**收到的原始请求文本**，
    /// 断言直接作用在真实的 HTTP 报文上，而不是我们自己的判据函数上。
    fn one_shot_server() -> (u16, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定回环端口");
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("接受连接");
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 2048];
            // 读满请求头即可（断言只针对头部）
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match sock.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let body = r#"{"choices":[{"message":{"content":"ok"}}]}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes());
            let _ = sock.flush();
            String::from_utf8_lossy(&buf).to_string()
        });
        (port, handle)
    }

    /// 指向回环的 custom 配置（走 base_url 分支，等价于本地档）
    fn loopback_cfg(port: u16, key: &str) -> ProviderConfig {
        ProviderConfig {
            provider: "custom".into(),
            api_key: key.into(),
            base_url: Some(format!("http://127.0.0.1:{port}/v1")),
            model: Some("test-model".into()),
            ..Default::default()
        }
    }

    /// 本地档空 Key：请求必须发得出去，且**不带** Authorization 头。
    ///
    /// 为什么不只测 `is_local()`：判据对 ≠ 请求干净 —— Key 校验放行与请求头
    /// 拼装是两处代码，任一处回退都会让本地服务收到一个多余的
    /// `Authorization: Bearer`（llama.cpp 配了 --api-key 时直接 401，
    /// 症状是"明明没填 Key 却鉴权失败"）。
    #[tokio::test]
    async fn local_request_carries_no_authorization_header() {
        let (port, server) = one_shot_server();
        let out = OpenAiProvider::new(loopback_cfg(port, ""))
            .chat("system", "user", "translate")
            .await
            .expect("本地档空 Key 必须能正常发请求");
        assert_eq!(out, "ok");

        let req = server.join().expect("服务端线程");
        assert!(
            !req.to_lowercase().contains("authorization"),
            "本地档不得发送 Authorization 头，实际请求：\n{req}"
        );
        assert!(
            req.starts_with("POST /v1/chat/completions"),
            "路径应指向 /v1/chat/completions，实际请求：\n{req}"
        );
    }

    /// 反向确认：填了 Key 就一定带 Authorization —— 防「把鉴权整个拆掉」式回归
    #[tokio::test]
    async fn explicit_key_still_sends_authorization_header() {
        let (port, server) = one_shot_server();
        let out = OpenAiProvider::new(loopback_cfg(port, "sk-test-key"))
            .chat("system", "user", "translate")
            .await
            .expect("带 Key 的请求应正常");
        assert_eq!(out, "ok");

        let req = server.join().expect("服务端线程");
        assert!(
            req.to_lowercase()
                .contains("authorization: bearer sk-test-key"),
            "填了 Key 就必须带 Authorization 头，实际请求：\n{req}"
        );
    }
}
