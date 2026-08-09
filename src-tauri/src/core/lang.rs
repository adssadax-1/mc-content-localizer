use thiserror::Error;

/// Java properties（Minecraft 1.12.2 及更早的 .lang）解析错误
#[derive(Debug, Error)]
pub enum LangError {
    #[error("无效的 unicode 转义: {0}")]
    BadUnicodeEscape(String),
}

/// 将 ISO-8859-1 字节解码并处理 \uXXXX 转义，得到 UTF-8 文本
pub fn decode_lang(bytes: &[u8]) -> Result<String, LangError> {
    // 1. ISO-8859-1: 每字节映射为一个字符
    let latin: String = bytes.iter().map(|&b| b as char).collect();
    // 2. 处理 \uXXXX 转义
    unescape_unicode(&latin)
}

/// 解析 .lang 内容，返回 (key, value) 列表（保持文件顺序）
pub fn parse_lang(bytes: &[u8]) -> Result<Vec<(String, String)>, LangError> {
    let text = decode_lang(bytes)?;
    let mut entries = Vec::new();

    // 先按原始行切分，处理续行
    let raw_lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < raw_lines.len() {
        let mut line = raw_lines[i].to_string();
        i += 1;

        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
            continue;
        }

        // 续行：以奇数个反斜杠结尾（转义符本身可能被转义 \\）
        while ends_with_continuation(&line) && i < raw_lines.len() {
            line.pop(); // 去掉续行反斜杠
            line.push_str(raw_lines[i].trim_start());
            i += 1;
        }

        // 拆分 key 与 value：第一个未转义的 =、: 或空白符
        let (raw_key, raw_value) = split_key_value(&line);
        let key = unescape_value(raw_key.trim())?;
        let value = unescape_value(raw_value.trim_start())?;
        if !key.is_empty() {
            entries.push((key, value));
        }
    }
    Ok(entries)
}

/// 将 (key, value) 列表序列化为 .lang 字节（ISO-8859-1 + \uXXXX 转义）
pub fn encode_lang(entries: &[(String, String)]) -> Vec<u8> {
    let mut out = String::new();
    for (k, v) in entries {
        out.push_str(&escape_key(k));
        out.push('=');
        out.push_str(&escape_value(v));
        out.push('\n');
    }
    // 全部 ASCII + \uXXXX 转义，所以编码安全
    out.into_bytes()
}

fn ends_with_continuation(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut count = 0;
    for &b in bytes.iter().rev() {
        if b == b'\\' {
            count += 1;
        } else {
            break;
        }
    }
    count % 2 == 1
}

/// 找到第一个未转义的分隔符（= : 或空白），返回 (key 部分, value 部分)
fn split_key_value(line: &str) -> (&str, &str) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            i += 2;
            continue;
        }
        if c == '=' || c == ':' || c.is_whitespace() {
            return (&line[..i], &line[i + 1..]);
        }
        i += 1;
    }
    (line, "")
}

/// 处理 \uXXXX 转义
fn unescape_unicode(text: &str) -> Result<String, LangError> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() && chars[i + 1] == 'u' {
            // 可能有多个 u（\uuuuXXXX）
            let mut j = i + 2;
            while j < chars.len() && chars[j] == 'u' {
                j += 1;
            }
            if j + 4 <= chars.len() {
                let hex: String = chars[j..j + 4].iter().collect();
                let cp = u32::from_str_radix(&hex, 16)
                    .map_err(|_| LangError::BadUnicodeEscape(hex.clone()))?;
                if let Some(c) = char::from_u32(cp) {
                    out.push(c);
                    i = j + 4;
                    continue;
                }
            }
            return Err(LangError::BadUnicodeEscape(chars[i..].iter().collect()));
        }
        out.push(chars[i]);
        i += 1;
    }
    Ok(out)
}

/// 值解码：\t \n \r \f \\ \: \= \# \! \ 空格
fn unescape_value(s: &str) -> Result<String, LangError> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            match chars[i + 1] {
                't' => {
                    out.push('\t');
                    i += 2;
                    continue;
                }
                'n' => {
                    out.push('\n');
                    i += 2;
                    continue;
                }
                'r' => {
                    out.push('\r');
                    i += 2;
                    continue;
                }
                'f' => {
                    out.push('\u{000C}');
                    i += 2;
                    continue;
                }
                'u' => {
                    // 已在 decode 阶段处理；此处直接吞掉 \u 后的序列
                    let mut j = i + 2;
                    while j < chars.len() && chars[j] == 'u' {
                        j += 1;
                    }
                    if j + 4 <= chars.len() {
                        let hex: String = chars[j..j + 4].iter().collect();
                        let cp = u32::from_str_radix(&hex, 16)
                            .map_err(|_| LangError::BadUnicodeEscape(hex.clone()))?;
                        if let Some(c) = char::from_u32(cp) {
                            out.push(c);
                            i = j + 4;
                            continue;
                        }
                    }
                    return Err(LangError::BadUnicodeEscape(chars[i..].iter().collect()));
                }
                other => {
                    out.push(other); // \\ \: \= \# \! \ 空格 等：去掉转义符
                    i += 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    Ok(out)
}

/// 编码 key：对分隔符/注释符/空白转义
fn escape_key(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '=' => out.push_str("\\="),
            ':' => out.push_str("\\:"),
            '#' => out.push_str("\\#"),
            '!' => out.push_str("\\!"),
            ' ' | '\t' => out.push('\\'),
            _ => push_escaped_char(&mut out, c),
        }
    }
    out
}

/// 编码 value：对特殊字符转义，非 ASCII 转 \uXXXX
fn escape_value(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '=' => out.push_str("\\="),
            ':' => out.push_str("\\:"),
            '#' => out.push_str("\\#"),
            '!' => out.push_str("\\!"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{000C}' => out.push_str("\\f"),
            _ => push_escaped_char(&mut out, c),
        }
    }
    out
}

/// 非 ASCII 字符统一 \uXXXX（.lang 文件是 ISO-8859-1，中文必须转义）
fn push_escaped_char(out: &mut String, c: char) {
    if c.is_ascii() {
        out.push(c);
    } else {
        out.push_str(&format!("\\u{:04X}", c as u32));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_legacy_lang_with_unicode() {
        let raw = b"item.sword.name=Diamond Sword\nitem.sword.desc=A \\u8f89\\u714c sword\\nBe careful!\n# comment\nempty.key=\n";
        let entries = parse_lang(raw).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0], ("item.sword.name".to_string(), "Diamond Sword".to_string()));
        assert_eq!(entries[1].0, "item.sword.desc");
        assert!(entries[1].1.contains("辉煌"));
        assert!(entries[1].1.contains('\n'));
    }

    #[test]
    fn roundtrip_chinese() {
        let entries = vec![
            ("item.sword.name".to_string(), "钻石剑".to_string()),
            ("item.sword.desc".to_string(), "一把 §a锋利§r 的剑".to_string()),
        ];
        let bytes = encode_lang(&entries);
        let reparsed = parse_lang(&bytes).unwrap();
        assert_eq!(reparsed, entries);
    }

    #[test]
    fn parses_colon_and_space_separators() {
        let raw = b"key1: value1\nkey2 value2\n";
        let entries = parse_lang(raw).unwrap();
        assert_eq!(entries[0], ("key1".to_string(), "value1".to_string()));
        assert_eq!(entries[1], ("key2".to_string(), "value2".to_string()));
    }
}
