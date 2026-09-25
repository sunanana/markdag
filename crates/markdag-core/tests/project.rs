// 射影 (layout/project.rs) が旧実装 (src/layout/project.ts) と同じ VisibleGraph を出すかの確かめ。
// (1) 原文 test/spike/p-l1.test.ts の射影の場面の移植。入力は spike/layout/inputs/ の 4 件を tests/fixtures/project/ に写したもの
//     (旧い形の tags を groups に直した) で、期待値の graph と hints は旧実装を vite-node で動かして書き出した値
//     (生成器は scripts/migration/fixtures/ の射影用)。
//     p-l1 のうち配置 (layoutGraph) の結果を見る場面 (重なり、左余白、横位置) は配置の層のテストに回す。
// (2) 審判のコーパス (tests/fixtures/judge/expected/*.json) の layout と layoutFolded の graph。入力は harness の layoutFor と同じ形で、
//     幅と高さは期待値の graph の値 (見えないノードは 0。射影は幅と高さを写すだけなので結果に効かない)。
// (3) 乱数の入力の突き合わせは #[ignore] のテストで、環境変数の JSON を読む。
use std::fs;
use std::path::Path;

use markdag_core::layout::project::{
    VisibleEdgeKind, VisibleGraph, compute_layout_parent_hints, project,
};
use markdag_core::types::{
    LayoutInput, LayoutInputEdge, LayoutInputNode, LayoutInputRelation, RelationKind,
};
use serde_json::{Value, json};

#[path = "judge_shape.rs"]
mod judge_shape;

fn fixture(name: &str) -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/project/{name}.json"));
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn load(name: &str) -> LayoutInput {
    serde_json::from_value(fixture(name)["input"].clone()).unwrap()
}

fn run(name: &str) -> VisibleGraph {
    project(&load(name)).unwrap()
}

fn hints_json(input: &LayoutInput) -> Value {
    serde_json::to_value(
        compute_layout_parent_hints(input)
            .into_iter()
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

// 欄の順も含めて同じか (serde_json の preserve_order で読み書きし、文字列で比べる)
fn same_text(expected: &Value, actual: &Value) -> bool {
    serde_json::to_string(expected).unwrap() == serde_json::to_string(actual).unwrap()
}

// relations の線を `kind:source>target×まとめた数` の形に (原文のテストの書き方)
fn relation_labels(graph: &VisibleGraph) -> Vec<String> {
    graph
        .edges
        .iter()
        .filter(|edge| edge.kind != VisibleEdgeKind::Tree)
        .map(|edge| {
            format!(
                "{}:{}>{}×{}",
                edge.kind.as_str(),
                edge.source,
                edge.target,
                edge.member_relation_indexes.len()
            )
        })
        .collect()
}

#[test]
fn project_fixtures_match_the_old_implementation() {
    for name in [
        "epic-expanded",
        "epic-initial",
        "epic-api-open",
        "tree-only",
    ] {
        let expected = fixture(name);
        let input = load(name);
        let graph = serde_json::to_value(project(&input).unwrap()).unwrap();
        assert!(
            same_text(&expected["graph"], &graph),
            "{name} の graph が違う"
        );
        assert!(
            same_text(&expected["hints"], &hints_json(&input)),
            "{name} の hints が違う"
        );
    }
}

#[test]
fn project_p_l1_epic_expanded_layout_parent_is_the_middle_join_source() {
    let hints = compute_layout_parent_hints(&load("epic-expanded"));
    let nodes: Vec<u32> = hints[&10].iter().map(|candidate| candidate.node).collect();
    assert_eq!(nodes, vec![7, 5, 8, 4, 9]);
    assert_eq!(run("epic-expanded").layout_parent.get(&10), Some(&7));
}

#[test]
fn project_p_l1_epic_expanded_chain_successors_hang_under_the_previous_node() {
    let graph = run("epic-expanded");
    for (child, parent) in [(11, 10), (15, 11), (16, 15), (17, 16)] {
        assert_eq!(graph.layout_parent.get(&child), Some(&parent), "#{child}");
    }
    // 原文は配置のあとの y の順で [12, 13, 14, 15] を見る。射影で分かるのは、11 を配置上の親に持つノードの集まりまで
    let mut children: Vec<u32> = graph
        .layout_parent
        .iter()
        .filter(|(_, parent)| **parent == 11)
        .map(|(&child, _)| child)
        .collect();
    children.sort();
    assert_eq!(children, vec![12, 13, 14, 15]);
}

#[test]
fn project_p_l1_epic_expanded_root_lines_skip_suppressed_nodes() {
    let graph = run("epic-expanded");
    let targets: Vec<u32> = graph
        .edges
        .iter()
        .filter(|edge| edge.kind == VisibleEdgeKind::Tree && edge.source == 1)
        .map(|edge| edge.target)
        .collect();
    assert_eq!(targets, vec![2]);
}

#[test]
fn project_p_l1_epic_initial_folded_relations_become_proxy_edges() {
    let graph = run("epic-initial");
    let ids: Vec<u32> = graph.nodes.iter().map(|node| node.id).collect();
    assert_eq!(ids, vec![1, 2, 3, 6, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert_eq!(graph.layout_parent.get(&10), Some(&6));
    let relations = relation_labels(&graph);
    for label in ["join:3>10×2", "join:6>10×3", "depends:6>3×1"] {
        assert!(
            relations.iter().any(|item| item == label),
            "{label} が無い: {relations:?}"
        );
    }
    assert_eq!(relations.len(), 7);
}

#[test]
fn project_p_l1_epic_api_open_layout_parent_returns_to_the_api() {
    assert_eq!(run("epic-api-open").layout_parent.get(&10), Some(&7));
}

#[test]
fn project_p_l1_tree_only_layout_tree_is_the_markdown_tree() {
    let input = load("tree-only");
    let graph = project(&input).unwrap();
    assert_eq!(
        graph
            .nodes
            .iter()
            .find(|node| node.id == 1)
            .map(|node| node.depth),
        Some(1)
    );
    for edge in &input.tree_edges {
        assert_eq!(graph.layout_parent.get(&edge.target), Some(&edge.source));
    }
}

#[test]
fn project_p_l1_projection_cycle_excludes_the_later_edge() {
    // A の子 a1, a2 と B の子 b1。a1 --> b1 と b1 --> a2 があり、A と B を両方閉じると A --> B と B --> A になる
    let labels = [
        (1, "root"),
        (2, "A"),
        (3, "a1"),
        (4, "a2"),
        (5, "B"),
        (6, "b1"),
    ];
    let input = LayoutInput {
        name: "projection-cycle".to_string(),
        nodes: labels
            .iter()
            .map(|&(id, label)| LayoutInputNode {
                id,
                label: label.to_string(),
                width: 40.0,
                height: 20.0,
                groups: Vec::new(),
            })
            .collect(),
        tree_edges: [(1, 2), (2, 3), (2, 4), (1, 5), (5, 6)]
            .iter()
            .map(|&(source, target)| LayoutInputEdge { source, target })
            .collect(),
        relations: vec![
            LayoutInputRelation {
                source: 3,
                target: 6,
                kind: RelationKind::Depends,
                origin: "a1 --> b1".to_string(),
            },
            LayoutInputRelation {
                source: 6,
                target: 4,
                kind: RelationKind::Depends,
                origin: "b1 --> a2".to_string(),
            },
        ],
        suppress_root_line: Vec::new(),
        folded: vec![2, 5],
    };
    let graph = project(&input).unwrap();
    let relations: Vec<(u32, u32, bool)> = graph
        .edges
        .iter()
        .filter(|edge| edge.kind != VisibleEdgeKind::Tree)
        .map(|edge| (edge.source, edge.target, edge.excluded_from_layout))
        .collect();
    assert_eq!(relations, vec![(2, 5, false), (5, 2, true)]);
}

// 原文 test/frames.test.ts の入力 (nested-groups)。relations も折りたたみもないので、レイアウト木は Markdown の木そのもの
#[test]
fn project_frames_input_keeps_the_markdown_tree() {
    let parents: [Option<u32>; 9] = [
        None,
        Some(1),
        Some(2),
        Some(3),
        Some(3),
        Some(2),
        Some(6),
        Some(6),
        Some(1),
    ];
    let input = LayoutInput {
        name: "nested-groups".to_string(),
        nodes: (1..=9)
            .map(|id| LayoutInputNode {
                id,
                label: format!("n{id}"),
                width: 40.0,
                height: 20.0,
                groups: Vec::new(),
            })
            .collect(),
        tree_edges: parents
            .iter()
            .zip(1u32..)
            .filter_map(|(parent, id)| parent.map(|source| LayoutInputEdge { source, target: id }))
            .collect(),
        relations: Vec::new(),
        suppress_root_line: Vec::new(),
        folded: Vec::new(),
    };
    let graph = project(&input).unwrap();
    let pairs: Vec<(u32, u32)> = graph
        .layout_parent
        .iter()
        .map(|(&child, &parent)| (child, parent))
        .collect();
    assert_eq!(
        pairs,
        vec![
            (2, 1),
            (3, 2),
            (4, 3),
            (5, 3),
            (6, 2),
            (7, 6),
            (8, 6),
            (9, 1)
        ]
    );
    assert_eq!(graph.edges.len(), 8);
}

// 審判の期待値から、harness の layoutFor と同じ形の LayoutInput を組む
fn judge_input(doc: &Value, layout: &Value) -> LayoutInput {
    let graph_nodes = layout["graph"]["nodes"].as_array().unwrap();
    let nodes = doc["parsed"]["nodes"].as_array().unwrap();
    let input = json!({
        "name": "judge",
        "nodes": nodes.iter().map(|node| {
            let shown = graph_nodes.iter().find(|shown| shown["id"] == node["id"]);
            json!({
                "id": node["id"],
                "label": node["refText"],
                "width": shown.map_or(json!(0), |shown| shown["width"].clone()),
                "height": shown.map_or(json!(0), |shown| shown["height"].clone()),
                "groups": node["groups"],
            })
        }).collect::<Vec<_>>(),
        "treeEdges": nodes.iter().filter(|node| !node["parent"].is_null())
            .map(|node| json!({ "source": node["parent"], "target": node["id"] })).collect::<Vec<_>>(),
        "relations": doc["model"]["relations"],
        "suppressRootLine": doc["model"]["suppressRootLine"],
        "folded": layout["folded"],
    });
    serde_json::from_value(input).unwrap()
}

#[test]
fn project_judge_corpus_graphs_match() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/judge/expected");
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert_eq!(files.len(), 57);
    let mut compared = 0;
    for path in files {
        let doc: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for key in ["layout", "layoutFolded"] {
            let layout = &doc[key];
            if layout.is_null() {
                continue;
            }
            let graph = serde_json::to_value(project(&judge_input(&doc, layout)).unwrap()).unwrap();
            let actual = judge_shape::expected_graph_from_boundary(&graph).unwrap();
            assert!(
                same_text(&layout["graph"], &actual),
                "{}:{key} の graph が違う",
                path.display()
            );
            compared += 1;
        }
    }
    assert_eq!(compared, 62);
}

// 配置上の親の表が閉路を持つか (子 → 親をたどって同じノードに戻るか)
fn has_layout_parent_cycle(graph: &VisibleGraph) -> bool {
    graph.layout_parent.keys().any(|&start| {
        let mut current = start;
        for _ in 0..=graph.layout_parent.len() {
            match graph.layout_parent.get(&current) {
                Some(&parent) if parent == start => return true,
                Some(&parent) => current = parent,
                None => return false,
            }
        }
        false
    })
}

// MARKDAG_PROJECT_CASES=<json のパス> cargo test -p markdag-core --test project -- --ignored。
// json は [{ name, input, graph, hints?, wellFormed? }] (射影用の生成器に出力先のディレクトリを渡すと、旧実装で corpus.json と random.json に書く)。
// wellFormed の入力 (view が渡す形: 文書順、親 1 つ、端点がすべてノード) では配置上の親に閉路がないことも確かめる
#[test]
#[ignore]
fn project_random_cases_match_the_old_implementation() {
    let Ok(paths) = std::env::var("MARKDAG_PROJECT_CASES") else {
        panic!("MARKDAG_PROJECT_CASES が無い");
    };
    let (mut total, mut mismatch, mut well_formed, mut cycles_well, mut cycles_malformed) =
        (0, 0, 0, 0, 0);
    for path in paths.split(',') {
        let cases: Vec<Value> = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        for case in cases {
            total += 1;
            let input: LayoutInput = serde_json::from_value(case["input"].clone()).unwrap();
            let graph = project(&input).unwrap();
            let actual = serde_json::to_value(&graph).unwrap();
            let mut same = same_text(&case["graph"], &actual);
            if !case["hints"].is_null() {
                same = same && same_text(&case["hints"], &hints_json(&input));
            }
            if !same {
                mismatch += 1;
                eprintln!("違う: {}", case["name"]);
            }
            let cyclic = has_layout_parent_cycle(&graph);
            if case["wellFormed"] == json!(true) {
                well_formed += 1;
                cycles_well += usize::from(cyclic);
            } else {
                cycles_malformed += usize::from(cyclic);
            }
        }
    }
    eprintln!(
        "cases {total} mismatch {mismatch} wellFormed {well_formed} cycles(wellFormed) {cycles_well} cycles(malformed) {cycles_malformed}"
    );
    assert_eq!(mismatch, 0);
    assert_eq!(cycles_well, 0);
}
