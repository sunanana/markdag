// MCP サーバーの結合試験。rmcp のクライアントとサーバーをプロセス内の転送路 (tokio::io::duplex) でつなぎ、
// tools/list と tools/call を JSON-RPC の往復で確かめる。入力はリポジトリの文書 (コーパスと docs/examples)。
// 子プロセス、ネットワーク、ファイルの書き込みは使わない。
use std::fs;
use std::path::{Path, PathBuf};

use markdag_core::model::model::format_diagnostics;
use markdag_core::model::util::js_json_stringify;
use markdag_core::native::{
    diagnose, diagnose_with_icons, parse_and_model, parse_and_model_with_icons,
};
use markdag_core::parse::parse_yaml;
use markdag_mcp::server::MarkdagServer;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::RunningService;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Map, Value, json};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(relative: &str) -> String {
    fs::read_to_string(repo_root().join(relative)).expect("リポジトリの文書を読める")
}

/// プロセス内でサーバーを起こし、初期化を済ませたクライアントを返す
async fn connect() -> RunningService<RoleClient, ()> {
    let (server_transport, client_transport) = tokio::io::duplex(1 << 16);
    tokio::spawn(async move {
        let service = MarkdagServer::new()
            .serve(server_transport)
            .await
            .expect("サーバーが初期化できる");
        let _ = service.waiting().await;
    });
    ().serve(client_transport)
        .await
        .expect("クライアントが初期化できる")
}

async fn call(
    client: &RunningService<RoleClient, ()>,
    name: &'static str,
    arguments: Value,
) -> CallToolResult {
    let arguments: Map<String, Value> = arguments.as_object().expect("引数はオブジェクト").clone();
    client
        .call_tool(CallToolRequestParams::new(name).with_arguments(arguments))
        .await
        .expect("tools/call が応答する")
}

fn text(result: &CallToolResult) -> &str {
    assert_eq!(result.content.len(), 1, "text の中身は 1 つ");
    result.content[0]
        .as_text()
        .map(|content| content.text.as_str())
        .expect("text の中身")
}

fn structured(result: &CallToolResult) -> &Value {
    result
        .structured_content
        .as_ref()
        .expect("structuredContent がある")
}

fn codes(result: &CallToolResult) -> Vec<String> {
    structured(result)["diagnostics"]
        .as_array()
        .expect("diagnostics は配列")
        .iter()
        .map(|diagnostic| {
            diagnostic["code"]
                .as_str()
                .expect("code は文字列")
                .to_string()
        })
        .collect()
}

#[tokio::test]
async fn server_info_and_three_tools_with_source_required() {
    let client = connect().await;
    let info = client.peer_info().expect("初期化の応答がある");
    let server = info.server_info.as_ref().expect("serverInfo がある");
    assert_eq!(server.name, "markdag");
    assert_eq!(server.version, markdag_core::VERSION);
    assert!(info.capabilities.tools.is_some());

    let tools = client
        .list_all_tools()
        .await
        .expect("tools/list が応答する");
    let mut names: Vec<&str> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        ["check_markdag", "get_writing_guide", "parse_markdag"]
    );

    for name in ["check_markdag", "parse_markdag"] {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .expect("道具がある");
        let schema = Value::Object(tool.input_schema.as_ref().clone());
        assert_eq!(
            schema["required"],
            json!(["source"]),
            "{name}: source だけが必須"
        );
        assert!(
            schema["properties"]["types"].is_object(),
            "{name}: types は任意の引数"
        );
    }
    client.cancel().await.expect("閉じられる");
}

#[tokio::test]
async fn check_markdag_reports_the_same_diagnostics_as_the_cli() {
    let client = connect().await;

    let clean = call(
        &client,
        "check_markdag",
        json!({ "source": read("docs/examples/notation.md") }),
    )
    .await;
    assert_eq!(text(&clean), "no diagnostics");
    assert_eq!(
        structured(&clean),
        &json!({ "diagnostics": [], "hasError": false })
    );
    assert_eq!(clean.is_error, Some(false));

    let source = read("testdata/judge/corpus/edge-cycle.md");
    let cycle = call(&client, "check_markdag", json!({ "source": source })).await;
    assert_eq!(
        text(&cycle),
        "error cycle 7:21 閉路になるので追加しません: C --> A\n\
         \x20   「A」から「C」へ、すでに道があります。向きを入れ替えるか、この指定を消します\n\
         error self-loop 8:15 始点と終点が同じです: D --> D\n\
         warning duplicate-edge 10:25 同じ線がすでにあります: B --> C\n\
         \x20   この向きの線はすでにあります。重なった指定を消せます"
    );
    assert_eq!(
        text(&cycle),
        format_diagnostics(&diagnose(&source, Default::default()))
    );
    assert_eq!(structured(&cycle)["hasError"], json!(true));
    assert_eq!(
        cycle.is_error,
        Some(false),
        "文書の error は道具の失敗ではない"
    );
    assert_eq!(
        structured(&cycle)["diagnostics"][0],
        json!({
            "severity": "error",
            "code": "cycle",
            "message": "閉路になるので追加しません: C --> A",
            "at": { "line": 7, "column": 21, "length": 1 },
            "hint": "「A」から「C」へ、すでに道があります。向きを入れ替えるか、この指定を消します"
        })
    );

    let plain = call(&client, "check_markdag", json!({ "source": "# a\n" })).await;
    assert_eq!(
        codes(&plain).last().map(String::as_str),
        Some("not-extracted")
    );

    let hooks = call(
        &client,
        "check_markdag",
        json!({ "source": read("docs/examples/hooks.md") }),
    )
    .await;
    assert_eq!(structured(&hooks)["hasError"], json!(false));
    let diagnostics = structured(&hooks)["diagnostics"].as_array().expect("配列");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["code"], json!("hooks-unresolved"));
    assert_eq!(diagnostics[0]["severity"], json!("info"));
    client.cancel().await.expect("閉じられる");
}

#[tokio::test]
async fn check_markdag_takes_types_as_yaml_text_or_as_an_object() {
    let client = connect().await;
    let source = read("testdata/judge/corpus/fx-typed.md");
    let yaml = read("testdata/judge/corpus/types.yaml");

    let without = call(&client, "check_markdag", json!({ "source": source })).await;
    assert!(codes(&without).contains(&"types-unresolved".to_string()));

    let from_yaml = call(
        &client,
        "check_markdag",
        json!({ "source": source, "types": { "./types.yaml": yaml } }),
    )
    .await;
    let object = json!({
        "priority": { "type": "enum", "values": ["high", "medium", "low"] },
        "ticket": { "type": "string", "pattern": "^T-\\d+$" }
    });
    let from_object = call(
        &client,
        "check_markdag",
        json!({ "source": source, "types": { "./types.yaml": object } }),
    )
    .await;
    for result in [&from_yaml, &from_object] {
        assert!(!codes(result).contains(&"types-unresolved".to_string()));
        assert!(text(result).contains(
            "error tag-type 22:9 「誤った行」の #priority:hgih: high / medium / low のどれかで書きます"
        ));
        assert!(codes(result).contains(&"tag-unique".to_string()));
    }
    assert_eq!(structured(&from_yaml), structured(&from_object));

    let unreadable = call(
        &client,
        "check_markdag",
        json!({ "source": source, "types": { "./types.yaml": null } }),
    )
    .await;
    assert!(codes(&unreadable).contains(&"types-unresolved".to_string()));
    client.cancel().await.expect("閉じられる");
}

#[tokio::test]
async fn parse_markdag_returns_the_cli_parse_json() {
    let client = connect().await;

    let source = read("docs/examples/notation.md");
    let result = call(&client, "parse_markdag", json!({ "source": source })).await;
    let value = structured(&result);
    let cli: Value = serde_json::from_str(&js_json_stringify(&parse_and_model(
        &source,
        Default::default(),
    )))
    .expect("CLI と同じ組み立ての JSON を読める");
    assert_eq!(value, &cli);
    assert_eq!(
        value
            .as_object()
            .expect("オブジェクト")
            .keys()
            .collect::<Vec<_>>(),
        ["parsed", "model"]
    );
    assert_eq!(value["parsed"]["nodes"].as_array().map(Vec::len), Some(19));
    assert_eq!(value["model"]["diagnostics"], json!([]));
    let from_text: Value = serde_json::from_str(text(&result)).expect("text は同じ JSON の文字列");
    assert_eq!(&from_text, value);

    let typed = read("testdata/judge/corpus/fx-typed.md");
    let yaml = read("testdata/judge/corpus/types.yaml");
    let result = call(
        &client,
        "parse_markdag",
        json!({ "source": typed, "types": { "./types.yaml": yaml } }),
    )
    .await;
    let mut types = indexmap::IndexMap::new();
    types.insert(
        "./types.yaml".to_string(),
        parse_yaml(&yaml).expect("types.yaml は YAML として読める"),
    );
    let cli: Value = serde_json::from_str(&js_json_stringify(&parse_and_model(&typed, types)))
        .expect("CLI と同じ組み立ての JSON を読める");
    assert_eq!(structured(&result), &cli);
    client.cancel().await.expect("閉じられる");
}

#[tokio::test]
async fn get_writing_guide_returns_the_guide_in_docs() {
    let client = connect().await;
    let result = call(&client, "get_writing_guide", json!({})).await;
    assert_eq!(text(&result), read("docs/writing-guide.md"));
    assert_ne!(result.is_error, Some(true));
    client.cancel().await.expect("閉じられる");
}

#[tokio::test]
async fn a_call_without_source_is_an_error_result() {
    let client = connect().await;
    for name in ["check_markdag", "parse_markdag"] {
        let result = call(&client, name, json!({})).await;
        assert_eq!(result.is_error, Some(true), "{name}");
        assert!(
            text(&result).contains("source"),
            "{name}: {}",
            text(&result)
        );
    }
    client.cancel().await.expect("閉じられる");
}

// markdag.icons.$ref を 1 つ書き、本文で $ref の中の alias (gh) と表にない alias (nope) を使う文書
const ICON_REF_SOURCE: &str =
    "---\nmarkdag:\n  icons:\n    $ref: ./icons.yaml\n---\n# R\n## :gh: Push\n## :nope: Pull\n";
const ICON_REF_YAML: &str = "gh: simple-icons:github\n";

#[tokio::test]
async fn check_and_parse_take_icons_as_an_optional_argument() {
    let client = connect().await;
    let tools = client
        .list_all_tools()
        .await
        .expect("tools/list が応答する");
    for name in ["check_markdag", "parse_markdag"] {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .expect("道具がある");
        let schema = Value::Object(tool.input_schema.as_ref().clone());
        assert!(
            schema["properties"]["icons"].is_object(),
            "{name}: icons は任意の引数"
        );
        assert_eq!(schema["required"], json!(["source"]), "{name}");
        assert!(
            tool.description
                .as_deref()
                .is_some_and(|text| text.contains("`icons`")),
            "{name}: 説明に icons の渡し方がある"
        );
    }
    let info = client.peer_info().expect("初期化の応答がある");
    assert!(
        info.instructions
            .as_deref()
            .is_some_and(|text| text.contains("markdag.icons.$ref") && text.contains("`icons`")),
        "サーバーの説明文に icons の渡し方がある"
    );
    client.cancel().await.expect("閉じられる");
}

#[tokio::test]
async fn check_markdag_resolves_icons_ref_only_when_icons_is_passed() {
    let client = connect().await;

    let without = call(
        &client,
        "check_markdag",
        json!({ "source": ICON_REF_SOURCE }),
    )
    .await;
    assert_eq!(codes(&without), ["icons-unresolved"]);
    assert_eq!(
        text(&without),
        format_diagnostics(&diagnose(ICON_REF_SOURCE, Default::default()))
    );

    let from_yaml = call(
        &client,
        "check_markdag",
        json!({ "source": ICON_REF_SOURCE, "icons": { "./icons.yaml": ICON_REF_YAML } }),
    )
    .await;
    let from_object = call(
        &client,
        "check_markdag",
        json!({ "source": ICON_REF_SOURCE, "icons": { "./icons.yaml": { "gh": "simple-icons:github" } } }),
    )
    .await;
    let mut icons = indexmap::IndexMap::new();
    icons.insert(
        "./icons.yaml".to_string(),
        parse_yaml(ICON_REF_YAML).expect("YAML として読める"),
    );
    let cli = format_diagnostics(&diagnose_with_icons(
        ICON_REF_SOURCE,
        Default::default(),
        Some(icons),
    ));
    for result in [&from_yaml, &from_object] {
        // gh は $ref の表で解決するので知らせず、表にない nope だけが icon-unknown になる
        assert_eq!(codes(result), ["icon-unknown"]);
        assert!(text(result).contains("nope"), "{}", text(result));
        assert!(!text(result).contains(":gh:"), "{}", text(result));
        assert_eq!(text(result), cli);
    }
    assert_eq!(structured(&from_yaml), structured(&from_object));

    let unreadable = call(
        &client,
        "check_markdag",
        json!({ "source": ICON_REF_SOURCE, "icons": { "./icons.yaml": null } }),
    )
    .await;
    assert_eq!(codes(&unreadable), ["icons-unresolved"]);

    let other_ref = call(
        &client,
        "check_markdag",
        json!({ "source": ICON_REF_SOURCE, "icons": { "./other.yaml": ICON_REF_YAML } }),
    )
    .await;
    assert_eq!(codes(&other_ref), ["icons-unresolved"]);

    let wrong_type = call(
        &client,
        "check_markdag",
        json!({ "source": ICON_REF_SOURCE, "icons": "./icons.yaml" }),
    )
    .await;
    assert_eq!(wrong_type.is_error, Some(true));
    client.cancel().await.expect("閉じられる");
}

#[tokio::test]
async fn parse_markdag_puts_the_icons_ref_table_into_the_model() {
    let client = connect().await;

    let without = call(
        &client,
        "parse_markdag",
        json!({ "source": ICON_REF_SOURCE }),
    )
    .await;
    assert!(structured(&without)["model"].get("icons").is_none());

    let result = call(
        &client,
        "parse_markdag",
        json!({ "source": ICON_REF_SOURCE, "icons": { "./icons.yaml": ICON_REF_YAML } }),
    )
    .await;
    let value = structured(&result);
    assert_eq!(
        value["model"]["icons"]["aliases"],
        json!([["gh", { "kind": "set", "ref": "simple-icons:github" }]])
    );
    let mut icons = indexmap::IndexMap::new();
    icons.insert(
        "./icons.yaml".to_string(),
        parse_yaml(ICON_REF_YAML).expect("YAML として読める"),
    );
    let cli: Value = serde_json::from_str(&js_json_stringify(&parse_and_model_with_icons(
        ICON_REF_SOURCE,
        Default::default(),
        Some(icons),
    )))
    .expect("CLI と同じ組み立ての JSON を読める");
    assert_eq!(value, &cli);
    client.cancel().await.expect("閉じられる");
}
