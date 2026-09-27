// 解析の層。Markdown の原文を、行の前処理 (タスクの印、タグ、グループ、$id) と AST からのアウトラインの組み立てで
// ノードの木 (ParsedDocument) にする。
mod document;
mod html;
mod icon_marks;
mod inline_marks;
mod notes;
mod outline;
pub mod task;

pub(crate) use document::{body_icon_marks, nameless_content};
pub use document::{parse_document, parse_yaml, replace_leading_mark};
pub(crate) use icon_marks::{ICON_ATTRIBUTE, ICON_CLASS, IconMark};
pub use notes::body_diagnostics;
