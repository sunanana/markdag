// html のサブコマンドが焼き込む dist のファイル (npm run build が作る) があることを確かめる。
// ないまま include_str! の誤りになると原因が読み取りにくいので、ここで手順を添えて止める。
use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo が渡す");
    let dist = Path::new(&manifest).join("../../dist");
    let mut missing = Vec::new();
    for name in ["markdag.core.iife.js", "style.css"] {
        let path = dist.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.is_file() {
            missing.push(format!("dist/{name}"));
        }
    }
    if !missing.is_empty() {
        panic!(
            "markdag-cli は {} を焼き込みます。先にリポジトリの根で `npm run build` を実行してください (まとめて行うなら `npm run build:cli`)",
            missing.join(" と ")
        );
    }
}
