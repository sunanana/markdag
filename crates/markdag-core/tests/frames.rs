// グループの枠 (layout/frames.rs) が旧実装 (src/view/frames.ts) と同じ値を出すかの確かめ。f64 は to_bits で比べる (許容なし)。
// 入力と期待値は scripts/migration/fixtures/ の枠の生成器が旧実装を vite-node で動かして書いた乱数の入力
// (tests/fixtures/frames/random.json)。1 件ごとに次を比べる:
//   compute_frames (group の同一性は groups の添字)、harness と同じ繰り返し (layout_graph に extra_spacing を渡す) の回数と
//   回ごとの count_intruders、最後の回の追加の間隔の呼び出しの組と値 (FrameSpacing::between と flextree に渡った spacing)、
//   最後の回の枠の矩形と bounds、乱数の rects に対する frame_outline / count_intruders / between (rects あり、なし)
// 件数を増やした突き合わせは #[ignore] のテストで、環境変数の JSON を読む。
use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use markdag_core::layout::frames::{
    Frame, compute_frames, count_intruders, frame_outline, frame_spacing,
};
use markdag_core::layout::layout::{ExtraSpacing, LayoutOptions, MARKMAP_DEFAULTS, layout_graph};
use markdag_core::layout::project::VisibleGraph;
use markdag_core::types::{GroupDef, Rect};
use serde_json::{Value, json};

const MAX_LAYOUT_PASSES: usize = 4;

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

// JSON の数か、有限でない数と -0 の印を f64 に
fn number_of(value: &Value) -> f64 {
    if let Some(number) = value.as_f64() {
        return number;
    }
    match value["$number"].as_str().unwrap() {
        "-0" => -0.0,
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        other => panic!("知らない印 {other}"),
    }
}

fn same_bits(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

fn rect_of(values: &[Value]) -> Rect {
    Rect {
        x: number_of(&values[0]),
        y: number_of(&values[1]),
        width: number_of(&values[2]),
        height: number_of(&values[3]),
    }
}

fn same_rect(expected: &Value, actual: Option<Rect>) -> bool {
    match (expected.as_array(), actual) {
        (None, None) => true,
        (Some(values), Some(rect)) => {
            let expected = rect_of(values);
            same_bits(expected.x, rect.x)
                && same_bits(expected.y, rect.y)
                && same_bits(expected.width, rect.width)
                && same_bits(expected.height, rect.height)
        }
        _ => false,
    }
}

fn pairs_of<T: serde::de::DeserializeOwned>(value: &Value) -> IndexMap<u32, T> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| serde_json::from_value(pair.clone()).unwrap())
        .collect()
}

#[derive(Default)]
struct Counts {
    cases: usize,
    with_frames: usize,
    frames: usize,
    multi_pass: usize,
    last_calls: usize,
    pairs: usize,
}

// 1 件を比べる。違えば最初の場所を返す
fn check_case(case: &Value, counts: &mut Counts) -> Result<(), String> {
    let name = case["name"].as_str().unwrap();
    let graph: VisibleGraph = serde_json::from_value(case["graph"].clone()).unwrap();
    let groups: Vec<GroupDef> = serde_json::from_value(case["groups"].clone()).unwrap();
    let groups_of: IndexMap<u32, Vec<String>> = pairs_of(&case["groupsOf"]);
    let sibling_order: IndexMap<u32, Vec<u32>> = pairs_of(&case["siblingOrder"]);

    let frames = compute_frames(&graph, &groups, &groups_of, &sibling_order);
    // 枠の group は groups の添字で比べる (同じ id のグループが 2 つあっても取り違えない。label は添字から作ってある)
    let rows: Vec<Value> = frames
        .iter()
        .map(|frame: &Frame| {
            let index = frame
                .group
                .label
                .trim_start_matches('g')
                .parse::<usize>()
                .unwrap();
            assert_eq!(groups[index], frame.group, "{name}: group の中身");
            json!([index, frame.members, frame.level])
        })
        .collect();
    if json!(rows) != case["frames"] {
        return Err(format!(
            "{name}: frames (期待 {}、実際 {})",
            case["frames"],
            json!(rows)
        ));
    }
    counts.cases += 1;
    counts.with_frames += usize::from(!frames.is_empty());
    counts.frames += frames.len();

    // harness と同じ繰り返し
    let expected_loop = &case["loop"];
    if expected_loop.get("error").is_some() {
        return Err(format!(
            "{name}: 旧実装が失敗した入力はこの生成器では出ない"
        ));
    }
    let mut previous: Option<IndexMap<u32, Rect>> = None;
    let mut intruders: Vec<usize> = Vec::new();
    let (result, rects, last_previous) = loop {
        let options = LayoutOptions {
            extra_spacing: Some(ExtraSpacing {
                frames: frames.clone(),
                rects: previous.clone(),
            }),
            ..MARKMAP_DEFAULTS
        };
        let result = layout_graph(&graph, Some(options)).map_err(|e| format!("{name}: {e}"))?;
        let rects: IndexMap<u32, Rect> = result
            .nodes
            .iter()
            .map(|(id, placed)| (*id, placed.rect))
            .collect();
        let count = count_intruders(&frames, &rects);
        intruders.push(count);
        if count == 0 || intruders.len() == MAX_LAYOUT_PASSES {
            break (result, rects, previous);
        }
        previous = Some(rects);
    };
    if json!(intruders.len()) != expected_loop["passes"]
        || json!(intruders) != expected_loop["intruders"]
    {
        return Err(format!(
            "{name}: 回数 (期待 {}、実際 {:?})",
            expected_loop["intruders"], intruders
        ));
    }
    counts.multi_pass += usize::from(intruders.len() > 1);

    let calls = expected_loop["calls"].as_array().unwrap();
    if calls.len() != result.flextree_params.spacing.len() {
        return Err(format!("{name}: 最後の回の呼び出しの数"));
    }
    let spacing = frame_spacing(&frames, last_previous.as_ref());
    for (index, (call, expected)) in result.flextree_params.spacing.iter().zip(calls).enumerate() {
        if (json!(call.upper), json!(call.lower)) != (expected[0].clone(), expected[1].clone()) {
            return Err(format!("{name}: 最後の回の {index} 回目の組"));
        }
        let value = number_of(&expected[2]);
        if !same_bits(spacing.between(call.upper, call.lower), value) {
            return Err(format!("{name}: 最後の回の {index} 回目の値"));
        }
        let depth = graph
            .nodes
            .iter()
            .find(|node| node.id == call.upper)
            .unwrap()
            .depth;
        let base = if graph.layout_parent.get(&call.upper) == graph.layout_parent.get(&call.lower) {
            MARKMAP_DEFAULTS.spacing_vertical
        } else {
            MARKMAP_DEFAULTS.spacing_vertical * 2.0
        };
        if !same_bits(
            call.value,
            base + MARKMAP_DEFAULTS.line_width.at(depth) + value,
        ) {
            return Err(format!("{name}: 最後の回の {index} 回目の spacing"));
        }
    }
    counts.last_calls += calls.len();
    for (index, frame) in frames.iter().enumerate() {
        if !same_rect(
            &expected_loop["outlines"][index],
            frame_outline(frame, &rects),
        ) {
            return Err(format!("{name}: 最後の回の枠 {index} の矩形"));
        }
    }
    if !same_rect(&expected_loop["bounds"], Some(result.bounds)) {
        return Err(format!("{name}: bounds"));
    }

    // 乱数の rects
    let random = &case["random"];
    let random_rects: IndexMap<u32, Rect> = random["rects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let row = row.as_array().unwrap();
            (row[0].as_u64().unwrap() as u32, rect_of(&row[1..]))
        })
        .collect();
    for (index, frame) in frames.iter().enumerate() {
        if !same_rect(
            &random["outlines"][index],
            frame_outline(frame, &random_rects),
        ) {
            return Err(format!("{name}: 乱数の rects の枠 {index} の矩形"));
        }
    }
    if json!(count_intruders(&frames, &random_rects)) != random["intruders"] {
        return Err(format!("{name}: 乱数の rects の count_intruders"));
    }
    let with_rects = frame_spacing(&frames, Some(&random_rects));
    let without = frame_spacing(&frames, None);
    for pair in random["pairs"].as_array().unwrap() {
        let (upper, lower) = (
            pair[0].as_u64().unwrap() as u32,
            pair[1].as_u64().unwrap() as u32,
        );
        if !same_bits(with_rects.between(upper, lower), number_of(&pair[2]))
            || !same_bits(without.between(upper, lower), number_of(&pair[3]))
        {
            return Err(format!("{name}: 乱数の rects の between({upper}, {lower})"));
        }
        counts.pairs += 1;
    }
    Ok(())
}

fn check_file(path: &Path) -> Counts {
    let cases = read_json(path);
    let mut counts = Counts::default();
    let mismatches: Vec<String> = cases
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|case| check_case(case, &mut counts).err())
        .collect();
    assert!(
        mismatches.is_empty(),
        "{} 件の不一致。最初: {}",
        mismatches.len(),
        mismatches[0]
    );
    eprintln!(
        "cases {} withFrames {} frames {} multiPass {} lastCalls {} pairs {}",
        counts.cases,
        counts.with_frames,
        counts.frames,
        counts.multi_pass,
        counts.last_calls,
        counts.pairs
    );
    counts
}

#[test]
fn frames_random_cases_match_the_old_implementation() {
    let counts = check_file(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/frames/random.json"),
    );
    assert_eq!(counts.cases, 300);
    // 枠ができる入力と、2 回以上配置する入力が十分にあること (生成器の件数と種の値)
    assert!(counts.with_frames >= 100 && counts.multi_pass >= 50);
}

// MARKDAG_FRAMES_CASES=<json のパス (カンマ区切りで複数)> cargo test -p markdag-core --test frames -- --ignored。
// json は枠の生成器に出力先のディレクトリと件数を渡して書く
#[test]
#[ignore]
fn frames_random_cases_from_env_match_the_old_implementation() {
    let Ok(paths) = std::env::var("MARKDAG_FRAMES_CASES") else {
        panic!("MARKDAG_FRAMES_CASES が無い");
    };
    for path in paths.split(',') {
        check_file(Path::new(path));
    }
}
