// 審判の harness (scripts/judge/harness.ts) が配置の前に行う入力の組み立ての写し。疑似の大きさ (pseudoSize)、
// 最初の折りたたみ (initialFold)、閉じたノードの配下を隠す (visibleIds)、layoutFor の LayoutInput。
// 配置の流れそのもの (layoutFor の繰り返し) は layout_document が持つので、ここには置かない。
// 結果を期待値の形にする変換は judge_shape.rs に閉じる (規則書 4 章)。
// 配置のテスト (tests/pipeline.rs) と、審判に Rust の配置を渡す例 (examples/layout_corpus.rs) が `#[path]` で読む
#![allow(dead_code)]

use std::collections::HashSet;

use indexmap::IndexSet;
use markdag_core::model::util::{JsValue, js_to_number};
use markdag_core::types::{
    LayoutInput, LayoutInputEdge, LayoutInputNode, LayoutInputRelation, OutlineNode,
};

// 幅は参照用のテキストのコードポイントの数 x 8 + 16 (テキストがなければ 0)。高さは 20 に、html の改行の数 x 14 を足す
fn pseudo_size(node: &OutlineNode) -> (f64, f64) {
    let width = if node.ref_text.is_empty() {
        0.0
    } else {
        node.ref_text.chars().count() as f64 * 8.0 + 16.0
    };
    let height = 20.0 + node.html.matches('\n').count() as f64 * 14.0;
    (width, height)
}

/// harness の `Number(frontmatter.markmap?.initialExpandLevel ?? -1)`。
/// 期待値を作った旧実装の harness の読み方で、配置の入力を期待値とそろえるために残す (製品は A-221 で markmap を読まなくなった)
pub fn expand_level_of(frontmatter: &JsValue) -> f64 {
    let level = match frontmatter {
        JsValue::Object(entries) => match entries.get("markmap") {
            Some(JsValue::Object(markmap)) => markmap.get("initialExpandLevel"),
            _ => None,
        },
        _ => None,
    };
    match level {
        None | Some(JsValue::Null) | Some(JsValue::Undefined) => -1.0,
        Some(value) => js_to_number(value),
    }
}

/// harness の initialFold (view.ts の computeInitialFold と同じ)。並びは文書順 (Set の挿入順)
pub fn initial_fold(nodes: &[OutlineNode], expand_level: f64) -> IndexSet<u32> {
    let has_children: HashSet<u32> = nodes.iter().filter_map(|node| node.parent).collect();
    let mut folded = IndexSet::new();
    let mut fold_all_under = HashSet::new();
    for node in nodes {
        let inherited = node
            .parent
            .is_some_and(|parent| fold_all_under.contains(&parent));
        if node.fold_hint == 2.0 || inherited {
            fold_all_under.insert(node.id);
        }
        if has_children.contains(&node.id)
            && (node.fold_hint > 0.0
                || inherited
                || (expand_level >= 0.0 && f64::from(node.depth) >= expand_level))
        {
            folded.insert(node.id);
        }
    }
    folded
}

/// harness の layoutFor の入力 (visibleIds で見えないノードは大きさ 0)
pub fn layout_input(
    nodes: &[OutlineNode],
    relations: &[LayoutInputRelation],
    suppress_root_line: &[u32],
    folded: &IndexSet<u32>,
) -> LayoutInput {
    let mut hidden: HashSet<u32> = HashSet::new();
    for node in nodes {
        if let Some(parent) = node.parent
            && (hidden.contains(&parent) || folded.contains(&parent))
        {
            hidden.insert(node.id);
        }
    }
    LayoutInput {
        name: "judge".to_string(),
        nodes: nodes
            .iter()
            .map(|node| {
                let (width, height) = if hidden.contains(&node.id) {
                    (0.0, 0.0)
                } else {
                    pseudo_size(node)
                };
                LayoutInputNode {
                    id: node.id,
                    label: node.ref_text.clone(),
                    width,
                    height,
                    groups: node.groups.clone(),
                }
            })
            .collect(),
        tree_edges: nodes
            .iter()
            .filter_map(|node| {
                node.parent.map(|parent| LayoutInputEdge {
                    source: parent,
                    target: node.id,
                })
            })
            .collect(),
        relations: relations.to_vec(),
        suppress_root_line: suppress_root_line.to_vec(),
        folded: folded.iter().copied().collect(),
    }
}
