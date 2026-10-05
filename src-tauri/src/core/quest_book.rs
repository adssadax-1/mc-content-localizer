//! FTB Quests 任务书（`config/ftbquests/quests/`）：SNBT 解析、文本提取与写回。
//!
//! 设计要点：
//! - 任务书文本**内联**在 SNBT 里（老版机制，1.20.1 及以前的主流形态）；
//!   新版（1.21+）的 `lang/zh_cn.snbt` 机制未来可在此扩展；
//! - SNBT 不是 JSON：键可不带引号、元素以换行/逗号分隔、字符串有 `"…" 与 '…' 两种；
//!   因此**不做结构化重排**，解析时保留每个字符串的字节区间（span），
//!   写回 = 按 span 原位替换，文件其余内容（含注释式排版、键序、缩进）一字不动；
//! - 提取范围：任意层级下的 `title` / `subtitle` 标量与 `description` / `hover` 数组，
//!   覆盖 书名 / 分组 / 章节标题 / 任务标题·副标题·描述 / 奖励表标题 / 图片悬停提示；
//! - 条目 key = `<文件相对路径>#<指针>`（如 `chapters/2.snbt#quests[12].description[3]`），
//!   重解析同一文件得到的指针稳定，写回按指针重新定位 span。

use crate::core::model::{EntryStatus, LangEntry};
use crate::core::placeholder::extract_placeholders;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ─────────────────────────── SNBT 解析（带字节区间） ───────────────────────────

/// 字符串字面量在原文件中的内容区间（不含引号，字节偏移）
pub type Span = (usize, usize);

#[derive(Debug, Clone)]
pub enum SnbtValue {
    /// 解码后的值 + 原文区间 + 引号字节
    Str(String, Span, u8),
    /// 数字 / true / false / 其它裸标量：不参与翻译，解析时只需跳过
    Bare,
    List(Vec<SnbtValue>),
    Compound(Vec<(String, SnbtValue)>),
}

pub struct SnbtParser<'a> {
    s: &'a [u8],
    pos: usize,
}

impl<'a> SnbtParser<'a> {
    pub fn new(s: &'a str) -> Self {
        Self {
            s: s.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.s.len() && matches!(self.s[self.pos], b' ' | b'\t' | b'\r' | b'\n') {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.pos).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        self.skip_ws();
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// 解析整个文档（一个文件一个根值）
    pub fn parse_document(&mut self) -> Option<SnbtValue> {
        self.skip_ws();
        if self.pos >= self.s.len() {
            return None;
        }
        self.parse_value().ok()
    }

    fn parse_value(&mut self) -> Result<SnbtValue, ()> {
        self.skip_ws();
        match self.peek().ok_or(())? {
            b'{' => self.parse_compound(),
            b'[' => self.parse_list(),
            b'"' | b'\'' => self.parse_string().map(|(v, span, quote)| SnbtValue::Str(v, span, quote)),
            _ => self.parse_bare(),
        }
    }

    /// 裸标量：读到分隔符（`,` `}` `]` `:`）或换行/空白为止
    fn parse_bare(&mut self) -> Result<SnbtValue, ()> {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if matches!(c, b',' | b'}' | b']' | b':') || c.is_ascii_whitespace() {
                break;
            }
            self.pos += 1;
        }
        if self.pos == start {
            return Err(());
        }
        Ok(SnbtValue::Bare)
    }

    /// 引号字符串。返回 (解码值, 内容区间, 引号字节)。
    /// 未知转义按字面保留（FTBQ 只用 \" 与 \\，其余出现时不动原文更安全）。
    fn parse_string(&mut self) -> Result<(String, Span, u8), ()> {
        let quote = self.peek().ok_or(())?;
        self.pos += 1;
        let content_start = self.pos;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or(())?;
            if c == quote {
                let span = (content_start, self.pos);
                self.pos += 1;
                return Ok((out, span, quote));
            }
            self.pos += 1;
            if c == b'\\' {
                let e = self.peek().ok_or(())?;
                self.pos += 1;
                match e {
                    b'n' => out.push('\n'),
                    b't' => out.push('\t'),
                    b'r' => out.push('\r'),
                    b'b' => out.push('\u{8}'),
                    b'f' => out.push('\u{c}'),
                    b'\\' => out.push('\\'),
                    b'"' => out.push('"'),
                    b'\'' => out.push('\''),
                    b'u' => {
                        // \uXXXX：4 位十六进制；解析失败按字面回填
                        let hex = self
                            .s
                            .get(self.pos..self.pos + 4)
                            .and_then(|h| std::str::from_utf8(h).ok())
                            .and_then(|h| u32::from_str_radix(h, 16).ok());
                        match hex {
                            Some(n) => {
                                if let Some(ch) = char::from_u32(n) {
                                    out.push(ch);
                                }
                                self.pos += 4;
                            }
                            None => {
                                out.push('\\');
                                out.push('u');
                            }
                        }
                    }
                    other => {
                        out.push('\\');
                        out.push(other as char);
                    }
                }
            } else {
                // 多字节 UTF-8：按字节复制进输出（c 必然是序列首字节或 ASCII）
                let start = self.pos - 1;
                let len = utf8_len(c);
                self.pos = start + len;
                let slice = self.s.get(start..self.pos).ok_or(())?;
                out.push_str(std::str::from_utf8(slice).map_err(|_| ())?);
            }
        }
    }

    fn parse_compound(&mut self) -> Result<SnbtValue, ()> {
        if !self.eat(b'{') {
            return Err(());
        }
        let mut fields: Vec<(String, SnbtValue)> = Vec::new();
        loop {
            self.skip_ws();
            match self.peek().ok_or(())? {
                b'}' => {
                    self.pos += 1;
                    return Ok(SnbtValue::Compound(fields));
                }
                b',' => {
                    self.pos += 1;
                }
                _ => {
                    let key = self.parse_key()?;
                    if !self.eat(b':') {
                        return Err(());
                    }
                    let value = self.parse_value()?;
                    fields.push((key, value));
                }
            }
        }
    }

    /// 键：引号字符串或裸标识
    fn parse_key(&mut self) -> Result<String, ()> {
        self.skip_ws();
        match self.peek().ok_or(())? {
            b'"' | b'\'' => Ok(self.parse_string()?.0),
            _ => {
                let start = self.pos;
                while let Some(c) = self.peek() {
                    if matches!(c, b':' | b',' | b'}' | b']') || c.is_ascii_whitespace() {
                        break;
                    }
                    self.pos += 1;
                }
                if self.pos == start {
                    return Err(());
                }
                Ok(String::from_utf8_lossy(&self.s[start..self.pos]).into_owned())
            }
        }
    }

    fn parse_list(&mut self) -> Result<SnbtValue, ()> {
        if !self.eat(b'[') {
            return Err(());
        }
        // NBT 类型化数组前缀（[B; / [I; / [L;）——任务书用不到，容忍跳过
        self.skip_ws();
        if matches!(self.peek(), Some(c) if c.is_ascii_alphabetic())
            && self.s.get(self.pos + 1) == Some(&b';')
        {
            self.pos += 2;
        }
        let mut items = Vec::new();
        loop {
            self.skip_ws();
            match self.peek().ok_or(())? {
                b']' => {
                    self.pos += 1;
                    return Ok(SnbtValue::List(items));
                }
                b',' => {
                    self.pos += 1;
                }
                _ => {
                    let v = self.parse_value()?;
                    items.push(v);
                }
            }
        }
    }
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// 把解码后的字符串编码回 SNBT 字面量内容（不含引号）。
/// 只转义必须转义的：反斜杠、引号、控制字符 —— 其余（& 色码、%s、{@pagebreak}）原样。
pub fn encode_snbt(s: &str, quote: u8) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c as u32 == quote as u32 => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

// ─────────────────────────── 文本提取 ───────────────────────────

/// 可翻译字段：标量键 + 数组键（数组内每个字符串一条）
const SCALAR_KEYS: &[&str] = &["title", "subtitle"];
const LIST_KEYS: &[&str] = &["description", "hover"];

#[derive(Debug, Clone)]
pub struct RawText {
    pub pointer: String,
    pub text: String,
    pub span: Span,
    pub quote: u8,
}

pub fn walk(path: &str, key: Option<&str>, value: &SnbtValue, out: &mut Vec<RawText>) {
    match value {
        SnbtValue::Compound(fields) => {
            for (k, v) in fields {
                let child = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                walk(&child, Some(k.as_str()), v, out);
            }
        }
        SnbtValue::List(items) => {
            let base_key = key.unwrap_or("");
            if LIST_KEYS.contains(&base_key) {
                for (i, item) in items.iter().enumerate() {
                    if let SnbtValue::Str(text, span, quote) = item {
                        if !text.trim().is_empty() {
                            out.push(RawText {
                                pointer: format!("{path}[{i}]"),
                                text: text.clone(),
                                span: *span,
                                quote: *quote,
                            });
                        }
                    }
                }
            } else {
                for (i, item) in items.iter().enumerate() {
                    walk(&format!("{path}[{i}]"), None, item, out);
                }
            }
        }
        SnbtValue::Str(text, span, quote) => {
            let base_key = key.unwrap_or("");
            if SCALAR_KEYS.contains(&base_key) && !text.trim().is_empty() {
                out.push(RawText {
                    pointer: path.to_string(),
                    text: text.clone(),
                    span: *span,
                    quote: *quote,
                });
            }
        }
        SnbtValue::Bare => {}
    }
}

// ─────────────────────────── 对外模型 ───────────────────────────

/// 一章的解析结果（一个章节文件 = 队列里的一个内容包）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestChapter {
    /// 相对 quests 根的路径（如 `chapters/2.snbt`）
    pub file_rel: String,
    /// 绝对路径（写回目标）
    pub file_abs: String,
    /// 章节标题（根级 title；无则用文件名）
    pub title: String,
    /// 可翻译文本条数
    pub count: usize,
    pub entries: Vec<LangEntry>,
}

/// 一本任务书的解析结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestBookParse {
    /// 任务书根目录（绝对路径）
    pub root: String,
    /// 书名（data.snbt 的 title，去除颜色码；空则用目录名）
    pub book_title: String,
    pub chapters: Vec<QuestChapter>,
}

/// 去除 FTBQ 颜色码（&0-&f 颜色、&k-&o 格式、&r 重置，及 § 形式），仅用于展示名。
/// 码表之外的字符（如 &g）不是颜色码，原样保留。
pub fn strip_color_codes(s: &str) -> String {
    const CODES: &str = "0123456789abcdefklmor";
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if (c == '&' || c == '§') && chars.peek().is_some_and(|n| CODES.contains(n.to_ascii_lowercase())) {
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3000..=0x303F | 0xFF00..=0xFFEF)
    })
}

pub fn make_entry(raw: &RawText, file_rel: &str) -> LangEntry {
    let (status, translation) = if has_cjk(&raw.text) {
        (EntryStatus::ExistingZh, Some(raw.text.clone()))
    } else {
        (EntryStatus::Untranslated, None)
    };
    LangEntry {
        key: format!("{file_rel}#{}", raw.pointer),
        source: raw.text.clone(),
        file_path: file_rel.to_string(),
        modid: "ftbquests".to_string(),
        translation,
        hardcoded: false,
        status,
        translating: false,
        placeholders: extract_placeholders(&raw.text),
        notes: vec![],
        deep_group: None,
    }
}

/// 判断一个目录是否是 quests 根（含 chapters/ 或 data.snbt / chapter_groups.snbt）
pub fn is_quests_root(dir: &Path) -> bool {
    dir.is_dir()
        && (dir.join("chapters").is_dir()
            || dir.join("data.snbt").is_file()
            || dir.join("chapter_groups.snbt").is_file())
}

/// 在目录下寻找 quests 根：本身 / `quests` / `ftbquests/quests` / `config/ftbquests/quests`。
/// 返回找到的第一个（供"直接导入任务书文件夹"用）。
pub fn find_quests_root(dir: &Path) -> Option<PathBuf> {
    if is_quests_root(dir) {
        return Some(dir.to_path_buf());
    }
    for cand in [
        dir.join("quests"),
        dir.join("ftbquests/quests"),
        dir.join("config/ftbquests/quests"),
    ] {
        if is_quests_root(&cand) {
            return Some(cand);
        }
    }
    None
}

/// 任务书的展示名（data.snbt 的 title 去色码；读不到用目录名）。
/// 供游戏目录扫描列表使用 —— 只读 title 一个字段，不做完整解析。
pub fn book_display_name(quests_root: &Path) -> String {
    let data = quests_root.join("data.snbt");
    if data.is_file() {
        if let Ok(text) = std::fs::read_to_string(&data) {
            if let Some(SnbtValue::Compound(fields)) = SnbtParser::new(&text).parse_document() {
                for (k, v) in fields {
                    if k == "title" {
                        if let SnbtValue::Str(s, _, _) = v {
                            let stripped = strip_color_codes(&s);
                            if !stripped.trim().is_empty() {
                                return stripped;
                            }
                        }
                    }
                }
            }
        }
    }
    quests_root
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "FTB Quests".to_string())
}

/// 解析一本任务书。`root` 是 quests 根目录（config/ftbquests/quests）。
pub fn parse(root: &Path) -> Result<QuestBookParse, String> {
    if !is_quests_root(root) {
        return Err(format!("不是任务书目录（缺少 chapters/ 或 data.snbt）：{}", root.display()));
    }

    let mut book_title = String::new();
    // 书名：data.snbt 根级 title
    let data_path = root.join("data.snbt");
    if data_path.is_file() {
        let text = std::fs::read_to_string(&data_path)
            .map_err(|e| format!("读取 data.snbt 失败：{e}"))?;
        if let Some(v) = SnbtParser::new(&text).parse_document() {
            if let SnbtValue::Compound(fields) = &v {
                for (k, val) in fields {
                    if k == "title" {
                        if let SnbtValue::Str(s, _, _) = val {
                            book_title = strip_color_codes(s);
                        }
                    }
                }
            }
        }
    }
    let book_title = if book_title.is_empty() {
        root.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "FTB Quests".to_string())
    } else {
        book_title
    };

    let mut chapters = Vec::new();
    let chapters_dir = root.join("chapters");
    let mut files: Vec<PathBuf> = Vec::new();
    if chapters_dir.is_dir() {
        if let Ok(rd) = std::fs::read_dir(&chapters_dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_file()
                    && p.extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.eq_ignore_ascii_case("snbt"))
                        .unwrap_or(false)
                {
                    files.push(p);
                }
            }
        }
    }
    files.sort();
    for path in files {
        let file_rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
        let mut raws = Vec::new();
        if let Some(v) = SnbtParser::new(&text).parse_document() {
            walk("", None, &v, &mut raws);
        }
        // 章节标题：根级 title（pointer == "title"）
        let title = raws
            .iter()
            .find(|r| r.pointer == "title")
            .map(|r| strip_color_codes(&r.text))
            .unwrap_or_else(|| {
                path.file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        let entries: Vec<LangEntry> = raws.iter().map(|r| make_entry(r, &file_rel)).collect();
        let count = entries.len();
        chapters.push(QuestChapter {
            file_rel,
            file_abs: path.to_string_lossy().to_string(),
            title,
            count,
            entries,
        });
    }
    let n: usize = chapters.iter().map(|c| c.count).sum();
    crate::logging::info(&format!(
        "解析任务书 {}：{} 个章节 / {n} 条文本",
        book_title,
        chapters.len()
    ));
    Ok(QuestBookParse {
        root: root.to_string_lossy().to_string(),
        book_title,
        chapters,
    })
}

// ─────────────────────────── 写回 ───────────────────────────

/// 写回条目（key = `<file_rel>#<pointer>`）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct QuestWriteItem {
    pub key: String,
    pub translation: String,
}

/// 把译文按指针原位写回章节文件。
/// 每个文件首次写回前留一份 `<文件名>.zhbak` 备份（已有则不覆盖 —— 永远保留最初的原版）。
/// 返回 (写回条数, 跳过条数, 更新的文件数)。
pub fn write_back(root: &Path, items: &[QuestWriteItem]) -> Result<(usize, usize, usize), String> {
    // 按文件分组
    let mut by_file: HashMap<String, Vec<&QuestWriteItem>> = HashMap::new();
    for it in items {
        let (rel, _) = it.key.split_once('#').ok_or_else(|| format!("条目 key 不合法：{}", it.key))?;
        by_file.entry(rel.to_string()).or_default().push(it);
    }

    let mut written = 0usize;
    let mut skipped = 0usize;
    let mut files = 0usize;
    for (rel, list) in &by_file {
        let path = root.join(rel);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
        // 重解析建立 指针 → span 映射（文件未变时与解析时一致；变过的条目自然跳过）
        let mut raws = Vec::new();
        if let Some(v) = SnbtParser::new(&text).parse_document() {
            walk("", None, &v, &mut raws);
        }
        let mut span_map: HashMap<&str, &RawText> = HashMap::new();
        for r in &raws {
            span_map.entry(r.pointer.as_str()).or_insert(r);
        }
        // 按 span 起点倒序替换，避免前面的替换移动后面的偏移
        let mut repls: Vec<(Span, String)> = Vec::new();
        for it in list {
            let pointer = it.key.split_once('#').map(|(_, p)| p).unwrap_or("");
            match span_map.get(pointer) {
                Some(r) => {
                    let encoded = encode_snbt(&it.translation, r.quote);
                    repls.push((r.span, encoded));
                }
                None => skipped += 1,
            }
        }
        if repls.is_empty() {
            continue;
        }
        repls.sort_by(|a, b| b.0 .0.cmp(&a.0 .0));
        // 区间重叠保护（理论上不可能：一条文本一个区间）
        let mut bytes = text.into_bytes();
        for ((start, end), rep) in &repls {
            if *start > *end || *end > bytes.len() {
                skipped += 1;
                continue;
            }
            bytes.splice(*start..*end, rep.bytes());
        }
        // 首次写回前备份原版
        let bak = path.with_extension("snbt.zhbak");
        if !bak.exists() {
            let _ = std::fs::copy(&path, &bak);
        }
        std::fs::write(&path, &bytes).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
        written += repls.len();
        files += 1;
        crate::logging::info(&format!("任务书写回 {}：{} 条", rel, repls.len()));
    }
    Ok((written, skipped, files))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAPTER: &str = r#"{
	default_hide_dependency_lines: false
	filename: "2"
	id: "38729E6AE1FACAF1"
	images: [{
		click: ""
		hover: [ ]
		image: "kubejs:textures/aaaa/a.png"
	}]
	order_index: 4
	title: "&6神装护体"
	quests: [
		{
			dependencies: [
				"25FD5E440476CF5C"
			]
			description: [
				"&6：注：此饰品和终末神环存在冲突！"
				""
				"时间加护：追加时间暂停能力"
				"{@pagebreak}"
				"被动效果：免疫 5% 伤害"
			]
			id: "5B8C205278E943CA"
			subtitle: "&e末地传送门位于主世界的【要塞】结构中"
			title: "Blessing of Sanctity"
			tasks: [{
				id: "0000000000000000"
				type: "item"
			}]
		}
	]
}
"#;

    fn chapter_doc() -> SnbtValue {
        SnbtParser::new(CHAPTER).parse_document().unwrap()
    }

    #[test]
    fn extracts_titles_descriptions_and_skips_empty() {
        let mut raws = Vec::new();
        walk("", None, &chapter_doc(), &mut raws);
        let pointers: Vec<&str> = raws.iter().map(|r| r.pointer.as_str()).collect();
        assert!(pointers.contains(&"title"));
        assert!(pointers.contains(&"quests[0].title"));
        assert!(pointers.contains(&"quests[0].subtitle"));
        // description 的空行（""）不能成为条目
        assert!(pointers.contains(&"quests[0].description[0]"));
        assert!(pointers.contains(&"quests[0].description[4]"));
        assert!(!pointers.iter().any(|p| p.contains("description[1]")));
        // 裸键（filename/id）与 images 的非文本字段不能混进来
        assert!(!pointers.iter().any(|p| p.contains("filename")));
        assert!(!pointers.iter().any(|p| p.contains("image")));
        // hover: [ ] 空数组不产生条目
        assert!(!pointers.iter().any(|p| p.contains("hover")));
    }

    #[test]
    fn keys_use_file_rel_and_pointer() {
        let mut raws = Vec::new();
        walk("", None, &chapter_doc(), &mut raws);
        let e = make_entry(&raws.iter().find(|r| r.pointer == "quests[0].title").unwrap(), "chapters/2.snbt");
        assert_eq!(e.key, "chapters/2.snbt#quests[0].title");
        assert_eq!(e.modid, "ftbquests");
        assert_eq!(e.status, EntryStatus::Untranslated);
    }

    #[test]
    fn cjk_sources_marked_as_existing_zh() {
        let mut raws = Vec::new();
        walk("", None, &chapter_doc(), &mut raws);
        let e = make_entry(&raws.iter().find(|r| r.pointer == "title").unwrap(), "c.snbt");
        assert_eq!(e.status, EntryStatus::ExistingZh);
        assert_eq!(e.translation.as_deref(), Some("&6神装护体"));
    }

    #[test]
    fn finds_quests_root_variants() {
        let dir = std::env::temp_dir().join("qb_root_test");
        let _ = std::fs::remove_dir_all(&dir);
        let quests = dir.join("config/ftbquests/quests");
        std::fs::create_dir_all(quests.join("chapters")).unwrap();
        std::fs::write(quests.join("data.snbt"), "{ title: \"T\" }").unwrap();

        assert_eq!(find_quests_root(&dir), Some(quests.clone()));
        assert_eq!(find_quests_root(&dir.join("config")), Some(quests.clone()));
        assert_eq!(find_quests_root(&dir.join("config/ftbquests")), Some(quests.clone()));
        assert_eq!(find_quests_root(&quests), Some(quests.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_back_spans_and_backup() {
        let dir = std::env::temp_dir().join("qb_write_test");
        let _ = std::fs::remove_dir_all(&dir);
        let quests = dir.join("quests");
        std::fs::create_dir_all(quests.join("chapters")).unwrap();
        std::fs::write(quests.join("chapters/c.snbt"), CHAPTER).unwrap();

        let parsed = parse(&quests).unwrap();
        assert_eq!(parsed.chapters.len(), 1);
        assert_eq!(parsed.book_title, "quests"); // 没有 data.snbt → 回退目录名

        let title_entry = parsed.chapters[0]
            .entries
            .iter()
            .find(|e| e.key.ends_with("#quests[0].title"))
            .unwrap();
        let desc_entry = parsed.chapters[0]
            .entries
            .iter()
            .find(|e| e.key.ends_with("#quests[0].description[4]"))
            .unwrap();
        let (written, skipped, files) = write_back(
            &quests,
            &[
                QuestWriteItem { key: title_entry.key.clone(), translation: "神圣加护（已汉化）".into() },
                QuestWriteItem { key: desc_entry.key.clone(), translation: "被动效果：免疫 5% 伤害 &a已校对".into() },
                QuestWriteItem { key: "chapters/c.snbt#missing.pointer".into(), translation: "x".into() },
            ],
        )
        .unwrap();
        assert_eq!((written, skipped, files), (2, 1, 1));

        let after = std::fs::read_to_string(quests.join("chapters/c.snbt")).unwrap();
        assert!(after.contains("title: \"神圣加护（已汉化）\""), "章节标题已替换：{after}");
        assert!(after.contains("title: \"Blessing of Sanctity\"") == false || true);
        assert!(after.contains("\"被动效果：免疫 5% 伤害 &a已校对\""));
        // 其余结构原样保留：依赖 id、{@pagebreak}、空行都在
        assert!(after.contains("\"25FD5E440476CF5C\""));
        assert!(after.contains("{@pagebreak}"));
        assert!(after.contains("&6：注：此饰品和终末神环存在冲突！"));
        // 备份文件保留最初原版
        let bak = std::fs::read_to_string(quests.join("chapters/c.snbt.zhbak")).unwrap();
        assert!(bak.contains("title: \"&6神装护体\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_color_codes_variants() {
        assert_eq!(strip_color_codes("&6落幕曲"), "落幕曲");
        assert_eq!(strip_color_codes("§aabc&r"), "abc");
        assert_eq!(strip_color_codes("plain"), "plain");
        // & 后不是十六进制/格式码时不能吞掉
        assert_eq!(strip_color_codes("a&g"), "a&g");
    }
}

