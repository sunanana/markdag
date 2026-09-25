// 審判の corpus (*.md) を parse_document と build_model に通し (frontmatter は Rust の解析の出力。期待値の frontmatter は使わない)、
// 審判の期待値と同じ形の model を 1 文書 1 つ ({ "model": … }) に書き出す (run.ts --candidate new --only model の入力)。
// types の $ref の中身とフックの形は審判の harness と同じ規則で tests/judge_inputs.rs が読み、期待値の形への変換は tests/judge_shape.rs が持つ。
// 使い方: model_corpus <corpus dir> <out dir>。失敗した文書は <名前>.error.txt に文面を書いて続ける。
#[path = "../tests/judge_inputs.rs"]
mod judge_inputs;
#[path = "../tests/judge_shape.rs"]
mod judge_shape;

use std::fs;
use std::panic;
use std::path::Path;

use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::parse::parse_document;
use serde_json::{Value, json};

fn model_of(corpus: &Path, name: &str, source: &str) -> Result<Value, String> {
    let parsed = parse_document(source);
    let types = judge_inputs::load_type_refs(&parsed.frontmatter, corpus);
    let hook_refs = judge_inputs::load_hook_spec(&corpus.join(format!("{name}.hooks.json")))?;
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions {
            types: Some(types),
            hook_refs,
        },
    );
    let boundary = serde_json::to_value(&model).map_err(|error| error.to_string())?;
    Ok(json!({ "model": judge_shape::expected_model_from_boundary(&boundary)? }))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(corpus), Some(out)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: model_corpus <corpus dir> <out dir>");
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
                panic::catch_unwind(|| model_of(Path::new(corpus), &name, &source))
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
