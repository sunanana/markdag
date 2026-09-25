// markdag の中核 (純粋な Rust)。Markdown の解析 (parse)、frontmatter とグラフの組み立て (model)、配置 (layout) と、
// それらが共有する型と JSON の契約 (types)、単体 HTML のページの組み立て (standalone) を持つ。DOM も JS も知らず、wasm とネイティブの両方から同じように呼ばれる。
#![forbid(unsafe_code)]

pub mod layout;
pub mod limits;
pub mod model;
pub mod parse;
pub mod standalone;
pub mod types;

/// crate の版。境界の疎通の確認と CLI の --version に使う
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
