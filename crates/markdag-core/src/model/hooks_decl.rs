// 原文: src/model/hooks.ts (2026-09-24)
// フックの宣言の読み取り。文書 (frontmatter の markdag.hooks) が名前で宣言したフックと、呼び出し側が渡した
// モジュールの形 (HookSpec: export の名前と関数か否か) を突き合わせ、拾う export の名前と診断の元 (issue) を返す。
// markdag.rules は組み込みの規則の設定の値だけを読む。フックの関数と実行 (HookRunner、フックに渡す文書の窓、
// 上流の未完了の集め方) は JS に残し、ここには持ち込まない (規則 2.6、決定 6、設計文書 (c))。
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::model::util::{JsValue, closest, is_record};
use crate::types::{
    DeclaredHook, HookSpec, HookSpecEntry, PathStep, RulesConfig, Severity, SourcePath,
};

// 規則 2.6: `as const` の配列は `pub const X: &[&str]` (順は原文のまま)

/// 事前に呼ぶフック。false を返すと、その操作を取りやめる (原文: BEFORE_HOOKS)
pub const BEFORE_HOOKS: &[&str] = &[
    "beforeUpdate",
    "beforeTaskToggle",
    "beforeFold",
    "beforeSelectEdge",
    "beforeSelectGroup",
    "beforeDetailsShow",
];

/// 事後に呼ぶフック。戻り値は見ない (原文: ON_HOOKS)
pub const ON_HOOKS: &[&str] = &[
    "onDocument",
    "onNodeClick",
    "onTaskToggle",
    "onFoldChange",
    "onSelectEdge",
    "onSelectGroup",
    "onDetailsShow",
    "onDetailsHide",
    "onTransform",
    "onLayout",
    "onDestroy",
];

/// 値を返すフック。図に反映するものをデータで返す (原文: VALUE_HOOKS)
pub const VALUE_HOOKS: &[&str] = &["transformSource", "decorateNode"];

/// フックのファイルが export してよい名前。BEFORE → ON → VALUE の順 (原文: HOOK_EVENTS)
pub const HOOK_EVENTS: &[&str] = &[
    "beforeUpdate",
    "beforeTaskToggle",
    "beforeFold",
    "beforeSelectEdge",
    "beforeSelectGroup",
    "beforeDetailsShow",
    "onDocument",
    "onNodeClick",
    "onTaskToggle",
    "onFoldChange",
    "onSelectEdge",
    "onSelectGroup",
    "onDetailsShow",
    "onDetailsHide",
    "onTransform",
    "onLayout",
    "onDestroy",
    "transformSource",
    "decorateNode",
];

/// フックの宣言の突き合わせで見つかった問題 (原文の HookIssue)。呼び出し側が Diagnostic に直す
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookIssue {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    /// frontmatter の中の場所 (呼び出し側が位置に直す)
    pub path: Option<SourcePath>,
}

/// resolveHooks の戻り値 (名前のない戻り値の型。規則 4 章の「関数名 + Result」)。
/// hooks は宣言の順、options は markdag.hooks.options (常に Object)
// 規則 4 章 (A-037): 共有の型の一覧にないので写し先のモジュールに置く
#[derive(Debug, Clone, PartialEq)]
pub struct ResolveHooksResult {
    pub hooks: Vec<DeclaredHook>,
    pub options: JsValue,
    pub issues: Vec<HookIssue>,
}

// 規則 2.4: 内部の固定の正規表現は regex。`$` は m フラグなしで末尾だけ
static TYPESCRIPT_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.[cm]?tsx?$").expect("固定の正規表現"));

// 何度も出る同じ式を private の関数 1 つにまとめる (規則 2.6、A-072)
fn field<'a>(record: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match record {
        JsValue::Object(map) => map.get(key),
        _ => None,
    }
}

/// 原文: resolveHooks。frontmatter の markdag.hooks と、呼び出し側が渡したモジュールの形を突き合わせる。
/// 形と型の誤りはスキーマがすでに警告にしているので、ここでは読めるものだけを拾う。
/// provided が None なのは hookRefs を渡していないアプリ (info)、Some は渡している (見つからなければ warning)
// 台帳 23 行: provided 全体の undefined は None、ref ごとの「値が undefined / キーなし」は get の None、record でない値は Invalid
pub fn resolve_hooks(raw: &JsValue, provided: Option<&HookSpec>) -> ResolveHooksResult {
    let mut issues: Vec<HookIssue> = Vec::new();
    let options = match field(raw, "options") {
        Some(value) if is_record(value) => value.clone(),
        _ => JsValue::Object(Default::default()),
    };
    let declared_ref = field(raw, "$ref");
    let single = matches!(declared_ref, Some(JsValue::String(_)));
    // (配列での元の添字, ref)。文字列でない項目は飛ばすが、診断の道すじには元の添字を使う
    // (旧実装は飛ばしたあとの添字を使い、`$ref: [1, './a.js']` で './a.js' の診断が `$ref[0]` を指した。docs/ignore/bugs/TODO.md の d)
    let refs: Vec<(usize, String)> = match declared_ref {
        Some(JsValue::String(text)) => vec![(0, text.clone())],
        Some(JsValue::Array(items)) => items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| match item {
                JsValue::String(text) => Some((index, text.clone())),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut hooks: Vec<DeclaredHook> = Vec::new();
    for (index, ref_text) in &refs {
        let index = *index;
        let mut path: SourcePath = vec![
            PathStep::Key("markdag".to_string()),
            PathStep::Key("hooks".to_string()),
            PathStep::Key("$ref".to_string()),
        ];
        if !single {
            path.push(PathStep::Index(index));
        }
        // 規則 2.1: 自分の持つキーだけを見る。Object.prototype の名前 (`toString`、`__proto__` など) の引きは写さない (差は accepted.md)
        let loaded = provided.and_then(|spec| spec.get(ref_text));
        let exports = match loaded {
            Some(HookSpecEntry::Module { exports }) => exports,
            _ => {
                // TypeScript のフックは markdag では変換しないので、読み込む側に変換器が要ることを添える
                let typescript = if TYPESCRIPT_REF.is_match(ref_text) {
                    "。.ts は markdag では変換しないので、読み込む側で JavaScript にしてから渡します (変換器がなければ .js で書きます)"
                } else {
                    ""
                };
                // hookRefs を渡していないアプリはフックを読み込まない方針なので、文書の誤りではなく知らせるだけにする。
                // 渡しているのに見つからない、または読めなかったものは、書き手が直せる問題として警告にする
                let hint = match (provided, loaded) {
                    (None, _) => format!(
                        "このアプリはフックを読み込みません (markdag.rules ならコードなしで効きます){typescript}"
                    ),
                    (Some(_), None) => {
                        format!(
                            "呼び出し側が import して render の hookRefs に渡します (信頼できる文書のときだけ){typescript}"
                        )
                    }
                    (Some(_), Some(_)) => format!(
                        "モジュールとして読めるか (名前付きの export があるか) 確かめます{typescript}"
                    ),
                };
                issues.push(HookIssue {
                    severity: if provided.is_none() { Severity::Info } else { Severity::Warning },
                    code: "hooks-unresolved".to_string(),
                    message: format!("markdag.hooks.$ref「{ref_text}」は読み込まれていないので、このフックは動きません"),
                    hint: Some(hint),
                    path: Some(path),
                });
                continue;
            }
        };
        let picked = pick_hooks(ref_text, exports, &mut issues, &path);
        hooks.push(DeclaredHook {
            ref_text: ref_text.clone(),
            exports: picked,
        });
    }
    ResolveHooksResult {
        hooks,
        options,
        issues,
    }
}

/// 原文: pickHooks。モジュールの export から、予約された名前の関数だけを取り出す。
/// exports は Object.entries の順の `[名前, 関数か]` で、返すのは拾った名前 (JS の包みが関数を付け直す)。
/// 書き間違いを黙って落とすと「フックが動かない」だけが残るので、拾えなかった関数は警告にする
// 台帳 22 行: 関数は渡さず、名前と関数か否かだけを受ける。exports の順のまま回し、並べ替えない (規則 2.3)
fn pick_hooks(
    ref_text: &str,
    exports: &[(String, bool)],
    issues: &mut Vec<HookIssue>,
    path: &SourcePath,
) -> Vec<String> {
    let mut module: Vec<String> = Vec::new();
    for (name, is_function) in exports {
        if HOOK_EVENTS.contains(&name.as_str()) {
            if *is_function {
                module.push(name.clone());
            } else {
                issues.push(HookIssue {
                    severity: Severity::Warning,
                    code: "hook-invalid-export".to_string(),
                    message: format!(
                        "{ref_text} の「{name}」は関数ではないので、フックとして呼びません"
                    ),
                    hint: Some(format!(
                        "export function {name}(ctx) {{ ... }} の形で書きます"
                    )),
                    path: Some(path.clone()),
                });
            }
            continue;
        }
        if name == "default" {
            issues.push(HookIssue {
                severity: Severity::Warning,
                code: "hook-unknown-export".to_string(),
                message: format!("{ref_text} の default export は拾いません"),
                hint: Some(format!(
                    "フックは名前付きで export します ({} など)",
                    hook_events_head(3)
                )),
                path: Some(path.clone()),
            });
            continue;
        }
        // 関数でない export は、フックが内部で使う定数と区別できないので黙って見送る
        if !*is_function {
            continue;
        }
        let near = closest(name, HOOK_EVENTS);
        issues.push(HookIssue {
            severity: Severity::Warning,
            code: "hook-unknown-export".to_string(),
            message: format!(
                "{ref_text} の「{name}」は予約された名前ではないので、フックとして呼びません"
            ),
            hint: Some(match near {
                None => format!(
                    "予約された名前だけが呼ばれます ({} ほか)",
                    hook_events_head(6)
                ),
                Some(near) => format!("「{near}」の書き間違いなら直します"),
            }),
            path: Some(path.clone()),
        });
    }
    module
}

// 何度も出る同じ式を private の関数 1 つにまとめる (規則 2.6、A-072)
// `HOOK_EVENTS.slice(0, n).join(', ')` の写し
fn hook_events_head(count: usize) -> String {
    HOOK_EVENTS
        .iter()
        .take(count)
        .copied()
        .collect::<Vec<&str>>()
        .join(", ")
}

/// 原文: rulesModule。frontmatter の markdag.rules を、組み込みの規則の設定にする。
/// 返すのは JS の包みが閉包 (beforeTaskToggle / beforeFold) を組み立てる元になる設定の値。
/// 何も有効になっていなければ None (原文の null)
// 台帳 24 行: Rust は設定の値だけを返す。None の条件は原文の null と同じ
pub fn rules_module(raw: &JsValue) -> Option<RulesConfig> {
    if !is_record(raw) {
        return None;
    }
    let task_toggle = field(raw, "taskToggle").filter(|value| is_record(value));
    let fold = field(raw, "fold").filter(|value| is_record(value));
    let require_upstream_done = matches!(
        task_toggle.and_then(|value| field(value, "requireUpstreamDone")),
        Some(JsValue::Bool(true))
    );
    let readonly_groups: Vec<String> =
        match task_toggle.and_then(|value| field(value, "readonlyGroups")) {
            Some(JsValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    JsValue::String(text) => Some(text.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
    let task_toggle_rule = require_upstream_done || !readonly_groups.is_empty();
    let keep_milestones_open = matches!(
        fold.and_then(|value| field(value, "keepMilestonesOpen")),
        Some(JsValue::Bool(true))
    );
    if !task_toggle_rule && !keep_milestones_open {
        return None;
    }
    Some(RulesConfig {
        require_upstream_done,
        readonly_groups,
        keep_milestones_open,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    // 期待値は node で原文 (src/model/hooks.ts) を動かして取った (vite-node、2026-09-24)。
    // 関数の値は HookSpecEntry::Module の exports の `true`、関数でない値は `false` に置き換えた

    fn s(text: &str) -> JsValue {
        JsValue::String(text.to_string())
    }

    fn obj(entries: Vec<(&str, JsValue)>) -> JsValue {
        JsValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    fn arr(items: Vec<JsValue>) -> JsValue {
        JsValue::Array(items)
    }

    fn module(exports: &[(&str, bool)]) -> HookSpecEntry {
        HookSpecEntry::Module {
            exports: exports
                .iter()
                .map(|(name, is_function)| (name.to_string(), *is_function))
                .collect(),
        }
    }

    fn spec(entries: Vec<(&str, HookSpecEntry)>) -> HookSpec {
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect()
    }

    fn ref_path(index: Option<usize>) -> Option<SourcePath> {
        let mut path = vec![
            PathStep::Key("markdag".to_string()),
            PathStep::Key("hooks".to_string()),
            PathStep::Key("$ref".to_string()),
        ];
        if let Some(index) = index {
            path.push(PathStep::Index(index));
        }
        Some(path)
    }

    fn issue(
        severity: Severity,
        code: &str,
        message: &str,
        hint: &str,
        path: Option<SourcePath>,
    ) -> HookIssue {
        HookIssue {
            severity,
            code: code.to_string(),
            message: message.to_string(),
            hint: Some(hint.to_string()),
            path,
        }
    }

    fn declared(ref_text: &str, exports: &[&str]) -> DeclaredHook {
        DeclaredHook {
            ref_text: ref_text.to_string(),
            exports: exports.iter().map(|name| name.to_string()).collect(),
        }
    }

    fn empty_object() -> JsValue {
        JsValue::Object(IndexMap::new())
    }

    const TS_NOTE: &str = "。.ts は markdag では変換しないので、読み込む側で JavaScript にしてから渡します (変換器がなければ .js で書きます)";
    const HINT_NOT_LOADING: &str =
        "このアプリはフックを読み込みません (markdag.rules ならコードなしで効きます)";
    const HINT_MISSING: &str =
        "呼び出し側が import して render の hookRefs に渡します (信頼できる文書のときだけ)";
    const HINT_INVALID: &str = "モジュールとして読めるか (名前付きの export があるか) 確かめます";

    fn unresolved_message(ref_text: &str) -> String {
        format!("markdag.hooks.$ref「{ref_text}」は読み込まれていないので、このフックは動きません")
    }

    #[test]
    fn hooks_decl_regex_compiles() {
        LazyLock::force(&TYPESCRIPT_REF);
    }

    #[test]
    fn hooks_decl_events_order_matches_node() {
        let expected = [
            "beforeUpdate",
            "beforeTaskToggle",
            "beforeFold",
            "beforeSelectEdge",
            "beforeSelectGroup",
            "beforeDetailsShow",
            "onDocument",
            "onNodeClick",
            "onTaskToggle",
            "onFoldChange",
            "onSelectEdge",
            "onSelectGroup",
            "onDetailsShow",
            "onDetailsHide",
            "onTransform",
            "onLayout",
            "onDestroy",
            "transformSource",
            "decorateNode",
        ];
        assert_eq!(HOOK_EVENTS, expected);
        let joined: Vec<&str> = BEFORE_HOOKS
            .iter()
            .chain(ON_HOOKS)
            .chain(VALUE_HOOKS)
            .copied()
            .collect();
        assert_eq!(HOOK_EVENTS, joined.as_slice());
    }

    // test/hooks.test.ts「hookRefs を渡さないアプリでは、フックは動かないと info で知らせる」(node の c1)
    #[test]
    fn hooks_decl_not_provided_is_info() {
        let result = resolve_hooks(&obj(vec![("$ref", s("./flow.hooks.js"))]), None);
        assert_eq!(result.hooks, vec![]);
        assert_eq!(result.options, empty_object());
        assert_eq!(
            result.issues,
            vec![issue(
                Severity::Info,
                "hooks-unresolved",
                &unresolved_message("./flow.hooks.js"),
                HINT_NOT_LOADING,
                ref_path(None)
            )]
        );
    }

    // test/hooks.test.ts「hookRefs を渡しているのに見つからないモジュールは警告にする」(node の c2。null は Invalid)
    #[test]
    fn hooks_decl_missing_and_invalid_are_warnings() {
        let provided = spec(vec![("./b.hooks.js", HookSpecEntry::Invalid)]);
        let result = resolve_hooks(
            &obj(vec![(
                "$ref",
                arr(vec![s("./a.hooks.js"), s("./b.hooks.js")]),
            )]),
            Some(&provided),
        );
        assert_eq!(result.hooks, vec![]);
        assert_eq!(
            result.issues,
            vec![
                issue(
                    Severity::Warning,
                    "hooks-unresolved",
                    &unresolved_message("./a.hooks.js"),
                    HINT_MISSING,
                    ref_path(Some(0))
                ),
                issue(
                    Severity::Warning,
                    "hooks-unresolved",
                    &unresolved_message("./b.hooks.js"),
                    HINT_INVALID,
                    ref_path(Some(1))
                ),
            ]
        );
    }

    // test/hooks.test.ts「.ts の $ref が未解決なら、読み込む側で変換する必要があることを添える」(node の c3)
    #[test]
    fn hooks_decl_typescript_note_when_not_provided() {
        let result = resolve_hooks(&obj(vec![("$ref", s("./flow.hooks.ts"))]), None);
        assert_eq!(
            result.issues,
            vec![issue(
                Severity::Info,
                "hooks-unresolved",
                &unresolved_message("./flow.hooks.ts"),
                &format!("{HINT_NOT_LOADING}{TS_NOTE}"),
                ref_path(None)
            )]
        );
    }

    // node の c3b: 拡張子の判定 (/\.[cm]?tsx?$/。大文字と途中の .ts は当たらない)
    #[test]
    fn hooks_decl_typescript_suffixes_match_node() {
        let refs = [
            "x.mts", "y.cts", "z.tsx", "w.ctsx", "v.ts.js", "u.TS", "q.xts",
        ];
        let noted = [true, true, true, true, false, false, false];
        let provided = HookSpec::new();
        let result = resolve_hooks(
            &obj(vec![(
                "$ref",
                arr(refs.iter().map(|text| s(text)).collect()),
            )]),
            Some(&provided),
        );
        let expected: Vec<HookIssue> = refs
            .iter()
            .zip(noted)
            .enumerate()
            .map(|(index, (ref_text, note))| {
                let hint = if note {
                    format!("{HINT_MISSING}{TS_NOTE}")
                } else {
                    HINT_MISSING.to_string()
                };
                issue(
                    Severity::Warning,
                    "hooks-unresolved",
                    &unresolved_message(ref_text),
                    &hint,
                    ref_path(Some(index)),
                )
            })
            .collect();
        assert_eq!(result.issues, expected);
    }

    // node の c3c: record でない値 (5) の hint にも .ts の添え書き
    #[test]
    fn hooks_decl_typescript_note_on_invalid() {
        let provided = spec(vec![("a.ts", HookSpecEntry::Invalid)]);
        let result = resolve_hooks(&obj(vec![("$ref", s("a.ts"))]), Some(&provided));
        assert_eq!(
            result.issues,
            vec![issue(
                Severity::Warning,
                "hooks-unresolved",
                &unresolved_message("a.ts"),
                &format!("{HINT_INVALID}{TS_NOTE}"),
                ref_path(None)
            )]
        );
    }

    // test/hooks.test.ts「一覧で書いた $ref は、書かれた順に並び、位置は添字で指す」(node の c4)
    #[test]
    fn hooks_decl_list_keeps_order_and_index() {
        let provided = spec(vec![("./a.hooks.js", module(&[("onDocument", true)]))]);
        let result = resolve_hooks(
            &obj(vec![(
                "$ref",
                arr(vec![s("./a.hooks.js"), s("./b.hooks.js")]),
            )]),
            Some(&provided),
        );
        assert_eq!(
            result.hooks,
            vec![declared("./a.hooks.js", &["onDocument"])]
        );
        assert_eq!(
            result.issues,
            vec![issue(
                Severity::Warning,
                "hooks-unresolved",
                &unresolved_message("./b.hooks.js"),
                HINT_MISSING,
                ref_path(Some(1))
            )]
        );
    }

    // test/hooks.test.ts「予約された名前の関数だけを拾い、拾えなかった export は警告にする」(node の c5)
    #[test]
    fn hooks_decl_pick_reports_unknown_and_invalid() {
        let provided = spec(vec![(
            "./flow.hooks.js",
            module(&[
                ("beforeTaskToggle", true),
                ("beforeTaskTogle", true),
                ("onDocument", false),
                ("LIMIT", false),
                ("default", true),
            ]),
        )]);
        let raw = obj(vec![
            ("$ref", s("./flow.hooks.js")),
            ("options", obj(vec![("strict", JsValue::Bool(true))])),
        ]);
        let result = resolve_hooks(&raw, Some(&provided));
        assert_eq!(
            result.hooks,
            vec![declared("./flow.hooks.js", &["beforeTaskToggle"])]
        );
        assert_eq!(result.options, obj(vec![("strict", JsValue::Bool(true))]));
        assert_eq!(
            result.issues,
            vec![
                issue(
                    Severity::Warning,
                    "hook-unknown-export",
                    "./flow.hooks.js の「beforeTaskTogle」は予約された名前ではないので、フックとして呼びません",
                    "「beforeTaskToggle」の書き間違いなら直します",
                    ref_path(None)
                ),
                issue(
                    Severity::Warning,
                    "hook-invalid-export",
                    "./flow.hooks.js の「onDocument」は関数ではないので、フックとして呼びません",
                    "export function onDocument(ctx) { ... } の形で書きます",
                    ref_path(None)
                ),
                issue(
                    Severity::Warning,
                    "hook-unknown-export",
                    "./flow.hooks.js の default export は拾いません",
                    "フックは名前付きで export します (beforeUpdate, beforeTaskToggle, beforeFold など)",
                    ref_path(None)
                ),
            ]
        );
    }

    // node の c10: default は関数でなくても警告、近い候補のない関数は slice(0, 6) の hint、options が record でなければ {}
    #[test]
    fn hooks_decl_pick_all_branches_match_node() {
        let provided = spec(vec![(
            "./m.js",
            module(&[
                ("default", false),
                ("zzzzzzzz", true),
                ("decorateNode", true),
                ("onLayot", true),
                ("transformSource", false),
            ]),
        )]);
        let raw = obj(vec![("$ref", s("./m.js")), ("options", s("no"))]);
        let result = resolve_hooks(&raw, Some(&provided));
        assert_eq!(result.hooks, vec![declared("./m.js", &["decorateNode"])]);
        assert_eq!(result.options, empty_object());
        assert_eq!(
            result.issues,
            vec![
                issue(
                    Severity::Warning,
                    "hook-unknown-export",
                    "./m.js の default export は拾いません",
                    "フックは名前付きで export します (beforeUpdate, beforeTaskToggle, beforeFold など)",
                    ref_path(None)
                ),
                issue(
                    Severity::Warning,
                    "hook-unknown-export",
                    "./m.js の「zzzzzzzz」は予約された名前ではないので、フックとして呼びません",
                    "予約された名前だけが呼ばれます (beforeUpdate, beforeTaskToggle, beforeFold, beforeSelectEdge, beforeSelectGroup, beforeDetailsShow ほか)",
                    ref_path(None)
                ),
                issue(
                    Severity::Warning,
                    "hook-unknown-export",
                    "./m.js の「onLayot」は予約された名前ではないので、フックとして呼びません",
                    "「onLayout」の書き間違いなら直します",
                    ref_path(None)
                ),
                issue(
                    Severity::Warning,
                    "hook-invalid-export",
                    "./m.js の「transformSource」は関数ではないので、フックとして呼びません",
                    "export function transformSource(ctx) { ... } の形で書きます",
                    ref_path(None)
                ),
            ]
        );
    }

    #[test]
    fn hooks_decl_module_issues_point_at_original_index() {
        // 読めたモジュールの export の診断も、配列での元の添字を指す (TODO の d)
        let provided = spec(vec![("./m.js", module(&[("onLayot", true)]))]);
        let raw = obj(vec![(
            "$ref",
            arr(vec![JsValue::Bool(true), JsValue::Null, s("./m.js")]),
        )]);
        let result = resolve_hooks(&raw, Some(&provided));
        assert_eq!(result.hooks, vec![declared("./m.js", &[])]);
        assert_eq!(
            result
                .issues
                .iter()
                .map(|issue| issue.path.clone())
                .collect::<Vec<_>>(),
            vec![ref_path(Some(2))]
        );
    }

    // node の c6: 文字列でない項目は飛ばし、道すじは配列での元の添字 (旧実装は飛ばしたあとの添字 0 と 1。TODO の d)
    #[test]
    fn hooks_decl_index_is_original_array_index() {
        let provided = HookSpec::new();
        let raw = obj(vec![(
            "$ref",
            arr(vec![
                JsValue::Number(1.0),
                s("./a.js"),
                JsValue::Null,
                s("./b.js"),
            ]),
        )]);
        let result = resolve_hooks(&raw, Some(&provided));
        assert_eq!(
            result.issues,
            vec![
                issue(
                    Severity::Warning,
                    "hooks-unresolved",
                    &unresolved_message("./a.js"),
                    HINT_MISSING,
                    ref_path(Some(1))
                ),
                issue(
                    Severity::Warning,
                    "hooks-unresolved",
                    &unresolved_message("./b.js"),
                    HINT_MISSING,
                    ref_path(Some(3))
                ),
            ]
        );
    }

    // node の c7、c8、c9、c14: 読めない宣言は何も拾わず、診断もない
    #[test]
    fn hooks_decl_unreadable_declarations_are_empty() {
        let provided = HookSpec::new();
        let cases: Vec<(JsValue, Option<&HookSpec>)> = vec![
            (JsValue::Null, None),
            (
                obj(vec![
                    ("$ref", JsValue::Number(3.0)),
                    ("options", arr(vec![JsValue::Number(1.0)])),
                ]),
                None,
            ),
            (s("x"), Some(&provided)),
            (obj(vec![("$ref", arr(vec![]))]), None),
            (JsValue::Undefined, None),
        ];
        for (raw, provided) in cases {
            let result = resolve_hooks(&raw, provided);
            assert_eq!(
                result,
                ResolveHooksResult {
                    hooks: vec![],
                    options: empty_object(),
                    issues: vec![]
                },
                "{raw:?}"
            );
        }
    }

    // node の c11 (値が undefined は包みがキーを作らない = キーなし) と c12 (配列は record でない = Invalid)
    #[test]
    fn hooks_decl_undefined_value_is_missing_and_array_is_invalid() {
        let empty = HookSpec::new();
        let missing = resolve_hooks(&obj(vec![("$ref", s("./m.js"))]), Some(&empty));
        assert_eq!(
            missing.issues,
            vec![issue(
                Severity::Warning,
                "hooks-unresolved",
                &unresolved_message("./m.js"),
                HINT_MISSING,
                ref_path(None)
            )]
        );
        let invalid = spec(vec![("./m.js", HookSpecEntry::Invalid)]);
        let result = resolve_hooks(&obj(vec![("$ref", s("./m.js"))]), Some(&invalid));
        assert_eq!(
            result.issues,
            vec![issue(
                Severity::Warning,
                "hooks-unresolved",
                &unresolved_message("./m.js"),
                HINT_INVALID,
                ref_path(None)
            )]
        );
    }

    // node の c13 (同じ ref を 2 度書けば 2 度拾う) と c15 (export のないモジュールは空の exports で拾う)
    #[test]
    fn hooks_decl_duplicate_refs_and_empty_module() {
        let provided = spec(vec![("./m.js", module(&[("onDocument", true)]))]);
        let result = resolve_hooks(
            &obj(vec![("$ref", arr(vec![s("./m.js"), s("./m.js")]))]),
            Some(&provided),
        );
        assert_eq!(
            result.hooks,
            vec![
                declared("./m.js", &["onDocument"]),
                declared("./m.js", &["onDocument"])
            ]
        );
        assert_eq!(result.issues, vec![]);
        let empty_module = spec(vec![("./m.js", module(&[]))]);
        let result = resolve_hooks(&obj(vec![("$ref", s("./m.js"))]), Some(&empty_module));
        assert_eq!(result.hooks, vec![declared("./m.js", &[])]);
        assert_eq!(result.issues, vec![]);
    }

    #[test]
    fn hooks_decl_pick_hooks_keeps_export_order() {
        let mut issues = Vec::new();
        let exports: Vec<(String, bool)> = [
            ("onLayout", true),
            ("beforeUpdate", true),
            ("decorateNode", true),
        ]
        .iter()
        .map(|(n, f)| (n.to_string(), *f))
        .collect();
        let picked = pick_hooks("./m.js", &exports, &mut issues, &vec![]);
        assert_eq!(picked, vec!["onLayout", "beforeUpdate", "decorateNode"]);
        assert_eq!(issues, vec![]);
    }

    fn rules(
        require_upstream_done: bool,
        readonly_groups: &[&str],
        keep_milestones_open: bool,
    ) -> Option<RulesConfig> {
        Some(RulesConfig {
            require_upstream_done,
            readonly_groups: readonly_groups
                .iter()
                .map(|name| name.to_string())
                .collect(),
            keep_milestones_open,
        })
    }

    // node の r1〜r12 (test/hooks.test.ts「何も有効にしていない rules は、フックを足さない」を含む)
    #[test]
    fn hooks_decl_rules_module_matches_node() {
        let t = JsValue::Bool(true);
        let cases: Vec<(&str, JsValue, Option<RulesConfig>)> = vec![
            (
                "r1",
                obj(vec![(
                    "taskToggle",
                    obj(vec![("requireUpstreamDone", JsValue::Bool(false))]),
                )]),
                None,
            ),
            ("r2", obj(vec![]), None),
            ("r3", JsValue::Null, None),
            (
                "r4",
                obj(vec![(
                    "taskToggle",
                    obj(vec![("requireUpstreamDone", t.clone())]),
                )]),
                rules(true, &[], false),
            ),
            (
                "r5",
                obj(vec![(
                    "taskToggle",
                    obj(vec![(
                        "readonlyGroups",
                        arr(vec![s("fixed"), JsValue::Number(3.0), s("b")]),
                    )]),
                )]),
                rules(false, &["fixed", "b"], false),
            ),
            (
                "r6",
                obj(vec![(
                    "taskToggle",
                    obj(vec![(
                        "readonlyGroups",
                        arr(vec![JsValue::Number(1.0), JsValue::Null]),
                    )]),
                )]),
                None,
            ),
            (
                "r7",
                obj(vec![("fold", obj(vec![("keepMilestonesOpen", t.clone())]))]),
                rules(false, &[], true),
            ),
            (
                "r8",
                obj(vec![
                    ("fold", obj(vec![("keepMilestonesOpen", s("true"))])),
                    (
                        "taskToggle",
                        obj(vec![("requireUpstreamDone", JsValue::Number(1.0))]),
                    ),
                ]),
                None,
            ),
            (
                "r9",
                obj(vec![
                    (
                        "taskToggle",
                        obj(vec![
                            ("requireUpstreamDone", t.clone()),
                            ("readonlyGroups", s("fixed")),
                        ]),
                    ),
                    ("fold", obj(vec![("keepMilestonesOpen", t.clone())])),
                ]),
                rules(true, &[], true),
            ),
            ("r10", arr(vec![JsValue::Number(1.0)]), None),
            (
                "r11",
                obj(vec![
                    ("taskToggle", arr(vec![t.clone()])),
                    ("fold", JsValue::Null),
                ]),
                None,
            ),
            (
                "r12",
                obj(vec![
                    (
                        "taskToggle",
                        obj(vec![("readonlyGroups", arr(vec![s("a")]))]),
                    ),
                    ("fold", obj(vec![("keepMilestonesOpen", t.clone())])),
                ]),
                rules(false, &["a"], true),
            ),
        ];
        for (label, raw, expected) in cases {
            assert_eq!(rules_module(&raw), expected, "{label}");
        }
    }
}

// PORT STATUS: confidence=high todos=0
