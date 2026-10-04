// 原文なし。
// 原文の行の扱い。行は split('\n') の要素で、行末の \r は行の中身に含める (書き換える行も \r を残す)。
// 解析と行の数え方が食い違う文書 (単独の \r を含むもの) は、単独の \r を文書の改行にそろえた原文にして書き換える。
// 行の差し替えの列を原文に当てる形は包みの継ぎ足しと同じ。書き換えを何段かに分けたときは、段ごとの差し替えの列を重ねて
// 原文に当てる 1 つの列にする。
// 書き換えたあとの行の列 (LinePlan) は、行ごとに原文のどの行から来たかを持ち、原文のまま残す行を含めない差し替えの列を組む。
// ブロックを消すか切り出すときの空行の詰め方と、文書の終わり方 (改行で終わるか) の保ち方もここで決める。
use crate::types::LineSplice;

/// 単独の \r (すぐあとが \n でない \r) を含むか。comrak は単独の \r でも行を分けるので、split('\n') の行と合わない
pub(super) fn has_lone_carriage_return(source: &str) -> bool {
    let bytes = source.as_bytes();
    bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| *byte == b'\r' && bytes.get(index + 1) != Some(&b'\n'))
}

/// 単独の \r を全部、文書の最初の \n の改行 (\r\n か \n。\n がなければ \n) にそろえる書き換え。
/// 単独の \r がなければ None。そろえても解析が読むノードは変わらない (comrak は単独の \r でも行を分けるため)
pub(super) fn aligned_line_endings(source: &str) -> Option<(Vec<LineSplice>, String)> {
    if !has_lone_carriage_return(source) {
        return None;
    }
    let carriage = carriage_of(source);
    let original: Vec<&str> = source.split('\n').collect();
    let last = original.len().saturating_sub(1);
    let mut plan = LinePlan::new(&original);
    // 後ろの行から当てる (行を足すと後ろの行の位置がずれるため)
    for (index, line) in original.iter().enumerate().rev() {
        // 最後の行のほかは、行末の \r は \r\n の \r なので行の終わりに残す
        let (content, end) = match line.strip_suffix('\r') {
            Some(content) if index != last => (content, "\r"),
            _ => (*line, ""),
        };
        if !content.contains('\r') {
            continue;
        }
        let parts: Vec<&str> = content.split('\r').collect();
        let count = parts.len();
        let written: Vec<String> = parts
            .iter()
            .enumerate()
            .map(|(at, part)| {
                let ending = if at + 1 == count { end } else { carriage };
                format!("{part}{ending}")
            })
            .collect();
        let mut written = written.into_iter();
        if let Some(first) = written.next() {
            plan.rewrite(index, first);
        }
        plan.insert(index + 1, written.collect());
    }
    Some((plan.splices(), plan.text()))
}

/// first (原文 → 中間の原文) の差し替えの列のあとに second (中間の原文 → 結果) を重ねた、原文 → 結果の差し替えの列
pub(super) fn composed(
    source: &str,
    first: &[LineSplice],
    second: &[LineSplice],
) -> Vec<LineSplice> {
    if first.is_empty() {
        return second.to_vec();
    }
    let original: Vec<&str> = source.split('\n').collect();
    let before = LinePlan::from_splices(&original, first);
    let middle: Vec<String> = (0..before.len())
        .filter_map(|at| before.line(at).map(str::to_string))
        .collect();
    let middle: Vec<&str> = middle.iter().map(String::as_str).collect();
    let after = LinePlan::from_splices(&middle, second);
    before.then(&after).splices()
}

/// 行を中身と行末の \r (なければ空) に分ける
pub(super) fn split_carriage(line: &str) -> (&str, &str) {
    match line.strip_suffix('\r') {
        Some(content) => (content, "\r"),
        None => (line, ""),
    }
}

/// 空白とタブだけの行か (行末の \r を除いて)
pub(super) fn is_blank(line: &str) -> bool {
    split_carriage(line)
        .0
        .chars()
        .all(|c| matches!(c, ' ' | '\t'))
}

/// 足す行の行末: 文書の最初の改行が \r\n なら \r (改行のない文書は LF)
pub(super) fn carriage_of(source: &str) -> &'static str {
    let crlf = source
        .find('\n')
        .is_some_and(|newline| source[..newline].ends_with('\r'));
    if crlf { "\r" } else { "" }
}

/// 行の差し替えの列 (start の昇順、重ならない) を原文に当てる (包みの継ぎ足しと同じ形。書き換えの結果を確かめるテストが使う)
#[cfg(test)]
pub(super) fn apply_splices(source: &str, splices: &[LineSplice]) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut next = 0;
    for splice in splices {
        let start = (splice.start as usize).min(lines.len());
        out.extend(lines.get(next..start).unwrap_or_default());
        out.extend(splice.lines.iter().map(String::as_str));
        next = (start + splice.delete_count as usize).min(lines.len());
    }
    out.extend(lines.get(next..).unwrap_or_default());
    out.join("\n")
}

/// 書き換えたあとの 1 行の出どころ
#[derive(Debug, Clone, PartialEq)]
pub(super) enum PlannedLine {
    /// 原文の行 (添字) をそのまま残す
    Kept(u32),
    /// 原文の行 (添字) を同じ位置で書き直す (行末の \r の付け外し)
    Rewritten(u32, String),
    /// 新しく書く行 (足す行、はさむ空行、付け替えで書き直して動かす行)
    Written(String),
}

/// 書き換えたあとの行の列。行ごとに原文のどの行から来たかを持ち、原文に当てる行の差し替えの列を組む
pub(super) struct LinePlan<'a> {
    original: &'a [&'a str],
    lines: Vec<PlannedLine>,
}

impl<'a> LinePlan<'a> {
    /// 原文の行を全部そのまま残す列
    pub(super) fn new(original: &'a [&'a str]) -> Self {
        let count = u32::try_from(original.len()).unwrap_or(u32::MAX);
        LinePlan {
            original,
            lines: (0..count).map(PlannedLine::Kept).collect(),
        }
    }

    /// 原文に差し替えの列 (start の昇順、重ならない) を当てた列。差し替えの先頭の行は、消す行があれば原文のその行を同じ位置で
    /// 書き直したものとして持つ (splices の逆)
    pub(super) fn from_splices(original: &'a [&'a str], splices: &[LineSplice]) -> Self {
        let mut plan = LinePlan::new(original);
        for splice in splices.iter().rev() {
            let start = (splice.start as usize).min(plan.lines.len());
            let end = start
                .saturating_add(splice.delete_count as usize)
                .min(plan.lines.len());
            let mut written: Vec<PlannedLine> = splice
                .lines
                .iter()
                .map(|line| PlannedLine::Written(line.clone()))
                .collect();
            if end > start
                && let Some(PlannedLine::Written(text)) = written.first()
            {
                let index = u32::try_from(start).unwrap_or(u32::MAX);
                written[0] = if original.get(start) == Some(&text.as_str()) {
                    PlannedLine::Kept(index)
                } else {
                    PlannedLine::Rewritten(index, text.clone())
                };
            }
            plan.lines.splice(start..end, written);
        }
        plan
    }

    pub(super) fn len(&self) -> usize {
        self.lines.len()
    }

    /// 書き換えたあとの原文 (行を \n でつないだもの)
    pub(super) fn text(&self) -> String {
        (0..self.lines.len())
            .filter_map(|at| self.line(at))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// at 番目の行の字 (行末の \r を含む)
    pub(super) fn line(&self, at: usize) -> Option<&str> {
        match self.lines.get(at)? {
            PlannedLine::Kept(index) => self.original.get(*index as usize).copied(),
            PlannedLine::Rewritten(_, text) | PlannedLine::Written(text) => Some(text),
        }
    }

    /// at の位置 (at 番目の行の前。列の長さなら末尾) に新しい行を差し込む
    pub(super) fn insert(&mut self, at: usize, lines: Vec<String>) {
        let at = at.min(self.lines.len());
        self.lines
            .splice(at..at, lines.into_iter().map(PlannedLine::Written));
    }

    /// at 番目から count 行を外す
    pub(super) fn remove(&mut self, at: usize, count: usize) {
        let start = at.min(self.lines.len());
        let end = at.saturating_add(count).min(self.lines.len());
        self.lines.drain(start..end);
    }

    /// at 番目の行を書き直す。原文の行は出どころを保ち、原文と同じ字に戻れば原文のまま残す行として扱う
    pub(super) fn rewrite(&mut self, at: usize, text: String) {
        let Some(line) = self.lines.get_mut(at) else {
            return;
        };
        *line = match origin(line) {
            Some(index) if self.original.get(index as usize) == Some(&text.as_str()) => {
                PlannedLine::Kept(index)
            }
            Some(index) => PlannedLine::Rewritten(index, text),
            None => PlannedLine::Written(text),
        };
    }

    /// next (この列の行を原文として書き換えた列) を重ねて、この列の原文から書き換えた列にする
    pub(super) fn then(&self, next: &LinePlan<'_>) -> LinePlan<'a> {
        let mut plan = LinePlan {
            original: self.original,
            lines: Vec::with_capacity(next.lines.len()),
        };
        for line in &next.lines {
            let (index, text) = match line {
                PlannedLine::Kept(index) => (*index as usize, None),
                PlannedLine::Rewritten(index, text) => (*index as usize, Some(text)),
                PlannedLine::Written(text) => {
                    plan.lines.push(PlannedLine::Written(text.clone()));
                    continue;
                }
            };
            let Some(source) = self.lines.get(index) else {
                // next の原文はこの列の行なので、ここには来ない
                let text = text.map_or_else(
                    || {
                        next.original
                            .get(index)
                            .copied()
                            .unwrap_or_default()
                            .to_string()
                    },
                    Clone::clone,
                );
                plan.lines.push(PlannedLine::Written(text));
                continue;
            };
            plan.lines.push(source.clone());
            if let Some(text) = text {
                let at = plan.lines.len() - 1;
                plan.rewrite(at, text.clone());
            }
        }
        plan
    }

    /// 原文に当てる行の差し替えの列 (start の昇順、重ならない)。原文のまま残す行は含めない (包みが原文の字のまま残す)。
    /// 書き直す原文の行は差し替えの先頭に置く (その行は差し替えの中の同じ位置に写るので、行の写しで追える)
    pub(super) fn splices(&self) -> Vec<LineSplice> {
        let mut splices: Vec<LineSplice> = Vec::new();
        // 組みかけの差し替えと、次に出てくるはずの原文の行
        let mut open: Option<LineSplice> = None;
        let mut next: u32 = 0;
        for line in &self.lines {
            match line {
                PlannedLine::Kept(index) => {
                    close(&mut splices, &mut open, next, *index);
                    next = index + 1;
                }
                PlannedLine::Rewritten(index, text) => {
                    close(&mut splices, &mut open, next, *index);
                    open = Some(LineSplice {
                        start: *index,
                        delete_count: 0,
                        lines: vec![text.clone()],
                    });
                    next = index + 1;
                }
                PlannedLine::Written(text) => open
                    .get_or_insert_with(|| LineSplice {
                        start: next,
                        delete_count: 0,
                        lines: Vec::new(),
                    })
                    .lines
                    .push(text.clone()),
            }
        }
        let count = u32::try_from(self.original.len()).unwrap_or(u32::MAX);
        close(&mut splices, &mut open, next, count);
        splices
    }
}

fn origin(line: &PlannedLine) -> Option<u32> {
    match line {
        PlannedLine::Kept(index) | PlannedLine::Rewritten(index, _) => Some(*index),
        PlannedLine::Written(_) => None,
    }
}

// 組みかけの差し替えを、原文の until の行の前までを消すものとして閉じる。組みかけがなく行が飛んでいれば、飛んだ行を消す差し替え
fn close(splices: &mut Vec<LineSplice>, open: &mut Option<LineSplice>, next: u32, until: u32) {
    match open.take() {
        Some(mut splice) => {
            splice.delete_count = until.saturating_sub(splice.start);
            splices.push(splice);
        }
        None if until > next => splices.push(LineSplice {
            start: next,
            delete_count: until - next,
            lines: Vec::new(),
        }),
        None => {}
    }
}

/// 原文から cut が真の行 (消すか切り出すブロック) を外した行の列。
/// 外した所の前後の空行が重なれば、後ろの空行を外して 1 つにする。外した行のあとに空でない行が残らなければ (文書の最後のブロック)、
/// 前に残る空行も外す (改行で終わる文書は最後の改行を残す)。原文の最後の行を外したら、新しい最後の行の \r を外す
/// (改行で終わらない形を保ち、単独の \r を作らない)
pub(super) fn cut_lines<'a>(original: &'a [&'a str], cut: &[bool]) -> LinePlan<'a> {
    let count = original.len();
    let mut removed: Vec<bool> = (0..count)
        .map(|index| cut.get(index).copied().unwrap_or(false))
        .collect();
    let blank = |index: usize| original.get(index).is_some_and(|line| is_blank(line));
    // 文書の最後のブロックを外したとき: 残る最後の空でない行のあとの空行を外す
    if let Some(last) = removed.iter().rposition(|cut| *cut)
        && (last + 1..count).all(blank)
    {
        let end = if original.last() == Some(&"") {
            count - 1
        } else {
            count
        };
        let mut index = end;
        while index > 0 && (removed[index - 1] || blank(index - 1)) {
            removed[index - 1] = true;
            index -= 1;
        }
    }
    collapse_blank_runs(original, &mut removed);
    let mut plan = LinePlan::new(original);
    plan.lines = plan
        .lines
        .into_iter()
        .zip(&removed)
        .filter(|(_, removed)| !**removed)
        .map(|(line, _)| line)
        .collect();
    if removed.last() == Some(&true)
        && let Some(at) = plan.len().checked_sub(1)
        && let Some(line) = plan.line(at)
        && let Some(content) = line.strip_suffix('\r')
    {
        let content = content.to_string();
        plan.rewrite(at, content);
    }
    plan
}

/// 外す行 (removed が真の行) をはさんで空行が続けば、外す行の前の空行だけを残すよう、後ろの空行にも外す印を付ける。
/// 外す行に関わらない既存の空行の並びは変えない
pub(super) fn collapse_blank_runs(original: &[&str], removed: &mut [bool]) {
    let mut in_blank_run = false;
    let mut crossed = false;
    for (line, removed) in original.iter().zip(removed.iter_mut()) {
        if *removed {
            crossed |= in_blank_run;
            continue;
        }
        if !is_blank(line) {
            in_blank_run = false;
            crossed = false;
        } else if in_blank_run && crossed {
            *removed = true;
        } else if !in_blank_run {
            in_blank_run = true;
            crossed = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_of<'a>(original: &'a [&'a str], lines: Vec<PlannedLine>) -> LinePlan<'a> {
        LinePlan { original, lines }
    }

    #[test]
    fn edit_line_plan_splices_skip_kept_lines_and_start_at_rewritten_ones() {
        let original = ["a", "b", "c", "d"];
        let plan = plan_of(
            &original,
            vec![
                PlannedLine::Kept(0),
                PlannedLine::Written("x".to_string()),
                PlannedLine::Rewritten(2, "C".to_string()),
                PlannedLine::Written("y".to_string()),
            ],
        );
        let splices = plan.splices();
        let source = original.join("\n");
        assert_eq!(apply_splices(&source, &splices), "a\nx\nC\ny");
        // 書き直す行 (2) は差し替えの先頭にあり、その前に書く行は別の差し替え
        assert_eq!(
            splices,
            [
                LineSplice {
                    start: 1,
                    delete_count: 1,
                    lines: vec!["x".to_string()]
                },
                LineSplice {
                    start: 2,
                    delete_count: 2,
                    lines: vec!["C".to_string(), "y".to_string()]
                },
            ]
        );
    }

    #[test]
    fn edit_line_plan_cut_collapses_blank_lines_and_keeps_the_document_end() {
        let cut = |source: &str, lines: &[usize]| -> String {
            let original: Vec<&str> = source.split('\n').collect();
            let flags: Vec<bool> = (0..original.len())
                .map(|index| lines.contains(&index))
                .collect();
            let plan = cut_lines(&original, &flags);
            apply_splices(source, &plan.splices())
        };
        assert_eq!(cut("x\n\na\n\ny\n", &[2]), "x\n\ny\n");
        assert_eq!(cut("x\n\na\n\nb\n\ny\n", &[2, 4]), "x\n\ny\n");
        assert_eq!(cut("x\n\na\n", &[2]), "x\n");
        assert_eq!(cut("x\n\na", &[2]), "x");
        assert_eq!(cut("x\r\n\r\na", &[2]), "x");
        // 書き直した行も、次の書き換えで重ねられる
        let original = ["x", "y\r", "z"];
        let first = cut_lines(&original, &[false, false, true]);
        let middle: Vec<String> = (0..first.len())
            .filter_map(|at| first.line(at).map(str::to_string))
            .collect();
        let middle: Vec<&str> = middle.iter().map(String::as_str).collect();
        let mut second = LinePlan::new(&middle);
        second.rewrite(1, "y\r".to_string());
        second.insert(2, vec!["w".to_string()]);
        let source = original.join("\n");
        assert_eq!(
            apply_splices(&source, &first.then(&second).splices()),
            "x\ny\r\nw"
        );
    }
}
