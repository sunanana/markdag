// 原文: test/model.test.ts の describe('model 層') と describe('参照の経路の区切り') (2026-09-24)。
// buildModel の relations の展開、閉路、groups の継承、branches、表示のオプション、参照の診断を、同じ入力と同じ期待値で見る。
// 入力は原文のテストと同じく、解析の層を通さずにノードの木を直接組み、frontmatter は JSON から JsValue に読む。
// 関数名は `cargo test -p markdag-core model` で選ばれるよう model_ で始める。
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::util::JsValue;
use markdag_core::types::{
    Diagnostic, DisplayMode, GraphModel, LegendItem, LegendPosition, OutlineNode, RelationKind,
    Severity, SourcePosition,
};
use serde_json::{Value, json};

// [参照用のテキスト, 親の位置 (0 始まり。ルートは None), グループ, $id]。原文の Row からタグを除いたもの
type Row<'a> = (&'a str, Option<usize>, &'a [&'a str], Option<&'a str>);

fn outline(rows: &[Row]) -> Vec<OutlineNode> {
    let mut nodes: Vec<OutlineNode> = Vec::new();
    for (index, (ref_text, parent_index, groups, ref_id)) in rows.iter().enumerate() {
        let parent = parent_index.and_then(|at| nodes.get(at));
        let node = OutlineNode {
            id: u32::try_from(index + 1).expect("ノードの数"),
            parent: parent.map(|node| node.id),
            depth: parent.map_or(0, |node| node.depth) + 1,
            html: (*ref_text).to_string(),
            ref_text: (*ref_text).to_string(),
            ref_id: ref_id.map(str::to_string),
            groups: groups.iter().map(|name| (*name).to_string()).collect(),
            tags: Vec::new(),
            milestone: false,
            fold_hint: 0.0,
            lines: None,
            task: None,
            details: None,
        };
        nodes.push(node);
    }
    nodes
}

fn leaf(ref_text: &str, parent: Option<usize>) -> Row<'_> {
    (ref_text, parent, &[], None)
}

// fixture の「新機能エピック」と同じ木
fn epic() -> Vec<OutlineNode> {
    outline(&[
        leaf("新機能エピック", None),
        leaf("仕様策定", Some(0)),
        ("画面開発", Some(1), &["frontend"], None),
        leaf("一覧画面", Some(2)),
        leaf("登録画面", Some(2)),
        ("API開発", Some(1), &["backend"], None),
        leaf("登録API POST /items", Some(5)),
        leaf("削除API DELETE /items/:id", Some(5)),
        leaf("一覧取得API GET /items", Some(5)),
        leaf("開発完了", Some(0)),
        leaf("リリース準備", Some(0)),
        ("デプロイ手順の確認", Some(10), &["backend"], None),
        ("ロールバック手順の確認", Some(10), &["backend"], None),
        ("受け入れテスト", Some(10), &["qa"], None),
        leaf("リリースノート作成", Some(0)),
        leaf("リリース", Some(0)),
        ("効果測定", Some(0), &["backend", "frontend"], None),
    ])
}

fn epic_frontmatter() -> Value {
    json!({
        "markdag": {
            "relations": {
                "join": ["仕様策定/* --> 開発完了"],
                "chain": ["開発完了 --> リリース準備 --> リリースノート作成 --> リリース --> 効果測定"],
                "depends": ["登録API --> 登録画面"],
            },
            "groups": {
                "backend": { "label": "バックエンド", "color": "#D64545", "boundary": true },
                "frontend": { "label": "フロントエンド", "color": "#3B7DD8", "boundary": true },
                "qa": { "label": "QA", "color": "#E0A100" },
            },
        },
    })
}

fn build(nodes: &[OutlineNode], frontmatter: Value) -> GraphModel {
    build_with(nodes, frontmatter, None)
}

fn build_with(nodes: &[OutlineNode], frontmatter: Value, markdown: Option<&str>) -> GraphModel {
    let frontmatter: JsValue = serde_json::from_value(frontmatter).expect("テストの frontmatter");
    build_model(nodes, &frontmatter, markdown, &ModelOptions::default())
}

fn pairs(model: &GraphModel, kind: RelationKind) -> Vec<String> {
    model
        .relations
        .iter()
        .filter(|relation| relation.kind == kind)
        .map(|relation| format!("{}>{}", relation.source, relation.target))
        .collect()
}

fn codes(model: &GraphModel) -> Vec<&str> {
    model
        .diagnostics
        .iter()
        .map(|item| item.code.as_str())
        .collect()
}

fn root_only() -> Vec<OutlineNode> {
    outline(&[leaf("root", None)])
}

fn info(code: &str, message: &str, hint: &str) -> Diagnostic {
    Diagnostic {
        severity: Severity::Info,
        code: code.to_string(),
        message: message.to_string(),
        at: None,
        hint: Some(hint.to_string()),
    }
}

// 原文: 「新機能エピック」の relations を、手で書き起こしたエッジと同じに展開する
#[test]
fn model_epic_relations_expand_to_hand_written_edges() {
    let model = build(&epic(), epic_frontmatter());
    assert_eq!(
        model.diagnostics,
        vec![info(
            "ref-prefix",
            "「登録API --> 登録画面」: 「登録API」は前方一致で「登録API POST /items」に解決しました",
            "書き間違いなら「登録API POST /items」に直します",
        )]
    );
    assert_eq!(
        pairs(&model, RelationKind::Join),
        ["4>10", "5>10", "7>10", "8>10", "9>10"]
    );
    assert_eq!(
        pairs(&model, RelationKind::Chain),
        ["10>11", "11>15", "15>16", "16>17"]
    );
    // 「登録API」は前方一致、「リリース」は完全一致が優先される
    assert_eq!(pairs(&model, RelationKind::Depends), ["7>5"]);
    assert_eq!(model.suppress_root_line, [10, 11, 15, 16, 17]);
}

// 原文: グループの所属は配下に継承し、groups の定義順に並べる
#[test]
fn model_groups_inherit_to_descendants_in_definition_order() {
    let model = build(&epic(), epic_frontmatter());
    assert_eq!(model.groups_of.get(&7), Some(&vec!["backend".to_string()]));
    assert_eq!(model.groups_of.get(&4), Some(&vec!["frontend".to_string()]));
    assert_eq!(
        model.groups_of.get(&17),
        Some(&vec!["backend".to_string(), "frontend".to_string()])
    );
    assert_eq!(model.groups_of.get(&2), Some(&Vec::new()));
}

// 原文: $id、パス、& を解決する
#[test]
fn model_resolves_ref_id_path_and_ampersand() {
    let nodes = outline(&[
        leaf("root", None),
        leaf("A", Some(0)),
        leaf("確認", Some(1)),
        leaf("B", Some(0)),
        leaf("確認", Some(3)),
        ("C", Some(0), &[], Some("goal")),
    ]);
    let model = build(
        &nodes,
        json!({ "markdag": { "relations": { "join": ["A/確認 & B/確認 --> $goal"] } } }),
    );
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    assert_eq!(pairs(&model, RelationKind::Join), ["3>6", "5>6"]);
}

// 原文: 詳細の見せ方は frontmatter の markdag.details.display で指定でき、使えない値は警告にして指定なしとして扱う
#[test]
fn model_details_display_option() {
    let nodes = root_only();
    assert_eq!(build(&nodes, json!({})).details_mode, None);
    assert_eq!(
        build(&nodes, json!({ "markdag": { "details": {} } })).details_mode,
        None
    );
    assert_eq!(
        build(
            &nodes,
            json!({ "markdag": { "details": { "display": "always" } } })
        )
        .details_mode,
        Some(DisplayMode::Always)
    );
    let invalid = build(
        &nodes,
        json!({ "markdag": { "details": { "display": "open" } } }),
    );
    assert_eq!(invalid.details_mode, None);
    assert_eq!(codes(&invalid), ["option-invalid"]);
}

// 原文: 凡例に出す項目は frontmatter の markdag.legend.display で指定でき、指定がなければグループと枝を出す
#[test]
fn model_legend_display_option() {
    let nodes = root_only();
    let both = [LegendItem::Groups, LegendItem::Branches];
    assert_eq!(build(&nodes, json!({})).legend, both);
    assert_eq!(
        build(&nodes, json!({ "markdag": { "legend": {} } })).legend,
        both
    );
    assert_eq!(
        build(
            &nodes,
            json!({ "markdag": { "legend": { "display": true } } })
        )
        .legend,
        both
    );
    assert_eq!(
        build(
            &nodes,
            json!({ "markdag": { "legend": { "display": false } } })
        )
        .legend,
        []
    );
    assert_eq!(
        build(
            &nodes,
            json!({ "markdag": { "legend": { "display": ["branches"] } } })
        )
        .legend,
        [LegendItem::Branches]
    );

    let unknown = build(
        &nodes,
        json!({ "markdag": { "legend": { "display": ["groups", "lines"] } } }),
    );
    assert_eq!(unknown.legend, [LegendItem::Groups]);
    assert_eq!(codes(&unknown), ["option-invalid"]);
    let wrong_type = build(
        &nodes,
        json!({ "markdag": { "legend": { "display": "all" } } }),
    );
    assert_eq!(wrong_type.legend, both);
    assert_eq!(codes(&wrong_type), ["option-invalid"]);
}

// 原文: 凡例を置く隅は frontmatter の markdag.legend.position で指定でき、指定がなければ右上に置く
#[test]
fn model_legend_position_option() {
    let nodes = root_only();
    assert_eq!(
        build(&nodes, json!({})).legend_position,
        LegendPosition::TopRight
    );
    assert_eq!(
        build(
            &nodes,
            json!({ "markdag": { "legend": { "display": ["groups"] } } })
        )
        .legend_position,
        LegendPosition::TopRight
    );
    for position in ["top-right", "top-left", "bottom-right", "bottom-left"] {
        let model = build(
            &nodes,
            json!({ "markdag": { "legend": { "position": position } } }),
        );
        assert_eq!(model.legend_position.as_str(), position);
        assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    }

    let invalid = build(
        &nodes,
        json!({ "markdag": { "legend": { "position": "bottom-rigth" } } }),
    );
    assert_eq!(invalid.legend_position, LegendPosition::TopRight);
    let first = invalid.diagnostics.first().expect("診断");
    assert_eq!(first.code, "option-invalid");
    assert_eq!(
        first.message,
        "markdag.legend.position に指定できるのは top-right, top-left, bottom-right, bottom-left です (\"bottom-rigth\")"
    );
    assert!(
        first
            .hint
            .as_deref()
            .is_some_and(|hint| hint.contains("bottom-right")),
        "{:?}",
        first.hint
    );
}

// 原文: 一覧や真偽値を legend に直接書く前の形は、警告にして指定なしとして扱う
#[test]
fn model_legend_old_shape_is_warned_and_ignored() {
    let nodes = root_only();
    for old in [json!(false), json!(["branches"])] {
        let model = build(&nodes, json!({ "markdag": { "legend": old } }));
        assert_eq!(model.legend, [LegendItem::Groups, LegendItem::Branches]);
        assert_eq!(model.legend_position, LegendPosition::TopRight);
        assert_eq!(codes(&model), ["option-invalid"]);
        let first = &model.diagnostics[0];
        assert!(
            first
                .message
                .contains("markdag.legend はキーと値の組で書きます"),
            "{}",
            first.message
        );
        assert!(
            first
                .hint
                .as_deref()
                .is_some_and(|hint| hint.contains("display")),
            "{:?}",
            first.hint
        );
    }
    let unknown_key = build(
        &nodes,
        json!({ "markdag": { "legend": { "pos": "top-left" } } }),
    );
    assert_eq!(codes(&unknown_key), ["option-unknown"]);
}

// 原文: 線をクリックしての強調は frontmatter の markdag.edgeHighlight で切れる (既定は使える)
#[test]
fn model_edge_highlight_option() {
    let nodes = root_only();
    assert!(build(&nodes, json!({})).edge_highlight);
    assert!(build(&nodes, json!({ "markdag": {} })).edge_highlight);
    assert!(build(&nodes, json!({ "markdag": { "edgeHighlight": true } })).edge_highlight);
    assert!(!build(&nodes, json!({ "markdag": { "edgeHighlight": false } })).edge_highlight);
    // 真偽値でない値はスキーマが警告にして、指定なしと同じ扱いにする
    let invalid = build(&nodes, json!({ "markdag": { "edgeHighlight": "no" } }));
    assert!(invalid.edge_highlight);
    assert_eq!(codes(&invalid), ["option-invalid"]);
}

// 原文: グループの枠をクリックしての強調は frontmatter の markdag.groupHighlight で切れる (既定は使える)
#[test]
fn model_group_highlight_option() {
    let nodes = root_only();
    assert!(build(&nodes, json!({})).group_highlight);
    assert!(build(&nodes, json!({ "markdag": { "groupHighlight": true } })).group_highlight);
    assert!(!build(&nodes, json!({ "markdag": { "groupHighlight": false } })).group_highlight);
    let invalid = build(&nodes, json!({ "markdag": { "groupHighlight": "no" } }));
    assert!(invalid.group_highlight);
    assert_eq!(codes(&invalid), ["option-invalid"]);
}

// 原文: 色を分ける枝の起点は frontmatter の markdag.branches で指定でき、1 ノードでない指定と解決できない指定は警告にする
#[test]
fn model_branches_option_and_its_diagnostics() {
    let nodes = outline(&[
        leaf("root", None),
        leaf("A", Some(0)),
        leaf("確認", Some(1)),
        leaf("B", Some(0)),
    ]);
    let unset = build(&nodes, json!({}));
    assert!(unset.branches.is_empty(), "{:?}", unset.branches);
    assert_eq!(
        build(
            &nodes,
            json!({ "markdag": { "branches": ["B", "A/確認"] } })
        )
        .branches,
        [4, 3]
    );

    let invalid = build(
        &nodes,
        json!({ "markdag": { "branches": ["A/*", "(B)", "C", 3, "B", "B"] } }),
    );
    assert_eq!(invalid.branches, [4]);
    // 先の 2 件はスキーマが出すもの (文字列でない項目と、同じ項目の重なり)。あとの 3 件は木を見ないと決まらないもの
    assert_eq!(
        codes(&invalid),
        [
            "option-invalid",
            "option-invalid",
            "option-invalid",
            "option-invalid",
            "ref-not-found"
        ]
    );
    assert_eq!(
        invalid.diagnostics[4].message,
        "markdag.branches: 「C」に一致するノードがありません"
    );
    let wrong_type = build(&nodes, json!({ "markdag": { "branches": "A" } }));
    assert!(wrong_type.branches.is_empty(), "{:?}", wrong_type.branches);
    assert_eq!(codes(&wrong_type), ["option-invalid"]);
}

// 原文: 名前の先頭だけが一致した参照は、書き間違いに気づけるよう参考の診断に出す
#[test]
fn model_prefix_match_is_reported_as_info() {
    let nodes = outline(&[
        leaf("root", None),
        leaf("リリース", Some(0)),
        leaf("開発", Some(0)),
    ]);
    let model = build(
        &nodes,
        json!({ "markdag": { "branches": ["リリー"], "relations": { "chain": ["開発 --> リリース"] } } }),
    );
    assert_eq!(model.branches, [2]);
    assert_eq!(
        model.diagnostics,
        vec![info(
            "ref-prefix",
            "markdag.branches: 「リリー」は前方一致で「リリース」に解決しました",
            "書き間違いなら「リリース」に直します",
        )]
    );
}

// 原文: 原文を渡すと、診断に frontmatter での位置と、近い名前の手がかりが付く
#[test]
fn model_diagnostic_gets_position_and_hint_with_markdown() {
    let nodes = outline(&[
        leaf("root", None),
        leaf("リリース", Some(0)),
        leaf("開発", Some(0)),
    ]);
    let markdown = [
        "---",
        "markdag:",
        "    branches:",
        "        - 開発",
        "        - リリーズ",
        "---",
        "",
        "# root",
    ]
    .join("\n");
    let model = build_with(
        &nodes,
        json!({ "markdag": { "branches": ["開発", "リリーズ"] } }),
        Some(&markdown),
    );
    assert_eq!(model.branches, [3]);
    assert_eq!(
        model.diagnostics,
        vec![Diagnostic {
            severity: Severity::Warning,
            code: "ref-not-found".to_string(),
            message: "markdag.branches: 「リリーズ」に一致するノードがありません".to_string(),
            at: Some(SourcePosition {
                line: 5,
                column: 11,
                length: 4
            }),
            hint: Some("もしかして「リリース」".to_string()),
        }]
    );
}

// 原文: 式の中の参照は、その語が式に 1 つだけあるときはその桁を指す
#[test]
fn model_ref_in_expression_points_at_its_column() {
    let nodes = outline(&[
        leaf("root", None),
        leaf("開発", Some(0)),
        leaf("リリース", Some(0)),
    ]);
    let markdown = [
        "---",
        "markdag:",
        "    relations:",
        "        chain:",
        "            - 開発 --> リリーズ",
        "---",
        "",
        "# root",
    ]
    .join("\n");
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "chain": ["開発 --> リリーズ"] } } }),
        Some(&markdown),
    );
    let places: Vec<Option<SourcePosition>> = model
        .diagnostics
        .iter()
        .map(|item| item.at.clone())
        .collect();
    assert_eq!(
        places,
        [Some(SourcePosition {
            line: 5,
            column: 22,
            length: 4
        })]
    );
}

// 原文: markdag の下の知らないキーと、markdag の外に置かれた指定を警告にする
#[test]
fn model_unknown_and_misplaced_keys_are_warned() {
    let nodes = root_only();
    let unknown = build(&nodes, json!({ "markdag": { "branch": ["A"] } }));
    assert_eq!(codes(&unknown), ["option-unknown"]);
    let misplaced = build(
        &nodes,
        json!({ "branches": ["A"], "relations": { "chain": ["A --> B"] }, "markdag": {} }),
    );
    assert!(misplaced.branches.is_empty(), "{:?}", misplaced.branches);
    assert!(misplaced.relations.is_empty(), "{:?}", misplaced.relations);
    assert_eq!(codes(&misplaced), ["option-misplaced", "option-misplaced"]);
}

// 原文: あいまいな参照、見つからない参照、閉路、未知のキーを診断にして、描画は続けられる形で返す
#[test]
fn model_ambiguous_missing_cycle_and_unknown_key_are_diagnosed() {
    let nodes = outline(&[
        leaf("root", None),
        leaf("A", Some(0)),
        leaf("確認", Some(1)),
        leaf("B", Some(0)),
        leaf("確認", Some(3)),
    ]);
    let model = build(
        &nodes,
        json!({
            "markdag": {
                "relations": {
                    "depends": ["確認 --> A", "なし --> A", "A --> B", "B --> A", "A -> B"],
                    "flow": ["A --> B"],
                },
            },
        }),
    );
    // 形と型の検査 (--> のない式、知らないキー) が先に並び、そのあとに木とグラフを見る検査が続く
    assert_eq!(
        codes(&model),
        [
            "relation-syntax",
            "relation-unknown-key",
            "ref-ambiguous",
            "ref-not-found",
            "cycle"
        ]
    );
    assert_eq!(pairs(&model, RelationKind::Depends), ["2>4"]);
}

// 原文: describe('参照の経路の区切り') の「\/」と書いた「/」は区切りにせず、名前の一部として照合する
#[test]
fn model_escaped_slash_is_part_of_name() {
    let nodes = outline(&[
        leaf("root", None),
        leaf("入出力", Some(0)),
        leaf("I/O", Some(1)),
        leaf("完了", Some(0)),
    ]);
    let model = build(
        &nodes,
        json!({ "markdag": { "relations": { "depends": ["入出力/I\\/O --> 完了"] } } }),
    );
    assert!(model.diagnostics.is_empty(), "{:?}", model.diagnostics);
    assert_eq!(pairs(&model, RelationKind::Depends), ["3>4"]);
}
