// 配置の層。折りたたみを反映した射影、木の配置 (flextree の移植)、グループの枠 (frames)、
// 箱にした枠を 1 つの頂点として組む配置の木と、それらをつないで座標を確定する配置の流れを持つ。

pub mod flextree;
pub mod frames;
// 写し先の名前は manifest の表どおり (layout.ts → layout/layout.rs)
#[allow(clippy::module_inception)]
pub mod layout;
pub mod pipeline;
pub mod placement;
pub mod project;
