// 原文: test/model.test.ts の describe('タグ') と describe('タグの型と検査') (2026-09-24)。
// buildModel のタグの持ち方 (継承しない、見せ方、グループと別)、markdag.types と markdag.tags.keys による型の解決と本文のタグの検査、
// $ref で読んだ型の重ね方、編集側の候補 (suggestTagKeys / suggestTagValues)、types と tags.keys の形のスキーマの検査を、
// 同じ入力と同じ期待値で見る。関数名は `cargo test -p markdag-core model` で選ばれるよう model_ で始める。
mod common;

use common::{build, build_with, build_with_types, codes, leaf, outline, row, tag};
use markdag_core::model::schema::check_frontmatter;
use markdag_core::model::tags::{suggest_tag_keys, suggest_tag_values};
use markdag_core::types::{Diagnostic, GraphModel, NodeTag, OutlineNode, TagKeySuggestion};
use serde_json::{Value, json};

// ---- describe('タグ') ----

// 原文の tag: 位置はどれも AT(0)
fn tag0(key: &str, values: &[&str]) -> NodeTag {
    tag(key, 0, values)
}

// 1 root / 2 A (owner, urgent) / 3 B (A の子。何も書いていない) / 4 C (グループ backend と、同じ名前の値のないタグ)
fn tree() -> Vec<OutlineNode> {
    outline(vec![
        leaf("root", None),
        row(
            "A",
            Some(0),
            &[],
            None,
            vec![tag0("owner", &["alice"]), tag0("urgent", &[])],
        ),
        leaf("B", Some(1)),
        row(
            "C",
            Some(0),
            &["backend"],
            None,
            vec![tag0("backend", &[]), tag0("status", &["doing", "review"])],
        ),
    ])
}

// 原文: タグは書いたノードだけが持ち、配下には継承しない
#[test]
fn model_tags_belong_only_to_written_node() {
    let model = build(&tree(), json!({ "markdag": {} }));
    assert_eq!(
        model.tags_of.get(&2),
        Some(&vec![tag0("owner", &["alice"]), tag0("urgent", &[])])
    );
    assert_eq!(model.tags_of.get(&3), Some(&Vec::new()));
    assert_eq!(
        model.tags_of.get(&4),
        Some(&vec![
            tag0("backend", &[]),
            tag0("status", &["doing", "review"])
        ])
    );
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
}

// 原文: タグの見せ方は frontmatter の markdag.tags.display でまとめて決まる (既定は always)
#[test]
fn model_tags_display_option() {
    assert_eq!(
        build(&tree(), json!({ "markdag": {} }))
            .tag_display
            .as_str(),
        "always"
    );
    for mode in ["always", "hover", "click", "never"] {
        assert_eq!(
            build(
                &tree(),
                json!({ "markdag": { "tags": { "display": mode } } })
            )
            .tag_display
            .as_str(),
            mode
        );
    }
    let hidden = build(
        &tree(),
        json!({ "markdag": { "tags": { "display": "never" } } }),
    );
    assert_eq!(hidden.tag_display.as_str(), "never");
    // 出さないだけで、タグそのものは持ったまま
    assert_eq!(
        hidden.tags_of.get(&2),
        Some(&vec![tag0("owner", &["alice"]), tag0("urgent", &[])])
    );
    assert!(hidden.diagnostics.is_empty(), "{:?}", hidden.diagnostics);
}

// 原文: グループと同じ名前のタグを書いても、タグはタグのままで、グループの所属は %名前 だけで決まる
#[test]
fn model_tags_with_group_name_stay_tags() {
    let model = build(
        &tree(),
        json!({ "markdag": { "groups": { "backend": { "label": "Backend" } } } }),
    );
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    assert_eq!(
        model.tags_of.get(&4),
        Some(&vec![
            tag0("backend", &[]),
            tag0("status", &["doing", "review"])
        ])
    );
    assert_eq!(model.groups_of.get(&4), Some(&vec!["backend".to_string()]));
}

// ---- describe('タグの型と検査') ----

// 1 root / 2 A (正しい値) / 3 B (誤った値) / 4 C ($api。id は D と重なる) / 5 D
fn typed_doc() -> Vec<OutlineNode> {
    outline(vec![
        leaf("root", None),
        row(
            "A",
            Some(0),
            &[],
            None,
            vec![
                tag("priority", 2, &["high"]),
                tag("estimate", 2, &["3.5"]),
                tag("due", 2, &["2026-10-01"]),
                tag("urgent", 2, &[]),
            ],
        ),
        row(
            "B",
            Some(0),
            &[],
            None,
            vec![
                tag("priority", 3, &["hgih"]),
                tag("estimate", 3, &["abc"]),
                tag("due", 3, &["2026-13-01"]),
                tag("urgent", 3, &["yes"]),
            ],
        ),
        row(
            "C",
            Some(0),
            &[],
            Some("api"),
            vec![
                tag("id", 4, &["T-1"]),
                tag("blockedBy", 4, &["$api"]),
                tag("owner", 4, &["alice", "bob"]),
            ],
        ),
        row(
            "D",
            Some(0),
            &[],
            None,
            vec![
                tag("id", 5, &["T-1"]),
                tag("blockedBy", 5, &["$missing"]),
                tag("owner", 5, &["carol"]),
            ],
        ),
    ])
}

fn keys() -> Value {
    json!({
        "priority": { "type": "enum", "values": ["high", "medium", "low"], "description": "優先度" },
        "estimate": { "type": "number", "min": 0 },
        "due": { "type": "date" },
        "urgent": { "type": "boolean" },
        "id": { "type": "string", "pattern": "^T-\\d+$", "unique": true },
        "blockedBy": { "type": "nodeId" },
        "owner": { "type": "string", "multiple": true },
    })
}

// 原文の found: [code, severity, at?.line ?? null, message, hint]
fn found(model: &GraphModel) -> Value {
    Value::Array(
        model
            .diagnostics
            .iter()
            .map(|item| {
                json!([
                    item.code,
                    item.severity,
                    item.at.as_ref().map(|at| at.line),
                    item.message,
                    item.hint
                ])
            })
            .collect(),
    )
}

fn code_messages(diagnostics: &[Diagnostic]) -> Vec<(&str, &str)> {
    diagnostics
        .iter()
        .map(|item| (item.code.as_str(), item.message.as_str()))
        .collect()
}

// 原文: 値を型に当てて、合わないものだけを本文の行つきで知らせる (既定は warning)
#[test]
fn model_tag_types_check_values_with_body_line() {
    let model = build(
        &typed_doc(),
        json!({ "markdag": { "tags": { "keys": keys() } } }),
    );
    assert_eq!(
        found(&model),
        json!([
            [
                "tag-type",
                "warning",
                3,
                "「B」の #priority:hgih: high / medium / low のどれかで書きます",
                "もしかして「high」"
            ],
            [
                "tag-type",
                "warning",
                3,
                "「B」の #estimate:abc: 数値で書きます",
                null
            ],
            [
                "tag-type",
                "warning",
                3,
                "「B」の #due:2026-13-01: YYYY-MM-DD の日付で書きます",
                null
            ],
            [
                "tag-type",
                "warning",
                3,
                "「B」の #urgent:yes: true か false のどちらかで書きます",
                null
            ],
            [
                "tag-type",
                "warning",
                5,
                "「D」の #blockedBy:$missing: $missing を持つノードがありません",
                "行末に $名前 を付けたノードを指します"
            ],
            [
                "tag-unique",
                "warning",
                4,
                "「C」の #id:T-1 は、ほかのノードにも書かれています (5 行目)",
                "unique のキーなので、値を変えるか片方を消します"
            ],
            [
                "tag-unique",
                "warning",
                5,
                "「D」の #id:T-1 は、ほかのノードにも書かれています (4 行目)",
                "unique のキーなので、値を変えるか片方を消します"
            ],
        ])
    );
    // 検査しても、タグは書いたまま残る
    let values: Vec<Vec<String>> = model
        .tags_of
        .get(&3)
        .expect("B のタグ")
        .iter()
        .map(|item| item.values.clone())
        .collect();
    assert_eq!(values, [["hgih"], ["abc"], ["2026-13-01"], ["yes"]]);
}

// 原文: lint: error で重大度が変わり、unknownKey: deny で定義のないキーも知らせる
#[test]
fn model_tag_types_lint_and_unknown_key() {
    let nodes = outline(vec![
        leaf("root", None),
        row(
            "A",
            Some(0),
            &[],
            None,
            vec![tag("onwer", 2, &["alice"]), tag("memo", 2, &["x"])],
        ),
    ]);
    let model = build(
        &nodes,
        json!({ "markdag": { "tags": { "lint": "error", "unknownKey": "deny", "keys": { "owner": { "type": "string" } } } } }),
    );
    assert_eq!(
        found(&model),
        json!([
            [
                "tag-unknown-key",
                "error",
                2,
                "「A」の #onwer:alice は、markdag.tags.keys に定義のないキーです",
                "もしかして「owner」"
            ],
            [
                "tag-unknown-key",
                "error",
                2,
                "「A」の #memo:x は、markdag.tags.keys に定義のないキーです",
                "keys に定義するか、unknownKey を allow にします"
            ],
        ])
    );
    // 定義がなく allow (既定) なら何も言わない
    assert!(
        build(&typed_doc(), json!({ "markdag": {} }))
            .diagnostics
            .is_empty()
    );
}

// 原文: 値の数を見る: 値なしは boolean だけが許され、複数の値は multiple のキーだけが許される
#[test]
fn model_tag_types_value_count() {
    let nodes = outline(vec![
        leaf("root", None),
        row(
            "A",
            Some(0),
            &[],
            None,
            vec![
                tag("due", 2, &[]),
                tag("urgent", 2, &[]),
                tag("due", 2, &["2026-10-01", "2026-10-02"]),
            ],
        ),
    ]);
    let model = build(
        &nodes,
        json!({ "markdag": { "tags": { "keys": { "due": { "type": "date" }, "urgent": { "type": "boolean" } } } } }),
    );
    // 同じキーを 1 行に 2 回書いたものは parse 層でつながるが、ここでは別々のタグとして渡している
    assert_eq!(
        code_messages(&model.diagnostics),
        [
            (
                "tag-missing-value",
                "「A」の #due には値が要ります (YYYY-MM-DD の日付)"
            ),
            (
                "tag-multiple",
                "「A」の #due:2026-10-01,2026-10-02 は値を 1 つだけ書くキーです"
            ),
        ]
    );
}

// 原文: 名前付きの型は制約を足すだけで派生でき、type の一覧はどれかに合えば通る
#[test]
fn model_tag_types_named_types_and_alternatives() {
    let nodes = outline(vec![
        leaf("root", None),
        row(
            "A",
            Some(0),
            &[],
            None,
            vec![
                tag("id", 2, &["JIRA-12"]),
                tag("priority", 2, &["3"]),
                tag("priority", 2, &["high"]),
            ],
        ),
        row(
            "B",
            Some(0),
            &[],
            None,
            vec![
                tag("id", 3, &["ABC-12"]),
                tag("priority", 3, &["9"]),
                tag("priority", 3, &["medium"]),
            ],
        ),
    ]);
    let model = build(
        &nodes,
        json!({
            "markdag": {
                "types": {
                    "ticket": { "type": "string", "pattern": "^[A-Z]+-\\d+$" },
                    "jira": { "type": "ticket", "pattern": "^JIRA-" },
                    "level": { "type": "integer", "min": 1, "max": 5 },
                },
                "tags": { "keys": { "id": { "type": "jira" }, "priority": { "type": ["level", "enum"], "values": ["high", "low"], "multiple": true } } },
            },
        }),
    );
    assert_eq!(
        serde_json::to_value(&model.tag_keys).expect("tagKeys"),
        json!([
            { "key": "id", "alternatives": [{ "primitive": "string", "patterns": ["^[A-Z]+-\\d+$", "^JIRA-"] }], "multiple": false, "unique": false, "description": null },
            { "key": "priority", "alternatives": [{ "primitive": "integer", "min": 1, "max": 5 }, { "primitive": "enum", "values": ["high", "low"] }], "multiple": true, "unique": false, "description": null },
        ])
    );
    let lines: Vec<(&str, Option<u32>, &str)> = model
        .diagnostics
        .iter()
        .map(|item| {
            (
                item.code.as_str(),
                item.at.as_ref().map(|at| at.line),
                item.message.as_str(),
            )
        })
        .collect();
    assert_eq!(
        lines,
        [
            (
                "tag-type",
                Some(3),
                "「B」の #id:ABC-12: 「^JIRA-」の形に合いません"
            ),
            (
                "tag-type",
                Some(3),
                "「B」の #priority:9 の「9」は 整数 (1 以上、5 以下)、high / low のどれか のどれにも合いません"
            ),
            (
                "tag-type",
                Some(3),
                "「B」の #priority:medium の「medium」は 整数 (1 以上、5 以下)、high / low のどれか のどれにも合いません"
            ),
        ]
    );
}

// 原文: 型の定義の誤りは、位置つきで知らせて、そのキーの検査をやめる
#[test]
fn model_tag_types_definition_errors_have_position() {
    let nodes = outline(vec![
        leaf("root", None),
        row(
            "A",
            Some(0),
            &[],
            None,
            vec![
                tag("a", 2, &["x"]),
                tag("b", 2, &["x"]),
                tag("c", 2, &["x"]),
            ],
        ),
    ]);
    let markdown = [
        "---",
        "markdag:",
        "    types:",
        "        loop:",
        "            type: loop",
        "        string:",
        "            type: string",
        "        bad:",
        "            type: number",
        "            pattern: x",
        "            min: \"1\"",
        "    tags:",
        "        keys:",
        "            a:",
        "                type: strng",
        "            b:",
        "                type: loop",
        "            c:",
        "                type: enum",
        "---",
        "",
        "# root",
        "",
        "## A #a:x #b:x #c:x",
        "",
    ]
    .join("\n");
    let model = build_with(
        &nodes,
        json!({
            "markdag": {
                "types": { "loop": { "type": "loop" }, "string": { "type": "string" }, "bad": { "type": "number", "pattern": "x", "min": "1" } },
                "tags": { "keys": { "a": { "type": "strng" }, "b": { "type": "loop" }, "c": { "type": "enum" } } },
            },
        }),
        Some(&markdown),
    );
    let described: Vec<(&str, Option<u32>, &str, Option<&str>)> = model
        .diagnostics
        .iter()
        .map(|item| {
            (
                item.code.as_str(),
                item.at.as_ref().map(|at| at.line),
                item.message.as_str(),
                item.hint.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        described,
        [
            (
                "type-reserved",
                Some(6),
                "markdag.types.string は組み込みの型と同じ名前なので定義できません",
                Some("別の名前にします")
            ),
            (
                "type-unknown",
                Some(15),
                "markdag.tags.keys.a の型「strng」は、組み込みの型にも markdag.types にもありません",
                Some("もしかして「string」")
            ),
            (
                "type-cycle",
                Some(5),
                "型「loop」の定義が自分自身に戻っています (loop → loop)",
                Some("型の type には、自分より基底の型を書きます")
            ),
            // values の行はないので、キーの行を指す
            (
                "type-invalid",
                Some(18),
                "markdag.tags.keys.c は enum なので values (許す値の一覧) が要ります",
                Some("values: の下に、許す値を「- high」の形で 1 行ずつ並べます"),
            ),
        ]
    );
    // 使われていない型 (bad) の誤りは、使われたときに知らせる
    let used = build_with(
        &nodes,
        json!({ "markdag": { "types": { "bad": { "type": "number", "pattern": "x", "min": "1" } }, "tags": { "keys": { "a": { "type": "bad" } } } } }),
        Some(&markdown),
    );
    assert_eq!(
        code_messages(&used.diagnostics),
        [
            (
                "type-invalid",
                "markdag.types.bad の pattern は string の型にだけ書けます (この型は number)"
            ),
            (
                "type-invalid",
                "markdag.types.bad の min は、number の型では数値で書きます"
            ),
            ("tag-type", "「A」の #a:x: 数値で書きます"),
        ]
    );
}

// 原文: $ref で読んだ型は一覧の順に重ねて後勝ちにし、文書の types がさらに優先する。読めなければ warning にして、その型を使うキーは検査しない
#[test]
fn model_tag_types_ref_layers_and_unresolved() {
    let nodes = outline(vec![
        leaf("root", None),
        row("A", Some(0), &[], None, vec![tag("p", 2, &["4"])]),
    ]);
    let frontmatter = |own: Value| {
        let mut types = json!({ "$ref": ["./a.yaml", "./b.yaml"] });
        if let (Some(types), Value::Object(own)) = (types.as_object_mut(), own) {
            types.extend(own);
        }
        json!({ "markdag": { "types": types, "tags": { "keys": { "p": { "type": "level" } } } } })
    };
    let a = json!({ "level": { "type": "integer", "max": 3 } });
    let loaded = json!({ "./a.yaml": a, "./b.yaml": { "level": { "type": "integer", "max": 5 } } });
    assert!(
        build_with_types(&nodes, frontmatter(json!({})), loaded.clone())
            .diagnostics
            .is_empty()
    );
    assert_eq!(
        codes(&build_with_types(
            &nodes,
            frontmatter(json!({ "level": { "type": "integer", "max": 2 } })),
            loaded
        )),
        ["tag-type"]
    );
    let unresolved = build_with_types(&nodes, frontmatter(json!({})), json!({ "./a.yaml": a }));
    assert_eq!(
        code_messages(&unresolved.diagnostics),
        [(
            "types-unresolved",
            "markdag.types.$ref「./b.yaml」を読めなかったので、その中の型は使えません (その型を使うキーは検査しません)"
        )]
    );
    // 読めたほうの定義 (max: 3) には合わないが、読めなかった側で上書きされるかもしれないので黙って通す
    assert_eq!(
        codes(&build_with_types(
            &nodes,
            frontmatter(json!({})),
            json!({ "./b.yaml": null })
        )),
        ["types-unresolved", "types-unresolved"]
    );
    // 組み込みの型を直接書いたキーは、読めなくても検査する
    let direct = build(
        &nodes,
        json!({ "markdag": { "types": { "$ref": "./a.yaml" }, "tags": { "keys": { "p": { "type": "integer", "max": 3 } } } } }),
    );
    assert_eq!(codes(&direct), ["types-unresolved", "tag-type"]);
}

// 原文: 日時、時刻、期間は書き方と範囲を見る
#[test]
fn model_tag_types_datetime_time_duration() {
    let nodes = outline(vec![
        leaf("root", None),
        row(
            "A",
            Some(0),
            &[],
            None,
            vec![
                tag("start", 2, &["2026-10-01T09:30"]),
                tag("at", 2, &["17:59:30"]),
                tag("est", 2, &["1.5d"]),
                tag("start", 2, &["2026-10-01 09:30+09:00"]),
            ],
        ),
        row(
            "B",
            Some(0),
            &[],
            None,
            vec![
                tag("start", 3, &["2026-09-30T23:59"]),
                tag("at", 3, &["18:01"]),
                tag("est", 3, &["3d"]),
                tag("est", 3, &["2 days"]),
            ],
        ),
    ]);
    let model = build(
        &nodes,
        json!({ "markdag": { "tags": { "keys": {
            "start": { "type": "datetime", "min": "2026-10-01T00:00" },
            "at": { "type": "time", "max": "18:00" },
            "est": { "type": "duration", "max": "2d" },
        } } } }),
    );
    let lines: Vec<(Option<u32>, &str)> = model
        .diagnostics
        .iter()
        .map(|item| (item.at.as_ref().map(|at| at.line), item.message.as_str()))
        .collect();
    assert_eq!(
        lines,
        [
            (
                Some(3),
                "「B」の #start:2026-09-30T23:59: 2026-10-01T00:00 以上で書きます"
            ),
            (Some(3), "「B」の #at:18:01: 18:00 以下で書きます"),
            (Some(3), "「B」の #est:3d: 2d 以下で書きます"),
            (
                Some(3),
                "「B」の #est:\"2 days\": 30m / 2h / 3d / 1w のような期間で書きます"
            ),
        ]
    );
}

// 原文: 編集側の候補は、キーの名前と、enum と boolean の値だけを出す
#[test]
fn model_tag_types_suggestions() {
    let model = build(
        &typed_doc(),
        json!({ "markdag": { "tags": { "keys": keys() } } }),
    );
    assert_eq!(
        suggest_tag_keys(&model.tag_keys, Some("p")),
        [TagKeySuggestion {
            key: "priority".to_string(),
            description: Some("優先度".to_string())
        }]
    );
    let all: Vec<String> = suggest_tag_keys(&model.tag_keys, None)
        .into_iter()
        .map(|item| item.key)
        .collect();
    assert_eq!(
        all,
        [
            "priority",
            "estimate",
            "due",
            "urgent",
            "id",
            "blockedBy",
            "owner"
        ]
    );
    assert_eq!(
        suggest_tag_values(&model.tag_keys, "priority", Some("h")),
        ["high"]
    );
    assert_eq!(
        suggest_tag_values(&model.tag_keys, "urgent", None),
        ["true", "false"]
    );
    assert!(suggest_tag_values(&model.tag_keys, "due", None).is_empty());
    assert!(suggest_tag_values(&model.tag_keys, "nothing", None).is_empty());
}

// 原文: types と tags.keys の形はスキーマが検査する
#[test]
fn model_tag_types_schema_checks_types_and_keys() {
    let codes = |frontmatter: Value| -> Vec<(String, Option<String>)> {
        let frontmatter = common::js(frontmatter);
        check_frontmatter(&frontmatter, None)
            .into_iter()
            .map(|item| (item.code, item.hint))
            .collect()
    };
    let one = |code: &str, hint: &str| vec![(code.to_string(), Some(hint.to_string()))];
    assert_eq!(
        codes(json!({ "markdag": { "types": { "a": { "type": 3 } } } })),
        one(
            "type-invalid",
            "「type: string」のように 1 つ書くか、「- enum」の形で 1 行ずつ並べます"
        )
    );
    assert_eq!(
        codes(json!({ "markdag": { "types": { "a": { "typo": "x" } } } })),
        one("type-invalid", "もしかして「type」")
    );
    assert_eq!(
        codes(json!({ "markdag": { "tags": { "keys": { "a": { "multiple": "yes" } } } } })),
        one(
            "type-invalid",
            "true か false と書きます。yes は YAML では文字列になります"
        )
    );
    assert_eq!(
        codes(json!({ "markdag": { "tags": { "lint": "warn" } } })),
        one("option-invalid", "warning か error と書きます")
    );
    assert_eq!(
        codes(json!({ "markdag": { "tags": { "unknownKey": "denny" } } })),
        one("option-invalid", "もしかして「deny」")
    );
    assert_eq!(
        codes(json!({ "markdag": { "types": { "$ref": 3 } } })),
        one(
            "option-invalid",
            "「$ref: ./types.yaml」のように文書からの相対パスを書くか、「- ./a.yaml」の形で 1 行ずつ並べます"
        )
    );
    assert!(codes(json!({
        "markdag": {
            "types": { "$ref": "./t.yaml", "a": { "type": ["string", "number"], "min": 1, "values": ["x"], "pattern": "y" } },
            "tags": { "lint": "error", "unknownKey": "deny", "keys": { "a": { "type": "a", "multiple": true, "unique": true, "description": "d" } } },
        },
    }))
    .is_empty());
}
