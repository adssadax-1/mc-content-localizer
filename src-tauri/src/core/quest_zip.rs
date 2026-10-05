//! FTB Quests 任务书与 ZIP：检测、解析、汉化导出。
//!
//! 整合包 zip 里任务书的形态是 `…/ftbquests/quests/`（常见 `config/` 或
//! CurseForge `overrides/config/` 前缀）。检测原则：**前缀宽松、核心严格** ——
//! 任意祖先目录都容忍，但必须存在 `ftbquests/quests/chapters/*.snbt`，
//! 因此光影 / 资源包 / 普通模组 / 只有 config、assets、data 的压缩包不会误诊。

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read as _;
use std::path::Path;
use std::sync::LazyLock;

use crate::core::model::LangEntry;

use super::quest_book::{
    encode_snbt, make_entry, strip_color_codes, walk, QuestBookParse, QuestChapter, QuestWriteItem,
    SnbtParser, SnbtValue, Span,
};

/// ZIP 内检测到的一本任务书
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipQuestBook {
    /// 任务书在 ZIP 内的 quests 目录前缀（如 `config/ftbquests/quests`）
    pub prefix: String,
    pub book_title: String,
    pub chapter_count: usize,
    pub entry_count: usize,
}

/// 任务书核心结构匹配：`…/ftbquests/quests/chapters/*.snbt`
static ZIP_CHAPTER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^([^/]*?/)*ftbquests/quests/chapters/[^/]+\.snbt$").unwrap()
});

/// 从 zip 成员路径提取 quests 前缀（`…/ftbquests/quests/chapters/x.snbt` → `…/ftbquests/quests`）
fn zip_quests_prefix(entry_name: &str) -> Option<String> {
    let m = ZIP_CHAPTER_RE.captures(entry_name)?;
    let full = m.get(0).unwrap().as_str();
    let pos = full.rfind("/chapters/")?;
    Some(full[..pos].to_string())
}

fn open_archive(zip_path: &Path) -> Result<zip::ZipArchive<std::fs::File>, String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    zip::ZipArchive::new(f).map_err(|e| e.to_string())
}

/// 检测 ZIP 内的任务书（一个 zip 可能含多本，按前缀区分、互不覆盖）。
/// 检测不到 = 空列表，调用方按原有导入逻辑处理。
pub fn detect_in_zip(zip_path: &Path) -> Result<Vec<ZipQuestBook>, String> {
    let mut archive = open_archive(zip_path)?;
    let mut prefixes: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        if let Some(p) = zip_quests_prefix(entry.name()) {
            if !prefixes.contains(&p) {
                prefixes.push(p);
            }
        }
    }
    prefixes.sort();
    let mut out = Vec::new();
    for prefix in prefixes {
        let book = parse_zip_book(zip_path, &prefix)?;
        let chapters = book.chapters.len();
        let total: usize = book.chapters.iter().map(|c| c.count).sum();
        // 没有可用章节的结构不认（防误诊的最后一道闸）
        if chapters == 0 {
            continue;
        }
        out.push(ZipQuestBook {
            prefix,
            book_title: book.book_title,
            chapter_count: chapters,
            entry_count: total,
        });
    }
    Ok(out)
}

/// 解析 ZIP 内一本任务书（prefix = zip 内 quests 目录前缀）。
/// 返回的 QuestBookParse.root = prefix；chapter.file_abs = `<prefix>/<file_rel>`（zip 内路径）。
pub fn parse_zip_book(zip_path: &Path, prefix: &str) -> Result<QuestBookParse, String> {
    let mut archive = open_archive(zip_path)?;

    let mut chapter_names: Vec<String> = Vec::new();
    let mut data_name: Option<String> = None;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        if let Some(rel) = name.strip_prefix(&format!("{prefix}/")) {
            if let Some(ch) = rel.strip_prefix("chapters/") {
                if ch.to_lowercase().ends_with(".snbt") && !ch.is_empty() {
                    chapter_names.push(format!("chapters/{ch}"));
                }
            } else if rel == "data.snbt" {
                data_name = Some(name);
            }
        }
    }
    chapter_names.sort();

    let mut book_title = String::new();
    if let Some(dn) = &data_name {
        let mut entry = archive.by_name(dn).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&buf);
        if let Some(SnbtValue::Compound(fields)) = SnbtParser::new(&text).parse_document() {
            for (k, v) in fields {
                if k == "title" {
                    if let SnbtValue::Str(s, _, _) = v {
                        book_title = strip_color_codes(&s);
                    }
                }
            }
        }
    }
    let book_title = if book_title.is_empty() {
        prefix
            .split('/')
            .next_back()
            .filter(|s| !s.is_empty())
            .unwrap_or("FTB Quests")
            .to_string()
    } else {
        book_title
    };

    let mut chapters = Vec::new();
    for rel in chapter_names {
        let full = format!("{prefix}/{rel}");
        let mut entry = archive.by_name(&full).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&buf);
        let mut raws = Vec::new();
        if let Some(v) = SnbtParser::new(&text).parse_document() {
            walk("", None, &v, &mut raws);
        }
        let title = raws
            .iter()
            .find(|r| r.pointer == "title")
            .map(|r| strip_color_codes(&r.text))
            .unwrap_or_else(|| {
                rel.trim_end_matches(".snbt")
                    .rsplit('/')
                    .next()
                    .unwrap_or(&rel)
                    .to_string()
            });
        let entries: Vec<LangEntry> = raws.iter().map(|r| make_entry(r, &rel)).collect();
        let count = entries.len();
        chapters.push(QuestChapter {
            file_rel: rel,
            file_abs: full,
            title,
            count,
            entries,
        });
    }
    Ok(QuestBookParse {
        root: prefix.to_string(),
        book_title,
        chapters,
    })
}

/// 汉化任务书 zip 导出：复制原 zip，仅替换有译文的章节 SNBT 成员（其余成员原字节保留）。
/// items 的 key 形如 `<zip 内章节路径>#<指针>`（即 parse_zip_book 的 file_abs）。
/// 返回 (写回条数, 跳过条数, 更新的文件数)。
pub fn export_zip(
    zip_path: &Path,
    dest: &Path,
    items: &[QuestWriteItem],
) -> Result<(usize, usize, usize), String> {
    let mut by_member: HashMap<String, Vec<&QuestWriteItem>> = HashMap::new();
    for it in items {
        let (member, _) = it
            .key
            .split_once('#')
            .ok_or_else(|| format!("条目 key 不合法：{}", it.key))?;
        by_member
            .entry(member.to_string())
            .or_default()
            .push(it);
    }

    let mut src = open_archive(zip_path)?;
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let out_f = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut out = zip::ZipWriter::new(out_f);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);

    let mut written = 0usize;
    let mut skipped = 0usize;
    let mut files = 0usize;

    for i in 0..src.len() {
        let mut entry = src.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() {
            out.add_directory::<_, ()>(&name, options).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(list) = by_member.get(&name) {
            // 重解析建立 指针 → span 映射，按 span 起点倒序替换（其余成员原字节复制）
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(&buf).into_owned();
            let mut raws = Vec::new();
            if let Some(v) = SnbtParser::new(&text).parse_document() {
                walk("", None, &v, &mut raws);
            }
            let mut span_map: HashMap<&str, &super::quest_book::RawText> = HashMap::new();
            for r in &raws {
                span_map.entry(r.pointer.as_str()).or_insert(r);
            }
            let mut repls: Vec<(Span, String)> = Vec::new();
            for it in list {
                let pointer = it.key.split_once('#').map(|(_, p)| p).unwrap_or("");
                match span_map.get(pointer) {
                    Some(r) => repls.push((r.span, encode_snbt(&it.translation, r.quote))),
                    None => skipped += 1,
                }
            }
            if repls.is_empty() {
                out.start_file(&name, options).map_err(|e| e.to_string())?;
                std::io::Write::write_all(&mut out, &buf).map_err(|e| e.to_string())?;
                continue;
            }
            repls.sort_by(|a, b| b.0 .0.cmp(&a.0 .0));
            let mut bytes = text.into_bytes();
            for ((start, end), rep) in &repls {
                if *start > *end || *end > bytes.len() {
                    skipped += 1;
                    continue;
                }
                bytes.splice(*start..*end, rep.bytes());
            }
            out.start_file(&name, options).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut out, &bytes).map_err(|e| e.to_string())?;
            written += repls.len();
            files += 1;
            crate::logging::info(&format!("任务书 zip 写出 {name}：{} 条", repls.len()));
        } else {
            out.start_file(&name, options).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    out.finish().map_err(|e| e.to_string())?;
    Ok((written, skipped, files))
}

/// 在目录下寻找可"直接导入"的任务书根（导入路由用，与游戏目录扫描分开）：
/// 认两种浅层形态 —— 目录本身就是 quests 根，或其下的 `quests/`、`ftbquests/quests/`；
/// 以及**目录名为 `config`** 且含 `ftbquests/quests`。
/// 刻意**不**认 `<游戏目录>/config/ftbquests/quests` —— 完整游戏目录应走原有
/// 游戏目录扫描，让任务书归入所属版本分组。
pub fn find_direct_import_root(dir: &Path) -> Option<String> {
    if !dir.is_dir() {
        return None;
    }
    for cand in [dir, dir.join("quests").as_path(), dir.join("ftbquests/quests").as_path()] {
        if super::quest_book::is_quests_root(cand) {
            return Some(cand.to_string_lossy().to_string());
        }
    }
    if dir
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("config"))
        .unwrap_or(false)
    {
        let c = dir.join("ftbquests/quests");
        if super::quest_book::is_quests_root(&c) {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}
