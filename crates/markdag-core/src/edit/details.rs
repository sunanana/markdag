// 原文なし。
// 詳細の書き換え (setDetails)。項目の詳細は 1 行目のあと最初の子の前にある引用、見出しの詳細は見出しのすぐ下 (空行だけをはさんでよい) の引用で、
// どちらも引用の中の怠惰な続きの行 (行頭に > のない続きの行) を含む。入力を改行で行に分け、先頭と末尾の空の行を外して、
// 行ごとに `> ` で書く (空の行は `>` だけ。項目は子の項目の字下げ、見出しは字下げなし)。書いてある詳細の行があれば怠惰な続きの行ごと全部を外し、
// 最初の詳細の行の位置に書く (中身が今と同じでも、怠惰な続きの行があれば > 付きで書き直す)。なければ、項目は 1 行目とそれに続く同じ段落の行のあと、最初の子の前に入れ、見出しは見出しの行
// (下線の見出しは下線の行) のすぐ次に入れて、そのすぐ次の行が空でなければ空行を 1 つはさむ (次の段落が引用の続きに読まれないように)。
// 空の入力は詳細の行を外し、重なった空行を詰める。容器と行のないルート、表とコードと画像は断る。
// markdag キーのない文書は、書き換えが要るときだけ markdag: を足してから書く (詳細は markdag キーのある文書でだけ抜き出されるため)。
// 書いたあとの原文を解析し直し、本文の形が変わらず、詳細がねらいの文字と、書いた行の引用 1 つに読まれることを確かめる。
use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::blocks::ParsedSource;
use super::frontmatter::Marking;
use super::lines::{LinePlan, carriage_of, collapse_blank_runs, cut_lines, is_blank};
use super::names::input_lines;
use super::shape::{Indentation, LineShape, nested_shape};
use super::verify::{Expectation, keeps_structure, target_of};
use super::{STALE_NODE, STRUCTURE_CHANGED, refused, unchanged};
use crate::model::util::js_trim;
use crate::types::{
    EditReasonCode, EditSelection, EditSourceResult, NodeKind, NodeTarget, OutlineNode,
};

// 解析が詳細として抜き出した引用ブロックの行の範囲 (data-lines は 0 始まりで終わりを含まない、原文の行)
static DETAILS_QUOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<blockquote data-lines="([0-9]+),([0-9]+)" class="mdag-details">"#)
        .expect("固定の正規表現")
});

/// 見出しか項目の詳細を text にする (空なら詳細を外す)。選ぶのは同じノード
pub(super) fn set_details(source: &str, target: &NodeTarget, text: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let Some(node) = before.find(target) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    match before.kind_of(node) {
        NodeKind::Block => {
            return refused(
                EditReasonCode::BlockNode,
                "表、コード、画像のノードは詳細を持てないので、詳細を書けません",
            );
        }
        NodeKind::List | NodeKind::Root => {
            return refused(
                EditReasonCode::NoSourceLine,
                "このノードは原文に自分の行を持たない (リストの入れ物か、行のないルート) ので、詳細を書けません",
            );
        }
        NodeKind::Heading | NodeKind::Item => {}
    }
    let rows = detail_rows(text);
    let aim = (!rows.is_empty()).then(|| rows.join("\n"));
    // 同じかは今の詳細の読み方 (inspectNode の details) で比べる。markdag キーのない文書でも、変わらなければ markdag: を足さない。
    // ただし今の詳細に怠惰な続きの行があれば、中身が同じでも詳細の行を全部 > 付きで書き直す (図の詳細は変わらない)
    if before.details_of(node) == aim && !before.has_lazy_detail_lines(node) {
        return unchanged(EditReasonCode::NothingToChange, "詳細が今と同じです");
    }
    let marking = if before.parsed.extracted {
        None
    } else {
        match Marking::of(source, &before) {
            Ok(marking) => Some(marking),
            Err(result) => return result,
        }
    };
    let marked_text = marking
        .as_ref()
        .map_or(source, |marking| marking.text.as_str());
    let marked = ParsedSource::read(marked_text);
    let id = match &marking {
        Some(marking) => marking
            .ids(&before, &marked, &[node])
            .and_then(|ids| ids.first().copied()),
        None => Some(node.id),
    };
    let Some(node) = id.and_then(|id| marked.node(id)) else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    let (plan, written) = match details_plan(&marked, node, &rows, carriage_of(marked_text)) {
        Some(planned) => planned,
        None => return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED),
    };
    let selected = match verified(&marked, &plan, node.id, aim.as_deref(), written) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    EditSourceResult::Edited {
        splices: marking.as_ref().map_or_else(
            || plan.splices(),
            |marking| marking.plan.then(&plan).splices(),
        ),
        select: EditSelection::Nodes {
            nodes: vec![selected],
        },
        rename: None,
        notes: marking
            .as_ref()
            .map_or_else(Vec::new, |marking| marking.notes(&before)),
    }
}

// 詳細の入力を行に分けたもの。先頭と末尾の空の行 (空白だけの行を含む) を外す。空白だけの入力は行なし (詳細を外す)
fn detail_rows(text: &str) -> Vec<&str> {
    let rows = input_lines(text);
    let filled = |row: &str| !js_trim(row).is_empty();
    let Some(first) = rows.iter().position(|row| filled(row)) else {
        return Vec::new();
    };
    let last = rows.iter().rposition(|row| filled(row)).unwrap_or(first);
    rows[first..=last].to_vec()
}

// 詳細の行を書いた行の列と、書いた引用の行の位置 (書き換えたあとの行の添字。詳細を外したときは None)。
// 行の字下げは、項目は子の項目の字下げ (入れ子の幅、タブを使う文書は 4 桁ごとのタブ)、見出しは字下げなし
fn details_plan<'a>(
    read: &'a ParsedSource<'a>,
    node: &OutlineNode,
    rows: &[&str],
    carriage: &str,
) -> Option<(LinePlan<'a>, Option<Range<u32>>)> {
    let heading = read.kind_of(node) == NodeKind::Heading;
    let indent = if heading {
        String::new()
    } else {
        let Some(LineShape::Item { indent, .. }) = nested_shape(read, node, &Indentation::of(read))
        else {
            return None;
        };
        indent
    };
    let mut written: Vec<String> = rows
        .iter()
        .map(|row| {
            if row.is_empty() {
                format!("{indent}>{carriage}")
            } else {
                format!("{indent}> {row}{carriage}")
            }
        })
        .collect();
    let original = &read.lines;
    let quoted = read.detail_lines(node);
    let Some(&first) = quoted.first() else {
        // 詳細がなければ、項目は 1 行目とそれに続く同じ段落の行のあと、最初の子の前に入れ、見出しは見出しの行のすぐ次に入れる
        let at = if heading {
            node.lines.as_ref()?.end as usize
        } else {
            details_position(read, node)?
        };
        let mut plan = LinePlan::new(original);
        let range = span(at, written.len());
        // 見出しのすぐ次の行が空でなければ、空行を 1 つはさむ (段落などが引用の続きに読まれないように)
        if heading && plan.line(at).is_some_and(|line| !is_blank(line)) {
            written.push(carriage.to_string());
        }
        if at == plan.len() {
            // 改行で終わらない文書の末尾: 前の最後の行に \r を足し、書く最後の行には付けない (単独の \r を作らない)
            if let Some(last) = written.last_mut()
                && last.ends_with('\r')
            {
                last.pop();
            }
            let previous = plan.line(at - 1)?.to_string();
            if !carriage.is_empty() {
                plan.rewrite(at - 1, format!("{previous}{carriage}"));
            }
        }
        plan.insert(at, written);
        return Some((plan, Some(range)));
    };
    // 外す行: 詳細の行と、2 つ以上の引用ブロックに分かれた詳細の間の空行 (間が空行だけのもの)
    let mut removed = vec![false; original.len()];
    for index in &quoted {
        removed[*index as usize] = true;
    }
    for pair in quoted.windows(2) {
        let between = pair[0] as usize + 1..pair[1] as usize;
        if original
            .get(between.clone())
            .is_some_and(|lines| lines.iter().all(|line| is_blank(line)))
        {
            removed[between].fill(true);
        }
    }
    if written.is_empty() {
        // 詳細を外す: 重なった空行を詰める (文書の終わり方は消すときの規則で保つ)
        return Some((cut_lines(original, &removed), None));
    }
    // 書いてある詳細の行を全部外し、最初の詳細の行の位置に書く。外した所をはさんで重なった空行は詰める
    removed[first as usize] = false;
    collapse_blank_runs(original, &mut removed);
    // 改行で終わる文書の最後の空の要素は外さない (改行で終わる形を保つ)
    if original.last() == Some(&"")
        && let Some(last) = removed.last_mut()
    {
        *last = false;
    }
    let ends_changed = removed.last() == Some(&true) || first as usize + 1 == original.len();
    let mut plan = LinePlan::new(original);
    for index in (0..original.len()).rev().filter(|index| removed[*index]) {
        plan.remove(index, 1);
    }
    let at = first as usize;
    let range = span(at, written.len());
    plan.remove(at, 1);
    let end = at + written.len();
    plan.insert(at, written);
    if ends_changed {
        // 原文の最後の行を外したら、書いた行のあとに残った空行を外し、新しい最後の行の \r を外す
        // (改行で終わらない形を保ち、単独の \r を作らない)
        while plan.len() > end && plan.line(plan.len() - 1).is_some_and(is_blank) {
            plan.remove(plan.len() - 1, 1);
        }
        if let Some(last) = plan.len().checked_sub(1)
            && let Some(content) = plan.line(last).and_then(|line| line.strip_suffix('\r'))
        {
            let content = content.to_string();
            plan.rewrite(last, content);
        }
    }
    Some((plan, Some(range)))
}

// 項目の詳細を足す位置: 1 行目と、それに続く同じ段落の行 (空でなく、フェンスの書き始めでない行) のあと。最初の子の前で止まる
fn details_position(read: &ParsedSource<'_>, node: &OutlineNode) -> Option<usize> {
    let start = node.lines.as_ref()?.start;
    let limit = read.children_start(node);
    let mut at = start + 1;
    while at < limit
        && read
            .lines
            .get(at as usize)
            .is_some_and(|line| !is_blank(line))
        && !read.is_fence_line(at)
    {
        at += 1;
    }
    Some(at as usize)
}

fn span(at: usize, count: usize) -> Range<u32> {
    let start = u32::try_from(at).unwrap_or(u32::MAX);
    start..start.saturating_add(u32::try_from(count).unwrap_or(u32::MAX))
}

// 書き換えたあとの原文を解析し直し、本文の形 (ノードの数、親子、名前、種類) が変わらず、そのノードの詳細がねらいの文字に読まれ、
// 解析が詳細として抜き出す引用が書いた行のちょうど 1 つ (詳細を外したときはなし) か。通れば、そのノードを指すもの
fn verified(
    before: &ParsedSource<'_>,
    plan: &LinePlan<'_>,
    id: u32,
    aim: Option<&str>,
    written: Option<Range<u32>>,
) -> Result<NodeTarget, EditSourceResult> {
    let text = plan.text();
    let after = ParsedSource::read(&text);
    let Some(correspondence) =
        keeps_structure(before, &after, &plan.splices(), &Expectation::default())
    else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    let Some(node) = correspondence
        .new_id(id)
        .and_then(|new_id| after.node(new_id))
    else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    let quotes = quote_ranges(node);
    let read_back = after.details_of(node);
    if read_back.as_deref() != aim
        || node.details.is_some() != aim.is_some()
        || quotes != written.into_iter().collect::<Vec<_>>()
    {
        return Err(refused(
            EditReasonCode::StructureChanged,
            "書いた詳細が、書いたとおりの引用として読まれない (前後の行が引用に続けて読まれるなど) ので、書き換えません",
        ));
    }
    Ok(target_of(node))
}

// 解析がそのノードの詳細として抜き出した引用ブロックの行の範囲 (原文の行。文書の順)
fn quote_ranges(node: &OutlineNode) -> Vec<Range<u32>> {
    DETAILS_QUOTE
        .captures_iter(&node.html)
        .filter_map(|found| {
            let start = found.get(1)?.as_str().parse().ok()?;
            let end = found.get(2)?.as_str().parse().ok()?;
            Some(start..end)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_details_regexes_compile() {
        LazyLock::force(&DETAILS_QUOTE);
    }

    #[test]
    fn edit_details_rows_split_on_every_line_break() {
        assert_eq!(
            detail_rows("a\r\nb\rc\nd\u{2028}e\u{2029}f"),
            ["a", "b", "c", "d", "e", "f"]
        );
        assert_eq!(detail_rows("1 行目\n\n3 行目"), ["1 行目", "", "3 行目"]);
    }
}
