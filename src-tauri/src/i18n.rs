// Lookup into the table generated from src/shared/i18n.ts (pnpm gen:rust-i18n).
use crate::i18n_table::TABLE;

pub fn tr(language: &str, key: &str) -> &'static str {
    let column = match language {
        "en" => 1,
        "ja" => 2,
        "ko" => 3,
        _ => 0,
    };
    TABLE
        .binary_search_by(|(candidate, _)| candidate.cmp(&key))
        .map_or("", |index| TABLE[index].1[column])
}

/// Replaces `{name}` placeholders, like the TypeScript `t(lang, key, params)`.
pub fn fill(template: &str, params: &[(&str, &str)]) -> String {
    params
        .iter()
        .fold(template.to_string(), |text, (name, value)| text.replace(&format!("{{{name}}}"), value))
}
