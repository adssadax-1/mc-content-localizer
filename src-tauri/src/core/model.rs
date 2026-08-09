use serde::{Deserialize, Serialize};

/// 单条语言条目的状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryStatus {
    /// 未翻译
    Untranslated,
    /// 翻译记忆库命中（CFPA 对照库，二期启用）
    TmHit,
    /// AI 翻译完成
    AiTranslated,
    /// 用户人工确认/编辑
    UserConfirmed,
    /// 占位符校验失败（需要人工处理）
    PlaceholderError,
}

/// 一条语言条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LangEntry {
    /// 语言 key，如 item.modid.sword
    pub key: String,
    /// 源语言文本（通常是英文）
    pub source: String,
    /// 来源文件相对路径，如 assets/<modid>/lang/en_us.json
    pub file_path: String,
    /// 所属 modid
    pub modid: String,
    /// 译文（未翻译为 None）
    pub translation: Option<String>,
    /// 状态
    pub status: EntryStatus,
    /// 提取出的占位符（%s、%1$s、\n、§颜色码等），用于校验
    pub placeholders: Vec<String>,
    /// 备注（占位符警告、TM 来源等）
    pub notes: Vec<String>,
}

/// 模组加载器
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Loader {
    Forge,
    Fabric,
    NeoForge,
    #[default]
    Unknown,
}

/// 语言文件格式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LangFormat {
    /// 1.12.2 及更早的 .lang（Java properties 格式）
    LegacyLang,
    /// 1.13+ 的 .json 格式
    Json,
}

/// 一个模组 jar 的解析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModFile {
    /// 原始文件名
    pub file_name: String,
    /// 模组显示名
    pub mod_name: String,
    /// modid
    pub modid: String,
    /// 模组版本
    pub version: Option<String>,
    /// 加载器
    pub loader: Loader,
    /// MC 版本提示（依赖声明中提取）
    pub mc_version: Option<String>,
    /// 语言文件格式
    pub lang_format: LangFormat,
    /// 全部语言条目
    pub entries: Vec<LangEntry>,
}
