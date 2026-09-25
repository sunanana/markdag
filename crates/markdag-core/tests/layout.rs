// 配置 (layout/layout.rs) が旧実装 (src/layout/layout.ts) と同じ結果を出すかの確かめ。f64 は to_bits で比べる (許容なし)。
// (1) 審判のコーパス (枠の余白と繰り返しを含む) の突き合わせは、配置の流れのテスト (tests/pipeline.rs) が回ごとに行う。
// (2) 原文 test/spike/p-l1.test.ts の配置の結果を見る場面 (重なり、左余白、左から右、plannedX、extraSpacing の呼び順、
//     合成 500 ノード、射影の閉路)。入力は tests/fixtures/project/ の 4 件と、tests/fixtures/layout/p-l1.json の合成 500 ノードと
//     射影の閉路。結果は旧実装を vite-node で動かした値 (p-l1.json。同じ配置の生成器が書く) とビット単位でも比べる。
// (3) 乱数の入力の突き合わせは #[ignore] のテストで、環境変数の JSON を読む。
use std::cell::RefCell;
use std::fs;
use std::path::Path;

use markdag_core::layout::layout::{
    LayoutOptions, LayoutResult, MARKMAP_DEFAULTS, PlacedNode, layout_graph,
    layout_graph_with_extra_spacing,
};
use markdag_core::layout::project::{VisibleGraph, project};
use markdag_core::types::{LayoutInput, Rect};
use serde_json::{Value, json};

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn fixture(relative: &str) -> Value {
    read_json(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(relative),
    )
}

// JSON の数か、有限でない数と -0 の印 ({ "$number": "-0" | "NaN" | "Infinity" | "-Infinity" }) を f64 に
fn number_of(value: &Value) -> Option<f64> {
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    match value.get("$number")?.as_str()? {
        "-0" => Some(-0.0),
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

fn same_bits(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

// 数を to_bits で比べる JSON の比較。オブジェクトのキーの順は見ない。違えば最初の場所を返す
fn bits_difference(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    if let (Some(a), Some(b)) = (number_of(expected), number_of(actual)) {
        return (!same_bits(a, b)).then(|| format!("{path}: 期待 {a:?}、実際 {b:?}"));
    }
    match (expected, actual) {
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path}: 長さ (期待 {}、実際 {})", a.len(), b.len()));
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(index, (x, y))| bits_difference(x, y, &format!("{path}/{index}")))
        }
        (Value::Object(a), Value::Object(b)) => {
            if a.len() != b.len() || a.keys().any(|key| !b.contains_key(key)) {
                return Some(format!("{path}: 欄が違う"));
            }
            a.iter()
                .find_map(|(key, x)| bits_difference(x, &b[key], &format!("{path}/{key}")))
        }
        (a, b) => (a != b).then(|| format!("{path}: 期待 {a}、実際 {b}")),
    }
}

// 旧実装の書き出し (配置の生成器の num) と同じ形の数: -0 と有限でない数は印
fn num(value: f64) -> Value {
    if value == 0.0 && value.is_sign_negative() {
        json!({ "$number": "-0" })
    } else if value.is_nan() {
        json!({ "$number": "NaN" })
    } else if value.is_infinite() {
        json!({ "$number": if value > 0.0 { "Infinity" } else { "-Infinity" } })
    } else {
        json!(value)
    }
}

fn rect_row(rect: &Rect) -> Value {
    json!([num(rect.x), num(rect.y), num(rect.width), num(rect.height)])
}

// 旧実装の書き出し (配置の生成器の resultJson) と同じ形の行
fn result_rows(result: &LayoutResult) -> Value {
    json!({
        "nodes": result.nodes.iter().map(|(id, placed)| {
            json!([id, num(placed.gap), rect_row(&placed.rect), placed.layout_parent])
        }).collect::<Vec<_>>(),
        "edges": result.edges.iter().map(|edge| {
            json!([
                edge.edge.source,
                edge.edge.target,
                [num(edge.source[0]), num(edge.source[1])],
                [num(edge.target[0]), num(edge.target[1])],
                edge.is_layout_link
            ])
        }).collect::<Vec<_>>(),
        "bounds": rect_row(&result.bounds),
        "plannedX": result.planned_x.iter().map(|(id, x)| json!([id, num(*x)])).collect::<Vec<_>>(),
        "nodeSize": result.flextree_params.node_size.iter()
            .map(|(id, [a, b])| json!([id, [num(*a), num(*b)]])).collect::<Vec<_>>(),
    })
}

fn project_input(name: &str) -> LayoutInput {
    serde_json::from_value(fixture(&format!("project/{name}.json"))["input"].clone()).unwrap()
}

fn p_l1_case(name: &str) -> Value {
    fixture("layout/p-l1.json")[name].clone()
}

fn p_l1_input(name: &str) -> LayoutInput {
    match name {
        "synthetic-500" | "projection-cycle" => {
            serde_json::from_value(p_l1_case(name)["input"].clone()).unwrap()
        }
        _ => project_input(name),
    }
}

fn run(name: &str) -> (VisibleGraph, LayoutResult) {
    let graph = project(&p_l1_input(name)).unwrap();
    let result = layout_graph(&graph, None).unwrap();
    (graph, result)
}

fn gap_nodes(result: &LayoutResult) -> Vec<u32> {
    let mut ids: Vec<u32> = result
        .nodes
        .values()
        .filter(|placed| placed.gap > 0.0)
        .map(|placed| placed.node.id)
        .collect();
    ids.sort();
    ids
}

// 原文 spike/layout/metrics.ts の rectsOverlap
fn rects_overlap(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

fn assert_no_overlap(result: &LayoutResult) {
    let placed: Vec<&PlacedNode> = result.nodes.values().collect();
    for (i, a) in placed.iter().enumerate() {
        for b in &placed[i + 1..] {
            assert!(
                !rects_overlap(&a.rect, &b.rect),
                "#{} と #{} が重なる",
                a.node.id,
                b.node.id
            );
        }
    }
}

// 配置の計算から外されていないすべての線で、始点の右端が終点の左端以下
fn assert_left_to_right(result: &LayoutResult) {
    for placed in &result.edges {
        if placed.edge.excluded_from_layout {
            continue;
        }
        assert!(
            placed.source[0] <= placed.target[0],
            "{} {} --> {}",
            placed.edge.kind.as_str(),
            placed.edge.source,
            placed.edge.target
        );
    }
}

// flextree を実行する前に最長経路で決めた横位置と、flextree の結果が一致する (原文の toBeCloseTo(…, 6))
fn assert_planned_x(result: &LayoutResult) {
    for (id, placed) in &result.nodes {
        let planned = result.planned_x.get(id).copied().unwrap_or(f64::NAN);
        assert!((placed.rect.x - planned).abs() < 5e-7, "#{id}");
    }
}

#[test]
fn layout_p_l1_results_match_the_old_implementation_bit_for_bit() {
    for name in [
        "epic-expanded",
        "epic-initial",
        "epic-api-open",
        "tree-only",
        "synthetic-500",
        "projection-cycle",
    ] {
        let (_, result) = run(name);
        if let Some(difference) =
            bits_difference(&p_l1_case(name)["result"], &result_rows(&result), name)
        {
            panic!("{difference}");
        }
    }
}

#[test]
fn layout_p_l1_epic_expanded_release_prep_children_in_order() {
    let (_, result) = run("epic-expanded");
    let mut children: Vec<&PlacedNode> = result
        .nodes
        .values()
        .filter(|placed| placed.layout_parent == Some(11))
        .collect();
    children.sort_by(|a, b| a.rect.y.total_cmp(&b.rect.y));
    let ids: Vec<u32> = children.iter().map(|placed| placed.node.id).collect();
    assert_eq!(ids, vec![12, 13, 14, 15]);
}

#[test]
fn layout_p_l1_epic_expanded_left_margin_only_on_two_nodes() {
    let (_, result) = run("epic-expanded");
    assert_eq!(gap_nodes(&result), vec![5, 10]);
}

#[test]
fn layout_p_l1_epic_expanded_left_to_right_no_overlap_planned_x() {
    let (_, result) = run("epic-expanded");
    assert_left_to_right(&result);
    assert_no_overlap(&result);
    assert_planned_x(&result);
}

#[test]
fn layout_p_l1_epic_expanded_join_target_level_with_layout_parent() {
    let (_, result) = run("epic-expanded");
    let parent = result.nodes[&7].rect.y;
    let child = result.nodes[&10].rect.y;
    assert!((child - parent).abs() < 5e-7);
}

#[test]
fn layout_p_l1_epic_initial_proxy_edge_moves_screen_dev_right() {
    let (_, result) = run("epic-initial");
    assert_eq!(gap_nodes(&result), vec![3, 10]);
    assert_left_to_right(&result);
    assert_no_overlap(&result);
    assert_planned_x(&result);
}

#[test]
fn layout_p_l1_epic_api_open_left_to_right_no_overlap_planned_x() {
    let (graph, result) = run("epic-api-open");
    assert_eq!(graph.layout_parent.get(&10), Some(&7));
    assert_left_to_right(&result);
    assert_no_overlap(&result);
    assert_planned_x(&result);
}

#[test]
fn layout_p_l1_tree_only_node_size_matches_markmap() {
    let input = project_input("tree-only");
    let (_, result) = run("tree-only");
    let LayoutOptions {
        padding_x,
        spacing_horizontal,
        ..
    } = MARKMAP_DEFAULTS;
    for node in &input.nodes {
        let expected = [
            node.height,
            node.width
                + (if node.width != 0.0 {
                    padding_x * 2.0
                } else {
                    0.0
                })
                + spacing_horizontal,
        ];
        assert_eq!(
            result.flextree_params.node_size.get(&node.id),
            Some(&expected),
            "#{}",
            node.id
        );
    }
    assert_eq!(gap_nodes(&result), Vec::<u32>::new());
}

#[test]
fn layout_p_l1_tree_only_spacing_matches_markmap() {
    // 原文は spacing の関数をすべてのノードの組で呼ぶ。Rust は関数を公開しないので、flextree が実際に受けた組と値の表で見る (A-164)
    let input = project_input("tree-only");
    let (graph, result) = run("tree-only");
    let parent_of: std::collections::HashMap<u32, u32> = input
        .tree_edges
        .iter()
        .map(|edge| (edge.target, edge.source))
        .collect();
    let depth_of: std::collections::HashMap<u32, u32> = graph
        .nodes
        .iter()
        .map(|node| (node.id, node.depth))
        .collect();
    assert_eq!(depth_of[&1], 1);
    assert!(!result.flextree_params.spacing.is_empty());
    for call in &result.flextree_params.spacing {
        let vertical = MARKMAP_DEFAULTS.spacing_vertical;
        let expected = (if parent_of.get(&call.upper) == parent_of.get(&call.lower) {
            vertical
        } else {
            vertical * 2.0
        }) + MARKMAP_DEFAULTS.line_width.at(depth_of[&call.upper]);
        assert!(same_bits(call.value, expected));
    }
}

#[test]
fn layout_p_l1_tree_only_layout_tree_is_markdown_tree_and_widths_include_padding() {
    let input = project_input("tree-only");
    let (graph, result) = run("tree-only");
    for edge in &input.tree_edges {
        assert_eq!(graph.layout_parent.get(&edge.target), Some(&edge.source));
    }
    for node in &input.nodes {
        assert_eq!(
            result.nodes[&node.id].rect.width,
            node.width + MARKMAP_DEFAULTS.padding_x * 2.0
        );
    }
    assert_no_overlap(&result);
}

#[test]
fn layout_p_l1_synthetic_500_nodes() {
    let (_, result) = run("synthetic-500");
    assert_eq!(result.nodes.len(), 500);
    assert_left_to_right(&result);
    assert_planned_x(&result);
    assert_no_overlap(&result);
}

#[test]
fn layout_p_l1_extra_spacing_is_called_upper_then_lower() {
    for name in ["epic-expanded", "tree-only"] {
        let graph = project(&p_l1_input(name)).unwrap();
        let pairs = RefCell::new(Vec::<(u32, u32)>::new());
        let mut record = |upper: u32, lower: u32| -> f64 {
            pairs.borrow_mut().push((upper, lower));
            0.0
        };
        let result = layout_graph_with_extra_spacing(&graph, None, Some(&mut record)).unwrap();
        let pairs = pairs.into_inner();
        assert!(!pairs.is_empty());
        for (upper, lower) in &pairs {
            let (a, b) = (result.nodes[upper].rect, result.nodes[lower].rect);
            assert!(a.y < b.y, "#{upper} は #{lower} より上");
        }
        // 呼ばれた組と順も旧実装と同じ
        let expected: Vec<(u32, u32)> =
            serde_json::from_value(p_l1_case(name)["extraCalls"].clone()).unwrap();
        assert_eq!(pairs, expected, "{name}");
        // 0 を足す extraSpacing は、渡さないときと同じ結果
        assert_eq!(result, layout_graph(&graph, None).unwrap());
    }
}

#[test]
fn layout_p_l1_projection_cycle_layout_completes() {
    let (graph, result) = run("projection-cycle");
    let excluded: Vec<(u32, u32, bool)> = graph
        .edges
        .iter()
        .filter(|edge| edge.kind.as_str() != "tree")
        .map(|edge| (edge.source, edge.target, edge.excluded_from_layout))
        .collect();
    assert_eq!(excluded, vec![(2, 5, false), (5, 2, true)]);
    assert_left_to_right(&result);
    assert_no_overlap(&result);
}

// MARKDAG_LAYOUT_CASES=<json のパス> cargo test -p markdag-core --test layout -- --ignored。
// json は [{ name, graph, options, extraKind, calls, result }] (scripts/migration/fixtures/ の配置の生成器に出力先のディレクトリを渡すと、旧実装で random.json に書く)。
// extraKind が 0 なら追加の間隔なし、1 と 2 は ((a * 7 + b * 13) % 11) / 3 と / 8。result は結果の行か { error }
#[test]
#[ignore]
fn layout_random_cases_match_the_old_implementation() {
    let Ok(paths) = std::env::var("MARKDAG_LAYOUT_CASES") else {
        panic!("MARKDAG_LAYOUT_CASES が無い");
    };
    let (mut total, mut mismatch, mut errors, mut with_extra) = (0, 0, 0, 0);
    for path in paths.split(',') {
        let cases = read_json(Path::new(path));
        for case in cases.as_array().unwrap() {
            total += 1;
            let graph: VisibleGraph = serde_json::from_value(case["graph"].clone()).unwrap();
            let raw = &case["options"];
            let options = LayoutOptions {
                padding_x: raw["paddingX"].as_f64().unwrap(),
                spacing_horizontal: raw["spacingHorizontal"].as_f64().unwrap(),
                spacing_vertical: raw["spacingVertical"].as_f64().unwrap(),
                ignore_proxied_depends: raw["ignoreProxiedDepends"].as_bool(),
                ..MARKMAP_DEFAULTS
            };
            let divisor = match case["extraKind"].as_u64().unwrap() {
                1 => Some(3.0),
                2 => Some(8.0),
                _ => None,
            };
            let mut calls: Vec<(u32, u32)> = Vec::new();
            let mut extra = |a: u32, b: u32| -> f64 {
                calls.push((a, b));
                ((u64::from(a) * 7 + u64::from(b) * 13) % 11) as f64 / divisor.unwrap_or(1.0)
            };
            let result = match divisor {
                Some(_) => layout_graph_with_extra_spacing(&graph, Some(options), Some(&mut extra)),
                None => layout_graph(&graph, Some(options)),
            };
            with_extra += usize::from(divisor.is_some());
            let actual = match &result {
                Ok(result) => result_rows(result),
                Err(error) => {
                    errors += 1;
                    json!({ "error": error.message })
                }
            };
            let expected_calls: Vec<(u32, u32)> =
                serde_json::from_value(case["calls"].clone()).unwrap();
            let difference = bits_difference(&case["result"], &actual, "").or_else(|| {
                (calls != expected_calls).then(|| "extraSpacing の呼び出し".to_string())
            });
            if let Some(difference) = difference {
                mismatch += 1;
                eprintln!("違う: {} {difference}", case["name"]);
            }
        }
    }
    eprintln!("cases {total} mismatch {mismatch} errors {errors} withExtra {with_extra}");
    assert_eq!(mismatch, 0);
}

// 境界の JSON の中で null になっている場所 (有限でない数が印にならずに落ちた跡) を集める
fn null_paths(value: &Value, path: &str, found: &mut Vec<String>) {
    match value {
        Value::Null => found.push(path.to_string()),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                null_paths(item, &format!("{path}[{index}]"), found);
            }
        }
        Value::Object(entries) => {
            for (key, item) in entries {
                null_paths(item, &format!("{path}.{key}"), found);
            }
        }
        _ => {}
    }
}

fn marks_in(value: &Value, label: &str) -> usize {
    match value {
        Value::Array(items) => items.iter().map(|item| marks_in(item, label)).sum(),
        Value::Object(entries) => {
            if entries.len() == 1 && entries.get("$number").and_then(Value::as_str) == Some(label) {
                1
            } else {
                entries.values().map(|item| marks_in(item, label)).sum()
            }
        }
        _ => 0,
    }
}

// 有限でない数は境界の JSON で `{ "$number": … }` の印になり、edges の座標、plannedX、nodeSize でも null にならない (規則書 4 章、A-165)。
// null を出すのは layoutParent と treeParent (Option の None) だけ
fn assert_boundary_marks(result: &LayoutResult, label: &str, sections: &[&str]) {
    let json = serde_json::to_value(result).unwrap();
    let mut nulls = Vec::new();
    null_paths(&json, "", &mut nulls);
    nulls.retain(|path| !path.ends_with(".layoutParent") && !path.ends_with(".treeParent"));
    assert!(nulls.is_empty(), "null になった数: {nulls:?}");
    for section in sections {
        let value = json.pointer(section).unwrap();
        assert!(
            marks_in(value, label) > 0,
            "{section} に {label} の印が無い: {value}"
        );
    }
    let back: LayoutResult = serde_json::from_value(json).unwrap();
    let again = serde_json::to_value(&back).unwrap();
    assert_eq!(again, serde_json::to_value(result).unwrap());
}

// ルート 1 と、その子 (id は 2 から) だけのグラフ。子の高さは child_heights の順。
// 幅の和があふれて gap が NaN になると flextree が止まらないので、深さ 1 に留める (A-156)
fn root_and_children(root_width: f64, child_heights: &[f64]) -> VisibleGraph {
    let node = |id: u32, width: f64, depth: u32, tree_parent: Value| json!({ "id": id, "label": id.to_string(), "width": width, "height": 20, "groups": [], "depth": depth, "treeParent": tree_parent, "folded": false });
    let children: Vec<u32> = (2..).take(child_heights.len()).collect();
    let mut nodes = vec![node(1, 0.0, 1, Value::Null)];
    nodes.extend(children.iter().map(|&id| node(id, 30.0, 2, json!(1))));
    let edges: Vec<Value> = children
        .iter()
        .map(|&id| json!({ "kind": "tree", "source": 1, "target": id, "memberRelationIndexes": [], "proxied": false, "excludedFromLayout": false }))
        .collect();
    let layout_parent: Vec<[u32; 2]> = children.iter().map(|&id| [id, 1]).collect();
    // 有限でない値は JSON の数に書けないので、読んだあとに入れる
    let mut graph: VisibleGraph = serde_json::from_value(
        json!({ "rootId": 1, "nodes": nodes, "edges": edges, "layoutParent": layout_parent }),
    )
    .unwrap();
    graph.nodes[0].width = root_width;
    for (node, &height) in graph.nodes[1..].iter_mut().zip(child_heights) {
        node.height = height;
    }
    graph
}

#[test]
fn layout_boundary_json_marks_infinite_width() {
    let graph = root_and_children(f64::INFINITY, &[20.0]);
    let result = layout_graph(&graph, None).unwrap();
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(
        json.pointer("/edges/0/source/0").unwrap(),
        &json!({ "$number": "Infinity" })
    );
    assert_boundary_marks(
        &result,
        "Infinity",
        &["/edges", "/plannedX", "/flextreeParams/nodeSize"],
    );
}

#[test]
fn layout_boundary_json_marks_nan_and_negative_infinite_heights() {
    let graph = root_and_children(40.0, &[f64::NAN, f64::NEG_INFINITY]);
    let result = layout_graph(&graph, None).unwrap();
    assert_boundary_marks(&result, "NaN", &["/edges", "/flextreeParams/nodeSize"]);
    assert_boundary_marks(&result, "-Infinity", &["/flextreeParams/nodeSize"]);
}
