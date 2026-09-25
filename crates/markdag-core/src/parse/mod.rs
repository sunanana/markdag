// 解析の層。Markdown の原文を、行の前処理 (タスクの印、タグ、グループ、$id) と AST からのアウトラインの組み立てで
// ノードの木 (ParsedDocument) にする。
mod document;
mod html;
mod inline_marks;
mod notes;
mod outline;
pub mod task;

pub use document::{parse_document, replace_leading_mark};
pub use notes::body_diagnostics;
