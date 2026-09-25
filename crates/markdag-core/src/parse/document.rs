// 原文: src/parse/document.ts (2026-09-24) と sample/markmap/packages/markmap-lib/src/plugins/frontmatter/index.ts (frontmatter の切り出しと markmap のオプションの正規化)
// markdag の前処理と組み立て。原文の行を書き換える前処理 (大文字の [X]、行末の %グループ #タグ $id) を行ってから
// 本文を AST にし、アウトラインの木を先行順にたどって OutlineNode の列にする。タスクの状態、記号の絵、詳細 (引用ブロック)、
// 参照用の 1 行目の文字とマイルストーンもここで決める。行数と桁は前処理で変えないので、行番号は原文のものとして使える。
//
// 前半は前処理 (大文字の記号、注釈) と frontmatter の読み取り、後半はノードごとの仕上げ (タスク、記号の絵、詳細、1 行目) と組み立て。
// 原文の lineRange (data-lines の文字を読む) は写さない: 行の範囲はアウトラインの木が数で持つ (台帳 99 行)。
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use comrak::Arena;
use indexmap::IndexMap;
use regex::{NoExpand, Regex};
use saphyr_parser::{Event as YamlEvent, Parser, ScalarStyle};
use unicode_normalization::UnicodeNormalization;

use super::html::{MARKED, UNMARKED};
use super::outline::{BlockTag, ContentPart, OutlineTree, build_outline};
use super::task::{TaskLineKind, task_mark_at, task_mark_of, task_state_of};
use crate::model::locator::SaphyrInput;
use crate::model::util::{
    JS_WHITESPACE, JsValue, js_json_stringify, js_number_to_string, js_slice, js_to_number,
    js_to_string, js_trim, js_trim_end, scalar_value, to_u32,
};
use crate::types::{
    NodeTag, OutlineNode, ParsedDocument, SourcePosition, TaskIcons, TaskInfo, TaskMark, TaskState,
};

// ==== 本番の前半: 前処理と注釈 (document.ts:89-176) と frontmatter (document.ts:272-277、markmap-lib の frontmatter プラグイン) ====

// 規則 2.4: JS の \s は JS_WHITESPACE の文字クラス、\S はその否定 (Rust の \s は U+FEFF を含まず U+0085 を含む)
fn js_whitespace_class() -> String {
    JS_WHITESPACE
        .iter()
        .map(|c| format!("\\x{{{:X}}}", u32::from(*c)))
        .collect()
}

// 規則 1 章 (A-021): 定数の正規表現は LazyLock と expect。規則 2.4: [\s\S] は (?s:.)、\d は [0-9]
static FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n(?s:.)*?\n---\r?\n").expect("固定の正規表現"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^#{{1,6}}[ \t]+[^{}]", js_whitespace_class())).expect("固定の正規表現")
});
static LIST_ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[ \t]*(?:[-*+]|[0-9]+[.)])[ \t]+[^{}]",
        js_whitespace_class()
    ))
    .expect("固定の正規表現")
});
static FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*(```|~~~)").expect("固定の正規表現"));
// 大文字で書かれた完了の記号と、その前に置かれた行頭の記号 (リストの記号か、見出しの #)
// 規則 2.4: 先読みを含むので regress に固定し、原文の文字のまま組む (ECMAScript の意味、フラグなし。\d は ASCII)
static UPPER_MARK: LazyLock<regress::Regex> = LazyLock::new(|| {
    regress::Regex::new(r"^([ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|#{1,6}[ \t]+)?)\[X\](?=[ \t])")
        .expect("固定の正規表現")
});
static SETEXT_UNDERLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]{0,3}(?:=+|-+)[ \t]*\r?$").expect("固定の正規表現"));
// 行末の印。`%名前` はグループ、`#キー` と `#キー:値` はタグ (値は " で囲めば空白を含められる)、`$名前` は id。
// 規則 2.4: \p{L} と \p{N} はそのまま (regex の Unicode の表。node 22 の Unicode 16.0 と全コードポイントで一致を確かめた)、
// `[^\s"]` の \s は JS_WHITESPACE (全角空白で値が切れる挙動を守る)
static TRAILING_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"[ \t]+(%[\p{{L}}\p{{N}}_-]+|#[\p{{L}}\p{{N}}_-]+(?::(?:"[^"]*"|[^{}"]+))?|\$[A-Za-z][A-Za-z0-9_-]*)[ \t]*$"#,
        js_whitespace_class()
    ))
    .expect("固定の正規表現")
});
// 規則 2.4: JS の \d は ASCII の数字だけ (全角数字や ① は印になる)
static DIGITS_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+$").expect("固定の正規表現"));
// markmap-lib の frontmatter プラグインの切り出し (開きは文書の先頭、閉じは文書の先頭から探した最初のもの)
static FRONTMATTER_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n").expect("固定の正規表現"));
static FRONTMATTER_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n---\r?\n").expect("固定の正規表現"));
static LINE_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\r?\n|\r").expect("固定の正規表現"));

/// 行ごとの注釈 (原文の LineAnnotation。document.ts の内部の型)
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct LineAnnotation {
    pub(super) groups: Vec<String>,
    pub(super) tags: Vec<NodeTag>,
    pub(super) ref_id: Option<String>,
}

/// stripAnnotations の戻り値 (名前のない型。規則 4 章「関数名 + Result」)
#[derive(Debug, Clone, PartialEq)]
pub(super) struct StripAnnotationsResult {
    pub(super) text: String,
    // 規則 2.3: Map<number, LineAnnotation> は IndexMap (キーは 0 始まりの行の添字)
    pub(super) annotations: IndexMap<usize, LineAnnotation>,
}

// `s.slice(1)`。呼ぶ側の先頭の字は印 (`#` `%` `$`) で ASCII なので、UTF-16 の 1 単位と 1 字は同じ
fn without_first_char(text: &str) -> &str {
    let mut chars = text.chars();
    chars.next();
    chars.as_str()
}

/// 原文: parseTag
/// `#キー:値` のトークンをタグにする。値は , で区切って複数にし、" で囲んだ値は区切らずそのまま 1 つの値にする
pub(super) fn parse_tag(token: &str, at: SourcePosition) -> NodeTag {
    // 規則 2.2: indexOf は find。見つからなければ値なし
    let Some((head, raw)) = token.split_once(':') else {
        return NodeTag {
            key: without_first_char(token).to_string(),
            values: Vec::new(),
            at,
        };
    };
    let values = if raw.starts_with('"') {
        // `raw.slice(1, -1)`: 先頭と末尾の 1 字を落とす。1 字しかなければ空 (TRAILING_TOKEN から来る値は " で閉じている)
        let mut chars = raw.chars();
        chars.next();
        chars.next_back();
        vec![chars.as_str().to_string()]
    } else {
        // 規則 2.2: split(',') のあと空を除く
        raw.split(',')
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect()
    };
    NodeTag {
        key: without_first_char(head).to_string(),
        values,
        at,
    }
}

/// 原文: mergeTags
/// 同じキーを 1 行に 2 回書いたら、値をつなげて 1 つにする (書かれた順。位置は最初のもの)
pub(super) fn merge_tags(tags: Vec<NodeTag>) -> Vec<NodeTag> {
    let mut merged: Vec<NodeTag> = Vec::new();
    for tag in tags {
        // 規則 2.3 (台帳の mergeTags の行): 最初の同じ key に extend、なければ写しを push
        if let Some(known) = merged.iter_mut().find(|item| item.key == tag.key) {
            known.values.extend(tag.values);
        } else {
            merged.push(tag);
        }
    }
    merged
}

/// 原文: rewriteBodyLines
/// 本文の行 (frontmatter とコードブロックの中を除く) を、1 行ずつ書き換える。行数は変えない
pub(super) fn rewrite_body_lines(
    source: &str,
    mut rewrite: impl FnMut(&str, usize, &[&str]) -> String,
) -> String {
    // `(FRONTMATTER.exec(source)?.[0].split('\n').length ?? 1) - 1` は一致した文字列の '\n' の数 (一致しなければ 0)
    let frontmatter_lines = FRONTMATTER
        .find(source)
        .map_or(0, |found| found.as_str().matches('\n').count());
    let lines: Vec<&str> = source.split('\n').collect();
    let mut in_fence = false;
    let mut rewritten: Vec<String> = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        if index < frontmatter_lines {
            rewritten.push((*line).to_string());
            continue;
        }
        // 台帳: フェンスの種類も長さも見ずに反転する (旧実装の癖。~~~ と ``` を区別しない)
        if FENCE.is_match(line) {
            in_fence = !in_fence;
        }
        rewritten.push(if in_fence {
            (*line).to_string()
        } else {
            rewrite(line, index, &lines)
        });
    }
    rewritten.join("\n")
}

/// 原文: normalizeTaskMarks
/// 完了の記号の大文字 (`[X]`) を、小文字にそろえる。変換器が絵にするのは小文字だけで、大文字は文字のまま残るため。
/// 文字数も行数も変えない
pub(super) fn normalize_task_marks(source: &str) -> String {
    rewrite_body_lines(source, |line, index, lines| {
        let Some(found) = UPPER_MARK.find(line) else {
            return line.to_string();
        };
        // 規則 2.1: `match[1] ?? ''` と `lines[index + 1] ?? ''` は None を空文字に
        let prefix = found
            .group(1)
            .and_then(|range| line.get(range))
            .unwrap_or("");
        let next = lines.get(index + 1).copied().unwrap_or("");
        // 行頭の記号がない行は、下線で書く見出し (次の行が === か ---) のときだけがタスク
        if js_trim(prefix).is_empty() && !SETEXT_UNDERLINE.is_match(next) {
            return line.to_string();
        }
        // 規則 2.2: g なしの replace は最初の 1 か所
        line.replacen("[X]", "[x]", 1)
    })
}

/// 原文: stripAnnotations
/// 見出しとリスト項目の 1 行目の末尾から、`%グループ`、`#タグ`、`$id` を取り除く。行数は変えない。
/// 1 行目がブロックの書き始めに見える行でも印は読む (A-219。1 行目は文字として読むので、印を取っても形は変わらない)
pub(super) fn strip_annotations(source: &str) -> StripAnnotationsResult {
    let mut annotations: IndexMap<usize, LineAnnotation> = IndexMap::new();
    let text = rewrite_body_lines(source, |line, index, _| {
        if !(HEADING.is_match(line) || LIST_ITEM.is_match(line)) {
            return line.to_string();
        }

        let mut annotation = LineAnnotation::default();
        // 改行が CRLF の文書では、行の終わりに \r が残る。末尾の照合の邪魔になるので外しておき、最後に戻す
        let carriage = if line.ends_with('\r') { "\r" } else { "" };
        let mut rest = line.strip_suffix('\r').unwrap_or(line);
        while let Some(captures) = TRAILING_TOKEN.captures(rest) {
            let (Some(whole), Some(token_match)) = (captures.get(0), captures.get(1)) else {
                // TODO(port): Rust 側の不到達 (一致すれば 0 番と 1 番の組は必ずある)
                break;
            };
            let token = token_match.as_str();
            let sigil = token.chars().next();
            let name = without_first_char(token)
                .split(':')
                .next()
                .unwrap_or_default();
            // 数字だけの名前 (Issue #123、%50 など) は印にしない。$id は 1 つまで
            if sigil != Some('$') && DIGITS_ONLY.is_match(name) {
                break;
            }
            if sigil == Some('$') && annotation.ref_id.is_some() {
                break;
            }
            // 末尾から順に取るので、先頭に足して書かれた順にそろえる
            match sigil {
                Some('%') => annotation
                    .groups
                    .insert(0, without_first_char(token).to_string()),
                Some('#') => {
                    // 診断が本文の行を指せるよう、印の位置を残す (行は 1 始まり、桁は文字数で数える)。
                    // `match.index + match[0].indexOf(token)` は 1 番の組の開始 (前の [ \t]+ は印の字を含まない)。
                    // 規則 2.2: 添字は rest の中のバイト、桁と長さはコードポイント
                    let start = token_match.start();
                    let column = js_slice(rest, 0, start).chars().count() + 1;
                    let at = SourcePosition {
                        line: to_u32(index + 1),
                        column: to_u32(column),
                        length: to_u32(token.chars().count()),
                    };
                    annotation.tags.insert(0, parse_tag(token, at));
                }
                _ => annotation.ref_id = Some(without_first_char(token).to_string()),
            }
            rest = js_slice(rest, 0, whole.start());
        }
        annotation.tags = merge_tags(std::mem::take(&mut annotation.tags));
        if !annotation.groups.is_empty()
            || !annotation.tags.is_empty()
            || annotation.ref_id.is_some()
        {
            annotations.insert(index, annotation);
        }
        format!("{rest}{carriage}")
    });
    StripAnnotationsResult { text, annotations }
}

/// markmap-lib の frontmatter プラグインが context に残すもの (context.frontmatter と context.frontmatterInfo)
#[derive(Debug, Clone, PartialEq)]
pub(super) struct FrontmatterInfo {
    /// 読めた値。空の YAML は null (原文の parse の戻り値)
    pub(super) value: JsValue,
    /// 本文の行番号に足す行数 (閉じの行まで)
    pub(super) lines: usize,
    /// 本文の始まりのバイト位置
    pub(super) offset: usize,
}

/// 原文: markmap-lib の frontmatter プラグインの beforeParse (名前のない関数)
/// `---` で始まる文書の、最初の `\n---` の行までを YAML として読む。読めなければ None で、本文から切り取らない
/// (frontmatter の文字が本文に残る)。読めたら markmap の欄を normalizeMarkmapJsonOptions で直す
pub(super) fn read_frontmatter(content: &str) -> Option<FrontmatterInfo> {
    if !FRONTMATTER_OPEN.is_match(content) {
        return None;
    }
    let close = FRONTMATTER_CLOSE.find(content)?;
    // 規則 2.2: `content.slice(4, match.index)` は a > b なら空 (`---\n---\n` では閉じが 3 から始まる)
    let raw = js_trim_end(js_slice(content, 4, close.start()));
    // 規則 2.5: yaml の parse が throw する入力は、markmap が catch して frontmatter なしにする
    let mut value = yaml_parse(&LINE_BREAK.replace_all(raw, "\n")).ok()?;
    // `if (frontmatter?.markmap)`: 写像のときだけ欄を書き換える (文字列や数の markmap は欄の読み書きが何も変えない)
    if let JsValue::Object(map) = &mut value
        && let Some(JsValue::Object(markmap)) = map.get_mut("markmap")
    {
        normalize_markmap_json_options(markmap);
    }
    Some(FrontmatterInfo {
        value,
        lines: js_slice(content, 0, close.start()).split('\n').count() + 1,
        offset: close.end(),
    })
}

/// 原文: markmap-lib の normalizeMarkmapJsonOptions
/// 値のある (null でも undefined でもない) 欄だけを直す。直せない値は欄を残して undefined にする (model 層が「値なし」の警告にする)
fn normalize_markmap_json_options(options: &mut IndexMap<String, JsValue>) {
    for key in ["color", "extraJs", "extraCss"] {
        if let Some(value) = options.get_mut(key)
            && !matches!(value, JsValue::Null | JsValue::Undefined)
        {
            *value = normalize_string_array(value);
        }
    }
    for key in ["duration", "maxWidth", "initialExpandLevel"] {
        if let Some(value) = options.get_mut(key)
            && !matches!(value, JsValue::Null | JsValue::Undefined)
        {
            *value = normalize_number(value);
        }
    }
}

/// 原文: markmap-lib の normalizeStringArray
fn normalize_string_array(value: &JsValue) -> JsValue {
    let result: Vec<JsValue> = match value {
        JsValue::String(text) => vec![JsValue::String(text.clone())],
        // `item && typeof item === 'string'`: 空でない文字列だけ
        JsValue::Array(items) => items
            .iter()
            .filter(|item| matches!(item, JsValue::String(text) if !text.is_empty()))
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    // `result?.length ? result : undefined`
    if result.is_empty() {
        JsValue::Undefined
    } else {
        JsValue::Array(result)
    }
}

/// 原文: markmap-lib の normalizeNumber
fn normalize_number(value: &JsValue) -> JsValue {
    // 規則 2.1: `+value` は js_to_number
    let number = js_to_number(value);
    if number.is_nan() {
        JsValue::Undefined
    } else {
        JsValue::Number(number)
    }
}

/// parseDocument の probe の結果のうち、前半が決めるもの (名前のない値の組。規則 4 章)
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ProbeFrontmatterResult {
    pub(super) frontmatter: JsValue,
    pub(super) extracted: bool,
}

/// 原文: parseDocument の 272-277 (probe の frontmatter と extracted の判定)。前半と後半で分けて写すために切り出した
/// frontmatter は「キー: 値」の形でない文書もある (一覧や文字列だけ)。形が違うことの診断は model 層が出すので、
/// ここでは抽出をしない判断にだけ使う。markdag の指定はすべて markdag キーの下にあるので、そのキーの有無で決まる
pub(super) fn probe_frontmatter(source: &str) -> ProbeFrontmatterResult {
    // 規則 2.1: `probe.frontmatter ?? {}`。読めなかった文書と、YAML が空 (null) の文書は空の写像
    let frontmatter = match read_frontmatter(source).map(|info| info.value) {
        None | Some(JsValue::Null | JsValue::Undefined) => JsValue::Object(IndexMap::new()),
        Some(value) => value,
    };
    // 規則 2.1: `'markdag' in frontmatter` は写像のキーの有無 (値が null でも「ある」)
    let extracted = matches!(&frontmatter, JsValue::Object(map) if map.contains_key("markdag"));
    ProbeFrontmatterResult {
        frontmatter,
        extracted,
    }
}

// ---- YAML の読み取り (eemeli/yaml の parse。markmap-lib の frontmatter プラグインが呼ぶ) ----

/// eemeli/yaml の parse が throw する理由 (規則 2.5 の YAML の読み込みの失敗の行)。markmap は文面を使わないので種類だけを持つ
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum YamlParseError {
    /// 構文の誤り (saphyr-parser の最初の Err)
    Syntax,
    /// `Map keys must be unique`
    DuplicateKey,
    /// `Source contains multiple documents; please use YAML.parseAllDocuments()`
    MultipleDocuments,
    /// 循環する別名 (規則 2.3)
    CyclicAlias,
    /// `Excessive alias count indicates a resource exhaustion attack` (maxAliasCount の既定 100)
    ExcessiveAliases,
    /// 入れ物の入れ子が上限 (MAX_YAML_NESTING) を越えた (A-105。原文にない失敗。位置の木も同じ所で誤りにする)
    TooDeep,
}

// eemeli/yaml の toJS の maxAliasCount の既定値
const MAX_ALIAS_COUNT: u64 = 100;

// eemeli/yaml の getAliasCount に要る節の形 (値とは別に持つ)。組 (Pair) の max と入れ物の max は結合するので、写像はキーと値を並べて持つ
#[derive(Debug, Clone)]
enum AliasWeight {
    // スカラ (と値のない組の null)。1
    Leaf,
    // 別名。指す錨の count * aliasCount
    Alias(usize),
    // 入れ物。項目の最大 (空なら 0)
    Collection(Vec<AliasWeight>),
}

// 錨ごとの toJS の記録 (eemeli/yaml の ctx.anchors の値 { aliasCount, count, res })。res は入れ物を読み終えるまで None
#[derive(Debug, Clone)]
struct AnchorData {
    value: Option<JsValue>,
    weight: AliasWeight,
    count: u64,
    alias_count: u64,
    // 値の入れ物の入れ子の段数 (スカラは 0)。別名で展開した値の深さを数える (A-105)
    height: usize,
}

// 組み立て中の入れ物。Map の key は値を待っているキー、key_text はそのキーが入れ物か入れ物を指す別名のときの YAML の字 (A-130 (1))
enum YamlFrame {
    Map {
        anchor: usize,
        entries: IndexMap<String, JsValue>,
        keys: Vec<JsValue>,
        weights: Vec<AliasWeight>,
        key: Option<JsValue>,
        key_text: Option<String>,
        // 読み終えた中身の入れ子の段数の最大
        height: usize,
    },
    Seq {
        anchor: usize,
        items: Vec<JsValue>,
        weights: Vec<AliasWeight>,
        height: usize,
    },
}

struct YamlReader {
    stack: Vec<YamlFrame>,
    anchors: HashMap<usize, AnchorData>,
    root: Option<JsValue>,
    // 写像のキーの位置で開いた入れ物の節の木 (キーを読み終えたら YAML のフロー形式の字にする)
    key_tree: KeyTreeBuilder,
    // 次に置く節 (写像のキー) の YAML の字。入れ物のキーを閉じたときと、入れ物を指す別名のキーで入る
    key_text: Option<String>,
}

/// 原文: eemeli/yaml の parse (frontmatter の本体を JS の値にする)
/// 値は規則 2.1 の JsValue、スカラは yaml_core_scalar (core schema)、写像のキーは書かれた順 (決定 8。JS の整数のキーの並べ替えはしない)。
/// 別名は展開し (規則 2.3)、重複キー、複数の文書、循環する別名、別名の数え過ぎは失敗 (規則 2.5)
// 規則 1 章 (A-120): saphyr の loader は使わず、saphyr-parser のイベントを読んで最初の Err で打ち切る。
// saphyr に渡す写しと、止まった所での書き換え (BOM、末尾の改行、NUL、`:` の後ろのタブ、サロゲートの escape、行をまたぐフローの閉じ) は
// frontmatter の位置の木と共有する (SaphyrInput。A-081 (2)、A-131)
// saphyr-parser と eemeli/yaml の受け入れの差 (eemeli だけが誤りにする書き方、YAML 1.1 の明示のタグ) は位置の木と同じく写さない (accepted.md 18、19。
// A-082、A-132、A-134)。深さの上限は YAML の入れ子 100 段 (規則 2.6 の再帰の行、A-105。accepted.md 28 (3))
pub(super) fn yaml_parse(raw: &str) -> Result<JsValue, YamlParseError> {
    let mut input = SaphyrInput::new(raw);
    loop {
        match read_yaml_events(&input)? {
            YamlRead::Value(value) => return Ok(value),
            YamlRead::Stopped { info, index } => {
                // フローの入れ子の数え過ぎ (saphyr の 256 段) は、上限を越えた入れ子と同じ失敗にする (A-105)
                if info == crate::model::locator::FLOW_LEVEL_OVERFLOW_INFO {
                    return Err(YamlParseError::TooDeep);
                }
                if !input.rewrite(&info, index) {
                    return Err(YamlParseError::Syntax);
                }
            }
        }
    }
}

/// 原文: scripts/check.ts の parseYaml (eemeli/yaml の parse。markdag.types.$ref が指すファイルを読む)。
/// yaml_parse を外から使う入口。改行は frontmatter と同じく LF にそろえてから読み、throw する入力は None にする
/// (check.ts は catch して null を渡し、build_model が types-unresolved にする)
pub fn parse_yaml(text: &str) -> Option<JsValue> {
    yaml_parse(&LINE_BREAK.replace_all(text, "\n")).ok()
}

// saphyr-parser のイベントを 1 回読んだ結果。Stopped は構文の誤りで止まった所 (写しを書き換えて読み直せるかは SaphyrInput が決める)
enum YamlRead {
    Value(JsValue),
    Stopped { info: String, index: usize },
}

fn read_yaml_events(input: &SaphyrInput) -> Result<YamlRead, YamlParseError> {
    let mut parser = Parser::new_from_str(&input.text);
    let mut reader = YamlReader {
        stack: Vec::new(),
        anchors: HashMap::new(),
        root: None,
        key_tree: KeyTreeBuilder::default(),
        key_text: None,
    };
    let mut documents = 0usize;
    // 直前のイベントの終わり (字の添字)。節の錨の名前は、ここから節の始まりまでの間 (節の性質とコメント) から読む
    let mut previous_end = 0usize;
    while let Some(next) = parser.next_event() {
        let (event, span) = match next {
            Ok(pair) => pair,
            Err(error) => {
                return Ok(YamlRead::Stopped {
                    info: error.info().to_string(),
                    index: error.marker().index(),
                });
            }
        };
        let (start, end) = (span.start.index(), span.end.index());
        let gap_start = previous_end.min(start);
        previous_end = previous_end.max(end);
        match event {
            YamlEvent::StreamEnd => break,
            YamlEvent::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Err(YamlParseError::MultipleDocuments);
                }
            }
            YamlEvent::Scalar(text, style, anchor, tag) => {
                let text = input.scalar_text(&text, input.byte(span.start.index()));
                // 中身のない折り返しのスカラが入力の最後の値だと、saphyr は写しの末尾に足した改行を中身にする ("\n")。
                // raw は trimEnd してあるのでこの形は記号の行で終わっており、eemeli/yaml の値は ""
                let empty_block = matches!(style, ScalarStyle::Literal | ScalarStyle::Folded)
                    && span.end.index() >= input.char_len()
                    && !text.is_empty()
                    && text.chars().all(|c| c == '\n');
                let text = if empty_block { "" } else { &text };
                let value = scalar_value(text, style, tag.as_deref());
                if reader.key_tree.is_open() {
                    // saphyr-parser は空のスカラを "~" (錨かタグがあれば "") で出す。eemeli/yaml の空の節は source が ""
                    let empty = style == ScalarStyle::Plain
                        && (text.is_empty() || (text == "~" && char_at(input, start) != Some('~')));
                    let props = key_props(input, anchor, tag.as_deref(), gap_start, start);
                    let mark = (empty && props == KeyProps::default()).then(|| EmptyMark {
                        colon: colon_column(input, gap_start, start),
                    });
                    let scalar = KeyScalar {
                        value: value.clone(),
                        source: if empty {
                            String::new()
                        } else {
                            text.to_string()
                        },
                        style,
                        props,
                    };
                    reader.key_tree.add(KeyNode::Scalar(scalar), mark);
                }
                reader.push(value, true, anchor, AliasWeight::Leaf)?;
            }
            YamlEvent::Alias(anchor) => {
                // 別名の位置は `*名前` の字
                let name = || {
                    let source = &input.text[input.byte(start)..input.byte(end)];
                    source.strip_prefix('*').unwrap_or(source).to_string()
                };
                if reader.key_tree.is_open() {
                    reader.key_tree.add(KeyNode::Alias(name()), None);
                } else if reader.waits_for_key()
                    && reader.anchors.get(&anchor).is_some_and(|data| {
                        matches!(data.value, Some(JsValue::Array(_) | JsValue::Object(_)))
                    })
                {
                    // 入れ物を指す別名のキーは、eemeli/yaml が Alias の節を文字にするので `*名前`
                    reader.key_text = Some(format!("*{}", name()));
                }
                reader.push_alias(anchor)?;
            }
            YamlEvent::SequenceStart(anchor, tag) => {
                reader.check_depth()?;
                if reader.key_tree.is_open() || reader.waits_for_key() {
                    let props = key_props(input, anchor, tag.as_deref(), gap_start, start);
                    let flow = char_at(input, start) == Some('[');
                    reader
                        .key_tree
                        .open(false, props, flow, column_of(input, start));
                }
                reader.open(anchor);
                reader.stack.push(YamlFrame::Seq {
                    anchor,
                    items: Vec::new(),
                    weights: Vec::new(),
                    height: 0,
                });
            }
            YamlEvent::MappingStart(anchor, tag) => {
                reader.check_depth()?;
                if reader.key_tree.is_open() || reader.waits_for_key() {
                    let props = key_props(input, anchor, tag.as_deref(), gap_start, start);
                    let flow = char_at(input, start) == Some('{');
                    reader
                        .key_tree
                        .open(true, props, flow, column_of(input, start));
                }
                reader.open(anchor);
                reader.stack.push(YamlFrame::Map {
                    anchor,
                    entries: IndexMap::new(),
                    keys: Vec::new(),
                    weights: Vec::new(),
                    key: None,
                    key_text: None,
                    height: 0,
                });
            }
            YamlEvent::SequenceEnd | YamlEvent::MappingEnd => {
                if let Some(text) = reader.key_tree.close() {
                    reader.key_text = Some(text);
                }
                reader.close()?;
            }
            YamlEvent::Nothing | YamlEvent::StreamStart | YamlEvent::DocumentEnd => {}
        }
    }
    // 空の文書 (コメントだけを含む) は null
    Ok(YamlRead::Value(reader.root.unwrap_or(JsValue::Null)))
}

impl YamlReader {
    // 入れ物をもう 1 段開けるか。値の clone と drop、JS の側の JSON の読み直しが再帰するので、深さを上限で止める (A-105)
    fn check_depth(&self) -> Result<(), YamlParseError> {
        if self.stack.len() >= crate::limits::MAX_YAML_NESTING {
            return Err(YamlParseError::TooDeep);
        }
        Ok(())
    }

    // 錨つきの入れ物を開く。読み終えるまで値はない (その間に別名で指されたら循環)
    fn open(&mut self, anchor: usize) {
        if anchor != 0 {
            self.anchors.insert(
                anchor,
                AnchorData {
                    value: None,
                    weight: AliasWeight::Leaf,
                    count: 1,
                    alias_count: 0,
                    height: 0,
                },
            );
        }
    }

    fn close(&mut self) -> Result<(), YamlParseError> {
        // TODO(port): Rust 側の不到達 (saphyr は End の前に必ず対の Start を出す)
        let Some(frame) = self.stack.pop() else {
            return Ok(());
        };
        let (anchor, value, weight, inner) = match frame {
            YamlFrame::Map {
                anchor,
                mut entries,
                weights,
                key,
                key_text,
                height,
                ..
            } => {
                // 値のないキー (`? a` の後ろに何もない) は null の値の組
                if let Some(key) = key {
                    entries.insert(stringify_key(&key, key_text), JsValue::Null);
                }
                (
                    anchor,
                    JsValue::Object(entries),
                    AliasWeight::Collection(weights),
                    height,
                )
            }
            YamlFrame::Seq {
                anchor,
                items,
                weights,
                height,
            } => (
                anchor,
                JsValue::Array(items),
                AliasWeight::Collection(weights),
                height,
            ),
        };
        let height = inner + 1;
        // PERF(port): 錨つきの入れ物を閉じるたびに部分木を写すので、錨が入れ子になると 2 乗で、深い入れ子 (4000 段) では clone の再帰で
        // スタックが溢れる。別名で指されたときだけ写すか Rc で共有する形にできる (A-135)
        if let Some(data) = self.anchors.get_mut(&anchor) {
            data.value = Some(value.clone());
            data.weight = weight.clone();
            data.height = height;
        }
        self.raise_height(height);
        self.attach(value, false, weight)
    }

    // 読み終えた節の入れ子の段数を、開いている入れ物の中身の最大に入れる
    fn raise_height(&mut self, height: usize) {
        if let Some(YamlFrame::Map { height: open, .. } | YamlFrame::Seq { height: open, .. }) =
            self.stack.last_mut()
        {
            *open = (*open).max(height);
        }
    }

    // スカラを置く。錨つきなら記録する (toJS の anchors.set)
    fn push(
        &mut self,
        value: JsValue,
        scalar: bool,
        anchor: usize,
        weight: AliasWeight,
    ) -> Result<(), YamlParseError> {
        if anchor != 0 {
            self.anchors.insert(
                anchor,
                AnchorData {
                    value: Some(value.clone()),
                    weight: weight.clone(),
                    count: 1,
                    alias_count: 0,
                    height: 0,
                },
            );
        }
        self.attach(value, scalar, weight)
    }

    // 別名を展開して置く。eemeli/yaml の Alias.resolve の数え方 (count と aliasCount の積が 100 を越えたら失敗)
    fn push_alias(&mut self, anchor: usize) -> Result<(), YamlParseError> {
        // 未定義の別名は saphyr-parser が先に構文の誤りにする (eemeli/yaml も値を読むときに投げる)
        let Some(data) = self.anchors.get(&anchor) else {
            // TODO(port): Rust 側の不到達 (saphyr-parser は未定義の別名を Err にする)
            return Err(YamlParseError::Syntax);
        };
        let Some(value) = data.value.clone() else {
            return Err(YamlParseError::CyclicAlias);
        };
        let weight = data.weight.clone();
        // 別名は指す値を展開して置くので、展開した値の入れ子も上限に数える (値の clone と drop、境界の JSON の読み直しが再帰する。A-105)。
        // 位置の木 (locator) も同じ所で誤りにする
        let height = data.height;
        if self.stack.len() + height > crate::limits::MAX_YAML_NESTING {
            return Err(YamlParseError::TooDeep);
        }
        let alias_count = if data.alias_count == 0 {
            self.alias_count_of(&weight)
        } else {
            data.alias_count
        };
        if let Some(data) = self.anchors.get_mut(&anchor) {
            data.count += 1;
            data.alias_count = alias_count;
            if data.count.saturating_mul(data.alias_count) > MAX_ALIAS_COUNT {
                return Err(YamlParseError::ExcessiveAliases);
            }
        }
        self.raise_height(height);
        // 別名のキーは Scalar の節ではないので、重複キーの判定 (mapIncludes) に加わらない
        self.attach(value, false, AliasWeight::Alias(anchor))
    }

    // 次に置く節が写像のキーになるか (開いている写像が値でなくキーを待っている)
    fn waits_for_key(&self) -> bool {
        matches!(self.stack.last(), Some(YamlFrame::Map { key: None, .. }))
    }

    // eemeli/yaml の getAliasCount
    fn alias_count_of(&self, weight: &AliasWeight) -> u64 {
        match weight {
            AliasWeight::Leaf => 1,
            AliasWeight::Alias(anchor) => self
                .anchors
                .get(anchor)
                .map_or(0, |data| data.count.saturating_mul(data.alias_count)),
            AliasWeight::Collection(items) => items
                .iter()
                .map(|item| self.alias_count_of(item))
                .max()
                .unwrap_or(0),
        }
    }

    // 読み終えた節を、開いている入れ物 (なければ根) に入れる。scalar はスカラの節か (重複キーの判定とキーの文字列化に使う)
    fn attach(
        &mut self,
        value: JsValue,
        scalar: bool,
        weight: AliasWeight,
    ) -> Result<(), YamlParseError> {
        // 置く節がキーになるときだけ使う (値の位置と並びの項目では None のまま)
        let text = self.key_text.take();
        match self.stack.last_mut() {
            // 2 つ目の文書の開始で失敗にするので、根が来るのは 1 度だけ
            None => self.root = Some(value),
            Some(YamlFrame::Seq { items, weights, .. }) => {
                items.push(value);
                weights.push(weight);
            }
            Some(YamlFrame::Map {
                entries,
                keys,
                weights,
                key,
                key_text,
                ..
            }) => {
                weights.push(weight);
                match key.take() {
                    // 規則 2.3: 文字列にしたあと同じになるキーは最初の位置に最後の値 (IndexMap::insert)
                    Some(pending) => {
                        entries.insert(stringify_key(&pending, key_text.take()), value);
                    }
                    None => {
                        // 重複キーは eemeli/yaml の mapIncludes (`a.value === b.value`。スカラの節どうしだけ) で調べる。frontmatter の位置の木と同じ判定
                        // 規則 2.5 の YAML の読み込みの失敗 (1) (A-083): 解決後の値の === で、`1` と `"1"` は重複にしない
                        if scalar
                            && keys
                                .iter()
                                .any(|other| crate::model::util::js_strict_equals(other, &value))
                        {
                            return Err(YamlParseError::DuplicateKey);
                        }
                        if scalar {
                            keys.push(value.clone());
                        }
                        *key = Some(value);
                        *key_text = text;
                    }
                }
            }
        }
        Ok(())
    }
}

// eemeli/yaml の addPairToJSMap の stringifyKey: null は ""、スカラの値は String(v)、入れ物 (と入れ物を指す別名) は YAML のフロー形式の字
// (`[ a, b ]`、`{ x: 1 }`、`*k`。字は読み取りのときに KeyTreeBuilder が節の木から作り、text に入れて渡す)
// 規則 2.3「YAML のキーの文字列化」
// TODO(port): 入れ物のキーのうち次の書き方は eemeli/yaml と字が違う (A-130 (1)。saphyr-parser のイベントに情報がない):
// キーの中のコメント (eemeli は入れ物を複数行にしてコメントを書き写す)、キーの中の項目の前の空行 (eemeli は複数行にして空行を残す)、
// 対にならないサロゲートを含む文字 (eemeli は二重引用の \udXXX)
fn stringify_key(key: &JsValue, text: Option<String>) -> String {
    match (key, text) {
        (_, Some(text)) => text,
        (JsValue::Null, None) => String::new(),
        (_, None) => js_to_string(key),
    }
}

// saphyr の位置 (字の添字) の字
fn char_at(input: &SaphyrInput, index: usize) -> Option<char> {
    input.text[input.byte(index)..].chars().next()
}

// 空のスカラの前の `:` の桁。saphyr-parser は空のスカラの位置を `:` にも、その後ろの字 (`]` など) にも置くので、
// 直前の節の終わりから空のスカラの位置の字までの間を見る (コメントは飛ばす)
fn colon_column(input: &SaphyrInput, gap_start: usize, start: usize) -> Option<usize> {
    let from = input.byte(gap_start);
    let to = input.byte(start);
    let to = to + input.text[to..].chars().next().map_or(0, char::len_utf8);
    let mut comment = false;
    let mut previous = None;
    for (offset, c) in input.text[from..to].char_indices() {
        if comment {
            comment = c != '\n';
        } else if c == '#' && previous.is_none_or(char::is_whitespace) {
            comment = true;
        } else if c == ':' {
            return Some(column_at(input, from + offset));
        }
        previous = Some(c);
    }
    None
}

// saphyr の位置 (字の添字) の桁 (行頭からの字の数)
fn column_of(input: &SaphyrInput, index: usize) -> usize {
    column_at(input, input.byte(index))
}

// 写しの上のバイトの位置の桁
fn column_at(input: &SaphyrInput, byte: usize) -> usize {
    let line_start = input.text[..byte].rfind('\n').map_or(0, |at| at + 1);
    input.text[line_start..byte].chars().count()
}

// キーの中の節の錨とタグ。saphyr-parser は錨を番号でしか渡さないので、名前は直前のイベントの終わりから節の始まりまでの間
// (節の性質、指示の記号、コメント) を語に分けて、`&` で始まる語から読む。タグは解決した形 (handle と suffix をつないだもの)
fn key_props(
    input: &SaphyrInput,
    anchor: usize,
    tag: Option<&saphyr_parser::Tag>,
    gap_start: usize,
    start: usize,
) -> KeyProps {
    let anchor = (anchor != 0)
        .then(|| anchor_name(&input.text[input.byte(gap_start)..input.byte(start)]))
        .flatten();
    KeyProps {
        anchor,
        tag: tag.map(|tag| format!("{}{}", tag.handle, tag.suffix)),
    }
}

// 節の前の間から錨の名前を読む。語は空白とフローの記号 (`,` `[` `]` `{` `}`) で区切り、語頭の `:` は飛ばす (`"a":&x b`)。
// 語頭の `#` はコメント (行末まで)。錨の名前は空白とフローの記号を含まない
fn anchor_name(gap: &str) -> Option<String> {
    let mut found = None;
    let mut chars = gap.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() || matches!(c, ',' | '[' | ']' | '{' | '}' | ':') {
            continue;
        }
        if c == '#' {
            for rest in chars.by_ref() {
                if rest == '\n' {
                    break;
                }
            }
            continue;
        }
        let mut word = String::new();
        while let Some(&next) = chars.peek() {
            if next.is_whitespace() || matches!(next, ',' | '[' | ']' | '{' | '}') {
                break;
            }
            word.push(next);
            chars.next();
        }
        if c == '&' {
            found = Some(word);
        }
    }
    found
}
// ---- 入れ物のキーの文字列化 (A-130 (1)) ----
// 原文: node_modules/yaml (eemeli/yaml 2.9.1) の nodes/addPairToJSMap.js の stringifyKey が入れ物のキーに使う文字列化
// (stringify/stringify.js、stringifyCollection.js の stringifyFlowCollection、stringifyPair.js、stringifyString.js、
// stringifyNumber.js、foldFlowLines.js、schema/core の int / float / bool / null の stringify、doc/directives.js の tagString)
// YAML の写像のキーが入れ物 (`? [a, b]`) か、入れ物を指す別名 (`? *k`) のとき、eemeli/yaml は JS のオブジェクトのキーにするために
// キーの節を YAML のフロー形式の文字 (`[ a, b ]`、`*k`) に書き直す。その書き直しを、saphyr-parser のイベントから組んだ節の木に当てる。
// 書き直しは節の書き方を引き継ぐ: 引用の種類、数の書き方 (0x、0o、指数、小数点以下の桁)、null と真偽値の綴り、明示のタグと錨。
// 1 行が 80 字 (UTF-16 の数) を越える入れ物は複数行に、長いスカラは折り返す (lineWidth 80、minContentWidth 20)。
// 写していない書き方 (キーの中のコメント、空行、対にならないサロゲート) は stringify_key の印に挙げる。

// eemeli/yaml の createStringifyContext の既定値
const LINE_WIDTH: usize = 80;
const MIN_CONTENT_WIDTH: usize = 20;
const INDENT_STEP: &str = "  ";
const DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH: usize = 40;
const YAML_TAG_PREFIX: &str = "tag:yaml.org,2002:";

// 規則 1 章 (A-021): 定数の正規表現は LazyLock と expect
static CONTROL_CHARS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f-\u{9f}]").expect("固定の正規表現"));
static FLOW_INDICATOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\[\]{},]").expect("固定の正規表現"));
static PLAIN_NOT_ALLOWED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^[\n\t ,\[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#,
    )
    .expect("固定の正規表現")
});
static SPACE_AROUND_NEWLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t]\n|\n[ \t]").expect("固定の正規表現"));
static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n+").expect("固定の正規表現"));
static DOCUMENT_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(?:%|---|\.\.\.)").expect("固定の正規表現"));
// core schema の null / bool / int (oct、10 進、hex) / float (nan、指数、小数) の test
static NULL_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:~|[Nn]ull|NULL)?$").expect("固定の正規表現"));
static BOOL_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$").expect("固定の正規表現"));
static INT_OCT_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^0o[0-7]+$").expect("固定の正規表現"));
static INT_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?[0-9]+$").expect("固定の正規表現"));
static INT_HEX_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^0x[0-9a-fA-F]+$").expect("固定の正規表現"));
static FLOAT_NAN_TEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$").expect("固定の正規表現")
});
static FLOAT_EXP_TEST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$").expect("固定の正規表現")
});
static FLOAT_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$").expect("固定の正規表現"));

/// 節の錨とタグ (eemeli/yaml の node.anchor と node.tag。タグは解決した形 `tag:yaml.org,2002:str`、`!x`)
#[derive(Debug, Clone, Default, PartialEq)]
struct KeyProps {
    anchor: Option<String>,
    tag: Option<String>,
}

/// キーの中のスカラ。source は書かれた字 (plain は折り返しを畳んだ字、空の節は "")
#[derive(Debug, Clone, PartialEq)]
struct KeyScalar {
    value: JsValue,
    source: String,
    style: ScalarStyle,
    props: KeyProps,
}

/// キーの中の組。value が None は値の節がない組 (`{a}`、`? a` だけ)。`a:` の空の値は空のスカラの節
#[derive(Debug, Clone, PartialEq)]
struct KeyPair {
    key: KeyNode,
    value: Option<KeyNode>,
}

/// 入れ物のキーの節 (eemeli/yaml の Scalar、Alias、YAMLSeq、YAMLMap)。別名は展開せず名前だけを持つ
#[derive(Debug, Clone, PartialEq)]
enum KeyNode {
    Scalar(KeyScalar),
    Alias(String),
    Seq {
        props: KeyProps,
        items: Vec<KeyNode>,
    },
    Map {
        props: KeyProps,
        pairs: Vec<KeyPair>,
    },
}

/// 組み立て中の入れ物。flow はフローの入れ物 (の中) か、Map の column は写像の始まりの桁 (値のない組の見分けに使う)
#[derive(Debug)]
enum KeyFrame {
    Seq {
        props: KeyProps,
        flow: bool,
        items: Vec<KeyNode>,
    },
    Map {
        props: KeyProps,
        flow: bool,
        column: usize,
        pairs: Vec<KeyPair>,
        key: Option<KeyNode>,
    },
}

/// 空のスカラの節の位置 (saphyr-parser は値のない組にも空のスカラを出すので、`:` の有無で eemeli の Pair の value を決める)
#[derive(Debug, Clone, Copy)]
struct EmptyMark {
    // 直前の節の終わりから空のスカラの位置までの `:` の桁 (字の数)。なければ None
    colon: Option<usize>,
}

/// 入れ物のキーの節の木を、saphyr-parser のイベントの順に組む
#[derive(Debug, Default)]
struct KeyTreeBuilder {
    stack: Vec<KeyFrame>,
}

impl KeyTreeBuilder {
    /// 入れ物を開く。flow はフローの入れ物 (`[` `{`) か。フローの並びの中の 1 組の写像 (`[a: 1]`) もフローの中として扱う
    fn open(&mut self, map: bool, props: KeyProps, flow: bool, column: usize) {
        let flow = flow
            || matches!(
                self.stack.last(),
                Some(KeyFrame::Seq { flow: true, .. } | KeyFrame::Map { flow: true, .. })
            );
        self.stack.push(if map {
            KeyFrame::Map {
                props,
                flow,
                column,
                pairs: Vec::new(),
                key: None,
            }
        } else {
            KeyFrame::Seq {
                props,
                flow,
                items: Vec::new(),
            }
        });
    }

    /// 入れ物を閉じる。最も外の入れ物 (キーそのもの) を閉じたら、キーの文字 (addPairToJSMap の stringifyKey の `key.toString(strCtx)`) を返す。
    /// 最も外の入れ物の錨とタグは書かない (toString は stringify を経ないので stringifyProps を通らない)
    fn close(&mut self) -> Option<String> {
        let frame = self.stack.pop()?;
        let outermost = self.stack.is_empty();
        let ctx = Ctx::default();
        let (node, text) = match frame {
            KeyFrame::Seq { props, items, .. } => {
                let text = outermost.then(|| seq_to_string(&items, &ctx));
                (KeyNode::Seq { props, items }, text)
            }
            KeyFrame::Map {
                props,
                mut pairs,
                key,
                ..
            } => {
                // 値の節のない最後のキー (saphyr-parser は値のないキーにも空のスカラを出すので、YamlReader と同じ形の受け)
                if let Some(key) = key {
                    pairs.push(KeyPair { key, value: None });
                }
                let text = outermost.then(|| map_to_string(&pairs, &ctx));
                (KeyNode::Map { props, pairs }, text)
            }
        };
        if !outermost {
            self.add(node, None);
        }
        text
    }

    /// 節を開いている入れ物に入れる。empty は錨もタグもない空のスカラの位置 (写像の値の位置では、`:` がなければ値のない組にする)
    fn add(&mut self, node: KeyNode, empty: Option<EmptyMark>) {
        // 呼ぶ側は入れ物を開いている間だけ呼ぶ (最も外の入れ物は close が文字にする)
        if let Some(frame) = self.stack.last_mut() {
            match frame {
                KeyFrame::Seq { items, .. } => items.push(node),
                KeyFrame::Map {
                    flow,
                    column,
                    pairs,
                    key,
                    ..
                } => match key.take() {
                    None => *key = Some(node),
                    Some(pending) => {
                        // 値のない組は空のスカラの前に `:` がない。ブロックでは外の写像の `:` (写像より浅い桁) が前に入ることがあるので桁で分ける
                        let has_value = match empty {
                            None => true,
                            Some(mark) => mark.colon.is_some_and(|at| *flow || at >= *column),
                        };
                        pairs.push(KeyPair {
                            key: pending,
                            value: has_value.then_some(node),
                        });
                    }
                },
            }
        }
    }

    fn is_open(&self) -> bool {
        !self.stack.is_empty()
    }
}

// eemeli/yaml の StringifyContext のうち、キーの文字列化で変わる欄 (inFlow は常に true、options は既定値)
#[derive(Debug, Clone, Default)]
struct Ctx {
    indent: String,
    implicit_key: bool,
    all_null_values: bool,
    indent_at_start: Option<usize>,
}

// JS の文字列の length (UTF-16 の数)
fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

// stringify.js の stringify (節 1 つ)。ctx.indentAtStart は渡された ctx の上で書き換える (eemeli と同じく、フローの入れ物の項目で共有される)
fn stringify(node: &KeyNode, ctx: &mut Ctx) -> String {
    match node {
        // Alias.toString (verifyAliasOrder は満たされている: 別名は読み終えた錨しか指せない)
        KeyNode::Alias(name) => {
            if ctx.implicit_key {
                format!("*{name} ")
            } else {
                format!("*{name}")
            }
        }
        KeyNode::Scalar(scalar) => {
            with_props(&scalar.props, ctx, |ctx| scalar_to_string(scalar, ctx))
        }
        KeyNode::Seq { props, items } => with_props(props, ctx, |ctx| seq_to_string(items, ctx)),
        KeyNode::Map { props, pairs } => with_props(props, ctx, |ctx| map_to_string(pairs, ctx)),
    }
}

// 錨とタグを前に置く。スカラとフローの入れ物 (`[` `{` で始まる) は同じ行に続ける
fn with_props(props: &KeyProps, ctx: &mut Ctx, body: impl FnOnce(&Ctx) -> String) -> String {
    let props = props_string(props);
    if props.is_empty() {
        return body(ctx);
    }
    ctx.indent_at_start = Some(ctx.indent_at_start.unwrap_or(0) + len16(&props) + 1);
    format!("{props} {}", body(ctx))
}

// stringifyProps: `&錨` と `タグ` を空白でつなぐ
fn props_string(props: &KeyProps) -> String {
    let mut parts = Vec::new();
    if let Some(anchor) = &props.anchor {
        parts.push(format!("&{anchor}"));
    }
    if let Some(tag) = &props.tag {
        parts.push(tag_string(tag));
    }
    parts.join(" ")
}

// directives.js の tagString (既定の `!!` だけ。frontmatter には %TAG を書けない: 閉じの `---` が指示の後ろの `---` で先に当たる)
fn tag_string(tag: &str) -> String {
    if let Some(rest) = tag.strip_prefix(YAML_TAG_PREFIX) {
        let mut escaped = String::from("!!");
        for c in rest.chars() {
            match c {
                '!' => escaped.push_str("%21"),
                ',' => escaped.push_str("%2C"),
                '[' => escaped.push_str("%5B"),
                ']' => escaped.push_str("%5D"),
                '{' => escaped.push_str("%7B"),
                '}' => escaped.push_str("%7D"),
                other => escaped.push(other),
            }
        }
        return escaped;
    }
    if tag.starts_with('!') {
        tag.to_string()
    } else {
        format!("!<{tag}>")
    }
}

// YAMLSeq.toString
fn seq_to_string(items: &[KeyNode], ctx: &Ctx) -> String {
    let item_indent = format!("{}{INDENT_STEP}", ctx.indent);
    let lines = flow_lines(items.len(), ctx, &item_indent, |index, item_ctx| {
        stringify(&items[index], item_ctx)
    });
    flow_collection(lines, ctx, '[', ']')
}

// YAMLMap.toString (値のない組だけの写像は allNullValues)
fn map_to_string(pairs: &[KeyPair], ctx: &Ctx) -> String {
    let mut ctx = ctx.clone();
    if !ctx.all_null_values && pairs.iter().all(|pair| pair.value.is_none()) {
        ctx.all_null_values = true;
    }
    let item_indent = ctx.indent.clone();
    let lines = flow_lines(pairs.len(), &ctx, &item_indent, |index, item_ctx| {
        stringify_pair(&pairs[index], item_ctx)
    });
    flow_collection(lines, &ctx, '{', '}')
}

// stringifyFlowCollection の項目の行 (最後以外に `,`)。行をまたぐ項目があれば true を添える
fn flow_lines(
    count: usize,
    ctx: &Ctx,
    item_indent: &str,
    mut item: impl FnMut(usize, &mut Ctx) -> String,
) -> (Vec<String>, bool) {
    let mut item_ctx = Ctx {
        indent: format!("{item_indent}{INDENT_STEP}"),
        ..ctx.clone()
    };
    let mut req_newline = false;
    let mut lines = Vec::with_capacity(count);
    for index in 0..count {
        let mut text = item(index, &mut item_ctx);
        req_newline = req_newline || text.contains('\n');
        if index + 1 < count {
            text.push(',');
        }
        lines.push(text);
    }
    (lines, req_newline)
}

// stringifyFlowCollection の組み立て。1 行に収まらない (項目の長さ + 2 の和 + 2 が 80 を越える) か、行をまたぐ項目があれば 1 項目 1 行
fn flow_collection(
    (lines, req_newline): (Vec<String>, bool),
    ctx: &Ctx,
    start: char,
    end: char,
) -> String {
    if lines.is_empty() {
        return format!("{start}{end}");
    }
    let req_newline =
        req_newline || lines.iter().map(|line| len16(line) + 2).sum::<usize>() + 2 > LINE_WIDTH;
    if req_newline {
        let mut text = start.to_string();
        for line in &lines {
            if line.is_empty() {
                text.push('\n');
            } else {
                text.push_str(&format!("\n{INDENT_STEP}{}{line}", ctx.indent));
            }
        }
        format!("{text}\n{}{end}", ctx.indent)
    } else {
        format!("{start} {} {end}", lines.join(" "))
    }
}

// stringifyPair (フローの中なので inFlow の枝だけ)
fn stringify_pair(pair: &KeyPair, ctx: &Ctx) -> String {
    let all_null_values = ctx.all_null_values;
    // 入れ物、別名、ブロックのスカラのキーは `? ` を付ける
    let explicit_key = match &pair.key {
        KeyNode::Scalar(scalar) => {
            matches!(scalar.style, ScalarStyle::Literal | ScalarStyle::Folded)
        }
        KeyNode::Alias(_) | KeyNode::Seq { .. } | KeyNode::Map { .. } => true,
    };
    let mut pair_ctx = Ctx {
        all_null_values: false,
        implicit_key: !explicit_key && !all_null_values,
        indent: format!("{}{INDENT_STEP}", ctx.indent),
        ..ctx.clone()
    };
    let key = stringify(&pair.key, &mut pair_ctx);
    let value = match &pair.value {
        Some(value) if !all_null_values => value,
        _ => {
            return if key.is_empty() {
                "?".to_string()
            } else if explicit_key {
                format!("? {key}")
            } else {
                key
            };
        }
    };
    let text = if explicit_key {
        format!("? {key}\n{}:", ctx.indent)
    } else {
        format!("{key}:")
    };
    pair_ctx.implicit_key = false;
    if !explicit_key && matches!(value, KeyNode::Scalar(_)) {
        pair_ctx.indent_at_start = Some(len16(&text) + 1);
    }
    let value_text = stringify(value, &mut pair_ctx);
    let mut ws = " ".to_string();
    if !explicit_key && matches!(value, KeyNode::Seq { .. } | KeyNode::Map { .. }) {
        if let Some(newline) = value_text.find('\n') {
            // 錨とタグだけの行 (`&a !t` の後ろで改行) なら同じ行に続ける
            let mut has_props_line = false;
            if value_text.starts_with(['&', '!']) {
                let mut space = value_text.find(' ');
                if value_text.starts_with('&')
                    && let Some(at) = space
                    && at < newline
                    && value_text[at + 1..].starts_with('!')
                {
                    space = value_text[at + 1..].find(' ').map(|next| at + 1 + next);
                }
                has_props_line = space.is_none_or(|at| newline < at);
            }
            if !has_props_line {
                ws = format!("\n{}", pair_ctx.indent);
            }
        }
    } else if value_text.is_empty() || value_text.starts_with('\n') {
        ws = String::new();
    }
    format!("{text}{ws}{value_text}")
}

// スカラの節の stringify (タグの stringify か stringifyString)
fn scalar_to_string(scalar: &KeyScalar, ctx: &Ctx) -> String {
    let core = scalar
        .props
        .tag
        .as_deref()
        .and_then(|tag| tag.strip_prefix(YAML_TAG_PREFIX));
    let value = &scalar.value;
    match (core, value) {
        (_, JsValue::Number(number)) => number_string(*number, &scalar.source, core),
        // 明示の core のタグに合わない書き方 (`!!bool x`、`!!int abc`) は文字の値のまま、そのタグの stringify で書く
        (Some("null"), _) => null_string(&scalar.source),
        (Some("bool"), _) | (_, JsValue::Bool(_)) => bool_string(&scalar.source, value),
        (Some("int" | "float"), _) => stringify_number(value, None, true),
        (_, JsValue::String(text)) => stringify_string(text, scalar.style, ctx),
        // null (スカラの節の値は null、真偽値、数、文字のどれか)
        _ => null_string(&scalar.source),
    }
}

// core の nullTag の stringify: 書かれた綴りが null の形ならそのまま、ほかは "null"
fn null_string(source: &str) -> String {
    if NULL_TEST.is_match(source) {
        source.to_string()
    } else {
        "null".to_string()
    }
}

// core の boolTag の stringify: 書かれた綴りが値と合えばそのまま、ほかは値の真偽 (JS の truthy) で "true" / "false"
fn bool_string(source: &str, value: &JsValue) -> String {
    if !source.is_empty()
        && BOOL_TEST.is_match(source)
        && *value == JsValue::Bool(source.starts_with(['t', 'T']))
    {
        return source.to_string();
    }
    let truthy = match value {
        JsValue::Null | JsValue::Undefined => false,
        JsValue::Bool(value) => *value,
        JsValue::Number(number) => *number != 0.0 && !number.is_nan(),
        JsValue::String(text) => !text.is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
    };
    if truthy { "true" } else { "false" }.to_string()
}

// 数の節: 書き方 (format) で int の hex / oct、float の指数を選び、ほかは stringifyNumber (小数の桁は float の resolve の minFractionDigits)
fn number_string(number: f64, source: &str, core_tag: Option<&str>) -> String {
    if INT_HEX_TEST.is_match(source) {
        return int_string(number, 16, "0x");
    }
    if INT_OCT_TEST.is_match(source) {
        return int_string(number, 8, "0o");
    }
    if FLOAT_EXP_TEST.is_match(source) {
        return if number.is_finite() {
            to_exponential(number)
        } else {
            stringify_number(&JsValue::Number(number), None, true)
        };
    }
    let min_fraction_digits = if FLOAT_TEST.is_match(source) && source.ends_with('0') {
        source.find('.').map(|dot| source.len() - dot - 1)
    } else {
        None
    };
    stringify_number(
        &JsValue::Number(number),
        min_fraction_digits,
        matches!(core_tag, None | Some("float")),
    )
}

// int.js の intStringify: 0 以上の整数は基数の字、ほかは stringifyNumber
fn int_string(number: f64, radix: u32, prefix: &str) -> String {
    if number.is_finite() && number.fract() == 0.0 && number >= 0.0 {
        return format!("{prefix}{}", integer_to_radix(number, radix));
    }
    stringify_number(&JsValue::Number(number), None, true)
}

// JS の Number.prototype.toString(radix) を 0 以上の整数に当てたもの。基数が 2 の冪なので割り算と余りは f64 で正確
fn integer_to_radix(number: f64, radix: u32) -> String {
    let base = f64::from(radix);
    let mut digits = Vec::new();
    let mut rest = number;
    while rest >= 1.0 {
        let digit = rest % base;
        // 余りは基数より小さい 0 以上の整数
        digits.push(char::from_digit(digit as u32, radix).unwrap_or('0'));
        rest = (rest - digit) / base;
    }
    if digits.is_empty() {
        return "0".to_string();
    }
    digits.iter().rev().collect()
}

// JS の Number.prototype.toExponential() (桁の指定なし。最短の桁と符号つきの指数)
fn to_exponential(number: f64) -> String {
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

// stringifyNumber.js。文字の値 (`!!int abc`) は Number(value) で有限か見て、有限なら JSON.stringify(value) (引用つき)
fn stringify_number(
    value: &JsValue,
    min_fraction_digits: Option<usize>,
    float_or_untagged: bool,
) -> String {
    let number = match value {
        JsValue::Number(number) => *number,
        other => js_to_number(other),
    };
    if !number.is_finite() {
        return if number.is_nan() {
            ".nan"
        } else if number < 0.0 {
            "-.inf"
        } else {
            ".inf"
        }
        .to_string();
    }
    let mut text = match value {
        JsValue::Number(number) if *number == 0.0 && number.is_sign_negative() => "-0".to_string(),
        JsValue::Number(number) => js_number_to_string(*number),
        other => js_json_stringify(other),
    };
    if let Some(digits) = min_fraction_digits
        && digits > 0
        && float_or_untagged
        && text
            .trim_start_matches('-')
            .starts_with(|c: char| c.is_ascii_digit())
        && !text.contains('e')
    {
        let dot = match text.find('.') {
            Some(dot) => dot,
            None => {
                text.push('.');
                text.len() - 1
            }
        };
        let have = text.len() - dot - 1;
        for _ in have..digits {
            text.push('0');
        }
    }
    text
}

// ---- stringifyString.js (フローの中なのでブロックのスカラは引用に落ちる) ----

fn stringify_string(value: &str, style: ScalarStyle, ctx: &Ctx) -> String {
    let style = if style != ScalarStyle::DoubleQuoted && CONTROL_CHARS.is_match(value) {
        ScalarStyle::DoubleQuoted
    } else {
        style
    };
    match style {
        ScalarStyle::Literal | ScalarStyle::Folded => quoted_string(value, ctx),
        ScalarStyle::DoubleQuoted => double_quoted_string(value, ctx),
        ScalarStyle::SingleQuoted => single_quoted_string(value, ctx),
        ScalarStyle::Plain => plain_string(value, ctx),
    }
}

// 項目の indent は空にならない (並びの項目は 4 字、写像の組は 2 字から)。空のときの containsDocumentMarker の 2 字は写しとして残す
fn indent_of(value: &str, ctx: &Ctx) -> String {
    if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if DOCUMENT_MARKER.is_match(value) {
        INDENT_STEP.to_string()
    } else {
        String::new()
    }
}

fn quoted_string(value: &str, ctx: &Ctx) -> String {
    // singleQuote は既定の null: " だけを含めば一重、ほかは二重
    if value.contains('"') && !value.contains('\'') {
        single_quoted_string(value, ctx)
    } else {
        double_quoted_string(value, ctx)
    }
}

fn double_quoted_string(value: &str, ctx: &Ctx) -> String {
    let json: Vec<u16> = js_json_stringify(&JsValue::String(value.to_string()))
        .encode_utf16()
        .collect();
    let indent = indent_of(value, ctx);
    let at = |index: usize| json.get(index).copied();
    let is = |index: usize, c: char| at(index) == Some(c as u16);
    let mut out: Vec<u16> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while let Some(mut ch) = at(i) {
        if ch == u16::from(b' ') && is(i + 1, '\\') && is(i + 2, 'n') {
            // 改行の前の空白は畳まれないように escape する
            out.extend_from_slice(&json[start..i]);
            out.extend("\\ ".encode_utf16());
            i += 1;
            start = i;
            ch = u16::from(b'\\');
        }
        if ch == u16::from(b'\\') {
            match at(i + 1).map(|c| char::from_u32(u32::from(c)).unwrap_or('\u{fffd}')) {
                Some('u') => {
                    out.extend_from_slice(&json[start..i]);
                    let code = String::from_utf16_lossy(
                        &json[(i + 2).min(json.len())..(i + 6).min(json.len())],
                    );
                    match code.as_str() {
                        "0000" => out.extend("\\0".encode_utf16()),
                        "0007" => out.extend("\\a".encode_utf16()),
                        "000b" => out.extend("\\v".encode_utf16()),
                        "001b" => out.extend("\\e".encode_utf16()),
                        "0085" => out.extend("\\N".encode_utf16()),
                        "00a0" => out.extend("\\_".encode_utf16()),
                        "2028" => out.extend("\\L".encode_utf16()),
                        "2029" => out.extend("\\P".encode_utf16()),
                        _ => {
                            if let Some(low) = code.strip_prefix("00") {
                                out.extend(format!("\\x{low}").encode_utf16());
                            } else {
                                out.extend_from_slice(&json[i..(i + 6).min(json.len())]);
                            }
                        }
                    }
                    i += 5;
                    start = i + 1;
                }
                Some('n') => {
                    if ctx.implicit_key
                        || is(i + 2, '"')
                        || json.len() < DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH
                    {
                        i += 1;
                    } else {
                        // 折り返しが最初の改行を食べるので、改行を 2 つ書く
                        out.extend_from_slice(&json[start..i]);
                        out.extend("\n\n".encode_utf16());
                        while is(i + 2, '\\') && is(i + 3, 'n') && !is(i + 4, '"') {
                            out.push(u16::from(b'\n'));
                            i += 2;
                        }
                        out.extend(indent.encode_utf16());
                        // 改行の後ろの空白は畳まれないように escape する
                        if is(i + 2, ' ') {
                            out.push(u16::from(b'\\'));
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let text = if start > 0 {
        out.extend_from_slice(&json[start.min(json.len())..]);
        String::from_utf16_lossy(&out)
    } else {
        String::from_utf16_lossy(&json)
    };
    if ctx.implicit_key {
        text
    } else {
        fold_flow_lines(&text, &indent, FoldMode::Quoted, ctx.indent_at_start)
    }
}

fn single_quoted_string(value: &str, ctx: &Ctx) -> String {
    if (ctx.implicit_key && value.contains('\n')) || SPACE_AROUND_NEWLINE.is_match(value) {
        return double_quoted_string(value, ctx);
    }
    let indent = indent_of(value, ctx);
    let escaped = value.replace('\'', "''");
    let body = NEWLINES.replace_all(&escaped, |caps: &regex::Captures| {
        format!("{}\n{indent}", &caps[0])
    });
    let text = format!("'{body}'");
    if ctx.implicit_key {
        text
    } else {
        fold_flow_lines(&text, &indent, FoldMode::Flow, ctx.indent_at_start)
    }
}

fn plain_string(value: &str, ctx: &Ctx) -> String {
    if (ctx.implicit_key && value.contains('\n')) || FLOW_INDICATOR.is_match(value) {
        return quoted_string(value, ctx);
    }
    if PLAIN_NOT_ALLOWED.is_match(value) {
        return quoted_string(value, ctx);
    }
    // containsDocumentMarker の枝 (indent が空ならブロックのスカラ、キーで indent が 1 段なら引用) は、項目の indent が
    // 空にも 1 段 (2 字) にもならない (並びの項目は 4 字、組の キーは 4 字から) ので当たらない
    let text = NEWLINES
        .replace_all(value, |caps: &regex::Captures| {
            format!("{}\n{}", &caps[0], ctx.indent)
        })
        .into_owned();
    // actualString: 書き直した字が core schema のほかの型 (null、真偽値、数) に読めるなら引用する
    let tests: [&LazyLock<Regex>; 8] = [
        &NULL_TEST,
        &BOOL_TEST,
        &INT_OCT_TEST,
        &INT_TEST,
        &INT_HEX_TEST,
        &FLOAT_NAN_TEST,
        &FLOAT_EXP_TEST,
        &FLOAT_TEST,
    ];
    if tests.iter().any(|test| test.is_match(&text)) {
        return quoted_string(value, ctx);
    }
    if ctx.implicit_key {
        text
    } else {
        fold_flow_lines(&text, &ctx.indent, FoldMode::Flow, ctx.indent_at_start)
    }
}

// ---- foldFlowLines.js (FOLD_FLOW と FOLD_QUOTED。FOLD_BLOCK はフローの中で使わない) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FoldMode {
    Flow,
    Quoted,
}

// JS の text.slice(start, end) を UTF-16 の列に (負の添字は末尾から)
fn slice16(text: &[u16], start: isize, end: isize) -> &[u16] {
    let len = text.len() as isize;
    let clamp = |index: isize| {
        if index < 0 {
            (len + index).max(0)
        } else {
            index.min(len)
        }
    };
    let (start, end) = (clamp(start), clamp(end));
    if start >= end {
        return &[];
    }
    &text[start as usize..end as usize]
}

// 行を lineWidth に収めるよう、両側が空白でない空白の所 (二重引用では escape の手前でも) で改行と indent に置き換える
fn fold_flow_lines(
    text: &str,
    indent: &str,
    mode: FoldMode,
    indent_at_start: Option<usize>,
) -> String {
    let chars: Vec<u16> = text.encode_utf16().collect();
    let indent_len = len16(indent) as isize;
    let line_width = LINE_WIDTH as isize;
    let min_content_width = MIN_CONTENT_WIDTH as isize;
    let end_step = (1 + min_content_width).max(1 + line_width - indent_len);
    if chars.len() as isize <= end_step {
        return text.to_string();
    }
    let at = |index: isize| {
        if index < 0 {
            None
        } else {
            chars.get(index as usize).copied()
        }
    };
    let space = u16::from(b' ');
    let tab = u16::from(b'\t');
    let newline = u16::from(b'\n');
    let mut folds: Vec<isize> = Vec::new();
    let mut escaped_folds: HashSet<isize> = HashSet::new();
    let mut end = line_width - indent_len;
    if let Some(indent_at_start) = indent_at_start {
        let indent_at_start = indent_at_start as isize;
        if indent_at_start > line_width - 2.max(min_content_width) {
            folds.push(0);
        } else {
            end = line_width - indent_at_start;
        }
    }
    let mut split: Option<isize> = None;
    let mut prev: Option<u16> = None;
    let mut i: isize = -1;
    let mut esc_start: isize = -1;
    let mut esc_end: isize = -1;
    loop {
        i += 1;
        let Some(first) = at(i) else {
            break;
        };
        let mut ch = Some(first);
        if mode == FoldMode::Quoted && first == u16::from(b'\\') {
            esc_start = i;
            match at(i + 1).map(u32::from).and_then(char::from_u32) {
                Some('x') => i += 3,
                Some('u') => i += 5,
                Some('U') => i += 9,
                _ => i += 1,
            }
            esc_end = i;
        }
        if first == newline {
            end = i + indent_len + end_step;
            split = None;
        } else {
            if first == space
                && prev.is_some_and(|p| p != space && p != newline && p != tab)
                && at(i + 1).is_some_and(|next| next != space && next != newline && next != tab)
            {
                split = Some(i);
            }
            if i >= end {
                if let Some(at_split) = split.filter(|at_split| *at_split != 0) {
                    folds.push(at_split);
                    end = at_split + end_step;
                    split = None;
                } else if mode == FoldMode::Quoted {
                    // 行末に集まった空白は lineWidth を越えてよい
                    while prev == Some(space) || prev == Some(tab) {
                        prev = ch;
                        i += 1;
                        ch = at(i);
                    }
                    // escape の改行を数に入れ、直前の escape は割らない
                    let j = if i > esc_end + 1 {
                        i - 2
                    } else {
                        esc_start - 1
                    };
                    if escaped_folds.contains(&j) {
                        return text.to_string();
                    }
                    folds.push(j);
                    escaped_folds.insert(j);
                    end = j + end_step;
                    split = None;
                }
            }
        }
        prev = ch;
        if ch.is_none() {
            break;
        }
    }
    if folds.is_empty() {
        return text.to_string();
    }
    let indent16: Vec<u16> = indent.encode_utf16().collect();
    let text_len = chars.len() as isize;
    let mut res: Vec<u16> = slice16(&chars, 0, folds[0]).to_vec();
    for (index, fold) in folds.iter().copied().enumerate() {
        let next = folds
            .get(index + 1)
            .copied()
            .filter(|next| *next != 0)
            .unwrap_or(text_len);
        if fold == 0 {
            res = vec![newline];
            res.extend_from_slice(&indent16);
            res.extend_from_slice(slice16(&chars, 0, next));
        } else {
            if mode == FoldMode::Quoted && escaped_folds.contains(&fold) {
                match at(fold) {
                    Some(c) => res.push(c),
                    None => res.extend("undefined".encode_utf16()),
                }
                res.push(u16::from(b'\\'));
            }
            res.push(newline);
            res.extend_from_slice(&indent16);
            res.extend_from_slice(slice16(&chars, fold + 1, next));
        }
    }
    String::from_utf16_lossy(&res)
}

// ==== 後半: タスク、記号の絵、詳細、1 行目、組み立て (document.ts:178-324) ====

// 規則 1 章 (A-021): 定数の正規表現は LazyLock と expect。規則 2.4: [\s\S] は (?s:.)
static REF_SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t\n]+").expect("固定の正規表現"));
static LEADING_ICON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<svg(?s:.)*?</svg>").expect("固定の正規表現"));
static LEADING_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[( |x|/|-)\] ").expect("固定の正規表現"));

/// 原文: normalize (document.ts:178)
// 規則 2.2: model.ts の normalize (`[ \t]+`) とは別の関数にする
fn normalize_ref_text(text: &str) -> String {
    let nfc: String = text.nfc().collect();
    js_trim(&REF_SPACES.replace_all(&nfc, " ")).to_string()
}

/// describeFirstLine の戻り値 (名前のない型。規則 4 章「関数名 + Result」)
#[derive(Debug, Clone, PartialEq)]
struct DescribeFirstLineResult {
    ref_text: String,
    milestone: bool,
}

// DOM の body の直下のノード (describeFirstLine が「意味のある子」を数えるもの)。要素は名前と textContent を持つ
#[derive(Debug, Clone, PartialEq)]
enum TopNode {
    Text(String),
    Element { name: String, text: String },
    Comment(String),
}

/// 原文: describeFirstLine
/// 1 行目の、装飾と状態の記号を除いた文字と、全体が 1 つの太字で包まれているか。
/// 原文は DOMParser で読み、svg を除き、最初の <br> から後ろを削る。ここでは HTML の層が書いた内容を字句に分けて、同じ順で読む
// AST でなく書き出した HTML から読む。生の HTML の要素と文字、拒まれたリンクの <br>、記号の絵が HTML の層の出力にしかないため
// (台帳 98 行、A-138 (1))
// refText は 1 行目だけにする (旧実装は最初の <br> でしか切らず、2 つ目の段落や表とコードの中身も混ざった。
// docs/ignore/bugs/TODO.md の a、migration/judge/accepted.md)。段落の中の改行は <br> になるので、body の直下の文字の改行は
// ブロックの境目。文字のあとの改行、文字のあとの Markdown のブロック (data-lines を持つ要素)、最初の Markdown のブロックの
// あとの要素で refText を切る。milestone は旧実装のまま (最初の <br> までの意味のある子を数える)
fn describe_first_line(html: &str) -> DescribeFirstLineResult {
    // body.textContent (コメントを含まない) のうち 1 行目の分
    let mut text = String::new();
    // 1 行目が終わったか
    let mut ref_done = false;
    // body の直下に Markdown のブロック (data-lines を持つ要素) が出たか
    let mut seen_block = false;
    // HTML の層は改行を LF で書き、単独の CR は `&#13;` からしか来ないので、1 行目の区切りに数えない。
    // DOM は CR を LF にするが、refText では空白と LF は同じ 1 つの空白になるので空白に置き換えてよい
    let html = html.replace("\r\n", "\n").replace('\r', " ");
    let mut top: Vec<TopNode> = Vec::new();
    let mut open = OpenElements::default();
    // 原文は `<body>${html}</body>` を読むので、閉じの `</body>` までを字句に分ける (`a </` の `</` はその `<` とつながってコメントになる)
    for token in read_html(&format!("{html}</body>")) {
        match token {
            // 最初の <br> から body の最後までを削る。<br> を含む祖先の要素は、<br> より前の部分だけが残る。
            // HTML の仕様では `</br>` も <br> になる。svg の中の <br> は svg ごと除かれるので数えない
            HtmlToken::Start { name, .. } | HtmlToken::End { name } if name == "br" => {
                if let Placement::Inserted { removed: false, .. } = open.start("br", false, &[]) {
                    break;
                }
            }
            HtmlToken::Start {
                name,
                self_closing,
                attributes,
            } => {
                // `querySelectorAll('svg')` の remove: svg とその中は数えない
                if let Placement::Inserted {
                    top_level: true,
                    removed: false,
                } = open.start(&name, self_closing, &attributes)
                {
                    let block = attributes.iter().any(|attribute| attribute == "data-lines");
                    if seen_block || (block && !normalize_ref_text(&text).is_empty()) {
                        ref_done = true;
                    }
                    seen_block |= block;
                    top.push(TopNode::Element {
                        name,
                        text: String::new(),
                    });
                }
            }
            HtmlToken::End { name } => open.end(&name),
            HtmlToken::Text(value) => match open.text_placement(&value) {
                Placement::Inserted { removed: true, .. } | Placement::Ignored => {}
                Placement::Inserted {
                    top_level,
                    removed: false,
                } => {
                    if !ref_done {
                        match value.find('\n') {
                            Some(end)
                                if top_level
                                    && !normalize_ref_text(&format!("{text}{}", &value[..end]))
                                        .is_empty() =>
                            {
                                text.push_str(&value[..end]);
                                ref_done = true;
                            }
                            _ => text.push_str(&value),
                        }
                    }
                    if top_level {
                        // 隣り合う文字のノードは、意味のある子の数に効かないのでつなげない (svg を除いたあとの DOM でもつながらない)
                        top.push(TopNode::Text(value));
                    } else if let Some(TopNode::Element { text: inner, .. }) = top.last_mut() {
                        inner.push_str(&value);
                    }
                }
            },
            // コメントの textContent は中身 (意味のある子に数える)。要素の中のコメントは要素の textContent に入らない
            HtmlToken::Comment(data) => {
                if open.is_empty() {
                    top.push(TopNode::Comment(data));
                }
            }
        }
    }
    let meaningful: Vec<&TopNode> = top
        .iter()
        .filter(|node| {
            let content = match node {
                TopNode::Text(value)
                | TopNode::Element { text: value, .. }
                | TopNode::Comment(value) => value,
            };
            !normalize_ref_text(content).is_empty()
        })
        .collect();
    let milestone =
        matches!(meaningful.as_slice(), [TopNode::Element { name, .. }] if name == "strong");
    DescribeFirstLineResult {
        ref_text: normalize_ref_text(&text),
        milestone,
    }
}

/// 名前を持たないノード (A-219) の内容の、最初の行の文字。参照が見つからないとき、名前を持たないノードを
/// 文字で指そうとしたのかを見分けて案内する (model 層の ref-not-found の hint)
pub(crate) fn nameless_content(html: &str) -> String {
    describe_first_line(html).ref_text
}

// 詳細の引用ブロックに付ける印 (クラス)。描画の側は、この印で詳細を隠したり、その場に開いて見せたりする
const DETAILS_CLASS: &str = "mdag-details";

/// splitDetails の戻り値 (名前のない型。規則 4 章「関数名 + Result」)
#[derive(Debug, Clone, PartialEq)]
struct SplitDetailsResult {
    html: String,
    plain: String,
    details: Option<String>,
}

/// 原文: splitDetails
/// ノードの内容から、詳細 (Markdown の引用ブロック) を見分ける。引用ブロックは書かれた位置に残して印だけを付け (html)、
/// 参照用のテキストを取り出すための、詳細を除いた内容 (plain) と、詳細だけをまとめたもの (details) も返す。
/// 詳細は項目の直下の Markdown の引用ブロック (アウトラインの parts の Quote。原文の `:scope > blockquote[data-lines]`) で、
/// HTML のタグで直接書いた blockquote は行番号の属性を持たないので対象にならず、内容として表示される (DESIGN (a))。
/// html は記号を絵にしたあとの内容、parts は同じ内容を引用ブロックの前後で分けたもの (先頭の断片にも同じ絵を当ててある)
fn split_details(html: &str, parts: &[ContentPart]) -> SplitDetailsResult {
    let mut marked = String::new();
    let mut plain = String::new();
    let mut details: Vec<String> = Vec::new();
    for part in parts {
        match part {
            ContentPart::Html(outside) => {
                marked.push_str(outside);
                plain.push_str(outside);
            }
            // 生の HTML の閉じていない要素のあとの引用ブロックは、DOM ではその要素の中に入るので `:scope >` に当たらず、内容のまま
            ContentPart::Quote { open, inner, close } if !is_top_level_after(&marked) => {
                let element = format!("{open}{inner}{close}");
                marked.push_str(&element);
                plain.push_str(&element);
            }
            ContentPart::Quote { open, inner, close } => {
                // 開きのタグの終わりは open の最初の `>` (属性の値の `>` は文字参照になっている)。閉じは `</blockquote>` と後ろの改行
                let (Some((tag, after_tag)), Some((_, after_element))) =
                    (open.split_once('>'), close.split_once('>'))
                else {
                    // TODO(port): Rust 側の不到達 (開きと閉じのトークンの書き出しは必ず `>` を持つ)
                    marked.push_str(&format!("{open}{inner}{close}"));
                    continue;
                };
                // classList.add の直列化は、既にある属性 (data-lines) のあとに class を書く
                marked.push_str(&format!(
                    "{tag} class=\"{DETAILS_CLASS}\">{after_tag}{inner}{close}"
                ));
                // quote.remove(): 要素の外の文字 (前の隠れた段落のあとの改行と、閉じのタグのあとの改行) は残る
                plain.push_str(
                    tag.split_once('<')
                        .map_or("", |(before_element, _)| before_element),
                );
                plain.push_str(after_element);
                // quote.innerHTML.trim(): 開きのタグの直後 (needLf の改行) から閉じのタグの前まで
                details.push(
                    trim_serialized(&normalize_newlines(&format!("{after_tag}{inner}")))
                        .to_string(),
                );
            }
        }
    }
    // `quotes.length === 0`: 詳細がなければ、内容をそのまま (trim もしない)
    if details.is_empty() {
        return SplitDetailsResult {
            html: html.to_string(),
            plain: html.to_string(),
            details: None,
        };
    }
    // body.innerHTML.trim(): DOM に読んだあとの直列化なので、CR は LF になっている
    SplitDetailsResult {
        html: trim_serialized(&normalize_newlines(&marked)).to_string(),
        plain: trim_serialized(&normalize_newlines(&plain)).to_string(),
        details: Some(details.join("\n")),
    }
}

// DOMParser の入力の前処理 (HTML の仕様の input stream の preprocessing): CRLF と CR を LF にする。
// HTML の層は `&#13;` を生の CR として書き出すので、DOM に読んだ文字と直列化では LF になる
fn normalize_newlines(html: &str) -> String {
    html.replace("\r\n", "\n").replace('\r', "\n")
}

// 直列化 (innerHTML) の結果にかける trim。innerHTML は U+00A0 を `&nbsp;` と書くので、原文の trim はそれを落とさない (A-146 (3))。
// ここの文字列は直列化し直していない (U+00A0 のまま) ので、U+00A0 を除いた JS の空白で trim する
fn trim_serialized(text: &str) -> &str {
    text.trim_matches(|c: char| c != '\u{a0}' && JS_WHITESPACE.contains(&c))
}

// 内容の先頭から引用ブロックの開きの前までを DOM に読んだとき、続く引用ブロックの開きが body の直下に入るか。
// 開きのタグそのものも木の組み立ての規則に通す: svg / math の中なら外に出し、button scope の p を閉じ、表の中なら表の前に出す (foster parenting)
// 台帳 107 行の写し先 (AST の BlockQuote) に、この判定を足している
// (台帳 107 行、A-138 (2)、A-145)
fn is_top_level_after(html: &str) -> bool {
    let mut open = OpenElements::default();
    for token in read_html(html) {
        match token {
            HtmlToken::Start {
                name,
                self_closing,
                attributes,
            } => {
                open.start(&name, self_closing, &attributes);
            }
            // `</br>` は <br> と同じ
            HtmlToken::End { name } if name == "br" => {
                open.start("br", false, &[]);
            }
            HtmlToken::End { name } => open.end(&name),
            HtmlToken::Text(_) | HtmlToken::Comment(_) => {}
        }
    }
    matches!(
        open.start("blockquote", false, &[]),
        Placement::Inserted {
            top_level: true,
            ..
        }
    )
}

/// 原文: taskAt
/// タスクになるのは、リスト項目と見出し。どちらも 1 行目が状態の記号 (`[ ]`, `[/]`, `[x]`, `[X]`, `[-]`) から始まるもの
// 台帳 111 行: 要素の種類は tag の文字でなくアウトラインの BlockTag から。line は行の範囲の開始 (範囲がなければ None。原文の NaN)
fn task_at(source_lines: &[&str], line: Option<u32>, tag: Option<BlockTag>) -> Option<TaskInfo> {
    let kind = match tag {
        Some(BlockTag::Li) => TaskLineKind::Item,
        Some(BlockTag::Heading(_)) => TaskLineKind::Heading,
        _ => return None,
    };
    // `sourceLines[NaN] ?? ''` は空の行なのでタスクでない
    let line = line?;
    let text = source_lines.get(line as usize).copied().unwrap_or("");
    let state = task_state_of(task_mark_at(text, kind)?);
    Some(TaskInfo {
        line,
        state,
        checked: state == TaskState::Done,
    })
}

// 作業中と中止の絵は、未完了の枠の中に印を足した形。左半分の塗りと横線で、枠が HTML の層の絵 (viewBox「0 -3 24 24」、枠の内側は 6〜18) であることを前提にしている
const DOING_FILL: &str = r#"<path d="M7 6h5v12H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/>"#;
const CANCELED_BAR: &str = r#"<path d="M8 11h8v2H8z"/>"#;

// 原文の inside (document.ts:240)。`frame.replace(/<\/svg>$/, ...)`: 末尾の `</svg>` の前に足す (末尾になければそのまま)
fn inside(frame: &str, shape: &str) -> String {
    match frame.strip_suffix("</svg>") {
        Some(head) => format!("{head}{shape}</svg>"),
        None => frame.to_string(),
    }
}

/// 原文: markIconsOf
/// 状態の記号の代わりに描く絵。未完了と完了は HTML の層の checkbox の絵 (自前で描いたもの。A-151)、
/// 作業中と中止は未完了の枠に印を足して作る。原文は変換器ごとに小さな文書を変換して絵を取り出し WeakMap に記憶したが、
/// 変換器はなくなったので固定の絵を返す (台帳 100 行。記号を絵にしない構成はないので null にならない)
fn mark_icons_of() -> TaskIcons {
    TaskIcons {
        todo: UNMARKED.to_string(),
        done: MARKED.to_string(),
        doing: inside(UNMARKED, DOING_FILL),
        canceled: inside(UNMARKED, CANCELED_BAR),
    }
}

// `icons[state]` (規則 2.1: Record<TaskState, string> は欄が決まった struct)
fn icon_of(icons: &TaskIcons, state: TaskState) -> &str {
    match state {
        TaskState::Todo => &icons.todo,
        TaskState::Doing => &icons.doing,
        TaskState::Done => &icons.done,
        TaskState::Canceled => &icons.canceled,
    }
}

/// 原文: drawLeadingMark
/// 変換器が絵にせず文字のまま残した状態の記号を、ほかのタスクと見た目も参照用のテキストもそろうよう、同じ絵に置き換える。
/// HTML の層は `[ ]` と `[x]` を絵にするので、残るのは `[/]` と `[-]` (原文の変換器では文書の最初のブロックの見出しの記号も残った)
fn draw_leading_mark(html: &str, icons: &TaskIcons) -> String {
    let Some(mark) = LEADING_MARK
        .captures(html)
        .and_then(|captures| captures.get(1))
        .and_then(|found| TaskMark::from_js(&JsValue::String(found.as_str().to_string())))
    else {
        return html.to_string();
    };
    // 規則 2.2: g なしの replace は 1 回。閉包の置き換えなので `$` を展開しない
    LEADING_MARK
        .replace(
            html,
            NoExpand(&format!("{} ", icon_of(icons, task_state_of(mark)))),
        )
        .into_owned()
}

/// 原文: replaceLeadingMark
/// ノードの内容の先頭にある状態の記号を、別の状態のものに差し替える。絵なら絵、文字のままなら文字を差し替え、どちらでもなければそのまま。
/// 原文を解析し直せない場面 (単体の HTML) で、タスクの状態だけを進めるのに使う
pub fn replace_leading_mark(html: &str, state: TaskState, icons: Option<&TaskIcons>) -> String {
    if let Some(icons) = icons
        && LEADING_ICON.is_match(html)
    {
        return LEADING_ICON
            .replace(html, NoExpand(icon_of(icons, state)))
            .into_owned();
    }
    LEADING_MARK
        .replace(
            html,
            NoExpand(&format!("[{}] ", task_mark_of(state).as_str())),
        )
        .into_owned()
}

// visit が捕まえる値のうち読むだけのもの (規則 2.6: 再帰する閉包は、捕まえた変数を引数にした自由な関数に写す。
// 引数が多いので読むだけの値を 1 つにまとめた)
struct VisitScope<'v> {
    annotations: &'v IndexMap<usize, LineAnnotation>,
    source_lines: &'v [&'v str],
    extracted: bool,
    // `typeof frontmatter.title === 'string' ? frontmatter.title : ''`
    title: &'v str,
    icons: &'v TaskIcons,
}

// 原文: parseDocument の中の visit (document.ts:285-311)。木を先行順にたどってノードにする。規則 2.6: 閉包を自由な関数に
fn visit(
    node: &OutlineTree,
    parent: Option<u32>,
    depth: u32,
    nodes: &mut Vec<OutlineNode>,
    scope: &VisitScope<'_>,
) {
    let id = to_u32(nodes.len() + 1);
    let lines = node.lines.clone();
    // 台帳 104 行: `annotations.get(lines?.start ?? NaN)`。行の範囲がなければ注釈もタスクもない
    let start_line = lines.as_ref().map(|range| range.start);
    let annotation = start_line.and_then(|start| scope.annotations.get(&(start as usize)));
    let task = task_at(scope.source_lines, start_line, node.tag);
    let (content, parts) = if task.is_none() {
        (node.content.clone(), node.parts.clone())
    } else {
        // 記号は内容の先頭にだけあるので、引用ブロックの前後で分けた断片の先頭にも同じ置き換えを当てる
        let parts = node
            .parts
            .iter()
            .enumerate()
            .map(|(index, part)| match part {
                ContentPart::Html(outside) if index == 0 => {
                    ContentPart::Html(draw_leading_mark(outside, scope.icons))
                }
                other => other.clone(),
            })
            .collect();
        (draw_leading_mark(&node.content, scope.icons), parts)
    };
    let SplitDetailsResult {
        html,
        plain,
        details,
    } = if scope.extracted {
        split_details(&content, &parts)
    } else {
        SplitDetailsResult {
            html: content.clone(),
            plain: content,
            details: None,
        }
    };
    let first_line = describe_first_line(&plain);
    // 規則 2.1 の `a || b`: 1 行目の文字が空ならルートだけ title で補う。名前を持たないノード (1 行目が空の項目など。A-219) は
    // 内容の最初の行の文字を使わない
    let ref_text = if node.named && !first_line.ref_text.is_empty() {
        first_line.ref_text
    } else if parent.is_none() {
        normalize_ref_text(scope.title)
    } else {
        String::new()
    };
    let (ref_id, groups, tags) = match annotation {
        Some(annotation) => (
            annotation.ref_id.clone(),
            annotation.groups.clone(),
            annotation.tags.clone(),
        ),
        None => (None, Vec::new(), Vec::new()),
    };
    nodes.push(OutlineNode {
        id,
        parent,
        depth,
        html,
        ref_text,
        ref_id,
        groups,
        tags,
        milestone: scope.extracted && first_line.milestone,
        fold_hint: f64::from(node.fold),
        lines,
        task,
        details,
    });
    for child in &node.children {
        visit(child, Some(id), depth + 1, nodes, scope);
    }
}

/// 原文: parseDocument
/// 原文を前処理 (大文字の記号、注釈) してから木にし、先行順にノードの列にする。原文の変換器の引数はない (DESIGN (c))。
/// styleUrls は返さず、数式とコードの有無 (features) を返す。URL は TS の包みが作る (決定 12 (a))
pub fn parse_document(original: &str) -> ParsedDocument {
    // 行と桁は変えないので、このあとの行番号は原文のものとしてそのまま使える
    let source = normalize_task_marks(original);
    let ProbeFrontmatterResult {
        frontmatter,
        extracted,
    } = probe_frontmatter(&source);

    let StripAnnotationsResult { text, annotations } = if extracted {
        strip_annotations(&source)
    } else {
        StripAnnotationsResult {
            text: source.clone(),
            annotations: IndexMap::new(),
        }
    };
    // 原文の `extracted ? transformer.transform(text) : probe`。注釈を落としても frontmatter の行は変わらないので、
    // どちらも本文の切り出しと木の組み立ては同じ手順
    let read = read_frontmatter(&text);
    let (body, frontmatter_lines) = match &read {
        Some(info) => (js_slice(&text, info.offset, text.len()), info.lines),
        None => (text.as_str(), 0),
    };
    let arena = Arena::new();
    let outline = build_outline(
        &arena,
        body,
        frontmatter_lines,
        read.as_ref().map(|info| &info.value),
        extracted,
    );

    let source_lines: Vec<&str> = source.split('\n').collect();
    let title = match &frontmatter {
        JsValue::Object(map) => match map.get("title") {
            Some(JsValue::String(title)) => title.as_str(),
            _ => "",
        },
        _ => "",
    };
    let icons = mark_icons_of();
    let scope = VisitScope {
        annotations: &annotations,
        source_lines: &source_lines,
        extracted,
        title,
        icons: &icons,
    };
    let mut nodes: Vec<OutlineNode> = Vec::new();
    visit(&outline.root, None, 1, &mut nodes, &scope);

    ParsedDocument {
        nodes,
        frontmatter,
        extracted,
        task_icons: Some(icons),
        features: outline.features,
    }
}

// ---- 書き出した HTML を DOM と同じ順で読む (describeFirstLine と splitDetails の DOMParser の代わり) ----
// HTML の仕様の字句の規則 (tokenizer) のうち文字と要素の並びに効くものと、木の組み立て (tree construction) のうち
// 「要素と文字が body の直下に入るか、svg の中か」に効くもの (OpenElements) を写す。どちらも生の HTML でしか効かない
// (HTML の層が Markdown から書く HTML はすべて明示的に閉じる)。旧実装は項目の HTML を cheerio (htmlparser2) で読み直してから
// DOMParser に渡すので、閉じのタグと <table> の p の閉じだけは htmlparser2 の結果に合わせる (A-145)。
// TODO(port): 次の規則は写さない。旧実装の DOM と違いうる (差として認めた。accepted.md の 22 (A-144 の (a))):
//   字句: RAWTEXT / RCDATA / PLAINTEXT への切り替えを要素の名前だけで決める (svg / math の中の <style> <script> <title> <textarea>
//         <plaintext> も切り替える)、foreign content の中の CDATA (`<![CDATA[…]]>`) を bogus comment として読む、
//         encoding の値で決まる annotation-xml の HTML integration point、名前つき文字参照は一部だけ (A-139)、U+0000 の扱い
//   木: 表の foster parenting で前に出した文字と要素の DOM の順 (textContent と最初の <br> の順。body の直下かどうかは写す)、
//       書式の要素の組み直し (adoption agency と active formatting elements の再構築)、li / dd / dt / option の暗黙の閉じ、
//       表の中の <table> <form> <input>、template の中身 (DocumentFragment に入り textContent にも querySelector にも入らない)、
//       `</body>` のあとのコメント (html 要素に入る)、対のない `</p>` が作る空の p、
//       cheerio (htmlparser2) の読み直しのうち閉じのタグと <table> のほかの差 (閉じていない要素の閉じの位置など。A-142 (4))

/// HTML の字句 1 つ
#[derive(Debug, Clone, PartialEq)]
enum HtmlToken {
    /// 文字 (文字参照を読んだあと)
    Text(String),
    /// 開きのタグ。attributes は属性の名前 (値は読まない)
    Start {
        name: String,
        self_closing: bool,
        attributes: Vec<String>,
    },
    End {
        name: String,
    },
    Comment(String),
}

// 閉じのタグを持たない要素 (HTML の仕様の void elements)
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input",
    "keygen", "link", "meta", "param", "source", "track", "wbr",
];
// 中身をタグとして読まない要素 (RAWTEXT)。textarea と title は文字参照だけを読む (RCDATA)
const RAW_TEXT_ELEMENTS: &[&str] = &["script", "style", "xmp", "iframe", "noembed", "noframes"];
const RC_DATA_ELEMENTS: &[&str] = &["textarea", "title"];

// svg と math の中で HTML の要素として扱われ、外に出る開きのタグ (HTML の仕様の「in foreign content」の一覧と、color / face / size の属性を持つ font)。
// 閉じの `</br>` と `</p>` も外に出る
fn breaks_out_of_foreign(name: &str, attributes: &[String]) -> bool {
    const BREAKOUT: &[&str] = &[
        "b",
        "big",
        "blockquote",
        "body",
        "br",
        "center",
        "code",
        "dd",
        "div",
        "dl",
        "dt",
        "em",
        "embed",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "head",
        "hr",
        "i",
        "img",
        "li",
        "listing",
        "menu",
        "meta",
        "nobr",
        "ol",
        "p",
        "pre",
        "ruby",
        "s",
        "small",
        "span",
        "strong",
        "strike",
        "sub",
        "sup",
        "table",
        "tt",
        "u",
        "ul",
        "var",
    ];
    BREAKOUT.contains(&name)
        || (name == "font"
            && attributes
                .iter()
                .any(|attribute| matches!(attribute.as_str(), "color" | "face" | "size")))
}

// body の中 (in body) で無視される開きのタグ。表の部品は表の外でだけ無視される
const IGNORED_IN_BODY: &[&str] = &["html", "head", "body", "frame"];
const TABLE_PARTS: &[&str] = &[
    "caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr",
];
// button scope に p があれば閉じる開きのタグ。<table> は DOMParser (DOCTYPE がなく quirks mode) だけなら p を閉じないが、
// 旧実装は先に cheerio (htmlparser2) が <table> で p を閉じて直列化し直すので、閉じる側に入れる (A-145)
const CLOSES_P: &[&str] = &[
    "table",
    "address",
    "article",
    "aside",
    "blockquote",
    "center",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "header",
    "hgroup",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "search",
    "section",
    "summary",
    "ul",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "listing",
    "form",
    "li",
    "dd",
    "dt",
    "plaintext",
    "hr",
    "xmp",
];
const HEADINGS: &[&str] = &["h1", "h2", "h3", "h4", "h5", "h6"];
// 表の中で current node がこれらのとき、表の部品でない要素と文字は表の前に出される (foster parenting)
const FOSTER_TARGETS: &[&str] = &["table", "tbody", "tfoot", "thead", "tr"];

// 要素の名前空間 (木の組み立てが要素に付けるもの)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Namespace {
    Html,
    Svg,
    MathMl,
}

// 開いている要素 1 つ。名前は ASCII の小文字 (svg の foreignObject は foreignobject)
#[derive(Debug, Clone, PartialEq)]
struct OpenElement {
    name: String,
    namespace: Namespace,
}

impl OpenElement {
    fn is_html(&self, name: &str) -> bool {
        self.namespace == Namespace::Html && self.name == name
    }

    // svg の HTML integration point (中の開きのタグを HTML として読む)
    fn is_html_integration_point(&self) -> bool {
        self.namespace == Namespace::Svg
            && matches!(self.name.as_str(), "foreignobject" | "desc" | "title")
    }

    // MathML の text integration point (mglyph と malignmark のほかの開きのタグを HTML として読む)
    fn is_mathml_text_integration_point(&self) -> bool {
        self.namespace == Namespace::MathMl
            && matches!(self.name.as_str(), "mi" | "mo" | "mn" | "ms" | "mtext")
    }

    // 「has an element in button scope」の境界 (default scope の境界と button)
    fn is_button_scope_boundary(&self) -> bool {
        match self.namespace {
            Namespace::Html => matches!(
                self.name.as_str(),
                "applet"
                    | "caption"
                    | "html"
                    | "table"
                    | "td"
                    | "th"
                    | "marquee"
                    | "object"
                    | "template"
                    | "button"
            ),
            Namespace::MathMl => {
                self.is_mathml_text_integration_point() || self.name == "annotation-xml"
            }
            Namespace::Svg => self.is_html_integration_point(),
        }
    }
}

// 要素か文字を木に入れた場所。top_level は body の直下、removed は svg の中 (describeFirstLine が svg ごと除く)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    Ignored,
    Inserted { top_level: bool, removed: bool },
}

// 開いている要素の列 (HTML の仕様の stack of open elements のうち body より内側)
#[derive(Debug, Default)]
struct OpenElements {
    stack: Vec<OpenElement>,
}

impl OpenElements {
    fn is_empty(&self) -> bool {
        self.stack.is_empty()
    }

    // 開きのタグを HTML でなく foreign content の規則で読むか (adjusted current node が svg / math の要素で、integration point でない)
    fn in_foreign_content(&self, name: &str) -> bool {
        match self.stack.last() {
            None => false,
            Some(current)
                if current.namespace == Namespace::Html || current.is_html_integration_point() =>
            {
                false
            }
            Some(current) if current.is_mathml_text_integration_point() => {
                matches!(name, "mglyph" | "malignmark")
            }
            Some(current)
                if current.namespace == Namespace::MathMl && current.name == "annotation-xml" =>
            {
                name != "svg"
            }
            Some(_) => true,
        }
    }

    // foreign content から外に出る: HTML の要素か integration point まで閉じる
    fn break_out_of_foreign(&mut self) {
        while self.stack.last().is_some_and(|current| {
            current.namespace != Namespace::Html
                && !current.is_html_integration_point()
                && !current.is_mathml_text_integration_point()
        }) {
            self.stack.pop();
        }
    }

    // 表の中で、current node の前に出される (foster parenting) なら、表の親の位置 (最後の table の添字)
    fn foster_parent(&self) -> Option<usize> {
        let current = self.stack.last()?;
        if current.namespace != Namespace::Html || !FOSTER_TARGETS.contains(&current.name.as_str())
        {
            return None;
        }
        self.stack
            .iter()
            .rposition(|element| element.is_html("table"))
    }

    // 要素を parent (列の添字。その手前までが祖先) の中に入れる。closed なら開いたままにしない
    fn insert(
        &mut self,
        name: &str,
        namespace: Namespace,
        closed: bool,
        parent: usize,
    ) -> Placement {
        let removed = name == "svg"
            || self.stack[..parent]
                .iter()
                .any(|element| element.name == "svg");
        if !closed {
            self.stack.push(OpenElement {
                name: name.to_string(),
                namespace,
            });
        }
        Placement::Inserted {
            top_level: parent == 0,
            removed,
        }
    }

    fn start(&mut self, name: &str, self_closing: bool, attributes: &[String]) -> Placement {
        if self.in_foreign_content(name) {
            if !breaks_out_of_foreign(name, attributes) {
                // foreign の要素は current node と同じ名前空間。自己閉じは閉じになる
                let namespace = self
                    .stack
                    .last()
                    .map_or(Namespace::Html, |current| current.namespace);
                return self.insert(name, namespace, self_closing, self.stack.len());
            }
            self.break_out_of_foreign();
        }
        let in_table = self.stack.iter().any(|element| element.is_html("table"));
        if IGNORED_IN_BODY.contains(&name) || (TABLE_PARTS.contains(&name) && !in_table) {
            return Placement::Ignored;
        }
        if CLOSES_P.contains(&name) {
            self.close_p_in_button_scope();
        }
        // 見出しの中の見出しの開きは、前の見出しを閉じる
        if HEADINGS.contains(&name)
            && self
                .stack
                .last()
                .is_some_and(|current| HEADINGS.iter().any(|h| current.is_html(h)))
        {
            self.stack.pop();
        }
        // 列の colgroup の中では、col のほかの開きのタグが colgroup を閉じて表の規則に戻る
        if name != "col"
            && self
                .stack
                .last()
                .is_some_and(|current| current.is_html("colgroup"))
        {
            self.stack.pop();
        }
        let fostered = !TABLE_PARTS.contains(&name)
            && !matches!(name, "table" | "style" | "script" | "template");
        let parent = self
            .foster_parent()
            .filter(|_| fostered)
            .unwrap_or(self.stack.len());
        let namespace = match name {
            "svg" => Namespace::Svg,
            "math" => Namespace::MathMl,
            _ => Namespace::Html,
        };
        // HTML の要素の自己閉じ (`<b/>`) は閉じにならない (void 要素だけが閉じを持たない)
        let closed = if namespace == Namespace::Html {
            VOID_ELEMENTS.contains(&name)
        } else {
            self_closing
        };
        self.insert(name, namespace, closed, parent)
    }

    fn close_p_in_button_scope(&mut self) {
        for index in (0..self.stack.len()).rev() {
            if self.stack[index].is_html("p") {
                self.stack.truncate(index);
                return;
            }
            if self.stack[index].is_button_scope_boundary() {
                return;
            }
        }
    }

    // 閉じのタグ。同じ名前の開いている要素まで、その内側で開いたままの要素もまとめて閉じる。対のない閉じは捨てる。
    // HTML の仕様の scope (表や integration point を越えて閉じない) は見ない: 旧実装は項目の HTML を cheerio (htmlparser2) で
    // 読んで直列化し直してから DOMParser に渡すので、閉じのタグは htmlparser2 のとおり、どこにあっても最も近い同じ名前の要素を閉じる
    // (`- a <p>x<table></p>` や `- a <div><table></div>` のあとの引用ブロックを旧実装は詳細にする。A-145)
    fn end(&mut self, name: &str) {
        // svg / math の中の `</p>` は外に出てから読む (対の p がなければ、htmlparser2 が書き足す空の p が svg の外に出る)
        if name == "p"
            && self
                .stack
                .last()
                .is_some_and(|current| current.namespace != Namespace::Html)
        {
            self.break_out_of_foreign();
        }
        if let Some(index) = self.stack.iter().rposition(|element| element.name == name) {
            self.stack.truncate(index);
        }
    }

    // 文字の入る場所 (表の中の空白でない文字は表の前に出される)
    fn text_placement(&self, text: &str) -> Placement {
        let parent = match self.foster_parent() {
            Some(table) if !text.chars().all(is_html_space) => table,
            _ => self.stack.len(),
        };
        let removed = self.stack[..parent]
            .iter()
            .any(|element| element.name == "svg");
        Placement::Inserted {
            top_level: parent == 0,
            removed,
        }
    }
}

// HTML の仕様の空白 (タブ、改行、改頁、復帰、空白)
fn is_html_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{c}' | '\r' | ' ')
}

fn read_html(html: &str) -> Vec<HtmlToken> {
    let html = normalize_newlines(html);
    let mut tokens = Vec::new();
    let mut rest = html.as_str();
    while let Some((text, after)) = rest.split_once('<') {
        if !text.is_empty() {
            tokens.push(HtmlToken::Text(decode_char_refs(text)));
        }
        let mut chars = after.chars();
        rest = match chars.next() {
            Some(c) if c.is_ascii_alphabetic() => match read_tag(after) {
                Some((name, self_closing, attributes, next)) => {
                    let raw = RAW_TEXT_ELEMENTS.contains(&name.as_str());
                    let rc = RC_DATA_ELEMENTS.contains(&name.as_str());
                    let plaintext = name == "plaintext";
                    tokens.push(HtmlToken::Start {
                        name: name.clone(),
                        self_closing,
                        attributes,
                    });
                    if plaintext {
                        // PLAINTEXT: 残りはすべて文字 (閉じのタグも文字参照も読まない)
                        if !next.is_empty() {
                            tokens.push(HtmlToken::Text(next.to_string()));
                        }
                        ""
                    } else if raw || rc {
                        read_raw_text(next, &name, rc, &mut tokens)
                    } else {
                        next
                    }
                }
                // タグの途中で終わると、そのタグは捨てられる
                None => "",
            },
            Some('/') => {
                let after_slash = chars.as_str();
                let mut chars = after_slash.chars();
                match chars.next() {
                    Some(c) if c.is_ascii_alphabetic() => match read_tag(after_slash) {
                        Some((name, _, _, next)) => {
                            tokens.push(HtmlToken::End { name });
                            next
                        }
                        None => "",
                    },
                    // `</>` は何も作らない
                    Some('>') => chars.as_str(),
                    // `</` で終わる文字は文字のまま
                    None => {
                        tokens.push(HtmlToken::Text("</".to_string()));
                        ""
                    }
                    // それ以外は閉じの `>` までを中身にしたコメント (bogus comment)
                    Some(_) => bogus_comment(after_slash, &mut tokens),
                }
            }
            Some('!') => {
                let after_bang = chars.as_str();
                match after_bang.strip_prefix("--") {
                    Some(comment) => read_comment(comment, &mut tokens),
                    // body の中の DOCTYPE は捨てられる
                    None if after_bang
                        .get(..7)
                        .is_some_and(|head| head.eq_ignore_ascii_case("doctype")) =>
                    {
                        after_bang.split_once('>').map_or("", |(_, next)| next)
                    }
                    None => bogus_comment(after_bang, &mut tokens),
                }
            }
            Some('?') => bogus_comment(after, &mut tokens),
            // タグにならない `<` は文字
            _ => {
                tokens.push(HtmlToken::Text("<".to_string()));
                after
            }
        };
    }
    if !rest.is_empty() {
        tokens.push(HtmlToken::Text(decode_char_refs(rest)));
    }
    tokens
}

// タグの名前と属性を `>` まで読む (input は `<` か `</` の直後)。タグと属性の名前は ASCII の小文字にする。
// 属性の値は捨てる (木の組み立てが見るのは属性の名前だけ)。`>` の前に終わったら None
fn read_tag(input: &str) -> Option<(String, bool, Vec<String>, &str)> {
    let stops_name = |c: char| is_html_space(c) || c == '/' || c == '>';
    let name: String = input
        .chars()
        .take_while(|c| !stops_name(*c))
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let mut rest = input.trim_start_matches(|c: char| !stops_name(c));
    let mut self_closing = false;
    let mut attributes: Vec<String> = Vec::new();
    loop {
        rest = rest.trim_start_matches(is_html_space);
        let mut chars = rest.chars();
        match chars.next() {
            None => return None,
            Some('>') => return Some((name, self_closing, attributes, chars.as_str())),
            // `/` はすぐ後ろが `>` のときだけ自己閉じ
            Some('/') => {
                rest = chars.as_str();
                self_closing = rest.starts_with('>');
            }
            Some(first) => {
                self_closing = false;
                // 属性の名前 (最初の字は `=` でも名前に含める)
                let stops_attribute =
                    |c: char| is_html_space(c) || c == '/' || c == '>' || c == '=';
                let after_first = chars.as_str();
                attributes.push(
                    std::iter::once(first)
                        .chain(after_first.chars().take_while(|c| !stops_attribute(*c)))
                        .map(|c| c.to_ascii_lowercase())
                        .collect(),
                );
                rest = after_first.trim_start_matches(|c: char| !stops_attribute(c));
                let after_name = rest.trim_start_matches(is_html_space);
                if let Some(value) = after_name.strip_prefix('=') {
                    let value = value.trim_start_matches(is_html_space);
                    rest = match value.chars().next() {
                        Some(quote @ ('"' | '\'')) => {
                            let quoted = value.strip_prefix(quote).unwrap_or(value);
                            let (_, next) = quoted.split_once(quote)?;
                            next
                        }
                        _ => value.trim_start_matches(|c: char| !(is_html_space(c) || c == '>')),
                    };
                } else {
                    rest = after_name;
                }
            }
        }
    }
}

// RAWTEXT と RCDATA の中身を、同じ名前の閉じのタグ (`</name` のあとに空白、`/`、`>`) まで文字として読む。閉じがなければ最後まで文字
fn read_raw_text<'h>(
    input: &'h str,
    name: &str,
    char_refs: bool,
    tokens: &mut Vec<HtmlToken>,
) -> &'h str {
    let mut text = String::new();
    let mut rest = input;
    let closes = |candidate: &str| {
        let mut chars = candidate.chars();
        name.chars().all(|expected| {
            chars
                .next()
                .is_some_and(|c| c.to_ascii_lowercase() == expected)
        }) && chars
            .next()
            .is_some_and(|c| is_html_space(c) || c == '/' || c == '>')
    };
    let next = loop {
        match rest.split_once("</") {
            None => {
                text.push_str(rest);
                break None;
            }
            Some((before, after)) => {
                text.push_str(before);
                if closes(after) {
                    break Some(after);
                }
                text.push_str("</");
                rest = after;
            }
        }
    };
    if !text.is_empty() {
        tokens.push(HtmlToken::Text(if char_refs {
            decode_char_refs(&text)
        } else {
            text
        }));
    }
    let Some(after) = next else {
        return "";
    };
    match read_tag(after) {
        Some((end, _, _, next)) => {
            tokens.push(HtmlToken::End { name: end });
            next
        }
        None => "",
    }
}

// `<!--` の後ろ。`-->` (か `--!>`) までが中身。`<!-->` と `<!--->` は空のコメント。閉じがなければ最後まで
fn read_comment<'h>(input: &'h str, tokens: &mut Vec<HtmlToken>) -> &'h str {
    if let Some(next) = input.strip_prefix('>').or_else(|| input.strip_prefix("->")) {
        tokens.push(HtmlToken::Comment(String::new()));
        return next;
    }
    let ends = [input.split_once("-->"), input.split_once("--!>")];
    let end = ends
        .into_iter()
        .flatten()
        .min_by_key(|(data, _)| data.len());
    match end {
        Some((data, next)) => {
            tokens.push(HtmlToken::Comment(data.to_string()));
            next
        }
        None => {
            tokens.push(HtmlToken::Comment(input.to_string()));
            ""
        }
    }
}

// 閉じの `>` までを中身にしたコメント (`<?…>`、`<!…>`、`</ …>`)
fn bogus_comment<'h>(input: &'h str, tokens: &mut Vec<HtmlToken>) -> &'h str {
    match input.split_once('>') {
        Some((data, next)) => {
            tokens.push(HtmlToken::Comment(data.to_string()));
            next
        }
        None => {
            tokens.push(HtmlToken::Comment(input.to_string()));
            ""
        }
    }
}

// 文字参照の名前と字。セミコロンのない形 (legacy) を受け入れるものは true
// TODO(port): HTML の仕様の名前つき文字参照 (2231 個) のうち、ここにあるものだけを読む。ほかは文字のまま残る (生の HTML でしか起きない。A-139)
const NAMED_CHAR_REFS: &[(&str, &str, bool)] = &[
    ("amp", "&", true),
    ("AMP", "&", true),
    ("lt", "<", true),
    ("LT", "<", true),
    ("gt", ">", true),
    ("GT", ">", true),
    ("quot", "\"", true),
    ("QUOT", "\"", true),
    ("nbsp", "\u{a0}", true),
    ("apos", "'", false),
];

// 数値の文字参照の 0x80〜0x9F は Windows-1252 の字として読む (HTML の仕様の表)
const C1_REPLACEMENTS: &[(u32, char)] = &[
    (0x80, '\u{20AC}'),
    (0x82, '\u{201A}'),
    (0x83, '\u{0192}'),
    (0x84, '\u{201E}'),
    (0x85, '\u{2026}'),
    (0x86, '\u{2020}'),
    (0x87, '\u{2021}'),
    (0x88, '\u{02C6}'),
    (0x89, '\u{2030}'),
    (0x8A, '\u{0160}'),
    (0x8B, '\u{2039}'),
    (0x8C, '\u{0152}'),
    (0x8E, '\u{017D}'),
    (0x91, '\u{2018}'),
    (0x92, '\u{2019}'),
    (0x93, '\u{201C}'),
    (0x94, '\u{201D}'),
    (0x95, '\u{2022}'),
    (0x96, '\u{2013}'),
    (0x97, '\u{2014}'),
    (0x98, '\u{02DC}'),
    (0x99, '\u{2122}'),
    (0x9A, '\u{0161}'),
    (0x9B, '\u{203A}'),
    (0x9C, '\u{0153}'),
    (0x9E, '\u{017E}'),
    (0x9F, '\u{0178}'),
];

// 文字の中の文字参照を読む (HTML の仕様の character reference state。属性の値でなく文字の中の規則)
fn decode_char_refs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((before, after)) = rest.split_once('&') {
        out.push_str(before);
        match char_ref(after) {
            Some((decoded, next)) => {
                out.push_str(&decoded);
                rest = next;
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

// `&` の後ろの文字参照 1 つ。読めなければ None (`&` は文字のまま)
fn char_ref(after: &str) -> Option<(String, &str)> {
    if let Some(number) = after.strip_prefix('#') {
        let (hex, digits_and_rest) = match number.strip_prefix(['x', 'X']) {
            Some(rest) => (true, rest),
            None => (false, number),
        };
        let is_digit = |c: char| {
            if hex {
                c.is_ascii_hexdigit()
            } else {
                c.is_ascii_digit()
            }
        };
        let rest = digits_and_rest.trim_start_matches(is_digit);
        let digits: Vec<u32> = digits_and_rest
            .chars()
            .take_while(|c| is_digit(*c))
            .filter_map(|c| c.to_digit(16))
            .collect();
        if digits.is_empty() {
            return None;
        }
        let radix = if hex { 16 } else { 10 };
        // 0x10FFFF を越えたら大きさだけが意味を持つので、そこで止める
        let value = digits.iter().fold(0u32, |value, digit| {
            value
                .saturating_mul(radix)
                .saturating_add(*digit)
                .min(0x11_0000)
        });
        let decoded = match value {
            0 => '\u{FFFD}',
            _ => C1_REPLACEMENTS
                .iter()
                .find(|(code, _)| *code == value)
                .map(|(_, c)| *c)
                .or_else(|| char::from_u32(value))
                .unwrap_or('\u{FFFD}'),
        };
        return Some((decoded.to_string(), rest.strip_prefix(';').unwrap_or(rest)));
    }
    let run: String = after
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    let after_run = after.trim_start_matches(|c: char| c.is_ascii_alphanumeric());
    if let Some(next) = after_run.strip_prefix(';')
        && let Some((_, value, _)) = NAMED_CHAR_REFS.iter().find(|(name, _, _)| *name == run)
    {
        return Some((value.to_string(), next));
    }
    // セミコロンのない形は、最も長く一致する名前 (後ろに英数字が続いてもよい)
    let (name, value, _) = NAMED_CHAR_REFS
        .iter()
        .filter(|(name, _, legacy)| *legacy && run.starts_with(name))
        .max_by_key(|(name, _, _)| name.len())?;
    Some((value.to_string(), after.strip_prefix(name).unwrap_or(after)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    // 期待値は原文 (src/parse/document.ts の関数に export を足した写しと、markmap-lib の Transformer) を
    // vite-node で動かして取った (2026-09-24)。YAML の値は JS の JSON.stringify の形 (undefined は "<undefined>"、有限でない数は $number の印)

    fn tag(key: &str, values: &[&str], line: u32, column: u32, length: u32) -> NodeTag {
        NodeTag {
            key: key.to_string(),
            values: values.iter().map(|value| value.to_string()).collect(),
            at: SourcePosition {
                line,
                column,
                length,
            },
        }
    }

    fn annotation(groups: &[&str], tags: Vec<NodeTag>, ref_id: Option<&str>) -> LineAnnotation {
        LineAnnotation {
            groups: groups.iter().map(|group| group.to_string()).collect(),
            tags,
            ref_id: ref_id.map(str::to_string),
        }
    }

    // JsValue を node の JSON.stringify の形 (undefined は "<undefined>") の serde_json の値にする。キーの順は比べない (IndexMap の ==)
    fn node_shape(value: &JsValue) -> serde_json::Value {
        match value {
            JsValue::Undefined => serde_json::Value::String("<undefined>".to_string()),
            JsValue::Array(items) => {
                serde_json::Value::Array(items.iter().map(node_shape).collect())
            }
            JsValue::Object(map) => serde_json::Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), node_shape(item)))
                    .collect(),
            ),
            other => serde_json::to_value(other).expect("JsValue は JSON に書ける"),
        }
    }

    // (原文, 書き換えた本文, 行の添字と注釈)
    type StripCase = (&'static str, &'static str, Vec<(usize, LineAnnotation)>);
    // (原文, 読めた値の JSON, 本文に足す行数, 切り取ったあとの本文)
    type FrontmatterCase = (&'static str, Option<(&'static str, usize, &'static str)>);

    fn keys_of(value: &JsValue) -> Vec<String> {
        match value {
            JsValue::Object(map) => map.keys().cloned().collect(),
            _ => Vec::new(),
        }
    }

    #[test]
    fn annotations_lazy_regexes_compile() {
        // 規則 1 章 (A-021): すべての LazyLock を 1 度触る
        for regex in [
            &*FRONTMATTER,
            &*HEADING,
            &*LIST_ITEM,
            &*FENCE,
            &*SETEXT_UNDERLINE,
            &*TRAILING_TOKEN,
            &*DIGITS_ONLY,
            &*FRONTMATTER_OPEN,
            &*FRONTMATTER_CLOSE,
            &*LINE_BREAK,
        ] {
            assert!(!regex.as_str().is_empty());
        }
        assert!(UPPER_MARK.find("- [X] a").is_some());
    }

    #[test]
    fn annotations_parse_tag_matches_node() {
        let at = SourcePosition {
            line: 1,
            column: 2,
            length: 3,
        };
        let cases: &[(&str, &str, &[&str])] = &[
            ("#k", "k", &[]),
            ("#k:v", "k", &["v"]),
            ("#k:a,b", "k", &["a", "b"]),
            ("#k:a,,b,", "k", &["a", "b"]),
            ("#k:\"x y\"", "k", &["x y"]),
            ("#k:\"", "k", &[""]),
            ("#k:", "k", &[]),
            ("#:v", "", &["v"]),
            ("#k:\"a,b\"", "k", &["a,b"]),
            ("#k:a:b", "k", &["a:b"]),
            ("#キー:値,２", "キー", &["値", "２"]),
        ];
        for (token, key, values) in cases {
            assert_eq!(
                parse_tag(token, at.clone()),
                tag(key, values, 1, 2, 3),
                "{token:?}"
            );
        }
    }

    #[test]
    fn annotations_merge_tags_joins_values_at_first_position() {
        let merged = merge_tags(vec![
            parse_tag(
                "#k:a",
                SourcePosition {
                    line: 1,
                    column: 1,
                    length: 4,
                },
            ),
            parse_tag(
                "#j",
                SourcePosition {
                    line: 1,
                    column: 6,
                    length: 2,
                },
            ),
            parse_tag(
                "#k:b,c",
                SourcePosition {
                    line: 1,
                    column: 9,
                    length: 6,
                },
            ),
            parse_tag(
                "#k",
                SourcePosition {
                    line: 1,
                    column: 16,
                    length: 2,
                },
            ),
        ]);
        assert_eq!(
            merged,
            vec![tag("k", &["a", "b", "c"], 1, 1, 4), tag("j", &[], 1, 6, 2)]
        );
    }

    #[test]
    fn annotations_normalize_task_marks_matches_node() {
        // 行頭の記号の種類、下線の見出し (=== / --- / 字下げ 4 の下線は見出しでない)、CRLF、フェンス (種類を区別しない)、frontmatter、全角の数字
        let cases: &[(&str, &str)] = &[
            (
                "- [X] a\n* [X] b\n+ [X]\tc\n1. [X] d\n2) [X] e\n# [X] f\n###### [X] g\n####### [X] h",
                "- [x] a\n* [x] b\n+ [x]\tc\n1. [x] d\n2) [x] e\n# [x] f\n###### [x] g\n####### [X] h",
            ),
            (
                "[X] a\n===\n[X] b\n---\n[X] c\n\n  [X] d\n   ---\n[X] e\n    ---\n[X] f\n= = =",
                "[x] a\n===\n[x] b\n---\n[X] c\n\n  [x] d\n   ---\n[X] e\n    ---\n[X] f\n= = =",
            ),
            ("[X] a\r\n---\r\n- [X] b\r\n", "[x] a\r\n---\r\n- [x] b\r\n"),
            (
                "- [X]x\n- [X]\n- [x] [X] a\n-  [X] [X] b\n\t- [X] c\n- a [X] b",
                "- [X]x\n- [X]\n- [x] [X] a\n-  [x] [X] b\n\t- [x] c\n- a [X] b",
            ),
            (
                "```\n- [X] a\n```\n- [X] b\n~~~\n- [X] c\n```\n- [X] d\n~~~\n- [X] e",
                "```\n- [X] a\n```\n- [x] b\n~~~\n- [X] c\n```\n- [x] d\n~~~\n- [X] e",
            ),
            ("---\n- [X] a\n---\n- [X] b", "---\n- [X] a\n---\n- [x] b"),
            (
                "---\r\ntitle: x\r\n---\r\n- [X] a\r\n",
                "---\r\ntitle: x\r\n---\r\n- [x] a\r\n",
            ),
            ("---\n---\n- [X] a", "---\n---\n- [x] a"),
            (
                "１. [X] a\n10. [X] b\n- [X]\u{3000}c",
                "１. [X] a\n10. [x] b\n- [X]\u{3000}c",
            ),
        ];
        for (source, expected) in cases {
            assert_eq!(normalize_task_marks(source), *expected, "{source:?}");
        }
    }

    #[test]
    fn annotations_strip_annotations_matches_node() {
        // 末尾から順の %グループ #キー:値 "引用" $id、数字だけの名前で止まる、$id は 1 つまで、桁はコードポイント、
        // CRLF、frontmatter とフェンスの中は触らない、全角空白で値が切れる、JS の数字は ASCII だけ
        let cases: Vec<StripCase> = vec![
            (
                "# A %g #k:v $id",
                "# A",
                vec![(
                    0,
                    annotation(&["g"], vec![tag("k", &["v"], 1, 8, 4)], Some("id")),
                )],
            ),
            (
                "- a #t %g1 %g2 $x #u:\"q r\" #t:2",
                "- a",
                vec![(
                    0,
                    annotation(
                        &["g1", "g2"],
                        vec![tag("t", &["2"], 1, 5, 2), tag("u", &["q r"], 1, 19, 8)],
                        Some("x"),
                    ),
                )],
            ),
            (
                "- Issue #123\n- a %50\n- b #2024:x\n- c #k:1\n- d $a $b\n- e $1a\n- f #k:v%g",
                "- Issue #123\n- a %50\n- b #2024:x\n- c\n- d $a\n- e $1a\n- f",
                vec![
                    (3, annotation(&[], vec![tag("k", &["1"], 4, 5, 4)], None)),
                    (4, annotation(&[], vec![], Some("b"))),
                    (6, annotation(&[], vec![tag("k", &["v%g"], 7, 5, 6)], None)),
                ],
            ),
            (
                "- 絵文字😀 #k:v\n- 全角\u{3000}#k:a\u{3000}b\n- tab\t#k\t\n- a #k:\"a b\" #j\n- x #k:\"unclosed",
                "- 絵文字😀\n- 全角\u{3000}#k:a\u{3000}b\n- tab\n- a\n- x #k:\"unclosed",
                vec![
                    (0, annotation(&[], vec![tag("k", &["v"], 1, 8, 4)], None)),
                    (2, annotation(&[], vec![tag("k", &[], 3, 7, 2)], None)),
                    (
                        3,
                        annotation(
                            &[],
                            vec![tag("k", &["a b"], 4, 5, 8), tag("j", &[], 4, 14, 2)],
                            None,
                        ),
                    ),
                ],
            ),
            (
                "- a #k:v\r\n- b %g\r\n## c $id\r\n",
                "- a\r\n- b\r\n## c\r\n",
                vec![
                    (0, annotation(&[], vec![tag("k", &["v"], 1, 5, 4)], None)),
                    (1, annotation(&["g"], vec![], None)),
                    (2, annotation(&[], vec![], Some("id"))),
                ],
            ),
            (
                "---\ntitle: x #t\n- a #t\n---\n- b #t\n```\n- c #t\n```\n- d #t",
                "---\ntitle: x #t\n- a #t\n---\n- b\n```\n- c #t\n```\n- d",
                vec![
                    (4, annotation(&[], vec![tag("t", &[], 5, 5, 2)], None)),
                    (8, annotation(&[], vec![tag("t", &[], 9, 5, 2)], None)),
                ],
            ),
            (
                "plain #t\n#nospace #t\n  - indented #t\n1) num #t\n- #only\n- a #\n- b %\n- c $",
                "plain #t\n#nospace #t\n  - indented\n1) num\n-\n- a #\n- b %\n- c $",
                vec![
                    (2, annotation(&[], vec![tag("t", &[], 3, 14, 2)], None)),
                    (3, annotation(&[], vec![tag("t", &[], 4, 8, 2)], None)),
                    (4, annotation(&[], vec![tag("only", &[], 5, 3, 5)], None)),
                ],
            ),
            (
                "- a #①\n- b #２０２４\n- c %Ⅻ\n- d #k:①\n- e #__\n- f #-",
                "- a\n- b\n- c\n- d\n- e\n- f",
                vec![
                    (0, annotation(&[], vec![tag("①", &[], 1, 5, 2)], None)),
                    (
                        1,
                        annotation(&[], vec![tag("２０２４", &[], 2, 5, 5)], None),
                    ),
                    (2, annotation(&["Ⅻ"], vec![], None)),
                    (3, annotation(&[], vec![tag("k", &["①"], 4, 5, 4)], None)),
                    (4, annotation(&[], vec![tag("__", &[], 5, 5, 3)], None)),
                    (5, annotation(&[], vec![tag("-", &[], 6, 5, 2)], None)),
                ],
            ),
            (
                "- a #k #k:x #k:y,z\n# 見出し #状態:進行中 %グループ",
                "- a\n# 見出し",
                vec![
                    (
                        0,
                        annotation(&[], vec![tag("k", &["x", "y", "z"], 1, 5, 2)], None),
                    ),
                    (
                        1,
                        annotation(&["グループ"], vec![tag("状態", &["進行中"], 2, 7, 7)], None),
                    ),
                ],
            ),
        ];
        for (source, text, annotations) in cases {
            let result = strip_annotations(source);
            assert_eq!(result.text, text, "{source:?}");
            assert_eq!(
                result.annotations.into_iter().collect::<Vec<_>>(),
                annotations,
                "{source:?}"
            );
        }
    }

    #[test]
    fn annotations_rewrite_body_lines_skips_frontmatter() {
        // 飛ばす行数は FRONTMATTER に一致した文字列の '\n' の数 (閉じの行まで)。一致しなければ 0
        let cases: &[(&str, &str)] = &[
            ("---\na\n---\nb\nc", "---\na\n---\n3:b\n4:c"),
            ("---\r\na\r\n---\r\nb", "---\r\na\r\n---\r\n3:b"),
            ("x\n---\na\n---\nb", "0:x\n1:---\n2:a\n3:---\n4:b"),
            ("---\na\n---", "0:---\n1:a\n2:---"),
            ("---\na\n---\n", "---\na\n---\n3:"),
        ];
        for (source, expected) in cases {
            assert_eq!(
                rewrite_body_lines(source, |line, index, _| format!("{index}:{line}")),
                *expected,
                "{source:?}"
            );
        }
    }

    #[test]
    fn annotations_read_frontmatter_matches_node() {
        // (原文, 読めた値の JSON, 本文に足す行数, 切り取ったあとの本文)。読めない (YAML の誤り、重複キー、複数の文書、未定義の別名) なら None
        let cases: &[FrontmatterCase] = &[
            (
                "---\ntitle: T\nmarkdag:\n  a: 1\n---\n# x",
                Some(("{\"title\":\"T\",\"markdag\":{\"a\":1}}", 5, "# x")),
            ),
            (
                "---\r\ntitle: T\r\nlist:\r\n  - a\r\n---\r\n# x\r\n",
                Some(("{\"title\":\"T\",\"list\":[\"a\"]}", 5, "# x\r\n")),
            ),
            ("---\n---\n# x", Some(("null", 2, "# x"))),
            ("---\r\n---\r\n# x", Some(("null", 2, "# x"))),
            ("---\n\n---\n# x", Some(("null", 3, "# x"))),
            ("---\n# only comment\n---\n# x", Some(("null", 3, "# x"))),
            ("---\na: [\n---\n# x", None),
            ("---\na: 1\na: 2\n---\n# x", None),
            (
                "---\na: 1\n---\nb: 2\n---\n# x",
                Some(("{\"a\":1}", 3, "b: 2\n---\n# x")),
            ),
            ("---\na: 1\n...\nb: 2\n---\n# x", None),
            (
                "---\nb: 1\n2024: 2\na: 3\n7: 4\n1: 5\n---\n",
                Some(("{\"1\":5,\"7\":4,\"2024\":2,\"b\":1,\"a\":3}", 7, "")),
            ),
            ("---\n007: a\n7: b\n---\n", None),
            ("---\n1: a\n\"1\": b\n---\n", Some(("{\"1\":\"b\"}", 4, ""))),
            (
                "---\na: &x [1, 2]\nb: *x\nc: &y {k: *x}\nd: *y\n---\n",
                Some((
                    "{\"a\":[1,2],\"b\":[1,2],\"c\":{\"k\":[1,2]},\"d\":{\"k\":[1,2]}}",
                    6,
                    "",
                )),
            ),
            ("---\na: *nope\n---\n", None),
            (
                "---\n~: a\nnull: b\ntrue: c\n1.0: d\n.inf: e\n-0: f\n---\n",
                None,
            ),
            (
                "---\nmarkmap:\n  color: red\n  extraJs: [\"\", 1, \"a.js\"]\n  extraCss: []\n  duration: \"500\"\n  maxWidth: abc\n  initialExpandLevel: [3]\n  other: 1\n---\n",
                Some((
                    "{\"markmap\":{\"color\":[\"red\"],\"extraJs\":[\"a.js\"],\"extraCss\":\"<undefined>\",\"duration\":500,\"maxWidth\":\"<undefined>\",\"initialExpandLevel\":3,\"other\":1}}",
                    10,
                    "",
                )),
            ),
            (
                "---\nmarkmap:\n  color: null\n  duration: true\n  maxWidth: {}\n  initialExpandLevel: [true]\n---\n",
                Some((
                    "{\"markmap\":{\"color\":null,\"duration\":1,\"maxWidth\":\"<undefined>\",\"initialExpandLevel\":\"<undefined>\"}}",
                    7,
                    "",
                )),
            ),
            ("---\nmarkmap: 5\n---\n", Some(("{\"markmap\":5}", 3, ""))),
            ("---\n- a\n- b\n---\n", Some(("[\"a\",\"b\"]", 4, ""))),
            (
                "---\njust a string\n---\n",
                Some(("\"just a string\"", 3, "")),
            ),
            ("---\nmarkdag:\n---\n", Some(("{\"markdag\":null}", 3, ""))),
            (
                "---\nmarkdag: null\n---\n",
                Some(("{\"markdag\":null}", 3, "")),
            ),
            (
                "---\na: |\n  x\n  y\nb: >-\n  p\n  q\n---\n",
                Some(("{\"a\":\"x\\ny\\n\",\"b\":\"p q\"}", 8, "")),
            ),
            ("---\na: |\n  x\n---\n", Some(("{\"a\":\"x\\n\"}", 4, ""))),
            (
                "---\na: !!str 1\nb: !!int \"2\"\nc: !!float 3\nd: !x y\n---\n",
                Some(("{\"a\":\"1\",\"b\":2,\"c\":\"3\",\"d\":\"y\"}", 6, "")),
            ),
            (
                "---\na: .nan\nb: -.inf\nc: 0x1F\nd: 0o17\ne: 1e3\nf: +12\n---\n",
                Some((
                    "{\"a\":{\"$number\":\"NaN\"},\"b\":{\"$number\":\"-Infinity\"},\"c\":31,\"d\":15,\"e\":1000,\"f\":12}",
                    8,
                    "",
                )),
            ),
            (
                "---\n? a\n? b\n: c\n---\n",
                Some(("{\"a\":null,\"b\":\"c\"}", 5, "")),
            ),
            ("---\ntitle: T\n---", None),
            ("x\n---\na: 1\n---\n", None),
            (
                "---\nkey: \"日本語\"\n---\n本文 #t",
                Some(("{\"key\":\"日本語\"}", 3, "本文 #t")),
            ),
            (
                "---\na: 1\n  ---\n---\n",
                Some(("{\"a\":\"1 ---\"}", 4, "")),
            ),
            ("---\na: \"x\n---\n", None),
        ];
        for (source, expected) in cases {
            let found = read_frontmatter(source);
            match (found, expected) {
                (None, None) => {}
                (Some(info), Some((json, lines, rest))) => {
                    let expected_value: serde_json::Value =
                        serde_json::from_str(json).expect("テストの JSON");
                    assert_eq!(node_shape(&info.value), expected_value, "{source:?}");
                    assert_eq!(info.lines, *lines, "{source:?}");
                    assert_eq!(
                        js_slice(source, info.offset, source.len()),
                        *rest,
                        "{source:?}"
                    );
                }
                (found, _) => panic!("{source:?}: {found:?}"),
            }
        }
    }

    #[test]
    fn annotations_frontmatter_cyclic_alias_is_unreadable() {
        // 旧実装 (eemeli/yaml) は循環するオブジェクトを返し、JSON にできない。規則 2.3 に従い YAML の失敗として扱う
        assert_eq!(read_frontmatter("---\na: &x [*x]\n---\n"), None);
        assert_eq!(yaml_parse("a: &x [*x]"), Err(YamlParseError::CyclicAlias));
    }

    #[test]
    fn annotations_frontmatter_keeps_written_order() {
        // 決定 8 (a) と A-111: 整数に見えるキーを先頭へ並べ直さない (旧実装の JS のオブジェクトは 1, 7, 2024, b, a)
        let info = read_frontmatter("---\nb: 1\n2024: 2\na: 3\n7: 4\n1: 5\n---\n").expect("読める");
        assert_eq!(keys_of(&info.value), vec!["b", "2024", "a", "7", "1"]);
        // 文字列にしたあと同じになるキー (`1` と `"1"` は重複キーではない) は最初の位置に最後の値
        let info = read_frontmatter("---\nx: 0\n1: a\n\"1\": b\n---\n").expect("読める");
        assert_eq!(keys_of(&info.value), vec!["x", "1"]);
        assert_eq!(
            node_shape(&info.value),
            serde_json::json!({ "x": 0, "1": "b" })
        );
    }

    #[test]
    fn annotations_frontmatter_markmap_options_keep_undefined_keys() {
        // normalizeMarkmapJsonOptions は直せない値の欄を消さず undefined にする (model 層が「値なし」の警告にする)
        let info =
            read_frontmatter("---\nmarkmap:\n  color: 5\n  duration: abc\n  maxWidth: null\n---\n")
                .expect("読める");
        let JsValue::Object(map) = &info.value else {
            panic!("写像")
        };
        let Some(JsValue::Object(markmap)) = map.get("markmap") else {
            panic!("markmap は写像")
        };
        assert_eq!(markmap.get("color"), Some(&JsValue::Undefined));
        assert_eq!(markmap.get("duration"), Some(&JsValue::Undefined));
        assert_eq!(markmap.get("maxWidth"), Some(&JsValue::Null));
    }

    #[test]
    fn annotations_probe_frontmatter_matches_node() {
        // `probe.frontmatter ?? {}` と `isMapping && 'markdag' in frontmatter` (値が null でも抽出する)
        let cases: &[(&str, &str, bool)] = &[
            (
                "---\ntitle: T\nmarkdag:\n  a: 1\n---\n# x",
                "{\"title\":\"T\",\"markdag\":{\"a\":1}}",
                true,
            ),
            (
                "---\r\ntitle: T\r\nlist:\r\n  - a\r\n---\r\n# x\r\n",
                "{\"title\":\"T\",\"list\":[\"a\"]}",
                false,
            ),
            ("---\n---\n# x", "{}", false),
            ("---\r\n---\r\n# x", "{}", false),
            ("---\n\n---\n# x", "{}", false),
            ("---\n# only comment\n---\n# x", "{}", false),
            ("---\na: [\n---\n# x", "{}", false),
            ("---\na: 1\na: 2\n---\n# x", "{}", false),
            ("---\na: 1\n---\nb: 2\n---\n# x", "{\"a\":1}", false),
            ("---\na: 1\n...\nb: 2\n---\n# x", "{}", false),
            (
                "---\nb: 1\n2024: 2\na: 3\n7: 4\n1: 5\n---\n",
                "{\"1\":5,\"7\":4,\"2024\":2,\"b\":1,\"a\":3}",
                false,
            ),
            ("---\n007: a\n7: b\n---\n", "{}", false),
            ("---\n1: a\n\"1\": b\n---\n", "{\"1\":\"b\"}", false),
            (
                "---\na: &x [1, 2]\nb: *x\nc: &y {k: *x}\nd: *y\n---\n",
                "{\"a\":[1,2],\"b\":[1,2],\"c\":{\"k\":[1,2]},\"d\":{\"k\":[1,2]}}",
                false,
            ),
            ("---\na: *nope\n---\n", "{}", false),
            (
                "---\n~: a\nnull: b\ntrue: c\n1.0: d\n.inf: e\n-0: f\n---\n",
                "{}",
                false,
            ),
            (
                "---\nmarkmap:\n  color: red\n  extraJs: [\"\", 1, \"a.js\"]\n  extraCss: []\n  duration: \"500\"\n  maxWidth: abc\n  initialExpandLevel: [3]\n  other: 1\n---\n",
                "{\"markmap\":{\"color\":[\"red\"],\"extraJs\":[\"a.js\"],\"extraCss\":\"<undefined>\",\"duration\":500,\"maxWidth\":\"<undefined>\",\"initialExpandLevel\":3,\"other\":1}}",
                false,
            ),
            (
                "---\nmarkmap:\n  color: null\n  duration: true\n  maxWidth: {}\n  initialExpandLevel: [true]\n---\n",
                "{\"markmap\":{\"color\":null,\"duration\":1,\"maxWidth\":\"<undefined>\",\"initialExpandLevel\":\"<undefined>\"}}",
                false,
            ),
            ("---\nmarkmap: 5\n---\n", "{\"markmap\":5}", false),
            ("---\n- a\n- b\n---\n", "[\"a\",\"b\"]", false),
            ("---\njust a string\n---\n", "\"just a string\"", false),
            ("---\nmarkdag:\n---\n", "{\"markdag\":null}", true),
            ("---\nmarkdag: null\n---\n", "{\"markdag\":null}", true),
            (
                "---\na: |\n  x\n  y\nb: >-\n  p\n  q\n---\n",
                "{\"a\":\"x\\ny\\n\",\"b\":\"p q\"}",
                false,
            ),
            ("---\na: |\n  x\n---\n", "{\"a\":\"x\\n\"}", false),
            (
                "---\na: !!str 1\nb: !!int \"2\"\nc: !!float 3\nd: !x y\n---\n",
                "{\"a\":\"1\",\"b\":2,\"c\":\"3\",\"d\":\"y\"}",
                false,
            ),
            (
                "---\na: .nan\nb: -.inf\nc: 0x1F\nd: 0o17\ne: 1e3\nf: +12\n---\n",
                "{\"a\":{\"$number\":\"NaN\"},\"b\":{\"$number\":\"-Infinity\"},\"c\":31,\"d\":15,\"e\":1000,\"f\":12}",
                false,
            ),
            (
                "---\n? a\n? b\n: c\n---\n",
                "{\"a\":null,\"b\":\"c\"}",
                false,
            ),
            ("---\ntitle: T\n---", "{}", false),
            ("x\n---\na: 1\n---\n", "{}", false),
            (
                "---\nkey: \"日本語\"\n---\n本文 #t",
                "{\"key\":\"日本語\"}",
                false,
            ),
            ("---\na: 1\n  ---\n---\n", "{\"a\":\"1 ---\"}", false),
            ("---\na: \"x\n---\n", "{}", false),
            (
                "---\nmarkdag:\n  a: 1\n---\n- [X] a #t",
                "{\"markdag\":{\"a\":1}}",
                true,
            ),
            ("no frontmatter", "{}", false),
        ];
        for (source, json, extracted) in cases {
            let probe = probe_frontmatter(source);
            let expected_value: serde_json::Value =
                serde_json::from_str(json).expect("テストの JSON");
            assert_eq!(node_shape(&probe.frontmatter), expected_value, "{source:?}");
            assert_eq!(probe.extracted, *extracted, "{source:?}");
        }
    }

    #[test]
    fn annotations_yaml_alias_count_matches_node() {
        // eemeli/yaml の maxAliasCount (100): 錨ごとの count と aliasCount の積が 100 を越えたら読めない
        let cases: &[(&str, Option<&str>)] = &[
            (
                "---\na: &a x\nb: [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n---\n",
                Some(
                    "{\"a\":\"x\",\"b\":[\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\"]}",
                ),
            ),
            (
                "---\na: &a x\nb: [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n---\n",
                None,
            ),
            (
                "---\na: &a [x, y]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b]\n---\n",
                None,
            ),
            (
                "---\na: &a [x, y]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n---\n",
                None,
            ),
            (
                "---\na: &a x\nb: &b [*a]\nc: *a\nd: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n---\n",
                None,
            ),
            (
                "---\na: &a x\nb: &b [*a]\nc: *a\nd: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n---\n",
                None,
            ),
            (
                "---\na: &a []\nb: [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n---\n",
                Some(
                    "{\"a\":[],\"b\":[[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[],[]]}",
                ),
            ),
            (
                "---\na: &a x\na2: &a y\nb: *a\n---\n",
                Some("{\"a\":\"x\",\"a2\":\"y\",\"b\":\"y\"}"),
            ),
            ("---\n? &k a\n: 1\n*k : 2\n---\n", Some("{\"a\":2}")),
        ];
        for (source, expected) in cases {
            let found = read_frontmatter(source)
                .map(|info| serde_json::to_string(&info.value).expect("JSON に書ける"));
            assert_eq!(found.as_deref(), *expected, "{source:?}");
        }
        assert_eq!(
            yaml_parse(&format!("a: &a x\nb: [{}]", vec!["*a"; 100].join(", "))),
            Err(YamlParseError::ExcessiveAliases)
        );
    }

    #[test]
    fn annotations_yaml_key_lazy_regexes_compile() {
        for regex in [
            &CONTROL_CHARS,
            &FLOW_INDICATOR,
            &PLAIN_NOT_ALLOWED,
            &SPACE_AROUND_NEWLINE,
            &NEWLINES,
            &DOCUMENT_MARKER,
            &NULL_TEST,
            &BOOL_TEST,
            &INT_OCT_TEST,
            &INT_TEST,
            &INT_HEX_TEST,
            &FLOAT_NAN_TEST,
            &FLOAT_EXP_TEST,
            &FLOAT_TEST,
        ] {
            LazyLock::force(regex);
        }
    }

    #[test]
    fn annotations_yaml_key_number_helpers_match_node() {
        // node: (0x1f).toString(16)、(2**60).toString(16)、(110).toExponential()、(0.0015).toExponential()、(1e21).toExponential()
        assert_eq!(integer_to_radix(31.0, 16), "1f");
        assert_eq!(
            integer_to_radix(1_152_921_504_606_846_976.0, 16),
            "1000000000000000"
        );
        assert_eq!(integer_to_radix(0.0, 8), "0");
        assert_eq!(to_exponential(110.0), "1.1e+2");
        assert_eq!(to_exponential(0.0015), "1.5e-3");
        assert_eq!(to_exponential(1e21), "1e+21");
    }

    #[test]
    fn annotations_yaml_collection_keys_match_node() {
        // A-130 (1): 入れ物のキーと入れ物を指す別名のキーは、eemeli/yaml 2.9.1 と同じ YAML のフロー形式の字になる。
        // 期待値は node で `Object.keys(require('yaml').parse(src))` を取ったもの (コメントを含むキーは写さないので入れない)
        let cases: &[(&str, &[&str])] = &[
            ("? [a, b]\n: 1", &["[ a, b ]"]),
            ("? [a, b]", &["[ a, b ]"]),
            ("? {x: 1}\n: 1", &["{ x: 1 }"]),
            ("? {x: 1, y: [1, 2]}\n: 1", &["{ x: 1, y: [ 1, 2 ] }"]),
            ("? []\n: 1", &["[]"]),
            ("? {}\n: 1", &["{}"]),
            ("? - a\n  - b\n: 1", &["[ a, b ]"]),
            ("? x: 1\n  y: 2\n: 1", &["{ x: 1, y: 2 }"]),
            (
                "? - a\n  - [b, c]\n  - {d: e}\n: 1",
                &["[ a, [ b, c ], { d: e } ]"],
            ),
            ("k: &k [a, b]\n*k : 1", &["k", "*k"]),
            ("k: &k {x: 1}\n? *k\n: 1", &["k", "*k"]),
            ("k: &k a\n*k : 1", &["k", "a"]),
            ("? &a [a, b]\n: 1", &["[ a, b ]"]),
            ("? !!seq [a, b]\n: 1", &["[ a, b ]"]),
            (
                "? [!!str 1, !foo x, !!int 2]\n: 1",
                &["[ !!str \"1\", !foo x, !!int 2 ]"],
            ),
            (
                "? ['a', \"b\", c d, 'e f']\n: 1",
                &["[ 'a', \"b\", c d, 'e f' ]"],
            ),
            (
                "? [\"a\\nb\", 'x''y', \"tab\\t\"]\n: 1",
                &["[ \"a\\nb\", 'x''y', \"tab\\t\" ]"],
            ),
            (
                "? [1, 1.0, 0x10, 0o7, 1e3, .inf, -.inf, .nan, 1.50]\n: 1",
                &["[ 1, 1.0, 0x10, 0o7, 1e+3, .inf, -.inf, .nan, 1.50 ]"],
            ),
            (
                "? [true, false, null, ~, '', ]\n: 1",
                &["[ true, false, null, ~, '' ]"],
            ),
            ("? [a: 1, b]\n: 1", &["[ { a: 1 }, b ]"]),
            ("? {a, b: }\n: 1", &["{ a, b: }"]),
            ("? [ab cd\n  ef]\n: 1", &["[ ab cd ef ]"]),
            (
                "? - |\n    lit\n    two\n  - >\n    fold\n: 1",
                &["[ \"lit\\ntwo\\n\", \"fold\\n\" ]"],
            ),
            (
                "? [aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]\n: 1",
                &[
                    "[\n  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,\n  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n]",
                ],
            ),
            ("? [[1, 2], [3, [4]]]\n: 1", &["[ [ 1, 2 ], [ 3, [ 4 ] ] ]"]),
            ("? {x: {y: {z: 1}}}\n: 1", &["{ x: { y: { z: 1 } } }"]),
            ("a: &a 1\n? [*a, b]\n: 1", &["a", "[ *a, b ]"]),
            ("? [&x a, *x]\n: 1", &["[ &x a, *x ]"]),
            ("? [a, b]\n: 1\n? [a, b]\n: 2", &["[ a, b ]"]),
            (
                "? [\"a:b\", 'a #b', '- x', '[x]', '{x}', 'x,y', '@x', '`x', '!x', '&x', '*x', '%x', '|x', '>x', '?x', ':x', 'x: y']\n: 1",
                &[
                    "[\n  \"a:b\",\n  'a #b',\n  '- x',\n  '[x]',\n  '{x}',\n  'x,y',\n  '@x',\n  '`x',\n  '!x',\n  '&x',\n  '*x',\n  '%x',\n  '|x',\n  '>x',\n  '?x',\n  ':x',\n  'x: y'\n]",
                ],
            ),
            (
                "? ['yes', 'no', 'true', '1', '~', 'null', '1.0', '0x1', ' x', 'x ']\n: 1",
                &["[ 'yes', 'no', 'true', '1', '~', 'null', '1.0', '0x1', ' x', 'x ' ]"],
            ),
            (
                "? ['日本', \"\\u0001\", \"\\x7f\", \"a\\u00a0b\"]\n: 1",
                &["[ '日本', \"\\x01\", \"\u{7f}\", \"a b\" ]"],
            ),
            ("? {? [a]: b}\n: 1", &["{\n  ? [ a ]\n  : b\n}"]),
            (
                "? [2001-01-01, !!binary aGVsbG8=]\n: 1",
                &["[ 2001-01-01, !!binary aGVsbG8= ]"],
            ),
            ("? {x: 1}\n", &["{ x: 1 }"]),
            (
                "? [a,b]\n: 1\n? {x: 1}\n: 2\nc: 3",
                &["[ a, b ]", "{ x: 1 }", "c"],
            ),
            ("[a, b]: 1", &["[ a, b ]"]),
            ("{x: 1}: 2", &["{ x: 1 }"]),
            ("? -1\n: 1", &["-1"]),
            (
                "? [-0, +1, 0.0, 1_000, 007, 1e+3, 1E3, .5, 5., -.5]\n: 1",
                &["[ -0, 1, 0.0, 1_000, 7, 1e+3, 1e+3, 0.5, 5, -0.5 ]"],
            ),
            (
                "? [12345678901234567890, 0.1234567890123456789]\n: 1",
                &["[ 12345678901234567000, 0.12345678901234568 ]"],
            ),
            ("? - \n  - a\n: 1", &["[ , a ]"]),
            ("? {: b}\n: 1", &["{ : b }"]),
            ("? {a, b}\n: 1", &["{ a, b }"]),
            ("? {a: , b}\n: 1", &["{ a:, b }"]),
            ("? a:\n  b: 1\n: 1", &["{ a:, b: 1 }"]),
            ("? ? a\n  ? b\n: 1", &["{ a, b }"]),
            ("? ? a\n  : x\n  ? b\n: 1", &["{ a: x, b }"]),
            ("? [a: ]\n: 1", &["[ { a: } ]"]),
            (
                "? [~, Null, NULL, null, True, TRUE, FALSE, False]\n: 1",
                &["[ ~, Null, NULL, null, True, TRUE, FALSE, False ]"],
            ),
            (
                "? [!!null ~, !!bool true, !!float 1, !!float 1.50, !!int 0x1F, !!str true, !!str a, !!map {a: 1}, !!seq [a], !!set {a}, !<tag:x.com,2000:a> b]\n: 1",
                &[
                    "[\n  !!null ~,\n  !!bool true,\n  !!float \"1\",\n  !!float 1.50,\n  !!int 0x1f,\n  !!str \"true\",\n  !!str a,\n  !!map { a: 1 },\n  !!seq [ a ],\n  !!set { a },\n  !<tag:x.com,2000:a> b\n]",
                ],
            ),
            (
                "? [0x1F, 0xff, 0o17, 1.10e2, -1.5e-3, 5.0e0, 100., -0.0, +.inf, .NaN, .Inf, 1e21, 123456789012345678901234, 0.000001, 0.0000001]\n: 1",
                &[
                    "[\n  0x1f,\n  0xff,\n  0o17,\n  1.1e+2,\n  -1.5e-3,\n  5e+0,\n  100,\n  -0.0,\n  .inf,\n  .nan,\n  .inf,\n  1e+21,\n  1.2345678901234569e+23,\n  0.000001,\n  1e-7\n]",
                ],
            ),
            (
                "? [\"a\\nb\\nccccccccccccccccccccccccccccccccccccccccccccccc\"]\n: 1",
                &["[\n  \"a\n\n    b\n\n    ccccccccccccccccccccccccccccccccccccccccccccccc\"\n]"],
            ),
            (
                "? ['a\n\n  b', \"x\n\n  y\"]\n: 1",
                &["[\n  'a\n\n    b',\n  \"x\\ny\"\n]"],
            ),
            ("? [a\n\n  b]\n: 1", &["[\n  a\n\n    b\n]"]),
            (
                "? [\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd eeeeeeeeeeeeeeeee fffffffff\"]\n: 1",
                &[
                    "[\n  \"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\\\n    dddddddddddddd eeeeeeeeeeeeeeeee fffffffff\"\n]",
                ],
            ),
            (
                "? [dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd ddddddddddd dddddddddddddd eeeeeeeeeeeeeeeee fffffffff]\n: 1",
                &[
                    "[\n  dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd ddddddddddd\n    dddddddddddddd eeeeeeeeeeeeeeeee fffffffff\n]",
                ],
            ),
            (
                "? {kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk: vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv, z: [1,2]}\n: 1",
                &[
                    "{\n  kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk: vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv,\n  z: [ 1, 2 ]\n}",
                ],
            ),
            (
                "? [[aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb], c]\n: 1",
                &[
                    "[\n  [\n      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,\n      bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n    ],\n  c\n]",
                ],
            ),
            (
                "? {k: [aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb], c: d}\n: 1",
                &[
                    "{\n  k:\n    [\n      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,\n      bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n    ],\n  c: d\n}",
                ],
            ),
            ("? {[a]: b}\n: 1", &["{\n  ? [ a ]\n  : b\n}"]),
            ("? {[a]}\n: 1", &["{ ? [ a ] }"]),
            (
                "? {{a: 1}: b, c: d}\n: 1",
                &["{\n  ? { a: 1 }\n  : b,\n  c: d\n}"],
            ),
            (
                "a: &a [x]\n? [*a, &b {y: 1}, *b]\n: 1",
                &["a", "[ *a, &b { y: 1 }, *b ]"],
            ),
            ("a: &a {x: 1}\n? *a\n", &["a", "*a"]),
            ("a: &a [x]\n? *a\n: 1\nb: *a", &["a", "*a", "b"]),
            (
                "? [&a !!str x, !!str &b y]\n: 1",
                &["[ &a !!str x, &b !!str y ]"],
            ),
            (
                "? [\"it's\", 'say \"hi\"', \"both ' \\\"\", 'x\ty']\n: 1",
                &["[ \"it's\", 'say \"hi\"', \"both ' \\\"\", 'x\ty' ]"],
            ),
            (
                "? ['-', '? x', '- ', 'a:', 'a :b', 'a#b', 'a #b']\n: 1",
                &["[ '-', '? x', '- ', 'a:', 'a :b', 'a#b', 'a #b' ]"],
            ),
            (
                "? ['---', '...', '% x', 'a\n  ---']\n: 1",
                &["[ '---', '...', '% x', 'a ---' ]"],
            ),
            ("? [1.0e+3, 2e-3, .5e3]\n: 1", &["[ 1e+3, 2e-3, 5e+2 ]"]),
            (
                "? [\"\\u2028\", \"\\t\", \"\\0\", \"\\e\", \"\\N\", \"\\_\", \"\\ud83d\\ude00\", \" \"]\n: 1",
                &["[ \"\u{2028}\", \"\\t\", \"\\0\", \"\\e\", \"\u{85}\", \" \", \"😀\", \" \" ]"],
            ),
            ("? [a b]: 1\n: 2", &["{\n  ? [ a b ]\n  : 1\n}"]),
            (
                "? [\"a \\nb\", \"a\\n b\"]\n: 1",
                &["[ \"a\\ \\nb\", \"a\\n b\" ]"],
            ),
            (
                "? [\"a\\n\", \"a\\n\\n\\nb and more text to make it forty chars long\"]\n: 1",
                &[
                    "[\n  \"a\\n\",\n  \"a\n\n\n\n    b and more text to make it forty chars long\"\n]",
                ],
            ),
            ("k: 1\n? []\n", &["k", "[]"]),
            ("? [? b]\n: 1", &["[ { b } ]"]),
            (
                "a: &a x\n? {*a : 1, b: *a}\n: 1",
                &["a", "{\n  ? *a\n  : 1,\n  b: *a\n}"],
            ),
            ("a: &a [x]\n? {*a : 1}\n: 1", &["a", "{\n  ? *a\n  : 1\n}"]),
            ("a: &a [x]\n? {*a }\n: 1", &["a", "{ ? *a }"]),
            (
                "? [yes, no, on, off, y, n]\n: 1",
                &["[ yes, no, on, off, y, n ]"],
            ),
            (
                "? [!!bool x, !!float abc, !!int abc, !!null x, !!float '1', !!int 1.5, !!float 1]\n: 1",
                &[
                    "[\n  !!bool true,\n  !!float .nan,\n  !!int .nan,\n  !!null null,\n  !!float \"1\",\n  !!int \"1.5\",\n  !!float \"1\"\n]",
                ],
            ),
            ("? [\"a'b\\\"c\"]\n: 1", &["[ \"a'b\\\"c\" ]"]),
            ("? ? |\n    x\n  : 1\n: 1", &["{\n  ? \"x\\n\"\n  : 1\n}"]),
            (
                "? [dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd ddddddddddd ddddddddddddddeeeeeeeeeeeeeeeeefffffffff]\n: 1",
                &[
                    "[\n  dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd ddddddddddd\n    ddddddddddddddeeeeeeeeeeeeeeeeefffffffff\n]",
                ],
            ),
            (
                "? {kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk kkkkkkkkkkkkkkkkkkkkk: v}\n: 1",
                &[
                    "{\n  kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk kkkkkkkkkkkkkkkkkkkkk: v\n}",
                ],
            ),
            (
                "? {k: vvvvvvvvvvvvvvvvvv vvvvvvvvvvvvvvvvvvvvvvvvvvvv vvvvvvvvvvvvvvvvvvvvv vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv}\n: 1",
                &[
                    "{\n  k: vvvvvvvvvvvvvvvvvv vvvvvvvvvvvvvvvvvvvvvvvvvvvv vvvvvvvvvvvvvvvvvvvvv\n    vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv\n}",
                ],
            ),
            (
                "? [&aaaaaaaaaaaaaaaaaaa dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd ddddddddddd ddddddddddddd, &b ffff ffffffffffff fffffffffffffffffffff fffffffffffffffffffffff ffffffffffffff ff]\n: 1",
                &[
                    "[\n  &aaaaaaaaaaaaaaaaaaa dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd\n    ddddddddddd ddddddddddddd,\n  &b ffff ffffffffffff fffffffffffffffffffff\n    fffffffffffffffffffffff ffffffffffffff ff\n]",
                ],
            ),
            (
                "? ['dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd ddddddddddd ddddddddddddd''x yyyyyyyyyyyyyyy']\n: 1",
                &[
                    "[\n  'dddddddddd dddddddddddd ddddddddddddddd ddddddddddddddddddd ddddddddddd\n    ddddddddddddd''x yyyyyyyyyyyyyyy'\n]",
                ],
            ),
            (
                "? [\"dddddddddd\\tdddddddddddd\\u0001ddddddddddddddd\\x02ddddddddddddddddddd\\u0003ddddddddddddddddddddddddddddddddddddddddddd\"]\n: 1",
                &[
                    "[\n  \"dddddddddd\\tdddddddddddd\\x01ddddddddddddddd\\x02ddddddddddddddddddd\\x03dddd\\\n    ddddddddddddddddddddddddddddddddddddddd\"\n]",
                ],
            ),
            ("? [\"a  \\nb\"]\n: 1", &["[ \"a \\ \\nb\" ]"]),
            (
                "? [\"   leading\", 'trailing   ', ' ']\n: 1",
                &["[ \"   leading\", 'trailing   ', ' ' ]"],
            ),
            ("? a: &x\n  b: 1\n: 1", &["{ a: &x , b: 1 }"]),
            ("? {a: &x , b: !t }\n: 1", &["{ a: &x , b: !t \"\" }"]),
            ("? [&x , !t ]\n: 1", &["[ &x , !t \"\" ]"]),
            ("? - &s [1]\n  - *s\n: 1", &["[ &s [ 1 ], *s ]"]),
            ("? - &m\n    k: v\n  - *m\n: 1", &["[ &m { k: v }, *m ]"]),
            ("? {\"a\":&x b, c: *x}\n: 1", &["{ \"a\": &x b, c: *x }"]),
            ("? [&a:b x, *a:b]\n: 1", &["[ &a:b x, *a:b ]"]),
            (
                "? [\"日本語の長い文字列日本語の長い文字列日本語の長い文字列日本語の長い文字列日本語の長い文字列日本語の長い文字列\"]\n: 1",
                &[
                    "[ \"日本語の長い文字列日本語の長い文字列日本語の長い文字列日本語の長い文字列日本語の長い文字列日本語の長い文字列\" ]",
                ],
            ),
            (
                "? [😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀]\n: 1",
                &[
                    "[\n  😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\n    😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀\n]",
                ],
            ),
            (
                "? {a: [b, {c: [d, e]}], f: {}}\n: 1",
                &["{ a: [ b, { c: [ d, e ] } ], f: {} }"],
            ),
            ("? [{}, [], {a: []}]\n: 1", &["[ {}, [], { a: [] } ]"]),
            ("markdag:\n  x: 1\n? [a]\n: 1", &["markdag", "[ a ]"]),
            (
                "? {a: {b}, c: [d: ]}\n: 1",
                &["{ a: { b }, c: [ { d: } ] }"],
            ),
            (
                "? [0o0, 0x0, 0, -0, +0, 0.0e0, 1.0e-10]\n: 1",
                &["[ 0o0, 0x0, 0, -0, 0, 0e+0, 1e-10 ]"],
            ),
            (
                "? [\"0x10\", '1e3', \"-.inf\", 'True', 'NULL', '']\n: 1",
                &["[ \"0x10\", '1e3', \"-.inf\", 'True', 'NULL', '' ]"],
            ),
            ("? [a~, ~a, a: b]\n: 1", &["[ a~, ~a, { a: b } ]"]),
            (
                "? [\"123456789012345678901234567890123456789\\nb\"]\n: 1",
                &["[\n  \"123456789012345678901234567890123456789\n\n    b\"\n]"],
            ),
            (
                "? [\"1234567890123456789012345678901234567890\\n b\"]\n: 1",
                &["[\n  \"1234567890123456789012345678901234567890\n\n    \\ b\"\n]"],
            ),
            ("? ['a\n  b', \"c\n  d\"]\n: 1", &["[ 'a b', \"c d\" ]"]),
            ("? [a\n  b]\n: 1", &["[ a b ]"]),
            ("? {a\n  b: c}\n: 1", &["{ a b: c }"]),
            ("? [!!str, !!str '']\n: 1", &["[ !!str \"\", !!str '' ]"]),
            (
                "? [!!int 1.0, !!float 0x1]\n: 1",
                &["[ !!int \"1.0\", !!float \"0x1\" ]"],
            ),
            (
                "? - - - a\n    - &q b\n  - *q\n: 1",
                &["[ [ [ a ], &q b ], *q ]"],
            ),
            ("? [a, b]\n", &["[ a, b ]"]),
            ("? {a: 1}\n? [b]\n", &["{ a: 1 }", "[ b ]"]),
            (
                "? [xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]\n: 1",
                &[
                    "[\n  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n]",
                ],
            ),
            (
                "? [\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"]\n: 1",
                &[
                    "[\n  \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\\n    xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"\n]",
                ],
            ),
            (
                "? [\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \\t xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"]\n: 1",
                &[
                    "[\n  \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \\t\n    xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"\n]",
                ],
            ),
            (
                "? {kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk: vvvvvvvvvv vvvvvvvvvvv vvvvvvvvvvvvv vvvvvvvvvvvvvvv}\n: 1",
                &[
                    "{\n  kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk: vvvvvvvvvv vvvvvvvvvvv vvvvvvvvvvvvv vvvvvvvvvvvvvvv\n}",
                ],
            ),
            (
                "? [&aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa xxxxxxxxxxxxxx xxxxxxxxxxxxxxxxxx xxxxxxxxxxxxxx xxxxxxxxxxxxxxxxxxx]\n: 1",
                &[
                    "[\n  &aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa xxxxxxxxxxxxxx xxxxxxxxxxxxxxxxxx xxxxxxxxxxxxxx xxxxxxxxxxxxxxxxxxx\n]",
                ],
            ),
            ("? &m\n  a: 1\n: 1\nx: *m", &["{ a: 1 }", "x"]),
            ("? !!map\n  a: 1\n: 1", &["{ a: 1 }"]),
            ("? - !t &a\n    - x\n  - *a\n: 1", &["[ &a !t [ x ], *a ]"]),
            (
                "? a:\n    - b\n    - c\n  d: {e: f}\n: 1",
                &["{ a: [ b, c ], d: { e: f } }"],
            ),
            (
                "? a: |\n    lit\n  b: >-\n    fold\n    more\n: 1",
                &["{ a: \"lit\\n\", b: \"fold more\" }"],
            ),
            (
                "? {a: \"long long long long long long long long long long long long long long long long long long\"}\n: 1",
                &[
                    "{\n  a: \"long long long long long long long long long long long long long long long\n    long long long\"\n}",
                ],
            ),
            (
                "? {\"long long long long long long long long long long long long long long long long long long\": a}\n: 1",
                &[
                    "{\n  \"long long long long long long long long long long long long long long long long long long\": a\n}",
                ],
            ),
            (
                "? {a: 'long long long long long long long long long long long long long long long long long long'}\n: 1",
                &[
                    "{\n  a: 'long long long long long long long long long long long long long long long\n    long long long'\n}",
                ],
            ),
            (
                "? [\"multi\\nline\\nstring with more than forty characters in total\"]\n: 1",
                &[
                    "[\n  \"multi\n\n    line\n\n    string with more than forty characters in total\"\n]",
                ],
            ),
            (
                "? {k: \"multi\\nline\\nstring with more than forty characters in total\"}\n: 1",
                &[
                    "{\n  k: \"multi\n\n    line\n\n    string with more than forty characters in total\"\n}",
                ],
            ),
            (
                "? {\"multi\\nline\\nstring with more than forty characters in total\": v}\n: 1",
                &["{ \"multi\\nline\\nstring with more than forty characters in total\": v }"],
            ),
            ("? {'a\n\n  b': v}\n: 1", &["{ \"a\\nb\": v }"]),
            ("? {x: a\n\n  b}\n: 1", &["{\n  x: a\n\n    b\n}"]),
            (
                "a: &a [1]\n? [*a, *a]\n: 1\n? *a\n: 2",
                &["a", "[ *a, *a ]", "*a"],
            ),
            ("? [1, 2]\n: a\n? [1, 2]\n: b", &["[ 1, 2 ]"]),
            ("? [a]\n: 1\n\"[ a ]\": 2", &["[ a ]"]),
            (
                "? [\"\\u0085\", \"\\u00a0x\", 'a\u{85}b']\n: 1",
                &["[ \"\u{85}\", \" x\", \"a\u{85}b\" ]"],
            ),
            (
                "? [!!str 0x10, !!str .inf, !!str ~, !!str '', !!str 1_000]\n: 1",
                &["[ !!str \"0x10\", !!str \".inf\", !!str \"~\", !!str '', !!str 1_000 ]"],
            ),
            (
                "? [0x7FFFFFFFFFFFFFFFFF, 0o777777777777777777777]\n: 1",
                &["[ 0x800000000000000000, 0o1000000000000000000000 ]"],
            ),
            (
                "? {a: [1, 2], b: [\n  3]}\n: 1",
                &["{ a: [ 1, 2 ], b: [ 3 ] }"],
            ),
            (
                "? - {a: b}\n  - [c]\n  - - d\n    - e\n: 1",
                &["[ { a: b }, [ c ], [ d, e ] ]"],
            ),
            (
                "? [a, [b, [c, [d, [e, [f, [g, [h, [i, [j, [k, [l, [m, [n, [o, [p, [q, [r, [s, [t]]]]]]]]]]]]]]]]]]]]\n: 1",
                &[
                    "[\n  a,\n  [\n      b,\n      [\n          c,\n          [\n              d,\n              [\n                  e,\n                  [\n                      f,\n                      [\n                          g,\n                          [\n                              h,\n                              [\n                                  i,\n                                  [ j, [ k, [ l, [ m, [ n, [ o, [ p, [ q, [ r, [ s, [ t ] ] ] ] ] ] ] ] ] ] ]\n                                ]\n                            ]\n                        ]\n                    ]\n                ]\n            ]\n        ]\n    ]\n]",
                ],
            ),
            (
                "? {a: {b: {c: {d: {e: {f: {g: {h: {i: {j: {k: {l: {m: {n: {o: {p: {q: {r: 1}}}}}}}}}}}}}}}}}}\n: 1",
                &[
                    "{\n  a:\n    {\n      b:\n        {\n          c:\n            {\n              d:\n                {\n                  e:\n                    {\n                      f:\n                        {\n                          g: { h: { i: { j: { k: { l: { m: { n: { o: { p: { q: { r: 1 } } } } } } } } } } }\n                        }\n                    }\n                }\n            }\n        }\n    }\n}",
                ],
            ),
            (
                "? - aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n    ccccccccccccccccc: [ddddddddddddddddddddddddddddd, eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee]\n: 1",
                &[
                    "[\n  {\n      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,\n      ccccccccccccccccc: [ ddddddddddddddddddddddddddddd, eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ]\n    }\n]",
                ],
            ),
        ];
        for (source, expected) in cases {
            let Ok(JsValue::Object(map)) = yaml_parse(source) else {
                panic!("写像として読めない: {source:?}");
            };
            let keys: Vec<&str> = map.keys().map(String::as_str).collect();
            assert_eq!(&keys, expected, "{source:?}");
        }
    }

    #[test]
    fn annotations_yaml_parse_failures() {
        assert_eq!(yaml_parse("a: 1\na: 2"), Err(YamlParseError::DuplicateKey));
        assert_eq!(
            yaml_parse("007: a\n7: b"),
            Err(YamlParseError::DuplicateKey)
        );
        assert_eq!(
            yaml_parse("a: 1\n---\nb: 2"),
            Err(YamlParseError::MultipleDocuments)
        );
        assert_eq!(yaml_parse("a: ["), Err(YamlParseError::Syntax));
        assert_eq!(yaml_parse(""), Ok(JsValue::Null));
    }

    // `%` だけの行は saphyr-parser が同じ誤りを返し続ける形。止まらなければ 10 秒で失敗にする (テストの処理を待ち続けない)。
    // frontmatter の読み取りを saphyr-parser のイベントから行う形 (A-120) の、止まらないことの確かめ
    #[test]
    fn annotations_frontmatter_stops_at_first_yaml_error() {
        for source in [
            "---\n%\n---\n# a\n",
            "---\n%zz\n---\n# a\n",
            "---\na: 1\n\n%zz-\n---\n# a\n",
        ] {
            let (sender, receiver) = mpsc::channel();
            thread::spawn(move || {
                let _ = sender.send(read_frontmatter(source).is_none());
            });
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(10)),
                Ok(true),
                "{source:?}"
            );
        }
        assert!(read_frontmatter("---\ntitle: T\n---\n# a\n").is_some());
    }

    // saphyr に渡す写しの書き換え (frontmatter の位置の木と共有): BOM、`:` と `?` の後ろのタブ、中身のない折り返しのスカラ、
    // 行をまたぐフローの閉じ、サロゲートの escape、NUL。値、行数、残りの本文、extracted は node の出力から生成した
    #[test]
    fn annotations_frontmatter_saphyr_rewrites_match_node() {
        let cases: &[(FrontmatterCase, bool)] = &[
            (
                (
                    "---\na:\t1\nmarkdag: {}\n---\n- x #t\n",
                    Some(("{\"a\":1,\"markdag\":{}}", 4, "- x #t\n")),
                ),
                true,
            ),
            (
                ("---\ntitle:\tT\n---\n", Some(("{\"title\":\"T\"}", 3, ""))),
                false,
            ),
            (
                (
                    "---\na:\n  b:\tc\n---\n",
                    Some(("{\"a\":{\"b\":\"c\"}}", 4, "")),
                ),
                false,
            ),
            (
                ("---\n? \ta\n: b\n---\n", Some(("{\"a\":\"b\"}", 4, ""))),
                false,
            ),
            (
                ("---\n? a\n:\tb\n---\n", Some(("{\"a\":\"b\"}", 4, ""))),
                false,
            ),
            (
                (
                    "---\n\u{feff}markdag: {}\n---\n- x #t\n",
                    Some(("{\"markdag\":{}}", 3, "- x #t\n")),
                ),
                true,
            ),
            (("---\na: |+\n---\n", Some(("{\"a\":\"\"}", 3, ""))), false),
            (("---\na: >\n---\n", Some(("{\"a\":\"\"}", 3, ""))), false),
            (("---\n- >\n\n---\n", Some(("[\"\"]", 4, ""))), false),
            (
                (
                    "---\nmarkdag: {}\ndescription: |\n---\n",
                    Some(("{\"markdag\":{},\"description\":\"\"}", 4, "")),
                ),
                true,
            ),
            (
                (
                    "---\nd:\n  e: |\n---\n",
                    Some(("{\"d\":{\"e\":\"\"}}", 4, "")),
                ),
                false,
            ),
            (
                (
                    "---\na: |\nb: 1\n---\n",
                    Some(("{\"a\":\"\",\"b\":1}", 4, "")),
                ),
                false,
            ),
            (
                (
                    "---\na: |+\n\nb: 1\n---\n",
                    Some(("{\"a\":\"\\n\",\"b\":1}", 5, "")),
                ),
                false,
            ),
            (
                (
                    "---\nmarkdag:\n  groups: [\n  ]\n---\n- x #t\n",
                    Some(("{\"markdag\":{\"groups\":[]}}", 5, "- x #t\n")),
                ),
                true,
            ),
            (("---\na: {\n}\n---\n", Some(("{\"a\":{}}", 4, ""))), false),
            (
                ("---\na: [ # c\n]\n---\n", Some(("{\"a\":[]}", 4, ""))),
                false,
            ),
            (("---\n- [\n]\n---\n", Some(("[[]]", 4, ""))), false),
            (
                (
                    "---\na: [\n  [\n  ]\n]\n---\n",
                    Some(("{\"a\":[[]]}", 6, "")),
                ),
                false,
            ),
            (
                (
                    "---\nm: [\n  \"x\" # c\n]\n---\n",
                    Some(("{\"m\":[\"x\"]}", 5, "")),
                ),
                false,
            ),
            (
                ("---\na: [ &x\n]\n---\n", Some(("{\"a\":[null]}", 4, ""))),
                false,
            ),
            (("---\na: [[\n]]\n---\n", None), false),
            (("---\nm:\n  g: [\n ]\n---\n", None), false),
            (
                (
                    "---\nm:\n  g: [\n  ]\n---\n",
                    Some(("{\"m\":{\"g\":[]}}", 5, "")),
                ),
                false,
            ),
            (
                (
                    "---\ntitle: \"\\ud83d\\ude00\"\nmarkdag: {}\n---\n- x #t\n",
                    Some(("{\"title\":\"😀\",\"markdag\":{}}", 4, "- x #t\n")),
                ),
                true,
            ),
            (
                (
                    "---\na: \"\\U0000D83D\\U0000DE00\\uDBFF\\uDFFF\"\n---\n",
                    Some(("{\"a\":\"😀\u{10ffff}\"}", 3, "")),
                ),
                false,
            ),
            (
                (
                    "---\n\"\\ud83d\\ude00\": 1\n---\n",
                    Some(("{\"😀\":1}", 3, "")),
                ),
                false,
            ),
            (
                (
                    "---\na: \"\\ue000\\ud83d\\ude00\"\n---\n",
                    Some(("{\"a\":\"\u{e000}😀\"}", 3, "")),
                ),
                false,
            ),
            (
                (
                    "---\na: b\u{0}c\nmarkdag: {}\n---\n- x #t\n",
                    Some(("{\"a\":\"b\\u0000c\",\"markdag\":{}}", 4, "- x #t\n")),
                ),
                true,
            ),
            (
                (
                    "---\na: \"b\u{0}c\"\nb: 'd\u{0}'\n---\n",
                    Some(("{\"a\":\"b\\u0000c\",\"b\":\"d\\u0000\"}", 4, "")),
                ),
                false,
            ),
            (
                (
                    "---\n# c\u{0}\na: |\n  x\u{0}y\n---\n",
                    Some(("{\"a\":\"x\\u0000y\\n\"}", 5, "")),
                ),
                false,
            ),
            (
                (
                    "---\na: \"\u{0}\\x01\u{2}\"\n---\n",
                    Some(("{\"a\":\"\\u0000\\u0001\\u0002\"}", 3, "")),
                ),
                false,
            ),
        ];
        for ((source, expected), extracted) in cases {
            match (read_frontmatter(source), expected) {
                (None, None) => {}
                (Some(info), Some((json, lines, rest))) => {
                    let expected_value: serde_json::Value =
                        serde_json::from_str(json).expect("テストの JSON");
                    assert_eq!(node_shape(&info.value), expected_value, "{source:?}");
                    assert_eq!(info.lines, *lines, "{source:?}");
                    assert_eq!(
                        js_slice(source, info.offset, source.len()),
                        *rest,
                        "{source:?}"
                    );
                }
                (found, _) => panic!("{source:?}: {found:?}"),
            }
            assert_eq!(
                probe_frontmatter(source).extracted,
                *extracted,
                "{source:?}"
            );
        }
    }

    // 孤立したサロゲートの escape は、旧実装 (eemeli/yaml) では孤立したサロゲートを持つ文字列になる。Rust の String は持てないので
    // U+FFFD にする (A-131 で依頼者の判断を待つ)。frontmatter は読める
    #[test]
    fn annotations_frontmatter_lone_surrogate_escape_becomes_replacement() {
        let cases: &[(&str, &str)] = &[
            ("a: \"\\ud800\"", "\u{fffd}"),
            ("a: \"x\\uDFFF\"", "x\u{fffd}"),
            ("a: \"\\ude00\\ud83d\"", "\u{fffd}\u{fffd}"),
            ("a: \"\\ud83dx\"", "\u{fffd}x"),
            ("a: \"\\ud83d\n  \\ude00\"", "\u{fffd} \u{fffd}"),
        ];
        for (raw, text) in cases {
            let mut expected = IndexMap::new();
            expected.insert("a".to_string(), JsValue::String((*text).to_string()));
            assert_eq!(yaml_parse(raw), Ok(JsValue::Object(expected)), "{raw:?}");
        }
    }

    #[test]
    fn annotations_unicode_classes_follow_js() {
        // \p{L} は Unicode 16.0 (node 22) と同じ表 (U+1C89 は 16.0 で足された字)。全コードポイントでの照合は migration/reviews/document1-impl.md
        let result = strip_annotations("- a #\u{1c89}");
        assert_eq!(
            result.annotations.get(&0).map(|a| a.tags.clone()),
            Some(vec![tag("\u{1c89}", &[], 1, 5, 2)])
        );
        // JS の \s は U+FEFF を含み U+0085 を含まない (値の [^\s"] と、見出しとリスト項目の行頭の \S)
        assert_eq!(
            strip_annotations("- a #k:x\u{feff}y").text,
            "- a #k:x\u{feff}y"
        );
        assert_eq!(strip_annotations("- a #k:x\u{85}y").text, "- a");
        assert!(!HEADING.is_match("# \u{feff}"));
        assert!(HEADING.is_match("# \u{85}"));
    }
    // (HTML, refText, milestone)。期待値は src/parse/document.ts の describeFirstLine の写しを Chromium (審判の harness と同じ Playwright) で動かして取った
    const DESCRIBE_CASES: &[(&str, &str, bool)] = &[
        ("a<br>\nb", "a", false),
        ("<strong>M</strong>", "M", true),
        (
            "<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path d=\"M1\"/></svg> <strong>M</strong>",
            "M",
            true,
        ),
        ("<strong>M</strong> x", "M x", false),
        ("\n<p data-lines=\"0,1\"><strong>M</strong></p>", "M", false),
        ("<strong>a<br>\nb</strong> c", "a", true),
        ("<strong>M</strong> <!-- c -->", "M", false),
        ("<!---->  <strong>M</strong>", "M", true),
        (
            "a &amp; b &lt;c&gt; &quot;d&quot;",
            "a & b <c> \"d\"",
            false,
        ),
        (
            "x &ampz &AMP; &lt &GT; &nbsp;y &apos; &apos &#128; &#0; &#xD800; &#x41 &#65; &#x110000; &# &#x;",
            "x &z & < > \u{a0}y ' &apos € � � A A � &# &#x;",
            false,
        ),
        ("a<script>x<br></script>b", "ax<br>b", false),
        ("<b>x</i>y</b>z", "xyz", false),
        // 旧実装は "a c" (2 つ目のブロックも混ざる。docs/ignore/bugs/TODO.md の a で 1 行目だけにした)
        ("<p>a</p>\n<pre><code>c\n</code></pre>", "a", false),
        ("a </br> b", "a", false),
        ("<svg/>a", "a", false),
        ("<svg><svg></svg><br></svg>a<br>b", "", false),
        ("e\u{301} \u{3000}x\t y", "é \u{3000}x y", false),
        ("<textarea>&lt;t&gt;</textarea>", "<t>", false),
        ("<!doctype html>a", "a", false),
        ("a <?pi?> b", "a b", false),
        ("<i>M</i>", "M", false),
        ("<STRONG>M</STRONG>", "M", true),
        ("<strong title=\"a>b\">M</strong>", "M", true),
        ("<strong title='x\">y'>M</strong>", "M", true),
        ("<strong a=b>M</strong>", "M", true),
        ("<strong/>M", "M", true),
        ("a <b", "a", false),
        ("a </", "a", false),
        ("a </> b", "a b", false),
        ("a </ x> b", "a b", false),
        ("<!-->a", "a", false),
        ("<!--->a", "a", false),
        ("<!-- a --!>b", "b", false),
        ("<!-- open", "", false),
        ("< a", "< a", false),
        ("a<style>s</STYLE >b", "asb", false),
        ("<title>&amp;t</title>x", "&tx", false),
        ("<strong>M</strong>\n", "M", true),
        ("", "", false),
        ("<img src=\"a.png\" alt=\"x\">", "", false),
        ("<strong></strong>x", "x", false),
        ("<br>", "", false),
        ("<strong>M<strong>", "M", true),
        ("<em><strong>M</strong></em>", "M", false),
        ("a<!-- x -->b", "ab", false),
    ];

    // (html, state, icons があるか, 期待値)。期待値は src/parse/document.ts の replaceLeadingMark を vite-node で動かして取った
    const REPLACE_CASES: &[(&str, TaskState, bool, &str)] = &[
        ("<svg a=\"1\"><path/></svg> a", TaskState::Done, true, "D a"),
        (
            "<svg a=\"1\"><path/></svg> a",
            TaskState::Done,
            false,
            "<svg a=\"1\"><path/></svg> a",
        ),
        ("[ ] a", TaskState::Doing, true, "[/] a"),
        ("[x] a", TaskState::Canceled, false, "[-] a"),
        ("[-] a", TaskState::Todo, true, "[ ] a"),
        ("[?] a", TaskState::Todo, true, "[?] a"),
        (
            " <svg a=\"1\"><path/></svg> a",
            TaskState::Done,
            true,
            " <svg a=\"1\"><path/></svg> a",
        ),
        ("plain", TaskState::Done, true, "plain"),
        ("[/]a", TaskState::Done, false, "[/]a"),
    ];

    // (原文, nodes の形)。nodes の形は document_nodes_shape (記号の絵は <todo> などに置き換える)。期待値は Rust の出力で、
    // 同じ原文を旧実装 (src/ を審判の harness の IIFE にして Chromium で動かしたもの) の parsed と比べて、DOM で正規化した html を含む全欄が一致することを確かめた。
    // ただし 2 つ目のブロックを持つ項目の refText は 1 行目だけにした (docs/ignore/bugs/TODO.md の a。旧実装は 2 つ目の段落、表、コード、引用ブロックの中身も混ざる)
    const PARSE_CASES: &[(&str, &str)] = &[
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  > q\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q</p>\n</blockquote>", "a", null, [], [], false, 0, [5, 7], null, "<p data-lines=\"6,7\">q</p>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  > q1\n\n  > q2\n- b\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<p data-lines=\"5,6\">a</p>\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q1</p>\n</blockquote>\n<blockquote data-lines=\"8,9\" class=\"mdag-details\">\n<p data-lines=\"8,9\">q2</p>\n</blockquote>", "a", null, [], [], false, 0, [5, 9], null, "<p data-lines=\"6,7\">q1</p>\n<p data-lines=\"8,9\">q2</p>"], [3, 1, 2, "\n<p data-lines=\"9,10\">b</p>", "b", null, [], [], false, 0, [9, 10], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- > only quote\n- b\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "&gt; only quote", "> only quote", null, [], [], false, 0, [5, 6], null, null], [3, 1, 2, "b", "b", null, [], [], false, 0, [6, 7], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n\n  > loose q\n\n  more text\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<p data-lines=\"5,6\">a</p>\n<blockquote data-lines=\"7,8\" class=\"mdag-details\">\n<p data-lines=\"7,8\">loose q</p>\n</blockquote>\n<p data-lines=\"9,10\">more text</p>", "a", null, [], [], false, 0, [5, 10], null, "<p data-lines=\"7,8\">loose q</p>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  > outer\n  > > inner\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a\n<blockquote data-lines=\"6,8\" class=\"mdag-details\">\n<p data-lines=\"6,7\">outer</p>\n<blockquote data-lines=\"7,8\">\n<p data-lines=\"7,8\">inner</p>\n</blockquote>\n</blockquote>", "a", null, [], [], false, 0, [5, 8], null, "<p data-lines=\"6,7\">outer</p>\n<blockquote data-lines=\"7,8\">\n<p data-lines=\"7,8\">inner</p>\n</blockquote>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  - child\n  > after list\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a", "a", null, [], [], false, 0, [5, 8], null, null], [3, 2, 3, "child", "child", null, [], [], false, 0, [6, 7], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n1. a\n   > q in ol\n2. b\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "1. a\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q in ol</p>\n</blockquote>", "1. a", null, [], [], false, 0, [5, 7], null, "<p data-lines=\"6,7\">q in ol</p>"], [3, 1, 2, "2. b", "2. b", null, [], [], false, 0, [7, 8], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- [ ] a\n  > q with task\n- [/] b\n  > doing q\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<todo> a\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q with task</p>\n</blockquote>", "a", null, [], [], false, 0, [5, 7], [5, "todo", false], "<p data-lines=\"6,7\">q with task</p>"], [3, 1, 2, "<doing> b\n<blockquote data-lines=\"8,9\" class=\"mdag-details\">\n<p data-lines=\"8,9\">doing q</p>\n</blockquote>", "b", null, [], [], false, 0, [7, 9], [7, "doing", false], "<p data-lines=\"8,9\">doing q</p>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  <blockquote>raw</blockquote>\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a<blockquote>raw</blockquote>", "araw", null, [], [], false, 0, [5, 7], null, null]]"##,
        ),
        (
            "# R\n\n- a\n  > q not extracted\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [0, 1], null, null], [2, 1, 2, "a\n<blockquote data-lines=\"3,4\">\n<p data-lines=\"3,4\">q not extracted</p>\n</blockquote>", "a", null, [], [], false, 0, [2, 4], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- **M**\n  > q\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<strong>M</strong>\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q</p>\n</blockquote>", "M", null, [], [], true, 0, [5, 7], null, "<p data-lines=\"6,7\">q</p>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a &amp; b\n  > q &lt;x&gt; \"d\" 日本\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a &amp; b\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q &lt;x&gt; &quot;d&quot; 日本</p>\n</blockquote>", "a & b", null, [], [], false, 0, [5, 7], null, "<p data-lines=\"6,7\">q &lt;x&gt; &quot;d&quot; 日本</p>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  > - list in q\n  > - two\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a\n<blockquote data-lines=\"6,8\" class=\"mdag-details\">\n<ul data-lines=\"6,8\">\n<li data-lines=\"6,7\">list in q</li>\n<li data-lines=\"7,8\">two</li>\n</ul>\n</blockquote>", "a", null, [], [], false, 0, [5, 8], null, "<ul data-lines=\"6,8\">\n<li data-lines=\"6,7\">list in q</li>\n<li data-lines=\"7,8\">two</li>\n</ul>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- \n  > empty first\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">empty first</p>\n</blockquote>", "", null, [], [], false, 0, [5, 7], null, "<p data-lines=\"6,7\">empty first</p>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- **M**\n- **M** x\n- x **M**\n- __M__\n- ***M***\n- **M**<br>two\n- **M**\n  second\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<strong>M</strong>", "M", null, [], [], true, 0, [5, 6], null, null], [3, 1, 2, "<strong>M</strong> x", "M x", null, [], [], false, 0, [6, 7], null, null], [4, 1, 2, "x <strong>M</strong>", "x M", null, [], [], false, 0, [7, 8], null, null], [5, 1, 2, "<strong>M</strong>", "M", null, [], [], true, 0, [8, 9], null, null], [6, 1, 2, "<em><strong>M</strong></em>", "M", null, [], [], false, 0, [9, 10], null, null], [7, 1, 2, "<strong>M</strong>&lt;br&gt;two", "M<br>two", null, [], [], false, 0, [10, 11], null, null], [8, 1, 2, "<strong>M</strong><br>\nsecond", "M", null, [], [], true, 0, [11, 13], null, null]]"##,
        ),
        (
            // 1 行目の生の HTML (<strong>、<b>、コメント) は書いたままの文字として表示し、名前にも入る。<strong> は太字にならないので
            // マイルストーンでもない (旧実装の refText は "raw"、"bold"、"M"、"**M**"。A-219)
            "---\nmarkdag: {}\n---\n# R\n\n- **a\n  b**\n- <strong>raw</strong>\n- <b>bold</b>\n- **M** <!-- c -->\n- <!-- c --> **M**\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<strong>a<br>\nb</strong>", "a", null, [], [], true, 0, [5, 7], null, null], [3, 1, 2, "&lt;strong&gt;raw&lt;/strong&gt;", "<strong>raw</strong>", null, [], [], false, 0, [7, 8], null, null], [4, 1, 2, "&lt;b&gt;bold&lt;/b&gt;", "<b>bold</b>", null, [], [], false, 0, [8, 9], null, null], [5, 1, 2, "<strong>M</strong> &lt;!-- c --&gt;", "M <!-- c -->", null, [], [], false, 0, [9, 10], null, null], [6, 1, 2, "&lt;!-- c --&gt; <strong>M</strong>", "<!-- c --> M", null, [], [], false, 0, [10, 11], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- first\n\n  **M**\n\n- **L**\n\n  x\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "\n<p data-lines=\"5,6\">first</p>\n<p data-lines=\"7,8\"><strong>M</strong></p>", "first", null, [], [], false, 0, [5, 9], null, null], [3, 1, 2, "\n<p data-lines=\"9,10\"><strong>L</strong></p>\n<p data-lines=\"11,12\">x</p>", "L", null, [], [], false, 0, [9, 12], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# **H**\n\n## **H2** $id\n\n## [ ] **T**\n\n- [x] **done**\n- [/] **doing** #k\n",
            r##"[[1, null, 1, "<strong>H</strong>", "H", null, [], [], true, 0, [3, 4], null, null], [2, 1, 2, "<strong>H2</strong>", "H2", "id", [], [], true, 0, [5, 6], null, null], [3, 1, 2, "<todo> <strong>T</strong>", "T", null, [], [], true, 0, [7, 8], [7, "todo", false], null], [4, 3, 3, "<done> <strong>done</strong>", "done", null, [], [], true, 0, [9, 10], [9, "done", true], null], [5, 3, 3, "<doing> <strong>doing</strong>", "doing", null, [], [["k", [], [11, 17, 2]]], true, 0, [10, 11], [10, "doing", false], null]]"##,
        ),
        (
            "# R\n\n- **not extracted**\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [0, 1], null, null], [2, 1, 2, "<strong>not extracted</strong>", "not extracted", null, [], [], false, 0, [2, 3], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- `**M**`\n- *M*\n- **M** \n- ** M **\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<code>**M**</code>", "**M**", null, [], [], false, 0, [5, 6], null, null], [3, 1, 2, "<em>M</em>", "M", null, [], [], false, 0, [6, 7], null, null], [4, 1, 2, "<strong>M</strong>", "M", null, [], [], true, 0, [7, 8], null, null], [5, 1, 2, "** M **", "** M **", null, [], [], false, 0, [8, 9], null, null]]"##,
        ),
        // 1 行目の生の HTML は書いたままの文字として表示し、名前にも入る (旧実装の refText は "a b c"、"a b"、"a"、"asb"、"ap{}b"。A-219)
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a <span>b</span> c\n- a <svg><text>x</text></svg> b\n- a <br> b\n- a </br> b\n- x &copy; y &nbsp;z &amp&lt\n- a<script>s</script>b\n- a<style>p{}</style>b\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a &lt;span&gt;b&lt;/span&gt; c", "a <span>b</span> c", null, [], [], false, 0, [5, 6], null, null], [3, 1, 2, "a &lt;svg&gt;&lt;text&gt;x&lt;/text&gt;&lt;/svg&gt; b", "a <svg><text>x</text></svg> b", null, [], [], false, 0, [6, 7], null, null], [4, 1, 2, "a &lt;br&gt; b", "a <br> b", null, [], [], false, 0, [7, 8], null, null], [5, 1, 2, "a &lt;/br&gt; b", "a </br> b", null, [], [], false, 0, [8, 9], null, null], [6, 1, 2, "x © y  z &amp;amp&amp;lt", "x © y  z &amp&lt", null, [], [], false, 0, [9, 10], null, null], [7, 1, 2, "a&lt;script&gt;s&lt;/script&gt;b", "a<script>s</script>b", null, [], [], false, 0, [10, 11], null, null], [8, 1, 2, "a&lt;style&gt;p{}&lt;/style&gt;b", "a<style>p{}</style>b", null, [], [], false, 0, [11, 12], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n\n  | t | u |\n  |---|---|\n  | 1 | 2 |\n- b\n\n  ```\n  code\n  ```\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "\n<p data-lines=\"5,6\">a</p>\n<table data-lines=\"7,10\">\n<thead data-lines=\"7,8\">\n<tr data-lines=\"7,8\">\n<th>t</th>\n<th>u</th>\n</tr>\n</thead>\n<tbody data-lines=\"9,10\">\n<tr data-lines=\"9,10\">\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>", "a", null, [], [], false, 0, [5, 10], null, null], [3, 1, 2, "\n<p data-lines=\"10,11\">b</p>\n<pre data-lines=\"12,15\"><code data-lines=\"12,15\">code\n</code></pre>", "b", null, [], [], false, 0, [10, 15], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# [x] Root\n\n## [/] doing\n\n## [-] canceled\n\n## [ ] todo\n\n- [X] upper\n- [x]\n- [ ]  two spaces\n",
            r##"[[1, null, 1, "<done> Root", "Root", null, [], [], false, 0, [3, 4], [3, "done", true], null], [2, 1, 2, "<doing> doing", "doing", null, [], [], false, 0, [5, 6], [5, "doing", false], null], [3, 1, 2, "<canceled> canceled", "canceled", null, [], [], false, 0, [7, 8], [7, "canceled", false], null], [4, 1, 2, "<todo> todo", "todo", null, [], [], false, 0, [9, 10], [9, "todo", false], null], [5, 4, 3, "<done> upper", "upper", null, [], [], false, 0, [11, 12], [11, "done", true], null], [6, 4, 3, "[x]", "[x]", null, [], [], false, 0, [12, 13], null, null], [7, 4, 3, "<todo>  two spaces", "two spaces", null, [], [], false, 0, [13, 14], [13, "todo", false], null]]"##,
        ),
        (
            "# R\n\n- [/] a\n- [-] b\n\n1. [ ] n\n2. [/] m\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [0, 1], null, null], [2, 1, 2, "", "", null, [], [], false, 0, [2, 5], null, null], [3, 2, 3, "<doing> a", "a", null, [], [], false, 0, [2, 3], [2, "doing", false], null], [4, 2, 3, "<canceled> b", "b", null, [], [], false, 0, [3, 5], [3, "canceled", false], null], [5, 1, 2, "", "", null, [], [], false, 0, [5, 7], null, null], [6, 5, 3, "1. <todo> n", "1. n", null, [], [], false, 0, [5, 6], [5, "todo", false], null], [7, 5, 3, "2. [/] m", "2. [/] m", null, [], [], false, 0, [6, 7], [6, "doing", false], null]]"##,
        ),
        (
            "[x] Setext\n===\n\n[/] s2\n---\n\n- a\n",
            r##"[[1, null, 1, "<done> Setext", "Setext", null, [], [], false, 0, [0, 2], [0, "done", true], null], [2, 1, 2, "<doing> s2", "s2", null, [], [], false, 0, [3, 5], [3, "doing", false], null], [3, 2, 3, "a", "a", null, [], [], false, 0, [6, 7], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n* [ ] star\n+ [-] plus\n\t- [/] tab\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<todo> star", "star", null, [], [], false, 0, [5, 6], [5, "todo", false], null], [3, 1, 2, "<canceled> plus", "plus", null, [], [], false, 0, [6, 8], [6, "canceled", false], null], [4, 3, 3, "<doing> tab", "tab", null, [], [], false, 0, [7, 8], [7, "doing", false], null]]"##,
        ),
        (
            "# R\n\n- [/]\n- [-]x\n- [/]\ttab\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [0, 1], null, null], [2, 1, 2, "[/]", "[/]", null, [], [], false, 0, [2, 3], null, null], [3, 1, 2, "[-]x", "[-]x", null, [], [], false, 0, [3, 4], null, null], [4, 1, 2, "[/]\ttab", "[/] tab", null, [], [], false, 0, [4, 5], [4, "doing", false], null]]"##,
        ),
        (
            "> - [ ] in quote\n\n# R\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [2, 3], null, null]]"##,
        ),
        (
            "---\ntitle: Tee\n---\n\n- a\n- b\n",
            r##"[[1, null, 1, "Tee", "Tee", null, [], [], false, 0, [4, 6], null, null], [2, 1, 2, "a", "a", null, [], [], false, 0, [4, 5], null, null], [3, 1, 2, "b", "b", null, [], [], false, 0, [5, 6], null, null]]"##,
        ),
        (
            "---\ntitle: 5\n---\n\n- a\n- b\n",
            r##"[[1, null, 1, "5", "5", null, [], [], false, 0, [4, 6], null, null], [2, 1, 2, "a", "a", null, [], [], false, 0, [4, 5], null, null], [3, 1, 2, "b", "b", null, [], [], false, 0, [5, 6], null, null]]"##,
        ),
        (
            "---\ntitle: \"  spaced   title \"\nmarkdag: {}\n---\n\n- a\n- b\n",
            r##"[[1, null, 1, "  spaced   title ", "spaced title", null, [], [], false, 0, [5, 7], null, null], [2, 1, 2, "a", "a", null, [], [], false, 0, [5, 6], null, null], [3, 1, 2, "b", "b", null, [], [], false, 0, [6, 7], null, null]]"##,
        ),
        (
            "---\n- a\n---\n\n- x\n- y\n",
            r##"[[1, null, 1, "", "", null, [], [], false, 0, [4, 6], null, null], [2, 1, 2, "x", "x", null, [], [], false, 0, [4, 5], null, null], [3, 1, 2, "y", "y", null, [], [], false, 0, [5, 6], null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  > q\n- **M**\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q</p>\n</blockquote>", "a", null, [], [], false, 0, [5, 7], null, "<p data-lines=\"6,7\">q</p>"], [3, 1, 2, "<strong>M</strong>", "M", null, [], [], true, 0, [7, 8], null, null]]"##,
        ),
        (
            "",
            r##"[[1, null, 1, "", "", null, [], [], false, 0, null, null, null]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a #t:v %g $id\n  > q\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q</p>\n</blockquote>", "a", "id", ["g"], [["t", ["v"], [6, 5, 4]]], false, 0, [5, 7], null, "<p data-lines=\"6,7\">q</p>"]]"##,
        ),
        // 1 行目の生の <p> は書いたままの文字 (旧実装の refText は "a x"。A-219)
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a <p>x\n  > q after open p\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "a &lt;p&gt;x\n<blockquote data-lines=\"6,7\" class=\"mdag-details\">\n<p data-lines=\"6,7\">q after open p</p>\n</blockquote>", "a <p>x", null, [], [], false, 0, [5, 7], null, "<p data-lines=\"6,7\">q after open p</p>"]]"##,
        ),
        (
            "---\nmarkdag: {}\n---\n# R\n\n- a\n  <div>\n\n  > q1\n\n  </div>\n\n  > q2\n",
            r##"[[1, null, 1, "R", "R", null, [], [], false, 0, [3, 4], null, null], [2, 1, 2, "<p data-lines=\"5,6\">a</p>\n<div>\n<blockquote data-lines=\"8,9\">\n<p data-lines=\"8,9\">q1</p>\n</blockquote>\n</div>\n<blockquote data-lines=\"12,13\" class=\"mdag-details\">\n<p data-lines=\"12,13\">q2</p>\n</blockquote>", "a", null, [], [], false, 0, [5, 13], null, "<p data-lines=\"12,13\">q2</p>"]]"##,
        ),
    ];

    // ---- 後半 (document.ts:178-324) ----

    #[test]
    fn document_lazy_regexes_compile() {
        // 規則 1 章 (A-021): すべての LazyLock を 1 度触る
        for regex in [&*REF_SPACES, &*LEADING_ICON, &*LEADING_MARK] {
            assert!(!regex.as_str().is_empty());
        }
    }

    #[test]
    fn document_describe_first_line_matches_browser() {
        for (html, ref_text, milestone) in DESCRIBE_CASES {
            let expected = DescribeFirstLineResult {
                ref_text: (*ref_text).to_string(),
                milestone: *milestone,
            };
            assert_eq!(describe_first_line(html), expected, "{html:?}");
        }
    }

    // (id, refText, refId, groups) の組
    fn names_and_marks(source: &str) -> Vec<(u32, String, Option<String>, Vec<String>)> {
        parse_document(source)
            .nodes
            .into_iter()
            .map(|node| (node.id, node.ref_text, node.ref_id, node.groups))
            .collect()
    }

    #[test]
    fn document_nameless_nodes_have_no_name() {
        // 名前は 1 行目の文字 (A-219)。1 行目にブロックの書き始め (表、コード、HTML、引用) や生の HTML を書いても、書いたままの文字が名前になる。
        // インラインの飾りは外し、magic comment は名前に入れない。1 行目が空の項目だけが名前を持たない
        let source = concat!(
            "---\nmarkdag: {}\n---\n# R\n\n",
            "- | x | y |\n  |---|---|\n  | 1 | 2 |\n",
            "- ```\n  code\n  ```\n",
            "- <div>\n  raw\n  </div>\n",
            "- <b>重要</b> 作業\n",
            "- > quoted\n",
            "- **飾り** と `code` と [リンク](https://example.com)\n",
            "- 行末のコメント <!-- markmap: fold -->\n",
            "- a<br>b\n",
            "-\n  | c |\n  |---|\n  | 3 |\n",
        );
        let names: Vec<String> = names_and_marks(source)
            .into_iter()
            .map(|(_, name, _, _)| name)
            .collect();
        assert_eq!(
            names,
            [
                "R",
                "| x | y |",
                "```",
                "<div>",
                "<b>重要</b> 作業",
                "> quoted",
                "飾り と code と リンク",
                "行末のコメント",
                "a<br>b",
                ""
            ]
        );
        // 見出しの生の HTML も書いたままの文字で名前に入る
        let headings =
            names_and_marks("---\nmarkdag: {}\n---\n# R\n## <span>H</span> 見出し\n## **H2**\n");
        assert_eq!(
            headings
                .iter()
                .map(|(_, name, _, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["R", "<span>H</span> 見出し", "H2"]
        );
        // 見出しの下の表とコードのブロックのノードはラベルの行を持てないので名前を持たない
        let blocks = names_and_marks("# R\n\n| x |\n|---|\n| 1 |\n\n```\ncode\n```\n");
        assert_eq!(
            blocks
                .iter()
                .map(|(_, name, _, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["R", "", ""]
        );
    }

    #[test]
    fn document_first_line_raw_html_is_shown_as_written() {
        // 1 行目の生の HTML は解釈せず、書いたままの文字として表示し、名前にも入る (A-219)。2 行目以降の生の HTML は今までどおり
        let parsed = parse_document(concat!(
            "---\nmarkdag: {}\n---\n# R <i>x</i>\n\n",
            "- 名前 <!-- メモ -->\n",
            "- a<br>b\n",
            "- <b>重要</b> 作業\n",
            "- ラベル\n  <b>2 行目</b>\n",
            "- 折りたたむ <!-- markmap: fold -->\n  - 子\n",
        ));
        let shape: Vec<(&str, &str)> = parsed
            .nodes
            .iter()
            .map(|node| (node.ref_text.as_str(), node.html.as_str()))
            .collect();
        assert_eq!(
            shape,
            [
                ("R <i>x</i>", "R &lt;i&gt;x&lt;/i&gt;"),
                ("名前 <!-- メモ -->", "名前 &lt;!-- メモ --&gt;"),
                ("a<br>b", "a&lt;br&gt;b"),
                ("<b>重要</b> 作業", "&lt;b&gt;重要&lt;/b&gt; 作業"),
                ("ラベル", "ラベル<br>\n<b>2 行目</b>"),
                ("折りたたむ", "折りたたむ"),
                ("子", "子"),
            ]
        );
        let heading = parse_document("---\nmarkdag: {}\n---\n# R\n## <span>見出し</span>\n");
        assert_eq!(heading.nodes[1].ref_text, "<span>見出し</span>");
        assert_eq!(heading.nodes[1].html, "&lt;span&gt;見出し&lt;/span&gt;");
        // markmap の magic comment は折りたたみの印のまま (表示にも名前にも出ない)
        assert_eq!(parsed.nodes[5].fold_hint, 1.0);
        // markdag の記法を読まない文書は markmap と同じく生の HTML を読む
        let plain = parse_document("# R\n- <b>重要</b> 作業\n");
        assert_eq!(plain.nodes[1].html, "<b>重要</b> 作業");
    }

    #[test]
    fn document_first_line_block_starts_are_text() {
        // 1 行目のブロックの書き始めは文字として表示し、ブロックにしない。2 行目以降は、それだけでブロックになるかで決まる (A-219)
        let parsed = parse_document(concat!(
            "---\nmarkdag: {}\n---\n# R\n\n",
            "- | x | y |\n  |---|---|\n  | 1 | 2 |\n",
            "- ```js\n  code\n  ```\n",
            "- <div>\n  inner\n  </div>\n",
            "- > q\n  > 2 行目の引用\n",
            "- # H\n",
            "- - a\n  - b\n",
            "- 1. one\n",
            "- ***\n",
            "- [ ] <b>task</b>\n",
        ));
        let shape: Vec<(&str, &str)> = parsed
            .nodes
            .iter()
            .map(|node| (node.ref_text.as_str(), node.html.as_str()))
            .collect();
        assert_eq!(
            shape,
            [
                ("R", "R"),
                ("| x | y |", "| x | y |<br>\n|---|---|<br>\n| 1 | 2 |"),
                (
                    "```js",
                    "```js<br>\ncode<pre data-lines=\"10,11\"><code data-lines=\"10,11\"></code></pre>"
                ),
                ("<div>", "&lt;div&gt;<br>\ninner</div>"),
                (
                    "> q",
                    "&gt; q\n<blockquote data-lines=\"15,16\" class=\"mdag-details\">\n<p data-lines=\"15,16\">2 行目の引用</p>\n</blockquote>"
                ),
                ("# H", "# H"),
                ("- a", "- a"),
                ("b", "b"),
                ("1. one", "1. one"),
                ("***", "***"),
                (
                    "<b>task</b>",
                    &format!("{UNMARKED} &lt;b&gt;task&lt;/b&gt;") as &str
                ),
            ]
        );
        assert_eq!(
            parsed.nodes[4].details.as_deref(),
            Some("<p data-lines=\"15,16\">2 行目の引用</p>")
        );
        assert!(parsed.nodes[10].task.is_some());
        // 前の項目のブロックが閉じたことで、後ろの行が新しい項目の 1 行目になる場合も文字にする
        let chained =
            parse_document("---\nmarkdag: {}\n---\n# R\n- ```\n- | a |\n  |---|\n  ```\n");
        let names: Vec<&str> = chained
            .nodes
            .iter()
            .map(|node| node.ref_text.as_str())
            .collect();
        assert_eq!(names, ["R", "```", "| a |"]);
    }

    #[test]
    fn document_label_and_id_lines_name_a_block() {
        // ブロックの前のラベルの行は名前になり、ブロックの文字とは連結しない。$id だけの行は 1 行目が空なので名前を持たず $id を付ける
        let source = concat!(
            "---\nmarkdag: {}\n---\n# R\n\n",
            "- 集計表 $sum %g\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n",
            "- $note\n  <div>inner</div>\n",
            "- <b>重要</b> 作業 $imp\n",
        );
        assert_eq!(
            names_and_marks(source),
            [
                (1, "R".to_string(), None, vec![]),
                (
                    2,
                    "集計表".to_string(),
                    Some("sum".to_string()),
                    vec!["g".to_string()]
                ),
                (3, String::new(), Some("note".to_string()), vec![]),
                (
                    4,
                    "<b>重要</b> 作業".to_string(),
                    Some("imp".to_string()),
                    vec![]
                ),
            ]
        );
        // ラベルの下の表は表のまま
        assert!(parse_document(source).nodes[1].html.contains("<table"));
    }

    #[test]
    fn document_block_lines_keep_their_marks_as_text() {
        // 1 行目がブロックの書き始めに見える行でも、行末の印は読む (A-219。A-218 (4) の「読まない」を置き換えた)。
        // 行末にない印 (表の行の中の $t) は今までどおり文字
        let source = concat!(
            "---\nmarkdag: {}\n---\n# R\n\n",
            "- <div> $d %g\n  hello\n  </div>\n",
            "- | x | $t |\n  |---|---|\n  | 1 | 2 |\n",
            "- 普通の行 $ok\n",
            "- ~~~ $c\n  code\n  ~~~\n",
        );
        let parsed = parse_document(source);
        let marks: Vec<(Option<&str>, usize)> = parsed
            .nodes
            .iter()
            .map(|node| (node.ref_id.as_deref(), node.groups.len()))
            .collect();
        assert_eq!(
            marks,
            [
                (None, 0),
                (Some("d"), 1),
                (None, 0),
                (Some("ok"), 0),
                (Some("c"), 0)
            ]
        );
        assert!(parsed.nodes[1].html.contains("&lt;div&gt;<br>"));
        assert!(!parsed.nodes[1].html.contains("$d"));
        assert!(parsed.nodes[2].html.contains("| x | $t |"));
        assert!(!parsed.nodes[2].html.contains("<table"));
        assert_eq!(parsed.nodes[4].ref_text, "~~~");
        assert_eq!(strip_annotations("- <div> $d\n").annotations.len(), 1);
    }

    #[test]
    fn document_describe_first_line_keeps_first_line_only() {
        // refText は 1 行目だけ。2 つ目の段落、表、コード、引用ブロック、生の HTML のブロックは混ざらない (TODO の a)
        let cases: &[(&str, &str, bool)] = &[
            (
                "\n<p data-lines=\"2,3\">a</p>\n<p data-lines=\"4,5\">b</p>",
                "a",
                false,
            ),
            (
                "a\n<table data-lines=\"3,6\">\n<tr><td>x</td></tr>\n</table>",
                "a",
                false,
            ),
            (
                "\n<p data-lines=\"6,7\">f</p>\n<pre data-lines=\"7,10\"><code>c\n</code></pre>",
                "f",
                false,
            ),
            (
                "<div>raw</div>\n<p data-lines=\"2,3\">after</p>",
                "raw",
                false,
            ),
            (
                "<p data-lines=\"5,6\">a</p>\n<div>\n<blockquote data-lines=\"8,9\">\n<p>q</p>\n</blockquote>\n</div>",
                "a",
                false,
            ),
            // 詳細を除いた内容の、詳細のあとの文字
            ("a\n\n  tail", "a", false),
            // 1 つ目のブロックに文字がなければ空 (2 つ目のブロックの文字は拾わない)
            (
                "\n<p data-lines=\"1,2\"><img src=x></p>\n<p data-lines=\"3,4\">b</p>",
                "",
                false,
            ),
            // 段落の中の <p> でない生の HTML、段落の中の改行 (<br>)、1 つのブロックの中の改行はそのまま
            ("a <div>x</div> b", "a x b", false),
            (
                "<p data-lines=\"1,3\">w <span>s</p>\n<p data-lines=\"4,5\">p2</p>",
                "w s",
                false,
            ),
            (
                "\n<pre data-lines=\"1,4\"><code>c\nd\n</code></pre>",
                "c d",
                false,
            ),
            ("<div>\nraw\nmore\n</div>", "raw more", false),
            // milestone は旧実装のまま (最初の <br> までの意味のある子を数える)
            ("<strong>M</strong>", "M", true),
            (
                "\n<p data-lines=\"1,2\"><strong>M</strong></p>\n<p data-lines=\"3,4\">t</p>",
                "M",
                false,
            ),
        ];
        for (html, ref_text, milestone) in cases {
            let expected = DescribeFirstLineResult {
                ref_text: (*ref_text).to_string(),
                milestone: *milestone,
            };
            assert_eq!(describe_first_line(html), expected, "{html:?}");
        }
        // 文書から: 段落を 2 つ持つ項目を 1 つ目の段落の名前で読む
        let parsed = parse_document("# R\n\n- a\n\n  b\n- c\n  | x |\n  |---|\n  | 1 |\n");
        let names: Vec<&str> = parsed
            .nodes
            .iter()
            .map(|node| node.ref_text.as_str())
            .collect();
        assert_eq!(names, ["R", "a", "c"]);
    }

    #[test]
    fn document_normalize_ref_text_joins_spaces_and_nfc() {
        // `[ \t\n]+` だけを 1 つの空白にし (全角空白と NBSP は残す)、両端は JS の trim で落とす
        assert_eq!(
            normalize_ref_text("  e\u{301}\t\n a \u{3000} b\u{a0}"),
            "é a \u{3000} b"
        );
        assert_eq!(normalize_ref_text("\u{feff}x\u{feff}"), "x");
    }

    // 詳細の候補の引用ブロックを、アウトラインと同じ形の断片 (Html と Quote) に分ける。Quote は data-lines を持つ開きのタグから閉じのタグまで
    fn parts_of(html: &str) -> Vec<ContentPart> {
        let mut parts = Vec::new();
        let mut rest = html;
        while let Some(start) = rest.find("<blockquote data-lines") {
            let (before, quote) = rest.split_at(start);
            let open_end = quote.find(">\n").expect("開きのタグ") + 2;
            let close_start = quote.find("</blockquote>").expect("閉じのタグ");
            let close_end = close_start
                + "</blockquote>".len()
                + usize::from(quote[close_start..].starts_with("</blockquote>\n"));
            // 開きのトークンの書き出しは、前の隠れた段落のあとの改行を含む
            let (before, lead) = match before.strip_suffix('\n') {
                Some(before) => (before, "\n"),
                None => (before, ""),
            };
            parts.push(ContentPart::Html(before.to_string()));
            parts.push(ContentPart::Quote {
                open: format!("{lead}{}", &quote[..open_end]),
                inner: quote[open_end..close_start].to_string(),
                close: quote[close_start..close_end].to_string(),
            });
            rest = &quote[close_end..];
        }
        parts.push(ContentPart::Html(rest.to_string()));
        parts
    }

    #[test]
    fn document_split_details_matches_browser() {
        // (内容, html, details)。期待値は src/parse/document.ts の splitDetails の写しを Chromium で動かして取った。
        // 生の HTML を含む内容の html は DOM の直列化 (閉じのタグの補い) が違うので details だけを比べる (html は None)
        let q = "<blockquote data-lines=\"1,2\">\n<p data-lines=\"1,2\">q</p>\n</blockquote>";
        let marked = "<blockquote data-lines=\"1,2\" class=\"mdag-details\">\n<p data-lines=\"1,2\">q</p>\n</blockquote>";
        let details = Some("<p data-lines=\"1,2\">q</p>");
        let cases: Vec<(String, Option<String>, Option<&str>)> = vec![
                (format!("a\n{q}"), Some(format!("a\n{marked}")), details),
                (
                    "a\n<blockquote data-lines=\"1,2\">\n<p data-lines=\"1,2\">q1</p>\n</blockquote>\n<blockquote data-lines=\"3,4\">\n<p data-lines=\"3,4\">q2</p>\n</blockquote>\n  tail".to_string(),
                    Some("a\n<blockquote data-lines=\"1,2\" class=\"mdag-details\">\n<p data-lines=\"1,2\">q1</p>\n</blockquote>\n<blockquote data-lines=\"3,4\" class=\"mdag-details\">\n<p data-lines=\"3,4\">q2</p>\n</blockquote>\n  tail".to_string()),
                    Some("<p data-lines=\"1,2\">q1</p>\n<p data-lines=\"3,4\">q2</p>"),
                ),
                (format!("\n{q}"), Some(marked.to_string()), details),
                ("a\n<blockquote>raw</blockquote>".to_string(), Some("a\n<blockquote>raw</blockquote>".to_string()), None),
                (format!("a <b>x\n{q}"), Some(format!("a <b>x\n{q}")), None),
                (format!("a <p>x\n{q}"), None, details),
                (format!("<div>\n{q}"), Some(format!("<div>\n{q}")), None),
                (format!("<div></div>\n{q}"), Some(format!("<div></div>\n{marked}")), details),
                ("<table><tr><td><p>x\n<blockquote data-lines=\"1,2\">\n<p>q</p>\n</blockquote>".to_string(), None, None),
            ];
        for (content, html, details) in cases {
            let result = split_details(&content, &parts_of(&content));
            if let Some(html) = html {
                assert_eq!(result.html, html, "{content:?}");
            }
            assert_eq!(result.details.as_deref(), details, "{content:?}");
        }
    }

    #[test]
    fn document_split_details_keeps_content_without_quotes() {
        // 詳細がなければ内容をそのまま返す (trim もしない)
        let content = "\n<p data-lines=\"1,2\">a</p>";
        let result = split_details(content, &[]);
        assert_eq!(
            result,
            SplitDetailsResult {
                html: content.to_string(),
                plain: content.to_string(),
                details: None
            }
        );
        // 詳細を除いた内容には、要素の外の改行が残る (参照用のテキストだけに使う)
        let content = "a\n<blockquote data-lines=\"1,2\">\n<p>q</p>\n</blockquote>\n  tail";
        assert_eq!(
            split_details(content, &parts_of(content)).plain,
            "a\n\n  tail"
        );
    }

    #[test]
    fn document_top_level_after_raw_html() {
        // 引用ブロックの前で開いたままの要素があれば、引用ブロックはその中に入る。開いた p は blockquote の開きで閉じる
        assert!(is_top_level_after("a <b>x</b>\n"));
        assert!(!is_top_level_after("a <b>x\n"));
        assert!(is_top_level_after("a <p>x\n"));
        assert!(!is_top_level_after("<div><p>x\n"));
        assert!(!is_top_level_after("<table><tr><td><p>x\n"));
        assert!(is_top_level_after("<p>a <b>x</p>\n"));
        assert!(is_top_level_after("a <br> <img src=x> <svg/> <i></i>\n"));
        assert!(!is_top_level_after("a <i/>\n"));
        assert!(is_top_level_after("<svg><path/><br>"));
        assert!(is_top_level_after("<div></span></div>"));
    }

    // ---- document2-fix の回帰テスト。期待値は旧実装から取った: 関数単位は原文の関数本体を Chromium の DOMParser で、
    // 文書単位は harness の IIFE (judge.snapshot(md).parsed) を Chromium で動かした ----

    // (内容, refText, milestone)。生の HTML の木の組み立て (foreign content、無視されるタグ、PLAINTEXT) と CR の前処理
    const DESCRIBE_RAW_HTML_CASES: &[(&str, &str, bool)] = &[
        // DOMParser の入力の前処理で CR と CRLF は LF になる。文字参照の &#13; は字句のあとなので CR のまま
        ("r \r s", "r s", false),
        ("a \r b \u{c} c", "a b \u{c} c", false),
        ("a <span>\r</span> b", "a b", false),
        // CRLF の LF は 1 行目の区切り (旧実装は "a b"。TODO の a)。単独の CR は区切りにしない (&#13; からしか来ない)
        ("a\r\nb", "a", false),
        ("a\r\r\nb", "a", false),
        ("a\r<br>b", "a", false),
        ("a &#13; b", "a \r b", false),
        // body の中の <html> <body> <head> と、表の外の表の部品は無視される
        ("<span></span><html><strong>M</strong>", "M", true),
        ("<span></span><body><strong>M</strong>", "M", true),
        ("<span></span><head><strong>M</strong>", "M", true),
        ("<svg><body><strong>M</strong>", "M", true),
        ("<td><strong>M</strong>", "M", true),
        ("<tr><strong>M</strong>", "M", true),
        ("<caption><strong>M</strong>", "M", true),
        ("<colgroup><strong>M</strong>", "M", true),
        ("<td>x</td><strong>M</strong>", "xM", false),
        ("a</body>b", "ab", false),
        // PLAINTEXT: 残りはすべて文字 (閉じの </body> も)
        ("<plaintext><b>x</b>", "<b>x</b></body>", false),
        ("a <plaintext><br>b", "a <br>b</body>", false),
        (
            "a <plaintext>&amp; <!-- c -->",
            "a &amp; <!-- c --></body>",
            false,
        ),
        ("<p><plaintext>x", "x</body>", false),
        ("<strong>M</strong><plaintext>", "M</body>", false),
        // svg / math の HTML integration point の中は HTML として読み、外に出ない (svg ごと除かれる)
        (
            "<svg><foreignObject><div>z</div></foreignObject></svg> b",
            "b",
            false,
        ),
        ("<svg><desc><b>z</b></desc></svg> b", "b", false),
        (
            "<svg><foreignObject><br>z</foreignObject></svg>q",
            "q",
            false,
        ),
        ("<math><mi><strong>M</strong></mi></math>", "M", false),
        // math の中の太字は外に出る
        ("<math><strong>M</strong>", "M", true),
        // 属性つきの font は外に出る。属性のない font は出ない
        ("<svg><font color=red>f</font>z</svg>w", "fzw", false),
        ("<svg><font size=1>q</font></svg>z", "qz", false),
        ("<svg><font>f</font>z</svg>w", "w", false),
        ("<svg></p>z", "z", false),
    ];

    #[test]
    fn document_describe_first_line_reads_raw_html_like_dom() {
        for (html, ref_text, milestone) in DESCRIBE_RAW_HTML_CASES {
            let expected = DescribeFirstLineResult {
                ref_text: (*ref_text).to_string(),
                milestone: *milestone,
            };
            assert_eq!(describe_first_line(html), expected, "{html:?}");
        }
    }

    #[test]
    fn document_top_level_after_follows_tree_construction() {
        // (引用ブロックの前の内容, 詳細になるか)
        let cases: &[(&str, bool)] = &[
            // 引用ブロックの開きは svg / math の中から外に出る。integration point の中では出ない
            ("a <svg>\n", true),
            ("a <math>\n", true),
            ("a <svg><g>\n", true),
            ("a <p><svg>\n", true),
            ("a <math><annotation-xml>\n", true),
            ("a <svg><foreignObject>\n", false),
            ("a <svg><desc>\n", false),
            ("a <svg><title>\n", false),
            ("a <math><mi>\n", false),
            ("a <math><mtext>\n", false),
            ("a <div><svg>\n", false),
            ("a <svg><foreignObject><div>\n", false),
            ("a <svg><foreignObject><svg>\n", false),
            // 表の中 (セルと caption の外) の引用ブロックは表の前に出される (foster parenting)
            ("a <table>\n", true),
            ("a <table><tr>\n", true),
            ("a <table><tbody>\n", true),
            ("a <table><thead><tr>\n", true),
            ("a <table><colgroup>\n", true),
            ("a <table><span></span>\n", true),
            ("a <table><tr><td></td>\n", true),
            ("a <table><p>\n", true),
            ("a <table><svg>\n", true),
            ("a <table></table>\n", true),
            ("a <table><tr><td>\n", false),
            ("a <table><tr><th>\n", false),
            ("a <table><caption>\n", false),
            ("a <table><span>\n", false),
            ("a <div><table>\n", false),
            ("a <table><tr><td><table>\n", false),
            ("a <table><tr><td><table></table>\n", false),
            // 無視される開きのタグは要素にならない
            ("a <html>\n", true),
            ("a <body>\n", true),
            ("a <head>\n", true),
            ("a <td>\n", true),
            ("a <tr>\n", true),
            ("a <colgroup>\n", true),
            ("a <frame>\n", true),
            ("a <svg><body>\n", true),
            ("a <div><body>\n", false),
            // PLAINTEXT のあとの引用ブロックは文字になる
            ("a <plaintext>\n", false),
        ];
        for (before, top_level) in cases {
            assert_eq!(is_top_level_after(before), *top_level, "{before:?}");
        }
    }

    #[test]
    fn document_top_level_after_follows_old_cheerio_pass() {
        // 旧実装は cheerio (htmlparser2) で読み直してから DOMParser に渡す。期待値は文書単位の旧実装 (`- a <前>\n  > q`)。
        // DOMParser だけなら、<table> は p を閉じず (quirks mode)、閉じのタグは表や integration point を越えない
        let cases: &[(&str, bool)] = &[
            ("a <p><table>\n", true),
            ("a <p>x<table></p>\n", true),
            ("a <div><table></div>\n", true),
            ("a <b><table></b>\n", true),
            ("a <span><table></span>\n", true),
            ("a <p><button></p>\n", true),
            ("a <svg><foreignObject><div></svg>\n", true),
            ("a <table><tr><td></tr>\n", true),
            ("a <table><caption></table>\n", true),
            ("a <font color=red><table></font>\n", true),
            ("a <svg><font color=red>\n", false),
            ("a <svg><font size=1>\n", false),
            ("a <svg><font>\n", true),
            ("a <a><table>\n", false),
            ("a <table><div>\n", false),
            ("a <table><td>\n", false),
            ("a <p><div>\n", false),
            ("a <h1><h2>\n", false),
        ];
        for (before, top_level) in cases {
            assert_eq!(is_top_level_after(before), *top_level, "{before:?}");
        }
    }

    #[test]
    fn document_split_details_keeps_nbsp_and_normalizes_cr() {
        // body.innerHTML.trim(): innerHTML は U+00A0 を &nbsp; と書くので trim で落ちない (旧実装の html は `&nbsp;a…`。ここは直列化し直さないので U+00A0)。
        // CR と CRLF は DOM に読んだ時点で LF になる
        let q = "<blockquote data-lines=\"1,2\">\n<p data-lines=\"1,2\">q</p>\n</blockquote>";
        let marked = "<blockquote data-lines=\"1,2\" class=\"mdag-details\">\n<p data-lines=\"1,2\">q</p>\n</blockquote>";
        let details = "<p data-lines=\"1,2\">q</p>";
        let cases: Vec<(String, String, String, String)> = vec![
            (format!("\u{a0}a\n{q}"), format!("\u{a0}a\n{marked}"), "\u{a0}a".to_string(), details.to_string()),
            (format!("\u{a0}\u{3000}a\n{q}"), format!("\u{a0}\u{3000}a\n{marked}"), "\u{a0}\u{3000}a".to_string(), details.to_string()),
            (
                format!("\u{a0}<strong>M</strong>\n{q}"),
                format!("\u{a0}<strong>M</strong>\n{marked}"),
                "\u{a0}<strong>M</strong>".to_string(),
                details.to_string(),
            ),
            (format!("a\u{a0}\n{q}"), format!("a\u{a0}\n{marked}"), "a\u{a0}".to_string(), details.to_string()),
            (format!("a\n{q}\u{a0}"), format!("a\n{marked}\u{a0}"), "a\n\u{a0}".to_string(), details.to_string()),
            (format!("a \r b\n{q}"), format!("a \n b\n{marked}"), "a \n b".to_string(), details.to_string()),
            (format!("a\r\n{q}"), format!("a\n{marked}"), "a".to_string(), details.to_string()),
            (
                "a\n<blockquote data-lines=\"1,2\">\n<p data-lines=\"1,2\">q \r r</p>\n</blockquote>".to_string(),
                "a\n<blockquote data-lines=\"1,2\" class=\"mdag-details\">\n<p data-lines=\"1,2\">q \n r</p>\n</blockquote>".to_string(),
                "a".to_string(),
                "<p data-lines=\"1,2\">q \n r</p>".to_string(),
            ),
        ];
        for (content, html, plain, details) in cases {
            let result = split_details(&content, &parts_of(&content));
            assert_eq!(
                result,
                SplitDetailsResult {
                    html,
                    plain,
                    details: Some(details)
                },
                "{content:?}"
            );
        }
    }

    #[test]
    fn document_parse_raw_html_fixes_match_old_implementation() {
        // 文書単位の旧実装の値 (html は DOM で正規化すれば同じ。旧実装は `&nbsp;` と閉じのタグを書く)
        let front = "---\nmarkdag: {}\n---\n# r\n";
        let quote = "<p data-lines=\"5,6\">q</p>";
        for item in [
            "- a <svg>\n  > q\n",
            "- a <math>\n  > q\n",
            "- a <table>\n  > q\n",
            "- a <table><tr>\n  > q\n",
            "- a <html>\n  > q\n",
        ] {
            let parsed = parse_document(&format!("{front}{item}"));
            let node = &parsed.nodes[1];
            // 1 行目の生の HTML は書いたままの文字なので、閉じていない要素が詳細を飲み込まない (旧実装の refText は "a"。A-219)
            let first_line = item
                .lines()
                .next()
                .unwrap_or_default()
                .trim_start_matches("- ");
            assert_eq!(
                (node.ref_text.as_str(), node.details.as_deref()),
                (first_line, Some(quote)),
                "{item:?}"
            );
            assert!(
                node.html
                    .contains("<blockquote data-lines=\"5,6\" class=\"mdag-details\">"),
                "{item:?}"
            );
        }
        let parsed = parse_document(&format!("{front}- \u{a0}a\n  > q\n"));
        assert_eq!(
            parsed.nodes[1].html,
            "\u{a0}a\n<blockquote data-lines=\"5,6\" class=\"mdag-details\">\n<p data-lines=\"5,6\">q</p>\n</blockquote>"
        );
        assert_eq!(parsed.nodes[1].ref_text, "a");
        // Markdown の &#13; は HTML の層が生の CR にし、DOM に読むと LF になる
        assert_eq!(parse_document("# r &#13; s\n").nodes[0].ref_text, "r s");
        assert_eq!(
            parse_document("# r\n- a &#13; b &#x0C; c\n").nodes[1].ref_text,
            "a b \u{c} c"
        );
        // markdag の記法を読まない文書は 1 行目の規則 (A-219) を当てず、markmap と同じく生の HTML を読む (旧実装と同じ "a b")
        assert_eq!(
            parse_document("# r\n- a <span>&#13;</span> b\n").nodes[1].ref_text,
            "a b"
        );
    }

    #[test]
    fn document_replace_leading_mark_matches_node() {
        let icons = TaskIcons {
            todo: "T".to_string(),
            done: "D".to_string(),
            doing: "G".to_string(),
            canceled: "C".to_string(),
        };
        for (html, state, with_icons, expected) in REPLACE_CASES {
            let icons = with_icons.then_some(&icons);
            assert_eq!(
                replace_leading_mark(html, *state, icons),
                *expected,
                "{html:?} {state:?}"
            );
        }
        // 置き換えの文字の `$` は展開しない (原文は閉包で置き換える)
        let dollars = TaskIcons {
            todo: "$&".to_string(),
            done: "$1".to_string(),
            doing: "$$".to_string(),
            canceled: "x".to_string(),
        };
        assert_eq!(
            replace_leading_mark(
                "<svg a=\"1\"><path/></svg><svg></svg> a",
                TaskState::Doing,
                Some(&dollars)
            ),
            "$$<svg></svg> a"
        );
    }

    #[test]
    fn document_draw_leading_mark_uses_state_icons() {
        let icons = mark_icons_of();
        assert_eq!(
            draw_leading_mark("[/] a", &icons),
            format!("{} a", icons.doing)
        );
        assert_eq!(
            draw_leading_mark("[-] ", &icons),
            format!("{} ", icons.canceled)
        );
        assert_eq!(
            draw_leading_mark("[x] a [ ] b", &icons),
            format!("{} a [ ] b", icons.done)
        );
        assert_eq!(
            draw_leading_mark("[ ] a", &icons),
            format!("{} a", icons.todo)
        );
        // 記号のあとに空白がない、知らない記号、先頭でない、大文字の X は置き換えない
        for html in ["[/]a", "[?] a", " [/] a", "[X] a", "\n<p>[/] a</p>"] {
            assert_eq!(draw_leading_mark(html, &icons), html);
        }
    }

    #[test]
    fn document_mark_icons_are_own_drawings() {
        // 自前で描いた絵 (A-151)。旧実装の taskIcons (markmap の絵) とは違う (accepted.md の A-151 の行)
        let icons = mark_icons_of();
        assert_eq!(icons.todo, UNMARKED);
        assert_eq!(icons.done, MARKED);
        assert_eq!(
            icons.doing,
            "<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z\"/><path d=\"M7 6h5v12H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z\"/></svg>"
        );
        assert_eq!(
            icons.canceled,
            "<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z\"/><path d=\"M8 11h8v2H8z\"/></svg>"
        );
        // 欄の順は原文の `{ todo, done, doing, canceled }`
        let json = serde_json::to_string(&icons).expect("JSON に書ける");
        let order: Vec<usize> = ["\"todo\"", "\"done\"", "\"doing\"", "\"canceled\""]
            .iter()
            .filter_map(|key| json.find(key))
            .collect();
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "{json}");
        assert_eq!(inside("<svg>", "x"), "<svg>");
    }

    #[test]
    fn document_task_at_reads_items_and_headings() {
        let lines = [
            "- [/] a",
            "## [-] b",
            "[x] c",
            "- a",
            "- [x] d\r",
            "  1. [ ] e",
        ];
        let task = |line: u32, state: TaskState| {
            Some(TaskInfo {
                line,
                state,
                checked: state == TaskState::Done,
            })
        };
        assert_eq!(
            task_at(&lines, Some(0), Some(BlockTag::Li)),
            task(0, TaskState::Doing)
        );
        assert_eq!(
            task_at(&lines, Some(1), Some(BlockTag::Heading(2))),
            task(1, TaskState::Canceled)
        );
        // 下線の見出しは行が記号から始まる。項目としては読まない
        assert_eq!(
            task_at(&lines, Some(2), Some(BlockTag::Heading(1))),
            task(2, TaskState::Done)
        );
        assert_eq!(task_at(&lines, Some(2), Some(BlockTag::Li)), None);
        assert_eq!(task_at(&lines, Some(3), Some(BlockTag::Li)), None);
        assert_eq!(
            task_at(&lines, Some(4), Some(BlockTag::Li)),
            task(4, TaskState::Done)
        );
        assert_eq!(
            task_at(&lines, Some(5), Some(BlockTag::Li)),
            task(5, TaskState::Todo)
        );
        // 項目と見出しでない要素、行の範囲のないノード (原文の NaN)、原文にない行はタスクでない
        for tag in [
            BlockTag::Ul,
            BlockTag::Ol,
            BlockTag::Table,
            BlockTag::Pre,
            BlockTag::Img,
        ] {
            assert_eq!(task_at(&lines, Some(0), Some(tag)), None);
        }
        assert_eq!(task_at(&lines, Some(0), None), None);
        assert_eq!(task_at(&lines, None, Some(BlockTag::Li)), None);
        assert_eq!(task_at(&lines, Some(99), Some(BlockTag::Li)), None);
    }

    #[test]
    fn document_char_refs_follow_html() {
        // 文字の中の文字参照: セミコロンのない legacy の名前 (後ろに英数字が続いてもよい)、数値の 0 とサロゲートと範囲外は U+FFFD、0x80〜0x9F は Windows-1252
        assert_eq!(
            decode_char_refs("&ampz &AMP; &lt &GT; &nbsp;"),
            "&z & < > \u{a0}"
        );
        assert_eq!(
            decode_char_refs("&apos; &apos &quot &QUOT;"),
            "' &apos \" \""
        );
        assert_eq!(
            decode_char_refs("&#65;&#x41&#X61;&#0;&#xD800;&#x110000;&#99999999999;"),
            "AAa\u{fffd}\u{fffd}\u{fffd}\u{fffd}"
        );
        assert_eq!(
            decode_char_refs("&#128;&#x9F;&#129;"),
            "\u{20ac}\u{178}\u{81}"
        );
        assert_eq!(
            decode_char_refs("& &# &#x; &unknown; a&"),
            "& &# &#x; &unknown; a&"
        );
    }

    #[test]
    fn document_read_html_tokens() {
        let start = |name: &str, self_closing: bool| HtmlToken::Start {
            name: name.to_string(),
            self_closing,
            attributes: Vec::new(),
        };
        let end = |name: &str| HtmlToken::End {
            name: name.to_string(),
        };
        let text = |value: &str| HtmlToken::Text(value.to_string());
        assert_eq!(
            read_html("<A HREF='x>y' b=c d>t</A ><br/>"),
            vec![
                HtmlToken::Start {
                    name: "a".to_string(),
                    self_closing: false,
                    attributes: vec!["href".to_string(), "b".to_string(), "d".to_string()],
                },
                text("t"),
                end("a"),
                start("br", true)
            ]
        );
        assert_eq!(read_html("<b / >x"), vec![start("b", false), text("x")]);
        assert_eq!(
            read_html("<script>a<b></script>c"),
            vec![
                start("script", false),
                text("a<b>"),
                end("script"),
                text("c")
            ]
        );
        assert_eq!(
            read_html("<style>x"),
            vec![start("style", false), text("x")]
        );
        assert_eq!(
            read_html("<!--a-->b<!--->c<?d>e<!f>"),
            vec![
                HtmlToken::Comment("a".to_string()),
                text("b"),
                HtmlToken::Comment(String::new()),
                text("c"),
                HtmlToken::Comment("?d".to_string()),
                text("e"),
                HtmlToken::Comment("f".to_string()),
            ]
        );
        assert_eq!(
            read_html("a <1 </> < b"),
            vec![
                text("a "),
                text("<"),
                text("1 "),
                text(" "),
                text("<"),
                text(" b")
            ]
        );
    }

    // parse_document の nodes を比べやすい形にする: [id, parent, depth, html, refText, refId, groups, [[key, values, [line, column, length]]],
    // milestone, foldHint, [start, end] | null, [line, state, checked] | null, details]。記号の絵は <todo> などに置き換える
    fn document_nodes_shape(parsed: &ParsedDocument) -> serde_json::Value {
        let icons = parsed.task_icons.clone().expect("記号の絵がある");
        let nodes: Vec<serde_json::Value> = parsed
            .nodes
            .iter()
            .map(|node| {
                let mut html = node.html.clone();
                for (key, icon) in [
                    ("doing", &icons.doing),
                    ("canceled", &icons.canceled),
                    ("todo", &icons.todo),
                    ("done", &icons.done),
                ] {
                    html = html.replace(icon.as_str(), &format!("<{key}>"));
                }
                let tags: Vec<serde_json::Value> = node
                    .tags
                    .iter()
                    .map(|tag| {
                        serde_json::json!([
                            tag.key,
                            tag.values,
                            [tag.at.line, tag.at.column, tag.at.length]
                        ])
                    })
                    .collect();
                serde_json::json!([
                    node.id,
                    node.parent,
                    node.depth,
                    html,
                    node.ref_text,
                    node.ref_id,
                    node.groups,
                    tags,
                    node.milestone,
                    node.fold_hint as i64,
                    node.lines.as_ref().map(|lines| [lines.start, lines.end]),
                    node.task.as_ref().map(|task| serde_json::json!([
                        task.line,
                        task.state.as_str(),
                        task.checked
                    ])),
                    node.details,
                ])
            })
            .collect();
        serde_json::Value::Array(nodes)
    }

    #[test]
    fn document_parse_matches_old_implementation() {
        for (source, expected) in PARSE_CASES {
            let parsed = parse_document(source);
            let expected: serde_json::Value =
                serde_json::from_str(expected).expect("テストの JSON");
            assert_eq!(document_nodes_shape(&parsed), expected, "{source:?}");
        }
    }

    #[test]
    fn document_parse_returns_frontmatter_icons_and_features() {
        // 記号の絵は常に返す。styleUrls は返さず features (フェンスと数式の有無) を返す (決定 12 (a))。frontmatter は読めた値のまま
        let parsed = parse_document("---\nmarkdag: {}\ntitle: T\n---\n- a $x$\n\n```js\nx\n```\n");
        assert_eq!(parsed.task_icons, Some(mark_icons_of()));
        assert_eq!(
            parsed.features,
            crate::types::ParsedFeatures {
                math: true,
                code: true
            }
        );
        assert!(parsed.extracted);
        assert_eq!(
            serde_json::to_value(&parsed.frontmatter).expect("JSON に書ける"),
            serde_json::json!({ "markdag": {}, "title": "T" })
        );
        let parsed = parse_document("# a\n\n    code\n");
        assert_eq!(
            parsed.features,
            crate::types::ParsedFeatures {
                math: false,
                code: false
            }
        );
        assert!(!parsed.extracted);
        assert_eq!(parsed.frontmatter, JsValue::Object(IndexMap::new()));
        // 読めない frontmatter は空の写像で、本文に残る (edge-yaml-error と同じ)
        let parsed = parse_document("---\na: [\n---\n# x\n");
        assert_eq!(parsed.frontmatter, JsValue::Object(IndexMap::new()));
        assert_eq!(
            parsed.nodes.first().map(|node| node.lines.clone()),
            Some(Some(crate::types::LineRange { start: 3, end: 4 }))
        );
    }

    #[test]
    fn document_parse_boundary_json_shape() {
        // 境界の JSON の欄 (styleUrls はなく features がある。T | null の欄は null で出す)
        let parsed = parse_document("- a");
        let json = serde_json::to_value(&parsed).expect("JSON に書ける");
        let keys: Vec<&str> = json
            .as_object()
            .expect("オブジェクト")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec!["nodes", "frontmatter", "extracted", "taskIcons", "features"]
        );
        assert_eq!(
            json["nodes"][0],
            serde_json::json!({ "id": 1, "parent": null, "depth": 1, "html": "a", "refText": "a", "refId": null, "groups": [], "tags": [],
                    "milestone": false, "foldHint": 0, "lines": { "start": 0, "end": 1 }, "task": null, "details": null })
        );
    }
}

// PORT STATUS: confidence=medium todos=7
