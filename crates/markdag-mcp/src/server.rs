// MCP の道具 (check_markdag、parse_markdag、get_writing_guide) を持つサーバー。
// 入力は文書の文字列で、ファイルは読まない。markdag.types.$ref と markdag.icons.$ref の中身は types と icons の引数で受け、
// markdag.hooks.$ref は読まない (hooks-unresolved の info が入る)。検査と JSON の組み立ては CLI と共有の markdag_core::native を使う。
// 道具の説明文は AI のクライアントが読むので英語で書く。

use indexmap::IndexMap;
use markdag_core::model::model::format_diagnostics;
use markdag_core::model::util::{JsValue, js_json_stringify};
use markdag_core::native::{diagnose_with_icons, has_error, parse_and_model_with_icons};
use markdag_core::parse::parse_yaml;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

const WRITING_GUIDE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/writing-guide.md"
));

const INSTRUCTIONS: &str = "markdag turns a Markdown outline into a DAG diagram. \
Read get_writing_guide before writing a document, then run check_markdag on the full document text and fix every error. \
Files referenced by markdag.types.$ref are not read by this server: pass their contents in the `types` argument. \
Files referenced by markdag.icons.$ref are not read either: pass their contents in the `icons` argument. \
Hook modules (markdag.hooks.$ref) are never loaded here, so a hooks-unresolved info is expected when a document declares hooks.";

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DocumentArgs {
    /// The whole markdag document (Markdown with optional YAML frontmatter), not a file path.
    pub source: String,
    /// Contents of the files listed in markdag.types.$ref. Each key is the $ref string exactly as written in the frontmatter
    /// (e.g. "./types.yaml"); each value is that file's content, either as a JSON object or as the YAML text.
    /// null means the file could not be read. A $ref missing here is reported as types-unresolved.
    #[serde(default)]
    pub types: Option<Map<String, Value>>,
    /// Contents of the files listed in markdag.icons.$ref. Each key is the $ref string exactly as written in the frontmatter
    /// (e.g. "./icons.yaml"); each value is that file's content, either as a JSON object or as the YAML text.
    /// null means the file could not be read. A $ref missing here is reported as icons-unresolved.
    #[serde(default)]
    pub icons: Option<Map<String, Value>>,
}

#[derive(Debug, Clone)]
pub struct MarkdagServer {
    tool_router: ToolRouter<Self>,
}

impl MarkdagServer {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

impl Default for MarkdagServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router]
impl MarkdagServer {
    #[tool(
        description = "Check a markdag document and list its diagnostics (the same checks as `markdag check` and the renderer). \
Returns structured content { diagnostics: [{ severity: \"error\" | \"warning\" | \"info\", code, message, at: { line, column, length } | null, hint }], hasError } \
and a text rendering with one diagnostic per line (\"no diagnostics\" when clean). \
Positions are 1-based within the source. Fix every error; warnings mean a setting was ignored. \
Pass the contents of markdag.types.$ref and markdag.icons.$ref files in `types` and `icons`; this tool does not read files."
    )]
    async fn check_markdag(
        &self,
        Parameters(args): Parameters<DocumentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let types = ref_argument("types", args.types.unwrap_or_default())?;
        let icons = icons_argument(args.icons)?;
        let diagnostics = diagnose_with_icons(&args.source, types, icons);
        let text = format_diagnostics(&diagnostics);
        let structured = json!({
            "diagnostics": serde_json::to_value(&diagnostics).map_err(internal)?,
            "hasError": has_error(&diagnostics),
        });
        let mut result = CallToolResult::structured(structured);
        result.content = vec![ContentBlock::text(if text.is_empty() {
            "no diagnostics".to_string()
        } else {
            text
        })];
        Ok(result)
    }

    #[tool(
        description = "Parse a markdag document and return its outline as JSON, the same shape as `markdag parse --json`: \
{ parsed: { nodes, frontmatter, extracted, taskIcons, styleUrls }, model: { relations, groups, groupsOf, tagsOf, diagnostics, ... } }. \
Each node has id, parent, depth, html, refText (the name relations match exactly: the first line without inline decoration, raw HTML kept as written; empty when the first line of a list item is empty), refId ($id), groups, tags, task, details and lines. \
groupsOf and tagsOf are arrays of [nodeId, value] pairs. \
model.icons (present when the resolved table has an alias or a color other than the default) is the resolved alias table, including the aliases from files passed in `icons`."
    )]
    async fn parse_markdag(
        &self,
        Parameters(args): Parameters<DocumentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let types = ref_argument("types", args.types.unwrap_or_default())?;
        let icons = icons_argument(args.icons)?;
        let json = js_json_stringify(&parse_and_model_with_icons(&args.source, types, icons));
        let value: Value = serde_json::from_str(&json).map_err(internal)?;
        Ok(CallToolResult::structured(value))
    }

    #[tool(
        description = "Return the markdag writing guide (Markdown): the notation for nodes, relations, groups, tags, tasks and frontmatter options. \
Read it before writing or editing a markdag document."
    )]
    async fn get_writing_guide(&self) -> CallToolResult {
        CallToolResult::success(vec![ContentBlock::text(WRITING_GUIDE)])
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MarkdagServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("markdag", markdag_core::VERSION))
            .with_instructions(INSTRUCTIONS)
    }
}

// types と icons の引数を build_model の形にする。文字列の値は YAML の本文として読み (読めなければ null で types-unresolved / icons-unresolved)、
// それ以外の値は JSON の値のまま使う。name は誤りの知らせに出す引数の名前
fn ref_argument(
    name: &str,
    files: Map<String, Value>,
) -> Result<IndexMap<String, JsValue>, ErrorData> {
    let mut resolved = IndexMap::new();
    for (reference, value) in files {
        let value = match value {
            Value::String(text) => parse_yaml(&text).unwrap_or(JsValue::Null),
            other => serde_json::from_value(other).map_err(|error| {
                ErrorData::invalid_params(format!("{name}[\"{reference}\"]: {error}"), None)
            })?,
        };
        resolved.insert(reference, value);
    }
    Ok(resolved)
}

// icons は渡さなかったこと (None) をそのまま core に伝える。どちらでも icons.$ref のある文書は icons-unresolved になる
fn icons_argument(
    icons: Option<Map<String, Value>>,
) -> Result<Option<IndexMap<String, JsValue>>, ErrorData> {
    icons.map(|files| ref_argument("icons", files)).transpose()
}

fn internal(error: serde_json::Error) -> ErrorData {
    ErrorData::internal_error(error.to_string(), None)
}
