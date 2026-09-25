// 配置の層。折りたたみを反映した射影、木の配置 (flextree の移植)、グループの枠 (frames) と、
// それらを繰り返して座標を確定する流れを持つ。

pub mod flextree;
pub mod frames;
// 写し先の名前は manifest の表どおり (layout.ts → layout/layout.rs)
#[allow(clippy::module_inception)]
pub mod layout;
pub mod pipeline;
pub mod project;
