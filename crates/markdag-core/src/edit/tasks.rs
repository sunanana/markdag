// 原文なし。
// タスクの記号の付け外し (toggleTaskMark)。指したノードのうち、記号を書けるもの (原文に自分の行を持つ見出しと項目。下線の見出しとルートの見出しも) と、
// 記号を外せないタスクだけを見て、1 つでもタスクでないものがあれば、タスクでないものの 1 行目の行頭の印 (字下げ、リストの印か番号、見出しの #) のあとに
// 未着手の記号 `[ ] ` を書き (タスクのものは状態のまま)、全部タスクなら、外せるものの記号を状態によらず (`[ ]`、`[/]`、`[x]`、`[X]`、`[-]`)
// あとの空白ごと外す。書けないノードは知らせずに飛ばし、1 つも書けなければ断る。書けないノードは、容器、行を持たないルート、表とコードと画像、
// 名前が空の項目 (記号を書くと解析が記号を名前 `[ ]` に読む)、1 行目が文章でない項目 (1 行目の印のあとが、Markdown として段落の書き始めでないもの。
// markdag キーの有無によらない。記号を書くと Markdown の表示で記号がコードの字になったりブロックの前に出たりする。1 行目が空で 2 行目から名前を読む項目も)、
// 記号を外すと本文が HTML のブロックとして読まれて見出しでなくなる下線の見出しのタスク。名前が HTML のブロックで始まる項目は、記号の有無で
// Markdown の表示が記号のほか変わらないので、`\` を足さずに付け外しする。ただし書いてみて図の形か名前が変わるもの (すぐ下の行を HTML のブロックが
// 飲み込むかが変わるものなど) は、付けるなら 1 行目が文章でない項目、外すなら記号を外すと HTML として読まれるタスクとして書かない。
// 断る理由は、書けないノードが全部同じ理由ならその理由 (名前を付けるよう求める文など)、そうでなければタスクにできないことだけを言う。
// 行頭の印、本文、本文のあとの印 (%、#、$) は変えない。記号を外したあとの本文の書き始めがブロックかタスクの記号か区切り線に読まれるなら、
// 名前の変更と同じく `\` で逃がす (HTML のブロックの書き始めは逃がさない)。名前が空のタスク (`- [ ] ` だけの行。解析は記号そのものを名前 `[ ]` に読む) は、
// 記号を消さずに `\` で逃がし (`- \[ ]`)、同じ名前のタスクでない項目として残す (消すと名前が空の項目になり、図からノードが消えるため)。
// 1 行目を同じ位置で書き直すので、行末の \r と最後の改行の有無はそのまま残る。
// 文書の先頭の BOM は、1 行目のノードの記号を付けるか外すときだけ外し、外したことを知らせに足す (解析は BOM のすぐあとのタスクの記号を読まず、
// marked も BOM のある 1 行目をリストにも見出しにも読まないので、BOM を残すと書いたとおりに読まれない)。
// 書いたあとの原文を解析し直し、本文の形 (名前を含む) と全部のノードの末尾の印が変わらず、書いたノードだけがねらいのタスクの状態
// (未着手か、タスクでない) に読まれ、書いていないノードのタスクの状態が変わらないことを確かめる。付けたノードは、内容に未着手の印の絵が足されたほかは
// 書く前と同じであることも確かめる (記号がタスクの印でなくコードの字などに読まれる書き換えを、書けるかの判定とは別に断る)。
// 選ぶのは指したノードの全部 (飛ばしたものも)
use std::sync::LazyLock;

use regex::Regex;

use super::blocks::{BOM, FirstLine, ParsedSource, display_name};
use super::lines::LinePlan;
use super::names::unmarked_body;
use super::tags::selected;
use super::verify::{Expectation, keeps_structure, same_trailing_marks, target_of};
use super::{STRUCTURE_CHANGED, refused};
use crate::parse::task::task_mark_of;
use crate::parse::{LineBlock, line_block};
use crate::types::{
    EditNote, EditNoteCode, EditReasonCode, EditSelection, EditSourceResult, NodeKind, NodeTarget,
    OutlineNode, TaskState,
};

// タスクにできるノードを 1 つも指していないときの断る文 (GUI の通知にそのまま出るので、Markdown の用語を並べない)
const NOT_TASKABLE: &str = "このノードはタスクにできません";

// 指したノードが全部、名前が空の項目のときの断る文
const UNNAMED: &str = "名前が空の項目はタスクにできません。先に名前を付けてください";

// 指したノードが全部、1 行目が文章でない項目のときの断る文
const NOT_TEXT: &str = "1 行目が文章でない項目はタスクにできません";

// タスク解除で、指したタスクが全部、記号を外すと本文が HTML のブロックとして読まれて見出しでなくなるもの (下線の見出し) のときの断る文
const HTML_AFTER_UNMARK: &str =
    "タスクの記号を外すと HTML として読まれるため、タスク解除できません";

// 1 行目のノードの記号を付けるか外すために、文書の先頭の BOM を外したときの知らせ
const BOM_REMOVED: &str = "タスクの記号は文書の先頭の BOM (U+FEFF) のすぐあとでは読まれないので、文書の先頭の BOM を外しました";

// 付ける記号。足すノードの行頭と同じく、いつも未着手
const TODO_MARK: &str = "[ ]";

// リストの印のあとの空白がこの桁数以上なら、項目の中身は字下げのコード (CommonMark)
const CODE_INDENT: usize = 5;

// タスクの内容の、状態の印の絵とあとの空白 (内容の頭か、番号付きの項目では番号のあとに 1 つ)
static TASK_ICON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<svg(?s:.)*?</svg> ").expect("固定の正規表現"));

// 記号の付け外しでノードを書けない理由
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unwritable {
    // 見出しと項目でないか、自分の行を持たない (容器、行を持たないルート、表とコードと画像)
    NoLine,
    Unnamed,
    NotText,
    HtmlAfterUnmark,
}

/// 指したノードのタスクの記号の付け外し: 書けるノードのうち 1 つでもタスクでないものがあればそれに付け、なければ外せるタスクの記号を外す。
/// 選ぶのは指したノードの全部
pub(super) fn toggle_task_mark(source: &str, targets: &[NodeTarget]) -> EditSourceResult {
    let (before, nodes) = match selected(source, targets) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    let blocked: Vec<Option<Unwritable>> =
        nodes.iter().map(|node| unwritable(&before, node)).collect();
    let adding = nodes
        .iter()
        .zip(&blocked)
        .any(|(node, block)| node.task.is_none() && block.is_none());
    let writing: Vec<&OutlineNode> = nodes
        .iter()
        .zip(&blocked)
        .filter(|(node, block)| block.is_none() && node.task.is_none() == adding)
        .map(|(node, _)| node)
        .collect();
    if writing.is_empty() {
        return nothing_written(&before, &nodes, &blocked);
    }
    let mut plan = LinePlan::new(&before.lines);
    let mut written: Vec<u32> = Vec::with_capacity(writing.len());
    let mut bom_removed = false;
    for node in writing {
        let Some(first) = before.first_line(node) else {
            return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
        };
        bom_removed |= first.marker.starts_with(BOM);
        let text = match &node.task {
            None => Some(marked_line(&first)),
            Some(task) => unmarked_line(
                &first,
                before.kind_of(node) == NodeKind::Heading,
                task.state,
            ),
        };
        let Some(text) = text else {
            return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
        };
        plan.rewrite(first.index as usize, text);
        written.push(node.id);
    }
    let aim = adding.then_some(TaskState::Todo);
    let selected = match verified(&before, &plan, &nodes, &written, aim) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    // BOM を外したことは、frontmatter を作る操作と同じく知らせに足す (GUI のスナックバーはこの知らせを出さない)
    let notes = if bom_removed {
        vec![EditNote {
            code: EditNoteCode::BomRemoved,
            count: 1,
            message: BOM_REMOVED.to_string(),
        }]
    } else {
        Vec::new()
    };
    EditSourceResult::Edited {
        splices: plan.splices(),
        select: EditSelection::Nodes { nodes: selected },
        rename: None,
        notes,
    }
}

/// 記号の付け外しがノードを書けるか: タスクでないノードは記号を付けられるか、タスクは記号を外せるか (原文の事実の canToggleTask)
pub(super) fn can_toggle(read: &ParsedSource<'_>, node: &OutlineNode) -> bool {
    unwritable(read, node).is_none()
}

// 書けるノードがないときの断り。記号を外せないタスクを指していれば、しようとしたのはタスク解除なのでその理由。
// そうでなければ、書けない理由が全部同じならその理由、違えば種類で決めた理由で、タスクにできないことだけを言う
fn nothing_written(
    read: &ParsedSource<'_>,
    nodes: &[OutlineNode],
    blocked: &[Option<Unwritable>],
) -> EditSourceResult {
    if blocked.contains(&Some(Unwritable::HtmlAfterUnmark)) {
        return refused(EditReasonCode::MarkerLine, HTML_AFTER_UNMARK);
    }
    let all = |reason: Unwritable| blocked.iter().all(|block| *block == Some(reason));
    if all(Unwritable::Unnamed) {
        return refused(EditReasonCode::EmptyName, UNNAMED);
    }
    if all(Unwritable::NotText) {
        return refused(EditReasonCode::MarkerLine, NOT_TEXT);
    }
    let code = if nodes
        .iter()
        .any(|node| read.kind_of(node) == NodeKind::Block)
    {
        EditReasonCode::BlockNode
    } else if blocked.contains(&Some(Unwritable::NoLine)) {
        EditReasonCode::NoSourceLine
    } else {
        EditReasonCode::MarkerLine
    };
    refused(code, NOT_TASKABLE)
}

// 記号の付け外しでノードを書けない理由。書ければ None
fn unwritable(read: &ParsedSource<'_>, node: &OutlineNode) -> Option<Unwritable> {
    let kind = read.kind_of(node);
    let first = match kind {
        NodeKind::Heading | NodeKind::Item if node.lines.is_some() => read.first_line(node),
        _ => None,
    };
    let Some(first) = first else {
        return Some(Unwritable::NoLine);
    };
    if node.task.is_some() {
        let html = html_after_unmark(kind, &first)
            || (kind == NodeKind::Item
                && line_block(&format!("{}{}", first.body, first.rest)) == LineBlock::Html
                && !keeps_reading(read, node, &first));
        return html.then_some(Unwritable::HtmlAfterUnmark);
    }
    if kind == NodeKind::Item {
        match first_line_read(read, node, &first) {
            FirstLineRead::NotText => return Some(Unwritable::NotText),
            FirstLineRead::Html if !keeps_reading(read, node, &first) => {
                return Some(Unwritable::NotText);
            }
            _ => {}
        }
    }
    first.body.is_empty().then_some(Unwritable::Unnamed)
}

// 項目の 1 行目の中身を Markdown (CommonMark) として読んだときの形
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FirstLineRead {
    // 段落の書き始め (1 行目が空で名前もない項目を含む)
    Text,
    Html,
    // 字下げのコード、見出し、引用、リスト、柵、区切り線、参照の定義と、1 行目が空で名前を 2 行目から読む項目
    NotText,
}

// 項目の 1 行目の中身の形。1 行目の印のあとが空の項目は、名前もなければ文章とみなし (名前が空の項目として扱う)、名前を 2 行目から読むなら文章でない。
// ほかは markdag キーの有無によらず Markdown (CommonMark) の読み方で決める (キーのある文書の解析は 1 行目を文字とインラインだけで読む (A-219) が、
// 記号を書いた原文を Markdown として表示すると、記号がコードの字になったりブロックの前に出たりする)。印のあとの空白が 5 桁以上なら字下げのコード、
// そうでなければ印のあとの字が段落の書き始めなら文章。HTML のブロックの書き始めは別に返し、書けるかは呼ぶ側が書いてみて決める
fn first_line_read(
    read: &ParsedSource<'_>,
    node: &OutlineNode,
    first: &FirstLine<'_>,
) -> FirstLineRead {
    let content = format!(
        "{}{}{}",
        &first.lead[first.marker.len()..],
        first.body,
        first.rest
    );
    if content.trim_matches([' ', '\t']).is_empty() {
        return if has_name(read, node) {
            FirstLineRead::NotText
        } else {
            FirstLineRead::Text
        };
    }
    let marker = bare_marker(first);
    let mark = marker.trim_end_matches([' ', '\t']);
    let start = columns(0, mark);
    if columns(start, &marker[mark.len()..]) - start >= CODE_INDENT {
        return FirstLineRead::NotText;
    }
    match line_block(&content) {
        LineBlock::Paragraph => FirstLineRead::Text,
        LineBlock::Html => FirstLineRead::Html,
        LineBlock::OrderedList | LineBlock::Other => FirstLineRead::NotText,
    }
}

// 名前が HTML のブロックで始まる項目の記号を付けるか外しても、図の形と名前が変わらず、ねらいのタスクの状態に読まれ、内容が記号の絵のほか
// 変わらないか (書いてみて確かめる)。記号の有無で Markdown の表示は記号のほか変わらないが、markdag キーのない文書の解析は、記号がないと
// 1 行目を HTML のブロックとして読むので、すぐ下の行 (詳細の引用、子のリスト、名前の続きの行) を HTML のブロックが飲み込むかや、
// 番号付きの項目の名前が変わる形がある。付けるときの内容は書いたあとの確かめが見るので、外すときだけここで見る (付けると外すで、書けるかをそろえる)
fn keeps_reading(read: &ParsedSource<'_>, node: &OutlineNode, first: &FirstLine<'_>) -> bool {
    let (text, aim) = match &node.task {
        None => (Some(marked_line(first)), Some(TaskState::Todo)),
        Some(task) => (unmarked_line(first, false, task.state), None),
    };
    let Some(text) = text else {
        return false;
    };
    let mut plan = LinePlan::new(&read.lines);
    plan.rewrite(first.index as usize, text);
    if verified(read, &plan, std::slice::from_ref(node), &[node.id], aim).is_err() {
        return false;
    }
    aim.is_some()
        || ParsedSource::read(&plan.text())
            .node(node.id)
            .is_some_and(|unmarked| same_content_but_icon(node, unmarked))
}

// 図の名前があるか。番号付きの項目の名前の頭の番号 (`1.`) は数えない
fn has_name(read: &ParsedSource<'_>, node: &OutlineNode) -> bool {
    match read.list_number(node) {
        Some(number) => !node.ref_text.is_empty() && node.ref_text != format!("{number}."),
        None => !node.ref_text.is_empty(),
    }
}

// 行頭から start 桁の所に text を置いたあとの桁 (タブは 4 の倍数の桁まで進める)
fn columns(start: usize, text: &str) -> usize {
    text.chars().fold(start, |column, c| {
        if c == '\t' {
            column + 4 - column % 4
        } else {
            column + 1
        }
    })
}

// 記号を外すと本文が HTML のブロックとして読まれて見出しでなくなるタスクか: 本文が HTML のブロックの書き始めの下線の見出し
// (HTML のブロックが下線の行を飲み込む)。ATX の見出しの中は行内だけを読むので外しても見出しのまま。項目は記号の有無で Markdown の表示が
// 記号のほか変わらないので、`\` を足さずに外す
fn html_after_unmark(kind: NodeKind, first: &FirstLine<'_>) -> bool {
    let setext = kind == NodeKind::Heading
        && !bare_marker(first)
            .trim_start_matches([' ', '\t'])
            .starts_with('#');
    setext && first.task && line_block(first.body) == LineBlock::Html
}

// 1 行目の行頭の印から、文書の先頭の BOM を外したもの
fn bare_marker<'s>(first: &FirstLine<'s>) -> &'s str {
    first.marker.trim_start_matches(BOM)
}

// 1 行目の行頭の印 (字下げ、リストの印か番号、見出しの #、続く空白。下線の見出しは字下げだけ) のあとに未着手の記号と空白 1 つを書いた行。
// 解析が読まなかった記号の字 (BOM のすぐあとの記号) は、書く記号に置き換える
fn marked_line(first: &FirstLine<'_>) -> String {
    format!(
        "{}{TODO_MARK} {}{}{}",
        bare_marker(first),
        first.body,
        first.rest,
        first.carriage
    )
}

// 1 行目からタスクの記号とあとの空白を外した行。外したあとの本文の書き始めは逃がす。
// 名前が空のタスクは、記号を `\` で逃がして名前として残す。書く字は解析が読む名前の字 (状態 state の記号。大文字の X は名前では x) で、
// 後ろに何もなければ行末の空白を残さない。行頭の分け方が記号を読まない行 (解析とずれる行) は None
fn unmarked_line(first: &FirstLine<'_>, heading: bool, state: TaskState) -> Option<String> {
    let marker = bare_marker(first);
    let line = if first.task && !first.body.is_empty() {
        let body = unmarked_body(marker, first.body, first.rest, heading);
        format!("{marker}{body}{}", first.rest)
    } else if first.task || (first.marked && bare_task_mark(first.body)) {
        // 記号とあとの空白は、行頭の分け方が記号を読めば lead の中、記号のすぐあとに末尾の印が続けば本文と rest の頭にある
        let gap = if first.rest.is_empty() || !first.task {
            ""
        } else {
            &first.lead[first.marker.len() + TODO_MARK.len()..]
        };
        format!(
            "{marker}\\[{}]{gap}{}",
            task_mark_of(state).as_str(),
            first.rest
        )
    } else {
        return None;
    };
    Some(format!("{line}{}", first.carriage))
}

// タスクの記号だけか (`[ ]`、`[x]`、`[X]`、`[/]`、`[-]`)。記号のすぐあとに末尾の印が続く行 (`- [ ] %g`) は、
// 行頭の分け方が記号を読まず本文に入れるが、解析は記号を読んで名前を記号そのもの (`[ ]`) にする
fn bare_task_mark(body: &str) -> bool {
    matches!(
        body.as_bytes(),
        [b'[', b' ' | b'x' | b'X' | b'/' | b'-', b']']
    )
}

// 書き換えたあとの原文を解析し直し、本文の形 (ノードの数、親子、名前、種類、1 行目の行) と全部のノードの末尾の印が変わらず、
// 書いたノード (written) のタスクの状態が aim (未着手か、タスクでない) に、ほかのノードのタスクの状態が書き換える前のままに読まれるか。
// 付けたときは、書いたノードの内容に状態の印の絵が 1 つ足されたほかは変わらないか (記号がタスクの印として読まれたか) も見る。
// 通れば、指したノード (nodes の順) を指すもの
fn verified(
    before: &ParsedSource<'_>,
    plan: &LinePlan<'_>,
    nodes: &[OutlineNode],
    written: &[u32],
    aim: Option<TaskState>,
) -> Result<Vec<NodeTarget>, EditSourceResult> {
    let text = plan.text();
    let after = ParsedSource::read(&text);
    let Some(correspondence) =
        keeps_structure(before, &after, &plan.splices(), &Expectation::default())
    else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    for old in &before.parsed.nodes {
        let Some(new) = correspondence
            .new_id(old.id)
            .and_then(|new_id| after.node(new_id))
        else {
            return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
        };
        let state = new.task.as_ref().map(|task| task.state);
        if written.contains(&old.id) {
            if state != aim
                || !same_trailing_marks(old, new)
                || (aim.is_some() && !same_content_but_icon(new, old))
            {
                return Err(refused(
                    EditReasonCode::StructureChanged,
                    &format!(
                        "「{}」のタスクの記号を書き換えると、書いたとおりに読まれないので、書き換えません",
                        display_name(old)
                    ),
                ));
            }
        } else if state != old.task.as_ref().map(|task| task.state)
            || !same_trailing_marks(old, new)
        {
            return Err(refused(
                EditReasonCode::StructureChanged,
                "タスクの記号を書き換えると、ほかのノードの印まで変わって読まれるので、書き換えません",
            ));
        }
    }
    nodes
        .iter()
        .map(|node| {
            correspondence
                .new_id(node.id)
                .and_then(|new_id| after.node(new_id))
                .map(target_of)
        })
        .collect::<Option<Vec<NodeTarget>>>()
        .ok_or_else(|| refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED))
}

// タスクのノードの内容が、記号のないノードの内容に状態の印の絵 (とあとの空白) が 1 つ足されたものか。番号付きの項目では番号のあとに入る。
// 記号のないノードの内容の頭の改行 (1 行目が HTML のブロックの項目で、空の名前の文字との区切り) は比べない
fn same_content_but_icon(task: &OutlineNode, plain: &OutlineNode) -> bool {
    TASK_ICON.replacen(&task.html, 1, "") == plain.html.trim_start_matches('\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_tasks_verification_refuses_a_mark_written_into_code() {
        // タスクにできるかの判定を通らずに来ても、書いた記号がタスクの印として読まれない書き換え (番号付きの項目の字下げのコードの中に書く) は確かめで断る
        let source = "# R\n\n1.     a\n2. b\n";
        let before = ParsedSource::read(source);
        let node = before.node(2).expect("番号付きの項目").clone();
        let first = before.first_line(&node).expect("1 行目");
        let mut plan = LinePlan::new(&before.lines);
        plan.rewrite(first.index as usize, marked_line(&first));
        assert_eq!(plan.text(), "# R\n\n1.     [ ] a\n2. b\n");
        let result = verified(
            &before,
            &plan,
            std::slice::from_ref(&node),
            &[node.id],
            Some(TaskState::Todo),
        );
        assert!(result.is_err(), "コードの中の記号は確かめで断る");
    }
}
