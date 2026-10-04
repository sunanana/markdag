// 原文なし。
// frontmatter の書き方の書き直し。操作が frontmatter の書き方の都合で断ったとき (フロー形式の写像か一覧、relations の kind の | や > の
// 複数行の文字)、その所を書き直した原文を返す (操作はその原文でやり直す)。
// フロー形式は、断った理由の道すじを含むいちばん外のフロー形式のブロックを、中の値ごと字下げの形 (キーと - で 1 行ずつ) に書き直す。
// スカラの字は書いたまま (引用符も) にし、字下げの幅は frontmatter の最小の字下げ (なければ 4)。書き直すブロックそのものが空 ({} か [])
// なら、値のないキーにする (そのあとの書き込みで中身が入る)。中に空のフロー形式があれば、その値は `{}` か `[]` のまま残す。
// コメント、アンカー、別名、タグ、明示のキー (?)、フロー形式の一覧の中の 1 組の写像、行をまたぐスカラを含むブロックは書き直さない。
// | や > の値は、中身の行のうち空でない行ごとに 1 項目の一覧にする (書いた見た目どおり。キーの行の記号のあとのコメントは残す)。
// どちらも、書き直したあとの frontmatter を読み直して、書き直した所のほかの値が変わらないことを確かめる。
use super::frontmatter::{indent_width, split_key_line, yaml_value};
use super::lines::{LinePlan, carriage_of, split_carriage};
use crate::model::locator::{BlockShape, FrontmatterBlock, FrontmatterLocator};
use crate::model::util::JsValue;
use crate::parse::parse_yaml;
use crate::types::{EditReason, EditReasonCode, LineSplice, PathStep};

/// 断った理由が frontmatter の書き方 (flow-style、block-scalar) なら、その所を書き直した原文と、原文からの差し替えの列。
/// 書き直せないか、断った理由がほかのものなら None
pub(super) fn restyled(source: &str, reason: &EditReason) -> Option<(Vec<LineSplice>, String)> {
    // 先頭の BOM のすぐあとが --- の文書は、BOM を外して読む (markdag: を足す操作は BOM を外してその frontmatter に書くため)。
    // 書き直すのは frontmatter の中の行だけで、BOM のある 1 行目 (開きの ---) には触らない
    let (bom, text) = match source.strip_prefix('\u{feff}') {
        Some(rest) if rest.starts_with("---") => ("\u{feff}", rest),
        _ => ("", source),
    };
    let locator = FrontmatterLocator::new(Some(text));
    if !locator.syntax_errors().is_empty() {
        return None;
    }
    let fences = locator.fence_lines()?;
    let lines: Vec<&str> = text.split('\n').collect();
    let path = match &reason.path {
        None => Vec::new(),
        Some(dotted) => path_of(&locator, &mut Vec::new(), dotted)?,
    };
    let site = Site {
        locator: &locator,
        lines: &lines,
        fences,
        width: indent_width(&lines, fences),
        carriage: carriage_of(text),
    };
    let rewrite = match reason.code {
        EditReasonCode::FlowStyle => site.unflowed(&path)?,
        EditReasonCode::BlockScalar => site.listed(&path)?,
        _ => return None,
    };
    let mut plan = LinePlan::new(&lines);
    plan.remove(rewrite.start, rewrite.end - rewrite.start);
    plan.insert(rewrite.start, rewrite.lines);
    let after = plan.text();
    // 書き直した所のほかの値が変わらず、書き直した所がねらいの値に読まれる
    let before_value = body_value(&locator, &lines)?;
    let expected = replaced(&before_value, &rewrite.path, rewrite.value)?;
    let after_locator = FrontmatterLocator::new(Some(&after));
    let after_lines: Vec<&str> = after.split('\n').collect();
    if !after_locator.syntax_errors().is_empty()
        || body_value(&after_locator, &after_lines).as_ref() != Some(&expected)
    {
        return None;
    }
    Some((plan.splices(), format!("{bom}{after}")))
}

// 書き直す行の範囲 (start から end の前まで) と書く行、書き直した値の道すじと、そこに読まれるはずの値 (None はもとの値のまま)
struct Rewrite {
    start: usize,
    end: usize,
    lines: Vec<String>,
    path: Vec<PathStep>,
    value: Option<JsValue>,
}

// 書き直す frontmatter
struct Site<'s> {
    locator: &'s FrontmatterLocator,
    lines: &'s [&'s str],
    fences: (u32, u32),
    width: usize,
    carriage: &'static str,
}

impl Site<'_> {
    // 道すじを含むいちばん外のフロー形式のブロックを、字下げの形に書き直す
    fn unflowed(&self, path: &[PathStep]) -> Option<Rewrite> {
        let depth = (0..=path.len()).find(|depth| {
            self.locator
                .block(&path[..*depth])
                .is_some_and(|block| block.flow)
        })?;
        let path = &path[..depth];
        let block = self.locator.block(path)?;
        let (open, close) = (self.fences.0 as usize, self.fences.1 as usize);
        if path.is_empty() {
            // frontmatter の全体
            let text = self.contents(open + 1, close.checked_sub(1)?, "");
            let flow = read_flow(&text)?;
            let mut written = Vec::new();
            emit_entries(&flow, 0, self.width, &mut written)?;
            return Some(Rewrite {
                start: open + 1,
                end: close,
                lines: self.ended(written),
                path: Vec::new(),
                value: empty_null(&flow),
            });
        }
        let (key_line, head, own) = self.key_line(path, &block)?;
        let rest = {
            let content = split_carriage(self.lines.get(key_line)?).0;
            content.get(head.len()..)?.to_string()
        };
        let text = self.contents(key_line + 1, block.last_line as usize, &rest);
        let flow = read_flow(&text)?;
        let key_column = self.key_column(path);
        let mut written = Vec::new();
        emit_entries(&flow, key_column + self.width, self.width, &mut written)?;
        let mut lines = vec![format!("{head}{own}")];
        lines.extend(self.ended(written));
        Some(Rewrite {
            start: key_line,
            end: (block.last_line as usize).max(key_line) + 1,
            lines,
            path: path.to_vec(),
            value: empty_null(&flow),
        })
    }

    // | や > の複数行の文字の値を、中身の行のうち空でない行ごとに 1 項目の一覧に書き直す
    fn listed(&self, path: &[PathStep]) -> Option<Rewrite> {
        let block = self.locator.block(path)?;
        if block.shape != BlockShape::Scalar || block.flow {
            return None;
        }
        let (key_line, head, own) = self.key_line(path, &block)?;
        let (_, value) = split_key_line(self.lines.get(key_line)?, self.key_column(path))?;
        if !value.starts_with(['|', '>']) {
            return None;
        }
        // キーの行の記号のあとはコメントだけ
        let after_indicator = value
            .split_once([' ', '\t'])
            .map_or("", |(_, rest)| rest.trim_start_matches([' ', '\t']));
        if !after_indicator.is_empty() && !after_indicator.starts_with('#') {
            return None;
        }
        let items: Vec<String> = self
            .lines
            .get(key_line + 1..=(block.last_line as usize).max(key_line))
            .unwrap_or_default()
            .iter()
            .map(|line| split_carriage(line).0.trim_matches([' ', '\t']).to_string())
            .filter(|item| !item.is_empty())
            .collect();
        let comment = if after_indicator.is_empty() {
            String::new()
        } else {
            format!(" {after_indicator}")
        };
        let indent = " ".repeat(self.key_column(path) + self.width);
        let mut lines = vec![format!("{head}{comment}{own}")];
        lines.extend(
            items
                .iter()
                .map(|item| format!("{indent}- {}{}", yaml_value(item), self.carriage)),
        );
        let value = if items.is_empty() {
            JsValue::Null
        } else {
            JsValue::Array(items.into_iter().map(JsValue::String).collect())
        };
        Some(Rewrite {
            start: key_line,
            end: (block.last_line as usize).max(key_line) + 1,
            lines,
            path: path.to_vec(),
            value: Some(value),
        })
    }

    // 値のキーの行、その行のキーと `:` まで (行頭の字下げを含む)、行末の \r
    fn key_line(
        &self,
        path: &[PathStep],
        block: &FrontmatterBlock,
    ) -> Option<(usize, String, String)> {
        let key_line = block.key_line? as usize;
        let line = self.lines.get(key_line)?;
        let (head, _) = split_key_line(line, self.key_column(path))?;
        Some((key_line, head, split_carriage(line).1.to_string()))
    }

    // キーの字の始まりの桁 (字数)
    fn key_column(&self, path: &[PathStep]) -> usize {
        self.locator
            .key(path)
            .map_or(0, |position| position.column.saturating_sub(1) as usize)
    }

    // first の前に置く字と、first から last までの行 (行末の \r を除く) を改行でつないだもの
    fn contents(&self, first: usize, last: usize, before: &str) -> String {
        let mut text = before.to_string();
        for line in self.lines.get(first..=last).unwrap_or_default() {
            text.push('\n');
            text.push_str(split_carriage(line).0);
        }
        text
    }

    fn ended(&self, lines: Vec<String>) -> Vec<String> {
        lines
            .into_iter()
            .map(|line| format!("{line}{}", self.carriage))
            .collect()
    }
}

// 断った理由の道すじ (キーを . でつないだもの) を、frontmatter の写像のキーをたどって道すじにしたもの
fn path_of(
    locator: &FrontmatterLocator,
    path: &mut Vec<PathStep>,
    dotted: &str,
) -> Option<Vec<PathStep>> {
    let block = locator.block(path)?;
    if block.shape != BlockShape::Map {
        return None;
    }
    for name in block.items.iter().filter_map(|item| item.key.as_deref()) {
        if dotted == name {
            let mut found = path.clone();
            found.push(PathStep::Key(name.to_string()));
            return Some(found);
        }
        if let Some(rest) = dotted
            .strip_prefix(name)
            .and_then(|rest| rest.strip_prefix('.'))
        {
            path.push(PathStep::Key(name.to_string()));
            if let Some(found) = path_of(locator, path, rest) {
                return Some(found);
            }
            path.pop();
        }
    }
    None
}

// frontmatter を YAML として読んだ値
fn body_value(locator: &FrontmatterLocator, lines: &[&str]) -> Option<JsValue> {
    let (open, close) = locator.fence_lines()?;
    let body = lines
        .get(open as usize + 1..close as usize)
        .unwrap_or_default()
        .join("\n");
    parse_yaml(&body)
}

// value の道すじの値を next にした値 (next が None ならそのまま)。道すじがなければ None
fn replaced(value: &JsValue, path: &[PathStep], next: Option<JsValue>) -> Option<JsValue> {
    let Some(next) = next else {
        return Some(value.clone());
    };
    let Some((step, rest)) = path.split_first() else {
        return Some(next);
    };
    match (value, step) {
        (JsValue::Object(map), PathStep::Key(name)) => {
            let mut map = map.clone();
            let inner = replaced(map.get(name)?, rest, Some(next))?;
            map.insert(name.clone(), inner);
            Some(JsValue::Object(map))
        }
        (JsValue::Array(items), PathStep::Index(index)) => {
            let mut items = items.clone();
            let inner = replaced(items.get(*index)?, rest, Some(next))?;
            items[*index] = inner;
            Some(JsValue::Array(items))
        }
        _ => None,
    }
}

// フロー形式の値 (字下げの形に書き直す前に読んだもの)。スカラは書いた字のまま (引用符を含む)
enum Flow {
    Map(Vec<(String, Option<Flow>)>),
    Seq(Vec<Flow>),
    Scalar(String),
}

impl Flow {
    fn is_empty(&self) -> bool {
        match self {
            Flow::Map(pairs) => pairs.is_empty(),
            Flow::Seq(items) => items.is_empty(),
            Flow::Scalar(_) => false,
        }
    }
}

// 書き直すブロックが空なら、値のないキー (null) に読まれる。空でなければ値は変わらない (None)
fn empty_null(flow: &Flow) -> Option<JsValue> {
    flow.is_empty().then_some(JsValue::Null)
}

// フロー形式のブロックの字 (前後の空白と改行はあってよい) を読む。書き直せない形なら None
fn read_flow(text: &str) -> Option<Flow> {
    let mut reader = FlowReader {
        chars: text.chars().collect(),
        at: 0,
    };
    reader.skip()?;
    if !matches!(reader.peek()?, '{' | '[') {
        return None;
    }
    let flow = reader.node()?;
    reader.skip()?;
    (reader.at == reader.chars.len()).then_some(flow)
}

struct FlowReader {
    chars: Vec<char>,
    at: usize,
}

impl FlowReader {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    // 空白と改行を飛ばす。コメントがあれば None (書き直すとコメントの置き場が決まらない)
    fn skip(&mut self) -> Option<()> {
        while let Some(c) = self.peek() {
            match c {
                ' ' | '\t' | '\n' | '\r' => self.at += 1,
                '#' => return None,
                _ => break,
            }
        }
        Some(())
    }

    fn node(&mut self) -> Option<Flow> {
        self.skip()?;
        match self.peek()? {
            '{' => self.map(),
            '[' => self.seq(),
            '"' => self.double_quoted(),
            '\'' => self.single_quoted(),
            // アンカー、別名、タグ、明示のキー、ブロックの文字の記号、予約の字、区切り
            '&' | '*' | '!' | '?' | '|' | '>' | '%' | '@' | '`' | '#' | ',' | ':' | ']' | '}' => {
                None
            }
            _ => self.plain(),
        }
    }

    fn map(&mut self) -> Option<Flow> {
        self.at += 1;
        let mut pairs = Vec::new();
        loop {
            self.skip()?;
            if self.peek()? == '}' {
                self.at += 1;
                return Some(Flow::Map(pairs));
            }
            let Flow::Scalar(key) = self.node()? else {
                return None;
            };
            self.skip()?;
            let value = if self.peek()? == ':' {
                self.at += 1;
                self.skip()?;
                match self.peek()? {
                    ',' | '}' => None,
                    _ => Some(self.node()?),
                }
            } else {
                None
            };
            pairs.push((key, value));
            self.skip()?;
            match self.peek()? {
                ',' => self.at += 1,
                '}' => {}
                _ => return None,
            }
        }
    }

    // 一覧の項目のあとに `:` があれば (一覧の中の 1 組の写像) 書き直さない
    fn seq(&mut self) -> Option<Flow> {
        self.at += 1;
        let mut items = Vec::new();
        loop {
            self.skip()?;
            if self.peek()? == ']' {
                self.at += 1;
                return Some(Flow::Seq(items));
            }
            items.push(self.node()?);
            self.skip()?;
            match self.peek()? {
                ',' => self.at += 1,
                ']' => {}
                _ => return None,
            }
        }
    }

    // "…" の字 (中の \ は次の字と組)。行をまたげば None
    fn double_quoted(&mut self) -> Option<Flow> {
        let start = self.at;
        self.at += 1;
        loop {
            match self.peek()? {
                '\\' => self.at += 2,
                '"' => {
                    self.at += 1;
                    break;
                }
                '\n' | '\r' => return None,
                _ => self.at += 1,
            }
        }
        Some(Flow::Scalar(
            self.chars.get(start..self.at)?.iter().collect(),
        ))
    }

    // '…' の字 ('' は ' 1 つ)。行をまたげば None
    fn single_quoted(&mut self) -> Option<Flow> {
        let start = self.at;
        self.at += 1;
        loop {
            match self.peek()? {
                '\'' if self.chars.get(self.at + 1) == Some(&'\'') => self.at += 2,
                '\'' => {
                    self.at += 1;
                    break;
                }
                '\n' | '\r' => return None,
                _ => self.at += 1,
            }
        }
        Some(Flow::Scalar(
            self.chars.get(start..self.at)?.iter().collect(),
        ))
    }

    // 引用符のない字。区切りの字、値の `:` (後ろが空白か区切りの字か終わり)、前が空白の #、改行の前で終わる
    fn plain(&mut self) -> Option<Flow> {
        let start = self.at;
        while let Some(c) = self.peek() {
            let next = self.chars.get(self.at + 1).copied();
            let ends = match c {
                ',' | '[' | ']' | '{' | '}' | '\n' | '\r' => true,
                ':' => next.is_none_or(|next| {
                    matches!(next, ' ' | '\t' | '\n' | '\r' | ',' | '[' | ']' | '{' | '}')
                }),
                '#' => self
                    .at
                    .checked_sub(1)
                    .and_then(|previous| self.chars.get(previous))
                    .is_some_and(|previous| matches!(previous, ' ' | '\t')),
                _ => false,
            };
            if ends {
                break;
            }
            self.at += 1;
        }
        let raw: String = self.chars.get(start..self.at)?.iter().collect();
        let raw = raw.trim_end_matches([' ', '\t']).to_string();
        (!raw.is_empty()).then_some(Flow::Scalar(raw))
    }
}

// 写像か一覧の中身を、indent の字下げで 1 行ずつ書く (行末の改行は付けない)。書けない形なら None
fn emit_entries(flow: &Flow, indent: usize, width: usize, out: &mut Vec<String>) -> Option<()> {
    match flow {
        Flow::Map(pairs) => {
            for (key, value) in pairs {
                let head = format!("{}{key}:", " ".repeat(indent));
                emit_value(head, value.as_ref(), indent, width, out)?;
            }
        }
        Flow::Seq(items) => {
            for item in items {
                let lead = format!("{}- ", " ".repeat(indent));
                match item {
                    Flow::Scalar(raw) => out.push(format!("{lead}{raw}")),
                    Flow::Map(pairs) if pairs.is_empty() => out.push(format!("{lead}{{}}")),
                    Flow::Seq(items) if items.is_empty() => out.push(format!("{lead}[]")),
                    // 一覧の項目の写像は、最初の組を「- 」の行に書き、ほかの組を「- 」のあとの桁にそろえる
                    Flow::Map(pairs) => {
                        let column = indent + 2;
                        for (index, (key, value)) in pairs.iter().enumerate() {
                            let head = if index == 0 {
                                format!("{lead}{key}:")
                            } else {
                                format!("{}{key}:", " ".repeat(column))
                            };
                            emit_value(head, value.as_ref(), column, width, out)?;
                        }
                    }
                    Flow::Seq(_) => return None,
                }
            }
        }
        Flow::Scalar(_) => return None,
    }
    Some(())
}

// 組の行 (head はキーと `:` まで) と、値が写像か一覧ならその下の行 (キーの字下げ indent + 幅)
fn emit_value(
    head: String,
    value: Option<&Flow>,
    indent: usize,
    width: usize,
    out: &mut Vec<String>,
) -> Option<()> {
    match value {
        None => out.push(head),
        Some(Flow::Scalar(raw)) => out.push(format!("{head} {raw}")),
        Some(Flow::Map(pairs)) if pairs.is_empty() => out.push(format!("{head} {{}}")),
        Some(Flow::Seq(items)) if items.is_empty() => out.push(format!("{head} []")),
        Some(nested) => {
            out.push(head);
            emit_entries(nested, indent + width, width, out)?;
        }
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(text: &str, indent: usize) -> Option<Vec<String>> {
        let flow = read_flow(text)?;
        let mut out = Vec::new();
        emit_entries(&flow, indent, 4, &mut out)?;
        Some(out)
    }

    #[test]
    fn edit_restyle_reads_flow_blocks_and_writes_them_indented() {
        assert_eq!(
            written("{ a: 1, b: [x --> y, \"q: r\"], c: {}, d }", 0).expect("書ける"),
            [
                "a: 1",
                "b:",
                "    - x --> y",
                "    - \"q: r\"",
                "c: {}",
                "d:"
            ]
        );
        assert_eq!(
            written("[\n  a --> b,\n  'it''s',\n]", 4).expect("書ける"),
            ["    - a --> b", "    - 'it''s'"]
        );
        assert_eq!(
            written("[{ a: 1, b: { c: 2 } }]", 0).expect("書ける"),
            ["- a: 1", "  b:", "      c: 2"]
        );
    }

    #[test]
    fn edit_restyle_refuses_flow_blocks_it_cannot_write_as_written() {
        for text in [
            "[a, # メモ\n]",
            "&r { a: 1 }",
            "[*a]",
            "[!!str a]",
            "{ ? a : 1 }",
            "[a: b]",
            "[\"a\nb\"]",
            "[a\n b]",
            "{ a: 1 } # メモ",
            "[[a]]",
        ] {
            assert!(written(text, 0).is_none(), "{text:?}");
        }
    }
}
