// parse のサブコマンド。文書の解析の結果とグラフのモデルを 1 つの JSON で stdout に出す (組み立ては MCP と共有の markdag_core::native)。
// 形は `{ "parsed": ParsedDocument, "model": GraphModel }`:
//   parsed は JS の parseDocument が返す公開の形 (features を消して styleUrls を足したもの。欄の順も同じ)。
//   model は wasm の境界の build_model が返すデータ部分 (JS の GraphModel から関数を除いた形)。groupsOf と tagsOf は
//   `[[ノードの id, 値], ...]` の組の配列 (JS では Map)、hooks は `{ declared, options, rules }` (JS では関数を付けた ResolvedHooks)。
// 数と欄は JSON.stringify と同じ規則で書く (有限でない数は null、undefined の欄は落とす。境界の $number などの印は出さない)。
// types と hooks の読み方は check と同じ (types は文書からの相対で読み、hooks は読まないので hooks-unresolved の info が入る)。

use std::path::Path;
use std::process::ExitCode;

use markdag_core::model::util::js_json_stringify;
use markdag_core::native::parse_and_model;

use crate::document::{load_type_refs, read_document};

pub fn run(file: &Path) -> ExitCode {
    let Some(markdown) = read_document(file) else {
        return ExitCode::from(2);
    };
    let types = load_type_refs(file, &markdown);
    println!("{}", js_json_stringify(&parse_and_model(&markdown, types)));
    ExitCode::SUCCESS
}
