// crate が include_str! で同梱する frontmatter.schema.json の写しが、原本 (src/model/) とバイト単位で同じことを守る。
// 写しは手で置く (RULEBOOK 1 章の panic の行、A-087 の (b))。原本は crate の外にあるので、読むテストは tests/ に置く (4 章)。
#[test]
fn schema_copy_matches_original() {
    let copy = include_str!("../src/model/frontmatter.schema.json");
    let original = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src/model/frontmatter.schema.json"
    ))
    .expect("src/model/frontmatter.schema.json を読む");
    assert_eq!(
        copy, original,
        "crates/markdag-core/src/model/frontmatter.schema.json を src/model/ から写し直す"
    );
}
