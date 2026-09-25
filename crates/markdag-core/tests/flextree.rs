// flextree の移植 (layout/flextree.rs) が d3-flextree 2.1.2 と同じ座標を出すかの確かめ。
// 期待値は d3-flextree を vite-node で動かして書き出した JSON (tests/fixtures/flextree/。生成器は scripts/migration/fixtures/ の flextree 用)。f64 は to_bits で比べる
// (許容なし。-0 と +0 を見分け、NaN どうしは一致とみなす)。JSON で書けない数 (-0、NaN、±Infinity) は { "$number": "-0" } の形。
// 期待値に spacing の呼び出しの列 (calls) があれば、呼ばれた組とその順も比べる。
// 間隔の関数は配置の層 (layout.ts:100-105) の形: 親が同じなら spacingVertical、違えば 2 倍、に lineWidth(depth(a)) と
// 枠の余白の代わりの決まった値を足す。乱数の木の突き合わせは #[ignore] のテストで、環境変数の JSON を読む。
use std::collections::VecDeque;
use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use markdag_core::layout::flextree::{FlexTree, Placed};
use markdag_core::types::LayoutError;
use serde::Deserialize;

// 期待値の JSON の数。数か、JSON.stringify で書けない値の印 { "$number": "-0" | "NaN" | "Infinity" | "-Infinity" }
#[derive(Clone, Copy, Debug)]
struct Num(f64);

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Plain(f64),
            Marked {
                #[serde(rename = "$number")]
                number: String,
            },
        }
        match Raw::deserialize(deserializer)? {
            Raw::Plain(value) => Ok(Num(value)),
            Raw::Marked { number } => match number.as_str() {
                "-0" => Ok(Num(-0.0)),
                "NaN" => Ok(Num(f64::NAN)),
                "Infinity" => Ok(Num(f64::INFINITY)),
                "-Infinity" => Ok(Num(f64::NEG_INFINITY)),
                other => Err(serde::de::Error::custom(format!("$number {other}"))),
            },
        }
    }
}

fn same_bits(expected: Num, actual: f64) -> bool {
    (expected.0.is_nan() && actual.is_nan()) || expected.0.to_bits() == actual.to_bits()
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Spacing {
    Const { value: Num },
    Markdag { vertical: f64, extra: bool },
}

// 1 ノードの [id, x, y, xSize, ySize] (each の順)
type PlacedRow = (u32, Num, Num, Num, Num);

#[derive(Deserialize)]
struct Expected {
    placed: Option<Vec<PlacedRow>>,
    error: Option<String>,
    // spacing が受けた (a, b) の id の組の列 (呼ばれた順)
    calls: Option<Calls>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    root: u32,
    children: Vec<(u32, Vec<u32>)>,
    node_size: Vec<(u32, [Num; 2])>,
    spacing: Spacing,
    expected: Expected,
}

// spacing が受けた (a, b) の組の列
type Calls = Vec<(u32, u32)>;

// 配置の結果と、spacing が受けた組の列を返す
fn run(case: &Case) -> (Result<Vec<Placed>, LayoutError>, Calls) {
    let children: IndexMap<u32, Vec<u32>> = case.children.iter().cloned().collect();
    let node_size: IndexMap<u32, [f64; 2]> = case
        .node_size
        .iter()
        .map(|(id, [a, b])| (*id, [a.0, b.0]))
        .collect();
    let mut parent_of: IndexMap<u32, u32> = IndexMap::new();
    let mut depth_of: IndexMap<u32, u32> = IndexMap::from([(case.root, 0)]);
    let mut queue = VecDeque::from([case.root]);
    while let Some(id) = queue.pop_front() {
        let depth = depth_of[&id];
        for &kid in children.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            if !depth_of.contains_key(&kid) {
                parent_of.insert(kid, id);
                depth_of.insert(kid, depth + 1);
                queue.push_back(kid);
            }
        }
    }
    let mut calls = Vec::new();
    let mut spacing = |a: u32, b: u32| -> Result<f64, LayoutError> {
        calls.push((a, b));
        Ok(match case.spacing {
            Spacing::Const { value } => value.0,
            Spacing::Markdag { vertical, extra } => {
                let base = if parent_of.get(&a) == parent_of.get(&b) {
                    vertical
                } else {
                    vertical * 2.0
                };
                let line_width = 1.0 + 3.0 / 2f64.powf(f64::from(depth_of[&a]));
                let extra = if extra && (u64::from(a) * 7 + u64::from(b) * 13) % 5 == 0 {
                    12.5
                } else {
                    0.0
                };
                base + line_width + extra
            }
        })
    };
    let result = FlexTree::layout(case.root, &children, &node_size, &mut spacing);
    (result, calls)
}

// 一致しなければ最初の違いを文にする
fn compare(case: &Case) -> Result<(), String> {
    let (actual, calls) = run(case);
    if let Some(expected_calls) = &case.expected.calls
        && let Some(k) = (0..expected_calls.len().max(calls.len()))
            .find(|&k| expected_calls.get(k) != calls.get(k))
    {
        return Err(format!(
            "{}: spacing の {k} 番目の呼び出し 期待 {:?} 実際 {:?} (回数 {} と {})",
            case.name,
            expected_calls.get(k),
            calls.get(k),
            expected_calls.len(),
            calls.len()
        ));
    }
    match (&case.expected.placed, &case.expected.error, actual) {
        (Some(expected), None, Ok(actual)) => {
            if expected.len() != actual.len() {
                return Err(format!(
                    "{}: 個数 {} != {}",
                    case.name,
                    expected.len(),
                    actual.len()
                ));
            }
            for (k, (e, a)) in expected.iter().zip(&actual).enumerate() {
                let (id, x, y, x_size, y_size) = *e;
                let matches = id == a.id
                    && same_bits(x, a.x)
                    && same_bits(y, a.y)
                    && same_bits(x_size, a.x_size)
                    && same_bits(y_size, a.y_size);
                if !matches {
                    return Err(format!("{}: {k} 番目 期待 {e:?} 実際 {a:?}", case.name));
                }
            }
            Ok(())
        }
        (None, Some(message), Err(error)) => {
            let expected = message.strip_prefix("TypeError: ").unwrap_or(message);
            if expected == error.message {
                Ok(())
            } else {
                Err(format!(
                    "{}: 誤り {message:?} != {:?}",
                    case.name, error.message
                ))
            }
        }
        (_, _, actual) => Err(format!("{}: 期待と結果の種類が違う {actual:?}", case.name)),
    }
}

#[test]
fn flextree_matches_d3_flextree_fixtures() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/flextree");
    let mut names: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    names.sort();
    assert!(
        names.len() >= 7,
        "突き合わせの JSON が足りない: {}",
        names.len()
    );
    let failures: Vec<String> = names
        .iter()
        .map(|path| {
            let text = fs::read_to_string(path).unwrap();
            let case: Case = serde_json::from_str(&text).unwrap();
            compare(&case)
        })
        .filter_map(Result::err)
        .collect();
    assert!(failures.is_empty(), "{failures:#?}");
}

// 乱数の木を一度だけ突き合わせる: MARKDAG_FLEXTREE_RANDOM=<JSON の配列> cargo test -p markdag-core --test flextree -- --ignored
// (JSON の配列は同じ flextree 用の生成器の random の形で書く)
#[test]
#[ignore]
fn flextree_matches_d3_flextree_random_trees() {
    let Ok(path) = std::env::var("MARKDAG_FLEXTREE_RANDOM") else {
        panic!("MARKDAG_FLEXTREE_RANDOM に乱数の木の JSON を渡す");
    };
    let cases: Vec<Case> = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let errors = cases
        .iter()
        .filter(|case| case.expected.error.is_some())
        .count();
    let failures: Vec<String> = cases.iter().map(compare).filter_map(Result::err).collect();
    println!(
        "cases={} errors={} mismatches={}",
        cases.len(),
        errors,
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "{:#?}",
        &failures[..failures.len().min(10)]
    );
}
