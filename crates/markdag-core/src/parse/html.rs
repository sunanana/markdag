// 原文: node_modules/markdown-it (14.3.2) の lib/renderer.mjs と lib/index.mjs (normalizeLink / validateLink)、mdurl (2.1.0) の parse / format / encode、punycode.js (2.3.1) の toASCII、sample/markmap/packages/markmap-lib/src/plugins/ の source-lines と checkbox (2026-09-24。checkbox の絵は写さず自前で描いた。A-151)
// ノードごとの HTML を書く層。comrak の AST を markdown-it と同じ形のトークンの列に直し、markdown-it の renderer と同じ規則で書き出す。
// markmap-html-parser はこの HTML を DOM にしてから切り分けていたので、改行の入れ方 (renderToken の needLf と、隠れた段落の直後の '\n')、
// 属性の順 (要素固有の属性のあとに data-lines)、文字参照 (& < > " だけ)、void 要素 (`<br>` `<img ...>`) まで写す必要がある。
// アウトラインの組み立ては、ノードごとにこの列の区間を書き出して内容にする (DOM の要素の outerHTML の代わり)。
// リンクの href は markdown-it の normalizeLink (mdurl の parse / format / encode と punycode の toASCII) で直し、validateLink が
// 拒む URL (javascript: など) はリンクにせず原文の文字のまま書く。
use std::collections::HashMap;

use comrak::nodes::{AstNode, LineColumn, ListType, NodeValue, TableAlignment};

use super::inline_marks;
use crate::model::util::{JS_WHITESPACE, js_trim};

// markmap-lib の checkbox プラグインが `[ ] ` と `[x] ` の代わりに書く絵の位置に置く、自前で描いた絵 (A-151)。
// 大きさと viewBox は markmap の絵と同じにして、ノードの測った寸法を変えない。枠は viewBox の 4〜20 の角丸の正方形。
// 解析の層の記号の絵 (未完了と完了、作業中と中止の枠) もこの 2 つから作る
pub(super) const UNMARKED: &str = r#"<svg width="16" height="16" viewBox="0 -3 24 24"><path fill-rule="evenodd" d="M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z"/></svg>"#;
pub(super) const MARKED: &str = r#"<svg width="16" height="16" viewBox="0 -3 24 24"><path fill-rule="evenodd" d="M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zm3.3 12.6 7.1-7.1-1.4-1.4-5.7 5.7-2.6-2.6-1.4 1.4z"/></svg>"#;

/// markdown-it のトークンの種類のうち、この層が作るもの
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Open,
    Close,
    /// ブロックの中のインライン (書き出した HTML を content に持つ)
    Inline,
    Fence,
    CodeBlock,
    HtmlBlock,
    Hr,
}

/// markdown-it の Token のうち、書き出しに使う欄だけを持つもの
#[derive(Debug, Clone)]
pub(super) struct Tok {
    pub(super) kind: Kind,
    pub(super) tag: &'static str,
    pub(super) attrs: Vec<(&'static str, String)>,
    /// token.map (0 始まりの [開始, 終了)。frontmatter の行数を足したもの)
    pub(super) map: Option<(usize, usize)>,
    pub(super) hidden: bool,
    /// Inline は書き出した HTML、Fence と CodeBlock は中身、HtmlBlock は原文
    pub(super) content: String,
    pub(super) info: String,
    /// この段で取り出した magic comment (`<!-- markmap: ... -->` の中身)
    pub(super) comments: Vec<String>,
}

impl Tok {
    fn new(kind: Kind, tag: &'static str) -> Self {
        Tok {
            kind,
            tag,
            attrs: Vec::new(),
            map: None,
            hidden: false,
            content: String::new(),
            info: String::new(),
            comments: Vec::new(),
        }
    }
}

/// AST のノードの同一性 (arena の中の位置)。値の == で比べない (規則 2.3 のオブジェクトの同一性)
pub(super) type NodeKey<'a> = *const AstNode<'a>;

pub(super) fn key_of<'a>(node: &'a AstNode<'a>) -> NodeKey<'a> {
    node
}

/// markdown-it の escapeHtml の写し (`&` `<` `>` `"` だけを文字参照にする)
pub(super) fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// 本文を行に分ける。markdown-it (NEWLINES_RE `/\r\n?|\n/`) と comrak はどちらも `\r\n`、`\r`、`\n` を行の終わりとする。
/// 最後の改行のあとの空の行は数えない (markdown-it の lineMax)
fn split_lines(body: &str) -> Vec<&str> {
    // `\n` で分けた各部分の末尾の `\r` は `\r\n` の一部 (最後の部分なら単独の `\r` で、その後ろの空の行は数えない)
    let mut lines: Vec<&str> = body
        .split('\n')
        .flat_map(|segment| segment.strip_suffix('\r').unwrap_or(segment).split('\r'))
        .collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
}

/// markmap の magic comment の中身 (`<!-- markmap: fold -->` の `fold`)。html-parser の extractMagicComments の写し:
/// コメントの data を trim して `markmap: ` で始まれば、その後ろを trim したもの
pub(super) fn magic_comment(literal: &str) -> Option<String> {
    let data = js_trim(literal).strip_prefix("<!--")?.strip_suffix("-->")?;
    js_trim(data)
        .strip_prefix("markmap: ")
        .map(|rest| js_trim(rest).to_string())
}

/// comrak の AST から作ったトークンの列と、AST のノードからその区間への対応
pub(super) struct Tokens<'a, 's> {
    pub(super) toks: Vec<Tok>,
    /// AST のノード → (開きのトークン, 閉じのトークン)。1 つだけのトークン (フェンスなど) は同じ添字
    ranges: HashMap<NodeKey<'a>, (usize, usize)>,
    /// 本文の行 (frontmatter を除いたもの。comrak の sourcepos の行はこの添字 + 1)
    lines: Vec<&'s str>,
    frontmatter_lines: usize,
}

impl<'a, 's> Tokens<'a, 's> {
    /// 文書の最上位のブロックを順にトークンにする (markdown-it の parse の結果にあたる)
    pub(super) fn build(root: &'a AstNode<'a>, body: &'s str, frontmatter_lines: usize) -> Self {
        let mut tokens = Tokens {
            toks: Vec::new(),
            ranges: HashMap::new(),
            lines: split_lines(body),
            frontmatter_lines,
        };
        for child in root.children() {
            tokens.block(child, false);
        }
        tokens
    }

    pub(super) fn range_of(&self, node: &'a AstNode<'a>) -> Option<(usize, usize)> {
        self.ranges.get(&key_of(node)).copied()
    }

    /// ノードの開きのトークンの map (data-lines に書く行の範囲)
    pub(super) fn map_of_node(&self, node: &'a AstNode<'a>) -> Option<(usize, usize)> {
        let (open, _) = self.range_of(node)?;
        // TODO(port): Rust 側の不到達 (区間の添字は toks に必ずある)
        self.toks.get(open)?.map
    }

    // sourcepos (1 始まり、終了を含む) を token.map (0 始まり、終了を含まない) に直し、frontmatter の行数を足す
    fn map_of(&self, node: &'a AstNode<'a>) -> (usize, usize) {
        let sourcepos = node.data().sourcepos;
        (
            sourcepos.start.line.saturating_sub(1) + self.frontmatter_lines,
            sourcepos.end.line + self.frontmatter_lines,
        )
    }

    fn push(&mut self, tok: Tok) -> usize {
        self.toks.push(tok);
        self.toks.len() - 1
    }

    fn open(&mut self, tag: &'static str, map: Option<(usize, usize)>, hidden: bool) -> usize {
        let mut tok = Tok::new(Kind::Open, tag);
        tok.map = map;
        tok.hidden = hidden;
        self.push(tok)
    }

    fn close(&mut self, tag: &'static str, hidden: bool) -> usize {
        let mut tok = Tok::new(Kind::Close, tag);
        tok.hidden = hidden;
        self.push(tok)
    }

    fn inline_tok(&mut self, html: String, comments: Vec<String>) -> usize {
        let mut tok = Tok::new(Kind::Inline, "");
        tok.content = html;
        tok.comments = comments;
        self.push(tok)
    }

    // tight は「詰まったリストの項目の直下」であること。直下の段落は markdown-it では隠れた段落 (hidden) になる
    fn block(&mut self, node: &'a AstNode<'a>, tight: bool) {
        let in_item = node
            .parent()
            .is_some_and(|parent| matches!(parent.data().value, NodeValue::Item(_)));
        let value = node.data().value.clone();
        match value {
            NodeValue::Paragraph => {
                let map = self.map_of(node);
                let open = self.open("p", Some(map), tight);
                // checkbox プラグインは「項目の最初の段落」だけを見る (直前が paragraph_open、その前が list_item_open)
                let first_in_item = in_item && node.previous_sibling().is_none();
                let mut comments = Vec::new();
                let html = Writer::new(&self.lines).block_inline(
                    node,
                    tight,
                    first_in_item,
                    &mut comments,
                );
                self.inline_tok(html, comments);
                let close = self.close("p", tight);
                self.ranges.insert(key_of(node), (open, close));
            }
            NodeValue::Heading(heading) => {
                let tag = heading_tag(heading.level);
                let map = self.map_of(node);
                let open = self.open(tag, Some(map), false);
                let mut comments = Vec::new();
                let html = Writer::new(&self.lines).block_inline(node, true, true, &mut comments);
                self.inline_tok(html, comments);
                let close = self.close(tag, false);
                self.ranges.insert(key_of(node), (open, close));
            }
            NodeValue::BlockQuote => {
                let map = self.map_of(node);
                let open = self.open("blockquote", Some(map), false);
                for child in node.children() {
                    self.block(child, false);
                }
                let close = self.close("blockquote", false);
                self.ranges.insert(key_of(node), (open, close));
            }
            NodeValue::List(list) => self.list(node, list.list_type, list.start, list.tight),
            NodeValue::CodeBlock(code) => {
                let mut tok = Tok::new(
                    if code.fenced {
                        Kind::Fence
                    } else {
                        Kind::CodeBlock
                    },
                    "code",
                );
                let map = self.map_of(node);
                tok.map = Some(if code.fenced {
                    map
                } else {
                    self.without_trailing_blank_lines(node, map)
                });
                tok.content = code.literal.clone();
                tok.info = code.info.clone();
                let index = self.push(tok);
                self.ranges.insert(key_of(node), (index, index));
            }
            NodeValue::HtmlBlock(block) => {
                let mut tok = Tok::new(Kind::HtmlBlock, "");
                tok.content = block.literal.clone();
                // 項目の直下のコメントだけの HTML ブロックは、li の内容の最上位のコメントになる (extractMagicComments が取り出す)。
                // DOM ではコメントのあとの改行が文字のノードとして残る
                // コメントとほかの要素が混ざった HTML ブロック (`<div></div><!-- markmap: fold -->`) のコメントは取り出さない (A-112。accepted.md の 16)
                if in_item && let Some(comment) = magic_comment(&block.literal) {
                    tok.comments.push(comment);
                    tok.content = "\n".to_string();
                }
                let index = self.push(tok);
                self.ranges.insert(key_of(node), (index, index));
            }
            NodeValue::ThematicBreak => {
                let mut tok = Tok::new(Kind::Hr, "hr");
                tok.map = Some(self.map_of(node));
                let index = self.push(tok);
                self.ranges.insert(key_of(node), (index, index));
            }
            NodeValue::Table(table) => self.table(node, &table.alignments),
            _ => {
                for child in node.children() {
                    self.block(child, tight);
                }
            }
        }
    }

    // markdown-it の list の規則の token.map: 項目の終わりは次の項目の開始行、最後の項目は後に続く空行まで
    // (囲む引用ブロックがあればその終わりまで)。リストは最初の項目の開始から最後の項目の終わりまで
    fn list(&mut self, node: &'a AstNode<'a>, list_type: ListType, start: usize, tight: bool) {
        let tag = if list_type == ListType::Ordered {
            "ol"
        } else {
            "ul"
        };
        let items: Vec<&'a AstNode<'a>> = node.children().collect();
        let mut item_maps = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            let (start_line, end_line) = self.map_of(item);
            let end_line = match items.get(index + 1) {
                Some(next) => self.map_of(next).0,
                None => self.end_with_blank_lines(item, end_line),
            };
            item_maps.push((start_line, end_line));
        }
        let list_map = match (item_maps.first(), item_maps.last()) {
            (Some(first), Some(last)) => (first.0, last.1),
            _ => self.map_of(node),
        };
        let mut open = Tok::new(Kind::Open, tag);
        // markdown-it は順序つきで開始の番号が 1 でないときだけ start を付ける
        if list_type == ListType::Ordered && start != 1 {
            open.attrs.push(("start", start.to_string()));
        }
        open.map = Some(list_map);
        let list_open = self.push(open);
        for (item, map) in items.iter().zip(item_maps) {
            let item_open = self.open("li", Some(map), false);
            for child in item.children() {
                self.block(child, tight);
            }
            let item_close = self.close("li", false);
            self.ranges.insert(key_of(item), (item_open, item_close));
        }
        let list_close = self.close(tag, false);
        self.ranges.insert(key_of(node), (list_open, list_close));
    }

    // 最後の項目の終わり: markdown-it の block.tokenize は項目の中を読んだあと空行を飛ばしてから抜けるので、
    // 後に続く空行を項目に含める。引用ブロックの中では、行頭の `>` を除いて空なら空行で、引用ブロックの終わりを越えない
    fn end_with_blank_lines(&self, item: &'a AstNode<'a>, end_line: usize) -> usize {
        let quote_end = item
            .ancestors()
            .find(|ancestor| matches!(ancestor.data().value, NodeValue::BlockQuote))
            .map(|quote| quote.data().sourcepos.end.line);
        let in_quote = quote_end.is_some();
        let limit = quote_end.unwrap_or(usize::MAX);
        let mut line = end_line.saturating_sub(self.frontmatter_lines);
        while line < limit
            && self
                .lines
                .get(line)
                .is_some_and(|text| is_blank(text, in_quote))
        {
            line += 1;
        }
        line + self.frontmatter_lines
    }

    // markdown-it の code_block の規則の token.map は最後の空でない行まで (comrak の sourcepos は後に続く空行を含む)
    fn without_trailing_blank_lines(
        &self,
        node: &'a AstNode<'a>,
        (start, end): (usize, usize),
    ) -> (usize, usize) {
        let in_quote = node
            .ancestors()
            .any(|ancestor| matches!(ancestor.data().value, NodeValue::BlockQuote));
        let mut end = end;
        while end > start + 1
            && end
                .checked_sub(self.frontmatter_lines + 1)
                .and_then(|line| self.lines.get(line))
                .is_some_and(|text| is_blank(text, in_quote))
        {
            end -= 1;
        }
        (start, end)
    }

    // markdown-it の table の規則: thead は見出しの行、tbody は本体の最初の行から最後の行まで。th と td は map を持たない
    fn table(&mut self, node: &'a AstNode<'a>, alignments: &[TableAlignment]) {
        let rows: Vec<&'a AstNode<'a>> = node.children().collect();
        let map = self.map_of(node);
        let open = self.open("table", Some(map), false);
        let (head, body): (Vec<&'a AstNode<'a>>, Vec<&'a AstNode<'a>>) = rows
            .iter()
            .copied()
            .partition(|row| matches!(row.data().value, NodeValue::TableRow(true)));
        for (section, cell_tag, rows) in [("thead", "th", &head), ("tbody", "td", &body)] {
            let (Some(first), Some(last)) = (rows.first(), rows.last()) else {
                continue;
            };
            let section_map = (self.map_of(first).0, self.map_of(last).1);
            self.open(section, Some(section_map), false);
            for row in rows.iter().copied() {
                self.table_row(node, row, cell_tag, alignments);
            }
            self.close(section, false);
        }
        let close = self.close("table", false);
        self.ranges.insert(key_of(node), (open, close));
    }

    fn table_row(
        &mut self,
        table: &'a AstNode<'a>,
        row: &'a AstNode<'a>,
        cell_tag: &'static str,
        alignments: &[TableAlignment],
    ) {
        let columns = self.row_columns(table, row);
        let map = self.map_of(row);
        self.open("tr", Some(map), false);
        for (index, cell) in row.children().enumerate() {
            let mut open = Tok::new(Kind::Open, cell_tag);
            let align = match alignments.get(index) {
                Some(TableAlignment::Left) => Some("left"),
                Some(TableAlignment::Center) => Some("center"),
                Some(TableAlignment::Right) => Some("right"),
                _ => None,
            };
            if let Some(align) = align {
                open.attrs.push(("style", format!("text-align:{align}")));
            }
            self.push(open);
            let html = Writer::for_row(&self.lines, columns).table_cell(cell);
            self.inline_tok(html, Vec::new());
            self.close(cell_tag, false);
        }
        self.close("tr", false);
    }

    // comrak は本体の行のセルの桁を「表の開始の桁 + 行の中の位置」で付けるので、行の字下げが表の最初の行と違うと桁がずれる。
    // (comrak が付けた開始の桁, 行の最初の空白でない字の桁) を返し、Writer がその差を戻す。
    // 行の最初の空白でない字は、字下げと、表を囲む引用の数だけの `>` とその後ろの空白を除いた後 (comrak の first_nonspace)。見出しの行はずれない
    fn row_columns(&self, table: &'a AstNode<'a>, row: &'a AstNode<'a>) -> (usize, usize) {
        if matches!(row.data().value, NodeValue::TableRow(true)) {
            return (0, 0);
        }
        let quotes = table
            .ancestors()
            .filter(|ancestor| matches!(ancestor.data().value, NodeValue::BlockQuote))
            .count();
        let line = self
            .lines
            .get(row.data().sourcepos.start.line.saturating_sub(1))
            .copied()
            .unwrap_or("");
        let mut rest = line.trim_start_matches([' ', '\t']);
        for _ in 0..quotes {
            match rest.strip_prefix('>') {
                Some(after) => rest = after.trim_start_matches([' ', '\t']),
                None => break,
            }
        }
        (
            table.data().sourcepos.start.column,
            line.len() - rest.len() + 1,
        )
    }

    fn render_attrs(tok: &Tok) -> String {
        let mut out = String::new();
        for (name, value) in &tok.attrs {
            out.push_str(&format!(" {name}=\"{}\"", escape_html(value)));
        }
        // sourceLines プラグインの renderAttrs の包み: block で map のあるトークンに data-lines を足す (要素固有の属性のあと)
        if let Some((start, end)) = tok.map {
            out.push_str(&format!(" data-lines=\"{start},{end}\""));
        }
        out
    }

    /// 開きのトークンの直後に改行を書くか (renderToken の needLf)。次がインラインか隠れたトークン、または同じ要素の閉じなら書かない
    pub(super) fn open_needs_lf(&self, index: usize) -> bool {
        match self.toks.get(index..) {
            Some([tok, next, ..]) => {
                !(next.kind == Kind::Inline
                    || next.hidden
                    || (next.kind == Kind::Close && tok.tag == next.tag))
            }
            _ => true,
        }
    }

    // markdown-it の Renderer.renderToken の写し (すべて block のトークン)
    fn render_token(&self, index: usize, tok: &Tok) -> String {
        if tok.hidden {
            return String::new();
        }
        let closing = tok.kind == Kind::Close;
        let mut out = String::new();
        // 隠れた段落のあとに続く開きのタグの前に改行を入れる
        if !closing && index > 0 && self.toks.get(index - 1).is_some_and(|prev| prev.hidden) {
            out.push('\n');
        }
        out.push_str(if closing { "</" } else { "<" });
        out.push_str(tok.tag);
        if !closing {
            out.push_str(&Self::render_attrs(tok));
        }
        let need_lf = tok.kind != Kind::Open || self.open_needs_lf(index);
        out.push_str(if need_lf { ">\n" } else { ">" });
        out
    }

    fn render_one(&self, index: usize, tok: &Tok) -> String {
        match tok.kind {
            Kind::Inline | Kind::HtmlBlock => tok.content.clone(),
            // markdown-it の code_block の規則: `<pre` + 属性 + `><code>`
            Kind::CodeBlock => format!(
                "<pre{}><code>{}</code></pre>\n",
                Self::render_attrs(tok),
                escape_html(&tok.content)
            ),
            // markdown-it の fence の規則と sourceLines の包み: 言語がなければ code に属性 (data-lines) を付け、pre にも data-lines を挿す。
            // 言語があれば code は class だけ (tmpToken は map を持たないので data-lines が付かない)
            Kind::Fence => {
                let data_lines = tok
                    .map
                    .map(|(start, end)| format!(" data-lines=\"{start},{end}\""))
                    .unwrap_or_default();
                let info = js_trim(&tok.info);
                // `info.split(/(\s+)/g)[0]`
                let lang = info
                    .split_once(|c: char| JS_WHITESPACE.contains(&c))
                    .map_or(info, |(lang, _)| lang);
                if lang.is_empty() {
                    format!(
                        "<pre{data_lines}><code{data_lines}>{}</code></pre>\n",
                        escape_html(&tok.content)
                    )
                } else {
                    format!(
                        "<pre{data_lines}><code class=\"language-{}\">{}</code></pre>\n",
                        escape_html(lang),
                        escape_html(&tok.content)
                    )
                }
            }
            Kind::Open | Kind::Close | Kind::Hr => self.render_token(index, tok),
        }
    }

    /// トークンの区間 [from, to) を書き出す。前後の隣のトークン (隠れた段落、needLf) は列の全体で見る
    pub(super) fn render_range(&self, from: usize, to: usize) -> String {
        self.toks
            .iter()
            .enumerate()
            .take(to)
            .skip(from)
            .map(|(index, tok)| self.render_one(index, tok))
            .collect()
    }

    /// 区間 [from, to) の中の、この段で取り出した magic comment
    pub(super) fn comments_in(&self, from: usize, to: usize) -> Vec<String> {
        self.toks
            .iter()
            .take(to)
            .skip(from)
            .flat_map(|tok| tok.comments.iter().cloned())
            .collect()
    }

    /// 段落の中身を書き出す (画像だけの段落の img のノードの内容)
    pub(super) fn render_inline(&self, node: &'a AstNode<'a>) -> String {
        let mut out = String::new();
        Writer::new(&self.lines).inline(node, &mut out);
        out
    }

    /// DOM で要素になるインラインの子 (文字とコメントは要素でない)。リンクにならない (validateLink が拒む) リンクと画像は、
    /// 文字に戻るので、その子の要素を代わりに数える。html-parser の `p>img:only-child` の判定に使う
    pub(super) fn element_children(&self, node: &'a AstNode<'a>) -> Vec<&'a AstNode<'a>> {
        let mut elements = Vec::new();
        for child in node.children() {
            let value = child.data().value.clone();
            match value {
                NodeValue::Text(_) => {}
                NodeValue::HtmlInline(literal) => {
                    // 開きのタグだけが要素を作る (閉じのタグ、コメント、`<?`、`<!` の宣言は作らない)
                    if literal.starts_with('<')
                        && !literal.starts_with("</")
                        && !literal.starts_with("<!")
                        && !literal.starts_with("<?")
                    {
                        elements.push(child);
                    }
                }
                NodeValue::Link(link) | NodeValue::Image(link) => {
                    if validate_link(&normalize_link(&link.url)) {
                        elements.push(child);
                    } else {
                        elements.extend(self.element_children(child));
                    }
                }
                _ => elements.push(child),
            }
        }
        elements
    }
}

fn heading_tag(level: u8) -> &'static str {
    match level {
        1 => "h1",
        2 => "h2",
        3 => "h3",
        4 => "h4",
        5 => "h5",
        _ => "h6",
    }
}

// markdown-it の isEmpty (行頭の空白とタブのあとに何もない)。引用ブロックの中では行頭の `>` も除いて見る
// TODO(port): 引用ブロックの中の空行の判定は `>` と空白を全部除く近似 (`> >` の入れ子の空の引用も空行と見なす)
fn is_blank(line: &str, in_quote: bool) -> bool {
    if in_quote {
        line.chars().all(|c| matches!(c, ' ' | '\t' | '>'))
    } else {
        line.chars().all(|c| matches!(c, ' ' | '\t'))
    }
}

/// インラインの HTML を書く (markdown-it の renderInline と既定の規則)。原文の文字 (sourcepos の区間) を読むために本文の行を持つ
struct Writer<'l, 's> {
    lines: &'l [&'s str],
    /// 表の本体の行の桁の直し (comrak が付けた開始の桁, 本当の開始の桁)。表の外は (0, 0)
    columns: (usize, usize),
}

impl<'l, 's> Writer<'l, 's> {
    fn new(lines: &'l [&'s str]) -> Self {
        Writer {
            lines,
            columns: (0, 0),
        }
    }

    fn for_row(lines: &'l [&'s str], columns: (usize, usize)) -> Self {
        Writer { lines, columns }
    }

    // comrak の桁を原文の桁に直す
    fn column(&self, column: usize) -> usize {
        let (comrak_start, source_start) = self.columns;
        (column + source_start).saturating_sub(comrak_start)
    }

    /// sourcepos の位置 (1 始まりの行と、バイトで数えた 1 始まりの桁) から行の終わりまで
    fn line_from(&self, at: LineColumn) -> &'s str {
        let line = self
            .lines
            .get(at.line.saturating_sub(1))
            .copied()
            .unwrap_or("");
        // TODO(port): Rust 側の不到達 (sourcepos の行が本文にない、または comrak の桁が文字の境界でない)。その場合は空とみなす
        line.get(self.column(at.column).saturating_sub(1)..)
            .unwrap_or("")
    }

    /// sourcepos の区間 [from, to] (to の字を含む) の原文。行をまたぐなら '\n' でつなぐ
    fn source_between(&self, from: LineColumn, to: LineColumn) -> String {
        let mut out = String::new();
        for line_number in from.line..=to.line {
            let line = self
                .lines
                .get(line_number.saturating_sub(1))
                .copied()
                .unwrap_or("");
            let start = if line_number == from.line {
                self.column(from.column).saturating_sub(1)
            } else {
                0
            };
            let end = if line_number == to.line {
                self.column(to.column).min(line.len())
            } else {
                line.len()
            };
            if line_number > from.line {
                out.push('\n');
            }
            // TODO(port): Rust 側の不到達 (sourcepos の行が本文にない、または comrak の桁が文字の境界でない)。その場合は空とみなす
            out.push_str(line.get(start..end.max(start)).unwrap_or(""));
        }
        out
    }

    /// 段落、見出し、表のセルのインラインを書く。strip なら、この段の magic comment を取り除いて comments に集める
    /// (DOM の最上位のコメント。見出しと、詰まったリストの項目の隠れた段落がそう)。checkbox なら markmap の checkbox プラグインを当てる
    fn block_inline<'a>(
        &self,
        node: &'a AstNode<'a>,
        strip: bool,
        checkbox: bool,
        comments: &mut Vec<String>,
    ) -> String {
        let children: Vec<&'a AstNode<'a>> = node.children().collect();
        let mut parts = Vec::with_capacity(children.len());
        for child in &children {
            if strip
                && let NodeValue::HtmlInline(literal) = &child.data().value
                && let Some(comment) = magic_comment(literal)
            {
                comments.push(comment);
                parts.push(String::new());
                continue;
            }
            let mut out = String::new();
            self.inline(child, &mut out);
            parts.push(out);
        }
        let html: String = parts.concat();
        let icon = if checkbox {
            self.checkbox_icon(node)
        } else {
            None
        };
        let Some(icon) = icon else {
            return html;
        };
        // 原文の `[ ] ` `[x] ` は markdown-it のインラインの解析の前に絵に置き換わる。書き出した HTML でも同じ 4 字で始まる
        if let Some(rest) = html
            .strip_prefix("[ ] ")
            .or_else(|| html.strip_prefix("[x] "))
        {
            return format!("{icon} {rest}");
        }
        // `[x] ` の直後が改行なら comrak は空白を落とすので `[x]<br>` で始まる。markdown-it も改行の前の空白を落とすので、絵のあとに `<br>` が続く
        if let Some(rest) = html
            .strip_prefix("[ ]")
            .or_else(|| html.strip_prefix("[x]"))
            .filter(|rest| rest.starts_with("<br>"))
        {
            return format!("{icon}{rest}");
        }
        // `[x]: url` の定義があると comrak は `[x]` をリンクにするが、markmap では置き換えのあとなのでリンクにならない。
        // 置き換えた原文 (`[x] `) のあとは、リンクの後ろの文字 (先頭の空白を含む) と同じ
        if children
            .first()
            .is_some_and(|first| matches!(first.data().value, NodeValue::Link(_)))
        {
            return format!(
                "{icon}{}",
                parts.iter().skip(1).map(String::as_str).collect::<String>()
            );
        }
        // TODO(port): 原文は `[ ] ` `[x] ` で始まるが書き出しが上の 3 つの形 (`[x] `、`[x]<br>`、先頭のリンク) にならない場合 (知られた形はない)。置き換えない
        html
    }

    // markmap の checkbox プラグイン: インラインの原文 (token.content。先頭の空白を除いた 1 行目) が `[ ] ` か `[x] ` で始まれば絵にする。
    // 書き出した HTML でなく原文で見る (`\[ ] a` はエスケープなので絵にならない)。
    // markmap は文書の最初のブロックの見出しを飛ばす (`for (let i = 2; ...)`) が、その記号は旧実装の drawLeadingMark が結局絵にするので写さない (DESIGN (a))
    fn checkbox_icon<'a>(&self, node: &'a AstNode<'a>) -> Option<&'static str> {
        let data = node.data();
        let from_start = self.line_from(data.sourcepos.start);
        let head = match &data.value {
            NodeValue::Heading(heading) if !heading.setext => from_start
                .trim_start_matches([' ', '\t'])
                .trim_start_matches('#')
                .trim_start_matches([' ', '\t']),
            _ => from_start.trim_start_matches([' ', '\t']),
        };
        if head.starts_with("[ ] ") {
            Some(UNMARKED)
        } else if head.starts_with("[x] ") {
            Some(MARKED)
        } else {
            None
        }
    }

    // markdown-it の table は列の原文を JS の trim (全角空白や NBSP も) で切ってからインラインを読む。comrak は ASCII の空白だけを切るので、
    // セルの最初と最後の文字のノードの端に残った空白のうち、原文に字のまま書いたもの (文字参照は切らない) を削る
    fn table_cell<'a>(&self, cell: &'a AstNode<'a>) -> String {
        let children: Vec<&'a AstNode<'a>> = cell.children().collect();
        let last = children.len().saturating_sub(1);
        let mut out = String::new();
        for (index, child) in children.iter().enumerate() {
            let data = child.data();
            let NodeValue::Text(text) = &data.value else {
                self.inline(child, &mut out);
                continue;
            };
            let source = self.source_between(data.sourcepos.start, data.sourcepos.end);
            // 原文と文字の端で同じ空白の字だけを数える (文字参照は原文が `&` なので数えない)
            let same_space = |(a, b): (char, char)| a == b && JS_WHITESPACE.contains(&a);
            let lead = if index == 0 {
                source
                    .chars()
                    .zip(text.chars())
                    .take_while(|&pair| same_space(pair))
                    .count()
            } else {
                0
            };
            let trail = if index == last {
                source
                    .chars()
                    .rev()
                    .zip(text.chars().rev())
                    .take_while(|&pair| same_space(pair))
                    .count()
            } else {
                0
            };
            let kept: String = text.chars().skip(lead).collect();
            let keep = kept.chars().count().saturating_sub(trail);
            let trimmed: String = kept.chars().take(keep).collect();
            out.push_str(&escape_html(&trimmed));
        }
        out
    }

    fn inline_children<'a>(&self, node: &'a AstNode<'a>, out: &mut String) {
        for child in node.children() {
            self.inline(child, out);
        }
    }

    fn wrap<'a>(&self, node: &'a AstNode<'a>, tag: &str, out: &mut String) {
        out.push_str(&format!("<{tag}>"));
        self.inline_children(node, out);
        out.push_str(&format!("</{tag}>"));
    }

    fn inline<'a>(&self, node: &'a AstNode<'a>, out: &mut String) {
        let value = node.data().value.clone();
        match &value {
            NodeValue::Text(text) => out.push_str(&escape_html(text)),
            // breaks: true なので段落の中の改行も `<br>` になる
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push_str("<br>\n"),
            NodeValue::Code(code) => {
                out.push_str("<code>");
                out.push_str(&escape_html(&code.literal));
                out.push_str("</code>");
            }
            NodeValue::HtmlInline(literal) => out.push_str(literal),
            NodeValue::Emph => self.wrap(node, "em", out),
            NodeValue::Strong => self.wrap(node, "strong", out),
            NodeValue::Strikethrough => self.wrap(node, "s", out),
            NodeValue::Link(link) => {
                let href = normalize_link(&link.url);
                if !validate_link(&href) {
                    self.rejected_link(node, "[", out);
                    return;
                }
                out.push_str(&format!("<a href=\"{}\"", escape_html(&href)));
                if !link.title.is_empty() {
                    out.push_str(&format!(" title=\"{}\"", escape_html(&link.title)));
                }
                out.push('>');
                // TODO(port): 自動リンク (`<https://…>`) の文字は markdown-it では normalizeLinkText (punycode の toUnicode と mdurl の decode) を通る。comrak の文字のまま書く
                self.inline_children(node, out);
                out.push_str("</a>");
            }
            NodeValue::Image(link) => {
                let src = normalize_link(&link.url);
                if !validate_link(&src) {
                    self.rejected_link(node, "![", out);
                    return;
                }
                let mut alt = String::new();
                inline_as_text(node, &mut alt);
                out.push_str(&format!(
                    "<img src=\"{}\" alt=\"{}\"",
                    escape_html(&src),
                    escape_html(&alt)
                ));
                if !link.title.is_empty() {
                    out.push_str(&format!(" title=\"{}\"", escape_html(&link.title)));
                }
                out.push('>');
            }
            NodeValue::Math(math) => {
                out.push_str(&inline_marks::render_math(&math.literal, math.display_math))
            }
            other => match inline_marks::mark_tag(other) {
                Some(tag) => self.wrap(node, tag, out),
                None => self.inline_children(node, out),
            },
        }
    }

    // validateLink が拒んだリンクと画像。markdown-it はリンクとして読まず、`[` からを文字として読み直す。
    // 中身 (リンクの文字) はそのまま書き、中身のあとの原文 (`](javascript:…)`) は文字にする。自動リンク (`<javascript:…>`) は全体が文字
    // TODO(port): 中身のあとの原文の中の記法 (バックスラッシュのエスケープ、強調) と、同じ名前の参照の定義へのリンクは読み直さない
    fn rejected_link<'a>(&self, node: &'a AstNode<'a>, opener: &str, out: &mut String) {
        let sourcepos = node.data().sourcepos;
        if self.line_from(sourcepos.start).starts_with('<') {
            out.push_str(&escape_html(
                &self.source_between(sourcepos.start, sourcepos.end),
            ));
            return;
        }
        out.push_str(opener);
        self.inline_children(node, out);
        let rest_from = match node.last_child() {
            Some(last) => {
                let end = last.data().sourcepos.end;
                LineColumn {
                    line: end.line,
                    column: end.column + 1,
                }
            }
            None => LineColumn {
                line: sourcepos.start.line,
                column: sourcepos.start.column + opener.len(),
            },
        };
        let rest = self.source_between(rest_from, sourcepos.end);
        out.push_str(&escape_html(&rest).replace('\n', "<br>\n"));
    }
}

// markdown-it の renderInlineAsText (画像の alt): 文字、画像の中身、HTML は content を足し、改行は '\n'、それ以外 (インラインのコードを含む) は飛ばす。
// markdown-it のインラインのトークンは平らな列なので、強調の中の文字は拾われる (comrak の木では子をたどる)
fn inline_as_text<'a>(node: &'a AstNode<'a>, out: &mut String) {
    for child in node.children() {
        let value = child.data().value.clone();
        match &value {
            NodeValue::Text(text) => out.push_str(text),
            NodeValue::HtmlInline(literal) => out.push_str(literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push('\n'),
            NodeValue::Code(_) | NodeValue::Math(_) => {}
            _ => inline_as_text(child, out),
        }
    }
}

// ---- リンクの正規化 (markdown-it の normalizeLink と validateLink) ----

/// markdown-it の validateLink: `vbscript:` `javascript:` `file:` `data:` を拒む (data: は gif / png / jpeg / webp の画像だけ許す)
pub(super) fn validate_link(url: &str) -> bool {
    let lower = js_trim(url).to_lowercase();
    let bad = ["vbscript:", "javascript:", "file:", "data:"]
        .iter()
        .any(|proto| lower.starts_with(proto));
    if !bad {
        return true;
    }
    [
        "data:image/gif;",
        "data:image/png;",
        "data:image/jpeg;",
        "data:image/webp;",
    ]
    .iter()
    .any(|good| lower.starts_with(good))
}

/// markdown-it の normalizeLink: mdurl で読み、http / https / mailto (と protocol なし) のホスト名を punycode にし、書き戻して百分率符号化する
pub(super) fn normalize_link(url: &str) -> String {
    let mut parsed = Url::parse(url);
    if let Some(hostname) = parsed.hostname.as_ref().filter(|host| !host.is_empty()) {
        let recode = match parsed.protocol.as_deref() {
            None => true,
            Some(protocol) => ["http:", "https:", "mailto:"].contains(&protocol),
        };
        if recode {
            // 原文は例外 (overflow) を握りつぶしてホスト名をそのまま残す
            if let Some(ascii) = punycode_to_ascii(hostname) {
                parsed.hostname = Some(ascii);
            }
        }
    }
    mdurl_encode(&parsed.format())
}

/// mdurl の Url (parse の結果) のうち format が使う欄
#[derive(Debug, Default)]
struct Url {
    protocol: Option<String>,
    slashes: bool,
    auth: Option<String>,
    port: Option<String>,
    hostname: Option<String>,
    hash: Option<String>,
    search: Option<String>,
    pathname: Option<String>,
}

const HOSTLESS_PROTOCOLS: &[&str] = &["javascript", "javascript:"];
const SLASHED_PROTOCOLS: &[&str] = &[
    "http", "https", "ftp", "gopher", "file", "http:", "https:", "ftp:", "gopher:", "file:",
];
const HOST_ENDING_CHARS: &[char] = &['/', '?', '#'];
// nonHostChars = ['%', '/', '?', ';', '#'] + autoEscape (['\''] + unwise (['{', '}', '|', '\\', '^', '`'] + delims))
const NON_HOST_CHARS: &[char] = &[
    '%', '/', '?', ';', '#', '\'', '{', '}', '|', '\\', '^', '`', '<', '>', '"', '`', ' ', '\r',
    '\n', '\t',
];
const HOSTNAME_MAX_LEN: usize = 255;

fn is_hostname_char(c: char) -> bool {
    c == '+' || c == '_' || c == '-' || c.is_ascii_alphanumeric()
}

impl Url {
    // mdurl の Url.prototype.parse (slashesDenoteHost = true の経路)
    fn parse(url: &str) -> Url {
        let mut this = Url::default();
        let mut rest = js_trim(url).to_string();
        // protocolPattern `/^([a-z0-9.+-]+:)/i`
        let proto_len = rest
            .char_indices()
            .find(|&(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-')))
            .filter(|&(index, c)| c == ':' && index > 0)
            .map(|(index, _)| index + 1);
        let proto = proto_len.map(|len| {
            let (head, tail) = split_string(&rest, len);
            rest = tail;
            head
        });
        this.protocol = proto.clone();
        let hostless = proto
            .as_deref()
            .is_some_and(|p| HOSTLESS_PROTOCOLS.contains(&p));
        let slashes = rest.starts_with("//");
        if slashes && !hostless {
            rest = split_string(&rest, 2).1;
            this.slashes = true;
        }
        let slashed = proto
            .as_deref()
            .is_some_and(|p| SLASHED_PROTOCOLS.contains(&p));
        if !hostless && (slashes || (proto.is_some() && !slashed)) {
            let host_end = rest.find(HOST_ENDING_CHARS);
            // `rest.lastIndexOf('@', hostEnd)`: hostEnd の字は `/` `?` `#` なので、それより前の最後の `@`
            let at_sign = rest
                .char_indices()
                .rfind(|&(index, c)| c == '@' && host_end.is_none_or(|end| index < end))
                .map(|(index, _)| index);
            if let Some(at) = at_sign {
                let (auth, after) = split_string(&rest, at);
                this.auth = Some(auth);
                rest = after.chars().skip(1).collect();
            }
            let mut host_end = rest.find(NON_HOST_CHARS).unwrap_or(rest.len());
            if host_end
                .checked_sub(1)
                .is_some_and(|last| rest.as_bytes().get(last) == Some(&b':'))
            {
                host_end -= 1;
            }
            let (host, after) = split_string(&rest, host_end);
            rest = after;
            this.parse_host(&host);
            let mut hostname = this.hostname.take().unwrap_or_default();
            let ipv6 = hostname.starts_with('[') && hostname.ends_with(']');
            if !ipv6 {
                let parts: Vec<String> = hostname.split('.').map(str::to_string).collect();
                for (index, part) in parts.iter().enumerate() {
                    if part.is_empty() || is_hostname_part(part) {
                        continue;
                    }
                    // 非 ASCII の字 (UTF-16 の単位ごと) を 'x' に置き換えて、なお形が合わなければ、そこから後ろはホスト名でない
                    let replaced: String = part
                        .chars()
                        .flat_map(|c| {
                            let repeat = if c.is_ascii() { 1 } else { c.len_utf16() };
                            std::iter::repeat_n(if c.is_ascii() { c } else { 'x' }, repeat)
                        })
                        .collect();
                    if is_hostname_part(&replaced) {
                        continue;
                    }
                    let mut valid_parts: Vec<String> = parts.iter().take(index).cloned().collect();
                    let mut not_host: Vec<String> = parts.iter().skip(index + 1).cloned().collect();
                    // hostnamePartStart `/^([+a-z0-9A-Z_-]{0,63})(.*)$/` (`.` は改行と U+2028 / U+2029 に当たらない)
                    let head_chars = part
                        .chars()
                        .take(63)
                        .take_while(|&c| is_hostname_char(c))
                        .count();
                    let head: String = part.chars().take(head_chars).collect();
                    let tail: String = part.chars().skip(head_chars).collect();
                    if !tail.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
                        valid_parts.push(head);
                        not_host.insert(0, tail);
                    }
                    if !not_host.is_empty() {
                        rest = format!("{}{rest}", not_host.join("."));
                    }
                    hostname = valid_parts.join(".");
                    break;
                }
            }
            if hostname.encode_utf16().count() > HOSTNAME_MAX_LEN {
                hostname = String::new();
            }
            if ipv6 {
                // 長さの上限で空にしたホスト名は `substr(1, length - 2)` でも空
                let inner = hostname
                    .strip_prefix('[')
                    .and_then(|h| h.strip_suffix(']'))
                    .unwrap_or("");
                hostname = inner.to_string();
            }
            this.hostname = Some(hostname);
        }
        if let Some(hash) = rest.find('#') {
            let (head, tail) = split_string(&rest, hash);
            this.hash = Some(tail);
            rest = head;
        }
        if let Some(query) = rest.find('?') {
            let (head, tail) = split_string(&rest, query);
            this.search = Some(tail);
            rest = head;
        }
        if !rest.is_empty() {
            this.pathname = Some(rest);
        }
        this
    }

    // mdurl の parseHost: 末尾の `:数字` を port にする (`:` だけなら port なしで取り除く)
    fn parse_host(&mut self, host: &str) {
        // portPattern `/:[0-9]*$/` に当たるのは最後の `:` で、その後ろが数字だけのとき
        let mut host = host;
        if let Some((head, port)) = host
            .rsplit_once(':')
            .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        {
            if !port.is_empty() {
                self.port = Some(port.to_string());
            }
            host = head;
        }
        if !host.is_empty() {
            self.hostname = Some(host.to_string());
        }
    }

    // mdurl の format
    fn format(&self) -> String {
        let mut result = String::new();
        result.push_str(self.protocol.as_deref().unwrap_or(""));
        if self.slashes {
            result.push_str("//");
        }
        if let Some(auth) = self.auth.as_deref().filter(|auth| !auth.is_empty()) {
            result.push_str(auth);
            result.push('@');
        }
        let hostname = self.hostname.as_deref().unwrap_or("");
        if hostname.contains(':') {
            result.push_str(&format!("[{hostname}]"));
        } else {
            result.push_str(hostname);
        }
        if let Some(port) = self.port.as_deref().filter(|port| !port.is_empty()) {
            result.push(':');
            result.push_str(port);
        }
        for part in [&self.pathname, &self.search, &self.hash] {
            result.push_str(part.as_deref().unwrap_or(""));
        }
        result
    }
}

// 文字列を添字 (バイト) で前後に分ける。添字は ASCII の字の位置から来るので文字の境界にある
fn split_string(text: &str, at: usize) -> (String, String) {
    // TODO(port): Rust 側の不到達 (添字が文字の境界でない)。その場合は分けない
    let (head, tail) = text.split_at_checked(at).unwrap_or((text, ""));
    (head.to_string(), tail.to_string())
}

// hostnamePartPattern `/^[+a-z0-9A-Z_-]{0,63}$/` (長さは UTF-16 の単位。ここに来る字は ASCII なので字の数と同じ)
fn is_hostname_part(part: &str) -> bool {
    part.encode_utf16().count() <= 63 && part.chars().all(is_hostname_char)
}

// mdurl の encode (exclude は既定の `;/?:@&=+$,-_.!~*'()#`、keepEscaped は true)。
// 正しい `%XX` はそのまま、ASCII の英数字と除外の字はそのまま、それ以外は UTF-8 のバイトごとに `%XX` (大文字)
fn mdurl_encode(text: &str) -> String {
    const EXCLUDE: &str = ";/?:@&=+$,-_.!~*'()#";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut chars = text.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        if c == '%'
            && bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit)
            && bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit)
        {
            out.push('%');
            for _ in 0..2 {
                if let Some((_, digit)) = chars.next() {
                    out.push(digit);
                }
            }
            continue;
        }
        if c.is_ascii_alphanumeric() || EXCLUDE.contains(c) {
            out.push(c);
            continue;
        }
        let mut buffer = [0u8; 4];
        for byte in c.encode_utf8(&mut buffer).bytes() {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// punycode.js の toASCII (mapDomain): `@` の前はそのまま、区切り (`.` `。` `．` `｡`) を `.` にして、非 ASCII を含むラベルを `xn--` + encode に。
// encode が overflow を投げたら None (normalizeLink はそれを握りつぶしてホスト名を変えない)
fn punycode_to_ascii(domain: &str) -> Option<String> {
    // `parts = domain.split('@')` の 2 つ目 (3 つ目より後ろは捨てる)
    let (prefix, domain) = match domain.split_once('@') {
        Some((first, rest)) => (
            format!("{first}@"),
            rest.split_once('@').map_or(rest, |(second, _)| second),
        ),
        None => (String::new(), domain),
    };
    let domain: String = domain
        .chars()
        .map(|c| {
            if matches!(c, '\u{3002}' | '\u{FF0E}' | '\u{FF61}') {
                '.'
            } else {
                c
            }
        })
        .collect();
    let mut labels = Vec::new();
    for label in domain.split('.') {
        if !label.is_ascii() {
            labels.push(format!("xn--{}", punycode_encode(label)?));
        } else {
            labels.push(label.to_string());
        }
    }
    Some(format!("{prefix}{}", labels.join(".")))
}

// punycode.js の encode (RFC 3492)。算術は原文と同じく 2^31 - 1 を越えたら overflow
fn punycode_encode(input: &str) -> Option<String> {
    const MAX_INT: u64 = 2_147_483_647;
    const BASE: u64 = 36;
    const T_MIN: u64 = 1;
    const T_MAX: u64 = 26;
    const INITIAL_BIAS: u64 = 72;
    const INITIAL_N: u64 = 128;
    let input: Vec<u64> = input.chars().map(|c| u64::from(u32::from(c))).collect();
    let mut output: Vec<char> = input
        .iter()
        .filter(|&&value| value < 0x80)
        .filter_map(|&value| char::from_u32(u32::try_from(value).ok()?))
        .collect();
    let basic_length = output.len();
    let mut handled = basic_length;
    if basic_length > 0 {
        output.push('-');
    }
    let mut n = INITIAL_N;
    let mut delta: u64 = 0;
    let mut bias = INITIAL_BIAS;
    while handled < input.len() {
        let m = input
            .iter()
            .copied()
            .filter(|&value| value >= n)
            .min()
            .unwrap_or(MAX_INT)
            .min(MAX_INT);
        let handled_plus_one = handled as u64 + 1;
        // 原文は `m - n > floor((maxInt - delta) / (handledCPCount + 1))`。maxInt - delta が負なら必ず overflow
        let room = MAX_INT.checked_sub(delta)?;
        if m - n > room / handled_plus_one {
            return None;
        }
        delta += (m - n) * handled_plus_one;
        n = m;
        for &value in &input {
            if value < n {
                delta += 1;
                if delta > MAX_INT {
                    return None;
                }
            }
            if value == n {
                let mut q = delta;
                let mut k = BASE;
                loop {
                    let t = if k <= bias {
                        T_MIN
                    } else if k >= bias + T_MAX {
                        T_MAX
                    } else {
                        k - bias
                    };
                    if q < t {
                        break;
                    }
                    output.push(punycode_digit(t + (q - t) % (BASE - t)));
                    q = (q - t) / (BASE - t);
                    k += BASE;
                }
                output.push(punycode_digit(q));
                bias = punycode_adapt(delta, handled_plus_one, handled == basic_length);
                delta = 0;
                handled += 1;
            }
        }
        delta += 1;
        n += 1;
    }
    Some(output.into_iter().collect())
}

// digitToBasic (flag は 0): 0..25 は a..z、26..35 は 0..9
fn punycode_digit(digit: u64) -> char {
    let code = if digit < 26 { digit + 97 } else { digit + 22 };
    // TODO(port): Rust 側の不到達 (digit は 36 未満なので ASCII)
    u32::try_from(code)
        .ok()
        .and_then(char::from_u32)
        .unwrap_or('?')
}

fn punycode_adapt(delta: u64, num_points: u64, first_time: bool) -> u64 {
    const BASE_MINUS_T_MIN: u64 = 35;
    const T_MAX: u64 = 26;
    let mut delta = if first_time { delta / 700 } else { delta >> 1 };
    delta += delta / num_points;
    let mut k = 0;
    while delta > (BASE_MINUS_T_MIN * T_MAX) >> 1 {
        delta /= BASE_MINUS_T_MIN;
        k += 36;
    }
    k + (BASE_MINUS_T_MIN + 1) * delta / (delta + 38)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期待値は node の markdown-it 14.3.2 の md.normalizeLink と md.validateLink で取った
    #[test]
    fn outline_html_normalize_link_matches_markdown_it() {
        let cases = [
            ("HTTP://EXAMPLE.com/Ä b", "HTTP://EXAMPLE.com/%C3%84%20b"),
            (
                "http://例え.jp/パス?q=値#h",
                "http://xn--r8jz45g.jp/%E3%83%91%E3%82%B9?q=%E5%80%A4#h",
            ),
            (
                "https://user:pw@Bücher.de:8080/x",
                "https://user:pw@xn--Bcher-kva.de:8080/x",
            ),
            ("//例え.jp/x", "//xn--r8jz45g.jp/x"),
            ("mailto:a@例え.jp", "mailto:a@xn--r8jz45g.jp"),
            ("ftp://例え.jp/", "ftp://%E4%BE%8B%E3%81%88.jp/"),
            ("例え.jp/x", "%E4%BE%8B%E3%81%88.jp/x"),
            ("http://[::1]/x", "http://%5B::1%5D/x"),
            ("http://a%zz/%41%4", "http://a%25zz/%41%254"),
            ("JavaScript:alert(1)", "JavaScript:alert(1)"),
            (" data:image/png;x", "data:image/png;x"),
            ("http://xn--r8jz45g.jp/", "http://xn--r8jz45g.jp/"),
            ("http://ex ample.com", "http://ex%20ample.com"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_link(input), expected, "{input}");
        }
    }

    #[test]
    fn outline_html_validate_link_rejects_script_protocols() {
        assert!(!validate_link("JavaScript:alert(1)"));
        assert!(!validate_link("file:///etc"));
        assert!(!validate_link("vbscript:x"));
        assert!(!validate_link("data:text/html;base64,AA"));
        assert!(validate_link("data:image/png;base64,AA"));
        assert!(validate_link("https://example.com"));
    }

    #[test]
    fn outline_html_split_lines_follows_markdown_it_newlines() {
        assert_eq!(split_lines("a\r\nb\rc\nd\n"), vec!["a", "b", "c", "d"]);
        assert_eq!(split_lines("a\n\n"), vec!["a", ""]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
    }

    #[test]
    fn outline_html_magic_comment_reads_markmap_prefix() {
        assert_eq!(
            magic_comment("<!-- markmap: fold -->"),
            Some("fold".to_string())
        );
        assert_eq!(
            magic_comment("<!--markmap: foldAll-->"),
            Some("foldAll".to_string())
        );
        assert_eq!(magic_comment("<!-- note -->"), None);
    }
}

// PORT STATUS: confidence=medium todos=9
