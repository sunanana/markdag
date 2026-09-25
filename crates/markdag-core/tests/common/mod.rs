// model のテストの移植 (後半) が共有する入力の組み立て。原文 test/model.test.ts の outline、EPIC、EPIC_FRONTMATTER と、
// buildModel を呼ぶ小さな補助を写したもの。解析の層は通さず、ノードの木を直接組む。
// テストのファイルごとに使う補助が違うので、使わないものの警告を止める。
#![allow(dead_code)]

use indexmap::IndexMap;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::util::JsValue;
use markdag_core::types::{GraphModel, NodeTag, OutlineNode, SourcePosition};
use serde_json::{Value, json};

// 原文の Row: [参照用のテキスト, 親の位置 (0 始まり。ルートは None), グループ, $id, タグ]
pub struct Row<'a> {
    pub ref_text: &'a str,
    pub parent: Option<usize>,
    pub groups: Vec<&'a str>,
    pub ref_id: Option<&'a str>,
    pub tags: Vec<NodeTag>,
}

pub fn leaf(ref_text: &str, parent: Option<usize>) -> Row<'_> {
    Row {
        ref_text,
        parent,
        groups: Vec::new(),
        ref_id: None,
        tags: Vec::new(),
    }
}

pub fn row<'a>(
    ref_text: &'a str,
    parent: Option<usize>,
    groups: &[&'a str],
    ref_id: Option<&'a str>,
    tags: Vec<NodeTag>,
) -> Row<'a> {
    Row {
        ref_text,
        parent,
        groups: groups.to_vec(),
        ref_id,
        tags,
    }
}

pub fn outline(rows: Vec<Row<'_>>) -> Vec<OutlineNode> {
    let mut nodes: Vec<OutlineNode> = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        let parent = row.parent.and_then(|at| nodes.get(at));
        let node = OutlineNode {
            id: u32::try_from(index + 1).expect("ノードの数"),
            parent: parent.map(|node| node.id),
            depth: parent.map_or(0, |node| node.depth) + 1,
            html: row.ref_text.to_string(),
            ref_text: row.ref_text.to_string(),
            ref_id: row.ref_id.map(str::to_string),
            groups: row.groups.iter().map(|name| (*name).to_string()).collect(),
            tags: row.tags,
            milestone: false,
            fold_hint: 0.0,
            lines: None,
            task: None,
            details: None,
        };
        nodes.push(node);
    }
    nodes
}

// 原文の AT: 位置は本文の行だけを見分ければよいので、行ごとに同じ桁で作る
pub fn at(line: u32) -> SourcePosition {
    SourcePosition {
        line,
        column: 10,
        length: 8,
    }
}

pub fn tag(key: &str, line: u32, values: &[&str]) -> NodeTag {
    NodeTag {
        key: key.to_string(),
        values: values.iter().map(|value| (*value).to_string()).collect(),
        at: at(line),
    }
}

pub fn position(line: u32, column: u32, length: u32) -> SourcePosition {
    SourcePosition {
        line,
        column,
        length,
    }
}

// fixture の「新機能エピック」と同じ木
pub fn epic() -> Vec<OutlineNode> {
    let grouped =
        |text, parent, groups: &[&'static str]| row(text, Some(parent), groups, None, Vec::new());
    outline(vec![
        leaf("新機能エピック", None),
        leaf("仕様策定", Some(0)),
        grouped("画面開発", 1, &["frontend"]),
        leaf("一覧画面", Some(2)),
        leaf("登録画面", Some(2)),
        grouped("API開発", 1, &["backend"]),
        leaf("登録API POST /items", Some(5)),
        leaf("削除API DELETE /items/:id", Some(5)),
        leaf("一覧取得API GET /items", Some(5)),
        leaf("開発完了", Some(0)),
        leaf("リリース準備", Some(0)),
        grouped("デプロイ手順の確認", 10, &["backend"]),
        grouped("ロールバック手順の確認", 10, &["backend"]),
        grouped("受け入れテスト", 10, &["qa"]),
        leaf("リリースノート作成", Some(0)),
        leaf("リリース", Some(0)),
        grouped("効果測定", 0, &["backend", "frontend"]),
    ])
}

pub fn epic_frontmatter() -> Value {
    json!({
        "markdag": {
            "relations": {
                "join": ["仕様策定/* --> 開発完了"],
                "chain": ["開発完了 --> リリース準備 --> リリースノート作成 --> リリース --> 効果測定"],
                "depends": ["登録API --> 登録画面"],
            },
            "groups": {
                "backend": { "label": "バックエンド", "color": "#D64545", "boundary": true },
                "frontend": { "label": "フロントエンド", "color": "#3B7DD8", "boundary": true },
                "qa": { "label": "QA", "color": "#E0A100" },
            },
        },
    })
}

pub fn js(value: Value) -> JsValue {
    serde_json::from_value(value).expect("テストの frontmatter")
}

// 原文の値に undefined を含む frontmatter を組む (JSON では書けない)
pub fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect::<IndexMap<_, _>>(),
    )
}

pub fn build(nodes: &[OutlineNode], frontmatter: Value) -> GraphModel {
    build_model(nodes, &js(frontmatter), None, &ModelOptions::default())
}

pub fn build_with(nodes: &[OutlineNode], frontmatter: Value, markdown: Option<&str>) -> GraphModel {
    build_model(nodes, &js(frontmatter), markdown, &ModelOptions::default())
}

pub fn build_with_types(nodes: &[OutlineNode], frontmatter: Value, types: Value) -> GraphModel {
    let types = match js(types) {
        JsValue::Object(entries) => entries,
        other => panic!("types は写像で渡す: {other:?}"),
    };
    build_model(
        nodes,
        &js(frontmatter),
        None,
        &ModelOptions {
            types: Some(types),
            hook_refs: None,
        },
    )
}

pub fn codes(model: &GraphModel) -> Vec<&str> {
    model
        .diagnostics
        .iter()
        .map(|item| item.code.as_str())
        .collect()
}
