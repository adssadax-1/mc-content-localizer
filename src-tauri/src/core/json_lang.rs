use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum JsonLangError {
    #[error("JSON 解析失败: {0}")]
    Parse(#[from] serde_json::Error),
}

/// 解析 1.13+ 的语言 JSON 文件。
///
/// 标准格式是扁平的 { "key": "value" }，
/// 但对嵌套结构做容错处理：递归收集字符串叶子，key 用 "." 连接。
/// 同时兼容 JSONC（剥离 // 与 /* */ 注释，部分模组如 Carpet 使用）。
pub fn parse_json_lang(text: &str) -> Result<Vec<(String, String)>, JsonLangError> {
    let cleaned = strip_json_comments(text);
    let value: Value = serde_json::from_str(&cleaned)?;
    let mut entries = Vec::new();
    collect_strings(&value, "", &mut entries);
    Ok(entries)
}

/// 剥离 JSON 中的注释（// 行注释与 /* */ 块注释），忽略字符串内的内容。
fn strip_json_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    let mut in_block = false;
    while i < chars.len() {
        let c = chars[i];
        if in_block {
            if c == '*' && i + 1 < chars.len() && chars[i + 1] == '/' {
                in_block = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        // 非字符串状态
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ',' {
            // 跳过尾逗号：后面（忽略空白）紧跟 } 或 ]
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        if c == '/' && i + 1 < chars.len() {
            match chars[i + 1] {
                '/' => {
                    // 行注释：跳过到换行
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                    continue;
                }
                '*' => {
                    in_block = true;
                    i += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn collect_strings(value: &Value, prefix: &str, out: &mut Vec<(String, String)>) {
    match value {
        Value::String(s) => {
            let key = if prefix.is_empty() {
                "_".to_string()
            } else {
                prefix.to_string()
            };
            out.push((key, s.clone()));
        }
        Value::Object(map) => {
            for (k, v) in map {
                let key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                collect_strings(v, &key, out);
            }
        }
        _ => {}
    }
}

/// 序列化：仅接受扁平 { key: value }；key 与 value 均视为字符串
pub fn encode_json_lang(entries: &[(String, String)]) -> Result<String, JsonLangError> {
    let mut map = serde_json::Map::new();
    for (k, v) in entries {
        map.insert(k.clone(), Value::String(v.clone()));
    }
    let value = Value::Object(map);
    Ok(serde_json::to_string_pretty(&value)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flat_json() {
        let text = r#"{"item.sword.name":"Diamond Sword","item.sword.desc":"Shiny"}"#;
        let entries = parse_json_lang(text).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], ("item.sword.name".to_string(), "Diamond Sword".to_string()));
    }

    #[test]
    fn parses_nested_json() {
        let text = r#"{"a":{"b":"nested"},"c":"plain"}"#;
        let entries = parse_json_lang(text).unwrap();
        assert_eq!(entries[0], ("a.b".to_string(), "nested".to_string()));
        assert_eq!(entries[1], ("c".to_string(), "plain".to_string()));
    }

    #[test]
    fn parses_jsonc_with_comments() {
        let text = "{\n  // TODO\n  /* block */\n  \"a\": \"hello\",\n  \"b\": \"http://example.com/x\",\n}";
        let entries = parse_json_lang(text).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].1, "hello");
        // 字符串内的 // 不应被剥离
        assert_eq!(entries[1].1, "http://example.com/x");
    }

    #[test]
    fn roundtrip() {
        let entries = vec![
            ("item.a.name".to_string(), "甲".to_string()),
            ("item.a.desc".to_string(), "带 %s 的描述".to_string()),
        ];
        let text = encode_json_lang(&entries).unwrap();
        let reparsed = parse_json_lang(&text).unwrap();
        assert_eq!(reparsed, entries);
    }
}
