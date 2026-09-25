// 入力の上限 (A-105 の (a)、A-156 の (b)) の確かめ。上限ちょうどの入力は通り、上限を 1 つ越えた入力は
// 「入れ子が深すぎます」などの分かる診断か誤りになる (スタックあふれや終わらない計算にならない)。
// cargo test の debug のビルドは 1 段あたりのスタックが大きいので、深い入力は大きなスタックのスレッドで回す。
// wasm (release、1 MiB のスタック) で trap しないことは test/wasm-limits.test.ts が境界を通して確かめる。
use indexmap::IndexMap;
use markdag_core::layout::layout::{LayoutOptions, MARKMAP_DEFAULTS};
use markdag_core::layout::pipeline::layout_document;
use markdag_core::layout::project::project;
use markdag_core::limits::{MAX_NESTING, MAX_YAML_NESTING};
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::util::JsValue;
use markdag_core::parse::parse_document;
use markdag_core::types::{
    Diagnostic, GraphModel, LayoutError, LayoutInput, LayoutInputEdge, LayoutInputNode,
    LayoutInputRelation, ParsedDocument, RelationKind, Severity, SourcePosition,
};

fn with_big_stack<T: Send + 'static>(run: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(run)
        .expect("スレッドを作れる")
        .join()
        .expect("スタックが足りる")
}

fn render(source: String) -> (ParsedDocument, GraphModel) {
    with_big_stack(move || {
        let parsed = parse_document(&source);
        let model = build_model(
            &parsed.nodes,
            &parsed.frontmatter,
            Some(&source),
            &ModelOptions::default(),
        );
        (parsed, model)
    })
}

fn find<'a>(model: &'a GraphModel, code: &str) -> Vec<&'a Diagnostic> {
    model
        .diagnostics
        .iter()
        .filter(|item| item.code == code)
        .collect()
}

fn nested_list(depth: usize) -> String {
    (0..depth)
        .map(|index| format!("{}- a{index}", "  ".repeat(index)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn max_depth(parsed: &ParsedDocument) -> u32 {
    parsed
        .nodes
        .iter()
        .map(|node| node.depth)
        .max()
        .unwrap_or(0)
}

#[test]
fn limits_nested_list_at_limit_is_drawn_whole() {
    let (parsed, model) = render(nested_list(MAX_NESTING));
    assert!(find(&model, "nesting-too-deep").is_empty());
    // ルート (空の包みは畳まれて最初の項目) から最後の項目まで、すべてノードになる
    assert_eq!(parsed.nodes.len(), MAX_NESTING);
    assert_eq!(max_depth(&parsed), MAX_NESTING as u32);
}

#[test]
fn limits_nested_list_over_limit_is_cut_with_a_positioned_error() {
    let (parsed, model) = render(nested_list(MAX_NESTING + 1));
    assert_eq!(parsed.nodes.len(), MAX_NESTING);
    let found = find(&model, "nesting-too-deep");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].severity, Severity::Error);
    assert_eq!(
        found[0].message,
        "入れ子が深すぎます (上限 500 段)。これより深い部分は図に出ません"
    );
    // 501 段目のリストの印 (字下げ 1000 桁のあと)
    let line = MAX_NESTING as u32 + 1;
    let column = 2 * MAX_NESTING as u32 + 1;
    assert_eq!(
        found[0].at,
        Some(SourcePosition {
            line,
            column,
            length: format!("- a{MAX_NESTING}").len() as u32
        })
    );
}

#[test]
fn limits_far_too_deep_list_does_not_overflow() {
    let (parsed, model) = render(nested_list(1500));
    assert_eq!(parsed.nodes.len(), MAX_NESTING);
    assert_eq!(find(&model, "nesting-too-deep").len(), 1);
}

#[test]
fn limits_quotes_count_each_level() {
    let quote = |depth: usize| format!("# R\n\n{} a", ">".repeat(depth));
    let (_, model) = render(quote(MAX_NESTING));
    assert!(find(&model, "nesting-too-deep").is_empty());
    let (_, model) = render(quote(MAX_NESTING + 1));
    let found = find(&model, "nesting-too-deep");
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].at.as_ref().map(|at| (at.line, at.column)),
        Some((3, MAX_NESTING as u32 + 1))
    );
    // 引用はノードにならないので、図はルートだけのまま
    let (parsed, model) = render(quote(30_000));
    assert_eq!(parsed.nodes.len(), 1);
    assert_eq!(find(&model, "nesting-too-deep").len(), 1);
}

#[test]
fn limits_inline_containers_count_too() {
    // `**` の組 1 つが強調 1 段。見出しの中の強調の入れ子
    let strong = |depth: usize| format!("# {}a{}", "**".repeat(depth), "**".repeat(depth));
    let (parsed, model) = render(strong(MAX_NESTING));
    assert!(find(&model, "nesting-too-deep").is_empty());
    assert!(
        parsed.nodes[0]
            .html
            .ends_with(&"</strong>".repeat(MAX_NESTING))
    );
    let (parsed, model) = render(strong(MAX_NESTING + 1));
    assert_eq!(find(&model, "nesting-too-deep").len(), 1);
    // 越えた強調は中身ごと外れる
    assert!(!parsed.nodes[0].html.contains('a'));
    let (_, model) = render(strong(20_000));
    assert_eq!(find(&model, "nesting-too-deep").len(), 1);
}

#[test]
fn limits_without_source_the_model_has_no_body_diagnostic() {
    let source = nested_list(MAX_NESTING + 1);
    let model = with_big_stack(move || {
        let parsed = parse_document(&source);
        build_model(
            &parsed.nodes,
            &parsed.frontmatter,
            None,
            &ModelOptions::default(),
        )
    });
    assert!(find(&model, "nesting-too-deep").is_empty());
}

fn yaml_block(depth: usize) -> String {
    let keys: Vec<String> = (0..depth)
        .map(|index| format!("{}k{index}:", "  ".repeat(index + 1)))
        .collect();
    format!("---\nmarkdag: {{}}\nx:\n{} 1\n---\n# a\n", keys.join("\n"))
}

fn yaml_flow(depth: usize) -> String {
    format!(
        "---\nmarkdag: {{}}\nx: {}{}\n---\n# a\n",
        "[".repeat(depth),
        "]".repeat(depth)
    )
}

fn yaml_depth(value: &JsValue) -> usize {
    match value {
        JsValue::Array(items) => 1 + items.iter().map(yaml_depth).max().unwrap_or(0),
        JsValue::Object(entries) => 1 + entries.values().map(yaml_depth).max().unwrap_or(0),
        _ => 0,
    }
}

#[test]
fn limits_yaml_at_limit_is_read() {
    // 最上位の写像と x の下の入れ子を合わせて上限ちょうど
    for source in [
        yaml_block(MAX_YAML_NESTING - 1),
        yaml_flow(MAX_YAML_NESTING - 1),
    ] {
        let (parsed, model) = render(source.clone());
        assert!(parsed.extracted, "{source:.40}");
        assert_eq!(yaml_depth(&parsed.frontmatter), MAX_YAML_NESTING);
        assert!(find(&model, "yaml-syntax").is_empty());
    }
}

#[test]
fn limits_yaml_over_limit_is_unreadable_with_a_positioned_error() {
    for (source, line) in [
        (yaml_block(MAX_YAML_NESTING), MAX_YAML_NESTING as u32 + 3),
        (yaml_flow(MAX_YAML_NESTING), 3),
    ] {
        let (parsed, model) = render(source.clone());
        // 読めない frontmatter は丸ごと捨てられる (markmap と同じ)
        assert!(!parsed.extracted);
        let found = find(&model, "yaml-syntax");
        assert_eq!(found.len(), 1, "{source:.40}");
        assert_eq!(
            found[0].message,
            "frontmatter を YAML として読めません: 入れ子が深すぎます (上限 100 段)"
        );
        assert_eq!(found[0].at.as_ref().map(|at| at.line), Some(line));
    }
}

// a は錨つきの 49 段の入れ子、b は depth 段の入れ子の底で a を別名で展開する。最上位の写像を合わせた深さは 1 + depth + 49
fn yaml_alias(depth: usize) -> String {
    format!(
        "---\nmarkdag: {{}}\na: &a {}1{}\nb: {}*a{}\n---\n# a\n",
        "[".repeat(49),
        "]".repeat(49),
        "[".repeat(depth),
        "]".repeat(depth)
    )
}

#[test]
fn limits_yaml_alias_expansion_counts_toward_the_limit() {
    // 展開した値の深さが上限ちょうどなら読める
    let (parsed, model) = render(yaml_alias(50));
    assert!(parsed.extracted);
    assert_eq!(yaml_depth(&parsed.frontmatter), MAX_YAML_NESTING);
    assert!(find(&model, "yaml-syntax").is_empty());
    // 1 段越えると、構文の入れ子は浅くても読めない frontmatter にし、別名の行を指す
    let (parsed, model) = render(yaml_alias(51));
    assert!(!parsed.extracted);
    let found = find(&model, "yaml-syntax");
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].message,
        "frontmatter を YAML として読めません: 入れ子が深すぎます (上限 100 段)"
    );
    assert_eq!(found[0].at.as_ref().map(|at| at.line), Some(4));
    // 98 段の入れ子を別名で 6 回つなぐ (修正前は深さ 589 の frontmatter が読めた)
    let mut lines = vec![format!("a0: &a0 {}1{}", "[".repeat(98), "]".repeat(98))];
    for index in 1..6 {
        lines.push(format!(
            "a{index}: &a{index} {}*a{}{}",
            "[".repeat(98),
            index - 1,
            "]".repeat(98)
        ));
    }
    let (parsed, model) = render(format!(
        "---\nmarkdag: {{}}\n{}\n---\n# a\n",
        lines.join("\n")
    ));
    assert!(!parsed.extracted);
    assert_eq!(find(&model, "yaml-syntax").len(), 1);
}

#[test]
fn limits_yaml_flow_beyond_the_parser_limit_has_the_same_message() {
    // saphyr はフローの入れ子を 256 段目で止める。上限を越えた入れ子と同じ文面と位置 (行) にする
    for depth in [255, 256, 1000, 100_000] {
        let (parsed, model) = render(yaml_flow(depth));
        assert!(!parsed.extracted);
        let found = find(&model, "yaml-syntax");
        assert_eq!(found.len(), 1, "{depth}");
        assert_eq!(
            found[0].message,
            "frontmatter を YAML として読めません: 入れ子が深すぎます (上限 100 段)",
            "{depth}"
        );
        assert_eq!(found[0].at.as_ref().map(|at| at.line), Some(3), "{depth}");
    }
}

fn chain(length: u32, width: f64) -> LayoutInput {
    LayoutInput {
        name: "chain".to_string(),
        nodes: (1..=length)
            .map(|id| LayoutInputNode {
                id,
                label: format!("n{id}"),
                width,
                height: 20.0,
                groups: Vec::new(),
            })
            .collect(),
        tree_edges: (1..length)
            .map(|id| LayoutInputEdge {
                source: id,
                target: id + 1,
            })
            .collect(),
        relations: Vec::new(),
        suppress_root_line: Vec::new(),
        folded: Vec::new(),
    }
}

fn layout(input: LayoutInput, options: Option<LayoutOptions>) -> Result<usize, LayoutError> {
    with_big_stack(move || {
        layout_document(&input, &[], &IndexMap::new(), options, None)
            .map(|result| result.rects.len())
    })
}

// wasm の既定と同じ 1 MiB のスタックのスレッドで配置する (配置の層は深さで再帰しないので、深い木でも溢れない)
fn layout_on_small_stack(input: LayoutInput) -> Result<usize, LayoutError> {
    std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || {
            layout_document(&input, &[], &IndexMap::new(), None, None)
                .map(|result| result.rects.len())
        })
        .expect("スレッドを作れる")
        .join()
        .expect("スタックが足りる")
}

#[test]
fn limits_layout_tree_depth_has_no_limit() {
    // 旧実装は 1500 段まで配置でき 3000 段で RangeError。修正前の Rust は 1001 段から誤り (上限 1000)。
    // flextree を明示のスタックにしたので、どの深さも配置できる
    for length in [1001u32, 3000, 20_000] {
        assert_eq!(
            layout_on_small_stack(chain(length, 40.0)),
            Ok(length as usize)
        );
    }
}

#[test]
fn limits_layout_deep_tree_from_relation_adoption() {
    // 平らなリスト (ルートの子が 1500 個) でも、chain の relations が配置上の親を付け替えるので配置の木は深くなる。
    // 旧実装が描けた深さなので、Rust も誤りにせずに配置する
    let count = 1500u32;
    let mut input = chain(2, 40.0);
    input.nodes = (1..=count)
        .map(|id| LayoutInputNode {
            id,
            label: format!("n{id}"),
            width: 40.0,
            height: 20.0,
            groups: Vec::new(),
        })
        .collect();
    input.tree_edges = (2..=count)
        .map(|id| LayoutInputEdge {
            source: 1,
            target: id,
        })
        .collect();
    input.relations = (2..count)
        .map(|id| LayoutInputRelation {
            source: id,
            target: id + 1,
            kind: RelationKind::Chain,
            origin: "chain".to_string(),
        })
        .collect();
    // model は relations の終点のうちルートの子をルートからの線を抑える印にする (付け替えの候補になる)
    input.suppress_root_line = (3..=count).collect();
    assert_eq!(layout_on_small_stack(input), Ok(count as usize));
}

#[test]
fn limits_layout_rejects_non_finite_and_huge_sizes() {
    // 1 ─ 2 ─ {3, 4} (layout-review の mini.ts)。幅 1e307 は旧実装も終わるので通し、9e307 と 1e308 は止まらなかったので弾く
    let mini = |width: f64| {
        let mut input = chain(2, width);
        for id in [3, 4] {
            input.nodes.push(LayoutInputNode {
                id,
                label: format!("n{id}"),
                width: 40.0,
                height: 20.0,
                groups: Vec::new(),
            });
            input.tree_edges.push(LayoutInputEdge {
                source: 2,
                target: id,
            });
        }
        input
    };
    assert!(layout(mini(1e299), None).is_ok());
    for (width, shown) in [
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
        (f64::NEG_INFINITY, "-Infinity"),
        (9e307, "9e+307"),
        (1e300, "1e+300"),
        (-1e300, "-1e+300"),
    ] {
        let error = layout(mini(width), None).unwrap_err();
        assert_eq!(
            error.message,
            format!(
                "配置の入力の ノード 1 の width が {shown} です。絶対値が 1e300 未満の有限の数にします"
            )
        );
        assert_eq!(project(&mini(width)).unwrap_err(), error);
    }
    let mut tall = mini(40.0);
    tall.nodes[2].height = f64::NAN;
    assert_eq!(
        layout(tall, None).unwrap_err().message,
        "配置の入力の ノード 3 の height が NaN です。絶対値が 1e300 未満の有限の数にします"
    );
}

#[test]
fn limits_layout_rejects_bad_options() {
    let cases: Vec<(LayoutOptions, &str)> = vec![
        (
            LayoutOptions {
                padding_x: f64::NAN,
                ..MARKMAP_DEFAULTS
            },
            "paddingX",
        ),
        (
            LayoutOptions {
                spacing_horizontal: 1e308,
                ..MARKMAP_DEFAULTS
            },
            "spacingHorizontal",
        ),
        (
            LayoutOptions {
                spacing_vertical: f64::INFINITY,
                ..MARKMAP_DEFAULTS
            },
            "spacingVertical",
        ),
    ];
    for (options, name) in cases {
        let error = layout(chain(3, 40.0), Some(options)).unwrap_err();
        assert!(
            error
                .message
                .starts_with(&format!("配置の入力の {name} が")),
            "{}",
            error.message
        );
    }
    let mut line = MARKMAP_DEFAULTS;
    line.line_width.scale = f64::NAN;
    assert!(
        layout(chain(3, 40.0), Some(line))
            .unwrap_err()
            .message
            .contains("lineWidth.scale")
    );
}

#[test]
fn limits_html_heading_block_is_an_info_diagnostic() {
    let (parsed, model) = render("# R\n\n<h2>raw heading</h2>\n\n- a\n".to_string());
    // 図は変わらない (HTML のブロックはノードにならない)
    assert_eq!(parsed.nodes.len(), 2);
    let found = find(&model, "html-heading-ignored");
    assert_eq!(found.len(), 1);
    // zu は warning のある文書を保存しないので info (依頼者に確かめる)
    assert_eq!(found[0].severity, Severity::Info);
    assert_eq!(
        found[0].message,
        "この HTML の見出しは図に出ません。## 見出し で書きます"
    );
    assert_eq!(
        found[0].at,
        Some(SourcePosition {
            line: 3,
            column: 1,
            length: 4
        })
    );
}
