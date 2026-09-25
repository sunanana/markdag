// 審判の corpus (*.md) を parse_document にかけ、境界の JSON の形 (ParsedDocument) で 1 文書 1 つに書き出す (審判の parsed の突き合わせ用)。
// 使い方: parse_corpus <corpus dir> <out dir>。失敗した文書は <名前>.error.txt に文面を書いて続ける。
use std::fs;
use std::panic;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(corpus), Some(out)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: parse_corpus <corpus dir> <out dir>");
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
                panic::catch_unwind(|| markdag_core::parse::parse_document(&source)).map_err(
                    |payload| {
                        payload
                            .downcast_ref::<String>()
                            .cloned()
                            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                            .unwrap_or_else(|| "panic".to_string())
                    },
                )
            });
        match result
            .and_then(|parsed| serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string()))
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
