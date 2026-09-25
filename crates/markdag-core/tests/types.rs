// 共有の型 (crate::types) が、審判の期待値 57 件の parsed と model のデータ部分を読み書きできるかの確かめ。
// 期待値を境界の形に直し (judge_shape)、ParsedDocument / GraphModel に読み、書き出した JSON が元と値として等しいことを見る
// (model は書き出しを期待値の形に戻し、期待値そのものと比べる)。
#[path = "judge_shape.rs"]
mod judge_shape;

use std::fs;
use std::path::{Path, PathBuf};

use markdag_core::types::{GraphModel, ParsedDocument};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

const EXPECTED_COUNT: usize = 57;

fn expected_files() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/judge/expected");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

// 読めなければ、serde の誤り (欄の名前を含む) と、誤りの行の前後を出す
fn read_as<T: DeserializeOwned>(value: &Value) -> Result<T, String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| {
        let lines: Vec<&str> = text.lines().collect();
        let at = error.line().saturating_sub(1);
        let context = lines[at.saturating_sub(4)..(at + 3).min(lines.len())].join("\n");
        format!("{error}\n---\n{context}\n---")
    })
}

// 境界の形の値を型に読んで書き戻し、to_expected で比べる形にして want と比べる
fn round_trip<T: DeserializeOwned + Serialize>(
    value: &Value,
    want: &Value,
    to_expected: fn(&Value) -> Result<Value, String>,
    label: &str,
) -> Result<(), String> {
    let typed: T = read_as(value).map_err(|error| format!("{label} が読めない: {error}"))?;
    let written =
        serde_json::to_value(&typed).map_err(|error| format!("{label} が書けない: {error}"))?;
    let written = to_expected(&written)
        .map_err(|error| format!("{label} を期待値の形にできない: {error}"))?;
    match judge_shape::first_difference(want, &written, "") {
        Some(difference) => Err(format!("{label} が往復で変わった: {difference}")),
        None => Ok(()),
    }
}

fn as_is(value: &Value) -> Result<Value, String> {
    Ok(value.clone())
}

#[test]
fn types_read_and_write_every_expected_document() {
    let files = expected_files();
    assert_eq!(files.len(), EXPECTED_COUNT, "期待値の件数");
    let mut failures = Vec::new();
    for file in &files {
        let name = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let result = fs::read_to_string(file)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
            })
            .and_then(|expected| {
                let (parsed, model) = judge_shape::boundary_from_expected(&expected)?;
                // parsed は Rust に DOM が無いので境界の形で比べ、model は Rust の出力を期待値の形に直して比べる
                round_trip::<ParsedDocument>(&parsed, &parsed, as_is, "parsed")?;
                let want = expected.get("model").ok_or("model の欄がない")?;
                round_trip::<GraphModel>(
                    &model,
                    want,
                    judge_shape::expected_model_from_boundary,
                    "model",
                )
            });
        if let Err(error) = result {
            failures.push(format!("{name}: {error}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} / {} 件が失敗:\n{}",
        failures.len(),
        files.len(),
        failures.join("\n\n")
    );
}
