// 原文: src/model/model.ts (2026-09-24) の FrontmatterLocator
// 原文の frontmatter を位置付きで解析して、診断が指す場所を原文の行と桁で返す。
// 場所は道すじ (パス) で指定する。解析できない frontmatter では位置を返さないだけで、パニックしない。
// 位置の木は saphyr-parser のイベントから自前で組む (loader は使わない)。eemeli/yaml の Document の
// isScalar / isMap / isSeq と range を、この木の Scalar / Map / Seq と range で写す。
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use saphyr_parser::{Event, Parser, ScalarStyle, Span};

use crate::limits::{MAX_YAML_NESTING, too_deep_message};
use crate::model::util::{
    JS_WHITESPACE, JsValue, js_slice, js_strict_equals, js_to_string, js_trim_end, scalar_value,
    to_u32,
};
use crate::types::{PathStep, SourcePosition};

// frontmatter の切り出しは、実際に値を読む側 (markmap) と同じ判定にそろえる
// 規則 1 章 (A-021): 定数の正規表現は LazyLock と expect
static FRONTMATTER_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n").expect("固定の正規表現"));
static FRONTMATTER_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n---\r?\n").expect("固定の正規表現"));

// eemeli/yaml が doc.errors に積む文面 (2.5 の YAML の失敗の行。A-023)
const DUPLICATE_KEY_MESSAGE: &str = "Map keys must be unique";
const MULTIPLE_DOCS_MESSAGE: &str =
    "Source contains multiple documents; please use YAML.parseAllDocuments()";
// saphyr-parser が eemeli/yaml の通す書き方で止まるときの ScanError::info() (写しを書き換えて読み直す)
const UNKNOWN_ANCHOR_INFO: &str = "while parsing node, found unknown anchor";
const COLON_TAB_INFO: &str = "':' must be followed by a valid YAML whitespace";
const EXPECTED_WHITESPACE_INFO: &str = "expected whitespace";
// saphyr-parser の走査器はフローの入れ子の段を u8 で数え、256 段目で止まる (上限 MAX_YAML_NESTING より深いので、
// 値の読み取りと位置の木は入れ子が深すぎる誤りとして扱う。A-105)
pub(crate) const FLOW_LEVEL_OVERFLOW_INFO: &str = "recursion limit exceeded";
const INVALID_ESCAPE_INFO: &str =
    "while parsing a quoted scalar, found invalid Unicode character escape code";
const INVALID_INDENTATION_INFO: &str = "invalid indentation";
const TAB_IN_CONTEXT_INFO: &str = "tabs disallowed in this context";

/// syntaxErrors の項目 1 つ (名前のない戻り値の型。規則 4 章「関数名 + Result」)
#[derive(Debug, Clone, PartialEq)]
pub struct SyntaxErrorsResult {
    pub message: String,
    pub at: Option<SourcePosition>,
}

// 位置の木の節。range は body の上のバイト添字で、eemeli/yaml の node.range の [0] と [1] (値の始まりと終わり) に当たる。
// 規則 1 章 (A-025): Alias は Scalar / Map / Seq のどれでもない節として残す。A-025 の「位置は別名の書かれた場所」は持たない
// (原文の rangeStartOf は別名を見ないので、位置を持っても使う所がない。規則の文面を直す案は A-086)
#[derive(Debug, Clone)]
enum YamlNode {
    Scalar { range: [usize; 2], value: JsValue },
    Map { start: usize, items: Vec<YamlPair> },
    Seq { start: usize, items: Vec<YamlNode> },
    Alias,
}

// eemeli/yaml の Pair。value は `? a` のように値のない組で None (原文の null)
#[derive(Debug, Clone)]
struct YamlPair {
    key: YamlNode,
    value: Option<YamlNode>,
}

// doc.errors の 1 件。pos は body の上のバイト添字 (error.pos[0])
#[derive(Debug, Clone)]
struct YamlError {
    message: String,
    pos: usize,
}

// eemeli/yaml の Document.Parsed のうち、位置に使う部分
#[derive(Debug, Clone)]
struct YamlDocument {
    contents: Option<YamlNode>,
    errors: Vec<YamlError>,
}

/// 原文: FrontmatterLocator
#[derive(Debug, Clone)]
pub struct FrontmatterLocator {
    // frontmatter の本体 (--- の内側)。位置の添字は、すべてこの文字列の上のバイトで数える (規則 2.2)
    body: String,
    // 本体の行番号を、原文の行番号に直すための差
    line_offset: usize,
    doc: Option<YamlDocument>,
}

impl FrontmatterLocator {
    /// 原文: FrontmatterLocator の constructor
    pub fn new(source: Option<&str>) -> FrontmatterLocator {
        let text = source.unwrap_or("");
        let open = FRONTMATTER_OPEN.find(text);
        // 閉じは text の先頭から探す (空の frontmatter `---\n---\n` では close (3) < start (4))
        let close = open.and_then(|_| FRONTMATTER_CLOSE.find(text));
        let (Some(open), Some(close)) = (open, close) else {
            return FrontmatterLocator {
                body: String::new(),
                line_offset: 0,
                doc: None,
            };
        };
        let start = open.end();
        // CRLF の文書では、閉じの --- の手前に \r が 1 つ残る。YAML の誤りと見なされるので落とす (前の位置はずれない)
        // 規則 2.2 (A-006、A-032): slice の a > b は空。`.replace(/\r$/, '')` は末尾の 1 つだけ
        let sliced = js_slice(text, start, start.max(close.start()));
        let body = sliced.strip_suffix('\r').unwrap_or(sliced).to_string();
        let line_offset = js_slice(text, 0, start).matches('\n').count();
        // 原文の try / catch は parseDocument が throw しないので届かない (規則 2.5 の「catch が事実上届かない箇所」)
        let doc = Some(parse_document(&body));
        FrontmatterLocator {
            body,
            line_offset,
            doc,
        }
    }

    /// 原文: syntaxErrors
    /// YAML として読めなかった誤り。markmap は読めない frontmatter を丸ごと捨てるので、ここでしか気づけない
    pub fn syntax_errors(&self) -> Vec<SyntaxErrorsResult> {
        let errors = self
            .doc
            .as_ref()
            .map(|doc| doc.errors.as_slice())
            .unwrap_or_default();
        errors
            .iter()
            .map(|error| SyntaxErrorsResult {
                // 規則 2.5 (A-023 (3)): 文面は ScanError::info() で、位置の文を含まないので原文の正規表現で落とさない。
                // 件数は A-024 の 1 件。台帳の syntaxErrors の行 (文面は Display、件数は eemeli に合わせる) はこの 2 つで上書きされている (A-084)
                message: error.message.clone(),
                at: self.span_of_line(error.pos),
            })
            .collect()
    }

    /// 原文: value
    /// 値の位置。inner を渡すと、その語が値の原文にちょうど 1 回あるときに限って、その語だけを指す。
    /// 値が空 (「color: #D64545」のように # から先がコメントになった場合) は、キーから行末までを指す
    pub fn value(&self, path: &[PathStep], inner: Option<&str>) -> Option<SourcePosition> {
        let node = self.node_at(path);
        if let Some(YamlNode::Scalar {
            range: [start, end],
            ..
        }) = node
        {
            let (start, end) = (*start, *end);
            let raw = js_slice(&self.body, start, end);
            // 規則 2.1: 真偽の位置の Option<&str> は Some("") を偽にする
            let inner = inner.filter(|inner| !inner.is_empty());
            if let Some(inner) = inner
                && let Some(found) = raw.find(inner)
            {
                // 同じ語が式に 2 回出るとき (A --> A など) は、どちらか分からないので式の全体を指す
                // 規則 2.2: `indexOf(inner, found + 1)` は found の次の文字の境界から探す
                let next = raw
                    .char_indices()
                    .map(|(index, _)| index)
                    .find(|index| *index > found)
                    .unwrap_or(raw.len());
                if !js_slice(raw, next, raw.len()).contains(inner) {
                    return Some(self.at(start + found, inner.chars().count()));
                }
            }
            // 折り返しのスカラ (|- や >-) は、記号の行ではなく中身の 1 行目を指す
            if raw.starts_with(['|', '>'])
                && let Some(wrapped) = index_of_newline(&self.body, start)
                && wrapped < end
            {
                return self.span_of_line(wrapped + 1);
            }
            if let Some(span) = self.span_from(start, Some(end)) {
                return Some(span);
            }
        }
        self.fallback(path, node)
    }

    /// 原文: key
    /// キーの位置。path の最後がキーの名前で、その前は親のキー
    pub fn key(&self, path: &[PathStep]) -> Option<SourcePosition> {
        match self.pair_at(path).map(|pair| &pair.key) {
            Some(YamlNode::Scalar {
                range: [start, end],
                ..
            }) => self.span_from(*start, Some(*end)),
            _ => None,
        }
    }

    // 値を指せないときの逃げ道。印が 0 幅にならないよう、指せる場所を順に試す。
    // キーから行末、値の始まりから行末 (ならびの中の写像やならびもここで指せる)、その行の字のある範囲、最後に親のキー
    fn fallback(&self, path: &[PathStep], node: Option<&YamlNode>) -> Option<SourcePosition> {
        let key = self.pair_at(path).map(|pair| &pair.key);
        let key_start = match key {
            Some(YamlNode::Scalar {
                range: [start, _], ..
            }) => Some(*start),
            _ => None,
        };
        let starts = [key_start, node.and_then(range_start_of)];
        for start in starts.into_iter().flatten() {
            let span = self
                .span_from(start, None)
                .or_else(|| self.span_of_line(start));
            if span.is_some() {
                return span;
            }
        }
        match path.split_last() {
            Some((_, parent)) if !parent.is_empty() => self.key(parent),
            _ => None,
        }
    }

    // 本体の中の添字を、原文での位置に直す。桁はコードポイントで数える (規則 2.2)。
    // 行は body[..offset] の改行の数 (LineCounter.linePos の写し。YAML の Marker の行は使わない。A-006)
    fn at(&self, offset: usize, length: usize) -> SourcePosition {
        let before = js_slice(&self.body, 0, offset);
        let line = before.matches('\n').count() + 1;
        let start = before.rfind('\n').map_or(0, |index| index + 1);
        SourcePosition {
            line: to_u32(line + self.line_offset),
            column: to_u32(js_slice(&self.body, start, offset).chars().count() + 1),
            length: to_u32(length),
        }
    }

    // その行の、字のある範囲を指す。値が空で指す場所がないとき (ならびの「-」だけの行など) の最後の逃げ道
    fn span_of_line(&self, offset: usize) -> Option<SourcePosition> {
        let body = self.body.as_str();
        // 規則 2.2 (A-006): lastIndexOf('\n', max(0, offset - 1)) は offset 0 で body[..=0] と書かない
        let previous = if offset >= 1 {
            js_slice(body, 0, offset).rfind('\n')
        } else if body.starts_with('\n') {
            Some(0)
        } else {
            None
        };
        let line_start = previous.map_or(0, |index| index + 1);
        let wrapped = index_of_newline(body, line_start);
        let line = js_trim_end(js_slice(body, line_start, wrapped.unwrap_or(body.len())));
        // 先頭の JS_WHITESPACE のバイト数 (規則 2.2)。usize の引き算をしない (規則 2.1)
        let indent = line
            .find(|c: char| !JS_WHITESPACE.contains(&c))
            .unwrap_or(line.len());
        if line.len() <= indent {
            None
        } else {
            Some(self.at(
                line_start + indent,
                js_slice(line, indent, line.len()).chars().count(),
            ))
        }
    }

    // offset から、その行の終わり (または limit) までを指す。SourcePosition は 1 行しか表せないので、印は 1 行に収める
    fn span_from(&self, offset: usize, limit: Option<usize>) -> Option<SourcePosition> {
        let body = self.body.as_str();
        let line_end = index_of_newline(body, offset).unwrap_or(body.len());
        let text = js_trim_end(js_slice(
            body,
            offset,
            limit.unwrap_or(line_end).min(line_end),
        ));
        if text.is_empty() {
            None
        } else {
            Some(self.at(offset, text.chars().count()))
        }
    }

    fn node_at(&self, path: &[PathStep]) -> Option<&YamlNode> {
        let mut node = self.doc.as_ref().and_then(|doc| doc.contents.as_ref());
        for step in path {
            node = match node {
                Some(map @ YamlNode::Map { .. }) => self
                    .pair_of(Some(map), step)
                    .and_then(|pair| pair.value.as_ref()),
                Some(YamlNode::Seq { items, .. }) => match step {
                    PathStep::Index(index) => items.get(*index),
                    PathStep::Key(_) => None,
                },
                _ => None,
            };
            node?;
        }
        node
    }

    fn pair_at(&self, path: &[PathStep]) -> Option<&YamlPair> {
        let (last, parent) = path.split_last()?;
        self.pair_of(self.node_at(parent), last)
    }

    // YAML はキーを数や真偽値に直す (groups の 2024 など) ので、名前は文字にして突き合わせる。
    // この事情で doc.getIn は使えず、items を自分でたどる
    // 規則 2.3 (YAML のキーの文字列化): js_to_string(スカラ) == js_to_string(name)。null のキーは "null"
    // 規則 2.6 の class の行: 原文の private メソッド (model.ts:257) なので impl の中に置く
    fn pair_of<'a>(&self, node: Option<&'a YamlNode>, name: &PathStep) -> Option<&'a YamlPair> {
        let Some(YamlNode::Map { items, .. }) = node else {
            return None;
        };
        let name = js_to_string(&JsValue::from(name));
        items.iter().find(|item| match &item.key {
            YamlNode::Scalar { value, .. } => js_to_string(value) == name,
            _ => false,
        })
    }
}

// スカラだけでなく、ならびの中の写像やならびも位置を持つ
fn range_start_of(node: &YamlNode) -> Option<usize> {
    match node {
        YamlNode::Scalar {
            range: [start, _], ..
        } => Some(*start),
        YamlNode::Map { start, .. } | YamlNode::Seq { start, .. } => Some(*start),
        YamlNode::Alias => None,
    }
}

// `body.indexOf('\n', from)` (見つからなければ None)
fn index_of_newline(body: &str, from: usize) -> Option<usize> {
    js_slice(body, from, body.len())
        .find('\n')
        .map(|index| from + index)
}

// 組み立て中の入れ物。Map の key は値を待っているキー。Seq の flow はフロー形式 (`[ ]`) か
enum Frame {
    Map {
        start: usize,
        items: Vec<YamlPair>,
        key: Option<YamlNode>,
    },
    Seq {
        start: usize,
        items: Vec<YamlNode>,
        flow: bool,
    },
}

impl Frame {
    fn close(self) -> YamlNode {
        match self {
            Frame::Map {
                start,
                mut items,
                key,
            } => {
                if let Some(key) = key {
                    items.push(YamlPair { key, value: None });
                }
                YamlNode::Map { start, items }
            }
            Frame::Seq { start, items, .. } => YamlNode::Seq { start, items },
        }
    }
}

// saphyr-parser のイベントから位置の木を組む (A-025)。Marker の添字は文字 (コードポイント) の数なので、
// 最初にバイトへ直す (規則 2.2「YAML crate の Marker は最初にバイトへ直す」)。
// saphyr には body ではなく SaphyrInput の写しを渡す。写しの上の位置に base (BOM の長さ) を足すと body の上の位置になる
struct TreeBuilder<'a> {
    body: &'a str,
    // saphyr に渡す写し
    input: &'a SaphyrInput,
    // 未定義の別名の `*` を plain の字に書き換えた位置 (body の上)。ここから始まるスカラは別名の節にする
    aliases: &'a [usize],
    stack: Vec<Frame>,
    root: Option<YamlNode>,
    errors: Vec<YamlError>,
    // 直前のイベントの終わり (バイト)。折り返しのスカラの記号と、空の値の位置を探す起点
    previous_end: usize,
    // saphyr が止まった所で、写しをどう書き換えれば読み進められるか
    rewrite: Option<Rewrite>,
    // stack と対の、開いている入れ物の (錨、読み終えた中身の入れ子の段数の最大)。別名の展開の深さを数える (A-105)
    heights: Vec<(usize, usize)>,
    // 錨ごとの、その節の入れ物の入れ子の段数 (スカラは 0)。反復しないので HashMap (A-008)
    anchor_heights: HashMap<usize, usize>,
}

// 写しの書き換え 1 つ
enum Rewrite {
    // 未定義の別名の `*` (写しの上のバイト)。位置の木だけの書き換え (値の側はどちらの実装でも読めない)
    Alias(usize),
    // 値の読み取りと共有の書き換え (SaphyrInput::rewrite) を試す。saphyr の誤りの説明と文字の添字
    Shared { info: String, index: usize },
}

impl<'a> TreeBuilder<'a> {
    fn new(body: &'a str, input: &'a SaphyrInput, aliases: &'a [usize]) -> TreeBuilder<'a> {
        TreeBuilder {
            body,
            input,
            aliases,
            stack: Vec::new(),
            root: None,
            errors: Vec::new(),
            previous_end: 0,
            rewrite: None,
            heights: Vec::new(),
            anchor_heights: HashMap::new(),
        }
    }

    // 読み終えた節の入れ子の段数を、開いている入れ物の中身の最大に入れる
    fn raise_height(&mut self, height: usize) {
        if let Some((_, open)) = self.heights.last_mut() {
            *open = (*open).max(height);
        }
    }

    // 写しの文字の添字を、body の上のバイトに直す。写しの末尾に足した改行は body の終わりに寄せる
    fn byte(&self, char_index: usize) -> usize {
        (self.input.base + self.input.byte(char_index)).min(self.body.len())
    }

    fn build(mut self) -> (YamlDocument, Option<Rewrite>) {
        let mut parser = Parser::new_from_str(&self.input.text);
        let mut documents = 0usize;
        while let Some(next) = parser.next_event() {
            let (event, span) = match next {
                Ok(pair) => pair,
                Err(error) => {
                    let index = error.marker().index();
                    let position = self.input.byte(index);
                    self.rewrite = if error.info() == UNKNOWN_ANCHOR_INFO
                        && self
                            .input
                            .text
                            .get(position..)
                            .is_some_and(|rest| rest.starts_with('*'))
                    {
                        Some(Rewrite::Alias(position))
                    } else {
                        Some(Rewrite::Shared {
                            info: error.info().to_string(),
                            index,
                        })
                    };
                    // 規則 2.5 (A-024): 構文の誤りは saphyr が報告する最初の 1 件で受け入れる。
                    // フローの入れ子の数え過ぎは、上限 (MAX_YAML_NESTING) を越えた入れ子と同じ文面にする
                    let message = if error.info() == FLOW_LEVEL_OVERFLOW_INFO {
                        too_deep_message(MAX_YAML_NESTING)
                    } else {
                        error.info().to_string()
                    };
                    self.errors.push(YamlError {
                        message,
                        pos: self.byte(index),
                    });
                    break;
                }
            };
            let (start, end) = (self.byte(span.start.index()), self.byte(span.end.index()));
            match event {
                Event::StreamEnd => break,
                Event::DocumentStart(_) => {
                    documents += 1;
                    if documents > 1 {
                        // 規則 2.5 (A-023): 2 つ目の文書の開始を指し、eemeli/yaml と同じくそこで読むのをやめる
                        self.errors.push(YamlError {
                            message: MULTIPLE_DOCS_MESSAGE.to_string(),
                            pos: start,
                        });
                        break;
                    }
                }
                Event::Scalar(..) if self.aliases.contains(&start) => {
                    self.push_node(YamlNode::Alias)
                }
                Event::Scalar(value, style, anchor, tag) => {
                    if anchor != 0 {
                        self.anchor_heights.insert(anchor, 0);
                    }
                    let value = self
                        .input
                        .scalar_text(&value, self.input.byte(span.start.index()));
                    let range = self.scalar_range(style, span, start, end, &value);
                    let node = YamlNode::Scalar {
                        range,
                        value: scalar_value(&value, style, tag.as_deref()),
                    };
                    self.push_node(node);
                }
                Event::Alias(anchor) => {
                    // 別名は指す節を展開した値になるので、その入れ子の段数も数える。値の読み取り (yaml_parse の TooDeep) と同じ所で止める (A-105)
                    // TODO(port): Rust 側の不到達 (未定義の別名は saphyr-parser が先に Err にする。循環する別名は値の側が誤りにする)
                    let height = self.anchor_heights.get(&anchor).copied().unwrap_or(0);
                    if self.stack.len() + height > MAX_YAML_NESTING {
                        self.errors.push(YamlError {
                            message: too_deep_message(MAX_YAML_NESTING),
                            pos: start,
                        });
                        break;
                    }
                    self.raise_height(height);
                    self.push_node(YamlNode::Alias);
                }
                Event::SequenceStart(..) | Event::MappingStart(..)
                    if self.stack.len() >= MAX_YAML_NESTING =>
                {
                    // 値の読み取り (yaml_parse の TooDeep) と同じ所で止める (A-105)
                    self.errors.push(YamlError {
                        message: too_deep_message(MAX_YAML_NESTING),
                        pos: start,
                    });
                    break;
                }
                Event::SequenceStart(anchor, _) => {
                    self.heights.push((anchor, 0));
                    let flow = js_slice(self.body, start, self.body.len()).starts_with('[');
                    self.stack.push(Frame::Seq {
                        start,
                        items: Vec::new(),
                        flow,
                    });
                }
                Event::MappingStart(anchor, _) => {
                    self.heights.push((anchor, 0));
                    let in_flow_seq =
                        matches!(self.stack.last(), Some(Frame::Seq { flow: true, .. }));
                    let start = self.map_start(start, in_flow_seq);
                    self.stack.push(Frame::Map {
                        start,
                        items: Vec::new(),
                        key: None,
                    });
                }
                Event::SequenceEnd | Event::MappingEnd => {
                    // TODO(port): Rust 側の不到達 (saphyr は End の前に必ず対の Start を出す)
                    if let Some(frame) = self.stack.pop() {
                        let (anchor, inner) = self.heights.pop().unwrap_or((0, 0));
                        if anchor != 0 {
                            self.anchor_heights.insert(anchor, inner + 1);
                        }
                        self.raise_height(inner + 1);
                        self.push_node(frame.close());
                    }
                }
                Event::Nothing | Event::StreamStart | Event::DocumentEnd => {}
            }
            self.previous_end = end;
        }
        // 規則 2.5 (A-023): 誤りがあっても組めたところまでの木を残す
        while let Some(frame) = self.stack.pop() {
            self.push_node(frame.close());
        }
        (
            YamlDocument {
                contents: self.root,
                errors: self.errors,
            },
            self.rewrite,
        )
    }

    fn push_node(&mut self, node: YamlNode) {
        match self.stack.last_mut() {
            // 2 つ目の文書の開始で読むのをやめるので、根が来るのは 1 度だけ
            None => self.root = Some(node),
            Some(Frame::Seq { items, .. }) => items.push(node),
            Some(Frame::Map { items, key, .. }) => match key.take() {
                Some(pending) => items.push(YamlPair {
                    key: pending,
                    value: Some(node),
                }),
                None => {
                    // 規則 2.5 (A-023): 重複キーはキーを読んだ時点で、2 つ目のキーの開始を指す。
                    // 等しさは eemeli/yaml の mapIncludes (`a.value === b.value`) に合わせ、`1` と `"1"` は重複にしない
                    // 規則 2.5 の YAML の読み込みの失敗 (1) (A-083): 等しさは js_strict_equals (解決後のスカラの値の ===)
                    if let YamlNode::Scalar {
                        range: [key_start, _],
                        value,
                    } = &node
                    {
                        let duplicate = items.iter().any(|item| match &item.key {
                            YamlNode::Scalar { value: other, .. } => js_strict_equals(other, value),
                            _ => false,
                        });
                        if duplicate {
                            self.errors.push(YamlError {
                                message: DUPLICATE_KEY_MESSAGE.to_string(),
                                pos: *key_start,
                            });
                        }
                    }
                    *key = Some(node);
                }
            },
        }
    }

    // eemeli/yaml の range[0..2] に寄せる。saphyr の Span は次の点で違うので直す:
    // 引用つきは後ろのコメントまで含む、折り返し (| >) は記号でなく中身から始まる、空の値は位置がまちまち
    // (ブロック形式では次のトークン、フロー形式では `,` や `}` を覆う)。
    // Span の開始は錨とタグの後ろにある (A-032 (2) の確認。locator_alias_and_tags と locator_seq_items_with_only_properties)
    // Span の直しは規則 2.2 の「saphyr-parser に渡す写しと Span の直し」の (3) (A-081 (1))
    fn scalar_range(
        &self,
        style: ScalarStyle,
        span: Span,
        start: usize,
        end: usize,
        value: &str,
    ) -> [usize; 2] {
        match style {
            ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted => {
                // TODO(port): Rust 側の不到達 (saphyr は閉じた引用しか Scalar にしない)
                [start, quoted_end(self.body, start, style).unwrap_or(end)]
            }
            ScalarStyle::Literal | ScalarStyle::Folded => [self.block_header(start, end), end],
            ScalarStyle::Plain if self.is_implicit_null(value, start) => {
                if span.is_empty() && self.stack_waits_for_value() {
                    let position = self.empty_value_position(start);
                    [position, position]
                } else {
                    // フロー形式の暗黙の null (`{a}` の値、`[&a , b]` の項目) は幅 0 にする。eemeli/yaml の range も空で、
                    // value() は fallback に落ちてキー (無ければこの位置) から行末を指す
                    [start, start]
                }
            }
            ScalarStyle::Plain => [start, end],
        }
    }

    // 書かれていない null (saphyr は値を "" か "~" にする)。`~` と書いた null は除く
    fn is_implicit_null(&self, value: &str, start: usize) -> bool {
        value.is_empty()
            || (value == "~" && !js_slice(self.body, start, self.body.len()).starts_with('~'))
    }

    // 空のスカラがキーでなく値 (写像の値か、ならびの項目) か
    fn stack_waits_for_value(&self) -> bool {
        !matches!(self.stack.last(), Some(Frame::Map { key: None, .. }))
    }

    // 空の値の位置。eemeli/yaml は指示子 (`:` `-` `?`)、錨、タグと空白の後ろに置く (`- # c` と `- &b # c` はコメントの始まり)。
    // 錨かタグがあれば、その後ろの空白の後ろ (改行は越えない)。saphyr の位置は次の行のトークンにあるので、その行を起点にしない。
    // なければ saphyr の位置の行 (または直前のイベントの終わり) から、改行を越えずに指示子と空白を飛ばす
    fn empty_value_position(&self, saphyr_position: usize) -> usize {
        let body = self.body;
        let from = self.previous_end.min(saphyr_position);
        if let Some(property_end) = self.last_property_end(from, saphyr_position) {
            let rest = js_slice(body, property_end, body.len());
            return property_end
                + rest
                    .find(|c: char| !matches!(c, ' ' | '\t'))
                    .unwrap_or(rest.len());
        }
        let line_start = js_slice(body, 0, saphyr_position)
            .rfind('\n')
            .map_or(0, |index| index + 1);
        let mut position = line_start.max(from);
        let mut chars = js_slice(body, position, body.len()).chars().peekable();
        while let Some(c) = chars.next() {
            let skip = match c {
                ' ' | '\t' => true,
                ':' | '-' | '?' => chars
                    .peek()
                    .is_none_or(|next| matches!(next, ' ' | '\t' | '\r' | '\n')),
                _ => false,
            };
            if !skip {
                break;
            }
            position += c.len_utf8();
        }
        position
    }

    // from から to までにある最後の錨 (`&a`) かタグ (`!!str`) の終わり。コメントの中は見ない
    fn last_property_end(&self, from: usize, to: usize) -> Option<usize> {
        let region = js_slice(self.body, from, to);
        let mut found = None;
        let mut before: Option<char> = None;
        let mut in_comment = false;
        let mut in_property = false;
        for (index, c) in region.char_indices() {
            if in_comment {
                in_comment = c != '\n';
            } else if in_property {
                if is_yaml_blank(c) {
                    in_property = false;
                    found = Some(from + index);
                }
            } else if before.is_none_or(is_yaml_blank) {
                in_comment = c == '#';
                in_property = matches!(c, '&' | '!');
            }
            before = Some(c);
        }
        if in_property {
            Some(from + region.len())
        } else {
            found
        }
    }

    // 写像の開始を、錨とタグ (フロー形式の並びの中の 1 組の写像では `?` も) の後ろに寄せる。eemeli/yaml の range[0] は
    // 最初のキーの開始にある (`- &a x: 1` は x、`[? a]` は a)。saphyr の Span はブロック形式でも錨やタグから始まる。改行は越えない
    fn map_start(&self, start: usize, in_flow_seq: bool) -> usize {
        let mut position = start;
        let mut in_property = false;
        let mut chars = js_slice(self.body, start, self.body.len())
            .chars()
            .peekable();
        while let Some(c) = chars.next() {
            let skip = match c {
                '\r' | '\n' => false,
                ' ' | '\t' => {
                    in_property = false;
                    true
                }
                _ if in_property => true,
                '&' | '!' => {
                    in_property = true;
                    true
                }
                '?' => in_flow_seq && chars.peek().is_none_or(|next| is_yaml_blank(*next)),
                _ => false,
            };
            if !skip {
                break;
            }
            position += c.len_utf8();
        }
        position
    }

    // 折り返しのスカラの記号 (| か >) の位置。直前のイベントの終わりから探し、空白か範囲の先頭の直後にあって、
    // 後ろが字数の指示 ([0-9+-]) と空白か行末で終わる最初のものを採る。コメント (空白か範囲の先頭の直後の # から行末) の中は見ない。
    // 見つからなければ saphyr の開始
    fn block_header(&self, start: usize, end: usize) -> usize {
        let from = self.previous_end.min(start);
        let region = js_slice(self.body, from, end.max(start));
        let mut before: Option<char> = None;
        let mut in_comment = false;
        for (index, c) in region.char_indices() {
            if in_comment {
                in_comment = c != '\n';
            } else if before.is_none_or(is_yaml_blank) {
                in_comment = c == '#';
                if matches!(c, '|' | '>') {
                    let rest = js_slice(region, index + c.len_utf8(), region.len())
                        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '+' || c == '-');
                    if rest.is_empty() || rest.starts_with(is_yaml_blank) {
                        return from + index;
                    }
                }
            }
            before = Some(c);
        }
        start
    }
}

// YAML の区切りの字 (空白、タブ、改行)
fn is_yaml_blank(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n')
}

// 引用つきのスカラの終わり (閉じの引用符の次)。二重引用は `\` の次の字を飛ばし、一重引用は `''` を 1 字とみなす
fn quoted_end(body: &str, start: usize, style: ScalarStyle) -> Option<usize> {
    let rest = js_slice(body, start, body.len());
    let mut chars = rest.char_indices().peekable();
    let (_, quote) = chars.next()?;
    while let Some((index, c)) = chars.next() {
        if style == ScalarStyle::DoubleQuoted && c == '\\' {
            chars.next();
        } else if c == quote {
            if style == ScalarStyle::SingleQuoted
                && chars.peek().is_some_and(|(_, next)| *next == '\'')
            {
                chars.next();
            } else {
                return Some(start + index + c.len_utf8());
            }
        }
    }
    None
}

// saphyr-parser に渡す frontmatter の本体の写し。frontmatter の値の読み取り (解析の層) と位置の木 (この単位) が同じものを使い、
// eemeli/yaml が通すのに saphyr が止まる (または黙って読み終える) 書き方を、バイトの長さを変えずに書き換える (位置はずれない):
// - 文書の先頭の BOM は写しに入れない (eemeli/yaml は落とす)。位置は base で足す
// - 末尾に改行を 1 つ足す (文書の末尾の `?` を saphyr は `expected whitespace` にする。足した改行の位置は body の終わりに寄せる)
// - NUL は、写しにも escape にも無い 1 バイトの制御文字に置き換え、スカラの字で NUL に戻す (saphyr は NUL を入力の終わりとして
//   扱い、以降を誤りなしに読み捨てる。eemeli/yaml は字として読む)
// - saphyr が止まった所で (rewrite)、`:` と `?` の直後のタブを空白にする。二重引用のスカラの中のサロゲートの escape
//   (`\uD83D`) を私用領域の escape に替え、スカラの字で UTF-16 の単位に戻す (対は 1 字、孤立は U+FFFD)。
//   フローの入れ物の閉じの字 (`[\n]` の `]`) の手前の改行とコメントを空白にする (eemeli/yaml が通す字下げのときだけ)
// 書き換えは規則 2.2 の「saphyr-parser に渡す写しと Span の直し」の (1)(2)、寄せない差は (5) (A-081、A-131)
pub(crate) struct SaphyrInput {
    // saphyr に渡す写し
    pub(crate) text: String,
    // body の先頭の BOM のバイト数。写しの添字に足すと body の添字になる
    pub(crate) base: usize,
    // 写しの文字の添字 i の文字が始まるバイト (写しの上)。末尾に写しの長さを置く
    char_starts: Vec<usize>,
    // NUL の代わりに置いた字
    nul: Option<char>,
    // サロゲートの escape を書き換えた二重引用のスカラの開始 (写しの上のバイト) と、私用領域へずらした差
    surrogate_scalars: Vec<(usize, u16)>,
}

// NUL の代わりに使う字の候補。1 バイトで、saphyr が字として読み、名前のある escape (`\a` `\b` `\e` `\v` `\f`) を持たないもの
const NUL_STAND_INS: &[char] = &[
    '\u{1}', '\u{2}', '\u{3}', '\u{4}', '\u{5}', '\u{6}', '\u{e}', '\u{f}', '\u{10}', '\u{11}',
    '\u{12}', '\u{13}', '\u{14}', '\u{15}', '\u{16}', '\u{17}', '\u{18}', '\u{19}', '\u{1a}',
    '\u{1c}', '\u{1d}', '\u{1e}', '\u{1f}', '\u{7f}',
];

// サロゲート (U+D800〜U+DFFF) を私用領域 (U+E000〜U+E7FF、U+E800〜U+EFFF、U+F000〜U+F7FF) へずらす差の候補。
// escape の 16 進の桁数を変えずに書き換えられる。同じスカラの字や escape が使っていない領域を選ぶ
const SURROGATE_SHIFTS: [u16; 3] = [0x800, 0x1000, 0x1800];

fn char_starts_of(text: &str) -> Vec<usize> {
    let mut starts: Vec<usize> = text.char_indices().map(|(index, _)| index).collect();
    starts.push(text.len());
    starts
}

impl SaphyrInput {
    pub(crate) fn new(body: &str) -> SaphyrInput {
        let base = if body.starts_with('\u{feff}') {
            '\u{feff}'.len_utf8()
        } else {
            0
        };
        let mut text = format!("{}\n", js_slice(body, base, body.len()));
        let mut nul = None;
        if text.contains('\0') {
            let lower = text.to_lowercase();
            // escape で同じ字を作れる候補も避ける (`\x01` `\u0001` `\U00000001`)
            nul = NUL_STAND_INS.iter().copied().find(|&c| {
                let code = u32::from(c);
                !text.contains(c)
                    && ![
                        format!("\\x{code:02x}"),
                        format!("\\u{code:04x}"),
                        format!("\\u{code:08x}"),
                    ]
                    .iter()
                    .any(|escape| lower.contains(escape.as_str()))
            });
            // TODO(port): 候補がすべて使われている文書 (24 種の制御文字と NUL を含む) は NUL を残し、両方の読み取りが NUL で黙って終わる (A-131)
            if let Some(stand_in) = nul {
                text = text.replace('\0', stand_in.encode_utf8(&mut [0; 4]));
            }
        }
        let char_starts = char_starts_of(&text);
        SaphyrInput {
            text,
            base,
            char_starts,
            nul,
            surrogate_scalars: Vec::new(),
        }
    }

    // saphyr の文字の添字を、写しの上のバイトに直す
    pub(crate) fn byte(&self, char_index: usize) -> usize {
        // TODO(port): Rust 側の不到達 (saphyr の Marker は写しの文字数を越えない)
        self.char_starts
            .get(char_index)
            .copied()
            .unwrap_or(self.text.len())
    }

    // saphyr の文字の添字の総数 (入力の終わり)
    pub(crate) fn char_len(&self) -> usize {
        self.char_starts.len().saturating_sub(1)
    }

    // スカラの字を eemeli/yaml の値の字に戻す (NUL の代わりの字と、サロゲートの escape の書き換え)。start は Span の開始 (写しの上のバイト)
    pub(crate) fn scalar_text<'t>(&self, text: &'t str, start: usize) -> Cow<'t, str> {
        let mut value = Cow::Borrowed(text);
        if let Some(stand_in) = self.nul
            && value.contains(stand_in)
        {
            value = Cow::Owned(value.replace(stand_in, "\0"));
        }
        if let Some(&(_, shift)) = self.surrogate_scalars.iter().find(|(at, _)| *at == start) {
            let stand_ins = 0xD800 + u32::from(shift)..0xE000 + u32::from(shift);
            let units: Vec<u16> = value
                .chars()
                .flat_map(|c| {
                    let mut buffer = [0u16; 2];
                    let encoded = c.encode_utf16(&mut buffer);
                    if stand_ins.contains(&u32::from(c)) {
                        encoded.iter_mut().for_each(|unit| *unit -= shift);
                    }
                    encoded.to_vec()
                })
                .collect();
            // 対は 1 字に、孤立したサロゲートは U+FFFD にする (Rust の String は孤立したサロゲートを持てない。A-131)
            value = Cow::Owned(String::from_utf16_lossy(&units));
        }
        value
    }

    // saphyr が止まった所 (info と文字の添字) で、写しを書き換えれば eemeli/yaml と同じく読み進められるなら書き換えて true。
    // 書き換えるたびにタブ、サロゲートの escape、改行のどれかが 1 つ以上減るので、読み直しはその数で終わる
    pub(crate) fn rewrite(&mut self, info: &str, index: usize) -> bool {
        let position = self.byte(index);
        let changed = match info {
            COLON_TAB_INFO | EXPECTED_WHITESPACE_INFO | TAB_IN_CONTEXT_INFO => {
                self.rewrite_tab(position)
            }
            INVALID_ESCAPE_INFO => self.rewrite_surrogates(position),
            INVALID_INDENTATION_INFO => self.rewrite_flow_end(position, index),
            _ => false,
        };
        if changed {
            self.char_starts = char_starts_of(&self.text);
        }
        changed
    }

    // `:` か `?` の後ろの区切りの空白とタブのうち、最初のタブ。saphyr の位置は `:` では区切りの後ろ、`?` ではタブそのものにある
    fn rewrite_tab(&mut self, position: usize) -> bool {
        let before = js_slice(&self.text, 0, position).trim_end_matches([' ', '\t']);
        if !before.ends_with([':', '?']) {
            return false;
        }
        let run = js_slice(&self.text, before.len(), self.text.len());
        let blanks = run
            .find(|c: char| !matches!(c, ' ' | '\t'))
            .unwrap_or(run.len());
        let Some(tab) = js_slice(run, 0, blanks).find('\t') else {
            return false;
        };
        let at = before.len() + tab;
        self.text.replace_range(at..at + 1, " ");
        true
    }

    // 二重引用のスカラ (quote は開きの `"`) の中の `\uD800`〜`\uDFFF` と `\U0000D800`〜`\U0000DFFF` を、同じ桁数の私用領域の escape にする。
    // eemeli/yaml は `\u` の値を UTF-16 の単位として足すので、対の escape は 1 字、孤立したものは孤立したサロゲートになる
    fn rewrite_surrogates(&mut self, quote: usize) -> bool {
        let Some(body) = self
            .text
            .get(quote..)
            .and_then(|rest| rest.strip_prefix('"'))
        else {
            return false;
        };
        // サロゲートの escape (16 進の桁の位置、値、桁数) と、スカラが字か escape で使っている字
        let mut surrogates: Vec<(usize, u32, usize)> = Vec::new();
        let mut present: Vec<u32> = Vec::new();
        let mut chars = body.char_indices();
        while let Some((offset, c)) = chars.next() {
            match c {
                '"' => break,
                '\\' => {
                    let Some((_, kind)) = chars.next() else { break };
                    let width = match kind {
                        'x' => 2,
                        'u' => 4,
                        'U' => 8,
                        _ => continue,
                    };
                    let digits_at = offset + 2;
                    let digits = js_slice(body, digits_at, digits_at + width);
                    let is_hex =
                        digits.len() == width && digits.chars().all(|c| c.is_ascii_hexdigit());
                    match u32::from_str_radix(digits, 16).ok().filter(|_| is_hex) {
                        Some(code) if (0xD800..=0xDFFF).contains(&code) => {
                            surrogates.push((quote + 1 + digits_at, code, width))
                        }
                        Some(code) => present.push(code),
                        None => {}
                    }
                }
                _ => present.push(u32::from(c)),
            }
        }
        let free = SURROGATE_SHIFTS.into_iter().find(|&shift| {
            let stand_ins = 0xD800 + u32::from(shift)..0xE000 + u32::from(shift);
            !present.iter().any(|code| stand_ins.contains(code))
        });
        // TODO(port): 3 つの私用領域をすべて使うスカラ (6144 字の私用領域の字を含む) はサロゲートを書き換えず、構文の誤りのまま (A-131)
        let Some(shift) = free.filter(|_| !surrogates.is_empty()) else {
            return false;
        };
        for (at, code, width) in surrogates {
            let digits = format!("{:0width$X}", code + u32::from(shift));
            self.text.replace_range(at..at + width, &digits);
        }
        self.surrogate_scalars.push((quote, shift));
        true
    }

    // フローの入れ物の閉じの字 (`]` か `}`) で saphyr が字下げの誤りにしたとき、直前のトークンから閉じの字までの改行とコメントを空白にする。
    // saphyr は中身のない入れ物 (`[\n]`) や入れ物で終わる入れ物 (`[\n  [ ]\n]`) の閉じの字の桁が親のブロックの字下げ以下なら止まり、
    // eemeli/yaml は一番外のフローの入れ物の閉じの字なら字下げより小さいときだけ誤りにする (内側の閉じの字は字下げより深くないと誤り)。
    // 閉じの字を 1 桁右にずらした写しを saphyr で読み、そこで止まらず、閉じるのが一番外の入れ物なら eemeli/yaml は読む
    fn rewrite_flow_end(&mut self, position: usize, index: usize) -> bool {
        if !self
            .text
            .get(position..)
            .is_some_and(|rest| rest.starts_with([']', '}']))
        {
            return false;
        }
        let mut shifted = self.text.clone();
        shifted.insert(position, ' ');
        let Some(previous) = outermost_flow_end(&shifted, index + 1) else {
            return false;
        };
        // 直前のトークンの終わり。引用つきのスカラは閉じの引用符の次 (saphyr の Span は後ろのコメントまで含む)
        let token = self.byte(previous.start);
        let scan_from = if previous.quoted {
            quoted_end(&self.text, token, previous.style).unwrap_or(position)
        } else {
            token
        };
        let line_end = index_of_newline(&self.text, scan_from)
            .unwrap_or(position)
            .min(position);
        let line = js_slice(&self.text, scan_from, line_end);
        let comment = line
            .char_indices()
            .find(|&(at, c)| c == '#' && js_slice(line, 0, at).ends_with([' ', '\t']));
        let content = js_slice(line, 0, comment.map_or(line.len(), |(at, _)| at))
            .trim_end_matches([' ', '\t', '\r']);
        let from = scan_from + content.len();
        let gap = js_slice(&self.text, from, position);
        // 間は区切りの空白、改行、コメントだけ (錨やタグが残っていれば書き換えない)。改行がなければ書き換えても変わらない
        let only_blanks = gap.split('\n').enumerate().all(|(line_index, segment)| {
            let rest = segment.trim_start_matches([' ', '\t', '\r']);
            let starts_with_blank = line_index > 0 || segment.starts_with([' ', '\t']);
            rest.is_empty() || (rest.starts_with('#') && starts_with_blank)
        });
        if !only_blanks || !gap.contains('\n') {
            return false;
        }
        let blank = " ".repeat(gap.len());
        self.text.replace_range(from..position, &blank);
        true
    }
}

// フローの入れ物の閉じの直前のトークン (saphyr のイベント)。start は文字の添字
struct PreviousToken {
    start: usize,
    quoted: bool,
    style: ScalarStyle,
}

// text を saphyr で読み、文字の添字 closer から始まるフローの入れ物の閉じのイベントが一番外の入れ物を閉じるなら、
// 閉じの字より前から始まる最後のイベントを返す。そこへ届く前に止まるか、内側の入れ物の閉じなら None
fn outermost_flow_end(text: &str, closer: usize) -> Option<PreviousToken> {
    let chars: Vec<char> = text.chars().collect();
    let mut parser = Parser::new_from_str(text);
    let mut depth = 0usize;
    let mut previous: Option<PreviousToken> = None;
    while let Some(next) = parser.next_event() {
        let (event, span) = next.ok()?;
        let (start, end) = (span.start.index(), span.end.index());
        // フロー形式の開きと閉じのイベントは字 (`[` `{` `]` `}`) を覆い、ブロック形式のものは幅 0 (錨とタグだけを覆うこともある)
        let covered = chars.get(start..end).unwrap_or_default();
        let opens_flow = covered
            .iter()
            .find(|c| matches!(c, '[' | '{' | '#'))
            .is_some_and(|c| *c != '#');
        match &event {
            Event::SequenceStart(..) | Event::MappingStart(..) if opens_flow => depth += 1,
            Event::SequenceEnd | Event::MappingEnd if end > start => {
                if start == closer {
                    return if depth == 1 { previous } else { None };
                }
                depth = depth.saturating_sub(1);
            }
            Event::StreamEnd => return None,
            _ => {}
        }
        if start < closer {
            let (quoted, style) = match &event {
                Event::Scalar(_, style, ..) => (
                    matches!(style, ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted),
                    *style,
                ),
                _ => (false, ScalarStyle::Plain),
            };
            previous = Some(PreviousToken {
                start,
                quoted,
                style,
            });
        }
    }
    None
}

// 原文の parseDocument(body, { lineCounter })。saphyr には SaphyrInput の写しを渡し、止まったら書き換えて読み直す。
// 値の読み取りと共有の書き換えのほかに、位置の木だけの書き換えを 1 つ持つ: 未定義の別名 (`*nope`) の `*` は plain の字にし、
// そこから始まるスカラを別名の節にする (eemeli/yaml は構文の誤りにせず、値を読む側で失敗する)
// 位置の木だけの書き換えは規則 2.2 の「saphyr-parser に渡す写しと Span の直し」の (1)(2) (A-081 (2)、A-131 (1))
fn parse_document(body: &str) -> YamlDocument {
    let mut input = SaphyrInput::new(body);
    let mut aliases: Vec<usize> = Vec::new();
    loop {
        let (document, rewrite) = TreeBuilder::new(body, &input, &aliases).build();
        match rewrite {
            Some(Rewrite::Alias(position)) => {
                input.text.replace_range(position..position + 1, "x");
                aliases.push(input.base + position);
            }
            Some(Rewrite::Shared { info, index }) => {
                if !input.rewrite(&info, index) {
                    return document;
                }
            }
            None => return document,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期待値は原文の FrontmatterLocator を vite-node で動かして取った (2026-09-24)。
    // 構文の誤りの文面と、誤りのある frontmatter の位置だけは saphyr の値で、旧実装との差を注記する

    fn pos(line: u32, column: u32, length: u32) -> Option<SourcePosition> {
        Some(SourcePosition {
            line,
            column,
            length,
        })
    }

    fn k(name: &str) -> PathStep {
        PathStep::Key(name.to_string())
    }

    fn i(index: usize) -> PathStep {
        PathStep::Index(index)
    }

    fn errors(locator: &FrontmatterLocator) -> Vec<(String, Option<SourcePosition>)> {
        locator
            .syntax_errors()
            .into_iter()
            .map(|error| (error.message, error.at))
            .collect()
    }

    #[test]
    fn locator_lazy_regexes_compile() {
        LazyLock::force(&FRONTMATTER_OPEN);
        LazyLock::force(&FRONTMATTER_CLOSE);
    }

    // saphyr-parser 0.0.12 の Marker::index は文字 (コードポイント) の数。版を上げて単位が変わったらここで気づく
    #[test]
    fn locator_saphyr_marker_counts_code_points() {
        let mut parser = Parser::new_from_str("あい: 😀x");
        let mut scalars = Vec::new();
        while let Some(Ok((event, span))) = parser.next_event() {
            if let Event::Scalar(value, ..) = event {
                scalars.push((value.to_string(), span.start.index(), span.end.index()));
            }
            if span.start.index() > 10 {
                break;
            }
        }
        assert_eq!(
            scalars,
            vec![("あい".to_string(), 0, 2), ("😀x".to_string(), 4, 6)]
        );
    }

    #[test]
    fn locator_value_and_key_nested() {
        let locator = FrontmatterLocator::new(Some(
            "---\nmarkdag:\n  relations:\n    fork:\n      - A --> B & C\n      - \"Q --> R\"\n  groups:\n    2024: { label: 年, color: '#fff' }\n---\n# Root\n",
        ));
        assert_eq!(locator.key(&[k("markdag")]), pos(2, 1, 7));
        assert_eq!(locator.value(&[k("markdag")], None), pos(2, 1, 8));
        assert_eq!(
            locator.key(&[k("markdag"), k("relations"), k("fork")]),
            pos(4, 5, 4)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("fork"), i(0)], None),
            pos(5, 9, 11)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("fork"), i(1)], None),
            pos(6, 9, 9)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("fork"), i(2)], None),
            pos(4, 5, 4)
        );
        assert_eq!(
            locator.key(&[k("markdag"), k("groups"), k("2024")]),
            pos(8, 5, 4)
        );
        assert_eq!(
            locator.key(&[k("markdag"), k("groups"), i(2024)]),
            pos(8, 5, 4)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("groups"), k("2024"), k("label")], None),
            pos(8, 20, 1)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("groups"), k("2024"), k("color")], None),
            pos(8, 30, 6)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("fork"), k("x")], None),
            pos(4, 5, 4)
        );
        assert_eq!(locator.value(&[k("missing"), k("deep")], None), None);
        assert_eq!(locator.key(&[]), None);
        assert_eq!(locator.value(&[], None), pos(2, 1, 8));
    }

    #[test]
    fn locator_value_inner_word() {
        let locator = FrontmatterLocator::new(Some(
            "---\nmarkdag:\n  chain: Root --> Root\n  dup: A --> A\n  inner: \"A --> Bee\"\n  fork:\n    - A --> B & C\n---\n",
        ));
        assert_eq!(
            locator.value(&[k("markdag"), k("chain")], Some("Root")),
            pos(3, 10, 13)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("dup")], Some("A")),
            pos(4, 8, 7)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("inner")], Some("Bee")),
            pos(5, 17, 3)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("inner")], Some("A")),
            pos(5, 11, 1)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("inner")], Some("")),
            pos(5, 10, 11)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("inner")], Some("zzz")),
            pos(5, 10, 11)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("fork"), i(0)], Some("C")),
            pos(7, 17, 1)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("fork"), i(0)], Some("-->")),
            pos(7, 9, 3)
        );
    }

    #[test]
    fn locator_block_scalar_points_at_first_content_line() {
        let locator = FrontmatterLocator::new(Some(
            "---\nmarkdag:\n  relations:\n    chain: |-\n      Root --> Child\n      Child --> Leaf\n    join: >\n\n      X --> Y\n    empty: |-\n    after: 1\n    last: |+\n---\n",
        ));
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("chain")], None),
            pos(5, 7, 14)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("chain")], Some("Leaf")),
            pos(6, 17, 4)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("chain")], Some("Child")),
            pos(5, 7, 14)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("join")], None),
            None
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("empty")], None),
            pos(11, 5, 8)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("last")], None),
            pos(12, 11, 2)
        );
    }

    #[test]
    fn locator_block_scalar_header_with_anchor_and_comment() {
        let locator =
            FrontmatterLocator::new(Some("---\na: &x |- # a|b\n  foo\nb: >-  # c\n  bar\n---\n"));
        assert_eq!(locator.value(&[k("a")], None), pos(3, 3, 3));
        assert_eq!(locator.value(&[k("b")], None), pos(5, 3, 3));
    }

    #[test]
    fn locator_flow_and_quoted() {
        let locator = FrontmatterLocator::new(Some(
            "---\nkey: [a, {b: c}, \"d e\"]\nm: {x: [1]}\nsq: 'it''s' # c\ndq: \"a\\\"b\" # c\n\"quoted key\": v\n---\n",
        ));
        assert_eq!(locator.value(&[k("key")], None), pos(2, 1, 23));
        assert_eq!(locator.value(&[k("key"), i(0)], None), pos(2, 7, 1));
        assert_eq!(locator.value(&[k("key"), i(1)], None), pos(2, 10, 14));
        assert_eq!(
            locator.value(&[k("key"), i(1), k("b")], None),
            pos(2, 14, 1)
        );
        assert_eq!(locator.value(&[k("key"), i(2)], None), pos(2, 18, 5));
        assert_eq!(locator.value(&[k("key"), i(2)], Some("e")), pos(2, 21, 1));
        assert_eq!(locator.value(&[k("m"), k("x")], None), pos(3, 5, 7));
        assert_eq!(locator.value(&[k("m"), k("x"), i(0)], None), pos(3, 9, 1));
        assert_eq!(locator.value(&[k("sq")], None), pos(4, 5, 7));
        assert_eq!(locator.value(&[k("dq")], None), pos(5, 5, 6));
        assert_eq!(locator.key(&[k("quoted key")]), pos(6, 1, 12));
        assert_eq!(locator.value(&[k("quoted key")], None), pos(6, 15, 1));
    }

    #[test]
    fn locator_empty_values_and_comments() {
        let locator = FrontmatterLocator::new(Some(
            "---\ncolor: #D64545\ny: # only\nz:\nlist:\n  -\n  - # c\n  - \n  - a: 1\n  - [1, 2]\n  - - p\n---\n",
        ));
        assert_eq!(locator.value(&[k("color")], None), pos(2, 1, 14));
        assert_eq!(locator.value(&[k("y")], None), pos(3, 1, 9));
        assert_eq!(locator.value(&[k("z")], None), pos(4, 1, 2));
        assert_eq!(locator.value(&[k("list"), i(0)], None), pos(6, 3, 1));
        assert_eq!(locator.value(&[k("list"), i(1)], None), pos(7, 5, 3));
        assert_eq!(locator.value(&[k("list"), i(2)], None), pos(8, 3, 1));
        assert_eq!(locator.value(&[k("list"), i(3)], None), pos(9, 5, 4));
        assert_eq!(locator.value(&[k("list"), i(4)], None), pos(10, 5, 6));
        assert_eq!(locator.value(&[k("list"), i(5)], None), pos(11, 5, 3));
        assert_eq!(locator.value(&[k("list"), i(9)], None), pos(5, 1, 4));
    }

    #[test]
    fn locator_columns_count_code_points() {
        let locator = FrontmatterLocator::new(Some(
            "---\nあい: 😀x y😀\nk: 全角　スペース\n'😀': \"é\"\n---\n",
        ));
        assert_eq!(locator.key(&[k("あい")]), pos(2, 1, 2));
        assert_eq!(locator.value(&[k("あい")], None), pos(2, 5, 5));
        assert_eq!(locator.value(&[k("あい")], Some("y😀")), pos(2, 8, 2));
        assert_eq!(locator.value(&[k("k")], None), pos(3, 4, 7));
        assert_eq!(locator.value(&[k("k")], Some("スペース")), pos(3, 7, 4));
        assert_eq!(locator.key(&[k("😀")]), pos(4, 1, 3));
        assert_eq!(locator.value(&[k("😀")], None), pos(4, 6, 3));
    }

    #[test]
    fn locator_crlf() {
        let locator = FrontmatterLocator::new(Some(
            "---\r\na: 1\r\nb: \"x y\"\r\nc: |-\r\n  one two\r\n---\r\n# A\r\n",
        ));
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 1));
        assert_eq!(locator.value(&[k("b")], None), pos(3, 4, 5));
        assert_eq!(locator.value(&[k("b")], Some("y")), pos(3, 7, 1));
        assert_eq!(locator.value(&[k("c")], None), pos(5, 3, 7));
        assert_eq!(locator.key(&[k("c")]), pos(4, 1, 1));
    }

    // A-032 (2) の確認: saphyr の Span は錨とタグの後ろから始まる (c の値は !!str の後ろの 3 を指す)
    #[test]
    fn locator_alias_and_tags() {
        let locator =
            FrontmatterLocator::new(Some("---\na: &x v\nb: *x\nc: !!str 3\nd: [*x, y]\n---\n"));
        assert_eq!(locator.value(&[k("a")], None), pos(2, 7, 1));
        assert_eq!(locator.value(&[k("b")], None), pos(3, 1, 5));
        assert_eq!(locator.value(&[k("b"), k("z")], None), pos(3, 1, 1));
        assert_eq!(locator.value(&[k("c")], None), pos(4, 10, 1));
        assert_eq!(locator.value(&[k("d"), i(0)], None), pos(5, 1, 1));
        assert_eq!(locator.value(&[k("d"), i(1)], None), pos(5, 9, 1));
    }

    #[test]
    fn locator_keys_are_stringified() {
        let locator = FrontmatterLocator::new(Some(
            "---\ntrue: 1\n1.0: 2\n.inf: 3\n0x10: 4\n~: 5\n: 6\n---\n",
        ));
        assert_eq!(locator.key(&[k("true")]), pos(2, 1, 4));
        assert_eq!(locator.key(&[k("1")]), pos(3, 1, 3));
        assert_eq!(locator.key(&[k("Infinity")]), pos(4, 1, 4));
        assert_eq!(locator.key(&[k("16")]), pos(5, 1, 4));
        assert_eq!(locator.key(&[i(16)]), pos(5, 1, 4));
        assert_eq!(locator.key(&[k("null")]), pos(6, 1, 1));
        assert_eq!(locator.value(&[k("null")], None), pos(6, 4, 1));
    }

    #[test]
    fn locator_complex_keys() {
        let locator = FrontmatterLocator::new(Some("---\n? complex\n: value\n? only\n---\n"));
        assert_eq!(locator.key(&[k("complex")]), pos(2, 3, 7));
        assert_eq!(locator.value(&[k("complex")], None), pos(3, 3, 5));
        assert_eq!(locator.key(&[k("only")]), pos(4, 3, 4));
        assert_eq!(locator.value(&[k("only")], None), pos(4, 3, 4));
    }

    #[test]
    fn locator_multiline_plain() {
        let locator =
            FrontmatterLocator::new(Some("---\np: one\n  two # c\nq:   spaced value   \n---\n"));
        assert_eq!(locator.value(&[k("p")], None), pos(2, 4, 3));
        assert_eq!(locator.value(&[k("p")], Some("two")), pos(3, 3, 3));
        assert_eq!(locator.value(&[k("q")], None), pos(4, 6, 12));
    }

    #[test]
    fn locator_duplicate_keys() {
        let locator = FrontmatterLocator::new(Some(
            "---\na: 1\n007: 2\n7: 3\n\"a\": 4\n1: 5\n\"1\": 6\nm: {k: 1, k: 2}\n---\n",
        ));
        assert_eq!(
            errors(&locator),
            vec![
                ("Map keys must be unique".to_string(), pos(4, 1, 4)),
                ("Map keys must be unique".to_string(), pos(5, 1, 6)),
                ("Map keys must be unique".to_string(), pos(8, 1, 15))
            ]
        );
        assert_eq!(locator.key(&[k("7")]), pos(3, 1, 3));
        assert_eq!(locator.value(&[k("7")], None), pos(3, 6, 1));
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 1));
        assert_eq!(locator.value(&[k("1")], None), pos(6, 4, 1));
        assert_eq!(locator.value(&[k("m"), k("k")], None), pos(8, 8, 1));
    }

    #[test]
    fn locator_multiple_documents_after_end_marker() {
        let locator = FrontmatterLocator::new(Some("---\na: 1\n...\nb\n---\n"));
        assert_eq!(
            errors(&locator),
            vec![(
                "Source contains multiple documents; please use YAML.parseAllDocuments()"
                    .to_string(),
                pos(4, 1, 1)
            )]
        );
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 1));
    }

    #[test]
    fn locator_multiple_documents_after_start_marker() {
        let locator = FrontmatterLocator::new(Some("---\na: 1\n--- x\nb\n---\n"));
        assert_eq!(
            errors(&locator),
            vec![(
                "Source contains multiple documents; please use YAML.parseAllDocuments()"
                    .to_string(),
                pos(3, 1, 5)
            )]
        );
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 1));
    }

    #[test]
    fn locator_end_marker_alone_is_one_document() {
        let locator = FrontmatterLocator::new(Some("---\na: 1\n...\n# comment\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 1));
    }

    #[test]
    fn locator_empty_frontmatter() {
        let locator = FrontmatterLocator::new(Some("---\n---\n# A\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), None);
        assert_eq!(locator.key(&[k("a")]), None);
    }

    #[test]
    fn locator_blank_frontmatter() {
        let locator = FrontmatterLocator::new(Some("---\n\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), None);
    }

    #[test]
    fn locator_without_frontmatter() {
        let locator = FrontmatterLocator::new(Some("# no frontmatter\n---\na: 1\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), None);
    }

    #[test]
    fn locator_unclosed_frontmatter() {
        let locator = FrontmatterLocator::new(Some("---\na: 1\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), None);
    }

    // 構文の誤りは saphyr の最初の 1 件 (A-024)。旧実装は 2 件 ("Nested mappings are not allowed in compact mappings" を行 2 と行 3)
    // `:` と `?` の直後のタブは YAML 1.2 の区切り。eemeli/yaml は誤りにしない (saphyr は誤りにするので写しを書き換えて読む)
    // 値の読み取りと共有の書き換え (`?` の後ろのタブ、行をまたぐフローの閉じ、サロゲートの escape、NUL)。
    // 旧実装は誤りなしで、位置は原文の FrontmatterLocator を vite-node で動かして取った
    #[test]
    fn locator_shared_saphyr_rewrites() {
        let locator = FrontmatterLocator::new(Some("---\n? \ta\n: b\nc: d\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("a")]), pos(2, 4, 1));
        assert_eq!(locator.value(&[k("a")], None), pos(3, 3, 1));
        assert_eq!(locator.value(&[k("c")], None), pos(4, 4, 1));
        let locator = FrontmatterLocator::new(Some("---\na: [\n]\nb: x\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("b")]), pos(4, 1, 1));
        assert_eq!(locator.value(&[k("b")], None), pos(4, 4, 1));
        let locator = FrontmatterLocator::new(Some("---\nm: [\n  \"x\" # c\n]\nb: x\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("m"), i(0)], None), pos(3, 3, 3));
        assert_eq!(locator.value(&[k("b")], None), pos(5, 4, 1));
        let locator = FrontmatterLocator::new(Some("---\nm:\n  g: {\n  }\n  h: 2\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("m"), k("g")]), pos(3, 3, 1));
        assert_eq!(locator.value(&[k("m"), k("h")], None), pos(5, 6, 1));
        let locator = FrontmatterLocator::new(Some("---\nt: \"\\ud83d\\ude00\"\nb: x\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("t")], None), pos(2, 4, 14));
        assert_eq!(locator.value(&[k("b")], None), pos(3, 4, 1));
        let locator = FrontmatterLocator::new(Some("---\n\"\\ud83d\\ude00\": 1\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("😀")]), pos(2, 1, 14));
        assert_eq!(locator.value(&[k("😀")], None), pos(2, 17, 1));
        let locator = FrontmatterLocator::new(Some("---\na: b\u{0}c\nb: x\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 3));
        assert_eq!(locator.value(&[k("b")], None), pos(3, 4, 1));
    }

    #[test]
    fn locator_tab_after_indicator() {
        let locator =
            FrontmatterLocator::new(Some("---\na:\tvalue\nb: \tv2\t\nc: [\t1,\t2 ]\n---\n# A\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("a")]), pos(2, 1, 1));
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 5));
        assert_eq!(locator.value(&[k("b")], None), pos(3, 5, 2));
        assert_eq!(locator.value(&[k("c"), i(1)], None), pos(4, 9, 1));
        assert_eq!(locator.value(&[], None), pos(2, 1, 8));
        let locator = FrontmatterLocator::new(Some(
            "---\nmarkdag:\n  relations:\n    chain:\tA --> B\n---\n# A\n",
        ));
        assert_eq!(
            locator.key(&[k("markdag"), k("relations"), k("chain")]),
            pos(4, 5, 5)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("chain")], None),
            pos(4, 12, 7)
        );
        assert_eq!(
            locator.value(&[k("markdag"), k("relations"), k("chain")], Some("A")),
            pos(4, 12, 1)
        );
        let locator = FrontmatterLocator::new(Some("---\n- a:\t1\n---\n# A\n"));
        assert_eq!(locator.value(&[i(0), k("a")], None), pos(2, 6, 1));
        let locator = FrontmatterLocator::new(Some("---\ne: {a:\t1}\n---\n# A\n"));
        assert_eq!(locator.value(&[k("e"), k("a")], None), pos(2, 8, 1));
        let locator = FrontmatterLocator::new(Some("---\n?\ta\n:\tb\n\"k:\tx\": 1\n---\n# A\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("k:\tx")]), pos(4, 1, 6));
    }

    // フロー形式の暗黙の null は幅 0 で、キー (無ければその位置) から行末を指す
    #[test]
    fn locator_flow_implicit_null() {
        let value = |fm: &str, path: &[PathStep]| {
            FrontmatterLocator::new(Some(&format!("---\n{fm}\n---\n# A\n"))).value(path, None)
        };
        assert_eq!(value("z: {a, b: }", &[k("z"), k("a")]), pos(2, 5, 7));
        assert_eq!(value("z: {a}", &[k("z"), k("a")]), pos(2, 5, 2));
        assert_eq!(value("z: {a, b}", &[k("z"), k("a")]), pos(2, 5, 5));
        assert_eq!(value("z: {a, b}", &[k("z"), k("b")]), pos(2, 8, 2));
        assert_eq!(value("z: {a: 1, b}", &[k("z"), k("b")]), pos(2, 11, 2));
        assert_eq!(value("z: {? a, b: 1}", &[k("z"), k("a")]), pos(2, 7, 8));
        assert_eq!(value("{a: &x , b: 1}", &[k("a")]), pos(2, 2, 13));
        assert_eq!(value("[&a , b]", &[i(0)]), pos(2, 5, 4));
    }

    // 並びの項目が錨かタグだけのとき、空の値はその項目の行 (錨とタグと空白の後ろ) にある。次の項目を指さない
    #[test]
    fn locator_seq_items_with_only_properties() {
        let locator = FrontmatterLocator::new(Some(
            "---\nlist:\n  - &a\n  - !!str\n  - &b # c\n  - x\n---\n# A\n",
        ));
        assert_eq!(locator.value(&[k("list"), i(0)], None), pos(3, 3, 4));
        assert_eq!(locator.value(&[k("list"), i(1)], None), pos(4, 3, 7));
        assert_eq!(locator.value(&[k("list"), i(2)], None), pos(5, 8, 3));
        assert_eq!(locator.value(&[k("list"), i(3)], None), pos(6, 5, 1));
        let locator = FrontmatterLocator::new(Some("---\nlist:\n  - !!null\n  - x\n---\n# A\n"));
        assert_eq!(locator.value(&[k("list"), i(0)], None), pos(3, 3, 8));
        let locator = FrontmatterLocator::new(Some(
            "---\nmarkdag:\n  groups:\n    - &g\n    - name: x\n---\n# A\n",
        ));
        assert_eq!(
            locator.value(&[k("markdag"), k("groups"), i(0)], None),
            pos(4, 5, 4)
        );
    }

    // 折り返しの記号の前のコメントに `|` や `>` があっても、記号でなく中身の 1 行目を指す
    #[test]
    fn locator_block_scalar_header_after_comment() {
        let value = |fm: &str, path: &[PathStep]| {
            FrontmatterLocator::new(Some(&format!("---\n{fm}\n---\n# A\n"))).value(path, None)
        };
        assert_eq!(value("a: # note |\n  |\n    body", &[k("a")]), pos(4, 5, 4));
        assert_eq!(value("a: # >\n  >-\n    body", &[k("a")]), pos(4, 5, 4));
        assert_eq!(value("- # |\n  |\n    body", &[i(0)]), pos(4, 5, 4));
        assert_eq!(value("a: &x # |\n  |\n    body", &[k("a")]), pos(4, 5, 4));
        assert_eq!(
            value("a:\n  # | comment\n  |\n    body", &[k("a")]),
            pos(5, 5, 4)
        );
        assert_eq!(
            value(
                "markdag:\n  relations:\n    chain: # 下の | を使う\n      |\n        A --> B",
                &[k("markdag"), k("relations"), k("chain")]
            ),
            pos(6, 9, 7)
        );
    }

    // 写像の開始は錨とタグ (フロー形式の並びの中の 1 組の写像では `?` も) の後ろ
    #[test]
    fn locator_map_start_after_properties() {
        let locator =
            FrontmatterLocator::new(Some("---\nlist:\n  - &a x: 1\n  - !!str k: v\n---\n# A\n"));
        assert_eq!(locator.value(&[k("list"), i(0)], None), pos(3, 8, 4));
        assert_eq!(locator.value(&[k("list"), i(1)], None), pos(4, 11, 4));
        let locator = FrontmatterLocator::new(Some("---\nz: [? a]\n---\n# A\n"));
        assert_eq!(locator.value(&[k("z"), i(0)], None), pos(2, 7, 2));
        assert_eq!(locator.value(&[k("z"), i(0), k("a")], None), pos(2, 7, 2));
        let locator = FrontmatterLocator::new(Some("---\na: [? b: c]\n---\n# A\n"));
        assert_eq!(locator.value(&[k("a"), i(0)], None), pos(2, 7, 5));
        let locator = FrontmatterLocator::new(Some("---\n&k key: v\n*k : w\n---\n# A\n"));
        assert_eq!(locator.value(&[], None), pos(2, 4, 6));
        let locator = FrontmatterLocator::new(Some("---\n? complex\n: value\n---\n# A\n"));
        assert_eq!(locator.value(&[], None), pos(2, 1, 9));
    }

    // 文書の先頭の BOM は eemeli/yaml が落とす。桁は BOM を 1 字と数える
    #[test]
    fn locator_leading_bom() {
        let locator = FrontmatterLocator::new(Some("---\n\u{feff}markdag: 1\n---\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("markdag")]), pos(2, 2, 7));
        assert_eq!(locator.value(&[k("markdag")], None), pos(2, 11, 1));
        assert_eq!(locator.value(&[], None), pos(2, 2, 10));
    }

    // タグつきのキーはタグで解決する (!!int "0x10" は 16、!!null "" は null)
    #[test]
    fn locator_tagged_keys() {
        let locator = FrontmatterLocator::new(Some(
            "---\n!!int \"0x10\": a\n!!null \"\": b\n!!str 1: c\n!!float 2: d\n!!bool \"true\": e\n---\n# A\n",
        ));
        assert_eq!(locator.key(&[k("16")]), pos(2, 7, 6));
        assert_eq!(locator.value(&[k("16")], None), pos(2, 15, 1));
        assert_eq!(locator.key(&[k("null")]), pos(3, 8, 2));
        assert_eq!(locator.value(&[k("null")], None), pos(3, 12, 1));
        assert_eq!(locator.value(&[k("1")], None), pos(4, 10, 1));
        assert_eq!(locator.value(&[k("true")], None), pos(6, 16, 1));
        assert_eq!(locator.value(&[], None), pos(2, 7, 9));
    }

    // 未定義の別名は eemeli/yaml の構文の誤りにならない (値を読む側で失敗する)。位置は別名の節と同じくキーから行末
    #[test]
    fn locator_unknown_alias_is_not_a_syntax_error() {
        let locator = FrontmatterLocator::new(Some("---\na: *undefined\n---\n# A\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), pos(2, 1, 13));
        let locator = FrontmatterLocator::new(Some("---\na: &x 1\nb: *y\n---\n# A\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("a")], None), pos(2, 7, 1));
        assert_eq!(locator.value(&[k("b")], None), pos(3, 1, 5));
        assert_eq!(locator.value(&[], None), pos(2, 1, 7));
        let locator = FrontmatterLocator::new(Some("---\n*u : v\nw: [*v, 1]\n---\n# A\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.value(&[k("w"), i(1)], None), pos(3, 9, 1));
    }

    // 文書の末尾の `?` だけの行は、値が null のキー
    #[test]
    fn locator_trailing_question_mark() {
        let locator = FrontmatterLocator::new(Some("---\nx: y\n?\n---\n# A\n"));
        assert_eq!(errors(&locator), vec![]);
        assert_eq!(locator.key(&[k("null")]), None);
        assert_eq!(locator.value(&[k("null")], None), pos(3, 1, 1));
    }

    // 旧実装で誤りのない文書のうち、位置が違うまま残るもの (A-082 (f)、accepted.md 18)。値は Rust のもので、旧実装の値を注記する
    #[test]
    fn locator_known_differences_without_syntax_errors() {
        // 字下げした空のキー: 旧実装は誤りなしで value(["null"]) = 3:5+3
        let locator = FrontmatterLocator::new(Some("---\nkey: value\n  : bad\n---\n# A\n"));
        assert_eq!(
            errors(&locator),
            vec![(
                "while parsing a block mapping, did not find expected key".to_string(),
                pos(3, 3, 5)
            )]
        );
        assert_eq!(locator.value(&[k("null")], None), None);
        // 空行の前の `?` だけのキー: 旧実装は 3:1+1
        let locator = FrontmatterLocator::new(Some("---\na: 1\n?\n\n---\n# A\n"));
        assert_eq!(locator.value(&[k("null")], None), None);
        // フロー形式の `[?]`: 旧実装は `?` を値のない組 (null のキー) と読み、2:6+1
        let locator = FrontmatterLocator::new(Some("---\na: [?]\n---\n# A\n"));
        assert_eq!(locator.value(&[k("a"), i(0)], None), pos(2, 5, 1));
    }

    #[test]
    fn locator_syntax_error_is_first_scan_error() {
        let locator = FrontmatterLocator::new(Some("---\na: b: c\nd: e: f\n---\n"));
        assert_eq!(
            errors(&locator),
            vec![(
                "mapping values are not allowed in this context".to_string(),
                pos(2, 1, 7)
            )]
        );
    }

    // 旧実装は "Missing closing \"quote" で、位置は同じ行
    #[test]
    fn locator_syntax_error_unclosed_quote() {
        let locator = FrontmatterLocator::new(Some("---\na: \"open\n---\n"));
        assert_eq!(
            errors(&locator),
            vec![(
                "while scanning a quoted scalar, found unexpected end of stream".to_string(),
                pos(2, 1, 8)
            )]
        );
    }

    // 誤りがあっても、誤りの前までの木は残す (A-023)
    #[test]
    fn locator_syntax_error_keeps_partial_tree() {
        let locator = FrontmatterLocator::new(Some("---\na: 1\nb: [1, 2\n---\n"));
        assert_eq!(
            errors(&locator),
            vec![(
                "while parsing a flow sequence, expected ',' or ']'".to_string(),
                pos(3, 1, 8)
            )]
        );
        assert_eq!(locator.value(&[k("a")], None), pos(2, 4, 1));
        assert_eq!(locator.value(&[k("b"), i(0)], None), pos(3, 5, 1));
    }

    // 先頭が多バイトの字で、offset 0 の spanOfLine がパニックしない (A-006)。
    // 1 件目の位置が旧実装と違う (Implicit keys / Nested mappings の類。A-082 (a)、accepted.md 18)。旧実装の yaml-syntax は pos 0 で
    // {line: 2, column: 1, length: 1} ("Implicit keys need to be on a single line")、saphyr は `:` で誤りにするので行 3 を指す (A-082)
    #[test]
    fn locator_offset_zero_with_multibyte_head() {
        let locator = FrontmatterLocator::new(Some("---\nあ\nmarkdag: 1\n---\n# A\n"));
        assert_eq!(locator.span_of_line(0), pos(2, 1, 1));
        assert_eq!(locator.span_from(0, None), pos(2, 1, 1));
        assert_eq!(
            errors(&locator),
            vec![(
                "mapping values are not allowed in this context".to_string(),
                pos(3, 1, 10)
            )]
        );
    }
}

// PORT STATUS: confidence=medium todos=6
