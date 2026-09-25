// 原文: src/parse/task.ts (2026-09-24)
// タスクの状態の記法。行頭の `[ ]` (未完了), `[/]` (作業中), `[x]` (完了), `[-]` (中止) を状態として読み、
// クリックでの切り替えを原文の上で行う。切り替えの順 (cycle) は文書の frontmatter が決め、既定は未完了と完了の行き来。
// DOM に依存しないので、model 層からも使える
use std::sync::LazyLock;

use regress::Regex;

use crate::model::util::JsValue;
use crate::types::{TaskMark, TaskState, ToggleTaskResult};

// 規則 2.6: `as const` の配列は enum の配列 (types.rs の ALL が原文の順)
pub const TASK_MARKS: &[TaskMark] = TaskMark::ALL;
pub const TASK_STATES: &[TaskState] = TaskState::ALL;

// 原文の定数 STATE_OF / MARK_OF (`Record<TaskMark, TaskState>` と `Record<TaskState, TaskMark>`)。
// キーも値も enum の写像なので、キーの取りこぼしをコンパイラが見る網羅の match の関数にした (名前は定数名の snake_case)
// (規則 2.1、A-054)
fn state_of(mark: TaskMark) -> TaskState {
    match mark {
        TaskMark::Space => TaskState::Todo,
        TaskMark::Slash => TaskState::Doing,
        TaskMark::X => TaskState::Done,
        TaskMark::Hyphen => TaskState::Canceled,
    }
}

fn mark_of(state: TaskState) -> TaskMark {
    match state {
        TaskState::Todo => TaskMark::Space,
        TaskState::Doing => TaskMark::Slash,
        TaskState::Done => TaskMark::X,
        TaskState::Canceled => TaskMark::Hyphen,
    }
}

// 指定がないときにクリックで進む順。右端の次は左端に戻る
pub const DEFAULT_TASK_CYCLE: &[TaskMark] = &[TaskMark::Space, TaskMark::X];

/// 原文: isTaskMark
// 規則 2.6: 型の述語は is_x -> Option (真なら変換した値)
pub fn is_task_mark(value: &JsValue) -> Option<TaskMark> {
    TaskMark::from_js(value)
}

/// 原文: taskStateOf
pub fn task_state_of(mark: TaskMark) -> TaskState {
    state_of(mark)
}

/// 原文: taskMarkOf
pub fn task_mark_of(state: TaskState) -> TaskMark {
    mark_of(state)
}

// 行頭の記号。大文字の X は完了として読む。リスト項目は行頭の記号のあと、見出しは # のあと。
// 下線で書く見出しは行が記号から始まるので、見出しと分かっている行にだけ使う
// 規則 2.4: 先読みを含むので regress に固定し、断片は原文の文字のまま組む (ECMAScript の意味、フラグなし)
const LIST_PREFIX: &str = r"[ \t]*(?:[-*+]|\d+[.)])[ \t]+";
const HEADING_PREFIX: &str = r"[ \t]*(?:#{1,6}[ \t]+)?";
const MARK: &str = r"\[( |x|X|\/|-)\](?=[ \t])";
// 規則 1 章 (A-021): 定数の正規表現は LazyLock と expect
static TASK_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^{LIST_PREFIX}{MARK}")).expect("固定の正規表現"));
static TASK_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^{HEADING_PREFIX}{MARK}")).expect("固定の正規表現"));
// 切り替えで書き換える記号。リスト項目でも見出しでも、行頭の印のすぐあとにある
static TASK_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("^((?:{LIST_PREFIX})|(?:{HEADING_PREFIX})){MARK}")).expect("固定の正規表現")
});

/// taskMarkAt の kind (原文の `'item' | 'heading'`)
// 規則 2.6 (A-041): 境界にも文面にも出ない局所の union は serde も as_str / from_js もない enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskLineKind {
    Item,
    Heading,
}

/// 原文: taskMarkAt
// 原文の 1 行から状態の記号を読む。タスクでなければ None
pub fn task_mark_at(line: &str, kind: TaskLineKind) -> Option<TaskMark> {
    // 規則 2.4 (A-009): exec(...)?.[1] は find と group
    let regex = match kind {
        TaskLineKind::Item => &*TASK_ITEM,
        TaskLineKind::Heading => &*TASK_HEADING,
    };
    // TODO(port): Rust 側の不到達。範囲は char 境界で、MARK の捕まえる字は 5 つだけなので、get と from_js の None は起きない (起きたらタスクでないとして扱う)
    let raw = regex
        .find(line)
        .and_then(|found| found.group(1))
        .and_then(|range| line.get(range));
    match raw {
        None => None,
        Some(raw) => TaskMark::from_js(&JsValue::String(
            if raw == "X" { "x" } else { raw }.to_string(),
        )),
    }
}

/// 原文: nextTaskMark
// クリックで次に進む記号。今の記号が順の中になければ None (その状態はクリックで変えない)
pub fn next_task_mark(current: TaskMark, cycle: &[TaskMark]) -> Option<TaskMark> {
    // cycle が空なら position が None なので割り算は起きない
    let index = cycle.iter().position(|mark| *mark == current)?;
    cycle.get((index + 1) % cycle.len()).copied()
}

/// 原文: toggleTask
// タスクの行の状態を、原文の上で順の次に進める。原文にない行や、順にない状態の行は、何も変えない (None)。
// DESIGN (b): 原文全体でなく書き換えた 1 行を返し、包みが原文に継ぎ足す (他の行と改行を原文のまま保つ)
pub fn toggle_task(
    source: &str,
    line: f64,
    cycle: Option<&[TaskMark]>,
) -> Option<ToggleTaskResult> {
    // 規則 2.6: 既定の引数は Option で受け、先頭で既定値にする
    let cycle = cycle.unwrap_or(DEFAULT_TASK_CYCLE);
    let lines: Vec<&str> = source.split('\n').collect();
    // 規則 2.1: line は f64 で受け、JS の配列の添字と同じ検査をする (小数、負、NaN、Infinity は undefined。-0 は 0)。
    // u32 に収まらない添字は lines の長さを越えるので、ここで外しても原文と同じく何も変えない
    if !(line.is_finite() && line.fract() == 0.0 && line >= 0.0 && line <= f64::from(u32::MAX)) {
        return None;
    }
    let index = line as u32;
    let current = *lines.get(index as usize)?;
    // 規則 2.2: g なしの replace は最初の 1 か所だけ。置き換えは find の範囲で手で組む (規則 2.4)
    let found = TASK_LINE.find(current)?;
    let range = found.range();
    // TODO(port): Rust 側の不到達。TASK_LINE が一致すれば捕まえ 1 と 2 は必ずあり、範囲は char 境界で、捕まえる字は MARK の 5 つだけ
    let (Some(before), Some(prefix), Some(raw), Some(after)) = (
        current.get(..range.start),
        found.group(1).and_then(|prefix| current.get(prefix)),
        found.group(2).and_then(|raw| current.get(raw)),
        current.get(range.end..),
    ) else {
        return None;
    };
    let mark = TaskMark::from_js(&JsValue::String(
        if raw == "X" { "x" } else { raw }.to_string(),
    ))?;
    let next = next_task_mark(mark, cycle)?;
    let text = format!("{before}{prefix}[{}]{after}", next.as_str());
    // DESIGN (b): 変えないなら None。書き換えても行が同じ (1 要素の cycle で `[x]` → `[x]`) ときも、
    // 包みが継ぎ足さないことで対になっていないサロゲートを原文のまま保つ
    if text == current {
        return None;
    }
    Some(ToggleTaskResult { line: index, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPACE: TaskMark = TaskMark::Space;
    const SLASH: TaskMark = TaskMark::Slash;
    const X: TaskMark = TaskMark::X;
    const HYPHEN: TaskMark = TaskMark::Hyphen;

    // 包みの toggleTask の写し: 書き換えた 1 行を原文に継ぎ足す (None なら原文のまま)
    fn toggled(source: &str, line: f64, cycle: Option<&[TaskMark]>) -> String {
        match toggle_task(source, line, cycle) {
            None => source.to_string(),
            Some(result) => {
                let mut lines: Vec<&str> = source.split('\n').collect();
                lines[result.line as usize] = &result.text;
                lines.join("\n")
            }
        }
    }

    #[test]
    fn task_regexes_compile() {
        LazyLock::force(&TASK_ITEM);
        LazyLock::force(&TASK_HEADING);
        LazyLock::force(&TASK_LINE);
    }

    #[test]
    fn task_toggle_keeps_other_lines_and_crlf() {
        let source = "# root\r\n- [ ] A\r\n- [x] B\r\n";
        assert_eq!(
            toggled(source, 1.0, None),
            "# root\r\n- [x] A\r\n- [x] B\r\n"
        );
        assert_eq!(
            toggled(source, 2.0, None),
            "# root\r\n- [ ] A\r\n- [ ] B\r\n"
        );
    }

    #[test]
    fn task_toggle_out_of_range_changes_nothing() {
        let source = "# root\n- [ ] A";
        assert_eq!(toggled(source, 5.0, None), source);
        assert_eq!(toggled(source, -1.0, None), source);
        assert_eq!(toggle_task(source, 5.0, None), None);
        assert_eq!(toggle_task(source, -1.0, None), None);
    }

    // 原文の添字の癖 (TS のテストにはない。規則 2.1 の公開の関数の引数の行)
    #[test]
    fn task_toggle_non_integer_line_changes_nothing() {
        let source = "- [ ] A\n- [ ] B";
        assert_eq!(toggle_task(source, 0.5, None), None);
        assert_eq!(toggle_task(source, f64::NAN, None), None);
        assert_eq!(toggle_task(source, f64::INFINITY, None), None);
        assert_eq!(toggled(source, -0.0, None), "- [x] A\n- [ ] B");
    }

    #[test]
    fn task_cycle_goes_left_to_right_and_wraps() {
        let cycle: &[TaskMark] = &[SPACE, SLASH, X];
        assert_eq!(toggled("- [ ] A", 0.0, Some(cycle)), "- [/] A");
        assert_eq!(toggled("- [/] A", 0.0, Some(cycle)), "- [x] A");
        assert_eq!(toggled("- [x] A", 0.0, Some(cycle)), "- [ ] A");
        assert_eq!(toggled("- [X] A", 0.0, Some(cycle)), "- [ ] A");
    }

    #[test]
    fn task_cycle_skips_states_outside_it() {
        assert_eq!(toggled("- [-] A", 0.0, None), "- [-] A");
        assert_eq!(toggled("- [/] A", 0.0, None), "- [/] A");
        assert_eq!(
            toggled("- [-] A", 0.0, Some(&[SPACE, HYPHEN, X])),
            "- [x] A"
        );
        assert_eq!(next_task_mark(HYPHEN, &[SPACE, X]), None);
        assert_eq!(next_task_mark(X, &[SPACE, X]), Some(SPACE));
    }

    #[test]
    fn task_toggle_rewrites_only_the_leading_mark() {
        assert_eq!(toggled("## [ ] A [ ] b", 0.0, None), "## [x] A [ ] b");
        assert_eq!(toggled("[x] Setext", 0.0, None), "[ ] Setext");
        assert_eq!(toggled("1. [ ] A", 0.0, None), "1. [x] A");
    }

    // 書き換えても行が変わらないときは None (DESIGN (b) の「変えないなら null」)。`[X]` → `[x]` は字が変わるので Some
    #[test]
    fn task_toggle_returns_none_when_the_line_is_unchanged() {
        assert_eq!(toggle_task("- [x] A", 0.0, Some(&[X])), None);
        assert_eq!(toggle_task("- [x] A\u{FFFD}", 0.0, Some(&[X])), None);
        assert_eq!(
            toggle_task("- [X] A", 0.0, Some(&[X])),
            Some(ToggleTaskResult {
                line: 0,
                text: "- [x] A".to_string()
            })
        );
        assert_eq!(toggle_task("- [-] A", 0.0, None), None);
        assert_eq!(toggle_task("plain", 0.0, None), None);
    }

    #[test]
    fn task_mark_at_reads_four_marks() {
        assert_eq!(task_mark_at("- [/] A", TaskLineKind::Item), Some(SLASH));
        assert_eq!(task_mark_at("  * [-] A", TaskLineKind::Item), Some(HYPHEN));
        assert_eq!(task_mark_at("## [X] A", TaskLineKind::Heading), Some(X));
        assert_eq!(
            task_mark_at("[-] Setext", TaskLineKind::Heading),
            Some(HYPHEN)
        );
        assert_eq!(task_mark_at("[-] plain", TaskLineKind::Item), None);
        assert_eq!(task_mark_at("- [?] A", TaskLineKind::Item), None);
        assert_eq!(task_mark_at("- [x]A", TaskLineKind::Item), None);
        let states: Vec<TaskState> = [SLASH, HYPHEN, SPACE, X]
            .into_iter()
            .map(task_state_of)
            .collect();
        assert_eq!(
            states,
            vec![
                TaskState::Doing,
                TaskState::Canceled,
                TaskState::Todo,
                TaskState::Done
            ]
        );
    }
}

// PORT STATUS: confidence=high todos=2
