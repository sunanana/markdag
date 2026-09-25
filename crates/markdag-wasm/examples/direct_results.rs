// 境界の試験 (test/wasm-boundary.test.ts) が比べる「中核の crate を直接呼んだ結果」を書き出す。
// 各項目は、wasm の mdag_<fn> に渡す入力の JSON と、同じ引数で markdag_core の関数を直に呼んだ結果の組。
// 引数は境界の入力の型を経ずに Rust の値として組むので、境界の読み取り・封筒・線形メモリの受け渡しが結果を変えないことを確かめられる。
// 使い方: cargo run -q -p markdag-wasm --example direct_results > 出力.json
#[path = "../../markdag-core/tests/judge_harness.rs"]
mod judge_harness;

use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use markdag_core::layout::frames::compute_frames;
use markdag_core::layout::layout::{MARKMAP_DEFAULTS, layout_children_of};
use markdag_core::layout::pipeline::layout_document;
use markdag_core::layout::project::project;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::schema::check_frontmatter;
use markdag_core::model::tags::{suggest_tag_keys, suggest_tag_values};
use markdag_core::model::util::JsValue;
use markdag_core::parse::task::{next_task_mark, toggle_task};
use markdag_core::parse::{parse_document, replace_leading_mark};
use markdag_core::standalone::{
    StandaloneOptions, StandaloneRuntime, StandaloneRuntimeOverride, render_standalone_page,
};
use markdag_core::types::{HookSpec, HookSpecEntry, LayoutInput, TaskMark, TaskState};
use serde::Serialize;
use serde_json::{Value, json};

fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("中核の型は JSON にできる")
}

fn ok<T: Serialize>(value: &T) -> Value {
    json!({ "ok": to_json(value) })
}

fn case(name: &str, function: &str, input: Value, expected: Value) -> Value {
    json!({ "name": name, "fn": function, "input": input, "expected": expected })
}

fn pairs(map: &IndexMap<u32, Vec<String>>) -> Value {
    Value::Array(map.iter().map(|(key, value)| json!([key, value])).collect())
}

// 境界の JSON の印 ($number / $object) のままの値から JsValue を作る (中核の JsValue の読み方を使う)
fn js_value(wire: Value) -> JsValue {
    serde_json::from_value(wire).expect("JsValue にできる")
}

// 利用者がキーを決める写像 (types と hooks) を境界の JSON の形で書く。
// JS の境界のレイヤーはどのオブジェクトにも $object の包みをかけるので、JsValue::Object と同じ書き方にする
fn wire_map<V: Serialize>(map: &IndexMap<String, V>) -> Value {
    let object: IndexMap<String, JsValue> = map
        .iter()
        .map(|(key, value)| (key.clone(), js_value(to_json(value))))
        .collect();
    to_json(&JsValue::Object(object))
}

// 名前、原文、types の写像、hooks の写像
type MarkCase = (
    &'static str,
    &'static str,
    Vec<(&'static str, JsValue)>,
    Vec<(&'static str, HookSpecEntry)>,
);

fn read_example(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/examples")
        .join(name);
    fs::read_to_string(path).expect("docs/examples の文書を読める")
}

fn main() {
    let notation = read_example("notation.md");
    let hooks_doc = read_example("hooks.md");
    let mut cases: Vec<Value> = Vec::new();

    // ---- 解析とモデル ----
    let parsed = parse_document(&notation);
    cases.push(case(
        "notation.md",
        "parse_document",
        json!({ "source": notation }),
        ok(&parsed),
    ));

    // YAML の .inf と、印とぶつかる利用者のオブジェクト (A-044 の $object の包み)
    let marks_source = "---\nmarkdag: {}\nx:\n  $number: NaN\ny: .inf\n---\n\n# root\n";
    cases.push(case(
        "frontmatter の印",
        "parse_document",
        json!({ "source": marks_source }),
        ok(&parse_document(marks_source)),
    ));

    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(&notation),
        &ModelOptions::default(),
    );
    cases.push(case(
        "notation.md",
        "build_model",
        json!({ "nodes": to_json(&parsed.nodes), "frontmatter": to_json(&parsed.frontmatter), "source": notation, "types": null, "hooks": null }),
        ok(&model),
    ));

    let hooks_parsed = parse_document(&hooks_doc);
    let mut spec: HookSpec = IndexMap::new();
    spec.insert(
        "./task-guard.hooks.js".to_string(),
        HookSpecEntry::Module {
            exports: vec![
                ("decorateNode".to_string(), true),
                ("onTaskToggle".to_string(), true),
                ("note".to_string(), false),
            ],
        },
    );
    let hooks_model = build_model(
        &hooks_parsed.nodes,
        &hooks_parsed.frontmatter,
        Some(&hooks_doc),
        &ModelOptions {
            types: None,
            hook_refs: Some(spec.clone()),
        },
    );
    cases.push(case(
        "hooks.md と HookSpec",
        "build_model",
        json!({ "nodes": to_json(&hooks_parsed.nodes), "frontmatter": to_json(&hooks_parsed.frontmatter), "source": hooks_doc, "types": null, "hooks": to_json(&spec) }),
        ok(&hooks_model),
    ));

    let broken = "---\nmarkdag:\n  relations: 3\n  groups:\n    a: 1\n---\n\n# root\n";
    let broken_parsed = parse_document(broken);
    cases.push(case(
        "形の誤り",
        "check_frontmatter",
        json!({ "frontmatter": to_json(&broken_parsed.frontmatter), "source": broken }),
        ok(&check_frontmatter(&broken_parsed.frontmatter, Some(broken))),
    ));

    let rendered_model = build_model(
        &hooks_parsed.nodes,
        &hooks_parsed.frontmatter,
        Some(&hooks_doc),
        &ModelOptions {
            types: None,
            hook_refs: Some(spec.clone()),
        },
    );
    cases.push(case(
        "hooks.md",
        "render_document",
        json!({ "source": hooks_doc, "types": null, "hooks": to_json(&spec) }),
        json!({ "ok": { "parsed": to_json(&hooks_parsed), "model": to_json(&rendered_model) } }),
    ));

    // types と hooks の写像のキーが印のキー ($number / $object) のとき (A-180)。
    // 欄が 1 つの写像は JS が $object で包み、2 つ以上なら包まない。types の値には有限でない数と印とぶつかる利用者のオブジェクトを入れる
    let defs_number = js_value(json!({
        "fromNumber": { "type": "string" },
        "inf": { "$number": "Infinity" },
        "weird": { "$object": [["$number", "NaN"]] },
        "nested": { "$object": [["$object", [["a", { "$number": "-Infinity" }]]]] }
    }));
    let defs_object = js_value(json!({ "fromObject": { "type": "enum", "values": ["S", "M"] } }));
    let defs_plain = js_value(json!({ "fromPlain": { "type": "string" } }));
    let module_entry = HookSpecEntry::Module {
        exports: vec![
            ("decorateNode".to_string(), true),
            ("note".to_string(), false),
        ],
    };
    let mark_cases: [MarkCase; 3] = [
        (
            "types と hooks のキーが $number だけ",
            "---\nmarkdag:\n  types:\n    $ref: $number\n  tags:\n    keys:\n      owner: { type: fromNumber }\n  hooks:\n    $ref: $number\n---\n\n# root #owner:me\n",
            vec![("$number", defs_number.clone())],
            vec![("$number", module_entry.clone())],
        ),
        (
            "types と hooks のキーが $object だけ",
            "---\nmarkdag:\n  types:\n    $ref: $object\n  tags:\n    keys:\n      size: { type: fromObject }\n  hooks:\n    $ref: $object\n---\n\n# root #size:L\n",
            vec![("$object", defs_object.clone())],
            vec![("$object", HookSpecEntry::Invalid)],
        ),
        (
            "印のキーを含む 2 つ以上のキー",
            "---\nmarkdag:\n  types:\n    $ref: [$number, $object, ./plain.yaml]\n  tags:\n    keys:\n      owner: { type: fromNumber }\n      size: { type: fromObject }\n      who: { type: fromPlain }\n  hooks:\n    $ref: [$number, $object]\nx: { $number: NaN }\ny: .nan\n---\n\n# root #owner:me #size:S #who:x\n",
            vec![
                ("$number", defs_number),
                ("$object", defs_object),
                ("./plain.yaml", defs_plain),
            ],
            vec![
                ("$number", module_entry),
                ("$object", HookSpecEntry::Invalid),
            ],
        ),
    ];
    for (name, source, types, hooks) in mark_cases {
        let types: IndexMap<String, JsValue> = types
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect();
        let hooks: HookSpec = hooks
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect();
        let marks_parsed = parse_document(source);
        let extra = ModelOptions {
            types: Some(types.clone()),
            hook_refs: Some(hooks.clone()),
        };
        let marks_model = build_model(
            &marks_parsed.nodes,
            &marks_parsed.frontmatter,
            Some(source),
            &extra,
        );
        cases.push(case(
            name,
            "build_model",
            json!({ "nodes": to_json(&marks_parsed.nodes), "frontmatter": to_json(&marks_parsed.frontmatter), "source": source, "types": wire_map(&types), "hooks": wire_map(&hooks) }),
            ok(&marks_model),
        ));
        cases.push(case(
            name,
            "render_document",
            json!({ "source": source, "types": wire_map(&types), "hooks": wire_map(&hooks) }),
            json!({ "ok": { "parsed": to_json(&marks_parsed), "model": to_json(&marks_model) } }),
        ));
    }

    cases.push(case(
        "source が null",
        "check_frontmatter",
        json!({ "frontmatter": to_json(&broken_parsed.frontmatter), "source": null }),
        ok(&check_frontmatter(&broken_parsed.frontmatter, None)),
    ));

    // ---- 配置 ----
    // 審判の harness と同じ規則で入力を組み、枝を 1 つ閉じた形も作る
    let mut folded = judge_harness::initial_fold(
        &parsed.nodes,
        judge_harness::expand_level_of(&parsed.frontmatter),
    );
    let open_input = judge_harness::layout_input(
        &parsed.nodes,
        &model.relations,
        &model.suppress_root_line,
        &folded,
    );
    if let Some(node) = parsed
        .nodes
        .iter()
        .find(|node| node.ref_text == "フロントエンド")
    {
        folded.insert(node.id);
    }
    let folded_input = judge_harness::layout_input(
        &parsed.nodes,
        &model.relations,
        &model.suppress_root_line,
        &folded,
    );

    for (name, input) in [("開いた形", &open_input), ("枝を閉じた形", &folded_input)] {
        let expected = ok(
            &layout_document(input, &model.groups, &model.groups_of, None, None)
                .expect("notation.md は配置できる"),
        );
        cases.push(case(
            name,
            "layout_document",
            json!({ "input": to_json(input), "groups": to_json(&model.groups), "groupsOf": pairs(&model.groups_of), "options": null, "maxPasses": null }),
            expected,
        ));
    }
    let options = MARKMAP_DEFAULTS;
    let with_options = layout_document(
        &open_input,
        &model.groups,
        &model.groups_of,
        Some(options.clone()),
        Some(1),
    )
    .expect("notation.md は配置できる");
    cases.push(case(
        "options と maxPasses を渡す",
        "layout_document",
        json!({ "input": to_json(&open_input), "groups": to_json(&model.groups), "groupsOf": pairs(&model.groups_of), "options": to_json(&options), "maxPasses": 1 }),
        ok(&with_options),
    ));

    let empty = LayoutInput {
        name: "empty".to_string(),
        nodes: Vec::new(),
        tree_edges: Vec::new(),
        relations: Vec::new(),
        suppress_root_line: Vec::new(),
        folded: Vec::new(),
    };
    let empty_error = project(&empty).expect_err("ノードのない入力は誤り");
    cases.push(case(
        "ノードのない入力",
        "layout_document",
        json!({ "input": to_json(&empty), "groups": [], "groupsOf": [], "options": null, "maxPasses": null }),
        json!({ "error": { "code": "layout-error", "message": empty_error.message } }),
    ));

    let graph = project(&folded_input).expect("notation.md は射影できる");
    cases.push(case(
        "枝を閉じた形",
        "project",
        json!({ "input": to_json(&folded_input) }),
        ok(&graph),
    ));
    cases.push(case(
        "ノードのない入力",
        "project",
        json!({ "input": to_json(&empty) }),
        json!({ "error": { "code": "layout-error", "message": empty_error.message } }),
    ));

    let sibling_order = layout_children_of(&graph);
    let frames = compute_frames(&graph, &model.groups, &model.groups_of, &sibling_order);
    let sibling_pairs: Vec<Value> = sibling_order
        .iter()
        .map(|(key, value)| json!([key, value]))
        .collect();
    cases.push(case(
        "枝を閉じた形",
        "project_and_frames",
        json!({ "input": to_json(&folded_input), "groups": to_json(&model.groups), "groupsOf": pairs(&model.groups_of), "siblingOrder": sibling_pairs }),
        json!({ "ok": { "graph": to_json(&graph), "frames": to_json(&frames) } }),
    ));

    // ---- タスク ----
    let task_line = notation
        .split('\n')
        .position(|line| line.contains("登録フォーム #owner"))
        .expect("タスクの行がある") as f64;
    cases.push(case(
        "既定の順",
        "toggle_task",
        json!({ "source": notation, "line": task_line, "cycle": null }),
        ok(&toggle_task(&notation, task_line, None)),
    ));
    let cycle = [TaskMark::Space, TaskMark::Slash, TaskMark::X];
    cases.push(case(
        "順を渡す",
        "toggle_task",
        json!({ "source": notation, "line": task_line, "cycle": to_json(&cycle) }),
        ok(&toggle_task(&notation, task_line, Some(&cycle))),
    ));
    cases.push(case(
        "行が NaN",
        "toggle_task",
        json!({ "source": notation, "line": { "$number": "NaN" }, "cycle": null }),
        ok(&toggle_task(&notation, f64::NAN, None)),
    ));
    cases.push(case(
        "順の中",
        "next_task_mark",
        json!({ "mark": " ", "cycle": to_json(&cycle) }),
        json!({ "ok": { "mark": to_json(&next_task_mark(TaskMark::Space, &cycle)) } }),
    ));
    cases.push(case(
        "順にない記号",
        "next_task_mark",
        json!({ "mark": "-", "cycle": to_json(&cycle) }),
        json!({ "ok": { "mark": to_json(&next_task_mark(TaskMark::Hyphen, &cycle)) } }),
    ));

    let task_node = parsed
        .nodes
        .iter()
        .find(|node| node.task.is_some())
        .expect("タスクのノードがある");
    let icons = parsed.task_icons.clone();
    cases.push(case(
        "絵の記号",
        "replace_leading_mark",
        json!({ "html": task_node.html, "state": "done", "icons": to_json(&icons) }),
        json!({ "ok": { "html": replace_leading_mark(&task_node.html, TaskState::Done, icons.as_ref()) } }),
    ));
    cases.push(case(
        "文字の記号",
        "replace_leading_mark",
        json!({ "html": "[ ] 文字のまま", "state": "doing", "icons": null }),
        json!({ "ok": { "html": replace_leading_mark("[ ] 文字のまま", TaskState::Doing, None) } }),
    ));

    // ---- タグ ----
    cases.push(case(
        "prefix なし",
        "suggest_tag_keys",
        json!({ "tagKeys": to_json(&model.tag_keys), "prefix": null }),
        ok(&suggest_tag_keys(&model.tag_keys, None)),
    ));
    cases.push(case(
        "prefix あり",
        "suggest_tag_keys",
        json!({ "tagKeys": to_json(&model.tag_keys), "prefix": "p" }),
        ok(&suggest_tag_keys(&model.tag_keys, Some("p"))),
    ));
    cases.push(case(
        "priority",
        "suggest_tag_values",
        json!({ "tagKeys": to_json(&model.tag_keys), "key": "priority", "prefix": null }),
        ok(&suggest_tag_values(&model.tag_keys, "priority", None)),
    ));
    cases.push(case(
        "priority と prefix",
        "suggest_tag_values",
        json!({ "tagKeys": to_json(&model.tag_keys), "key": "priority", "prefix": "h" }),
        ok(&suggest_tag_values(&model.tag_keys, "priority", Some("h"))),
    ));

    // ---- 単体 HTML ----
    // 既定のランタイムは仮のもの (組み立ては中身を読まない)。素材は data、ページの指定は options に分ける (A-185)
    let runtime = StandaloneRuntime {
        script: "var markdag = { mountStandalone() {} };".to_string(),
        style: ".markdag { color: red; }".to_string(),
    };
    let page_options = StandaloneOptions {
        title: Some("</title>notation".to_string()),
        lang: Some("ja".to_string()),
        container_class: Some(" zu-markdag ".to_string()),
        css: Some(vec![".a::after { content: \"</style>\"; }".to_string()]),
        head: Some("<meta name=\"color-scheme\" content=\"dark\">".to_string()),
        runtime: Some(StandaloneRuntimeOverride {
            script: None,
            style: Some(".b {}".to_string()),
        }),
    };
    let full_data = js_value(json!({
        "parsed": to_json(&parsed),
        "source": notation,
        "view": { "theme": "dark", "legend": true },
        "state": { "folded": [1, 3], "transform": { "x": 0.5, "y": { "$number": "NaN" }, "k": 1 } },
        "tasks": "scratch"
    }));
    let source_only = js_value(json!({ "source": "# </script><!--" }));
    let standalone_cases: [(&str, &JsValue, Option<&StandaloneOptions>); 2] = [
        (
            "解析結果と原文と表示の指定",
            &full_data,
            Some(&page_options),
        ),
        ("原文だけ、指定なし", &source_only, None),
    ];
    for (name, data, options) in standalone_cases {
        let html = render_standalone_page(&options.cloned().unwrap_or_default(), data, &runtime)
            .expect("素材があれば組み立てられる");
        cases.push(case(
            name,
            "standalone_page",
            json!({ "runtime": runtime.script, "css": runtime.style, "data": to_json(data), "options": options.map(to_json) }),
            ok(&html),
        ));
    }
    let no_material = js_value(json!({ "title": "x" }));
    let standalone_error =
        render_standalone_page(&StandaloneOptions::default(), &no_material, &runtime)
            .expect_err("素材がなければ誤り");
    cases.push(case(
        "素材なし",
        "standalone_page",
        json!({ "runtime": runtime.script, "css": runtime.style, "data": to_json(&no_material), "options": null }),
        json!({ "error": { "code": "standalone-error", "message": standalone_error.message } }),
    ));

    println!(
        "{}",
        serde_json::to_string(&json!({ "cases": cases })).expect("JSON にできる")
    );
}
