use regex::Regex;
use std::sync::LazyLock;

/// 占位符模式：
/// - %s / %d / %f / %% （无索引）
/// - %1$s / %2$d （显式索引，顺序不能变）
/// - \n / \t （转义换行、制表）
/// - § 后跟颜色/格式码（Minecraft 样式码）
static PLACEHOLDER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"%\d*\$?[a-zA-Z%]|\\[nt]|§[0-9a-fk-or]").unwrap()
});

/// 从文本中提取占位符 token（保持出现顺序）
pub fn extract_placeholders(text: &str) -> Vec<String> {
    PLACEHOLDER_RE
        .find_iter(text)
        .map(|m| m.as_str().to_string())
        .collect()
}

/// 校验译文占位符是否与原文一致。
/// 返回警告列表（空 = 通过）。
///
/// 规则：
/// - 显式索引占位符（%1$s）必须按原顺序一一对应，不允许换序或丢失
/// - 无索引占位符（%s、%d）数量必须一致
/// - \n、\t、§颜色码数量必须一致
pub fn validate_placeholders(source: &str, translation: &str) -> Vec<String> {
    let mut warnings = Vec::new();

    let src_tokens = extract_placeholders(source);
    let tr_tokens = extract_placeholders(translation);

    // 显式索引占位符：按顺序比对
    let src_indexed: Vec<&String> = src_tokens
        .iter()
        .filter(|t| t.contains('$') || (t.len() > 1 && t.as_bytes()[1].is_ascii_digit()))
        .collect();
    let tr_indexed: Vec<&String> = tr_tokens
        .iter()
        .filter(|t| t.contains('$') || (t.len() > 1 && t.as_bytes()[1].is_ascii_digit()))
        .collect();

    if src_indexed != tr_indexed {
        warnings.push(format!(
            "显式索引占位符不一致：原文 {}，译文 {}",
            src_indexed
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            tr_indexed
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }

    // 无索引占位符：数量比对
    let src_plain: Vec<&String> = src_tokens
        .iter()
        .filter(|t| !t.contains('$') && !(t.len() > 1 && t.as_bytes()[1].is_ascii_digit()))
        .collect();
    let tr_plain: Vec<&String> = tr_tokens
        .iter()
        .filter(|t| !t.contains('$') && !(t.len() > 1 && t.as_bytes()[1].is_ascii_digit()))
        .collect();

    // 对无索引占位符只比类型数量（%s 对 %s），不做顺序强校验（中文语序允许调整）
    let mut src_count: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for t in src_plain.iter() {
        *src_count.entry(t.as_str()).or_insert(0) += 1;
    }
    let mut tr_count: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for t in tr_plain.iter() {
        *tr_count.entry(t.as_str()).or_insert(0) += 1;
    }
    if src_count != tr_count {
        warnings.push(format!(
            "无索引占位符数量不一致：原文 {}，译文 {}",
            format_tokens(&src_count),
            format_tokens(&tr_count)
        ));
    }

    warnings
}

fn format_tokens(map: &std::collections::HashMap<&str, usize>) -> String {
    let mut parts: Vec<String> = map
        .iter()
        .map(|(k, v)| format!("{}x{}", k, v))
        .collect();
    parts.sort();
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_placeholders() {
        let src = "You have %1$s diamonds and %2$d emeralds\\n§aNew line!";
        let tokens = extract_placeholders(src);
        assert_eq!(tokens, vec!["%1$s", "%2$d", "\\n", "§a"]);
    }

    #[test]
    fn valid_translation_passes() {
        let src = "Kill %1$s zombies with %2$s";
        let tr = "用 %1$s 击杀 %2$s 只僵尸";
        assert!(validate_placeholders(src, tr).is_empty());
    }

    #[test]
    fn index_reorder_fails() {
        let src = "A %1$s and B %2$s";
        let tr = "B %2$s 和 A %1$s"; // 顺序调换 -> 显式索引不应换序
        let warnings = validate_placeholders(src, tr);
        assert!(!warnings.is_empty());
    }

    #[test]
    fn count_mismatch_fails() {
        let src = "Eat %d apples";
        let tr = "吃掉 %d 个苹果 %d"; // 多了一个 %d
        let warnings = validate_placeholders(src, tr);
        assert!(!warnings.is_empty());
    }
}
