// 棚卸しの道具の片割れ。ブラウザで描いたときのノードの大きさと閉じたノード (node-sizes.mjs の JSON) を読み、
// 同じ入力で layout_document_with_counts を呼んで、枠の数、箱にした枠の数、loose の枠の数、採った回を表の行で出す。
// 公開 API と境界の JSON に出ない値 (箱と loose の数) を数えるためのもの (設計 7 章の出口の案 1)。
// 入力がブラウザと同じだったかは、配置の矩形をブラウザの矩形と比べた差の最大で示す (0 なら同じ)。
// 使い方: リポジトリの根で cargo run -p markdag-core --example frame_counts -- <node-sizes の JSON>
use std::collections::{HashMap, HashSet};
use std::fs;

use markdag_core::layout::pipeline::layout_document_with_counts;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::parse::parse_document;
use markdag_core::types::{LayoutInput, LayoutInputEdge, LayoutInputNode, Rect};
use serde::Deserialize;

#[derive(Deserialize)]
struct Measured {
    name: String,
    path: String,
    sizes: Vec<(u32, [f64; 2])>,
    folded: Vec<u32>,
    rects: Vec<(u32, Rect)>,
}

fn row(doc: &Measured) -> Result<String, String> {
    let source = fs::read_to_string(&doc.path).map_err(|error| format!("{}: {error}", doc.path))?;
    let parsed = parse_document(&source);
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(&source),
        &ModelOptions::default(),
    );
    let sizes: HashMap<u32, [f64; 2]> = doc.sizes.iter().copied().collect();
    let input = LayoutInput {
        name: doc.name.clone(),
        nodes: parsed
            .nodes
            .iter()
            .map(|node| {
                let [width, height] = sizes.get(&node.id).copied().unwrap_or([0.0, 0.0]);
                LayoutInputNode {
                    id: node.id,
                    label: node.ref_text.clone(),
                    width,
                    height,
                    groups: node.groups.clone(),
                }
            })
            .collect(),
        tree_edges: parsed
            .nodes
            .iter()
            .filter_map(|node| {
                node.parent.map(|parent| LayoutInputEdge {
                    source: parent,
                    target: node.id,
                })
            })
            .collect(),
        relations: model.relations.clone(),
        suppress_root_line: model.suppress_root_line.clone(),
        folded: doc.folded.clone(),
    };
    let (result, counts) =
        layout_document_with_counts(&input, &model.groups, &model.groups_of, None, None)
            .map_err(|error| error.message)?;

    let browser: HashMap<u32, &Rect> = doc.rects.iter().map(|(id, rect)| (*id, rect)).collect();
    let mut max_diff: f64 = 0.0;
    let mut seen = HashSet::new();
    for (id, rect) in &result.rects {
        seen.insert(*id);
        match browser.get(id) {
            Some(other) => {
                for (a, b) in [
                    (rect.x, other.x),
                    (rect.y, other.y),
                    (rect.width, other.width),
                    (rect.height, other.height),
                ] {
                    max_diff = max_diff.max((a - b).abs());
                }
            }
            None => max_diff = f64::INFINITY,
        }
    }
    if browser.keys().any(|id| !seen.contains(id)) {
        max_diff = f64::INFINITY;
    }
    let frames = result
        .frames
        .iter()
        .filter(|frame| frame.outline.is_some())
        .count();
    Ok(format!(
        "| {} | {} | {} | {} | {} | {} |",
        doc.name, frames, counts.boxed, counts.loose, result.passes, max_diff
    ))
}

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: frame_counts <node-sizes の JSON>");
        std::process::exit(2);
    };
    let documents: Vec<Measured> = match fs::read_to_string(&path)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|error| error.to_string()))
    {
        Ok(documents) => documents,
        Err(error) => {
            eprintln!("{path}: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "| サンプル | 枠の数 (outline あり) | 箱にした枠 | loose の枠 | 採った回 | ブラウザの矩形との差の最大 |"
    );
    println!("| --- | ---: | ---: | ---: | ---: | ---: |");
    let mut failed = false;
    for doc in &documents {
        match row(doc) {
            Ok(line) => println!("{line}"),
            Err(message) => {
                println!("| {} | 失敗: {message} | | | | |", doc.name);
                failed = true;
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}
