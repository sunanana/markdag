// 原文: test/model.test.ts の describe('frontmatter の形と型の検証')、describe('黙って無視されていた書き方を、スキーマが警告にする')、
// describe('タスクの設定') (2026-09-24)。
// checkFrontmatter (Rust では schema::check_frontmatter) のコード、重大度、文面、手がかり、位置と、
// 形の誤りを buildModel が読み飛ばすこと、markdag.tasks の cycle と dim の読み方を、同じ入力と同じ期待値で見る。
// 関数名は `cargo test -p markdag-core model` で選ばれるよう model_ で始める。
mod common;

use common::{build, codes, epic, epic_frontmatter, js, leaf, object, outline, position};
use markdag_core::model::schema::check_frontmatter;
use markdag_core::model::util::JsValue;
use markdag_core::types::{Diagnostic, Severity};
use serde_json::{Value, json};

fn check(frontmatter: Value) -> Vec<Diagnostic> {
    check_frontmatter(&js(frontmatter), None)
}

fn check_codes(frontmatter: Value) -> Vec<String> {
    check(frontmatter)
        .into_iter()
        .map(|item| item.code)
        .collect()
}

fn first(frontmatter: Value) -> Diagnostic {
    let label = frontmatter.to_string();
    check(frontmatter)
        .into_iter()
        .next()
        .unwrap_or_else(|| panic!("診断がない: {label}"))
}

// toMatchObject({ severity, code }) の写し
fn assert_kind(frontmatter: Value, severity: Severity, code: &str) {
    let label = frontmatter.to_string();
    let item = first(frontmatter);
    assert_eq!(
        (item.severity, item.code.as_str()),
        (severity, code),
        "{label}"
    );
}

fn hint_of(frontmatter: Value) -> Option<String> {
    first(frontmatter).hint
}

fn some(text: &str) -> Option<String> {
    Some(text.to_string())
}

// ---- describe('frontmatter の形と型の検証') ----

// 原文: 正しく書かれた frontmatter には、何も言わない
#[test]
fn model_schema_valid_frontmatter_has_no_diagnostics() {
    assert!(check(epic_frontmatter()).is_empty());
    let diagnostics = check(json!({
        "title": "小さな DAG",
        "markdag": {
            "relations": { "fork": ["企画 --> 設計/*"], "depends": "画面設計 --> API設計" },
            "groups": { "design": { "label": "設計チーム", "color": "#3B7DD8", "boundary": true, "members": ["画面設計"] } },
            "tags": { "display": "never" },
            "details": { "display": "always" },
            "legend": { "position": "bottom-left", "display": false },
            "branches": ["企画", "実装"],
            "initialExpandLevel": 2,
        },
    }));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
}

// 原文: コードと重大度はスキーマが決め、書いていなければ警告の option-invalid / option-unknown にする
#[test]
fn model_schema_code_and_severity_come_from_schema() {
    // relations の下は、その式を描けなくなる誤りなので error
    assert_kind(
        json!({ "markdag": { "relations": ["A --> B"] } }),
        Severity::Error,
        "relation-syntax",
    );
    assert_kind(
        json!({ "markdag": { "relations": { "fork": [3] } } }),
        Severity::Error,
        "relation-not-string",
    );
    assert_kind(
        json!({ "markdag": { "relations": { "fork": ["A -> B"] } } }),
        Severity::Error,
        "relation-syntax",
    );
    assert_kind(
        json!({ "markdag": { "relations": { "flow": ["A --> B"] } } }),
        Severity::Warning,
        "relation-unknown-key",
    );
    assert_kind(
        json!({ "markdag": { "groups": { "a": { "color": 3 } } } }),
        Severity::Warning,
        "group-invalid",
    );
    assert_kind(
        json!({ "markdag": { "tags": { "display": "yes" } } }),
        Severity::Warning,
        "option-invalid",
    );
    let unknown = first(json!({ "markdag": { "tags": { "displa": true } } }));
    assert_eq!(
        (unknown.severity, unknown.code.as_str(), unknown.hint),
        (
            Severity::Warning,
            "option-unknown",
            some("もしかして「display」")
        )
    );
    assert_kind(
        json!({ "markdag": { "branches": "A" } }),
        Severity::Warning,
        "option-invalid",
    );
    assert_kind(
        json!({ "markdag": { "branch": ["A"] } }),
        Severity::Warning,
        "option-unknown",
    );
}

// 原文: $ref を type の兄弟に置いた制約は、型と形の 2 段で効く
#[test]
fn model_schema_ref_beside_type_applies_in_two_steps() {
    // 文字列でない式 (expression の type) と、--> のない式 (その $ref の先の arrow の pattern) を区別する
    assert_eq!(
        hint_of(json!({ "markdag": { "relations": { "fork": [3] } } })),
        some("「A --> B: C」のように「: 」を含む式は、行全体を \"…\" で囲みます")
    );
    let arrow =
        hint_of(json!({ "markdag": { "relations": { "fork": ["A -> B"] } } })).expect("hint");
    assert!(
        arrow.contains("半角の空白で挟んだ --> で結びます"),
        "{arrow}"
    );
    // 一覧の型 (branches の type) と、重なり (その $ref の先の noDuplicates の uniqueItems) も同じ
    assert_eq!(
        check_codes(json!({ "markdag": { "branches": "A" } })),
        ["option-invalid"]
    );
    let duplicate = first(json!({ "markdag": { "branches": ["A", "B", "A"] } }));
    assert_eq!(duplicate.code, "option-invalid");
    assert_eq!(
        duplicate.message,
        "markdag.branches[2] は前にも書かれています (\"A\")"
    );
    assert_eq!(
        duplicate.hint,
        some("同じ行が 2 回あります。重なった行は消せます")
    );
}

// 原文: oneOf は値の型で枝を選び、どの枝の型にも合わなければ oneOf を書いた位置の手がかりを出す
#[test]
fn model_schema_one_of_picks_branch_by_type() {
    // 一覧の枝が選ばれるので、項目ごとの手がかりになる
    let item = first(json!({ "markdag": { "legend": { "display": ["groups", "lines"] } } }));
    assert_eq!(
        item.message,
        "markdag.legend.display[1] に指定できるのは groups, branches です (\"lines\")"
    );
    assert_eq!(item.hint, some("凡例に出せるのは groups と branches です"));
    // 真偽値の枝が選ばれるので、何も言わない
    assert!(check_codes(json!({ "markdag": { "legend": { "display": true } } })).is_empty());
    assert!(check_codes(json!({ "markdag": { "legend": { "display": false } } })).is_empty());
    // 文字列は真偽値でも一覧でもないので、display そのものの手がかりを出す
    let whole = first(json!({ "markdag": { "legend": { "display": "all" } } }));
    assert_eq!(
        whole.message,
        "markdag.legend.display には 真偽値、一覧 のどれかを書きます (\"all\")"
    );
    assert_eq!(
        whole.hint,
        some("凡例を出さないなら false、項目を選ぶなら一覧で書きます")
    );
}

// 原文: 知らないキーと使えない値には、近い名前を手がかりにする
#[test]
fn model_schema_unknown_key_and_value_get_closest_name() {
    assert_eq!(
        hint_of(json!({ "markdag": { "relations": { "chian": ["A --> B"] } } })),
        some("もしかして「chain」")
    );
    assert_eq!(
        hint_of(json!({ "markdag": { "branch": ["A"] } })),
        some("もしかして「branches」")
    );
    assert_eq!(
        hint_of(json!({ "markdag": { "groups": { "a": { "colour": "#fff" } } } })),
        some("もしかして「color」")
    );
    assert_eq!(
        hint_of(json!({ "markdag": { "details": { "display": "hoverr" } } })),
        some("もしかして「hover」")
    );
    // 近い名前がなければ、スキーマの手がかりをそのまま出す
    assert_eq!(
        hint_of(json!({ "markdag": { "details": { "display": "open" } } })),
        some("always は最初から開いて表示、hover はノードに重ねる、click は印のクリックです")
    );
}

// 原文: 下の階層に書くはずのキーは、知らないキーではなく置き場所の違いとして知らせる
#[test]
fn model_schema_misplaced_key_is_reported_as_misplaced() {
    let fork = first(json!({ "markdag": { "fork": ["A --> B"] } }));
    assert_eq!(fork.code, "option-misplaced");
    assert_eq!(
        fork.message,
        "markdag のキー「fork」は、markdag.relations の下に書いてください。この位置では無視します"
    );
    assert_eq!(
        fork.hint,
        some("relations: の行を作り、その下に字下げして fork: を書きます")
    );
    assert_eq!(
        first(json!({ "markdag": { "position": "top-left" } })).message,
        "markdag のキー「position」は、markdag.legend の下に書いてください。この位置では無視します"
    );
    // 0.2 までの書き方 (最上位の relations と groups) も、置き場所の違いになる
    let relations = first(json!({ "relations": { "fork": ["A --> B"] } }));
    assert_eq!(relations.code, "option-misplaced");
    assert_eq!(
        relations.message,
        "「relations」は frontmatter の markdag の下に書いてください。この位置では無視します"
    );
    assert_eq!(
        relations.hint,
        some("markdag: の行を作り、その下に字下げして relations: を書きます")
    );
    assert_eq!(
        hint_of(json!({ "fork": "A --> B" })),
        some("markdag: の下に relations: を作り、その下に字下げして fork: を書きます")
    );
    // 書き間違いの近い名前が下の階層のキーなら、置き場所も添える
    assert_eq!(
        hint_of(json!({ "relation": { "fork": ["A --> B"] } })),
        some("もしかして「relations」(markdag の下に書きます)")
    );
}

// 原文: 診断の位置は、スキーマの中の場所から原文の行と桁で引く
#[test]
fn model_schema_position_is_looked_up_from_source() {
    let markdown = [
        "---",
        "markdag:",
        "    details: always",
        "    branches:",
        "        - A",
        "        - A",
        "---",
        "",
        "# root",
    ]
    .join("\n");
    let places: Vec<_> = check_frontmatter(
        &js(json!({ "markdag": { "details": "always", "branches": ["A", "A"] } })),
        Some(&markdown),
    )
    .into_iter()
    .map(|item| item.at)
    .collect();
    assert_eq!(places, [Some(position(3, 14, 6)), Some(position(6, 11, 1))]);
}

// ---- describe('黙って無視されていた書き方を、スキーマが警告にする') ----

// 原文の cases の表。ラベル、frontmatter、期待するコードの並び
fn silent_cases() -> Vec<(&'static str, JsValue, Vec<&'static str>)> {
    let undefined_in = |parent: &'static str, key: &str| {
        object(vec![(parent, object(vec![(key, JsValue::Undefined)]))])
    };
    vec![
        (
            "グループの色が引用符なしで、# 以降がコメントになった",
            js(json!({ "markdag": { "groups": { "a": { "color": null } } } })),
            vec!["group-invalid"],
        ),
        (
            "グループの色が文字列でない",
            js(json!({ "markdag": { "groups": { "a": { "color": 123456 } } } })),
            vec!["group-invalid"],
        ),
        (
            "グループの色が CSS の色の形でない",
            js(json!({ "markdag": { "groups": { "a": { "color": "まっか" } } } })),
            vec!["group-invalid"],
        ),
        (
            "グループの色の 16 進の桁数が足りない",
            js(json!({ "markdag": { "groups": { "a": { "color": "#D6454" } } } })),
            vec!["group-invalid"],
        ),
        (
            "題が文字列でない",
            js(json!({ "title": 123 })),
            vec!["option-invalid"],
        ),
        (
            "グループのラベルが文字列でない",
            js(json!({ "markdag": { "groups": { "a": { "label": 2025 } } } })),
            vec!["group-invalid"],
        ),
        (
            "グループのラベルが空",
            js(json!({ "markdag": { "groups": { "a": { "label": "" } } } })),
            vec!["group-invalid"],
        ),
        (
            "枠の指定が真偽値でない (yes は YAML では文字列)",
            js(json!({ "markdag": { "groups": { "a": { "boundary": "yes" } } } })),
            vec!["group-invalid"],
        ),
        (
            "メンバーを一覧にしていない",
            js(json!({ "markdag": { "groups": { "a": { "members": "A" } } } })),
            vec!["group-invalid"],
        ),
        (
            "メンバーが文字列でない",
            js(json!({ "markdag": { "groups": { "a": { "members": [3] } } } })),
            vec!["group-invalid"],
        ),
        (
            "グループの中の知らないキー",
            js(json!({ "markdag": { "groups": { "a": { "colour": "#fff", "member": ["A"] } } } })),
            vec!["group-invalid", "group-invalid"],
        ),
        (
            "解決されずに残ったマージキー",
            js(json!({ "markdag": { "groups": { "a": { "<<": { "color": "#fff" } } } } })),
            vec!["group-invalid"],
        ),
        (
            "グループの定義が写像でない",
            js(json!({ "markdag": { "groups": { "a": "なにか" } } })),
            vec!["group-invalid"],
        ),
        (
            "グループの定義が一覧 (members: の書き忘れ)",
            js(json!({ "markdag": { "groups": { "a": ["A", "B"] } } })),
            vec!["group-invalid"],
        ),
        (
            "groups が一覧",
            js(json!({ "markdag": { "groups": ["a", "b"] } })),
            vec!["group-invalid"],
        ),
        (
            "groups が文字列",
            js(json!({ "markdag": { "groups": "abc" } })),
            vec!["group-invalid"],
        ),
        (
            "markdag が文字列",
            js(json!({ "markdag": "abc" })),
            vec!["option-invalid"],
        ),
        (
            "凡例の項目が重なっている",
            js(json!({ "markdag": { "legend": { "display": ["groups", "groups"] } } })),
            vec!["option-invalid"],
        ),
        (
            "最上位のキーが大文字違い",
            js(json!({ "Markdag": { "details": { "display": "always" } } })),
            vec!["option-unknown"],
        ),
        (
            "relations の書き間違いを最上位に置いた",
            js(json!({ "relation": { "fork": ["A --> B"] } })),
            vec!["option-unknown"],
        ),
        (
            "initialExpandLevel を最上位に置いた",
            js(json!({ "initialExpandLevel": 2 })),
            vec!["option-misplaced"],
        ),
        (
            "relations を最上位に置いた (0.2 までの書き方)",
            js(json!({ "relations": { "fork": ["A --> B"] } })),
            vec!["option-misplaced"],
        ),
        (
            "groups を最上位に置いた (0.2 までの書き方)",
            js(json!({ "groups": { "a": { "color": "#fff" } } })),
            vec!["option-misplaced"],
        ),
        (
            "relations のキーを最上位に置いた",
            js(json!({ "fork": "A --> B" })),
            vec!["option-misplaced"],
        ),
        (
            "relations のキーを markdag の直下に置いた",
            js(json!({ "markdag": { "fork": ["A --> B"] } })),
            vec!["option-misplaced"],
        ),
        (
            "legend のキーを markdag の直下に置いた",
            js(json!({ "markdag": { "position": "top-left" } })),
            vec!["option-misplaced"],
        ),
        (
            "markdag のキーを markmap の下に置いた (最上位の markmap は読まない)",
            js(json!({ "markmap": { "markdag": { "details": { "display": "always" } } } })),
            vec!["option-removed"],
        ),
        (
            "最初に開く深さに数字の文字列を書いた",
            js(json!({ "markdag": { "initialExpandLevel": "2" } })),
            vec!["option-invalid"],
        ),
        (
            "真偽値に文字列を書いた (逆の意味になる)",
            js(json!({ "markdag": { "edgeHighlight": "no" } })),
            vec!["option-invalid"],
        ),
        (
            "最初に開く深さに数でない文字列を書いた",
            js(json!({ "markdag": { "initialExpandLevel": "abc" } })),
            vec!["option-invalid"],
        ),
        (
            "markmap の知らないキー (最上位の markmap は読まない)",
            js(json!({ "markmap": { "colorFreeze": 2 } })),
            vec!["option-removed"],
        ),
        // JS から渡された undefined の値は、原文の値を診断に書き添えられない
        (
            "最初に開く深さが undefined",
            undefined_in("markdag", "initialExpandLevel"),
            vec!["option-invalid"],
        ),
        (
            "markmap の下の undefined も読まない",
            undefined_in("markmap", "color"),
            vec!["option-removed"],
        ),
        (
            "title など markdag の外のキーは、最上位にあってもよい",
            js(json!({ "title": "x", "author": "y" })),
            vec![],
        ),
        (
            "markmap.htmlParser も読まない",
            js(json!({ "markmap": { "htmlParser": { "selector": "h1,h2" } } })),
            vec!["option-removed"],
        ),
        (
            "frontmatter がキーと値の組でない",
            JsValue::String("abc".to_string()),
            vec!["option-invalid"],
        ),
        (
            "グループの色に 8 桁の 16 進",
            js(json!({ "markdag": { "groups": { "a": { "color": "#3B7DD880" } } } })),
            vec![],
        ),
        (
            "グループの色に色の名前",
            js(json!({ "markdag": { "groups": { "a": { "color": "steelblue" } } } })),
            vec![],
        ),
        (
            "グループの色に関数の書き方",
            js(json!({ "markdag": { "groups": { "a": { "color": "rgb(59, 125, 216)" } } } })),
            vec![],
        ),
    ]
}

// 原文: cases の表の 39 件 (原文は 1 件ずつの it。失敗したときはラベルを添えて全件の差を出す)
#[test]
fn model_schema_silently_ignored_forms_are_warned() {
    let cases = silent_cases();
    assert_eq!(cases.len(), 39, "原文の表の件数");
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|(label, frontmatter, expected)| {
            let actual: Vec<String> = check_frontmatter(frontmatter, None)
                .into_iter()
                .map(|item| item.code)
                .collect();
            (actual != *expected).then(|| format!("{label}: {actual:?} (期待 {expected:?})"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// 原文: relations が写像でないときに、添字をキーと取り違えた警告を出さない
#[test]
fn model_schema_relations_not_mapping_is_not_read_by_index() {
    let nodes = outline(vec![
        leaf("root", None),
        leaf("A", Some(0)),
        leaf("B", Some(0)),
    ]);
    let model = build(&nodes, json!({ "markdag": { "relations": "A --> B" } }));
    assert!(model.relations.is_empty());
    assert_eq!(codes(&model), ["relation-syntax"]);
}

// 原文: groups が一覧のときに、添字を名前にしたグループを作らない
#[test]
fn model_schema_groups_list_makes_no_group() {
    let nodes = outline(vec![leaf("root", None), leaf("A", Some(0))]);
    let model = build(&nodes, json!({ "markdag": { "groups": ["a", "b"] } }));
    assert!(model.groups.is_empty());
    assert_eq!(codes(&model), ["group-invalid"]);
}

// 原文: markdag が一覧のときに、添字をキーと取り違えた警告を出さない
#[test]
fn model_schema_markdag_list_is_not_read_by_index() {
    let nodes = outline(vec![leaf("root", None), leaf("A", Some(0))]);
    let model = build(&nodes, json!({ "markdag": ["A"] }));
    assert!(model.branches.is_empty());
    assert_eq!(codes(&model), ["option-invalid"]);
    assert_eq!(
        model.diagnostics[0].message,
        "markdag はキーと値の組で書きます ([\"A\"])"
    );
}

// 原文: 値を書かずに markdag のキーだけを置いた文書には、何も言わない (オプションは既定のまま)
#[test]
fn model_schema_null_markdag_keeps_defaults() {
    let nodes = outline(vec![leaf("root", None), leaf("A", Some(0))]);
    let model = build(&nodes, json!({ "markdag": null }));
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    assert_eq!(model.details_mode, None);
    assert!(model.edge_highlight);
}

// ---- describe('タスクの設定') ----

// 原文: クリックで進む順は markdag.tasks.cycle で指定でき、指定がなければ未完了と完了の行き来
#[test]
fn model_tasks_cycle_option() {
    let cycle = |frontmatter: Value| {
        serde_json::to_value(build(&epic(), frontmatter).task_cycle).expect("taskCycle")
    };
    assert_eq!(cycle(json!({})), json!([" ", "x"]));
    assert_eq!(
        cycle(json!({ "markdag": { "tasks": { "cycle": [" ", "/", "x"] } } })),
        json!([" ", "/", "x"])
    );
    // 知らない記号と重複はスキーマが知らせ、ここでは読み飛ばす
    let wrong = build(
        &epic(),
        json!({ "markdag": { "tasks": { "cycle": [" ", "?", "x", "x"] } } }),
    );
    assert_eq!(
        serde_json::to_value(&wrong.task_cycle).expect("taskCycle"),
        json!([" ", "x"])
    );
    assert_eq!(
        code_messages(&wrong.diagnostics),
        [
            (
                "option-invalid",
                "markdag.tasks.cycle[3] は前にも書かれています (\"x\")"
            ),
            (
                "option-invalid",
                "markdag.tasks.cycle[1] に指定できるのは  , /, x, - です (\"?\")"
            ),
        ]
    );
    // 1 つでは進めないので、既定に戻して知らせる
    let single = build(
        &epic(),
        json!({ "markdag": { "tasks": { "cycle": ["x"] } } }),
    );
    assert_eq!(
        serde_json::to_value(&single.task_cycle).expect("taskCycle"),
        json!([" ", "x"])
    );
    assert_eq!(
        code_messages(&single.diagnostics),
        [(
            "option-invalid",
            "markdag.tasks.cycle: クリックで進む順は、記号を 2 つ以上並べます"
        )]
    );
}

// 原文: 薄く表示する状態は markdag.tasks.dim で指定でき、一覧だけでも、詳細とタグの見せ方を添えても書ける
#[test]
fn model_tasks_dim_option() {
    let dim = |frontmatter: Value| {
        serde_json::to_value(build(&epic(), frontmatter).task_dim).expect("taskDim")
    };
    assert_eq!(
        dim(json!({})),
        json!({ "states": [], "details": "keep", "tags": "keep" })
    );
    assert_eq!(
        dim(json!({ "markdag": { "tasks": { "dim": ["x", "-"] } } })),
        json!({ "states": ["done", "canceled"], "details": "keep", "tags": "keep" })
    );
    assert_eq!(
        dim(
            json!({ "markdag": { "tasks": { "dim": { "states": ["-"], "details": "hover", "tags": "never" } } } })
        ),
        json!({ "states": ["canceled"], "details": "hover", "tags": "never" })
    );
    let wrong = build(
        &epic(),
        json!({ "markdag": { "tasks": { "dim": { "states": ["x"], "details": "always" } } } }),
    );
    assert_eq!(
        serde_json::to_value(&wrong.task_dim).expect("taskDim"),
        json!({ "states": ["done"], "details": "keep", "tags": "keep" })
    );
    assert_eq!(
        code_messages(&wrong.diagnostics),
        [(
            "option-invalid",
            "markdag.tasks.dim.details に指定できるのは keep, hover, click, never です (\"always\")"
        )]
    );
}

fn code_messages(diagnostics: &[Diagnostic]) -> Vec<(&str, &str)> {
    diagnostics
        .iter()
        .map(|item| (item.code.as_str(), item.message.as_str()))
        .collect()
}

// ---- 最初に開いておく深さ (markdag.initialExpandLevel) と、読まなくなった最上位の markmap (A-221) ----

fn diagnose(markdown: &str) -> Vec<Diagnostic> {
    markdag_core::native::diagnose(markdown, Default::default())
}

#[test]
fn model_initial_expand_level_is_read_under_markdag() {
    for level in [-1, 0, 2] {
        assert!(check(json!({ "markdag": { "initialExpandLevel": level } })).is_empty());
    }
    let parsed = markdag_core::parse::parse_document(
        "---\nmarkdag:\n    initialExpandLevel: 2\n---\n\n# root\n\n## a\n\n- b\n",
    );
    assert!(parsed.extracted);
    assert_eq!(
        parsed.frontmatter,
        js(json!({ "markdag": { "initialExpandLevel": 2 } }))
    );
    let diagnostics = diagnose("---\nmarkdag:\n    initialExpandLevel: \"2\"\n---\n\n# root\n");
    assert_eq!(
        diagnostics,
        [Diagnostic {
            severity: Severity::Warning,
            code: "option-invalid".to_string(),
            message: "markdag.initialExpandLevel は整数で書きます (\"2\")".to_string(),
            at: Some(position(3, 25, 3)),
            hint: some("深さを整数で書きます (すべて開くなら -1)"),
        }]
    );
    for wrong in [json!(1.5), json!(true), json!([2]), json!(null)] {
        assert_eq!(
            check_codes(json!({ "markdag": { "initialExpandLevel": wrong } })),
            ["option-invalid"],
            "{wrong}"
        );
    }
}

#[test]
fn model_leftover_markmap_is_warned_and_ignored() {
    let removed = "frontmatter の「markmap」は読みません (markmap のオプションは削除しました)。この位置では無視します";
    let with_level = diagnose(
        "---\nmarkmap:\n    initialExpandLevel: 3\nmarkdag:\n    branches: [a]\n---\n\n# root\n\n## a\n",
    );
    assert_eq!(
        with_level,
        [Diagnostic {
            severity: Severity::Warning,
            code: "option-removed".to_string(),
            message: removed.to_string(),
            at: Some(position(2, 1, 7)),
            hint: some(
                "initialExpandLevel は markdag.initialExpandLevel に移します (markdag: の下に字下げして initialExpandLevel: を書きます)。markmap: の行は消します"
            ),
        }]
    );
    let without_level = diagnose(
        "---\ntitle: T\nmarkmap:\n    colorFreezeLevel: 2\n    maxWidth: 300\n---\n\n# root\n",
    );
    let codes: Vec<(&str, Option<&str>)> = without_level
        .iter()
        .map(|item| (item.code.as_str(), item.hint.as_deref()))
        .collect();
    assert_eq!(
        codes,
        [
            (
                "option-removed",
                Some(
                    "markmap のキー (colorFreezeLevel, maxWidth) は削除したオプションで、書いても効きません。markmap: の行ごと消します"
                )
            ),
            ("not-extracted", None),
        ]
    );
    // 値は読まないので、markmap の下の書き損じは型の診断にならない
    assert_eq!(
        check_codes(json!({ "markmap": { "initialExpandLevel": "abc", "autoFit": "no" } })),
        ["option-removed"]
    );
}
