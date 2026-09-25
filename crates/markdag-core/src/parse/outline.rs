// 原文: sample/markmap/packages/markmap-html-parser/src/index.ts (parseHtml / convertNode / buildTree) と sample/markmap/packages/markmap-lib/src/transform.ts (cleanNode、root.content の補い) (2026-09-24)
// Markdown の本文からアウトラインの木を組む (旧実装が markmap-lib の Transformer から受け取っていた木)。
// markmap-html-parser は markdown-it の HTML を DOM にして selector の規則で木を組んでいた。ここではその規則を comrak の AST の上で写す:
// 見出しは headingStack で親を決め、ul / ol は中身のない容器のノード、li はノード (内容は入れ子のリストより前)、
// 表とコードブロックと画像だけの段落は Block のノード。親の children の level は最初に来た子で決まり、より小さい level が来たら作り直し、
// より大きい level は捨てる (addChild)。そのあと markmap-lib の cleanNode で空の包みを畳み、ルートの内容が空なら frontmatter の title で補う。
// ノードの内容の HTML は HTML の層が markdown-it と同じ形で書き、行の範囲 (data-lines) もその層のトークンの map から取る。
use comrak::arena_tree::NodeEdge;
use comrak::nodes::{AstNode, ListType, NodeValue};
use comrak::{Arena, parse_document};

use super::html::Tokens;
use super::inline_marks::comrak_options;
use crate::limits::MAX_NESTING;
use crate::model::util::{JsValue, js_to_string, to_u32};
use crate::types::{LineRange, ParsedFeatures};

// html-parser の Levels。見出しは 1〜6 (h1〜h6 の数)
const LEVEL_NONE: u8 = 0;
const LEVEL_BLOCK: u8 = 7;
const LEVEL_LIST: u8 = 8;
const LEVEL_LIST_ITEM: u8 = 9;

/// ノードになった要素 (原文の payload.tag。`h1`〜`h6`、`ul`、`ol`、`li`、`table`、`pre`、`img`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum BlockTag {
    Heading(u8),
    Ul,
    Ol,
    Li,
    Table,
    Pre,
    Img,
}

/// markmap の IPureNode にあたる木のノード。payload のうち旧実装が読む欄 (tag、lines、fold) を持つ
#[derive(Debug, Clone)]
pub(super) struct OutlineTree {
    /// ノードの内容の HTML (DOM の要素の outerHTML / 中身を trimEnd したもの)
    pub(super) content: String,
    pub(super) children: Vec<OutlineTree>,
    /// payload.tag。payload のないノード (ルート) は None
    pub(super) tag: Option<BlockTag>,
    /// payload.lines (data-lines の「開始,終了」)。0 始まり、終了は含まない、frontmatter の行数を足したもの
    pub(super) lines: Option<LineRange>,
    /// payload.fold (magic comment の `fold` が 1、`foldAll` が 2)。なければ 0 (旧実装の `?? 0`)
    pub(super) fold: u8,
    /// 内容を、項目の直下の Markdown の引用ブロック (詳細の候補。AST の BlockQuote) の前後で分けたもの。
    /// 項目 (li) で引用ブロックがあるときだけ持ち、それ以外は空。つなげると trimEnd の前の内容になる
    pub(super) parts: Vec<ContentPart>,
}

/// 項目の内容の断片。詳細の切り分け (解析の層の splitDetails) が、書き出した HTML の文字を探さずに引用ブロックの要素を扱うためのもの
#[derive(Debug, Clone, PartialEq)]
pub(super) enum ContentPart {
    /// 引用ブロックの外の HTML
    Html(String),
    /// 引用ブロック 1 つ。open は開きのタグのトークンの書き出し (前の隠れた段落のあとの改行と、needLf の改行を含む)、
    /// inner はその中のトークン、close は閉じのタグのトークン (後ろの改行を含む)
    Quote {
        open: String,
        inner: String,
        close: String,
    },
}

/// 本文を解析した結果: アウトラインの木と、数式やコードを含むか
#[derive(Debug)]
pub(super) struct Outline {
    pub(super) root: OutlineTree,
    pub(super) features: ParsedFeatures,
}

/// markmap-lib の Transformer.transform のうち、本文 (frontmatter を切り取ったもの) から木を作る部分。
/// frontmatter_lines は data-lines に足す行数 (frontmatterInfo.lines)、frontmatter は読めた値 (読めなければ None。title の補いに使う)。
/// 原文: Transformer.transform (markdown-it の render、buildTree、cleanNode、root.content の補い)
pub(super) fn build_outline<'a>(
    arena: &'a Arena<'a>,
    body: &str,
    frontmatter_lines: usize,
    frontmatter: Option<&JsValue>,
) -> Outline {
    let body = normalize_source(body);
    let document = parse_body(arena, &body);
    // 上限より深い入れ子は、HTML の層とアウトラインの再帰がスタックを溢れさせるので木から外す (A-105)。
    // 外したことの診断は、model 層が原文から同じ判定で出す (parse の結果は診断を持たない)
    for node in too_deep_nodes(document) {
        node.detach();
    }
    let tokens = Tokens::build(document, &body, frontmatter_lines);
    let mut builder = Builder {
        tokens: &tokens,
        nodes: vec![HtmlNode {
            tag: None,
            html: String::new(),
            children: Some(Vec::new()),
            children_level: LEVEL_NONE,
            lines: None,
            list_index: None,
            comments: Vec::new(),
            parts: Vec::new(),
        }],
        heading_stack: Vec::new(),
    };
    builder.check_nodes(document.children().collect(), None);
    let mut root = clean_node(builder.convert_node(0));
    // `root.content ||= \`${context.frontmatter?.title || ''}\``
    if root.content.is_empty() {
        root.content = title_of(frontmatter);
    }
    Outline {
        root,
        features: features_of(document),
    }
}

/// 本文 (normalize_source を当てたもの) を comrak で読む。アウトラインの組み立てと、model 層が原文から出す本文の診断が同じ読み方をする
pub(super) fn parse_body<'a>(arena: &'a Arena<'a>, body: &str) -> &'a AstNode<'a> {
    parse_document(arena, body, &comrak_options())
}

// 入れ子の段に数える節: 子を持つ入れ物のうち、段に数えない形 (文書、リストの項目、段落、見出し、表の枠) 以外。
// リスト (項目は数えない)、引用、強調やリンクなどのインラインの入れ物が 1 段ずつになる。
// 数えない形は 1 本の道に高々 1 つずつ (項目はリストと対) なので、AST の深さは段数の 2 倍と少しに収まる
fn is_nesting<'a>(node: &'a AstNode<'a>) -> bool {
    node.first_child().is_some()
        && !matches!(
            node.data().value,
            NodeValue::Document
                | NodeValue::Item(_)
                | NodeValue::Paragraph
                | NodeValue::Heading(_)
                | NodeValue::Table(_)
                | NodeValue::TableRow(_)
                | NodeValue::TableCell
        )
}

/// 入れ子の段数が上限 (MAX_NESTING) を越える節のうち、最も外側のもの (文書順)。これらを外すと木は上限に収まる。
/// comrak の木を反復でたどる (traverse) ので、どれだけ深い木でも再帰しない
pub(super) fn too_deep_nodes<'a>(document: &'a AstNode<'a>) -> Vec<&'a AstNode<'a>> {
    let mut found = Vec::new();
    // 開いている節ごとの段数
    let mut levels: Vec<usize> = Vec::new();
    for edge in document.traverse() {
        match edge {
            NodeEdge::Start(node) => {
                let parent_level = levels.last().copied().unwrap_or(0);
                let nesting = is_nesting(node);
                if nesting && parent_level == MAX_NESTING {
                    found.push(node);
                }
                levels.push(parent_level + usize::from(nesting));
            }
            NodeEdge::End(_) => {
                levels.pop();
            }
        }
    }
    found
}

// markdown-it の core の normalize (`\r\n` と `\r` を `\n`、NUL を U+FFFD) と、StateBlock が行に数えない最後の行
// (改行で終わらず空白とタブだけの行) を除く。どちらも行の数と位置を変えないので、data-lines は原文の行のまま。
// AST の sourcepos の桁はこの本文の上の位置 (NUL のある行では原文とずれる)
pub(super) fn normalize_source(body: &str) -> String {
    let mut normalized = body
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "\u{FFFD}");
    let blank_last_line = normalized
        .rsplit('\n')
        .next()
        .filter(|line| !line.is_empty() && line.chars().all(|c| matches!(c, ' ' | '\t')))
        .map(str::len);
    if let Some(len) = blank_last_line {
        normalized.truncate(normalized.len() - len);
    }
    normalized
}

// html-parser の `$.html(...).trimEnd()`。cheerio は非 ASCII の字を数値の文字参照にしてから trimEnd するので、
// 削られるのは ASCII の空白 (`\t \n \v \f \r` と空白) だけ (全角空白や NBSP は残る)
fn trim_end_ascii(html: &str) -> &str {
    html.trim_end_matches([' ', '\t', '\n', '\u{b}', '\u{c}', '\r'])
}

// 数式 (math_dollars) とフェンスの有無。飾りと styleUrls は TS の包みがこれを見て作る (決定 12)。
// markmap の hljs プラグインが印を立てるのは markdown-it の highlight が呼ばれたとき (フェンスの書き出し) だけで、字下げのコードでは立たない
fn features_of<'a>(document: &'a AstNode<'a>) -> ParsedFeatures {
    let mut features = ParsedFeatures::default();
    for node in document.descendants() {
        match &node.data().value {
            NodeValue::Math(_) => features.math = true,
            NodeValue::CodeBlock(code) if code.fenced => features.code = true,
            _ => {}
        }
    }
    features
}

// `${frontmatter?.title || ''}`: 写像の title が truthy なら JS の文字列化、そうでなければ空。
// 規則 2.1 の `a || b` の行 (falsy は undefined、null、false、0、NaN、空文字)
fn title_of(frontmatter: Option<&JsValue>) -> String {
    let title = match frontmatter {
        Some(JsValue::Object(map)) => map.get("title"),
        _ => None,
    };
    let truthy = match title {
        None | Some(JsValue::Null | JsValue::Undefined) => false,
        Some(JsValue::Bool(value)) => *value,
        Some(JsValue::Number(value)) => *value != 0.0 && !value.is_nan(),
        Some(JsValue::String(value)) => !value.is_empty(),
        Some(JsValue::Array(_) | JsValue::Object(_)) => true,
    };
    match title {
        Some(value) if truthy => js_to_string(value),
        _ => String::new(),
    }
}

// html-parser の IHtmlNode。children は nesting のときだけ Some (見出し、ul / ol、li)
struct HtmlNode {
    tag: Option<BlockTag>,
    html: String,
    children: Option<Vec<usize>>,
    children_level: u8,
    lines: Option<(usize, usize)>,
    /// `ol > li` の番号 (data の listIndex)
    list_index: Option<usize>,
    comments: Vec<String>,
    parts: Vec<ContentPart>,
}

// addChild の引数 (原文の props)
struct ChildProps {
    nesting: bool,
    tag: BlockTag,
    level: u8,
    html: String,
    comments: Vec<String>,
    lines: Option<(usize, usize)>,
    list_index: Option<usize>,
    parts: Vec<ContentPart>,
}

// parseHtml の中の状態 (rootNode は nodes の 0 番、headingStack)。
// skippingHeading は、規則を持たない見出しの要素でだけ立つので、既定の規則 (h1〜h6 はすべて規則を持つ) では立たない。写さない
struct Builder<'t, 'a, 's> {
    tokens: &'t Tokens<'a, 's>,
    nodes: Vec<HtmlNode>,
    /// 見出しのノードの添字と level
    heading_stack: Vec<(usize, u8)>,
}

impl<'a> Builder<'_, 'a, '_> {
    // 原文: addChild。親の children の level は最初に来た子で決まり、より小さい level の子が来たら children を捨てて作り直す
    fn add_child(&mut self, parent: usize, props: ChildProps) -> usize {
        let id = self.nodes.len();
        let level = props.level;
        self.nodes.push(HtmlNode {
            tag: Some(props.tag),
            html: props.html,
            children: props.nesting.then(Vec::new),
            children_level: LEVEL_NONE,
            lines: props.lines,
            list_index: props.list_index,
            comments: props.comments,
            parts: props.parts,
        });
        // TODO(port): Rust 側の不到達 (parent は nodes の添字なので get_mut は必ず Some)
        if let Some(parent) = self.nodes.get_mut(parent)
            && let Some(children) = parent.children.as_mut()
        {
            if parent.children_level == LEVEL_NONE || parent.children_level > level {
                children.clear();
                parent.children_level = level;
            }
            if parent.children_level == level {
                children.push(id);
            }
        }
        id
    }

    // 原文: getCurrentHeading。自分より level が小さい直近の見出し、なければルート
    fn current_heading(&mut self, level: u8) -> usize {
        while let Some(&(top, top_level)) = self.heading_stack.last() {
            if top_level >= level {
                self.heading_stack.pop();
            } else {
                return top;
            }
        }
        0
    }

    // 原文: checkNodes。DOM の要素の並びの代わりに AST のブロックの並びを見る。node は入れ子のリストを読むときの親の li
    fn check_nodes(&mut self, children: Vec<&'a AstNode<'a>>, node: Option<usize>) {
        for child in children {
            let value = child.data().value.clone();
            match value {
                // 'div,p' の規則: 包み。子の要素のうち `p>img:only-child` だけがノードになる (ほかの要素は規則を持たず捨てられる)。
                // data は最も近い p のもの (`$child.closest('p').data()`)
                NodeValue::Paragraph => {
                    let Some(image) = self.image_only(child) else {
                        continue;
                    };
                    let parent = self.parent_of(node, LEVEL_BLOCK);
                    let props = ChildProps {
                        nesting: false,
                        tag: BlockTag::Img,
                        level: LEVEL_BLOCK,
                        html: trim_end_ascii(&self.tokens.render_inline(image)).to_string(),
                        comments: Vec::new(),
                        lines: self.tokens.map_of_node(child),
                        list_index: None,
                        parts: Vec::new(),
                    };
                    self.add_child(parent, props);
                }
                // 'h1,...,h6' の規則: getContent($node.contents())
                NodeValue::Heading(heading) => {
                    // TODO(port): Rust 側の不到達 (トークンの列は見出しの区間を必ず持つ)
                    let Some((open, _)) = self.tokens.range_of(child) else {
                        continue;
                    };
                    let inline = self.tokens.toks.get(open + 1);
                    let html = inline
                        .map(|tok| trim_end_ascii(&tok.content).to_string())
                        .unwrap_or_default();
                    let comments = inline.map(|tok| tok.comments.clone()).unwrap_or_default();
                    let level = heading.level;
                    let parent = self.parent_of(node, level);
                    let props = ChildProps {
                        nesting: true,
                        tag: BlockTag::Heading(level),
                        level,
                        html,
                        comments,
                        lines: self.tokens.map_of_node(child),
                        list_index: None,
                        parts: Vec::new(),
                    };
                    let id = self.add_child(parent, props);
                    self.heading_stack.push((id, level));
                }
                // 'ul,ol' の規則: 中身のない容器のノードで、子の li を読む
                NodeValue::List(list) => {
                    let parent = self.parent_of(node, LEVEL_LIST);
                    let ordered = list.list_type == ListType::Ordered;
                    let props = ChildProps {
                        nesting: true,
                        tag: if ordered { BlockTag::Ol } else { BlockTag::Ul },
                        level: LEVEL_LIST,
                        html: String::new(),
                        comments: Vec::new(),
                        lines: self.tokens.map_of_node(child),
                        list_index: None,
                        parts: Vec::new(),
                    };
                    let id = self.add_child(parent, props);
                    for item in child.children() {
                        self.check_item(item, id, ordered, list.start);
                    }
                }
                // 'table,pre' の規則: getContent($node) (要素そのものの HTML)
                NodeValue::Table(_) | NodeValue::CodeBlock(_) => {
                    // TODO(port): Rust 側の不到達 (トークンの列は表とコードの区間を必ず持つ)
                    let Some((open, close)) = self.tokens.range_of(child) else {
                        continue;
                    };
                    let tag = if matches!(value, NodeValue::Table(_)) {
                        BlockTag::Table
                    } else {
                        BlockTag::Pre
                    };
                    let parent = self.parent_of(node, LEVEL_BLOCK);
                    let props = ChildProps {
                        nesting: false,
                        tag,
                        level: LEVEL_BLOCK,
                        html: trim_end_ascii(&self.tokens.render_range(open, close + 1))
                            .to_string(),
                        comments: Vec::new(),
                        lines: self.tokens.map_of_node(child),
                        list_index: None,
                        parts: Vec::new(),
                    };
                    self.add_child(parent, props);
                }
                // blockquote と hr は規則を持たないので捨てる (中も読まない)。
                // 生の HTML ブロックの中の要素 (`<h2>`、`<ul>`、`<table>` など) は DOM ではノードになるが、AST では 1 つの HtmlBlock なので拾わない。見出しを含むときは html-heading-ignored の警告を出す (A-112。accepted.md の 16、28 (1))
                _ => {}
            }
        }
    }

    fn parent_of(&mut self, node: Option<usize>, level: u8) -> usize {
        match node {
            Some(node) => node,
            None => self.current_heading(level),
        }
    }

    // `p>img:only-child`: 段落の子の要素が画像 1 つだけ (文字とコメントは要素でない)。生の HTML で書いた `<img ...>` も img の要素
    fn image_only(&self, paragraph: &'a AstNode<'a>) -> Option<&'a AstNode<'a>> {
        let elements = self.tokens.element_children(paragraph);
        let [only] = elements.as_slice() else {
            return None;
        };
        let is_img = match &only.data().value {
            NodeValue::Image(_) => true,
            NodeValue::HtmlInline(literal) => is_img_tag(literal),
            _ => false,
        };
        is_img.then_some(*only)
    }

    // li の規則: 内容は入れ子の ul / ol より前の contents (最初の子が div / p なら最初の子。markdown-it の出力では `<li>` の直後に
    // 改行か文字が来るので、この分岐には入らない)。子は入れ子の ul / ol すべて。`ol > li` は内容の前に番号を付ける
    fn check_item(&mut self, item: &'a AstNode<'a>, list: usize, ordered: bool, start: usize) {
        // TODO(port): Rust 側の不到達 (トークンの列は項目の区間を必ず持つ)
        let Some((open, close)) = self.tokens.range_of(item) else {
            return;
        };
        let nested: Vec<&'a AstNode<'a>> = item
            .children()
            .filter(|child| matches!(child.data().value, NodeValue::List(_)))
            .collect();
        let stop = nested
            .first()
            .and_then(|first| self.tokens.range_of(first))
            .map(|(first_open, _)| first_open)
            .unwrap_or(close);
        // `<li>` の直後の改行 (renderToken の needLf) は、DOM では li の最初の文字のノードになる
        let lead = if self.tokens.open_needs_lf(open) {
            "\n"
        } else {
            ""
        };
        let mut html = trim_end_ascii(&format!(
            "{lead}{}",
            self.tokens.render_range(open + 1, stop)
        ))
        .to_string();
        let comments = self.tokens.comments_in(open + 1, stop);
        let mut list_index = None;
        let mut number = String::new();
        if ordered {
            // TODO(port): Rust 側の不到達 (list は nodes の添字で、ul / ol は children を持つ)
            let count = self
                .nodes
                .get(list)
                .and_then(|node| node.children.as_ref())
                .map(Vec::len)
                .unwrap_or(0);
            // `+($child.parent().attr('start') || 1)`: start 属性は 1 でないときだけ付くので、comrak の start と同じ
            let index = start + count;
            number = format!("{index}. ");
            html = format!("{number}{html}");
            list_index = Some(index);
        }
        let parts = self.content_parts(item, open + 1, stop, &format!("{number}{lead}"));
        let props = ChildProps {
            nesting: true,
            tag: BlockTag::Li,
            level: LEVEL_LIST_ITEM,
            html,
            comments,
            lines: self.tokens.map_of_node(item),
            list_index,
            parts,
        };
        let id = self.add_child(list, props);
        self.check_nodes(nested, Some(id));
    }

    // 項目の内容 (トークンの区間 [from, stop)) を、項目の直下の引用ブロックの前後で分ける。引用ブロックは入れ子のリストより前のものだけが内容に入る。
    // DOM の `:scope > blockquote[data-lines]` にあたるのは Markdown の引用ブロックだけ (生の HTML の blockquote は data-lines を持たない)。
    // head は内容の先頭に付く文字 (`ol > li` の番号と `<li>` の直後の改行)。引用ブロックがなければ空
    // 閉じていない生の HTML (`<div>` だけの行など) のあとの引用ブロックが DOM でその要素の中に入るかは、詳細の切り分けの側が見る
    fn content_parts(
        &self,
        item: &'a AstNode<'a>,
        from: usize,
        stop: usize,
        head: &str,
    ) -> Vec<ContentPart> {
        let quotes: Vec<(usize, usize)> = item
            .children()
            .take_while(|child| !matches!(child.data().value, NodeValue::List(_)))
            .filter(|child| matches!(child.data().value, NodeValue::BlockQuote))
            .filter_map(|child| self.tokens.range_of(child))
            .collect();
        if quotes.is_empty() {
            return Vec::new();
        }
        let mut parts = Vec::with_capacity(quotes.len() * 2 + 1);
        let mut outside = head.to_string();
        let mut cursor = from;
        for (open, close) in quotes {
            outside.push_str(&self.tokens.render_range(cursor, open));
            parts.push(ContentPart::Html(std::mem::take(&mut outside)));
            parts.push(ContentPart::Quote {
                open: self.tokens.render_range(open, open + 1),
                inner: self.tokens.render_range(open + 1, close),
                close: self.tokens.render_range(close, close + 1),
            });
            cursor = close + 1;
        }
        outside.push_str(&self.tokens.render_range(cursor, stop));
        parts.push(ContentPart::Html(outside));
        parts
    }

    // 原文: convertNode。payload は data (data-lines と listIndex) があるときだけ付き、tag はその中。fold は comments から
    fn convert_node(&self, id: usize) -> OutlineTree {
        let Some(node) = self.nodes.get(id) else {
            // TODO(port): Rust 側の不到達 (children の添字は nodes に必ずある)
            return OutlineTree {
                content: String::new(),
                children: Vec::new(),
                tag: None,
                lines: None,
                fold: 0,
                parts: Vec::new(),
            };
        };
        let children = node
            .children
            .as_ref()
            .map(|children| {
                children
                    .iter()
                    .map(|&child| self.convert_node(child))
                    .collect()
            })
            .unwrap_or_default();
        let has_data = node.lines.is_some() || node.list_index.is_some();
        let fold = if node.comments.iter().any(|comment| comment == "foldAll") {
            2
        } else if node.comments.iter().any(|comment| comment == "fold") {
            1
        } else {
            0
        };
        OutlineTree {
            content: node.html.clone(),
            children,
            tag: if has_data { node.tag } else { None },
            lines: node.lines.map(|(start, end)| LineRange {
                start: to_u32(start),
                end: to_u32(end),
            }),
            fold,
            parts: node.parts.clone(),
        }
    }
}

// 生の HTML の開きのタグが img か (DOM の tagName は大文字と小文字を区別しない)
fn is_img_tag(literal: &str) -> bool {
    let Some(rest) = literal.strip_prefix('<') else {
        return false;
    };
    let name: String = rest
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    name.eq_ignore_ascii_case("img")
}

// 原文: markmap-lib の cleanNode。内容が空で子が 1 つなら子に置き換え、子が 1 つでその内容が空なら孫を子にする (子が 2 つ以上の空の包みは残る)
fn clean_node(mut node: OutlineTree) -> OutlineTree {
    while node.content.is_empty()
        && node.children.len() == 1
        && let Some(child) = node.children.pop()
    {
        node = child;
    }
    while node.children.len() == 1
        && let Some(child) = node.children.pop_if(|child| child.content.is_empty())
    {
        node.children = child.children;
    }
    node.children = node.children.into_iter().map(clean_node).collect();
    node
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use serde_json::{Value, json};

    fn tag_name(tag: BlockTag) -> String {
        match tag {
            BlockTag::Heading(level) => format!("h{level}"),
            BlockTag::Ul => "ul".to_string(),
            BlockTag::Ol => "ol".to_string(),
            BlockTag::Li => "li".to_string(),
            BlockTag::Table => "table".to_string(),
            BlockTag::Pre => "pre".to_string(),
            BlockTag::Img => "img".to_string(),
        }
    }

    // 旧実装の木 (markmap-lib の transform の root) と同じ形の JSON: content、tag、lines (「開始,終了」の文字)、fold、children
    fn shape(node: &OutlineTree) -> Value {
        json!({
            "content": node.content,
            "tag": node.tag.map(tag_name),
            "lines": node.lines.as_ref().map(|lines| format!("{},{}", lines.start, lines.end)),
            "fold": node.fold,
            "children": node.children.iter().map(shape).collect::<Vec<_>>(),
        })
    }

    fn outline_of(body: &str) -> Value {
        let arena = Arena::new();
        shape(&build_outline(&arena, body, 0, None).root)
    }

    // `---` で囲んだ `キー: 値` だけの frontmatter を切り取り、その行数と値を渡す (frontmatter の読み取りは document の仕事なので、試験では最小の形だけ)
    fn outline_with_frontmatter(source: &str) -> Value {
        let rest = source.strip_prefix("---\n").unwrap_or(source);
        let (yaml, body) = rest.split_once("\n---\n").unwrap_or(("", rest));
        let mut map = IndexMap::new();
        for line in yaml.lines() {
            if let Some((key, value)) = line.split_once(": ") {
                map.insert(key.to_string(), JsValue::String(value.to_string()));
            }
        }
        let lines = yaml.lines().count() + 2;
        let arena = Arena::new();
        shape(&build_outline(&arena, body, lines, Some(&JsValue::Object(map))).root)
    }

    fn parse(expected: &str) -> Value {
        serde_json::from_str(expected).unwrap()
    }

    // 以下の expected は、同じ原文を node の markmap-lib 0.18.12 の Transformer (数式とコードの色付けのプラグインを除いたもの) に通した root を
    // 同じ形に直して取った。cheerio が非 ASCII を数値の文字参照にする差 (決定済みの差) だけは戻してある

    // 見出しは自分より浅い直近の見出しの子になる (h1 の下の h3 と h2 は兄弟)
    #[test]
    fn outline_nests_by_heading_depth() {
        let expected = r##"{"content": "", "tag": null, "lines": null, "fold": 0, "children": [{"content": "A", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "B", "tag": "h2", "lines": "4,5", "fold": 0, "children": []}]}, {"content": "D", "tag": "h1", "lines": "6,7", "fold": 0, "children": []}]}"##;
        assert_eq!(outline_of("# A\n\n### C\n\n## B\n\n# D\n"), parse(expected));
    }

    // 内容の空のルートは、子が 1 つならその子に置き換わる (cleanNode)
    #[test]
    fn outline_single_root_heading_replaces_empty_root() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "a", "tag": "h2", "lines": "2,3", "fold": 0, "children": [{"content": "b", "tag": "h3", "lines": "4,5", "fold": 0, "children": []}]}]}"##;
        assert_eq!(outline_of("# R\n\n## a\n\n### b\n"), parse(expected));
    }

    // 最後の項目は後に続く空行まで、リストの容器のノードは子が 1 つなので畳まれる
    #[test]
    fn outline_nests_lists_and_counts_trailing_blank_lines() {
        let expected = r##"{"content": "A", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "a", "tag": "li", "lines": "2,3", "fold": 0, "children": []}, {"content": "b", "tag": "li", "lines": "3,7", "fold": 0, "children": [{"content": "c", "tag": "li", "lines": "4,7", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of("# A\n\n- a\n- b\n  - c\n\n\ntext"),
            parse(expected)
        );
    }

    // ゆるい項目は <li> の直後の改行と <p> ごとが内容になる
    #[test]
    fn outline_loose_item_keeps_paragraph_and_leading_newline() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "\n<p data-lines=\"2,3\">a</p>", "tag": "li", "lines": "2,4", "fold": 0, "children": []}, {"content": "\n<p data-lines=\"4,5\">b</p>", "tag": "li", "lines": "4,8", "fold": 0, "children": [{"content": "c", "tag": "li", "lines": "5,8", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of("# R\n\n- a\n\n- b\n  - c\n\n\ntext"),
            parse(expected)
        );
    }

    // li の内容は最初の入れ子のリストより前まで。入れ子のリストが 2 つなら空の容器のノードが残る
    #[test]
    fn outline_item_content_stops_before_nested_list() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "\n<p data-lines=\"2,4\">a<br>\nline2</p>", "tag": "li", "lines": "2,9", "fold": 0, "children": [{"content": "", "tag": "ul", "lines": "4,7", "fold": 0, "children": [{"content": "b", "tag": "li", "lines": "4,5", "fold": 0, "children": []}, {"content": "c", "tag": "li", "lines": "5,7", "fold": 0, "children": []}]}, {"content": "d", "tag": "li", "lines": "8,9", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of("# R\n\n- a\n  line2\n  - b\n  - c\n\n  after\n  - d\n"),
            parse(expected)
        );
    }

    // 表、フェンス (言語なし / あり)、字下げのコード、画像だけの段落は Block のノード。引用、区切り線、文字の段落は捨てる
    #[test]
    fn outline_blocks_become_block_nodes() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "<table data-lines=\"2,5\">\n<thead data-lines=\"2,3\">\n<tr data-lines=\"2,3\">\n<th style=\"text-align:left\">a</th>\n<th style=\"text-align:right\">b</th>\n</tr>\n</thead>\n<tbody data-lines=\"4,5\">\n<tr data-lines=\"4,5\">\n<td style=\"text-align:left\">1</td>\n<td style=\"text-align:right\">2</td>\n</tr>\n</tbody>\n</table>", "tag": "table", "lines": "2,5", "fold": 0, "children": []}, {"content": "<pre data-lines=\"6,9\"><code data-lines=\"6,9\">code\n</code></pre>", "tag": "pre", "lines": "6,9", "fold": 0, "children": []}, {"content": "<pre data-lines=\"10,13\"><code class=\"language-js\">x &lt; y\n</code></pre>", "tag": "pre", "lines": "10,13", "fold": 0, "children": []}, {"content": "<pre data-lines=\"14,15\"><code>indented\n</code></pre>", "tag": "pre", "lines": "14,15", "fold": 0, "children": []}, {"content": "<img src=\"a.png\" alt=\"alt em\" title=\"t\">", "tag": "img", "lines": "16,17", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of(
                "# R\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n```\ncode\n```\n\n```js\nx < y\n```\n\n    indented\n\n![alt *em*](a.png \"t\")\n\n> quote\n\n---\n\ntext only\n"
            ),
            parse(expected)
        );
    }

    // 文字は要素でないので画像は only-child。改行 (<br>) は要素なので only-child でない。生の <img> も img
    #[test]
    fn outline_image_with_text_is_only_child_but_break_is_not() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "a", "tag": "h2", "lines": "2,3", "fold": 0, "children": [{"content": "<img src=\"a.png\" alt=\"x\">", "tag": "img", "lines": "4,5", "fold": 0, "children": []}]}, {"content": "b", "tag": "h2", "lines": "6,7", "fold": 0, "children": [{"content": "<img src=\"x.png\">", "tag": "img", "lines": "11,12", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of(
                "# R\n\n## a\n\nsee ![x](a.png) here\n\n## b\n\n![x](a.png)\nnext\n\nline <img src=\"x.png\">\n"
            ),
            parse(expected)
        );
    }

    // alt は renderInlineAsText (インラインのコードは飛ばし、HTML は content を足す)
    #[test]
    fn outline_image_alt_skips_inline_code_like_markdown_it() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "<img src=\"x.png\" alt=\"a  c &lt;i&gt;d&lt;/i&gt;\" title=\"t\">", "tag": "img", "lines": "2,3", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of("# R\n\n![a `b` *c* <i>d</i>](x.png \"t\")"),
            parse(expected)
        );
    }

    // 表のあとのリストは捨てられ (level が大きい)、見出しより前の画像は見出しが来ると捨てられる (level が小さい子で作り直す)
    #[test]
    fn outline_first_child_level_wins_and_smaller_level_resets() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "2,3", "fold": 0, "children": [{"content": "kept", "tag": "h2", "lines": "10,11", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of("![x](a.png)\n\n# R\n\n| a |\n|---|\n| b |\n\n- lost\n\n## kept\n"),
            parse(expected)
        );
    }

    // magic comment は見出しと詰まった項目の最上位のコメントだけ。ゆるい項目の段落の中のコメントは取り出さない
    #[test]
    fn outline_fold_magic_comment_on_heading_and_items() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "a", "tag": "h2", "lines": "2,3", "fold": 1, "children": [{"content": "\n<p data-lines=\"4,5\">b <!-- markmap: foldAll --></p>", "tag": "li", "lines": "4,5", "fold": 0, "children": []}, {"content": "\n<p data-lines=\"5,6\">c</p>", "tag": "li", "lines": "5,7", "fold": 1, "children": []}, {"content": "\n<p data-lines=\"7,8\">d</p>\n<p data-lines=\"9,10\">e <!-- markmap: fold --></p>", "tag": "li", "lines": "7,10", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of(
                "# R\n\n## a <!-- markmap: fold -->\n\n- b <!-- markmap: foldAll -->\n- c\n  <!-- markmap: fold -->\n- d\n\n  e <!-- markmap: fold -->\n"
            ),
            parse(expected)
        );
    }

    // ol > li は開始の番号 + それまでの項目の数を内容の前に付ける
    #[test]
    fn outline_ordered_list_numbers_from_start() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "3. \n<p data-lines=\"2,3\">a</p>", "tag": "li", "lines": "2,3", "fold": 0, "children": []}, {"content": "4. \n<p data-lines=\"3,4\">b</p>", "tag": "li", "lines": "3,7", "fold": 0, "children": [{"content": "0. c", "tag": "li", "lines": "5,6", "fold": 0, "children": []}, {"content": "1. d", "tag": "li", "lines": "6,7", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of("# R\n\n3. a\n4. b\n\n   0. c\n   1. d\n"),
            parse(expected)
        );
    }

    // data-lines に frontmatter の行数を足し、ルートの内容が空なら title で補う
    #[test]
    fn outline_lines_add_frontmatter_lines_and_title_fills_empty_root() {
        let expected = r##"{"content": "T", "tag": "ul", "lines": "3,5", "fold": 0, "children": [{"content": "a", "tag": "li", "lines": "3,4", "fold": 0, "children": []}, {"content": "b", "tag": "li", "lines": "4,5", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_with_frontmatter("---\ntitle: T\n---\n- a\n- b\n"),
            parse(expected)
        );
    }

    // checkbox は原文の [ ] / [x] を見る (エスケープと大文字は絵にならない)
    #[test]
    fn outline_checkbox_follows_source_not_rendered_text() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z\"/></svg> second", "tag": "h2", "lines": "2,3", "fold": 0, "children": []}, {"content": "[ ] escaped", "tag": "h2", "lines": "4,5", "fold": 0, "children": [{"content": "[ ] esc item", "tag": "li", "lines": "6,7", "fold": 0, "children": []}, {"content": "<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm3.3 12.6 7.1-7.1-1.4-1.4-5.7 5.7-2.6-2.6-1.4 1.4z\"/></svg> done item", "tag": "li", "lines": "7,8", "fold": 0, "children": []}, {"content": "[X] upper", "tag": "li", "lines": "8,9", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of(
                "# R\n\n## [ ] second\n\n## \\[ ] escaped\n\n- \\[ ] esc item\n- [x] done item\n- [X] upper\n"
            ),
            parse(expected)
        );
    }

    // [x]: url の定義があっても原文の [x] は絵になる
    #[test]
    fn outline_checkbox_wins_over_link_reference() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "2,3", "fold": 0, "children": [{"content": "<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm3.3 12.6 7.1-7.1-1.4-1.4-5.7 5.7-2.6-2.6-1.4 1.4z\"/></svg> linked", "tag": "li", "lines": "4,5", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of("[x]: http://e.com\n\n# R\n\n- [x] linked\n"),
            parse(expected)
        );
    }

    // validateLink が拒む URL はリンクにならない (data: の画像は通す)
    #[test]
    fn outline_rejected_links_stay_as_text() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "[x](javascript:alert(1)) y", "tag": "li", "lines": "2,3", "fold": 0, "children": []}, {"content": "<a href=\"data:image/png;base64,AA\">z</a> w", "tag": "li", "lines": "3,4", "fold": 0, "children": []}, {"content": "[q](file:///etc) v", "tag": "li", "lines": "4,5", "fold": 0, "children": []}, {"content": "[<em>a</em>](javascript:x &quot;t&quot;) y", "tag": "li", "lines": "5,6", "fold": 0, "children": []}, {"content": "&lt;javascript:alert(1)&gt; z", "tag": "li", "lines": "6,7", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of(
                "# R\n\n- [x](javascript:alert(1)) y\n- [z](data:image/png;base64,AA) w\n- [q](file:///etc) v\n- [*a*](javascript:x \"t\") y\n- <javascript:alert(1)> z\n"
            ),
            parse(expected)
        );
    }

    // href は normalizeLink (punycode と百分率符号化)
    #[test]
    fn outline_links_are_normalized() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "<a href=\"http://x.com\" title=\"T\">a</a> <a href=\"/rel?q=1&amp;r=2#h\">b</a> <a href=\"./a%20b.md\">c</a>", "tag": "li", "lines": "2,3", "fold": 0, "children": []}, {"content": "<img src=\"http://xn--Bcher-kva.de/x.png\" alt=\"ã\">", "tag": "li", "lines": "3,4", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of(
                "# R\n\n- [a](http://x.com \"T\") [b](/rel?q=1&r=2#h) [c](<./a b.md>)\n- ![ã](http://Bücher.de/x.png)\n"
            ),
            parse(expected)
        );
    }

    // \r だけの改行も行の区切り (markdown-it の NEWLINES_RE)
    #[test]
    fn outline_lone_carriage_return_is_a_line_break() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "a", "tag": "li", "lines": "1,2", "fold": 0, "children": []}, {"content": "b", "tag": "li", "lines": "2,4", "fold": 0, "children": []}]}"##;
        assert_eq!(outline_of("# R\r- a\r- b\r\rtext"), parse(expected));
    }

    // 項目の中の見出しは内容の HTML に残る (ノードにならない)
    #[test]
    fn outline_item_with_heading_keeps_heading_html() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "\n<h1 data-lines=\"2,3\">H in li</h1>", "tag": "li", "lines": "2,3", "fold": 0, "children": []}, {"content": "b", "tag": "li", "lines": "3,4", "fold": 0, "children": []}]}"##;
        assert_eq!(outline_of("# R\n\n- # H in li\n- b\n"), parse(expected));
    }

    // 見出しのない文書の 2 つのリストは空の容器のノードとして残る
    #[test]
    fn outline_multiple_lists_leave_empty_wrapper() {
        let expected = r##"{"content": "", "tag": null, "lines": null, "fold": 0, "children": [{"content": "a", "tag": "li", "lines": "0,2", "fold": 0, "children": []}, {"content": "1. b", "tag": "li", "lines": "4,5", "fold": 0, "children": []}]}"##;
        assert_eq!(outline_of("- a\n\ntext\n\n1. b\n"), parse(expected));
    }

    // 引用の中のリストの最後の項目は、> だけの行を空行として含む
    #[test]
    fn outline_list_in_blockquote_counts_quoted_blank_lines() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "a\n<blockquote data-lines=\"3,6\">\n<ul data-lines=\"3,5\">\n<li data-lines=\"3,5\">q</li>\n</ul>\n<p data-lines=\"5,6\">text</p>\n</blockquote>", "tag": "li", "lines": "2,6", "fold": 0, "children": []}, {"content": "b", "tag": "li", "lines": "6,8", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of("# R\n\n- a\n  > - q\n  >\n  > text\n- b\n\n> - x\n>\n> y\n"),
            parse(expected)
        );
    }

    // ==、++、~、^、~~ は mark / ins / sub / sup / s。改行は <br>
    #[test]
    fn outline_inline_marks_and_breaks() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "<mark>m</mark> <ins>i</ins> <sub>s</sub> <sup>p</sup> <s>d</s> <code>c&lt;</code> a&amp;b", "tag": "li", "lines": "2,3", "fold": 0, "children": []}, {"content": "x<br>\ny<br>\nz", "tag": "li", "lines": "3,6", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of("# R\n\n- ==m== ++i++ ~s~ ^p^ ~~d~~ `c<` a&amp;b\n- x  \n  y\\\n  z\n"),
            parse(expected)
        );
    }

    // 字下げのコードの行の範囲は最後の空でない行まで
    #[test]
    fn outline_indented_code_excludes_trailing_blank_lines() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "<pre data-lines=\"2,3\"><code>code\n</code></pre>", "tag": "pre", "lines": "2,3", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of("# R\n\n    code\n\n\n\n- after\n"),
            parse(expected)
        );
    }

    // CRLF の文書の行番号と表
    #[test]
    fn outline_crlf_lines_and_table() {
        let expected = r##"{"content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [{"content": "<table data-lines=\"5,8\">\n<thead data-lines=\"5,6\">\n<tr data-lines=\"5,6\">\n<th>x</th>\n</tr>\n</thead>\n<tbody data-lines=\"7,8\">\n<tr data-lines=\"7,8\">\n<td>y</td>\n</tr>\n</tbody>\n</table>", "tag": "table", "lines": "5,8", "fold": 0, "children": []}]}"##;
        assert_eq!(
            outline_of("# R\r\n\r\n- a\r\n- b\r\n\r\n| x |\r\n|---|\r\n| y |\r\n"),
            parse(expected)
        );
    }

    // 下線の見出しは下線の行まで
    #[test]
    fn outline_setext_headings() {
        let expected = r##"{"content": "Title", "tag": "h1", "lines": "0,2", "fold": 0, "children": [{"content": "Sub", "tag": "h2", "lines": "3,5", "fold": 0, "children": [{"content": "a", "tag": "li", "lines": "6,7", "fold": 0, "children": []}]}]}"##;
        assert_eq!(
            outline_of("Title\n=====\n\nSub\n---\n\n- a\n"),
            parse(expected)
        );
    }

    #[test]
    fn outline_title_uses_js_truthiness_and_string_conversion() {
        let with_title = |value: JsValue| {
            let mut map = IndexMap::new();
            map.insert("title".to_string(), value);
            title_of(Some(&JsValue::Object(map)))
        };
        assert_eq!(with_title(JsValue::Number(12.0)), "12");
        assert_eq!(with_title(JsValue::Number(0.0)), "");
        assert_eq!(with_title(JsValue::Number(f64::NAN)), "");
        assert_eq!(with_title(JsValue::Bool(true)), "true");
        assert_eq!(with_title(JsValue::String(String::new())), "");
        assert_eq!(
            with_title(JsValue::Array(vec![
                JsValue::String("a".to_string()),
                JsValue::String("b".to_string())
            ])),
            "a,b"
        );
        assert_eq!(title_of(Some(&JsValue::String("title".to_string()))), "");
        assert_eq!(title_of(None), "");
    }

    #[test]
    fn outline_features_report_math_and_code() {
        let arena = Arena::new();
        let outline = build_outline(&arena, "# R\n\n- $x$\n", 0, None);
        assert_eq!(
            outline.features,
            ParsedFeatures {
                math: true,
                code: false
            }
        );
        let arena = Arena::new();
        let outline = build_outline(&arena, "# R\n\n```\nx\n```\n", 0, None);
        assert_eq!(
            outline.features,
            ParsedFeatures {
                math: false,
                code: true
            }
        );
        // 字下げのコードは highlight を通らないので、コードの印は立たない (node の Transformer の features は {})
        let arena = Arena::new();
        let outline = build_outline(&arena, "# R\n\n    x\n", 0, None);
        assert_eq!(
            outline.features,
            ParsedFeatures {
                math: false,
                code: false
            }
        );
    }

    #[test]
    fn outline_math_is_marked_not_rendered() {
        // 決定 2: 数式は KaTeX でなく印の要素にする (旧実装との決定済みの差)
        let expected = json!({ "content": "R", "tag": "h1", "lines": "0,1", "fold": 0, "children": [
            { "content": "a <span class=\"mdag-math\">x</span> b", "tag": "li", "lines": "2,3", "fold": 0, "children": [] }
        ]});
        assert_eq!(outline_of("# R\n\n- a $x$ b\n"), expected);
    }

    #[test]
    fn outline_empty_body_is_empty_root() {
        let expected =
            json!({ "content": "", "tag": null, "lines": null, "fold": 0, "children": [] });
        assert_eq!(outline_of(""), expected);
    }
    // markdown-it は本文の `\r\n` と `\r` を `\n` に、NUL を U+FFFD にしてから読む (コードとコードスパンの中にも `\r` が残らない)。行の範囲は変わらない
    #[test]
    fn outline_newlines_and_nul_are_normalized_like_markdown_it() {
        let expected = r##"{"content":"R","tag":"h1","lines":"0,1","fold":0,"children":[{"content":"<pre data-lines=\"2,6\"><code data-lines=\"2,6\">a\nb\n</code></pre>","tag":"pre","lines":"2,6","fold":0,"children":[]}]}"##;
        assert_eq!(
            outline_of("# R\r\n\r\n```\r\na\r\nb\r\n```\r\n"),
            parse(expected)
        );
        let expected = r##"{"content":"<pre data-lines=\"0,4\"><code data-lines=\"0,4\">x\ny\n</code></pre>","tag":"pre","lines":"0,4","fold":0,"children":[]}"##;
        assert_eq!(outline_of("```\rx\ry\r```"), parse(expected));
        let expected = r##"{"content":"","tag":"ul","lines":"0,3","fold":0,"children":[{"content":"<code>a b</code>","tag":"li","lines":"0,2","fold":0,"children":[]},{"content":"c\u{FFFD}d","tag":"li","lines":"2,3","fold":0,"children":[]}]}"##;
        assert_eq!(
            outline_of("- `a\r\nb`\r\n- c\u{0}d"),
            parse(&expected.replace("\\u{FFFD}", "\u{FFFD}"))
        );
    }

    // 改行で終わらない最後の行が空白とタブだけなら、markdown-it はその行を数えない (項目の終わりと閉じないフェンスの中身)
    #[test]
    fn outline_blank_last_line_without_newline_is_not_a_line() {
        let expected = r##"{"content":"R","tag":"h1","lines":"0,1","fold":0,"children":[{"content":"a","tag":"li","lines":"2,3","fold":0,"children":[]},{"content":"b","tag":"li","lines":"3,4","fold":0,"children":[]}]}"##;
        assert_eq!(outline_of("# R\n\n- a\n- b\n  "), parse(expected));
        let expected = r##"{"content":"R","tag":"h1","lines":"0,1","fold":0,"children":[{"content":"<pre data-lines=\"2,4\"><code data-lines=\"2,4\">code\n</code></pre>","tag":"pre","lines":"2,4","fold":0,"children":[]}]}"##;
        assert_eq!(outline_of("# R\n\n```\ncode\n  "), parse(expected));
    }

    // trimEnd は cheerio が非 ASCII を文字参照にしたあとの HTML に当たるので、末尾の全角空白や NBSP は残る
    #[test]
    fn outline_trim_end_keeps_non_ascii_whitespace() {
        let expected = "{\"content\":\"a\u{3000}\",\"tag\":\"h1\",\"lines\":\"0,1\",\"fold\":0,\"children\":[{\"content\":\"b\u{a0}\",\"tag\":\"li\",\"lines\":\"1,2\",\"fold\":0,\"children\":[]},{\"content\":\"c\u{2003}\",\"tag\":\"li\",\"lines\":\"2,3\",\"fold\":0,\"children\":[]}]}";
        assert_eq!(
            outline_of("# a\u{3000}\n- b\u{a0} \n- c\u{2003}"),
            parse(expected)
        );
    }

    // 表のセルは JS の trim で切る (全角空白と NBSP も)。文字参照で書いた空白は切らない
    #[test]
    fn outline_table_cells_trim_js_whitespace() {
        let expected = r##"{"content":"<table data-lines=\"0,3\">\n<thead data-lines=\"0,1\">\n<tr data-lines=\"0,1\">\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody data-lines=\"2,3\">\n<tr data-lines=\"2,3\">\n<td><code>c</code></td>\n<td>NBSPdNBSP</td>\n</tr>\n</tbody>\n</table>","tag":"table","lines":"0,3","fold":0,"children":[]}"##;
        assert_eq!(
            outline_of(
                "| \u{3000}a\u{3000} | b\u{a0} |\n|---|---|\n| `c`\u{3000} | &nbsp;d&nbsp; |"
            ),
            parse(&expected.replace("NBSP", "\u{a0}"))
        );
    }

    // `[x] ` の直後が改行 (やハードブレーク) でも絵になり、絵のあとに `<br>` が続く (下線の見出しも同じ)
    #[test]
    fn outline_checkbox_before_line_break() {
        let expected = r##"{"content":"R","tag":"h1","lines":"0,1","fold":0,"children":[{"content":"<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm3.3 12.6 7.1-7.1-1.4-1.4-5.7 5.7-2.6-2.6-1.4 1.4z\"/></svg><br>\nnext","tag":"li","lines":"2,4","fold":0,"children":[]}]}"##;
        assert_eq!(outline_of("# R\n\n- [x] \n  next\n"), parse(expected));
        let expected = r##"{"content":"R","tag":"h1","lines":"0,1","fold":0,"children":[{"content":"<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm3.3 12.6 7.1-7.1-1.4-1.4-5.7 5.7-2.6-2.6-1.4 1.4z\"/></svg><br>\nm","tag":"h2","lines":"2,5","fold":0,"children":[{"content":"<svg width=\"16\" height=\"16\" viewBox=\"0 -3 24 24\"><path fill-rule=\"evenodd\" d=\"M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z\"/></svg><br>\nhard","tag":"li","lines":"5,7","fold":0,"children":[]}]}]}"##;
        assert_eq!(
            outline_of("# R\n\n[x] \nm\n---\n- [ ]  \n  hard"),
            parse(expected)
        );
    }
}

// PORT STATUS: confidence=medium todos=6
