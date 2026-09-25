// 審判の期待値 (tests/fixtures/judge/expected/*.json) の model.diagnostics のうち、frontmatter の検査の段
// (locator の構文の誤り、schema の検査、tags の型の解決と本文のタグの検査) が出す診断を、
// code、位置、文面、hint、severity まで突き合わせる。
// 入力は期待値の parsed (nodes と frontmatter) と corpus の原文で、本物の build_model に通す。parse の写しは使わない。
// relations / groups の members / refs / 閉路 / hooks / rules / tasks.cycle / branches から出る診断は、
// 期待値と build_model の出力の両方から同じ規則 (is_model_only) で除いて比べる (model 全体の突き合わせは別のテスト)。
#[path = "judge_inputs.rs"]
mod judge_inputs;
#[path = "judge_shape.rs"]
mod judge_shape;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::util::JsValue;
use markdag_core::types::ParsedDocument;
use serde_json::Value;

const EXPECTED_COUNT: usize = 57;

fn expected_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/judge/expected")
}

// 入力の文書は Rust と JS のテストが共有するので、リポジトリ直下の testdata に置く
fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata/judge/corpus")
}

fn expected_files() -> Vec<PathBuf> {
    let dir = expected_dir();
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

// ---- 審判の取り決め ----

// buildModel の、frontmatter の検査のあとの段 (relations、groups の members、refs、閉路、hooks、rules、tasks、branches) だけが出す code
const MODEL_ONLY_CODES: &[&str] = &[
    "cycle",
    "duplicate-edge",
    "self-loop",
    "shape-mismatch",
    "not-supported",
    "ref-not-found",
    "ref-ambiguous",
    "ref-prefix",
    "selector-empty",
    "hook-invalid-export",
    "hook-unknown-export",
    "hooks-unresolved",
];

// code が schema と model の両方から出るものは、model の段の文面の形で見分ける
fn is_model_only(diagnostic: &Value) -> bool {
    let code = diagnostic["code"].as_str().unwrap_or("");
    let message = diagnostic["message"].as_str().unwrap_or("");
    if MODEL_ONLY_CODES.contains(&code) {
        return true;
    }
    match code {
        // rules の readonlyGroups、tasks.cycle の長さ、branches の SelectorError
        "option-invalid" => {
            message.starts_with("markdag.rules.taskToggle.readonlyGroups: ")
                || message.starts_with("markdag.tasks.cycle: ")
                || message.starts_with("markdag.branches: ")
        }
        // groups の members の SelectorError (`markdag.groups.<id>.members「…」: …`)
        "group-invalid" => message.starts_with("markdag.groups.") && message.contains(".members「"),
        // relations の式の SelectorError (`「式」: …`)。schema の relation-syntax は `markdag.relations…` で始まる
        "relation-syntax" => message.starts_with('「'),
        _ => false,
    }
}

// A-005 / A-023 / A-024: yaml-syntax は message の最初の「: 」より後ろ (YAML の実装の文面) を比べない
fn normalized(diagnostic: &Value) -> Value {
    let mut diagnostic = diagnostic.clone();
    if diagnostic["code"] == "yaml-syntax"
        && let Some(message) = diagnostic["message"].as_str()
    {
        let cut = message
            .find(": ")
            .map_or(message, |at| &message[..at])
            .to_string();
        diagnostic["message"] = Value::String(format!("{cut}: (yaml-syntax: この後ろは比べない)"));
    }
    diagnostic
}

// accepted.md #5 (A-024): 構文の誤りが 2 つ以上あると saphyr は 1 件目で止まる。Rust が 1 件なら、期待値の 2 件目以降を落とす
fn drop_later_yaml_errors(expected: Vec<Value>, actual: &[Value]) -> Vec<Value> {
    let actual_count = actual
        .iter()
        .filter(|item| item["code"] == "yaml-syntax")
        .count();
    if actual_count != 1 {
        return expected;
    }
    let mut seen = 0;
    expected
        .into_iter()
        .filter(|item| {
            if item["code"] != "yaml-syntax" {
                return true;
            }
            seen += 1;
            seen == 1
        })
        .collect()
}

struct DocumentResult {
    // code ごとの (比べた件数、一致した件数)
    per_code: BTreeMap<String, (usize, usize)>,
    excluded: BTreeMap<String, usize>,
    difference: Option<String>,
}

fn run_document(file: &Path) -> Result<DocumentResult, String> {
    let name = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default();
    let text = fs::read_to_string(file).map_err(|error| error.to_string())?;
    let expected: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let (parsed_boundary, _) = judge_shape::boundary_from_expected(&expected)?;
    let parsed: ParsedDocument = serde_json::from_value(parsed_boundary)
        .map_err(|error| format!("parsed を読めない: {error}"))?;
    let frontmatter: JsValue = serde_json::from_value(expected["parsed"]["frontmatter"].clone())
        .map_err(|error| format!("frontmatter を読めない: {error}"))?;
    let corpus = corpus_dir();
    let markdown = fs::read_to_string(corpus.join(format!("{name}.md")))
        .map_err(|error| format!("corpus の原文: {error}"))?;
    let types = judge_inputs::load_type_refs(&frontmatter, &corpus);

    let hook_refs = judge_inputs::load_hook_spec(&corpus.join(format!("{name}.hooks.json")))?;
    let model = build_model(
        &parsed.nodes,
        &frontmatter,
        Some(&markdown),
        &ModelOptions {
            types: Some(types),
            hook_refs,
        },
    );
    let actual: Vec<Value> = model
        .diagnostics
        .iter()
        .map(|diagnostic| serde_json::to_value(diagnostic).expect("Diagnostic は JSON に書ける"))
        .filter(|diagnostic| !is_model_only(diagnostic))
        .collect();
    let all = expected["model"]["diagnostics"]
        .as_array()
        .ok_or("model.diagnostics が配列でない")?;
    let mut excluded = BTreeMap::new();
    let mut wanted = Vec::new();
    for item in all {
        if is_model_only(item) {
            *excluded
                .entry(item["code"].as_str().unwrap_or("").to_string())
                .or_insert(0) += 1;
        } else {
            wanted.push(item.clone());
        }
    }
    let wanted: Vec<Value> = drop_later_yaml_errors(wanted, &actual)
        .iter()
        .map(normalized)
        .collect();
    let actual: Vec<Value> = actual.iter().map(normalized).collect();

    let mut per_code: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (index, want) in wanted.iter().enumerate() {
        let entry = per_code
            .entry(want["code"].as_str().unwrap_or("").to_string())
            .or_insert((0, 0));
        entry.0 += 1;
        if actual
            .get(index)
            .is_some_and(|got| judge_shape::first_difference(want, got, "").is_none())
        {
            entry.1 += 1;
        }
    }
    let difference = judge_shape::first_difference(
        &Value::Array(wanted.clone()),
        &Value::Array(actual.clone()),
        "",
    )
    .map(|first| {
        let show = |items: &[Value]| {
            items
                .iter()
                .map(|item| format!("    {item}"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        format!(
            "{first}\n  期待:\n{}\n  実際:\n{}",
            show(&wanted),
            show(&actual)
        )
    });
    Ok(DocumentResult {
        per_code,
        excluded,
        difference,
    })
}

// 本体の誤りで落ちる文書 (#[ignore] のテストで別に見る)。文書名と理由
const KNOWN_BODY_BUGS: &[(&str, &str)] = &[(
    "edge-yaml-error",
    "閉じない二重引用符が複数行にわたる frontmatter で、yaml-syntax の位置が違う。旧実装 (eemeli/yaml の Missing closing \"quote) は \
     frontmatter の最後の行 8:5+6、locator.rs (saphyr の found unexpected end of stream) は引用符の始まりの行 2:1+17。\
     A-097 として依頼者が決定済みの差にした (accepted.md の 18 行目)",
)];

fn run(names: Option<&[&str]>) -> (Vec<String>, String) {
    let files = expected_files();
    assert_eq!(files.len(), EXPECTED_COUNT, "期待値の件数");
    let mut failures = Vec::new();
    let mut lines = Vec::new();
    let mut totals: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut excluded_totals: BTreeMap<String, usize> = BTreeMap::new();
    let mut documents = 0;
    for file in &files {
        let name = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let known = KNOWN_BODY_BUGS.iter().any(|(bug, _)| *bug == name);
        match names {
            Some(only) if !only.contains(&name.as_str()) => continue,
            None if known => continue,
            _ => {}
        }
        documents += 1;
        match run_document(file) {
            Ok(result) => {
                let compared: usize = result.per_code.values().map(|(count, _)| count).sum();
                let matched: usize = result.per_code.values().map(|(_, ok)| ok).sum();
                let status = if result.difference.is_none() {
                    "ok"
                } else {
                    "NG"
                };
                lines.push(format!("{status} {name}: {matched}/{compared} 件一致"));
                for (code, (count, ok)) in &result.per_code {
                    let total = totals.entry(code.clone()).or_insert((0, 0));
                    total.0 += count;
                    total.1 += ok;
                }
                for (code, count) in &result.excluded {
                    *excluded_totals.entry(code.clone()).or_insert(0) += count;
                }
                if let Some(difference) = result.difference {
                    failures.push(format!("{name}: {difference}"));
                }
            }
            Err(error) => failures.push(format!("{name}: 入力を作れない: {error}")),
        }
    }
    lines.push(format!("文書 {documents} 件"));
    for (code, (count, ok)) in &totals {
        lines.push(format!("  {code}: {ok}/{count}"));
    }
    lines.push("除いた code (model のタスク):".to_string());
    for (code, count) in &excluded_totals {
        lines.push(format!("  {code}: {count}"));
    }
    (failures, lines.join("\n"))
}

#[test]
fn judge_diagnostics_from_schema_and_tags_match_expected() {
    let (failures, summary) = run(None);
    println!("{summary}");
    assert!(
        failures.is_empty(),
        "{} 件の文書で差:\n{}\n\n{summary}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
#[ignore = "本体の誤りで落ちる文書 (KNOWN_BODY_BUGS)。直ったら一覧から外す"]
fn judge_diagnostics_known_body_bugs() {
    let names: Vec<&str> = KNOWN_BODY_BUGS.iter().map(|(name, _)| *name).collect();
    let (failures, summary) = run(Some(&names));
    println!("{summary}");
    assert!(
        failures.is_empty(),
        "{} 件の文書で差:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

// ---- model 全体の突き合わせ ----
// build_model の出力 (境界の形) を judge_shape で期待値の形に直し、期待値の model と欄ごとに比べる。
// diagnostics の yaml-syntax は上と同じ取り決め (normalized、drop_later_yaml_errors) を両側に当てる。

// 決定済みの差と本体の誤りで、model 全体が一致しない文書。文書名、差の場所 (model からの JSON Pointer)、理由。
// 差の場所の値が両側で違うことを確かめてから、その値だけを期待値に置き換えて残りを比べる (他の欄の差は失敗にする)。
// edge-numeric-group-keys (決定 8 の groups の並び) は、入力の frontmatter が期待値の JSON (旧実装が JS の順に並べ直したもの)
// なのでここでは差が出ない。書かれた順の入力での並びは model 層の単体テストと、審判の model (examples/model_corpus の
// parse → build_model の通し。accepted.md の 1 行目の差として出る) が確かめる
const MODEL_KNOWN_DIFFERENCES: &[(&str, &str, &str)] = &[(
    "edge-yaml-error",
    "/diagnostics/0/at",
    "KNOWN_BODY_BUGS と同じ yaml-syntax の位置の差",
)];

// 既知の差の場所を除いた比べの結果。known_differs は既知の差の場所の値が両側で違ったか
struct ModelComparison {
    known_differs: bool,
    difference: Option<String>,
}

fn model_difference(file: &Path, known_pointer: Option<&str>) -> Result<ModelComparison, String> {
    let name = file
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default();
    let text = fs::read_to_string(file).map_err(|error| error.to_string())?;
    let expected: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let (parsed_boundary, _) = judge_shape::boundary_from_expected(&expected)?;
    let parsed: ParsedDocument = serde_json::from_value(parsed_boundary)
        .map_err(|error| format!("parsed を読めない: {error}"))?;
    let frontmatter: JsValue = serde_json::from_value(expected["parsed"]["frontmatter"].clone())
        .map_err(|error| format!("frontmatter を読めない: {error}"))?;
    let corpus = corpus_dir();
    let markdown = fs::read_to_string(corpus.join(format!("{name}.md")))
        .map_err(|error| format!("corpus の原文: {error}"))?;
    let types = judge_inputs::load_type_refs(&frontmatter, &corpus);
    let hook_refs = judge_inputs::load_hook_spec(&corpus.join(format!("{name}.hooks.json")))?;
    let model = build_model(
        &parsed.nodes,
        &frontmatter,
        Some(&markdown),
        &ModelOptions {
            types: Some(types),
            hook_refs,
        },
    );
    let boundary = serde_json::to_value(&model)
        .map_err(|error| format!("model を JSON に書けない: {error}"))?;
    let mut actual = judge_shape::expected_model_from_boundary(&boundary)?;
    let mut wanted = expected["model"].clone();
    let actual_diagnostics = actual["diagnostics"]
        .as_array()
        .cloned()
        .ok_or("diagnostics が配列でない")?;
    let wanted_diagnostics = wanted["diagnostics"]
        .as_array()
        .cloned()
        .ok_or("期待値の diagnostics が配列でない")?;
    wanted["diagnostics"] = Value::Array(
        drop_later_yaml_errors(wanted_diagnostics, &actual_diagnostics)
            .iter()
            .map(normalized)
            .collect(),
    );
    actual["diagnostics"] = Value::Array(actual_diagnostics.iter().map(normalized).collect());
    let mut known_differs = false;
    if let Some(pointer) = known_pointer {
        let wanted_value = wanted
            .pointer(pointer)
            .cloned()
            .ok_or(format!("期待値に既知の差の場所 {pointer} がない"))?;
        let actual_value = actual
            .pointer_mut(pointer)
            .ok_or(format!("出力に既知の差の場所 {pointer} がない"))?;
        known_differs = *actual_value != wanted_value;
        *actual_value = wanted_value;
    }
    Ok(ModelComparison {
        known_differs,
        difference: judge_shape::first_difference(&wanted, &actual, "/model"),
    })
}

#[test]
fn judge_model_matches_expected() {
    let files = expected_files();
    assert_eq!(files.len(), EXPECTED_COUNT, "期待値の件数");
    let mut failures = Vec::new();
    let mut known = Vec::new();
    let mut matched = 0;
    for file in &files {
        let name = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let known_pointer = MODEL_KNOWN_DIFFERENCES
            .iter()
            .find(|(known, _, _)| *known == name)
            .map(|(_, pointer, _)| *pointer);
        match (model_difference(file, known_pointer), known_pointer) {
            (
                Ok(ModelComparison {
                    difference: Some(difference),
                    ..
                }),
                _,
            ) => failures.push(format!("{name}: {difference}")),
            (
                Ok(ModelComparison {
                    known_differs: false,
                    ..
                }),
                Some(pointer),
            ) => failures.push(format!(
                "{name}: 既知の差 (/model{pointer}) が一致した。MODEL_KNOWN_DIFFERENCES から外す"
            )),
            (Ok(_), Some(pointer)) => {
                known.push(format!("{name}: /model{pointer} (既知の差の他は一致)"))
            }
            (Ok(_), None) => matched += 1,
            (Err(error), _) => failures.push(format!("{name}: 入力を作れない: {error}")),
        }
    }
    println!(
        "model 一致 {matched}/{} (既知の差 {} 件)\n{}",
        files.len(),
        known.len(),
        known.join("\n")
    );
    assert!(
        failures.is_empty(),
        "{} 件の文書で差:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
