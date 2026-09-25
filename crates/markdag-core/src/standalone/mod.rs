// 単体 HTML の層。図を「単体で開ける HTML」の文字列に組み立てる (ランタイムとスタイルシートと素材の JSON を 1 枚に埋める)。
// 開いたときの組み立て (mountStandalone) は JS に残り、ここはページの文字列だけを作る。JS の包みと CLI が同じ関数を呼ぶ (A-017)
pub mod page;

pub use page::{
    StandaloneError, StandaloneOptions, StandaloneRuntime, StandaloneRuntimeOverride,
    render_standalone_page,
};
