// モデルの層。frontmatter の検査、relations と groups と tags の解決、フックの宣言の読み取りを行い、
// 診断つきのグラフ (GraphModel) を組み立てる。

pub mod hooks_decl;
pub mod locator;
// 写し先の名前は manifest の表どおり (model.ts → model/model.rs)
#[allow(clippy::module_inception)]
pub mod model;
pub mod schema;
pub mod tags;
pub mod util;
