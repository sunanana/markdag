// 審判の corpus (*.md) を parse_document、build_model、layout_document に通し、審判の期待値と同じ形の layout と layoutFolded を
// 1 文書 1 つ ({ "layout": …, "layoutFolded": … | null }) に書き出す (run.ts --candidate new --only layout の入力)。
// 入力の組み立て (疑似の大きさ、最初の折りたたみ) は tests/judge_harness.rs、期待値の形への変換は tests/judge_shape.rs を読む。
// build_model には types も hookRefs も渡さない (配置が読む relations、suppressRootLine、groups、groupsOf は両方に依らない)。
// 使い方: layout_corpus <corpus dir> <out dir>。失敗した文書は <名前>.error.txt に文面を書いて続ける。
#[path = "../tests/judge_harness.rs"]
mod judge_harness;
#[path = "../tests/judge_shape.rs"]
mod judge_shape;

use std::fs;
use std::panic;
use std::path::Path;

use indexmap::IndexSet;
use markdag_core::layout::pipeline::layout_document;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::parse::parse_document;
use serde_json::{Value, json};

fn layout_of(source: &str) -> Result<Value, String> {
    let parsed = parse_document(source);
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions::default(),
    );
    let section = |folded: &IndexSet<u32>| -> Result<Value, String> {
        let input = judge_harness::layout_input(
            &parsed.nodes,
            &model.relations,
            &model.suppress_root_line,
            folded,
        );
        let result = layout_document(&input, &model.groups, &model.groups_of, None, None)
            .map_err(|error| error.message)?;
        let boundary = serde_json::to_value(&result).map_err(|error| error.to_string())?;
        judge_shape::expected_layout_document_from_boundary(
            &boundary,
            &folded.iter().copied().collect::<Vec<_>>(),
        )
    };
    let folded = judge_harness::initial_fold(
        &parsed.nodes,
        judge_harness::expand_level_of(&parsed.frontmatter),
    );
    let layout = section(&IndexSet::new())?;
    let layout_folded = if folded.is_empty() {
        Value::Null
    } else {
        section(&folded)?
    };
    Ok(json!({ "layout": layout, "layoutFolded": layout_folded }))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(corpus), Some(out)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: layout_corpus <corpus dir> <out dir>");
        std::process::exit(2);
    };
    if let Err(error) = fs::create_dir_all(out) {
        eprintln!("{out}: {error}");
        std::process::exit(1);
    }
    let mut entries: Vec<_> = match fs::read_dir(corpus) {
        Ok(dir) => dir
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "md"))
            .collect(),
        Err(error) => {
            eprintln!("{corpus}: {error}");
            std::process::exit(1);
        }
    };
    entries.sort();
    panic::set_hook(Box::new(|_| {}));
    let (mut ok, mut failed) = (0, 0);
    for path in entries {
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let result = fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|source| {
                panic::catch_unwind(|| layout_of(&source))
                    .map_err(|payload| {
                        payload
                            .downcast_ref::<String>()
                            .cloned()
                            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_else(|| "panic".to_string())
                    })
                    .and_then(|result| result)
            });
        match result
            .and_then(|value| serde_json::to_string_pretty(&value).map_err(|e| e.to_string()))
        {
            Ok(json) => {
                let _ = fs::write(Path::new(out).join(format!("{name}.json")), json);
                ok += 1;
            }
            Err(message) => {
                let _ = fs::write(Path::new(out).join(format!("{name}.error.txt")), message);
                eprintln!("failed: {name}");
                failed += 1;
            }
        }
    }
    println!("{ok} ok, {failed} failed");
}
