// 配置の流れ (layout/pipeline.rs の layout_document) が、旧実装の view の配置の流れ (src/view/view.ts の update) と同じ結果を出すかの確かめ。
// f64 は to_bits で比べる (許容なし、-0 の符号まで)。
// (1) 審判のコーパス (tests/fixtures/judge/expected/*.json) の layout と layoutFolded の 62 件。入力は期待値の parsed と model から
//     harness と同じ規則 (tests/judge_harness.rs) で組み、layout_document の出力を judge_shape で期待値の形にして、
//     folded、graph、frames (outline つき)、rects、gaps、edges、bounds、plannedX、nodeSize、passes を比べる。
// (2) 同じ 62 件の回ごとの値を、旧実装で view の繰り返しを回した記録 (tests/fixtures/pipeline/corpus.json。
//     scripts/migration/fixtures/pipeline.ts が書く) と比べる。回 k の配置は max_passes を k にした layout_document の結果
//     (k 回目より前に入り込みが 0 になっていないので、k 回目で打ち切られる)。比べるもの: 配置の 6 つの欄、flextree が呼んだ
//     spacing の組の順と合計、枠の余白 (前回の矩形から作った FrameSpacing の between) の値、countIntruders
// (3) 乱数の入力 (tests/fixtures/pipeline/random.json、options と ignoreProxiedDepends と回数の上限を変える) で (2) と同じもの。
//     件数を増やした突き合わせは #[ignore] のテストで、環境変数 MARKDAG_PIPELINE_CASES の JSON を読む
#[path = "judge_harness.rs"]
mod judge_harness;
#[path = "judge_shape.rs"]
mod judge_shape;

use std::fs;
use std::path::Path;

use indexmap::{IndexMap, IndexSet};
use markdag_core::layout::frames::{Frame, count_intruders, frame_spacing};
use markdag_core::layout::layout::{LayoutOptions, MARKMAP_DEFAULTS};
use markdag_core::layout::pipeline::{LayoutDocumentResult, MAX_LAYOUT_PASSES, layout_document};
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
    let mut pass_counts: IndexMap<usize, usize> = IndexMap::new();
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
            let (result, count) = check_passes(&case, record["passes"].as_array().unwrap());
            calls += count;
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
            assert_same(layout, &actual, &name);
            compared += 1;
            with_frames += usize::from(!result.frames.is_empty());
            frame_count += result.frames.len();
            *pass_counts.entry(result.passes).or_default() += 1;
        }
    }
    assert_eq!(compared, 62);
    assert_eq!((with_frames, frame_count), (7, 27));
    assert_eq!(pass_counts.get(&1).copied(), Some(57));
    assert_eq!(pass_counts.get(&2).copied(), Some(2));
    assert_eq!(pass_counts.get(&4).copied(), Some(3));
    assert!(calls > 0);
}

fn check_random(cases: &Value) -> (usize, usize) {
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
        let (result, _) = check_passes(&run, case["passes"].as_array().unwrap());
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
                json!({
                    "group": index,
                    "members": frame.frame.members,
                    "level": frame.frame.level,
                    "outline": frame.outline.as_ref().map(rect_row),
                })
            })
            .collect();
        assert_same(&case["frames"], &json!(frames), &format!("{name}/frames"));
        compared += 1;
    }
    (compared, failed)
}

#[test]
fn pipeline_random_cases_match_the_old_view_flow() {
    let (compared, failed) = check_random(&fixture("random.json"));
    assert_eq!((compared, failed), (150, 0));
}

#[test]
#[ignore = "MARKDAG_PIPELINE_CASES に scripts/migration/fixtures/pipeline.ts が書いた random.json のパスを渡す"]
fn pipeline_random_cases_from_env_match_the_old_view_flow() {
    let path = std::env::var("MARKDAG_PIPELINE_CASES").expect("MARKDAG_PIPELINE_CASES");
    let (compared, failed) = check_random(&read_json(Path::new(&path)));
    eprintln!("compared {compared}, errors {failed}");
    assert!(compared > 0);
}
