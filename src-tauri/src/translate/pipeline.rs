use serde::{Deserialize, Serialize};

use super::provider::{OpenAiProvider, TranslateError};

/// 翻译上下文：注入给模型的模组信息
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslateContext {
    pub mod_name: String,
    pub modid: String,
    pub mc_version: Option<String>,
    pub loader: String,
    /// 内容包类型：mod / shader / resourcepack（决定使用哪套提示词）
    pub pack_type: String,
    /// 用户自定义的可编辑提示词段（覆盖默认角色/规则；核心段固定不可改）
    #[serde(default)]
    pub custom_prompt: Option<String>,
    /// 用户自定义术语表（来自设置），始终合并进 prompt
    pub user_glossary: Vec<(String, String)>,
}

/// 待翻译条目（单条）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub key: String,
    pub source: String,
}

/// 翻译结果（单条）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedItem {
    pub key: String,
    pub translation: String,
    /// 占位符校验警告等
    pub notes: Vec<String>,
}

/// 提取术语表的样例条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossarySample {
    pub key: String,
    pub source: String,
}

/// 单批翻译结果：翻译成功 + 模型未返回的 key
#[derive(Debug)]
pub struct BatchResult {
    pub translated: Vec<TranslatedItem>,
    pub missing: Vec<String>,
    /// 整批响应"有内容但不可用"时的原因（走兜底抽取路径或彻底解析失败）。
    /// 供 UI 备注列说明问题出在哪，而不是笼统报"AI 未返回"。
    pub parse_issue: Option<String>,
}

/// 模组可编辑段（默认；用户可自定义覆盖，含程序注入的变量）
const EDITABLE_MOD_DEFAULT: &str = r#"你是一位资深的《我的世界》(Minecraft) Java 版模组本地化翻译专家。

下面这份英文语言文件来自《我的世界》模组「{mod_name}」（modid: {modid}），运行于 Minecraft {mc_version}（{loader} 加载器）。请将其完整翻译为简体中文。

翻译要求：
- 结合模组所处的游戏语境自然表达——物品、方块、生物、生物群系、成就、进度、GUI、音效字幕、指令等各有其语言习惯，读起来要像模组自带的中文，严禁机翻腔。
- 优先使用 Minecraft 官方中文译名与社区通用译名（见下方参考术语表）；专有名词保持全文一致。
- 同一英文词在本模组内译名必须一致。

模组信息：
- 模组名：{mod_name}
- modid：{modid}
- Minecraft 版本：{mc_version}
- 加载器：{loader}

Minecraft 官方译名参考（按语境取用）：
- 物品：Diamond 钻石 / Gold 金 / Iron 铁 / Netherite 下界合金 / Copper 铜 / Redstone 红石 / Emerald 绿宝石
- 维度：Overworld 主世界 / Nether 下界 / The End 末地 / End City 末地城 / Nether Fortress 下界要塞
- 方块：Enchanting Table 附魔台 / Anvil 铁砧 / Crafting Table 工作台 / Furnace 熔炉 / Chest 箱子 / Beacon 信标
- 生物：Zombie 僵尸 / Skeleton 骷髅 / Creeper 苦力怕 / Enderman 末影人 / Villager 村民 / Wither 凋灵
- 武器工具：Sword 剑 / Pickaxe 镐 / Axe 斧 / Shovel 锹 / Hoe 锄 / Bow 弓 / Armor 盔甲
- 通用：XP 经验 / Level 等级 / Damage 伤害 / Durability 耐久 / Cooldown 冷却 / Spawn 生成 / Enchanting 附魔"#;

const GLOSSARY_SYSTEM: &str = r#"你是《我的世界》(Minecraft) 模组本地化专家。下面是一个模组语言文件的部分条目，包含物品、方块、生物、结构、附魔、指令等专有名词。
请提取其中需要统一译名的专有名词，给出 Minecraft 官方或社区通用中文译名；没有公认译名的给出你推荐的译名。
只输出一个 JSON 对象，格式：{{"glossary":[{{"en":"英文原文","zh":"中文译名"}}]}}，不要输出任何多余内容。"#;

/// 软失败补漏时追加在 user payload 尾部的强约束。
///
/// 刻意加在 user 末尾而不是改 system：system 是 llama.cpp 前缀缓存里的"不变段"，
/// 动它会让整批 prompt 缓存失效、每批全量重算（本地档尤其致命）。
const RETRY_FORMAT_REINFORCE: &str = "\n\n注意：只输出一个 JSON 对象；第一个字符必须是 {，最后一个字符必须是 }；\
不要使用 markdown 代码块，不要输出任何解释或前后缀文字；对象的键必须与上面每条条目的 key 逐字完全一致。";

/// 单批翻译（含失败重试、软失败补漏与占位符校验）
pub async fn translate_batch(
    provider: &OpenAiProvider,
    ctx: &TranslateContext,
    glossary: &[(String, String)],
    items: &[BatchItem],
) -> Result<BatchResult, TranslateError> {
    let system = build_translate_system(ctx, glossary);
    let payload = serde_json::to_string(&items).unwrap_or_default();

    let max_retries = provider.config.max_retries();
    let mut attempt = 0;
    let mut last_err: Option<TranslateError> = None;

    loop {
        match provider.chat(&system, &payload, "translate").await {
            Ok(raw) => {
                let mut res = parse_batch_response(&raw, items);
                // 软失败：HTTP 200 但内容不可用（解析走了兜底路径，或大面积缺条目）。
                // 原先这类失败直接整批作废、一次机会都不给，用户只看到"AI 未返回该条目"。
                // 这里对**缺失条目**补发一次，并在 payload 尾部追加更强的格式约束。
                let systematic = res.parse_issue.is_some()
                    || (!items.is_empty() && res.missing.len() * 2 >= items.len());
                if systematic && !res.missing.is_empty() {
                    let retry_items: Vec<BatchItem> = items
                        .iter()
                        .filter(|i| res.missing.iter().any(|k| k == &i.key))
                        .cloned()
                        .collect();
                    let retry_payload = format!(
                        "{}{}",
                        serde_json::to_string(&retry_items).unwrap_or_default(),
                        RETRY_FORMAT_REINFORCE
                    );
                    // devtools 插桩：软失败补漏（soft=true，与网络重试区分）
                    #[cfg(feature = "devtools")]
                    crate::dev::dev_emit("dev-retry", serde_json::json!({
                        "attempt": attempt + 1,
                        "maxRetries": max_retries,
                        "is429": false,
                        "soft": true,
                        "missingCount": retry_items.len(),
                        "errorMsg": res
                            .parse_issue
                            .clone()
                            .unwrap_or_else(|| "大面积缺条目".to_string()),
                        "waitSecs": 1,
                    }));
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    match provider.chat(&system, &retry_payload, "translate").await {
                        Ok(raw2) => {
                            let res2 = parse_batch_response(&raw2, &retry_items);
                            for t in res2.translated {
                                res.missing.retain(|k| k != &t.key);
                                res.translated.push(t);
                            }
                        }
                        // 补漏本身失败不影响首次结果（首次已把原因写进 parse_issue）
                        Err(_) => {}
                    }
                }
                return Ok(res);
            }
            Err(e) => {
                if attempt >= max_retries {
                    return Err(last_err.unwrap_or(e));
                }
                let is_rate_limited = matches!(&e, TranslateError::Api { status: 429, .. });
                let err_msg = e.to_string();
                last_err = Some(e);
                attempt += 1;
                // 429（限流）退避更长：5s, 10s, 20s...；其他错误 1s, 2s, 4s...
                let wait = if is_rate_limited {
                    std::time::Duration::from_secs(5u64 << attempt)
                } else {
                    std::time::Duration::from_secs(1u64 << attempt)
                };
                // devtools 插桩：重试事件
                #[cfg(feature = "devtools")]
                crate::dev::dev_emit("dev-retry", serde_json::json!({
                    "attempt": attempt,
                    "maxRetries": max_retries,
                    "is429": is_rate_limited,
                    "errorMsg": err_msg,
                    "waitSecs": wait.as_secs(),
                }));
                #[cfg(not(feature = "devtools"))]
                let _ = err_msg;
                tokio::time::sleep(wait).await;
            }
        }
    }
}

/// 提取术语表（第一轮）：返回 (en, zh) 列表
pub async fn extract_glossary(
    provider: &OpenAiProvider,
    samples: &[GlossarySample],
) -> Result<Vec<(String, String)>, TranslateError> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    let payload = serde_json::to_string(samples).unwrap_or_default();
    let raw = provider.chat(GLOSSARY_SYSTEM, &payload, "glossary").await?;

    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
        TranslateError::Api {
            status: 0,
            body: "术语表响应不是合法 JSON".to_string(),
        }
    })?;

    let mut glossary = Vec::new();
    if let Some(arr) = value.get("glossary").and_then(|g| g.as_array()) {
        for entry in arr {
            let en = entry.get("en").and_then(|e| e.as_str()).unwrap_or("");
            let zh = entry.get("zh").and_then(|z| z.as_str()).unwrap_or("");
            if !en.is_empty() && !zh.is_empty() {
                glossary.push((en.to_string(), zh.to_string()));
            }
        }
    }
    Ok(glossary)
}

/// 从语言条目中选取术语表样例（名称类 key 优先，数量封顶）
pub fn pick_glossary_samples(entries: &[BatchItem], max: usize) -> Vec<GlossarySample> {
    let mut name_like: Vec<&BatchItem> = entries
        .iter()
        .filter(|e| {
            let k = e.key.to_ascii_lowercase();
            k.ends_with(".name") || k.contains(".item.") || k.contains(".block.")
                || k.contains(".entity.")
        })
        .collect();
    name_like.sort_by_key(|e| e.source.len());
    name_like.truncate(max);

    name_like
        .iter()
        .map(|e| GlossarySample {
            key: e.key.clone(),
            source: e.source.clone(),
        })
        .collect()
}

/// 光影包可编辑段（默认；用户可自定义覆盖）
const EDITABLE_PLUGIN_DEFAULT: &str = r#"你是一位资深的《我的世界》(Minecraft) Java 版服务器插件本地化翻译专家，任务是把服务器插件（Bukkit / Spigot / Paper / BungeeCord / Velocity 等）的配置与消息文本从英文翻译成简体中文。

翻译要求：
1. 面向服主与玩家：命令用法、报错提示、GUI 标题、聊天消息要口语、简洁、符合国内服务器习惯
2. 严格保留占位符与格式码：%player%、%s、{0}、{player}、<red>、</red> 等 MiniMessage 标签、&a/&c 等颜色码、
 换行、§ 样式码，位置与数量都不能变
3. 只翻译玩家可见文本：配置里数据库、权限节点、冷却时间等机器用途的键如有出现，保持原样不翻译
4. 服务器术语统一：spawn → 出生点，claim → 领地，kit → 礼包，rank → 权限组，guild/team → 公会/队伍，warp → 传送点，motd → 服务器标语，cooldown → 冷却
5. 命令名、权限节点、插件内部标识（如 /spawn、essentials.spawn）不翻译
6. 简洁优先：UI 文本受游戏宽度限制，中文尽量短，不添加原文没有的标点与语气词
"#;

const EDITABLE_SHADER_DEFAULT: &str = r#"你是一位资深的《我的世界》(Minecraft) 光影包（Shader Pack）本地化翻译专家，任务是把光影包的界面文本从英文翻译成简体中文。

这些文本来自光影包「{mod_name}」的 shaders.properties / shaders/lang 语言文件，是游戏内光影设置界面的文案（屏幕标题、选项名、选项说明、按钮、配置档名等）。

翻译要求：
- 结合图形设置界面的语境自然表达，要像官方汉化的光影设置一样，禁止机翻腔（例如 "Blur" 在图形语境下是"动态模糊"而不是"模糊"）。
- 图形术语使用社区通用译名并全文一致：Shader 着色器 / Profile 配置档 / Bloom 泛光 / SSAO 环境光遮蔽 / Anti-aliasing 抗锯齿 / FXAA 快速近似抗锯齿 / Motion Blur 动态模糊 / Depth of Field 景深 / Volumetric Fog 体积雾 / Volumetric Clouds 体积云 / Tone Mapping 色调映射 / Exposure 曝光 / Gamma 伽马 / Shadow 阴影 / Reflection 反射 / Refraction 折射 / Vignette 暗角 / Specular 高光 / Ambient 环境光 / Upscaling 超采样 / Render Distance 渲染距离 / Quality 质量 / Performance 性能 / Visuals 视觉 / Toggles 开关 / Utilities 工具 / Wetness 潮湿 / Hand 手持视角。
- profile. 开头的 key 是配置档（预设方案）名，意译为简洁中文（如 Potato→土豆画质、Very Low→极低、Ultra→极高）。
- 同一英文词在全文译名必须一致。

光影包信息：
- 光影包名：{mod_name}"#;

/// 资源包可编辑段（默认；用户可自定义覆盖）
const EDITABLE_RESOURCE_DEFAULT: &str = r#"你是一位《我的世界》(Minecraft) 资源包（材质包）描述翻译专家，任务是把资源包描述文本从英文翻译成简体中文。

这些文本来自资源包「{mod_name}」的 pack.mcmeta 描述（description），是资源包在游戏中选择界面显示的介绍文字。

翻译要求：
- 描述通常介绍资源包风格、适用版本、特性与作者信息，翻译要自然流畅、像官方资源包的中文描述。
- 材质/视觉风格相关词用社区通用表达或保留原词：PBR、Ray Tracing 光线追踪、Realistic 写实、Faithful 原版风格、Xray 透视、Texture 材质、Shader 着色器、Pack 资源包/材质包。

资源包信息：
- 资源包名：{mod_name}"#;

/// 核心段（系统保留，不可修改；所有类型共用，含自动注入的术语表）
const CORE_RULES_TEMPLATE: &str = r#"技术规则（必须遵守）：
- 保持所有占位符与格式码原样：%s、%1$s、%d、%f、%%、\n、\t、§ 后跟颜色/格式码（如 §a）等，绝不能增删改，也不能改变 %1$s 这类带编号占位符的顺序。
- key 本身、内部 ID、游戏指令、@ 符号、URL、文件路径一律不翻译。
- 同一英文词在全文译名必须一致，严格遵循术语表。

术语表（必须遵守，如与规则冲突以术语表为准）：
{glossary}

只输出一个 JSON 对象，键为输入的 key，值为对应译文。不要输出任何多余文字、不要使用 markdown 代码块。

待翻译条目如下（JSON 数组，每个元素含 key 与 source），请逐条翻译："#;

/// 提示词模板信息（供前端「自定义提示词」编辑器展示）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    /// 该类型的默认可编辑段（含 {mod_name} 等变量占位符）
    pub editable_default: String,
    /// 系统保留的核心段（不可修改）
    pub core_rules: String,
}

/// 获取某类型提示词模板（默认可编辑段 + 核心段）
pub fn prompt_template(pack_type: &str) -> PromptTemplate {
    let editable_default = match pack_type {
        "shader" => EDITABLE_SHADER_DEFAULT.to_string(),
        "resourcepack" => EDITABLE_RESOURCE_DEFAULT.to_string(),
        "plugin" => EDITABLE_PLUGIN_DEFAULT.to_string(),
        _ => EDITABLE_MOD_DEFAULT.to_string(),
    };
    PromptTemplate {
        editable_default,
        core_rules: CORE_RULES_TEMPLATE.to_string(),
    }
}

fn build_translate_system(ctx: &TranslateContext, glossary: &[(String, String)]) -> String {
    let mut glossary_lines: Vec<String> = ctx
        .user_glossary
        .iter()
        .map(|(en, zh)| format!("- {} -> {}", en, zh))
        .collect();
    for (en, zh) in glossary {
        glossary_lines.push(format!("- {} -> {}", en, zh));
    }
    if glossary_lines.is_empty() {
        glossary_lines.push("（无）".to_string());
    }

    // 可编辑段：用户自定义优先，否则按类型用默认；核心段固定拼接
    let default_editable = match ctx.pack_type.as_str() {
        "shader" => EDITABLE_SHADER_DEFAULT,
        "resourcepack" => EDITABLE_RESOURCE_DEFAULT,
        "plugin" => EDITABLE_PLUGIN_DEFAULT,
        _ => EDITABLE_MOD_DEFAULT,
    };
    let editable = match ctx.custom_prompt.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => default_editable,
    };
    let core = CORE_RULES_TEMPLATE.replace("{glossary}", &glossary_lines.join("\n"));
    let full = format!("{}\n\n{}", editable, core);

    full.replace("{mod_name}", &ctx.mod_name)
        .replace("{modid}", &ctx.modid)
        .replace("{mc_version}", ctx.mc_version.as_deref().unwrap_or("未知"))
        .replace("{loader}", &ctx.loader)
}

/// 归一化 key：去掉首尾空白与包裹引号、统一小写。
/// 用于容忍模型回显 key 时的大小写 / 空白 / 引号差异。
fn normalize_key(k: &str) -> String {
    k.trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_lowercase()
}

/// 剥掉 markdown 代码围栏（```json … ``` / ``` … ```）与 BOM
fn strip_code_fence(raw: &str) -> String {
    let s = raw.trim_start_matches('\u{feff}').trim();
    let Some(rest) = s.strip_prefix("```") else {
        return s.to_string();
    };
    // 围栏后可能紧跟语言标记（json / JSON），取第一个换行之后
    let body = match rest.find('\n') {
        Some(i) => &rest[i + 1..],
        None => rest,
    };
    let body = match body.rfind("```") {
        Some(i) => &body[..i],
        None => body,
    };
    body.trim().to_string()
}

/// 从文本中截取第一个**完整**的 JSON 对象。
///
/// 括号配平扫描，正确跳过字符串内部的 `{}` 与转义引号，因此能容忍
/// 前置垃圾（如 `{"json` 这种残句）与后置多余文本。
/// 扫到结尾仍未闭合（模型输出被截断）时返回 None。
fn slice_first_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for (i, b) in s.bytes().enumerate().skip(start) {
        if in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// 从 `start`（须指向 `"`）读一个 JSON 字符串字面量，返回（解码后内容, 下一个下标）。
/// 未闭合（被截断）返回 None。
fn read_json_string(s: &str, start: usize) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut out = String::new();
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                let nxt = *bytes.get(i + 1)?;
                match nxt {
                    b'n' => out.push('\n'),
                    b't' => out.push('\t'),
                    b'r' => out.push('\r'),
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    other => {
                        out.push('\\');
                        out.push(other as char);
                    }
                }
                i += 2;
            }
            b'"' => return Some((out, i + 1)),
            _ => {
                let ch = s[i..].chars().next()?;
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    None
}

/// 行级键值对回退：线性扫描 `"key" : "value"` 形式的**完整**对。
///
/// 专治模型输出被截断（未闭合）的情况 —— 把截断点之前已经写完的条目尽量救回来，
/// 而不是让整批一起作废。跳过 `key` / `source`，避免模型把输入数组原样回显时误认成翻译对。
fn scan_kv_pairs(s: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    let bytes = s.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        let Some((key, after_key)) = read_json_string(s, i) else {
            break; // 字符串都没闭合 → 后面更不可能有完整对
        };
        // 跳过空白，期望 ':'
        let mut j = after_key;
        while matches!(bytes.get(j), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            j += 1;
        }
        if bytes.get(j) != Some(&b':') {
            // 只前进 1 字节 —— 若直接跳到 after_key，会越过真正的键。
            // 例：`{"json\n{"a":"…"}` 里 `"json\n{` 是被当成"键"读走的残句，
            // 跳到它之后就会漏掉后面的 `"a"`。
            i += 1;
            continue;
        }
        j += 1;
        while matches!(bytes.get(j), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            j += 1;
        }
        let Some((value, after_val)) = read_json_string(s, j) else {
            break; // 值被截断 → 到此为止，前面的都已救回
        };
        if !matches!(key.as_str(), "key" | "source") {
            map.insert(key, serde_json::Value::String(value));
        }
        i = after_val;
    }

    map
}

/// 从模型自由文本里抽取 `{key: 译文}` 映射。
///
/// 依次尝试：严格解析 → 括号配平切片 → 行级 KV 回退。
/// 之所以不用裸 `serde_json::from_str`：小模型（尤其本地 4B）会带垃圾前缀、
/// 裹 markdown 围栏、或被截断，严格解析一旦失败就会让**整批**条目一起作废，
/// 用户侧只看到"AI 未返回该条目"，而响应里其实是有内容的。
fn extract_json_map(raw: &str) -> (serde_json::Map<String, serde_json::Value>, Option<String>) {
    let cleaned = strip_code_fence(raw);

    // A) 干净 JSON —— 正常路径
    if let Ok(serde_json::Value::Object(m)) = serde_json::from_str::<serde_json::Value>(&cleaned) {
        return (m, None);
    }

    // B) 带垃圾前缀 / 后缀（含数组包裹对象）：配平扫描切出第一个完整对象
    if let Some(obj) = slice_first_object(&cleaned) {
        let slice = if obj.len() == cleaned.len() {
            cleaned.clone()
        } else {
            obj.to_string()
        };
        if let Ok(serde_json::Value::Object(m)) = serde_json::from_str::<serde_json::Value>(&slice) {
            return (m, Some("响应含 JSON 之外的额外内容，已忽略".to_string()));
        }
    }

    // C) 输出被截断或夹杂解释文字：按行扫出所有完整键值对
    let m = scan_kv_pairs(&cleaned);
    if !m.is_empty() {
        return (
            m,
            Some("模型输出不是完整 JSON，已提取其中可用的键值对".to_string()),
        );
    }

    (
        serde_json::Map::new(),
        Some("响应内容无法解析出任何键值对".to_string()),
    )
}

/// 在模型返回的映射里找某条目的译文。
/// 三级匹配：key 精确 → 原文当 key（部分小模型直接回显原文）→ 归一化 key。
fn lookup_translation(
    map: &serde_json::Map<String, serde_json::Value>,
    item: &BatchItem,
) -> Option<String> {
    if let Some(s) = map.get(&item.key).and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if let Some(s) = map.get(&item.source).and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    let nk = normalize_key(&item.key);
    let ns = normalize_key(&item.source);
    for (k, v) in map.iter() {
        let Some(s) = v.as_str() else { continue };
        let n = normalize_key(k);
        if n == nk || n == ns {
            return Some(s.to_string());
        }
    }
    None
}

/// 解析模型返回的 {key: translation} JSON，过滤幻觉 key，并做占位符校验
fn parse_batch_response(raw: &str, items: &[BatchItem]) -> BatchResult {
    let (map, parse_issue) = extract_json_map(raw);

    let mut translated = Vec::new();
    let mut missing = Vec::new();

    for item in items {
        let Some(tr) = lookup_translation(&map, item) else {
            missing.push(item.key.clone());
            continue;
        };
        let mut notes = Vec::new();
        // 占位符校验
        let warnings = crate::core::placeholder::validate_placeholders(&item.source, &tr);
        notes.extend(warnings);
        // 空翻译/与原文相同视为异常
        if tr.trim().is_empty() {
            notes.push("AI 返回空译文".to_string());
        } else if tr == item.source {
            notes.push("译文与原文相同（可能未翻译）".to_string());
        }
        translated.push(TranslatedItem {
            key: item.key.clone(),
            translation: tr,
            notes,
        });
    }

    BatchResult {
        translated,
        missing,
        parse_issue,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with_type(pack_type: &str) -> TranslateContext {
        TranslateContext {
            mod_name: "Test".into(),
            modid: "test".into(),
            mc_version: None,
            loader: "".into(),
            pack_type: pack_type.into(),
            custom_prompt: None,
            user_glossary: vec![],
        }
    }

    #[test]
    fn plugin_prompt_mentions_placeholders() {
        let tpl = prompt_template("plugin");
        assert!(tpl.editable_default.contains("服务器插件"));
        assert!(tpl.editable_default.contains("%player%"));
    }

    #[test]
    fn picks_template_by_pack_type() {
        // 模组模板：模组语境 + 物品/方块术语
        let sys = build_translate_system(&ctx_with_type("mod"), &[]);
        assert!(sys.contains("模组"));
        assert!(sys.contains("钻石"));
        // 光影模板：图形术语 + 光影语境，不含模组物品术语
        let sys = build_translate_system(&ctx_with_type("shader"), &[]);
        assert!(sys.contains("光影包"));
        assert!(sys.contains("SSAO"));
        assert!(sys.contains("shaders.properties"));
        assert!(!sys.contains("钻石"));
        // 资源包模板：描述语境
        let sys = build_translate_system(&ctx_with_type("resourcepack"), &[]);
        assert!(sys.contains("pack.mcmeta"));
        assert!(sys.contains("资源包"));
        assert!(!sys.contains("SSAO"));
        // 未知类型回退模组模板
        let sys = build_translate_system(&ctx_with_type("unknown"), &[]);
        assert!(sys.contains("模组"));
    }

    #[test]
    fn custom_prompt_overrides_editable_section() {
        // 自定义可编辑段生效（角色被替换），核心段仍保留（占位符规则/JSON 输出）
        let mut ctx = ctx_with_type("mod");
        ctx.custom_prompt = Some("你是我的御用翻译，语气要俏皮。模组名：{mod_name}".into());
        let sys = build_translate_system(&ctx, &[]);
        assert!(sys.contains("御用翻译"));
        assert!(sys.contains("俏皮"));
        assert!(!sys.contains("模组本地化翻译专家"));
        // 核心段必须保留
        assert!(sys.contains("%s"));
        assert!(sys.contains("只输出一个 JSON 对象"));
        assert!(sys.contains("待翻译条目如下"));
        // 变量替换仍然生效
        assert!(sys.contains("Test"));
    }

    #[test]
    fn prompt_template_returns_sections() {
        let t = prompt_template("shader");
        assert!(t.editable_default.contains("光影包"));
        assert!(t.editable_default.contains("SSAO"));
        assert!(t.core_rules.contains("占位符"));
        assert!(t.core_rules.contains("{glossary}"));
        let t2 = prompt_template("mod");
        assert!(t2.editable_default.contains("钻石"));
        let t3 = prompt_template("resourcepack");
        assert!(t3.editable_default.contains("pack.mcmeta"));
    }

    #[test]
    fn parses_valid_response() {
        let items = vec![
            BatchItem { key: "a".into(), source: "Hello %s".into() },
            BatchItem { key: "b".into(), source: "Plain".into() },
        ];
        let raw = r#"{"a":"你好 %s","b":"普通文本"}"#;
        let res = parse_batch_response(raw, &items);
        assert_eq!(res.translated.len(), 2);
        assert!(res.missing.is_empty());
        assert!(res.translated[0].notes.is_empty());
    }

    #[test]
    fn filters_hallucinated_and_missing_keys() {
        let items = vec![
            BatchItem { key: "a".into(), source: "Hello" .into()},
            BatchItem { key: "b".into(), source: "World".into() },
        ];
        // 模型返回了不存在的 key "c"，且漏了 "b"
        let raw = r#"{"a":"你好","c":"幻觉"}"#;
        let res = parse_batch_response(raw, &items);
        assert_eq!(res.translated.len(), 1);
        assert_eq!(res.missing, vec!["b".to_string()]);
    }

    #[test]
    fn flags_placeholder_mismatch() {
        let items = vec![BatchItem { key: "a".into(), source: "Eat %d apples".into() }];
        let raw = r#"{"a":"吃掉 %d 个苹果 %d"}"#;
        let res = parse_batch_response(raw, &items);
        assert_eq!(res.translated.len(), 1);
        assert!(!res.translated[0].notes.is_empty());
    }

    #[test]
    fn glossary_samples_prefers_names() {
        let entries = vec![
            BatchItem { key: "gui.title".into(), source: "Menu".into() },
            BatchItem { key: "item.sword.name".into(), source: "Diamond Sword".into() },
        ];
        let samples = pick_glossary_samples(&entries, 10);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].key, "item.sword.name");
    }

    // ── 响应解析加固：小模型输出容错 ──────────────────────────────────
    // 背景：本地小模型（4B 级）常给出"有内容但不可用"的响应 —— 带垃圾前缀、
    // 裹 markdown 围栏、或被截断。旧实现一律严格解析，一失败就让整批作废。

    fn two_items() -> Vec<BatchItem> {
        vec![
            BatchItem { key: "a".into(), source: "Hello".into() },
            BatchItem { key: "b".into(), source: "World".into() },
        ]
    }

    #[test]
    fn parses_clean_json_without_issue() {
        let res = parse_batch_response(r#"{"a":"你好","b":"世界"}"#, &two_items());
        assert_eq!(res.translated.len(), 2);
        assert!(res.missing.is_empty());
        assert!(res.parse_issue.is_none(), "正常 JSON 不应报解析问题");
    }

    #[test]
    fn strips_markdown_fence() {
        let raw = "```json\n{\"a\":\"你好\",\"b\":\"世界\"}\n```";
        let res = parse_batch_response(raw, &two_items());
        assert_eq!(res.translated.len(), 2);
        assert!(res.missing.is_empty());
    }

    #[test]
    fn ignores_surrounding_prose() {
        let raw = "好的，翻译如下：\n{\"a\":\"你好\",\"b\":\"世界\"}\n希望有帮助！";
        let res = parse_batch_response(raw, &two_items());
        assert_eq!(res.translated.len(), 2);
        assert!(res.parse_issue.is_some(), "切对象属于兜底路径，应给出原因");
    }

    /// 截图里那条响应的形态：`{"json` 残句 + 换行 + 真对象被截断（无收尾 `}`）
    #[test]
    fn recovers_from_junk_prefix_and_truncation() {
        let raw = "{\"json\n{\"a\":\"你好\",\n\"b\":\"世界\"";
        let res = parse_batch_response(raw, &two_items());
        assert_eq!(res.translated.len(), 2, "两个条目都该从截断输出里救回");
        assert!(res.missing.is_empty());
        assert!(res.parse_issue.is_some());
    }

    /// 截断发生在最后一条中间：前面的条目必须保住，不能整批陪葬
    #[test]
    fn truncation_keeps_complete_pairs() {
        let raw = "{\"a\":\"你好\",\"b\":";
        let res = parse_batch_response(raw, &two_items());
        assert_eq!(res.translated.len(), 1);
        assert_eq!(res.missing, vec!["b".to_string()]);
        assert!(res.parse_issue.is_some());
    }

    /// 括号配平必须跳过字符串内部的 `{}`，否则会把对象切在半路
    #[test]
    fn brace_scan_skips_braces_inside_strings() {
        let raw = r#"结果：{"a":"花括号 { 与 } 都在值里","b":"世界"}"#;
        let res = parse_batch_response(raw, &two_items());
        assert_eq!(res.translated.len(), 2);
        assert_eq!(res.translated[0].translation, "花括号 { 与 } 都在值里");
    }

    /// 部分小模型不回显 key，直接拿英文原文当键
    #[test]
    fn matches_by_source_text() {
        let raw = r#"{"Hello":"你好","World":"世界"}"#;
        let res = parse_batch_response(raw, &two_items());
        assert_eq!(res.translated.len(), 2);
        assert!(res.missing.is_empty());
    }

    /// 大小写 / 空白差异不应导致漏条
    #[test]
    fn matches_normalized_keys() {
        let raw = r#"{" A ":"你好","B":"世界"}"#;
        let res = parse_batch_response(raw, &two_items());
        assert_eq!(res.translated.len(), 2);
        assert!(res.missing.is_empty());
    }

    /// 模型把输入数组原样回显：不得把 `key` / `source` 字段当成译文
    #[test]
    fn ignores_echoed_input_fields() {
        let raw = r#"[{"key":"a","source":"Hello"},{"key":"b","source":"World"}]"#;
        let res = parse_batch_response(raw, &two_items());
        assert!(res.translated.is_empty(), "回显输入不应被当成译文");
        assert_eq!(res.missing.len(), 2);
    }

    /// 彻底无法解析时也要给出原因，而不是静默整批作废
    #[test]
    fn reports_issue_when_unparsable() {
        let res = parse_batch_response("抱歉，我无法完成这个请求。", &two_items());
        assert!(res.translated.is_empty());
        assert_eq!(res.missing.len(), 2);
        assert!(res.parse_issue.is_some());
    }

    /// 软失败补漏：首次响应"有内容但不可用"（截断 JSON）时，必须自动补发一次把缺失条目补回。
    ///
    /// 这是旧实现最致命的一环 —— HTTP 200 但内容不可用属于**成功分支**，
    /// 重试只挂在 Err 分支上，于是整批直接作废、一次机会都不给。
    /// 用真实回环服务验证：脚本化两次响应，第 1 次截断、第 2 次完整。
    #[tokio::test]
    async fn retry_recovers_items_from_unusable_response() {
        use crate::translate::provider::ProviderConfig;
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定回环端口");
        let port = listener.local_addr().unwrap().port();

        let server = std::thread::spawn(move || {
            let mut served = 0usize;
            // 第 1 次：截断（模拟小模型跑飞）；第 2 次：完整
            for payload in [r#"{"a":"你好","b":"#, r#"{"a":"你好","b":"世界"}"#] {
                let (mut sock, _) = listener.accept().expect("接受连接");
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                // 读满请求头即可（本测试不断言报文内容）
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let body = serde_json::json!({
                    "choices": [{"message": {"content": payload}}]
                })
                .to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes());
                let _ = sock.flush();
                served += 1;
            }
            served
        });

        let cfg = ProviderConfig {
            provider: "custom".into(),
            api_key: String::new(),
            model: Some("test-model".into()),
            base_url: Some(format!("http://127.0.0.1:{port}/v1")),
            ..Default::default()
        };
        let provider = OpenAiProvider::new(cfg);
        let items = two_items();
        let res = translate_batch(&provider, &ctx_with_type("mod"), &[], &items)
            .await
            .expect("补漏后应拿到结果");

        // 先断结果，再 join —— 万一补漏没触发，服务端线程会阻塞在第二次 accept，
        // 此时我们已在上面失败，不必再等它。
        assert_eq!(res.translated.len(), 2, "截断输出丢掉的那条应被补漏救回");
        assert!(res.missing.is_empty(), "补漏后不应还有缺失条目");
        assert_eq!(server.join().expect("服务端线程"), 2, "应恰好补发一次请求");
    }
}
