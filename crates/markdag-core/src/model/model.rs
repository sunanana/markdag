// 原文: src/model/model.ts (2026-09-24)
// model 層の本体。frontmatter の markdag の下の指定 (relations、groups、tags と types、hooks と rules、tasks、legend、branches など) を、
// ノードの木に対して解決し、診断つきのグラフ (GraphModel) を組み立てる。
// 参照の解決 (Resolver) と式の形の検査 (check_shape) もここに置く。frontmatter の位置の特定、スキーマの検査、
// タグの型の解決、フックの宣言の読み取りは別のモジュールが担い、ここはそれらを呼んで診断を集める。
// 参照の解決の失敗は例外でなく Result<_, SelectorError> で返し、呼び出し側が診断に直す (規則 2.5)。

use std::fmt;
use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::model::hooks_decl::{resolve_hooks, rules_module};
use crate::model::locator::FrontmatterLocator;
use crate::model::schema::schema_diagnostics;
use crate::model::tags::{TagLintOptions, TypeSource, lint_tags, resolve_tag_keys};
use crate::model::util::{JsValue, closest, js_number_to_string, js_trim, unique_in_order};
use crate::parse::task::{DEFAULT_TASK_CYCLE, is_task_mark, task_state_of};
use crate::types::{
    Diagnostic, DimDisplayMode, DisplayMode, GraphModel, GroupDef, HookSpec, LayoutInputRelation,
    LegendItem, LegendPosition, ModelHooks, NodeTag, OutlineNode, PathStep, RelationKind, Severity,
    SourcePath, SourcePosition, TagDisplayMode, TagLintSeverity, TagLintUnknownKey, TaskDimOptions,
    TaskMark,
};

// ノードに添えるもの (詳細、タグ) の見せ方。規則 2.6: 原文の文字列の union の配列は enum の配列 (共有の型の enum の ALL が原文の順)
pub const DISPLAY_MODES: &[DisplayMode] = DisplayMode::ALL;
// タグの見せ方。出さない (never) を選べる点だけが詳細と違う
pub const TAG_DISPLAY_MODES: &[TagDisplayMode] = TagDisplayMode::ALL;
// 薄く表示するタスクのノードでの、詳細とタグの見せ方。keep = 文書の指定のまま
pub const DIM_DISPLAY_MODES: &[DimDisplayMode] = DimDisplayMode::ALL;
// 凡例に出す項目の既定 (この順で出す)
pub const DEFAULT_LEGEND: &[LegendItem] = LegendItem::ALL;
// 凡例を置く隅。先頭が既定
pub const LEGEND_POSITIONS: &[LegendPosition] = LegendPosition::ALL;

/// 原文: ModelOptions。buildModel に呼び出し側が渡すもの
// 規則 4 章: 共有の型の一覧にないので写し先のモジュールに置く。台帳 26 行と規則 2.1 の `x?: T` の行
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptions {
    /// markdag.types.$ref で参照したファイルの中身。$ref に書いた文字列をキーに、YAML を読んだ値 (読めなければ Null)。
    /// キーがないか値が Undefined なら「渡していない」、Null は「読めなかった」(規則 2.3 の types / hookRefs の行)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<IndexMap<String, JsValue>>,
    /// markdag.hooks.$ref で参照したモジュールの形。None は hookRefs そのものを渡していない (設計文書 (b) の HookSpec)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_refs: Option<HookSpec>,
}

// 規則 1 章 (A-021): 定数の正規表現は LazyLock と expect。
// 規則 2.4「.」は [^\n\r\u{2028}\u{2029}] (JS の . は改行に一致しない。台帳の parseSelector の行)
static BRANCH_WITH_EXPAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\([^\n\r\u{2028}\u{2029}]*\)/\*\*?$").expect("固定の正規表現"));
// ASCII だけの固定の文字クラス (規則 2.4)
static REF_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\$[A-Za-z][A-Za-z0-9_-]*$").expect("固定の正規表現"));
// 区間の中の「\/」「\(」「\$」の「\」を落とす (台帳の区間のエスケープ外しの行。生の文字列の中の \ は 1 組だけ)
static SEGMENT_ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\([/($])").expect("固定の正規表現"));
static SPACES_AND_TABS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t]+").expect("固定の正規表現"));
// relations の式の項の区切り (`-->`) と、項の中の区切り (`&`)。前後に空白かタブが要る
static ARROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t]+-->[ \t]+").expect("固定の正規表現"));
static AMPERSAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t]+&[ \t]+").expect("固定の正規表現"));

/// 原文: normalize (model.ts:114)。NFC にし、空白とタブの並びを 1 つの空白にして前後を落とす。
/// 改行はまとめない点が本文の参照の文字 (解析の層の normalize_ref_text) と違う (規則 2.2 の名前が同じで中身が違う normalize の行)
fn normalize_frontmatter_text(text: &str) -> String {
    let nfc: String = text.nfc().collect();
    js_trim(&SPACES_AND_TABS.replace_all(&nfc, " ")).to_string()
}

/// 原文: splitPath。参照の経路を「/」で区切る。直前が「\」の「/」は区切りにしない
fn split_path(ref_text: &str) -> Vec<String> {
    // 規則 2.2「[...s] は chars().collect::<Vec<char>>()」
    let chars: Vec<char> = ref_text.chars().collect();
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    for (index, &char) in chars.iter().enumerate() {
        // chars[index - 1] は先頭で undefined なので、先頭の「/」は区切りになる
        let previous = index.checked_sub(1).and_then(|i| chars.get(i));
        if char == '/' && previous != Some(&'\\') {
            segments.push(std::mem::take(&mut current));
        } else {
            current.push(char);
        }
    }
    segments.push(current);
    segments
}

/// 参照の範囲 (原文: Selector['scope'])。境界にも文面にも出ない局所の union (規則 2.6、A-041)。
/// self は SelfScope (A-030)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectorScope {
    // そのノード自身
    SelfScope,
    // 配下の末端 (`X/*`)
    Leaves,
    // そのノードと配下のすべて (`X/**`)
    All,
    // 枝の枠 (`(X)`)。未対応なので X 自身として扱う
    Branch,
}

/// 原文: Selector
#[derive(Debug, Clone, PartialEq)]
struct Selector {
    ref_text: String,
    scope: SelectorScope,
}

/// relations の式の、`-->` で区切った項 1 つ (原文の名前のない型 `{ selectors: Selector[]; ids: number[] }`)
// 名前のない欄の型は「原文の変数名か欄名 + 意味」で名前を付ける (規則 4 章、A-100)
#[derive(Debug, Clone, PartialEq)]
struct RelationTerm {
    selectors: Vec<Selector>,
    ids: Vec<u32>,
}

/// 前方一致で解決した参照 (原文の名前のない型 `{ ref: string; text: string }`)。text は一致したノードの refText
// 名前のない欄の型は「原文の変数名か欄名 + 意味」で名前を付ける (規則 4 章、A-100)
#[derive(Debug, Clone, PartialEq)]
struct PrefixMatch {
    ref_text: String,
    text: String,
}

/// 原文: SelectorError。参照の解決と式の読み取りの誤り。ref_text は原文の中でこの誤りが指す語、hint は直し方の手がかり
// 規則 2.5 (A-020): ref_text は String (原文の throw はすべて ref を渡す)
#[derive(Debug, Clone, PartialEq)]
struct SelectorError {
    code: String,
    message: String,
    ref_text: String,
    hint: Option<String>,
}

impl SelectorError {
    fn new(code: &str, message: String, ref_text: &str, hint: Option<&str>) -> SelectorError {
        SelectorError {
            code: code.to_string(),
            message,
            ref_text: ref_text.to_string(),
            hint: hint.map(str::to_string),
        }
    }
}

impl fmt::Display for SelectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// 原文: Resolver。ノードの木に対して、relations と groups と branches の参照をノードの id に解決する
struct Resolver<'a> {
    nodes: &'a [OutlineNode],
    // 規則 2.3 と台帳の Resolver.byId / children の行: IndexMap (byId の値は原文と同じくノードそのもの)
    by_id: IndexMap<u32, &'a OutlineNode>,
    children: IndexMap<u32, Vec<u32>>,
    // 前方一致で解決した参照。書き間違いでも名前の一部が一致すれば通ってしまうので、呼び出し側が診断に出す
    prefix_matched: Vec<PrefixMatch>,
}

impl<'a> Resolver<'a> {
    /// 原文: Resolver の constructor
    fn new(nodes: &'a [OutlineNode]) -> Resolver<'a> {
        let mut by_id = IndexMap::new();
        let mut children: IndexMap<u32, Vec<u32>> = IndexMap::new();
        for node in nodes {
            by_id.insert(node.id, node);
            children.insert(node.id, Vec::new());
        }
        for node in nodes {
            // this.children.get(parent)?.push は親が無ければ黙って落とす
            if let Some(parent) = node.parent
                && let Some(list) = children.get_mut(&parent)
            {
                list.push(node.id);
            }
        }
        Resolver {
            nodes,
            by_id,
            children,
            prefix_matched: Vec::new(),
        }
    }

    /// 原文: takePrefixMatches。直前の解決で前方一致になった参照を取り出して、記録を空にする
    fn take_prefix_matches(&mut self) -> Vec<PrefixMatch> {
        std::mem::take(&mut self.prefix_matched)
    }

    /// 原文: childrenOf
    fn children_of(&self, id: u32) -> &[u32] {
        self.children.get(&id).map(Vec::as_slice).unwrap_or(&[])
    }

    /// 原文: descendants。先行順
    fn descendants(&self, id: u32) -> Vec<u32> {
        let mut result = Vec::new();
        for &child in self.children_of(id) {
            result.push(child);
            result.extend(self.descendants(child));
        }
        result
    }

    /// 原文: ancestors。ルート側が先
    fn ancestors(&self, id: u32) -> Vec<&'a OutlineNode> {
        let mut chain = Vec::new();
        let mut parent = self.by_id.get(&id).copied().and_then(|node| node.parent);
        while let Some(current) = parent {
            let node = self.by_id.get(&current).copied();
            if let Some(node) = node {
                chain.push(node);
            }
            parent = node.and_then(|node| node.parent);
        }
        // unshift の写し: 集めてから逆にする (台帳の ancestors の行)
        chain.reverse();
        chain
    }

    /// 原文: parseSelector
    fn parse_selector(&self, raw: &str) -> Result<Selector, SelectorError> {
        let mut text = js_trim(raw);
        // startsWith('(') && endsWith(')') と text.slice(1, -1)。strip の組は長さ 2 以上のときだけ通り、原文と同じ
        if let Some(inner) = text
            .strip_prefix('(')
            .and_then(|rest| rest.strip_suffix(')'))
        {
            return Ok(Selector {
                ref_text: js_trim(inner).to_string(),
                scope: SelectorScope::Branch,
            });
        }
        if BRANCH_WITH_EXPAND.is_match(text) {
            return Err(SelectorError::new(
                "relation-syntax",
                format!("括弧と /* は組み合わせられません: {raw}"),
                js_trim(raw),
                Some("枝の枠でまとめるか配下に展開するかの、どちらかにします"),
            ));
        }
        let mut scope = SelectorScope::SelfScope;
        if let Some(rest) = text.strip_suffix("/**") {
            text = rest;
            scope = SelectorScope::All;
        } else if let Some(rest) = text.strip_suffix("/*") {
            text = rest;
            scope = SelectorScope::Leaves;
        }
        if js_trim(text).is_empty() {
            return Err(SelectorError::new(
                "relation-syntax",
                format!("参照が空です: {raw}"),
                js_trim(raw),
                None,
            ));
        }
        Ok(Selector {
            ref_text: js_trim(text).to_string(),
            scope,
        })
    }

    /// 原文: resolveRef。完全一致を優先し、なければ前方一致。祖先のセグメントは、この順に並ぶ祖先がいるものだけを残す
    fn resolve_ref(&mut self, ref_text: &str) -> Result<u32, SelectorError> {
        let nodes = self.nodes;
        if let Some(ref_id) = ref_text
            .strip_prefix('$')
            .filter(|_| REF_ID.is_match(ref_text))
        {
            // 規則 2.3: filter は collect してから件数を見る
            let found: Vec<&OutlineNode> = nodes
                .iter()
                .filter(|node| node.ref_id.as_deref() == Some(ref_id))
                .collect();
            if let [only] = found.as_slice() {
                return Ok(only.id);
            }
            let candidates: Vec<String> = nodes
                .iter()
                .filter_map(|node| node.ref_id.as_ref().map(|id| format!("${id}")))
                .collect();
            let near = closest(ref_text, &candidates);
            let missing = found.is_empty();
            let hint = if missing {
                match near {
                    None => "本文のノードの行末に $id を書くと、その名前で指せます".to_string(),
                    Some(near) => format!("もしかして「{near}」"),
                }
            } else {
                "同じ $id を 2 つ以上のノードに書かないようにします".to_string()
            };
            return Err(SelectorError::new(
                if missing {
                    "ref-not-found"
                } else {
                    "ref-ambiguous"
                },
                format!(
                    "{ref_text} が{}",
                    if missing {
                        "見つかりません"
                    } else {
                        "複数あります"
                    }
                ),
                ref_text,
                Some(&hint),
            ));
        }
        let segments: Vec<String> = split_path(ref_text)
            .iter()
            .map(|segment| normalize_frontmatter_text(&SEGMENT_ESCAPE.replace_all(segment, "$1")))
            .collect();
        // segments[segments.length - 1] ?? '' と segments.slice(0, -1) (split_path は 1 つ以上を返すので '' には届かない)
        let (last, ancestor_segments): (&str, &[String]) = match segments.split_last() {
            Some((last, rest)) => (last.as_str(), rest),
            None => ("", &[]),
        };
        let matches = |text: &str, segment: &str, exact: bool| -> bool {
            !text.is_empty()
                && if exact {
                    text == segment
                } else {
                    text.starts_with(segment)
                }
        };
        // BUG(port): 祖先の区間が前方一致で通っても prefix_matched に記録しない (記録は最後の区間だけ)。
        // 再現: 木 Root > 実装 > 画面 で `実/画` は ref-prefix を「画面」の 1 件だけ出し、「実」→「実装」は出さない (台帳の hasAncestors の行)
        let has_ancestors = |node: &OutlineNode| -> bool {
            let mut chain = self.ancestors(node.id);
            for segment in ancestor_segments {
                let exact = nodes.iter().any(|candidate| &candidate.ref_text == segment);
                let Some(index) = chain
                    .iter()
                    .position(|ancestor| matches(&ancestor.ref_text, segment, exact))
                else {
                    return false;
                };
                // chain.slice(index + 1)
                chain = chain.into_iter().skip(index + 1).collect();
            }
            true
        };
        for exact in [true, false] {
            let found: Vec<&'a OutlineNode> = nodes
                .iter()
                .filter(|node| matches(&node.ref_text, last, exact) && has_ancestors(node))
                .collect();
            if let [only] = found.as_slice() {
                if !exact {
                    self.prefix_matched.push(PrefixMatch {
                        ref_text: ref_text.to_string(),
                        text: only.ref_text.clone(),
                    });
                }
                return Ok(only.id);
            }
            if found.len() > 1 {
                let names: Vec<&str> = found.iter().map(|node| node.ref_text.as_str()).collect();
                return Err(SelectorError::new(
                    "ref-ambiguous",
                    format!(
                        "「{ref_text}」に一致するノードが {} 個あります ({})",
                        js_number_to_string(found.len() as f64),
                        names.join("、")
                    ),
                    ref_text,
                    Some(
                        "親のノードを付けて「親/子」と書くか、指したいノードの行末に $id を付けると 1 つに絞れます",
                    ),
                ));
            }
        }
        let candidates: Vec<&str> = nodes.iter().map(|node| node.ref_text.as_str()).collect();
        let hint = match closest(last, &candidates) {
            None => {
                "ノードの 1 行目の文字を、先頭から書きます (装飾とタグは除いた文字)".to_string()
            }
            Some(near) => format!("もしかして「{near}」"),
        };
        Err(SelectorError::new(
            "ref-not-found",
            format!("「{ref_text}」に一致するノードがありません"),
            ref_text,
            Some(&hint),
        ))
    }

    /// 原文: expand。参照を解決し、範囲に応じてノードの id の並びに広げる
    fn expand(&mut self, selector: &Selector) -> Result<Vec<u32>, SelectorError> {
        let id = self.resolve_ref(&selector.ref_text)?;
        match selector.scope {
            SelectorScope::SelfScope | SelectorScope::Branch => Ok(vec![id]),
            SelectorScope::All => {
                let mut ids = vec![id];
                ids.extend(self.descendants(id));
                Ok(ids)
            }
            SelectorScope::Leaves => {
                let leaves: Vec<u32> = self
                    .descendants(id)
                    .into_iter()
                    .filter(|&descendant| self.children_of(descendant).is_empty())
                    .collect();
                if leaves.is_empty() {
                    return Err(SelectorError::new(
                        "selector-empty",
                        format!(
                            "「{}/*」は、配下にノードがないので展開できません",
                            selector.ref_text
                        ),
                        &selector.ref_text,
                        Some("このノード自身を指すなら、末尾の /* を外します"),
                    ));
                }
                Ok(leaves)
            }
        }
    }
}

/// 原文: checkShape。式の形が relations の種類の想定と違えば、その説明を返す
fn check_shape(kind: RelationKind, terms: &[RelationTerm]) -> Option<&'static str> {
    let (Some(first), Some(last)) = (terms.first(), terms.last()) else {
        return None;
    };
    if kind == RelationKind::Join
        && !(terms.len() == 2
            && last.ids.len() == 1
            && (first.ids.len() >= 2
                || first
                    .selectors
                    .iter()
                    .all(|s| s.scope == SelectorScope::Branch)))
    {
        return Some("join は「2 ノード以上 --> 1 ノード」の形を想定しています");
    }
    if kind == RelationKind::Fork
        && !(terms.len() == 2 && first.ids.len() == 1 && last.ids.len() >= 2)
    {
        return Some("fork は「1 ノード --> 2 ノード以上」の形を想定しています");
    }
    // ['self', 'branch'].includes(term.selectors[0]?.scope ?? '')
    if kind == RelationKind::Chain
        && !terms.iter().all(|term| {
            term.selectors.len() == 1
                && matches!(
                    term.selectors.first().map(|s| s.scope),
                    Some(SelectorScope::SelfScope | SelectorScope::Branch)
                )
        })
    {
        return Some("chain は、すべての項が 1 ノードの形を想定しています");
    }
    None
}

/// 原文: buildModel の report。診断を 1 件積む (at と hint は無ければ null)
// 規則 2.6 (A-040) と台帳 52 行: diagnostics を捕まえる閉包は、&mut Vec<Diagnostic> を引数にした自由な関数にする
fn report(
    diagnostics: &mut Vec<Diagnostic>,
    severity: Severity,
    code: &str,
    message: String,
    at: Option<SourcePosition>,
    hint: Option<String>,
) {
    diagnostics.push(Diagnostic {
        severity,
        code: code.to_string(),
        message,
        at,
        hint,
    });
}

/// 原文: buildModel の reportPrefixMatches。
/// 前方一致で解決した参照を知らせる。名前を書き誤っても、先頭が一致すればそのまま通ってしまうため
// 規則 2.6 (A-040): diagnostics と resolver を捕まえる閉包は自由な関数にする
fn report_prefix_matches(
    diagnostics: &mut Vec<Diagnostic>,
    resolver: &mut Resolver<'_>,
    context: &str,
    locate: &dyn Fn(Option<&str>) -> Option<SourcePosition>,
) {
    for PrefixMatch { ref_text, text } in resolver.take_prefix_matches() {
        report(
            diagnostics,
            Severity::Info,
            "ref-prefix",
            format!("{context}: 「{ref_text}」は前方一致で「{text}」に解決しました"),
            locate(Some(&ref_text)),
            Some(format!("書き間違いなら「{text}」に直します")),
        );
    }
}

// 道すじのキーの 1 段を作る何度も出る同じ式を private の関数 1 つにまとめる (規則 2.6、A-072)
fn key(name: &str) -> PathStep {
    PathStep::Key(name.to_string())
}

/// 原文: buildModel。
/// ノードの木と frontmatter から、relations と groups と tags を解決したグラフと、その診断を組み立てる。
/// markdown (原文) を渡すと、診断に frontmatter での位置が付く
pub fn build_model(
    nodes: &[OutlineNode],
    frontmatter: &JsValue,
    markdown: Option<&str>,
    extra: &ModelOptions,
) -> GraphModel {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut resolver = Resolver::new(nodes);
    let locator = FrontmatterLocator::new(markdown);
    // YAML として読めない frontmatter は、値を読む側 (markmap) が丸ごと捨てるので、指定が何も効かない。
    // 位置付きの解析はその誤りを見ているので、ここで知らせる
    for error in locator.syntax_errors() {
        diagnostics.push(Diagnostic {
            severity: Severity::Error,
            code: "yaml-syntax".to_string(),
            message: format!("frontmatter を YAML として読めません: {}", error.message),
            at: error.at,
            hint: Some(
                "この frontmatter は丸ごと無視されるので、markdag の指定は何も効きません"
                    .to_string(),
            ),
        });
    }
    // frontmatter の形と型はスキーマ 1 枚が出どころ。ここから下では、木やグラフを見ないと決まらない検査だけを行う
    diagnostics.extend(schema_diagnostics(frontmatter, &locator));

    // 閉路の検査に使うグラフ。ツリーのエッジを入れておき、relations を記述順に足していく
    // 台帳 67 行: successors は IndexMap、existing は `{parent}>{id}` の文字列の IndexSet
    let mut successors: IndexMap<u32, Vec<u32>> =
        nodes.iter().map(|node| (node.id, Vec::new())).collect();
    let mut existing: IndexSet<String> = IndexSet::new();
    for node in nodes {
        let Some(parent) = node.parent else { continue };
        if let Some(list) = successors.get_mut(&parent) {
            list.push(node.id);
        }
        existing.insert(format!("{parent}>{}", node.id));
    }
    let name = |id: u32| -> String {
        // 規則 2.1 の `||`: refText が空文字なら #id。nodes[id - 1] の範囲外 (undefined) も #id
        (id as usize)
            .checked_sub(1)
            .and_then(|index| nodes.get(index))
            .map(|node| node.ref_text.as_str())
            .filter(|text| !text.is_empty())
            .map_or_else(
                || format!("#{}", js_number_to_string(f64::from(id))),
                str::to_string,
            )
    };

    // markdag の指定はすべて markdag キーの下にある。知らないキー、使えない値、markdag の外に置かれた指定は、どれもスキーマが警告にしている
    let empty: IndexMap<String, JsValue> = IndexMap::new();
    let options = match frontmatter {
        JsValue::Object(entries) => match entries.get("markdag") {
            Some(JsValue::Object(markdag)) => markdag,
            _ => &empty,
        },
        _ => &empty,
    };

    let mut relations: Vec<LayoutInputRelation> = Vec::new();
    let mut warned_branch = false;
    // 写像でない relations、文字列でない式、--> のない式は、どれもスキーマが警告にしている
    let relations_raw = match options.get("relations") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    // 規則 2.3 (決定 8): 書かれた順に回す
    for (kind_key, value) in relations_raw {
        // 規則 2.6 (A-022): 原文の KINDS.includes(key as RelationKind) は from_js (KINDS は RelationKind::ALL と同じ並び)
        let Some(kind) = RelationKind::from_js(&JsValue::String(kind_key.clone())) else {
            continue;
        };
        let list: &[JsValue] = match value {
            JsValue::Array(items) => items,
            other => std::slice::from_ref(other),
        };
        // 添字は元の配列の添字 (filter していない。台帳 49 行)
        for (index, expression) in list.iter().enumerate() {
            let JsValue::String(expression) = expression else {
                continue;
            };
            let parts: Vec<&str> = ARROW.split(expression).collect();
            if parts.len() < 2 {
                continue;
            }
            // 一覧で書かれたときは添字まで、1 つだけ書かれたときはキーまでが、この式の道すじ
            let path: SourcePath = if matches!(value, JsValue::Array(_)) {
                vec![
                    key("markdag"),
                    key("relations"),
                    key(kind_key),
                    PathStep::Index(index),
                ]
            } else {
                vec![key("markdag"), key("relations"), key(kind_key)]
            };
            let place =
                |inner: Option<&str>| -> Option<SourcePosition> { locator.value(&path, inner) };
            // 規則 2.5: try の本体は Result を返す閉包。catch は Err の腕、finally は match のあと
            let outcome = (|| -> Result<(), SelectorError> {
                // 規則 2.3 (A-007): 項ごとに、その項の selectors をすべて読んでから、その項を展開する
                let mut terms: Vec<RelationTerm> = Vec::new();
                for part in &parts {
                    let selectors = AMPERSAND
                        .split(part)
                        .map(|raw| resolver.parse_selector(raw))
                        .collect::<Result<Vec<Selector>, SelectorError>>()?;
                    let mut expanded: Vec<u32> = Vec::new();
                    for selector in &selectors {
                        expanded.extend(resolver.expand(selector)?);
                    }
                    terms.push(RelationTerm {
                        selectors,
                        ids: unique_in_order(expanded),
                    });
                }
                if !warned_branch
                    && terms.iter().any(|term| {
                        term.selectors
                            .iter()
                            .any(|selector| selector.scope == SelectorScope::Branch)
                    })
                {
                    warned_branch = true;
                    report(
                        &mut diagnostics,
                        Severity::Warning,
                        "not-supported",
                        "(X) の枝の枠は未対応です。X 自身から線を出します".to_string(),
                        place(None),
                        None,
                    );
                }
                if let Some(shape) = check_shape(kind, &terms) {
                    report(
                        &mut diagnostics,
                        Severity::Warning,
                        "shape-mismatch",
                        format!("「{expression}」: {shape}"),
                        place(None),
                        None,
                    );
                }

                // 原文の terms.slice(1).forEach((term, index) => terms[index]) は、隣り合う 2 項の組
                for (previous, term) in terms.iter().zip(terms.iter().skip(1)) {
                    for &source in &previous.ids {
                        for &target in &term.ids {
                            let label = format!("{} --> {}", name(source), name(target));
                            if source == target {
                                report(
                                    &mut diagnostics,
                                    Severity::Error,
                                    "self-loop",
                                    format!("始点と終点が同じです: {label}"),
                                    place(Some(&name(source))),
                                    None,
                                );
                            } else if existing.contains(&format!("{source}>{target}")) {
                                report(
                                    &mut diagnostics,
                                    Severity::Warning,
                                    "duplicate-edge",
                                    format!("同じ線がすでにあります: {label}"),
                                    place(Some(&name(target))),
                                    Some(
                                        "この向きの線はすでにあります。重なった指定を消せます"
                                            .to_string(),
                                    ),
                                );
                            } else if reaches(&successors, target, source) {
                                report(
                                    &mut diagnostics,
                                    Severity::Error,
                                    "cycle",
                                    format!("閉路になるので追加しません: {label}"),
                                    place(Some(&name(target))),
                                    Some(format!(
                                        "「{}」から「{}」へ、すでに道があります。向きを入れ替えるか、この指定を消します",
                                        name(target),
                                        name(source)
                                    )),
                                );
                            } else {
                                existing.insert(format!("{source}>{target}"));
                                if let Some(list) = successors.get_mut(&source) {
                                    list.push(target);
                                }
                                relations.push(LayoutInputRelation {
                                    source,
                                    target,
                                    kind,
                                    origin: expression.clone(),
                                });
                            }
                        }
                    }
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                // 規則 2.1: place(error.ref) の ref が空文字なら偽 (台帳 43 行)。原文と同じく判定は位置の特定の側 (value) が持つ
                let at = place(Some(error.ref_text.as_str()));
                report(
                    &mut diagnostics,
                    Severity::Error,
                    &error.code,
                    format!("「{expression}」: {}", error.message),
                    at,
                    error.hint,
                );
            }
            report_prefix_matches(
                &mut diagnostics,
                &mut resolver,
                &format!("「{expression}」"),
                &place,
            );
        }
    }

    let top_level: IndexSet<u32> = nodes
        .iter()
        .filter(|node| node.depth == 2)
        .map(|node| node.id)
        .collect();
    let mut suppress_root_line: Vec<u32> =
        unique_in_order(relations.iter().map(|relation| relation.target))
            .into_iter()
            .filter(|id| top_level.contains(id))
            .collect();
    // 規則 2.3: `(a, b) => a - b` は u32 の昇順 (sort は安定)
    suppress_root_line.sort();

    // groups: 本文の %名前、members の指定、祖先からの継承の 3 つを合わせる
    let mut groups: Vec<GroupDef> = Vec::new();
    let mut direct: IndexMap<u32, IndexSet<String>> = nodes
        .iter()
        .map(|node| (node.id, node.groups.iter().cloned().collect()))
        .collect();
    let groups_raw = match options.get("groups") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    // 規則 2.3 (決定 8、台帳 46 行): 書かれた順に回す (整数に見えるキーを先頭へ並べない。差は審判の決定済みの差の一覧)
    for (id, raw) in groups_raw {
        let def = match raw {
            JsValue::Object(entries) => entries,
            _ => &empty,
        };
        groups.push(GroupDef {
            id: id.clone(),
            label: match def.get("label") {
                Some(JsValue::String(label)) => label.clone(),
                _ => id.clone(),
            },
            color: match def.get("color") {
                Some(JsValue::String(color)) => Some(color.clone()),
                _ => None,
            },
            boundary: matches!(def.get("boundary"), Some(JsValue::Bool(true))),
            defined: true,
        });
        let members: &[JsValue] = match def.get("members") {
            Some(JsValue::Array(items)) => items,
            _ => &[],
        };
        for (index, member) in members.iter().enumerate() {
            // 文字列でない要素と空の要素はスキーマが警告にしているので、同じ誤りを二重に出さない
            let JsValue::String(member) = member else {
                continue;
            };
            if js_trim(member).is_empty() {
                continue;
            }
            let member_path: SourcePath = vec![
                key("markdag"),
                key("groups"),
                key(id),
                key("members"),
                PathStep::Index(index),
            ];
            let member_place = |inner: Option<&str>| -> Option<SourcePosition> {
                locator.value(&member_path, inner)
            };
            let outcome = (|| -> Result<(), SelectorError> {
                let selector = resolver.parse_selector(member)?;
                if selector.scope == SelectorScope::Branch {
                    return Err(SelectorError::new(
                        "group-invalid",
                        "members に (X) は書けません".to_string(),
                        member,
                        Some("括弧を外して書きます"),
                    ));
                }
                for node_id in resolver.expand(&selector)? {
                    if let Some(set) = direct.get_mut(&node_id) {
                        set.insert(id.clone());
                    }
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                let at = member_place(Some(error.ref_text.as_str()));
                report(
                    &mut diagnostics,
                    Severity::Warning,
                    &error.code,
                    format!("markdag.groups.{id}.members「{member}」: {}", error.message),
                    at,
                    error.hint,
                );
            }
            report_prefix_matches(
                &mut diagnostics,
                &mut resolver,
                &format!("markdag.groups.{id}.members"),
                &member_place,
            );
        }
    }
    for node in nodes {
        for group_name in &node.groups {
            if !groups.iter().any(|group| &group.id == group_name) {
                groups.push(GroupDef {
                    id: group_name.clone(),
                    label: group_name.clone(),
                    color: None,
                    boundary: false,
                    defined: false,
                });
            }
        }
    }
    let order: IndexMap<String, usize> = groups
        .iter()
        .enumerate()
        .map(|(index, group)| (group.id.clone(), index))
        .collect();
    let mut groups_of: IndexMap<u32, Vec<String>> = IndexMap::new();
    for node in nodes {
        let inherited: Vec<String> = match node.parent {
            None => Vec::new(),
            Some(parent) => groups_of.get(&parent).cloned().unwrap_or_default(),
        };
        let all: IndexSet<String> = inherited
            .into_iter()
            .chain(direct.get(&node.id).into_iter().flatten().cloned())
            .collect();
        let mut sorted: Vec<String> = all.into_iter().collect();
        // 規則 2.3: 安定な sort_by。order にない名前は 0 (`?? 0`)
        sorted.sort_by(|a, b| {
            order
                .get(a)
                .copied()
                .unwrap_or(0)
                .cmp(&order.get(b).copied().unwrap_or(0))
        });
        groups_of.insert(node.id, sorted);
    }

    // tags: 定義なしで使え、配下には継承しない。見せ方は文書がまとめて決める (キーごとの指定はない)
    let tag_options_raw = match options.get("tags") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    // 規則 2.6 (A-022): TAG_DISPLAY_MODES.includes(v) は from_js
    let tag_display = tag_options_raw
        .get("display")
        .and_then(TagDisplayMode::from_js)
        .unwrap_or(TagDisplayMode::Always);
    let mut tags_of: IndexMap<u32, Vec<NodeTag>> = IndexMap::new();
    for node in nodes {
        tags_of.insert(node.id, node.tags.clone());
    }

    // types と tags.keys: 型をキーごとの定義に解決し、本文のタグを検査する。$ref のファイルは呼び出し側が読んで extra.types に渡す
    let types_raw = match options.get("types") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    let refs_listed = matches!(types_raw.get("$ref"), Some(JsValue::Array(_)));
    let refs: Vec<&String> = match types_raw.get("$ref") {
        Some(JsValue::String(one)) => vec![one],
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(text) => Some(text),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut sources: Vec<TypeSource> = Vec::new();
    let mut unresolved = false;
    // 規則 2.3: 添字は filter のあとの位置 (台帳 50 行)
    // BUG(port): `$ref: [1, './a.yaml']` で './a.yaml' の types-unresolved が `$ref[0]` (YAML の 1 の項目) を指す。原文 model.ts:813-824 のまま
    for (index, ref_text) in refs.iter().enumerate() {
        // 規則 2.3 (A-011): キーがない、または値が Undefined は「渡していない」、Null は「読めなかった」。
        // 規則 2.1 の `obj[k]`: 自分の持つキーだけを見る (`toString` や `__proto__` で prototype の値を引かない。決定済みの差)
        let loaded = extra
            .types
            .as_ref()
            .and_then(|types| types.get(ref_text.as_str()))
            .filter(|value| !matches!(value, JsValue::Undefined));
        if let Some(JsValue::Object(defs)) = loaded {
            sources.push(TypeSource {
                label: (*ref_text).clone(),
                defs: defs.clone(),
                path: None,
            });
            continue;
        }
        unresolved = true;
        let path: SourcePath = if refs_listed {
            vec![
                key("markdag"),
                key("types"),
                key("$ref"),
                PathStep::Index(index),
            ]
        } else {
            vec![key("markdag"), key("types"), key("$ref")]
        };
        report(
            &mut diagnostics,
            Severity::Warning,
            "types-unresolved",
            format!(
                "markdag.types.$ref「{ref_text}」を読めなかったので、その中の型は使えません (その型を使うキーは検査しません)"
            ),
            locator.value(&path, None),
            Some(if loaded.is_none() {
                "呼び出し側が読んで buildModel の types に渡します (npm run check は文書の場所からの相対で読みます)".to_string()
            } else {
                "ファイルが YAML のキーと値の組として読めるか確かめます".to_string()
            }),
        );
    }
    // 規則 2.3 (台帳 51 行): $ref を除くのは shift_remove (順を保つ)
    let mut own_types = types_raw.clone();
    own_types.shift_remove("$ref");
    sources.push(TypeSource {
        label: "markdag.types".to_string(),
        defs: own_types,
        path: Some(vec![key("markdag"), key("types")]),
    });
    let raw_keys = match tag_options_raw.get("keys") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    let resolved = resolve_tag_keys(
        &sources,
        raw_keys,
        &[key("markdag"), key("tags"), key("keys")],
        unresolved,
    );
    let lint = TagLintOptions {
        severity: match tag_options_raw.get("lint") {
            Some(JsValue::String(value)) if value == "error" => TagLintSeverity::Error,
            _ => TagLintSeverity::Warning,
        },
        unknown_key: match tag_options_raw.get("unknownKey") {
            Some(JsValue::String(value)) if value == "deny" => TagLintUnknownKey::Deny,
            _ => TagLintUnknownKey::Allow,
        },
    };
    // 規則 2.3: 原文の [...resolved.issues, ...lintTags(...)] は、lintTags を済ませてから並べる
    let linted = lint_tags(nodes, &resolved.keys, &lint);
    for issue in resolved.issues.iter().chain(linted.iter()) {
        // 規則 2.1: issue.path は配列なので空でも真 (is_some だけ)
        let at = issue.at.clone().or_else(|| {
            issue
                .path
                .as_ref()
                .and_then(|path| locator.value(path, None))
        });
        diagnostics.push(Diagnostic {
            severity: issue.severity,
            code: issue.code.clone(),
            message: issue.message.clone(),
            at,
            hint: issue.hint.clone(),
        });
    }

    // hooks: 文書は使うフックの名前だけを宣言し、実体は呼び出し側が渡す。ここでは宣言と実体を突き合わせて診断を出す
    let hooks = resolve_hooks(
        options.get("hooks").unwrap_or(&JsValue::Undefined),
        extra.hook_refs.as_ref(),
    );
    for issue in &hooks.issues {
        let at = issue
            .path
            .as_ref()
            .and_then(|path| locator.value(path, None));
        report(
            &mut diagnostics,
            issue.severity,
            &issue.code,
            issue.message.clone(),
            at,
            issue.hint.clone(),
        );
    }
    // rules: コードを書かずに使える規則。組み込みのフックにして、宣言したフックより先に評価する (並べるのは JS の包み)
    let rules = rules_module(options.get("rules").unwrap_or(&JsValue::Undefined));
    let group_ids: Vec<&str> = groups.iter().map(|group| group.id.as_str()).collect();
    // 規則 2.3: 添字は filter のあとの位置 (rulesModule が文字列だけを残した一覧。台帳 50 行)
    // BUG(port): `readonlyGroups: [1, 'x']` で「x」の option-invalid が `readonlyGroups[0]` (YAML の 1 の項目) を指す。原文 model.ts:843-846 のまま
    for (index, group_name) in rules
        .iter()
        .flat_map(|rules| rules.readonly_groups.iter())
        .enumerate()
    {
        if group_ids.contains(&group_name.as_str()) {
            continue;
        }
        // 台帳 58 行: closest は純粋なので 1 回でよい
        let hint = match closest(group_name, &group_ids) {
            None => "本文で %名前 を付けるか、markdag.groups に定義します".to_string(),
            Some(near) => format!("もしかして「{near}」"),
        };
        report(
            &mut diagnostics,
            Severity::Warning,
            "option-invalid",
            format!(
                "markdag.rules.taskToggle.readonlyGroups: グループ「{group_name}」は、この文書のどのノードにも付いていません"
            ),
            locator.value(
                &[
                    key("markdag"),
                    key("rules"),
                    key("taskToggle"),
                    key("readonlyGroups"),
                    PathStep::Index(index),
                ],
                None,
            ),
            Some(hint),
        );
    }

    let details_options = match options.get("details") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    // 規則 2.6 (A-022): DISPLAY_MODES.includes(v) は from_js
    let details_mode = details_options
        .get("display")
        .and_then(DisplayMode::from_js);
    // tasks: クリックで進む順と、薄く表示する状態。使えない値は指定なしとして扱う (診断はスキーマの検証が出す)。
    // 順は 2 つ以上でないと進めないので、それだけはここで知らせる
    let task_options = match options.get("tasks") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    let cycle_raw: Option<&[JsValue]> = match task_options.get("cycle") {
        Some(JsValue::Array(items)) => Some(items),
        _ => None,
    };
    let cycle_marks: Vec<TaskMark> = unique_in_order(
        cycle_raw
            .unwrap_or_default()
            .iter()
            .filter_map(is_task_mark),
    );
    if cycle_raw.is_some_and(|items| items.len() < 2) {
        report(
            &mut diagnostics,
            Severity::Warning,
            "option-invalid",
            "markdag.tasks.cycle: クリックで進む順は、記号を 2 つ以上並べます".to_string(),
            locator.value(&[key("markdag"), key("tasks"), key("cycle")], None),
            Some("未完了と完了の行き来なら書かずに済みます。作業中を挟むなら [' ', '/', 'x'] と書きます".to_string()),
        );
    }
    let task_cycle: Vec<TaskMark> = if cycle_marks.len() >= 2 {
        cycle_marks
    } else {
        DEFAULT_TASK_CYCLE.to_vec()
    };
    // 配列なら { states: 配列 }、写像ならそのまま、それ以外は {}
    let dim_raw: IndexMap<String, JsValue> = match task_options.get("dim") {
        Some(states @ JsValue::Array(_)) => {
            IndexMap::from([("states".to_string(), states.clone())])
        }
        Some(JsValue::Object(entries)) => entries.clone(),
        _ => IndexMap::new(),
    };
    let dim_mode = |value: Option<&JsValue>| -> DimDisplayMode {
        // DIM_DISPLAY_MODES.includes(v) は from_js
        value
            .and_then(DimDisplayMode::from_js)
            .unwrap_or(DimDisplayMode::Keep)
    };
    let dim_states: &[JsValue] = match dim_raw.get("states") {
        Some(JsValue::Array(items)) => items,
        _ => &[],
    };
    let task_dim = TaskDimOptions {
        states: unique_in_order(
            dim_states
                .iter()
                .filter_map(is_task_mark)
                .map(task_state_of),
        ),
        details: dim_mode(dim_raw.get("details")),
        tags: dim_mode(dim_raw.get("tags")),
    };
    // edgeHighlight: false と書いたときだけ、線をクリックしての強調を使えなくする (`!== false` は Bool(false) だけが偽)
    let edge_highlight = !matches!(options.get("edgeHighlight"), Some(JsValue::Bool(false)));
    let group_highlight = !matches!(options.get("groupHighlight"), Some(JsValue::Bool(false)));

    // legend.display: false で凡例を出さない。一覧で項目を選ぶ (書かれた順ではなく、既定の並び順で出す)。
    // legend.position: 凡例を置く隅。どちらも、使えない値は指定なしとして扱う (診断はスキーマの検証が出す)
    let legend_options = match options.get("legend") {
        Some(JsValue::Object(entries)) => entries,
        _ => &empty,
    };
    let legend: Vec<LegendItem> = match legend_options.get("display") {
        Some(JsValue::Bool(false)) => Vec::new(),
        // wanted.includes(item): 文字列の要素だけが一致しうる
        Some(JsValue::Array(wanted)) => DEFAULT_LEGEND
            .iter()
            .copied()
            .filter(|item| {
                wanted
                    .iter()
                    .any(|value| LegendItem::from_js(value) == Some(*item))
            })
            .collect(),
        _ => DEFAULT_LEGEND.to_vec(),
    };
    // LEGEND_POSITIONS.find(p => p === v) は from_js
    let legend_position = legend_options
        .get("position")
        .and_then(LegendPosition::from_js)
        .unwrap_or(LegendPosition::TopRight);

    // branches: 色を分ける単位を、著者が起点のノードで指定する。起点の配下は起点の色になり、起点の中の起点はそこから別の色になる。
    // 書かれていないノードには色を付けない (このキーのない文書は、今までどおり colorFreezeLevel で色が決まる)
    let mut branches: Vec<u32> = Vec::new();
    // 同じ表記の重なりはスキーマが拾うので、ここでは別の表記で同じノードを指した場合だけを警告にする
    let mut branch_of: IndexMap<u32, String> = IndexMap::new();
    let items: &[JsValue] = match options.get("branches") {
        Some(JsValue::Array(items)) => items,
        _ => &[],
    };
    for (index, item) in items.iter().enumerate() {
        // 文字列でない要素と空の要素はスキーマが警告にしているので、同じ誤りを二重に出さない
        let JsValue::String(item) = item else {
            continue;
        };
        if js_trim(item).is_empty() {
            continue;
        }
        let branch_path: SourcePath = vec![key("markdag"), key("branches"), PathStep::Index(index)];
        let branch_place =
            |inner: Option<&str>| -> Option<SourcePosition> { locator.value(&branch_path, inner) };
        let outcome = (|| -> Result<(), SelectorError> {
            let selector = resolver.parse_selector(item)?;
            if selector.scope != SelectorScope::SelfScope {
                return Err(SelectorError::new(
                    "option-invalid",
                    format!(
                        "「{item}」は 1 ノードの指定ではありません。枝の起点は 1 ノードで指定します ((X), /*, /** は使えません)"
                    ),
                    item,
                    Some(&format!(
                        "配下をまとめて 1 色にするなら「{}」だけを書きます (配下は起点の色を引き継ぎます)",
                        selector.ref_text
                    )),
                ));
            }
            let id = resolver.resolve_ref(&selector.ref_text)?;
            let written = branch_of.get(&id);
            // 同じ表記の 2 度書きはスキーマが拾うので、ここでは黙って読み飛ばす。
            // 原文の try の中の continue: 本体の残りを飛ばし、finally (前方一致の報告) は通る (規則 2.5)
            if written == Some(item) {
                return Ok(());
            }
            if let Some(written) = written {
                return Err(SelectorError::new(
                    "option-invalid",
                    format!(
                        "「{item}」は「{written}」と同じノードで、すでに枝の起点になっています"
                    ),
                    item,
                    Some("この行は消せます"),
                ));
            }
            branch_of.insert(id, item.clone());
            branches.push(id);
            Ok(())
        })();
        if let Err(error) = outcome {
            let at = branch_place(Some(error.ref_text.as_str()));
            report(
                &mut diagnostics,
                Severity::Warning,
                &error.code,
                format!("markdag.branches: {}", error.message),
                at,
                error.hint,
            );
        }
        report_prefix_matches(
            &mut diagnostics,
            &mut resolver,
            "markdag.branches",
            &branch_place,
        );
    }

    // 本文の書き方のうち図に出ないもの (上限より深い入れ子、生の HTML の見出し)。原文があるときだけ読み直して知らせる (A-105、A-112)
    if let Some(markdown) = markdown {
        diagnostics.extend(crate::parse::body_diagnostics(markdown));
    }

    GraphModel {
        details_mode,
        legend,
        legend_position,
        edge_highlight,
        group_highlight,
        branches,
        relations,
        suppress_root_line,
        groups,
        groups_of,
        tag_display,
        tags_of,
        tag_keys: resolved.keys,
        task_cycle,
        task_dim,
        // 設計文書 (b): hooks はデータ。markdag.rules を宣言の前に並べるのは JS の包み
        hooks: ModelHooks {
            declared: hooks.hooks,
            options: hooks.options,
            rules,
        },
        diagnostics,
    }
}

/// 原文: buildModel の reaches。閉路の検査のグラフで from から to へ道があるか (深さ優先)
// 規則 2.6 (A-040): successors を捕まえる閉包は、引数にした自由な関数にする (呼ぶ側が successors を書き換えるため)
fn reaches(successors: &IndexMap<u32, Vec<u32>>, from: u32, to: u32) -> bool {
    let mut seen: IndexSet<u32> = IndexSet::from([from]);
    let mut stack: Vec<u32> = vec![from];
    while let Some(current) = stack.pop() {
        if current == to {
            return true;
        }
        for &next in successors.get(&current).map(Vec::as_slice).unwrap_or(&[]) {
            if !seen.contains(&next) {
                seen.insert(next);
                stack.push(next);
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DeclaredHook, HookSpecEntry, RulesConfig};

    // 期待値は node (vite-node) で src/model/model.ts の Resolver / checkShape / splitPath / normalize を直接呼んで取った
    fn node(
        id: u32,
        parent: Option<u32>,
        depth: u32,
        ref_text: &str,
        ref_id: Option<&str>,
    ) -> OutlineNode {
        OutlineNode {
            id,
            parent,
            depth,
            html: String::new(),
            ref_text: ref_text.to_string(),
            ref_id: ref_id.map(str::to_string),
            groups: Vec::new(),
            tags: Vec::new(),
            milestone: false,
            fold_hint: 0.0,
            lines: None,
            task: None,
            details: None,
        }
    }

    fn tree() -> Vec<OutlineNode> {
        vec![
            node(1, None, 1, "Root", None),
            node(2, Some(1), 2, "設計", Some("design")),
            node(3, Some(2), 3, "画面", None),
            node(4, Some(2), 3, "API", None),
            node(5, Some(1), 2, "実装", None),
            node(6, Some(5), 3, "画面", None),
            node(7, Some(5), 3, "API基盤", None),
            node(8, Some(1), 2, "テスト", Some("dup")),
            node(9, Some(1), 2, "A/B", Some("dup")),
            node(10, Some(1), 2, "(注)x", None),
            node(11, Some(1), 2, "$100 plan", None),
            node(12, Some(1), 2, "", None),
            node(13, Some(7), 4, "ｶﾞ", None),
            node(14, Some(1), 2, "Ca\u{301}fe  au\tlait", None),
            node(15, Some(1), 2, "Caf\u{e9}", None),
        ]
    }

    fn sel(ref_text: &str, scope: SelectorScope) -> Selector {
        Selector {
            ref_text: ref_text.to_string(),
            scope,
        }
    }

    fn err(code: &str, message: &str, ref_text: &str, hint: Option<&str>) -> SelectorError {
        SelectorError::new(code, message.to_string(), ref_text, hint)
    }

    fn prefix(ref_text: &str, text: &str) -> PrefixMatch {
        PrefixMatch {
            ref_text: ref_text.to_string(),
            text: text.to_string(),
        }
    }

    // 解決の結果と、その直後に取り出した前方一致の記録
    fn resolve(ref_text: &str) -> (Result<u32, SelectorError>, Vec<PrefixMatch>) {
        let nodes = tree();
        let mut resolver = Resolver::new(&nodes);
        let result = resolver.resolve_ref(ref_text);
        (result, resolver.take_prefix_matches())
    }

    fn expand(
        ref_text: &str,
        scope: SelectorScope,
    ) -> (Result<Vec<u32>, SelectorError>, Vec<PrefixMatch>) {
        let nodes = tree();
        let mut resolver = Resolver::new(&nodes);
        let result = resolver.expand(&sel(ref_text, scope));
        (result, resolver.take_prefix_matches())
    }

    fn parse(raw: &str) -> Result<Selector, SelectorError> {
        let nodes = tree();
        Resolver::new(&nodes).parse_selector(raw)
    }

    const HINT_NOT_FOUND: &str =
        "ノードの 1 行目の文字を、先頭から書きます (装飾とタグは除いた文字)";
    const HINT_AMBIGUOUS: &str =
        "親のノードを付けて「親/子」と書くか、指したいノードの行末に $id を付けると 1 つに絞れます";

    #[test]
    fn lazy_locks_compile() {
        assert!(BRANCH_WITH_EXPAND.is_match("(A)/*"));
        assert!(REF_ID.is_match("$a-1_b"));
        assert_eq!(SEGMENT_ESCAPE.replace_all(r"a\/b", "$1"), "a/b");
        assert_eq!(SPACES_AND_TABS.replace_all("a \t b", " "), "a b");
    }

    #[test]
    fn normalize_frontmatter_text_cases() {
        assert_eq!(normalize_frontmatter_text(" a \t b "), "a b");
        assert_eq!(normalize_frontmatter_text("Cafe\u{301}"), "Caf\u{e9}");
        // 改行はまとめない (本文の normalize_ref_text との違い)
        assert_eq!(normalize_frontmatter_text("a\nb"), "a\nb");
        assert_eq!(normalize_frontmatter_text("\u{3000}x\u{3000}"), "x");
        // U+00A0 は [ \t] に入らないのでまとめない
        assert_eq!(normalize_frontmatter_text("a\u{a0} b"), "a\u{a0} b");
    }

    #[test]
    fn split_path_cases() {
        let cases: &[(&str, &[&str])] = &[
            ("a/b", &["a", "b"]),
            ("/a", &["", "a"]),
            ("a/", &["a", ""]),
            (r"a\/b", &[r"a\/b"]),
            (r"\/", &[r"\/"]),
            ("a//b", &["a", "", "b"]),
            ("", &[""]),
            ("/", &["", ""]),
            (r"あ/い\/う", &["あ", r"い\/う"]),
        ];
        for (input, expected) in cases {
            assert_eq!(
                split_path(input),
                expected.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                "{input}"
            );
        }
    }

    #[test]
    fn tree_helpers() {
        let nodes = tree();
        let resolver = Resolver::new(&nodes);
        assert_eq!(
            resolver
                .ancestors(13)
                .iter()
                .map(|n| n.id)
                .collect::<Vec<_>>(),
            vec![1, 5, 7]
        );
        assert!(resolver.ancestors(1).is_empty());
        assert_eq!(
            resolver.descendants(1),
            vec![2, 3, 4, 5, 6, 7, 13, 8, 9, 10, 11, 12, 14, 15]
        );
        assert!(resolver.children_of(99).is_empty());
        assert_eq!(resolver.children_of(2), &[3, 4]);
    }

    #[test]
    fn parse_selector_scopes() {
        use SelectorScope::*;
        let cases: &[(&str, &str, SelectorScope)] = &[
            ("A", "A", SelfScope),
            ("  A  ", "A", SelfScope),
            ("(A)", "A", Branch),
            ("( A )", "A", Branch),
            ("()", "", Branch),
            ("\u{3000}(A)\u{3000}", "A", Branch),
            ("A/*", "A", Leaves),
            ("A/**", "A", All),
            ("A/**/*", "A/**", Leaves),
            ("(A", "(A", SelfScope),
            ("A)", "A)", SelfScope),
            ("(A)x/*", "(A)x", Leaves),
            // JS の . は改行に一致しないので括弧と /* の組み合わせの誤りにならない
            ("(A\n)/*", "(A\n)", Leaves),
            ("(A)/*x", "(A)/*x", SelfScope),
        ];
        for (raw, ref_text, scope) in cases {
            assert_eq!(parse(raw), Ok(sel(ref_text, *scope)), "{raw:?}");
        }
    }

    #[test]
    fn parse_selector_syntax_errors() {
        let hint = Some("枝の枠でまとめるか配下に展開するかの、どちらかにします");
        assert_eq!(
            parse("(A)/*"),
            Err(err(
                "relation-syntax",
                "括弧と /* は組み合わせられません: (A)/*",
                "(A)/*",
                hint
            ))
        );
        assert_eq!(
            parse("(A)/**"),
            Err(err(
                "relation-syntax",
                "括弧と /* は組み合わせられません: (A)/**",
                "(A)/**",
                hint
            ))
        );
        assert_eq!(
            parse("/*"),
            Err(err("relation-syntax", "参照が空です: /*", "/*", None))
        );
        assert_eq!(
            parse("/**"),
            Err(err("relation-syntax", "参照が空です: /**", "/**", None))
        );
        // 文面は trim 前の raw、ref は trim 後
        assert_eq!(
            parse("  "),
            Err(err("relation-syntax", "参照が空です:   ", "", None))
        );
        assert_eq!(
            parse(""),
            Err(err("relation-syntax", "参照が空です: ", "", None))
        );
    }

    #[test]
    fn resolve_ref_id_branch() {
        assert_eq!(resolve("$design"), (Ok(2), vec![]));
        assert_eq!(
            resolve("$desgn").0,
            Err(err(
                "ref-not-found",
                "$desgn が見つかりません",
                "$desgn",
                Some("もしかして「$design」")
            ))
        );
        assert_eq!(
            resolve("$nothing").0,
            Err(err(
                "ref-not-found",
                "$nothing が見つかりません",
                "$nothing",
                Some("本文のノードの行末に $id を書くと、その名前で指せます")
            ))
        );
        assert_eq!(
            resolve("$dup").0,
            Err(err(
                "ref-ambiguous",
                "$dup が複数あります",
                "$dup",
                Some("同じ $id を 2 つ以上のノードに書かないようにします")
            ))
        );
        // $id の形でないものは経路として探す
        assert_eq!(
            resolve("$1bad").0,
            Err(err(
                "ref-not-found",
                "「$1bad」に一致するノードがありません",
                "$1bad",
                Some(HINT_NOT_FOUND)
            ))
        );
        assert_eq!(
            resolve("$design\n").0,
            Err(err(
                "ref-not-found",
                "「$design\n」に一致するノードがありません",
                "$design\n",
                Some(HINT_NOT_FOUND)
            ))
        );
        assert_eq!(resolve("$100 plan"), (Ok(11), vec![]));
    }

    #[test]
    fn resolve_ref_paths() {
        assert_eq!(resolve("Root"), (Ok(1), vec![]));
        assert_eq!(resolve("  Root  "), (Ok(1), vec![]));
        assert_eq!(resolve("設計/画面"), (Ok(3), vec![]));
        assert_eq!(resolve("実装/画面"), (Ok(6), vec![]));
        assert_eq!(resolve("Root/実装/画面"), (Ok(6), vec![]));
        assert_eq!(resolve("Root\t\t/  実装  /画面"), (Ok(6), vec![]));
        assert_eq!(resolve("API"), (Ok(4), vec![]));
        assert_eq!(resolve("設計/API"), (Ok(4), vec![]));
        assert_eq!(resolve("実装/ｶﾞ"), (Ok(13), vec![]));
        assert_eq!(resolve("API基盤/ｶﾞ"), (Ok(13), vec![]));
        // NFC で合成済みの字と一致する
        assert_eq!(resolve("Cafe\u{301}"), (Ok(15), vec![]));
        assert_eq!(
            resolve("設計/ｶﾞ").0,
            Err(err(
                "ref-not-found",
                "「設計/ｶﾞ」に一致するノードがありません",
                "設計/ｶﾞ",
                Some(HINT_NOT_FOUND)
            ))
        );
        for bad in ["実装//画面", "/画面", "Root/実装/画面/", r"x\y", "A/B"] {
            assert_eq!(
                resolve(bad).0,
                Err(err(
                    "ref-not-found",
                    &format!("「{bad}」に一致するノードがありません"),
                    bad,
                    Some(HINT_NOT_FOUND)
                )),
                "{bad}"
            );
        }
    }

    #[test]
    fn resolve_ref_escaped_segments() {
        assert_eq!(resolve(r"A\/B"), (Ok(9), vec![]));
        assert_eq!(resolve(r"\(注)x"), (Ok(10), vec![]));
        assert_eq!(resolve(r"\$100 plan"), (Ok(11), vec![]));
    }

    #[test]
    fn resolve_ref_prefix_matches_are_recorded() {
        assert_eq!(resolve("R"), (Ok(1), vec![prefix("R", "Root")]));
        assert_eq!(resolve("テス"), (Ok(8), vec![prefix("テス", "テスト")]));
        assert_eq!(
            resolve("実装/API"),
            (Ok(7), vec![prefix("実装/API", "API基盤")])
        );
        // 祖先の区間の欠陥の再現: 「実」→「実装」の前方一致は記録しない
        assert_eq!(resolve("実/画"), (Ok(6), vec![prefix("実/画", "画面")]));
    }

    #[test]
    fn resolve_ref_ambiguous_and_hints() {
        assert_eq!(
            resolve("画面").0,
            Err(err(
                "ref-ambiguous",
                "「画面」に一致するノードが 2 個あります (画面、画面)",
                "画面",
                Some(HINT_AMBIGUOUS)
            ))
        );
        assert_eq!(
            resolve("Root/画面").0,
            Err(err(
                "ref-ambiguous",
                "「Root/画面」に一致するノードが 2 個あります (画面、画面)",
                "Root/画面",
                Some(HINT_AMBIGUOUS)
            ))
        );
        assert_eq!(
            resolve("AP").0,
            Err(err(
                "ref-ambiguous",
                "「AP」に一致するノードが 2 個あります (API、API基盤)",
                "AP",
                Some(HINT_AMBIGUOUS)
            ))
        );
        // 空の参照は前方一致で空でないすべてのノードに一致する
        assert_eq!(
            resolve("").0,
            Err(err(
                "ref-ambiguous",
                "「」に一致するノードが 14 個あります (Root、設計、画面、API、実装、画面、API基盤、テスト、A/B、(注)x、$100 plan、ｶﾞ、Ca\u{301}fe  au\tlait、Caf\u{e9})",
                "",
                Some(HINT_AMBIGUOUS)
            ))
        );
        assert_eq!(
            resolve("Rot").0,
            Err(err(
                "ref-not-found",
                "「Rot」に一致するノードがありません",
                "Rot",
                Some("もしかして「Root」")
            ))
        );
        assert_eq!(
            resolve("Cafe").0,
            Err(err(
                "ref-not-found",
                "「Cafe」に一致するノードがありません",
                "Cafe",
                Some("もしかして「Caf\u{e9}」")
            ))
        );
        assert_eq!(
            resolve("Café au lait").0,
            Err(err(
                "ref-not-found",
                "「Café au lait」に一致するノードがありません",
                "Café au lait",
                Some("もしかして「Ca\u{301}fe  au\tlait」")
            ))
        );
        for far in ["zzzz", "テスtt"] {
            assert_eq!(
                resolve(far).0,
                Err(err(
                    "ref-not-found",
                    &format!("「{far}」に一致するノードがありません"),
                    far,
                    Some(HINT_NOT_FOUND)
                ))
            );
        }
    }

    #[test]
    fn expand_scopes() {
        use SelectorScope::*;
        assert_eq!(expand("設計", SelfScope), (Ok(vec![2]), vec![]));
        assert_eq!(expand("設計", Branch), (Ok(vec![2]), vec![]));
        assert_eq!(expand("設計", All), (Ok(vec![2, 3, 4]), vec![]));
        assert_eq!(expand("設計", Leaves), (Ok(vec![3, 4]), vec![]));
        assert_eq!(
            expand("Root", Leaves),
            (Ok(vec![3, 4, 6, 13, 8, 9, 10, 11, 12, 14, 15]), vec![])
        );
        assert_eq!(
            expand("Root", All),
            (
                Ok(vec![1, 2, 3, 4, 5, 6, 7, 13, 8, 9, 10, 11, 12, 14, 15]),
                vec![]
            )
        );
    }

    #[test]
    fn expand_errors() {
        use SelectorScope::*;
        let empty_hint = Some("このノード自身を指すなら、末尾の /* を外します");
        assert_eq!(
            expand("設計/画面", Leaves),
            (
                Err(err(
                    "selector-empty",
                    "「設計/画面/*」は、配下にノードがないので展開できません",
                    "設計/画面",
                    empty_hint
                )),
                vec![]
            )
        );
        // 前方一致の記録は selector-empty の前に済んでいる (呼び出し側は finally で報告する)
        assert_eq!(
            expand("テ", Leaves),
            (
                Err(err(
                    "selector-empty",
                    "「テ/*」は、配下にノードがないので展開できません",
                    "テ",
                    empty_hint
                )),
                vec![prefix("テ", "テスト")]
            )
        );
        assert_eq!(
            expand("画面", Leaves).0,
            Err(err(
                "ref-ambiguous",
                "「画面」に一致するノードが 2 個あります (画面、画面)",
                "画面",
                Some(HINT_AMBIGUOUS)
            ))
        );
        assert_eq!(
            expand("Missing", All).0,
            Err(err(
                "ref-not-found",
                "「Missing」に一致するノードがありません",
                "Missing",
                Some(HINT_NOT_FOUND)
            ))
        );
    }

    #[test]
    fn take_prefix_matches_empties_the_record() {
        let nodes = tree();
        let mut resolver = Resolver::new(&nodes);
        assert_eq!(resolver.resolve_ref("R"), Ok(1));
        assert_eq!(resolver.resolve_ref("テス"), Ok(8));
        assert_eq!(
            resolver.take_prefix_matches(),
            vec![prefix("R", "Root"), prefix("テス", "テスト")]
        );
        assert!(resolver.take_prefix_matches().is_empty());
    }

    fn term(scopes: &[SelectorScope], ids: &[u32]) -> RelationTerm {
        RelationTerm {
            selectors: scopes.iter().map(|&scope| sel("x", scope)).collect(),
            ids: ids.to_vec(),
        }
    }

    #[test]
    fn check_shape_cases() {
        use RelationKind::*;
        use SelectorScope::*;
        const JOIN: Option<&str> = Some("join は「2 ノード以上 --> 1 ノード」の形を想定しています");
        const FORK: Option<&str> = Some("fork は「1 ノード --> 2 ノード以上」の形を想定しています");
        const CHAIN: Option<&str> = Some("chain は、すべての項が 1 ノードの形を想定しています");
        let cases: Vec<(RelationKind, Vec<RelationTerm>, Option<&str>)> = vec![
            (
                Join,
                vec![
                    term(&[SelfScope, SelfScope], &[1, 2]),
                    term(&[SelfScope], &[3]),
                ],
                None,
            ),
            (
                Join,
                vec![term(&[SelfScope], &[1]), term(&[SelfScope], &[3])],
                JOIN,
            ),
            (
                Join,
                vec![term(&[Branch], &[1]), term(&[SelfScope], &[3])],
                None,
            ),
            (
                Join,
                vec![term(&[Branch, SelfScope], &[1]), term(&[SelfScope], &[3])],
                JOIN,
            ),
            (
                Join,
                vec![
                    term(&[SelfScope, SelfScope], &[1, 2]),
                    term(&[SelfScope], &[3, 4]),
                ],
                JOIN,
            ),
            (
                Join,
                vec![
                    term(&[SelfScope, SelfScope], &[1, 2]),
                    term(&[SelfScope], &[3]),
                    term(&[SelfScope], &[4]),
                ],
                JOIN,
            ),
            // selectors が空なら every は真
            (Join, vec![term(&[], &[]), term(&[SelfScope], &[3])], None),
            (
                Fork,
                vec![
                    term(&[SelfScope], &[1]),
                    term(&[SelfScope, SelfScope], &[2, 3]),
                ],
                None,
            ),
            (
                Fork,
                vec![term(&[SelfScope], &[1]), term(&[All], &[2])],
                FORK,
            ),
            (
                Fork,
                vec![
                    term(&[SelfScope, SelfScope], &[1, 2]),
                    term(&[All], &[2, 3]),
                ],
                FORK,
            ),
            (
                Chain,
                vec![
                    term(&[SelfScope], &[1]),
                    term(&[Branch], &[2]),
                    term(&[SelfScope], &[3]),
                ],
                None,
            ),
            (
                Chain,
                vec![term(&[SelfScope], &[1]), term(&[Leaves], &[2, 3])],
                CHAIN,
            ),
            (
                Chain,
                vec![
                    term(&[SelfScope, SelfScope], &[1, 2]),
                    term(&[SelfScope], &[3]),
                ],
                CHAIN,
            ),
            (
                Chain,
                vec![term(&[All], &[1]), term(&[SelfScope], &[3])],
                CHAIN,
            ),
            (
                Depends,
                vec![term(&[All], &[1, 2]), term(&[Leaves], &[3, 4])],
                None,
            ),
            (Join, vec![], None),
            (Chain, vec![term(&[SelfScope], &[1])], None),
        ];
        for (index, (kind, terms, expected)) in cases.iter().enumerate() {
            assert_eq!(check_shape(*kind, terms), *expected, "case {index}");
        }
    }

    // ---- build_model ----
    // 期待値は、Rust の parse_document が出した nodes と frontmatter を node (vite-node) の src/model/model.ts の buildModel に
    // 渡して取った (2026-09-24)。types は `{ './null.yaml': null, './ok.yaml': { fromOk: { type: 'string' } } }`、
    // hookRefs は d4 だけ `{ './a.js': { beforeFold: 関数, x: 1 }, './b.js': null }` (他は undefined)。
    // hooks は形が違う (設計文書 (b)) ので JSON から外して別に比べる

    const D1_SOURCE: &str = r##"---
markdag:
  relations:
    chain:
      - Root --> Root
      - Root --> 設計
      - 画面 --> 設計
      - 設計/画 --> テス
      - Missing --> (Root)/*
      - Missing & (Root)/* --> 設計
    join: (設計) & 実装 --> テスト
    fork: 設計 --> 実装/API/*
    depends: " --> 設計"
    bogus: a --> b
---
# Root
## 設計
### 画面
## 実装
### 画面
### API
## テスト
"##;
    // node の buildModel の出力 (hooks を除く): {"hooks": [], "options": {}}
    const D1_MODEL: &str = r##"{"detailsMode":null,"legend":["groups","branches"],"legendPosition":"top-right","edgeHighlight":true,"groupHighlight":true,"branches":[],"relations":[{"kind":"chain","source":3,"target":7,"origin":"設計/画 --> テス"},{"kind":"join","source":2,"target":7,"origin":"(設計) & 実装 --> テスト"},{"kind":"join","source":4,"target":7,"origin":"(設計) & 実装 --> テスト"}],"suppressRootLine":[7],"groups":[],"groupsOf":[[1,[]],[2,[]],[3,[]],[4,[]],[5,[]],[6,[]],[7,[]]],"tagDisplay":"always","tagsOf":[[1,[]],[2,[]],[3,[]],[4,[]],[5,[]],[6,[]],[7,[]]],"tagKeys":[],"taskCycle":[" ","x"],"taskDim":{"states":[],"details":"keep","tags":"keep"},"diagnostics":[{"severity":"warning","code":"relation-unknown-key","message":"markdag.relations のキー「bogus」は使えません (fork, join, chain, depends)","at":{"line":14,"column":5,"length":5},"hint":"relations に書けるのは fork, join, chain, depends です"},{"severity":"error","code":"self-loop","message":"始点と終点が同じです: Root --> Root","at":{"line":5,"column":9,"length":13},"hint":null},{"severity":"warning","code":"duplicate-edge","message":"同じ線がすでにあります: Root --> 設計","at":{"line":6,"column":18,"length":2},"hint":"この向きの線はすでにあります。重なった指定を消せます"},{"severity":"error","code":"ref-ambiguous","message":"「画面 --> 設計」: 「画面」に一致するノードが 2 個あります (画面、画面)","at":{"line":7,"column":9,"length":2},"hint":"親のノードを付けて「親/子」と書くか、指したいノードの行末に $id を付けると 1 つに絞れます"},{"severity":"info","code":"ref-prefix","message":"「設計/画 --> テス」: 「設計/画」は前方一致で「画面」に解決しました","at":{"line":8,"column":9,"length":4},"hint":"書き間違いなら「画面」に直します"},{"severity":"info","code":"ref-prefix","message":"「設計/画 --> テス」: 「テス」は前方一致で「テスト」に解決しました","at":{"line":8,"column":18,"length":2},"hint":"書き間違いなら「テスト」に直します"},{"severity":"error","code":"ref-not-found","message":"「Missing --> (Root)/*」: 「Missing」に一致するノードがありません","at":{"line":9,"column":9,"length":7},"hint":"ノードの 1 行目の文字を、先頭から書きます (装飾とタグは除いた文字)"},{"severity":"error","code":"relation-syntax","message":"「Missing & (Root)/* --> 設計」: 括弧と /* は組み合わせられません: (Root)/*","at":{"line":10,"column":19,"length":8},"hint":"枝の枠でまとめるか配下に展開するかの、どちらかにします"},{"severity":"warning","code":"not-supported","message":"(X) の枝の枠は未対応です。X 自身から線を出します","at":{"line":11,"column":11,"length":17},"hint":null},{"severity":"error","code":"selector-empty","message":"「設計 --> 実装/API/*」: 「実装/API/*」は、配下にノードがないので展開できません","at":{"line":12,"column":18,"length":6},"hint":"このノード自身を指すなら、末尾の /* を外します"},{"severity":"error","code":"relation-syntax","message":"「 --> 設計」: 参照が空です: ","at":{"line":13,"column":14,"length":9},"hint":null}]}"##;

    const D2_SOURCE: &str = r##"---
markdag:
  groups:
    b:
      label: B群
      color: "#f00"
      boundary: true
      members: [設計, (実装), 実, 7]
    g2:
      members:
        - テスト/**
    a: {}
  branches:
    - 設計
    - $impl
    - 実装
    - 実装
    - 設計/*
    - テ
    - Missing
  rules:
    taskToggle:
      readonlyGroups: [1, bb, zz]
---
# Root
## 設計 %c
### 画面 %a
## 実装 $impl
### 画面
## テスト %c
### 項目 %b
"##;
    // node の buildModel の出力 (hooks を除く): {"hooks": [{"ref": "markdag.rules", "exports": ["beforeTaskToggle"]}], "options": {}}
    const D2_MODEL: &str = r##"{"detailsMode":null,"legend":["groups","branches"],"legendPosition":"top-right","edgeHighlight":true,"groupHighlight":true,"branches":[2,4,6],"relations":[],"suppressRootLine":[],"groups":[{"id":"b","label":"B群","color":"#f00","boundary":true,"defined":true},{"id":"g2","label":"g2","color":null,"boundary":false,"defined":true},{"id":"a","label":"a","color":null,"boundary":false,"defined":true},{"id":"c","label":"c","color":null,"boundary":false,"defined":false}],"groupsOf":[[1,[]],[2,["b","c"]],[3,["b","a","c"]],[4,["b"]],[5,["b"]],[6,["g2","c"]],[7,["b","g2","c"]]],"tagDisplay":"always","tagsOf":[[1,[]],[2,[]],[3,[]],[4,[]],[5,[]],[6,[]],[7,[]]],"tagKeys":[],"taskCycle":[" ","x"],"taskDim":{"states":[],"details":"keep","tags":"keep"},"diagnostics":[{"severity":"warning","code":"group-invalid","message":"markdag.groups.b.members[3] は文字列で書きます (7)","at":{"line":8,"column":30,"length":1},"hint":"ノードの 1 行目の文字を、先頭から書きます (装飾とタグは除いた文字)"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[3] は前にも書かれています (\"実装\")","at":{"line":17,"column":7,"length":2},"hint":"同じ行が 2 回あります。重なった行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.rules.taskToggle.readonlyGroups[0] は文字列で書きます (1)","at":{"line":23,"column":24,"length":1},"hint":"本文の %名前 や markdag.groups のキーと同じ名前を、% なしで書きます"},{"severity":"warning","code":"group-invalid","message":"markdag.groups.b.members「(実装)」: members に (X) は書けません","at":{"line":8,"column":21,"length":4},"hint":"括弧を外して書きます"},{"severity":"info","code":"ref-prefix","message":"markdag.groups.b.members: 「実」は前方一致で「実装」に解決しました","at":{"line":8,"column":27,"length":1},"hint":"書き間違いなら「実装」に直します"},{"severity":"warning","code":"option-invalid","message":"markdag.rules.taskToggle.readonlyGroups: グループ「bb」は、この文書のどのノードにも付いていません","at":{"line":23,"column":24,"length":1},"hint":"もしかして「b」"},{"severity":"warning","code":"option-invalid","message":"markdag.rules.taskToggle.readonlyGroups: グループ「zz」は、この文書のどのノードにも付いていません","at":{"line":23,"column":27,"length":2},"hint":"本文で %名前 を付けるか、markdag.groups に定義します"},{"severity":"warning","code":"option-invalid","message":"markdag.branches: 「実装」は「$impl」と同じノードで、すでに枝の起点になっています","at":{"line":16,"column":7,"length":2},"hint":"この行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches: 「実装」は「$impl」と同じノードで、すでに枝の起点になっています","at":{"line":17,"column":7,"length":2},"hint":"この行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches: 「設計/*」は 1 ノードの指定ではありません。枝の起点は 1 ノードで指定します ((X), /*, /** は使えません)","at":{"line":18,"column":7,"length":4},"hint":"配下をまとめて 1 色にするなら「設計」だけを書きます (配下は起点の色を引き継ぎます)"},{"severity":"info","code":"ref-prefix","message":"markdag.branches: 「テ」は前方一致で「テスト」に解決しました","at":{"line":19,"column":7,"length":1},"hint":"書き間違いなら「テスト」に直します"},{"severity":"warning","code":"ref-not-found","message":"markdag.branches: 「Missing」に一致するノードがありません","at":{"line":20,"column":7,"length":7},"hint":"ノードの 1 行目の文字を、先頭から書きます (装飾とタグは除いた文字)"}]}"##;

    const D3_SOURCE: &str = r##"---
markdag:
  types:
    $ref: [1, ./missing.yaml, ./null.yaml, ./ok.yaml]
    size: { type: enum, values: [S, M] }
  tags:
    display: hover
    lint: error
    unknownKey: deny
    keys:
      size: size
      owner: { type: fromOk }
  tasks:
    cycle: ['x']
    dim: ['x', '-', 'x', 'q']
  details:
    display: click
  legend:
    display: [branches, nope]
    position: bottom-left
  edgeHighlight: "false"
  groupHighlight: false
---
# Root
## A #size:L #owner:me #who:x
- [x] done
"##;
    // node の buildModel の出力 (hooks を除く): {"hooks": [], "options": {}}
    const D3_MODEL: &str = r##"{"detailsMode":"click","legend":["branches"],"legendPosition":"bottom-left","edgeHighlight":true,"groupHighlight":false,"branches":[],"relations":[],"suppressRootLine":[],"groups":[],"groupsOf":[[1,[]],[2,[]],[3,[]]],"tagDisplay":"hover","tagsOf":[[1,[]],[2,[{"key":"size","values":["L"],"at":{"line":25,"column":6,"length":7}},{"key":"owner","values":["me"],"at":{"line":25,"column":14,"length":9}},{"key":"who","values":["x"],"at":{"line":25,"column":24,"length":6}}]],[3,[]]],"tagKeys":[{"key":"size","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"owner","alternatives":[],"multiple":false,"unique":false,"description":null}],"taskCycle":[" ","x"],"taskDim":{"states":["done","canceled"],"details":"keep","tags":"keep"},"diagnostics":[{"severity":"warning","code":"type-invalid","message":"markdag.types.$ref[0] は文字列で書きます (1)","at":{"line":4,"column":12,"length":1},"hint":"「./types.yaml」のように、文書からの相対パスを文字列で書きます"},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.size はキーと値の組で書きます (\"size\")","at":{"line":11,"column":13,"length":4},"hint":"タグのキーの下に type と制約、multiple, unique, description を字下げして書きます"},{"severity":"warning","code":"option-invalid","message":"markdag.tasks.dim[2] は前にも書かれています (\"x\")","at":{"line":15,"column":21,"length":3},"hint":"同じ行が 2 回あります。重なった行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.tasks.dim[3] に指定できるのは  , /, x, - です (\"q\")","at":{"line":15,"column":26,"length":3},"hint":"もしかして「 」"},{"severity":"warning","code":"option-invalid","message":"markdag.legend.display[1] に指定できるのは groups, branches です (\"nope\")","at":{"line":19,"column":25,"length":4},"hint":"凡例に出せるのは groups と branches です"},{"severity":"warning","code":"option-invalid","message":"markdag.edgeHighlight は真偽値で書きます (\"false\")","at":{"line":21,"column":18,"length":7},"hint":"使わないなら false と書きます。yes は YAML では文字列になります"},{"severity":"warning","code":"types-unresolved","message":"markdag.types.$ref「./missing.yaml」を読めなかったので、その中の型は使えません (その型を使うキーは検査しません)","at":{"line":4,"column":12,"length":1},"hint":"呼び出し側が読んで buildModel の types に渡します (npm run check は文書の場所からの相対で読みます)"},{"severity":"warning","code":"types-unresolved","message":"markdag.types.$ref「./null.yaml」を読めなかったので、その中の型は使えません (その型を使うキーは検査しません)","at":{"line":4,"column":15,"length":14},"hint":"ファイルが YAML のキーと値の組として読めるか確かめます"},{"severity":"error","code":"tag-unknown-key","message":"「A」の #who:x は、markdag.tags.keys に定義のないキーです","at":{"line":25,"column":24,"length":6},"hint":"keys に定義するか、unknownKey を allow にします"},{"severity":"warning","code":"option-invalid","message":"markdag.tasks.cycle: クリックで進む順は、記号を 2 つ以上並べます","at":{"line":14,"column":5,"length":12},"hint":"未完了と完了の行き来なら書かずに済みます。作業中を挟むなら [' ', '/', 'x'] と書きます"}]}"##;

    const D4_SOURCE: &str = r##"---
markdag:
  types:
    $ref: ./missing.yaml
  tasks:
    dim: { states: ['/'], details: never, tags: bogus }
  legend:
    display: false
  hooks:
    $ref: [./a.js, ./b.js, ./c.js]
    options: { k: 1 }
---
# Root
## A
"##;
    // node の buildModel の出力 (hooks を除く): {"hooks": [{"ref": "./a.js", "exports": ["beforeFold"]}], "options": {"k": 1}}
    const D4_MODEL: &str = r##"{"detailsMode":null,"legend":[],"legendPosition":"top-right","edgeHighlight":true,"groupHighlight":true,"branches":[],"relations":[],"suppressRootLine":[],"groups":[],"groupsOf":[[1,[]],[2,[]]],"tagDisplay":"always","tagsOf":[[1,[]],[2,[]]],"tagKeys":[],"taskCycle":[" ","x"],"taskDim":{"states":["doing"],"details":"never","tags":"keep"},"diagnostics":[{"severity":"warning","code":"option-invalid","message":"markdag.tasks.dim.tags に指定できるのは keep, hover, click, never です (\"bogus\")","at":{"line":6,"column":49,"length":5},"hint":"keep, hover, click, never のどれかを書きます"},{"severity":"warning","code":"types-unresolved","message":"markdag.types.$ref「./missing.yaml」を読めなかったので、その中の型は使えません (その型を使うキーは検査しません)","at":{"line":4,"column":11,"length":14},"hint":"呼び出し側が読んで buildModel の types に渡します (npm run check は文書の場所からの相対で読みます)"},{"severity":"warning","code":"hooks-unresolved","message":"markdag.hooks.$ref「./b.js」は読み込まれていないので、このフックは動きません","at":{"line":10,"column":20,"length":6},"hint":"モジュールとして読めるか (名前付きの export があるか) 確かめます"},{"severity":"warning","code":"hooks-unresolved","message":"markdag.hooks.$ref「./c.js」は読み込まれていないので、このフックは動きません","at":{"line":10,"column":28,"length":6},"hint":"呼び出し側が import して render の hookRefs に渡します (信頼できる文書のときだけ)"}]}"##;
    fn types_option() -> IndexMap<String, JsValue> {
        let ok: JsValue =
            serde_json::from_str(r#"{ "fromOk": { "type": "string" } }"#).expect("テストの JSON");
        IndexMap::from([
            ("./null.yaml".to_string(), JsValue::Null),
            ("./ok.yaml".to_string(), ok),
        ])
    }

    fn built(source: &str, hook_refs: Option<HookSpec>) -> GraphModel {
        let parsed = crate::parse::parse_document(source);
        build_model(
            &parsed.nodes,
            &parsed.frontmatter,
            Some(source),
            &ModelOptions {
                types: Some(types_option()),
                hook_refs,
            },
        )
    }

    fn without_hooks(model: &GraphModel) -> serde_json::Value {
        let mut value = serde_json::to_value(model).expect("GraphModel は JSON に書ける");
        if let Some(entries) = value.as_object_mut() {
            entries.shift_remove("hooks");
        }
        value
    }

    fn assert_model(source: &str, hook_refs: Option<HookSpec>, expected: &str) -> GraphModel {
        let model = built(source, hook_refs);
        let expected: serde_json::Value = serde_json::from_str(expected).expect("期待値の JSON");
        let actual = without_hooks(&model);
        // 差の見やすさのために diagnostics を 1 件ずつ先に比べる
        let wanted = expected["diagnostics"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let got = actual["diagnostics"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for (index, (want, got)) in wanted.iter().zip(got.iter()).enumerate() {
            assert_eq!(got, want, "diagnostics[{index}]");
        }
        assert_eq!(got.len(), wanted.len(), "diagnostics の件数");
        assert_eq!(actual, expected);
        model
    }

    #[test]
    fn build_model_relations_cycles_and_selector_errors() {
        // self-loop、duplicate-edge、ref-ambiguous、ref-prefix (2 件は finally の順)、項をまたがない ref-not-found と
        // 同じ項の中の relation-syntax (規則 2.3 の段ごとの collect)、not-supported は 1 度だけ、selector-empty、
        // 空の参照の relation-syntax (ref は空文字なので place は式の全体を指す)、知らない種類の bogus は読まない
        let model = assert_model(D1_SOURCE, None, D1_MODEL);
        assert_eq!(
            model.hooks,
            ModelHooks {
                declared: vec![],
                options: JsValue::Object(IndexMap::new()),
                rules: None
            }
        );
    }

    #[test]
    fn build_model_groups_branches_and_rules() {
        // members の (X) は group-invalid、前方一致の members、定義のないグループの順と継承、branches の重複 (別の表記で
        // 同じノードを指す $impl と 実装 は警告。2 つ目の 実装 も 1 つ目が警告で登録されないので同じ警告)、
        // scope が self でない指定、rules の readonlyGroups の closest と filter 後の添字。
        // 同じ表記の 2 度目が成功する経路 (try の中の continue) は build_model_branches_same_spelling_skips_to_finally
        let model = assert_model(D2_SOURCE, None, D2_MODEL);
        assert_eq!(
            model.hooks.rules,
            Some(RulesConfig {
                require_upstream_done: false,
                readonly_groups: vec!["bb".to_string(), "zz".to_string()],
                keep_milestones_open: false,
            })
        );
        assert!(model.hooks.declared.is_empty());
    }

    const D5_SOURCE: &str = r##"---
markdag:
  branches:
    - 実装
    - テ
    - 実装
    - テ
---
# Root
## 設計
## 実装
## テスト
"##;
    // node の buildModel の出力 (hooks を除く): {"hooks": [], "options": {}}。nodes は D5_SOURCE の見出しと同じ 4 件を手で組んで渡した
    const D5_MODEL: &str = r##"{"detailsMode":null,"legend":["groups","branches"],"legendPosition":"top-right","edgeHighlight":true,"groupHighlight":true,"branches":[3,4],"relations":[],"suppressRootLine":[],"groups":[],"groupsOf":[[1,[]],[2,[]],[3,[]],[4,[]]],"tagDisplay":"always","tagsOf":[[1,[]],[2,[]],[3,[]],[4,[]]],"tagKeys":[],"taskCycle":[" ","x"],"taskDim":{"states":[],"details":"keep","tags":"keep"},"diagnostics":[{"severity":"warning","code":"option-invalid","message":"markdag.branches[2] は前にも書かれています (\"実装\")","at":{"line":6,"column":7,"length":2},"hint":"同じ行が 2 回あります。重なった行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[3] は前にも書かれています (\"テ\")","at":{"line":7,"column":7,"length":1},"hint":"同じ行が 2 回あります。重なった行は消せます"},{"severity":"info","code":"ref-prefix","message":"markdag.branches: 「テ」は前方一致で「テスト」に解決しました","at":{"line":5,"column":7,"length":1},"hint":"書き間違いなら「テスト」に直します"},{"severity":"info","code":"ref-prefix","message":"markdag.branches: 「テ」は前方一致で「テスト」に解決しました","at":{"line":7,"column":7,"length":1},"hint":"書き間違いなら「テスト」に直します"}]}"##;

    #[test]
    fn build_model_branches_same_spelling_skips_to_finally() {
        // 同じ表記の 2 度目は解決に成功し、try の中の continue で登録を飛ばす (branches は [3, 4] のまま、model 層の警告なし。
        // 重複の警告はスキーマの 2 件だけ)。finally は通るので、2 度目の テ の前方一致の info も 2 件目として出る
        assert_model(D5_SOURCE, None, D5_MODEL);
    }

    const NUMERIC_GROUPS_SOURCE: &str =
        include_str!("../../../../testdata/judge/corpus/edge-numeric-group-keys.md");

    // 決定 8 (a) の並び: groups は YAML に書かれた順 (007 は 7、1.0 は 1 のキー)。旧実装は整数に見えるキーを先頭へ並べて
    // [1, 7, 2024, b, a]。groupsOf も同じ order で並べる。要素と各値は審判の期待値と同じ
    fn assert_numeric_groups_in_written_order(model: &GraphModel) {
        let group = |id: &str, label: &str| GroupDef {
            id: id.to_string(),
            label: label.to_string(),
            color: None,
            boundary: false,
            defined: true,
        };
        assert_eq!(
            model.groups,
            vec![
                group("b", "B"),
                group("2024", "年"),
                group("a", "A"),
                group("7", "七"),
                group("1", "一点零")
            ]
        );
        let names = |list: &[&str]| {
            list.iter()
                .map(|name| name.to_string())
                .collect::<Vec<String>>()
        };
        assert_eq!(
            model.groups_of,
            IndexMap::from([
                (1, names(&[])),
                (2, names(&["b", "1"])),
                (3, names(&["2024", "a"])),
                (4, names(&["7"]))
            ])
        );
        assert_eq!(model.diagnostics, Vec::new());
    }

    #[test]
    fn build_model_numeric_group_keys_follow_written_order() {
        // nodes は解析の層から取り、frontmatter は同じ文書の YAML を書かれた順のまま組む
        // (解析の層を通す形は下の parse_then_build_model_numeric_group_keys_follow_written_order)
        let parsed = crate::parse::parse_document(NUMERIC_GROUPS_SOURCE);
        let frontmatter: JsValue = serde_json::from_str(
            r#"{ "markdag": { "groups": {
                "b": { "label": "B" },
                "2024": { "label": "年", "members": ["Two"] },
                "a": { "label": "A" },
                "7": { "label": "七", "members": ["Seven"] },
                "1": { "label": "一点零", "members": ["One"] }
            } } }"#,
        )
        .expect("テストの JSON");
        let model = build_model(
            &parsed.nodes,
            &frontmatter,
            Some(NUMERIC_GROUPS_SOURCE),
            &ModelOptions::default(),
        );
        assert_numeric_groups_in_written_order(&model);
    }

    #[test]
    fn parse_then_build_model_numeric_group_keys_follow_written_order() {
        assert_numeric_groups_in_written_order(&built(NUMERIC_GROUPS_SOURCE, None));
    }

    #[test]
    fn build_model_types_tags_tasks_and_legend() {
        // $ref の filter 後の添字 (filter 後の添字の欠陥の再現: ./missing.yaml の types-unresolved が $ref[0] の 1 を指す)、
        // Null と渡していないものの hint の違い、tags の lint と unknownKey、tasks.cycle の長さ、dim の配列の形、
        // legend の一覧と位置、`edgeHighlight: "false"` は真のまま
        assert_model(D3_SOURCE, None, D3_MODEL);
    }

    #[test]
    fn build_model_hooks_and_dim_object() {
        let spec = HookSpec::from([
            (
                "./a.js".to_string(),
                HookSpecEntry::Module {
                    exports: vec![("beforeFold".to_string(), true), ("x".to_string(), false)],
                },
            ),
            ("./b.js".to_string(), HookSpecEntry::Invalid),
        ]);
        let model = assert_model(D4_SOURCE, Some(spec), D4_MODEL);
        let options: JsValue = serde_json::from_str(r#"{ "k": 1 }"#).expect("テストの JSON");
        assert_eq!(
            model.hooks,
            ModelHooks {
                declared: vec![DeclaredHook {
                    ref_text: "./a.js".to_string(),
                    exports: vec!["beforeFold".to_string()]
                }],
                options,
                rules: None,
            }
        );
    }

    #[test]
    fn build_model_without_markdown_and_with_non_record_frontmatter() {
        // 原文なしでは位置が付かない。frontmatter が写像でなければ markdag の指定はないものとして既定の値になる
        let nodes = tree();
        let model = build_model(
            &nodes,
            &JsValue::String("x".to_string()),
            None,
            &ModelOptions::default(),
        );
        assert_eq!(model.task_cycle, DEFAULT_TASK_CYCLE.to_vec());
        assert_eq!(model.legend, DEFAULT_LEGEND.to_vec());
        assert_eq!(model.legend_position, LegendPosition::TopRight);
        assert_eq!(model.tag_display, TagDisplayMode::Always);
        assert!(model.edge_highlight && model.group_highlight);
        assert_eq!(model.groups_of.len(), nodes.len());
        let frontmatter: JsValue =
            serde_json::from_str(r#"{ "markdag": { "relations": { "chain": ["$100 plan --> (注)x", "設計 --> Root"] } } }"#)
                .expect("テストの JSON");
        let model = build_model(&nodes, &frontmatter, None, &ModelOptions::default());
        assert_eq!(model.relations.len(), 1);
        assert_eq!(model.suppress_root_line, vec![10]);
        let cycle = model
            .diagnostics
            .iter()
            .find(|d| d.code == "cycle")
            .expect("閉路の診断");
        assert_eq!(cycle.message, "閉路になるので追加しません: 設計 --> Root");
        assert_eq!(cycle.at, None);
        // 空の refText (id 12) は #12 で名前を付ける。期待値は node の buildModel (同じ nodes、原文なし) で取った
        let frontmatter: JsValue = serde_json::from_str(
            r#"{ "markdag": { "relations": { "chain": ["Root --> Root/*"] } } }"#,
        )
        .expect("テストの JSON");
        let model = build_model(&nodes, &frontmatter, None, &ModelOptions::default());
        let targets: Vec<u32> = model
            .relations
            .iter()
            .map(|relation| relation.target)
            .collect();
        assert_eq!(targets, vec![3, 4, 6, 13]);
        let duplicates: Vec<&str> = model
            .diagnostics
            .iter()
            .filter(|d| d.code == "duplicate-edge")
            .map(|d| d.message.as_str())
            .collect();
        assert_eq!(
            duplicates,
            vec![
                "同じ線がすでにあります: Root --> テスト",
                "同じ線がすでにあります: Root --> A/B",
                "同じ線がすでにあります: Root --> (注)x",
                "同じ線がすでにあります: Root --> $100 plan",
                "同じ線がすでにあります: Root --> #12",
                "同じ線がすでにあります: Root --> Ca\u{301}fe  au\tlait",
                "同じ線がすでにあります: Root --> Caf\u{e9}",
            ]
        );
        assert_eq!(
            model.diagnostics.len(),
            8,
            "shape-mismatch 1 件と duplicate-edge 7 件"
        );
        assert_eq!(model.diagnostics[0].code, "shape-mismatch");
    }

    #[test]
    fn reaches_follows_successors_depth_first() {
        let successors: IndexMap<u32, Vec<u32>> =
            IndexMap::from([(1, vec![2, 3]), (2, vec![4]), (3, vec![]), (4, vec![1])]);
        assert!(reaches(&successors, 1, 4));
        assert!(reaches(&successors, 4, 3));
        assert!(reaches(&successors, 3, 3));
        assert!(!reaches(&successors, 3, 1));
        assert!(!reaches(&successors, 9, 1));
    }

    #[test]
    fn selector_error_display_is_message() {
        assert_eq!(err("ref-not-found", "文面", "x", None).to_string(), "文面");
    }
}

// PORT STATUS: confidence=high todos=0
