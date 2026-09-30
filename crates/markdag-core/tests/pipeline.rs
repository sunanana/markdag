// 配置の流れ (layout/pipeline.rs の layout_document) の確かめ。
// 枠のない文書は、旧実装の view の配置の流れ (src/view/view.ts の update) と同じ結果を出すかを見る。f64 は to_bits で比べる (許容なし、-0 の符号まで)。
// 枠のある文書 (記録の frames が空でないもの) は枠を箱にして配置するので、座標が旧実装と変わる。座標の欄 (rects、gaps、edges、bounds、
// plannedX、nodeSize、passes、枠の outline) は旧実装と比べず、記録からも消してある。代わりに (4) の不変条件で確かめる。
// 座標以外 (folded、graph、枠の group、members、level) と入力は、枠のある文書も記録と比べる。
// (1) 審判のコーパス (tests/fixtures/judge/expected/*.json) の layout と layoutFolded の 62 件。入力は期待値の parsed と model から
//     harness と同じ規則 (tests/judge_harness.rs) で組み、layout_document の出力を judge_shape で期待値の形にして、
//     folded、graph、frames (枠のない文書は outline つき)、rects、gaps、edges、bounds、plannedX、nodeSize、passes を比べる
//     (枠のある文書は folded、graph、frames の group、members、level だけ)。
// (2) 同じ 62 件のうち枠のない文書の回ごとの値を、旧実装で view の繰り返しを回した記録 (tests/fixtures/pipeline/corpus.json。
//     scripts/migration/fixtures/pipeline.ts が書く) と比べる。回 k の配置は max_passes を k にした layout_document の結果
//     (k 回目より前に入り込みが 0 になっていないので、k 回目で打ち切られる)。比べるもの: 配置の 6 つの欄、flextree が呼んだ
//     spacing の組の順と合計、枠の余白 (前回の矩形から作った FrameSpacing の between) の値、countIntruders
// (3) 乱数の入力 (tests/fixtures/pipeline/random.json、options と ignoreProxiedDepends と回数の上限を変える) で (2) と同じもの
//     (枠のある入力は graph と、frames の group、members、level)。
//     件数を増やした突き合わせは #[ignore] のテストで、環境変数 MARKDAG_PIPELINE_CASES の JSON を読む
// (4) 枠のある文書の不変条件 (design.md 3 章): I1 (メンバーでないノードが枠に入らない)、I2 (メンバーの交わらない枠どうしが重ならない)、
//     I10 (入れ子の箱の形)、I5 (左から右の流れ)、I7 (loose がなければ 1 回)、I8 (同じ入力なら同じ結果)。箱にした枠は 0 を求め、
//     loose の枠が関わる入り込みと重なりは数えて文書ごとに試験の出力 (eprintln) に出す。loose のある入力では、採った回が
//     Q4-b の規則 (入り込み、面積、早さの順) どおりかも見る
#[path = "judge_harness.rs"]
mod judge_harness;
#[path = "judge_shape.rs"]
mod judge_shape;

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use indexmap::{IndexMap, IndexSet};
use markdag_core::layout::frames::{
    Frame, LABEL_HEIGHT, compute_frames, count_intruders, frame_blocks, frame_outline,
    frame_spacing,
};
use markdag_core::layout::layout::{
    LayoutOptions, MARKMAP_DEFAULTS, layout_children_of, layout_graph_framed,
};
use markdag_core::layout::pipeline::{
    FrameBoxCounts, LayoutDocumentResult, MAX_LAYOUT_PASSES, layout_document,
    layout_document_with_counts,
};
use markdag_core::layout::project::{VisibleEdgeKind, project};
use markdag_core::types::{GroupDef, LayoutInput, LayoutInputRelation, ParsedDocument, Rect};
use serde_json::{Value, json};

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn fixture(relative: &str) -> Value {
    read_json(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/pipeline")
            .join(relative),
    )
}

// JSON の数か、有限でない数と -0 の印を f64 に
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

fn assert_same(expected: &Value, actual: &Value, path: &str) {
    if let Some(difference) = bits_difference(expected, actual, path) {
        panic!("{difference}");
    }
}

// 生成器の num と同じ形の数: -0 と有限でない数は印
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

// 生成器の passJson と同じ形の行 (extra と intruders は呼び手が足す)
fn pass_rows(result: &LayoutDocumentResult) -> Value {
    json!({
        "rects": result.rects.iter().map(|(id, rect)| json!([id, rect_row(rect)])).collect::<Vec<_>>(),
        "gaps": result.gaps.iter().map(|(id, gap)| json!([id, num(*gap)])).collect::<Vec<_>>(),
        "edges": result.edges.iter().map(|edge| json!([
            edge.edge.kind.as_str(),
            edge.edge.source,
            edge.edge.target,
            [num(edge.source[0]), num(edge.source[1])],
            [num(edge.target[0]), num(edge.target[1])],
            edge.is_layout_link,
        ])).collect::<Vec<_>>(),
        "bounds": rect_row(&result.bounds),
        "plannedX": result.planned_x.iter().map(|(id, x)| json!([id, num(*x)])).collect::<Vec<_>>(),
        "nodeSize": result.node_size.iter().map(|(id, [a, b])| json!([id, [num(*a), num(*b)]])).collect::<Vec<_>>(),
        "spacing": result.spacing.iter().map(|call| json!([call.upper, call.lower, num(call.value)])).collect::<Vec<_>>(),
    })
}

struct Case<'a> {
    name: &'a str,
    input: &'a LayoutInput,
    groups: &'a [GroupDef],
    groups_of: &'a IndexMap<u32, Vec<String>>,
    options: &'a LayoutOptions,
    max_passes: usize,
}

// 回ごとの値を旧実装の記録と比べ、最後の回の結果を返す。比べた spacing の呼び出しの数も返す
fn check_passes(case: &Case, expected_passes: &[Value]) -> (LayoutDocumentResult, usize) {
    let name = case.name;
    let run = |max: usize| {
        layout_document(
            case.input,
            case.groups,
            case.groups_of,
            Some(case.options.clone()),
            Some(max),
        )
        .unwrap()
    };
    let full = run(case.max_passes);
    assert_eq!(full.passes, expected_passes.len(), "{name}: passes");
    let frames: Vec<Frame> = full
        .frames
        .iter()
        .map(|frame| frame.frame.clone())
        .collect();
    let mut previous: Option<LayoutDocumentResult> = None;
    let mut calls = 0;
    for (index, expected) in expected_passes.iter().enumerate() {
        let pass = index + 1;
        let path = format!("{name}/pass{pass}");
        let result = if pass == full.passes {
            full.clone()
        } else {
            run(pass)
        };
        assert_eq!(
            result.passes, pass,
            "{path}: 回数の上限で打ち切られていない"
        );
        // 途中の回でも枠そのものは変わらない (配置の前に 1 度だけ作る)
        assert_eq!(
            result.frames.iter().map(|f| &f.frame).collect::<Vec<_>>(),
            frames.iter().collect::<Vec<_>>()
        );
        let rows = pass_rows(&result);
        for field in [
            "rects", "gaps", "edges", "bounds", "plannedX", "nodeSize", "spacing",
        ] {
            assert_same(&expected[field], &rows[field], &format!("{path}/{field}"));
        }
        // 枠の余白: 前回の矩形 (1 回目は無し) から作った FrameSpacing が、旧実装の extraSpacing と同じ組で同じ値を返す
        let spacing = frame_spacing(&frames, previous.as_ref().map(|p| &p.rects));
        let extra: Vec<Value> = result
            .spacing
            .iter()
            .map(|call| {
                json!([
                    call.upper,
                    call.lower,
                    num(spacing.between(call.upper, call.lower))
                ])
            })
            .collect();
        assert_same(&expected["extra"], &json!(extra), &format!("{path}/extra"));
        let intruders = count_intruders(&frames, &result.rects);
        assert_eq!(json!(intruders), expected["intruders"], "{path}: intruders");
        if pass < full.passes {
            assert!(intruders > 0, "{path}: 入り込みが 0 なのに次の回がある");
        }
        calls += result.spacing.len();
        previous = Some(result);
    }
    (full, calls)
}

// 記録の frames が空でない (枠のある文書)。座標の欄を旧実装と比べない分岐に使う
fn has_frames(frames: &Value) -> bool {
    frames.as_array().is_some_and(|list| !list.is_empty())
}

// 期待値の形の layout から座標の欄と枠の outline を除く (記録から消した欄。枠のある文書の比較に使う)
fn without_coordinates(layout: &Value) -> Value {
    let mut layout = layout.clone();
    if let Some(object) = layout.as_object_mut() {
        for key in [
            "rects", "gaps", "edges", "bounds", "plannedX", "nodeSize", "passes",
        ] {
            object.remove(key);
        }
        if let Some(frames) = object.get_mut("frames").and_then(Value::as_array_mut) {
            for frame in frames {
                if let Some(frame) = frame.as_object_mut() {
                    frame.remove("outline");
                }
            }
        }
    }
    layout
}

// 3 章の許容 (接するだけは数えない)
const TOLERANCE: f64 = 0.5;

// 3 章の「重なる」: x の重なりの幅と y の重なりの幅が、どちらも許容を超える
fn overlaps(a: &Rect, b: &Rect) -> bool {
    let x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    x > TOLERANCE && y > TOLERANCE
}

fn contains(outer: &Rect, inner: &Rect) -> bool {
    inner.x >= outer.x - TOLERANCE
        && inner.y >= outer.y - TOLERANCE
        && inner.x + inner.width <= outer.x + outer.width + TOLERANCE
        && inner.y + inner.height <= outer.y + outer.height + TOLERANCE
}

// 3 章の「枠の矩形」: outline を上へ LABEL_HEIGHT 広げたもの
fn with_label(outline: &Rect) -> Rect {
    Rect {
        y: outline.y - LABEL_HEIGHT,
        height: outline.height + LABEL_HEIGHT,
        ..*outline
    }
}

// view の withGap: 本体の左に確保した余白を足した矩形
fn with_gap(rect: &Rect, gap: f64) -> Rect {
    Rect {
        x: rect.x - gap,
        width: rect.width + gap,
        ..*rect
    }
}

// I1: 枠の矩形に入る、メンバーでないノード (本体の矩形か、gap を足した矩形のどちらかが重なる)。幅か高さが 0 のノードは除く
fn intruders(result: &LayoutDocumentResult, index: usize) -> Vec<u32> {
    let entry = &result.frames[index];
    let Some(outline) = entry.outline else {
        return Vec::new();
    };
    let area = with_label(&outline);
    result
        .rects
        .iter()
        .filter(|(id, rect)| {
            let gap = result.gaps.get(*id).copied().unwrap_or(0.0);
            rect.width > 0.0
                && rect.height > 0.0
                && !entry.frame.members.contains(id)
                && (overlaps(rect, &area) || overlaps(&with_gap(rect, gap), &area))
        })
        .map(|(id, _)| *id)
        .collect()
}

fn shares_members(a: &Frame, b: &Frame) -> bool {
    a.members.iter().any(|id| b.members.contains(id))
}

fn is_subset(inner: &Frame, outer: &Frame) -> bool {
    inner.members.iter().all(|id| outer.members.contains(id))
}

// 枠のある文書の件数 (文書ごとに足し上げる)
#[derive(Debug, Default)]
struct FramedTotals {
    documents: usize,
    frames: usize,
    boxed: usize,
    loose: usize,
    // loose の枠に入るメンバーでないノードの数 (I1。0 を求めない)
    loose_intruders: usize,
    // 片方が loose の、メンバーの交わらない枠の組の重なり (I2。0 を求めない)
    loose_overlaps: usize,
}

// (4) の不変条件の確かめ。箱かどうかは、結果の graph と frames に frame_blocks を当てて決め、出口の関数の数と比べる
fn check_frame_invariants(
    name: &str,
    result: &LayoutDocumentResult,
    counts: FrameBoxCounts,
    options: &LayoutOptions,
    totals: &mut FramedTotals,
) {
    let frames: Vec<Frame> = result
        .frames
        .iter()
        .map(|entry| entry.frame.clone())
        .collect();
    let blocks = frame_blocks(&result.graph, &frames, &layout_children_of(&result.graph));
    assert_eq!(
        (counts.boxed, counts.loose),
        (blocks.blocks.len(), blocks.loose.len()),
        "{name}: 箱の数と箱にできない枠の数"
    );
    let boxed: HashSet<usize> = blocks.blocks.iter().map(|block| block.frame).collect();
    // I7
    if blocks.loose.is_empty() {
        assert_eq!(
            result.passes, 1,
            "{name}: loose がないのに 1 回で終わらない (I7)"
        );
    }
    let (mut loose_intruders, mut loose_overlaps) = (0, 0);
    // I1
    for (index, frame) in frames.iter().enumerate() {
        let found = intruders(result, index);
        if boxed.contains(&index) {
            assert!(
                found.is_empty(),
                "{name}: 箱にした枠 {} {:?} にメンバーでないノード {found:?} が入る (I1)",
                frame.group.id,
                frame.members
            );
        } else {
            loose_intruders += found.len();
        }
    }
    // I2 と I10。同じ id のグループの枠も添字で区別する
    for a in 0..frames.len() {
        for b in a + 1..frames.len() {
            let (Some(outline_a), Some(outline_b)) =
                (result.frames[a].outline, result.frames[b].outline)
            else {
                continue;
            };
            let (frame_a, frame_b) = (&frames[a], &frames[b]);
            let path = format!("{name}: 枠 {} と {}", frame_a.group.id, frame_b.group.id);
            if !shares_members(frame_a, frame_b) {
                let hit = overlaps(&with_label(&outline_a), &with_label(&outline_b));
                if boxed.contains(&a) && boxed.contains(&b) {
                    assert!(!hit, "{path}: メンバーが交わらない箱の枠が重なる (I2)");
                } else if hit {
                    loose_overlaps += 1;
                }
                continue;
            }
            // メンバーを共有する組は規定で重なってよい。入れ子の箱の形 (I10) だけを見る
            if !(boxed.contains(&a) && boxed.contains(&b)) {
                continue;
            }
            let (inner, outer) = if is_subset(frame_a, frame_b) && frame_a.level < frame_b.level {
                (a, b)
            } else if is_subset(frame_b, frame_a) && frame_b.level < frame_a.level {
                (b, a)
            } else if is_subset(frame_a, frame_b) && is_subset(frame_b, frame_a) {
                // TODO(spec): メンバーも level も同じ 2 つの枠 (同じ id のグループが 2 つ) は、設計に内と外の決め方がない。
                // 同じメンバーから作る矩形なので、同じ outline になることだけを見る
                assert_eq!(outline_a, outline_b, "{path}: メンバーも level も同じ枠");
                continue;
            } else {
                panic!("{path}: メンバーが一部だけ重なる枠を、両方とも箱にした");
            };
            let inner_area = with_label(&result.frames[inner].outline.unwrap());
            assert!(
                contains(&result.frames[outer].outline.unwrap(), &inner_area),
                "{path}: 内側の枠がラベルの行ごと外側の枠に収まらない (I10)"
            );
        }
    }
    check_left_to_right(name, result, options);
    eprintln!(
        "{name}: 枠 {}、箱 {}、loose {}、passes {}、loose の入り込み {loose_intruders}、loose の枠が関わる重なり {loose_overlaps}",
        frames.len(),
        blocks.blocks.len(),
        blocks.loose.len(),
        result.passes
    );
    totals.documents += 1;
    totals.frames += frames.len();
    totals.boxed += blocks.blocks.len();
    totals.loose += blocks.loose.len();
    totals.loose_intruders += loose_intruders;
    totals.loose_overlaps += loose_overlaps;
}

// I5: rect.x と plannedX の差が 0.5 以下。配置上の親子と、配置の計算から外されていない relations で、
// 終点の rect.x ≥ 始点の右の端 + spacing_horizontal − 0.5
fn check_left_to_right(name: &str, result: &LayoutDocumentResult, options: &LayoutOptions) {
    for (id, rect) in &result.rects {
        let planned = result.planned_x[id];
        assert!(
            (rect.x - planned).abs() <= TOLERANCE,
            "{name}: ノード {id} の x {} が plannedX {planned} と違う (I5)",
            rect.x
        );
    }
    let mut pairs: Vec<(u32, u32)> = result
        .graph
        .layout_parent
        .iter()
        .map(|(child, parent)| (*parent, *child))
        .collect();
    for edge in &result.graph.edges {
        if edge.kind == VisibleEdgeKind::Tree || edge.excluded_from_layout {
            continue;
        }
        if options.ignore_proxied_depends == Some(true)
            && edge.kind == VisibleEdgeKind::Depends
            && edge.proxied
        {
            continue;
        }
        pairs.push((edge.source, edge.target));
    }
    for (source, target) in pairs {
        let (Some(from), Some(to)) = (result.rects.get(&source), result.rects.get(&target)) else {
            continue;
        };
        assert!(
            to.x >= from.x + from.width + options.spacing_horizontal - TOLERANCE,
            "{name}: {source} → {target} で終点が始点の右に来ない (I5)"
        );
    }
}

// 枠のある文書の結果を出口の関数で求め、I8 (同じ入力なら同じ結果) と (4) の不変条件を確かめる
fn check_framed(case: &Case, totals: &mut FramedTotals) -> LayoutDocumentResult {
    let name = case.name;
    let run = || {
        layout_document_with_counts(
            case.input,
            case.groups,
            case.groups_of,
            Some(case.options.clone()),
            Some(case.max_passes),
        )
        .unwrap()
    };
    let (result, counts) = run();
    let (again, again_counts) = run();
    assert_eq!(counts, again_counts, "{name}: 同じ入力の箱の数 (I8)");
    assert_same(
        &serde_json::to_value(&result).unwrap(),
        &serde_json::to_value(&again).unwrap(),
        &format!("{name}/I8"),
    );
    assert_eq!(
        result.spacing, again.spacing,
        "{name}: 同じ入力の spacing (I8)"
    );
    assert!(
        result.passes >= 1 && result.passes <= case.max_passes.max(1),
        "{name}: passes {} が上限 {} を超える",
        result.passes,
        case.max_passes
    );
    check_frame_invariants(name, &result, counts, case.options, totals);
    if counts.loose > 0 {
        check_adopted_pass(case, &result);
    }
    result
}

// Q4-b の止め方と採る回の比べ方で使う入り込みの数 (G-009): 全部の枠 (箱と loose) について、ずらす前の outline
// (frame_outline) をラベルの行ごと見た枠の矩形に、メンバーでないノードの矩形 (gap を左に足した矩形でも見る) が
// 許容 0.5 を超えて重なる組の数。3 章の I1 の定義と同じ。幅か高さが 0 のノードは除く
fn label_row_intruders(
    frames: &[Frame],
    rects: &IndexMap<u32, Rect>,
    gaps: &IndexMap<u32, f64>,
) -> usize {
    let mut count = 0;
    for frame in frames {
        let Some(outline) = frame_outline(frame, rects) else {
            continue;
        };
        let area = with_label(&outline);
        for (id, rect) in rects {
            let gap = gaps.get(id).copied().unwrap_or(0.0);
            if rect.width > 0.0
                && rect.height > 0.0
                && !frame.members.contains(id)
                && (overlaps(rect, &area) || overlaps(&with_gap(rect, gap), &area))
            {
                count += 1;
            }
        }
    }
    count
}

// Q4-b を設計の文から組んだ参照と、採った回と矩形を比べる。loose の枠だけを前回の矩形の余白 (between) に渡して
// layout_graph_framed を回し、入り込みの数 (label_row_intruders。G-009) が 0 の回か上限で止め、
// 入り込みが最も少ない回、同じなら bounds の面積が小さい回、さらに同じなら早い回を採る
fn check_adopted_pass(case: &Case, result: &LayoutDocumentResult) {
    let name = case.name;
    let graph = project(case.input).unwrap();
    let children_of = layout_children_of(&graph);
    let frames = compute_frames(&graph, case.groups, case.groups_of, &children_of);
    let blocks = frame_blocks(&graph, &frames, &children_of);
    let loose: Vec<Frame> = blocks
        .loose
        .iter()
        .map(|&index| frames[index].clone())
        .collect();
    let mut passes: Vec<(usize, f64, IndexMap<u32, Rect>)> = Vec::new();
    let mut previous: Option<IndexMap<u32, Rect>> = None;
    for _ in 0..case.max_passes.max(1) {
        // 1 回目も loose の枠を前回の矩形なし (frame_clearance のぶん) で渡す (旧と試作の流れと同じ。段 5 の実装がこの読みで実装した)
        let spacing = frame_spacing(&loose, previous.as_ref());
        let mut between = |upper: u32, lower: u32| spacing.between(upper, lower);
        let layout = layout_graph_framed(
            &graph,
            Some(LayoutOptions {
                extra_spacing: None,
                ..case.options.clone()
            }),
            Some(&mut between),
            &children_of,
            &frames,
            &blocks,
        )
        .unwrap();
        let rects: IndexMap<u32, Rect> = layout
            .nodes
            .iter()
            .map(|(id, placed)| (*id, placed.rect))
            .collect();
        let gaps: IndexMap<u32, f64> = layout
            .nodes
            .iter()
            .map(|(id, placed)| (*id, placed.gap))
            .collect();
        let count = label_row_intruders(&frames, &rects, &gaps);
        passes.push((
            count,
            layout.bounds.width * layout.bounds.height,
            rects.clone(),
        ));
        if count == 0 {
            break;
        }
        previous = Some(rects);
    }
    let mut best = 0;
    for (index, pass) in passes.iter().enumerate().skip(1) {
        let kept = &passes[best];
        if pass.0 < kept.0 || (pass.0 == kept.0 && pass.1 < kept.1) {
            best = index;
        }
    }
    assert_eq!(
        result.passes,
        best + 1,
        "{name}: Q4-b で採る回 (回ごとの入り込み {:?})",
        passes.iter().map(|pass| pass.0).collect::<Vec<_>>()
    );
    let rows = |rects: &IndexMap<u32, Rect>| {
        json!(
            rects
                .iter()
                .map(|(id, rect)| json!([id, rect_row(rect)]))
                .collect::<Vec<_>>()
        )
    };
    assert_same(
        &rows(&passes[best].2),
        &rows(&result.rects),
        &format!("{name}/adopted/rects"),
    );
}

#[test]
fn pipeline_judge_corpus_matches_expected_and_old_passes() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/judge/expected");
    let recorded = fixture("corpus.json");
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert_eq!(files.len(), 57);
    let (mut compared, mut with_frames, mut frame_count, mut calls) = (0, 0, 0, 0);
    let mut totals = FramedTotals::default();
    for path in files {
        let doc = read_json(&path);
        let file = path.file_name().unwrap().to_str().unwrap();
        let (parsed, model) = judge_shape::boundary_from_expected(&doc).unwrap();
        let parsed: ParsedDocument = serde_json::from_value(parsed).unwrap();
        let groups: Vec<GroupDef> = serde_json::from_value(model["groups"].clone()).unwrap();
        let groups_of: IndexMap<u32, Vec<String>> = model["groupsOf"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| serde_json::from_value(pair.clone()).unwrap())
            .collect();
        let relations: Vec<LayoutInputRelation> =
            serde_json::from_value(model["relations"].clone()).unwrap();
        let suppress: Vec<u32> = serde_json::from_value(model["suppressRootLine"].clone()).unwrap();
        let initial = judge_harness::initial_fold(
            &parsed.nodes,
            judge_harness::expand_level_of(&parsed.frontmatter),
        );
        for (key, folded) in [("layout", IndexSet::new()), ("layoutFolded", initial)] {
            let layout = &doc[key];
            if folded.is_empty() && key == "layoutFolded" {
                assert!(
                    layout.is_null(),
                    "{file}: layoutFolded は閉じたノードがあるときだけ"
                );
                continue;
            }
            let name = format!("{file}:{key}");
            let input = judge_harness::layout_input(&parsed.nodes, &relations, &suppress, &folded);
            // harness の入力の写しが、旧実装の記録の入力と同じ
            let record = &recorded[&name];
            assert_same(
                &record["input"],
                &serde_json::to_value(&input).unwrap(),
                &format!("{name}/input"),
            );

            let case = Case {
                name: &name,
                input: &input,
                groups: &groups,
                groups_of: &groups_of,
                options: &MARKMAP_DEFAULTS,
                max_passes: MAX_LAYOUT_PASSES,
            };
            // 枠のある文書は座標を旧実装の記録と比べず、不変条件で確かめる
            let framed = has_frames(&layout["frames"]);
            let result = if framed {
                check_framed(&case, &mut totals)
            } else {
                let (result, count) = check_passes(&case, record["passes"].as_array().unwrap());
                calls += count;
                result
            };
            // 既定の引数 (None) でも同じ
            assert_eq!(
                layout_document(&input, &groups, &groups_of, None, None).unwrap(),
                result,
                "{name}: 既定の引数"
            );

            let folded: Vec<u32> = folded.into_iter().collect();
            let actual = judge_shape::expected_layout_document_from_boundary(
                &serde_json::to_value(&result).unwrap(),
                &folded,
            )
            .unwrap();
            if framed {
                assert_same(layout, &without_coordinates(&actual), &name);
            } else {
                assert_same(layout, &actual, &name);
            }
            compared += 1;
            with_frames += usize::from(!result.frames.is_empty());
            frame_count += result.frames.len();
        }
    }
    assert_eq!(compared, 62);
    assert_eq!((with_frames, frame_count), (7, 27));
    // コーパスの枠は、どれも箱にできる (通常の文書では loose は出ない。design.md の Q4 と段 1)
    assert_eq!(
        (totals.documents, totals.boxed, totals.loose),
        (7, 27, 0),
        "{totals:?}"
    );
    assert!(calls > 0);
}

fn check_random(cases: &Value, totals: &mut FramedTotals) -> (usize, usize) {
    let (mut compared, mut failed) = (0, 0);
    for case in cases.as_array().unwrap() {
        let input: LayoutInput = serde_json::from_value(case["input"].clone()).unwrap();
        let name = input.name.clone();
        let groups: Vec<GroupDef> = serde_json::from_value(case["groups"].clone()).unwrap();
        let groups_of: IndexMap<u32, Vec<String>> = case["groupsOf"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pair| serde_json::from_value(pair.clone()).unwrap())
            .collect();
        let options: LayoutOptions = serde_json::from_value(case["options"].clone()).unwrap();
        let max_passes = usize::try_from(case["maxPasses"].as_u64().unwrap()).unwrap();
        if let Some(message) = case.get("error") {
            let error =
                layout_document(&input, &groups, &groups_of, Some(options), Some(max_passes))
                    .unwrap_err();
            assert_eq!(json!(error.message), *message, "{name}");
            failed += 1;
            continue;
        }
        let run = Case {
            name: &name,
            input: &input,
            groups: &groups,
            groups_of: &groups_of,
            options: &options,
            max_passes,
        };
        // 枠のある入力は座標を旧実装の記録と比べず、不変条件で確かめる
        let framed = has_frames(&case["frames"]);
        let result = if framed {
            check_framed(&run, totals)
        } else {
            check_passes(&run, case["passes"].as_array().unwrap()).0
        };
        assert_same(
            &case["graph"],
            &serde_json::to_value(&result.graph).unwrap(),
            &format!("{name}/graph"),
        );
        let frames: Vec<Value> = result
            .frames
            .iter()
            .map(|frame| {
                let index = groups
                    .iter()
                    .position(|group| *group == frame.frame.group)
                    .unwrap();
                let mut row = json!({
                    "group": index,
                    "members": frame.frame.members,
                    "level": frame.frame.level,
                });
                if !framed {
                    row["outline"] = json!(frame.outline.as_ref().map(rect_row));
                }
                row
            })
            .collect();
        assert_same(&case["frames"], &json!(frames), &format!("{name}/frames"));
        compared += 1;
    }
    (compared, failed)
}

#[test]
fn pipeline_random_cases_match_the_old_view_flow() {
    let mut totals = FramedTotals::default();
    let (compared, failed) = check_random(&fixture("random.json"), &mut totals);
    assert_eq!((compared, failed), (150, 0));
    // 枠のある入力は 58 件、枠は計 132 (design.md の「既存の試験の扱い」)。箱と loose の内訳は出力に出すだけ
    assert_eq!((totals.documents, totals.frames), (58, 132), "{totals:?}");
    eprintln!("random: {totals:?}");
}

#[test]
#[ignore = "MARKDAG_PIPELINE_CASES に scripts/migration/fixtures/pipeline.ts が書いた random.json のパスを渡す"]
fn pipeline_random_cases_from_env_match_the_old_view_flow() {
    let path = std::env::var("MARKDAG_PIPELINE_CASES").expect("MARKDAG_PIPELINE_CASES");
    let mut totals = FramedTotals::default();
    let (compared, failed) = check_random(&read_json(Path::new(&path)), &mut totals);
    eprintln!("compared {compared}, errors {failed}, framed {totals:?}");
    assert!(compared > 0);
}
