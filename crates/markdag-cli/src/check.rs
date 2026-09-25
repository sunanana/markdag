// 原文: scripts/check.ts (2026-09-25)
// check のサブコマンド。Node の check (npm run check、--hooks なし) と同じ診断を同じ形で出す。
// 集め方は render が描く前に出すものと同じ: 解析と組み立て、markdag のキーがない文書の知らせ (MCP と共有の markdag_core::native)。
// markdag.types.$ref のファイルは文書からの相対で読んで渡す (読めなければ null で、ライブラリが types-unresolved にする)。
// markdag.hooks.$ref のモジュールは読まない (hookRefs を渡さないので、ライブラリが hooks-unresolved を info で知らせる)。

use std::path::Path;
use std::process::ExitCode;

use markdag_core::model::model::format_diagnostics;
use markdag_core::native::{diagnose, has_error};

use crate::document::{load_type_refs, read_document};

pub fn run(file: &Path) -> ExitCode {
    let Some(markdown) = read_document(file) else {
        return ExitCode::from(2);
    };
    let diagnostics = diagnose(&markdown, load_type_refs(file, &markdown));
    let text = format_diagnostics(&diagnostics);
    println!(
        "{}",
        if text.is_empty() {
            "no diagnostics"
        } else {
            &text
        }
    );
    if has_error(&diagnostics) {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}
