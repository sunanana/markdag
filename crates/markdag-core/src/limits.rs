// 入力の大きさの上限 (A-105 の (a)、A-156 の (b))。再帰の残る層は wasm の既定のスタック (1 MiB) で溢れない深さに収め、
// 配置の計算が終わらなくなる大きさの数を入口で弾く。上限は release の wasm で測った限界のおよそ半分にしてある。
// 上限を越えた入力は、trap や固まる代わりに「入れ子が深すぎます」などの分かる診断か誤りになる。

/// Markdown の入れ子 (リスト、引用、強調やリンクなどのインラインの入れ物) の段数の上限。
/// 越えた部分は図に出さず、nesting-too-deep の診断を出す。
/// 測定 (2026-09-25、release の wasm を Node 22 で): 入れ子のリストは 1000 段が通り 2000 段で trap、引用は 1000 が通り 2000 で trap
pub const MAX_NESTING: usize = 500;

/// frontmatter の YAML の入れ物 (写像と配列) の入れ子の段数の上限。越えた frontmatter は YAML として読めない扱いになる。
/// 境界の JSON を読む serde_json の再帰の上限 (128) より浅くして、読めた frontmatter を buildModel に渡し直せるようにする
pub const MAX_YAML_NESTING: usize = 100;

// 配置の木 (配置上の親でつないだ木) の深さには上限を置かない。flextree と枠の段の計算は明示のスタックと反復でたどり、
// 木の深さでスタックを使わない (測定 (2026-09-25、release の wasm を Node 22 で): 1 本の鎖 100000 段が 1.9 秒で通る)

/// 配置の入力の数 (ノードの幅と高さ、間隔) の絶対値の上限。これ以上の値は深さ方向の和があふれて NaN になり、
/// flextree の輪郭の走査が終わらなくなる (A-156)
pub const MAX_LAYOUT_MAGNITUDE: f64 = 1e300;

/// 入れ子の上限を越えたときの文面
pub fn too_deep_message(limit: usize) -> String {
    format!("入れ子が深すぎます (上限 {limit} 段)")
}

/// 配置の入力の数を検べる。NaN、無限大、絶対値が MAX_LAYOUT_MAGNITUDE 以上なら、what (どの値か) を添えた誤り
pub fn check_layout_number(
    value: f64,
    what: impl FnOnce() -> String,
) -> Result<(), crate::types::LayoutError> {
    if value.is_finite() && value.abs() < MAX_LAYOUT_MAGNITUDE {
        return Ok(());
    }
    Err(crate::types::LayoutError {
        message: format!(
            "配置の入力の {} が {} です。絶対値が 1e300 未満の有限の数にします",
            what(),
            crate::model::util::js_number_to_string(value)
        ),
    })
}
