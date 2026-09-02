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

/// 单批翻译（含失败重试与占位符校验）
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
                return Ok(parse_batch_response(&raw, items));
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

/// 解析模型返回的 {key: translation} JSON，过滤幻觉 key，并做占位符校验
fn parse_batch_response(raw: &str, items: &[BatchItem]) -> BatchResult {
    let mut translated = Vec::new();
    let mut missing = Vec::new();

    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => {
            // 模型输出非法 JSON：整批视为缺失
            return BatchResult {
                translated,
                missing: items.iter().map(|i| i.key.clone()).collect(),
            };
        }
    };

    let Some(map) = value.as_object() else {
        return BatchResult {
            translated,
            missing: items.iter().map(|i| i.key.clone()).collect(),
        };
    };

    for item in items {
        let Some(tr) = map.get(&item.key).and_then(|v| v.as_str()) else {
            missing.push(item.key.clone());
            continue;
        };
        let tr = tr.to_string();
        let mut notes = Vec::new();
        // 占位符校验
        let warnings =
            crate::core::placeholder::validate_placeholders(&item.source, &tr);
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

    BatchResult { translated, missing }
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
}
