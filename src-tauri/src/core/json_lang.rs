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
pub fn parse_json_lang(text: &str) -> Result<Vec<(String, String)>, JsonLangError> {
    let value: Value = serde_json::from_str(text)?;
    let mut entries = Vec::new();
    collect_strings(&value, "", &mut entries);
    Ok(entries)
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
