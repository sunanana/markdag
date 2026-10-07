// 原文なし。
// 本文を書き換える操作。名前の変更 (renameNode) は 1 行目の本文だけを差し替え、行頭、末尾の印、行末の \r を残す (どのノードも名前を空にはできない)。
// 行を持たないルートの名前は frontmatter の title なので、title を書き換える (なければ足し、frontmatter がなければ作る)。
// 子と兄弟の追加 (addChild、addSibling) は、並ぶノードの形で 1 行を親か自分のブロックの最後の空でない行のあとに足し、
// 兄弟を上に足す操作 (addSiblingBefore) は自分と同じ形 (番号付きは同じ番号) で自分の 1 行目の前に足し、行の読み方を保つ空行をはさむ。
// 削除 (deleteNodes) はノードのブロックを配下ごと消して重なった空行を詰める。
// 付け替え (moveNode) はブロックを切り出し、移す先の最後の子の形で書き直して足す。どれも書き換えたあとの原文を解析し直し、
// ねらいと違う形に読まれれば断る。子と兄弟の追加 (兄弟は上と下)、削除、付け替え (もとの親と移す先) では、兄弟が増えたか減った親の
// 直下の番号付きの項目の原文の番号を、書き換える前の始まりの番号から数え直す (振り直し。足すときと移す先は足したあとに、
// 消すときと切り出すときは外す前に当てる)。末尾に足すときも、原文の番号がずれたリストは全体を図の番号にそろえる。
// 本文を書き換えたあと、frontmatter の参照の追随 (名前の変更、削除) と守り (読み方が変わって
// 指せなくなった参照の書き直し) を当てる (書き方は参照の書き直しの側が決める)。
use super::blocks::{BOM, ParsedSource, is_titled_root, start_line, title_label};
use super::frontmatter::{markdag_notes, with_title, yaml_value};
use super::lines::{LinePlan, carriage_of, cut_lines};
use super::names::{added_line, input_label, name_line, normalize_label};
use super::refs::{Follow, Guard, rewrite_references};
use super::renumber::{Renumbering, aligned, renumber_lines, renumbered_lists};
use super::shape::{
    Indentation, LineShape, Side, Spacing, blank_lines_around, moved_lines, nested_shape,
    next_shape, sibling_shape,
};
use super::verify::{Correspondence, Expectation, Placed, PlacedNode, keeps_structure, target_of};
use super::{STALE_NODE, STRUCTURE_CHANGED, refused, unchanged};
use crate::model::util::JsValue;
use crate::parse::BlockTag;
use crate::types::{
    EditReasonCode, EditRename, EditSelection, EditSourceResult, NodeKind, NodeTarget, OutlineNode,
};

/// 本文の書き換え (書き換えたあとの原文がねらいどおりに読まれることを確かめたもの)。frontmatter の参照の追随と守りを当てる前
pub(super) struct BodyEdit<'a> {
    /// 書き換える前の原文の行に対する、書き換えたあとの行の列
    pub(super) plan: LinePlan<'a>,
    /// 書き換えたあとの原文
    pub(super) text: String,
    /// 書き換える前のノードから書き換えたあとのノードへの対応
    pub(super) correspondence: Correspondence,
    /// 選ぶノード (書き換えたあとの原文の id)
    pub(super) selected: u32,
    /// 選ぶノードの名前の入力を開くか
    rename: bool,
    /// 参照に求めること (名前の変更の追随、削除の追随)
    follow: Follow,
}

// 本文の書き換えに、frontmatter の参照の追随と守りを当てた結果。断られた本文の書き換えはその結果のまま
fn finish(
    before: &ParsedSource<'_>,
    edit: Result<BodyEdit<'_>, EditSourceResult>,
) -> EditSourceResult {
    let edit = match edit {
        Ok(edit) => edit,
        Err(result) => return result,
    };
    let after = ParsedSource::read(&edit.text);
    let guard = Guard {
        before,
        correspondence: &edit.correspondence,
        follow: &edit.follow,
    };
    let (splices, selected, notes) = match rewrite_references(&after, Some(guard), None) {
        Err(reason) => return EditSourceResult::Refused { reason },
        Ok(None) => (
            edit.plan.splices(),
            after.node(edit.selected).map(target_of),
            Vec::new(),
        ),
        Ok(Some(rewritten)) => {
            let last = ParsedSource::read(&rewritten.text);
            let selected = rewritten
                .correspondence
                .new_id(edit.selected)
                .and_then(|id| last.node(id))
                .map(target_of);
            (
                edit.plan.then(&rewritten.plan).splices(),
                selected,
                rewritten.notes,
            )
        }
    };
    let Some(selected) = selected else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    EditSourceResult::Edited {
        splices,
        select: EditSelection::Nodes {
            nodes: vec![selected.clone()],
        },
        rename: edit.rename.then_some(EditRename::Node { node: selected }),
        notes,
    }
}

// 名前の変更で原文を変えない理由の文 (初めの値のまま決めたときと、書き換えても行が同じとき)
const SAME_NAME: &str = "名前が今と同じです";
// 名前を空にする変更を断る理由の文 (GUI の通知にそのまま出るので、理由を書きすぎない)
const EMPTY_NAME: &str = "名前を空にできません";

pub(super) fn rename_node(source: &str, target: &NodeTarget, label: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    if let Some(node) = before.find(target)
        && is_titled_root(&before, node)
    {
        return rename_title(source, &before, node, label);
    }
    finish(&before, rename_edit(&before, target, label))
}

// 行を持たないルートの名前の変更: frontmatter の title を書き換える (なければ足し、frontmatter がなければ作る)。
// 名前の決め方はほかのノードと同じ (名前の入力の初めの値 (原文の title の文字) のまま決めたら変えない、空の名前は断る)。
// ルートを名前で指す参照は名前の変更と同じく追随する。
// frontmatter を作ったときと、先頭の BOM を外したときは、そのことを知らせに足す
fn rename_title(
    source: &str,
    before: &ParsedSource<'_>,
    node: &OutlineNode,
    label: &str,
) -> EditSourceResult {
    let name = normalize_label(label);
    if name == title_label(before, node) {
        return unchanged(EditReasonCode::SameName, SAME_NAME);
    }
    if name.is_empty() {
        return refused(EditReasonCode::EmptyName, EMPTY_NAME);
    }
    let (plan, added) = match with_title(source, &before.lines, &yaml_value(&name)) {
        Ok(written) => written,
        Err(reason) => return EditSourceResult::Refused { reason },
    };
    let expectation = Expectation {
        renamed: Some(node.id),
        ..Expectation::default()
    };
    let (text, correspondence) = match verified(before, &plan, &expectation) {
        Ok(verified) => verified,
        Err(result) => return result,
    };
    // 書いた title が、決めた名前の文字列として読まれること (YAML の書き方の誤りを書き換えにしない)。図の名前は title を
    // 見出しや項目の 1 行目と同じ読み方 (空白を詰め、タグを外し、文字参照を戻す) で読んだものなので、決めた名前とは比べない
    let written = matches!(
        &ParsedSource::read(&text).parsed.frontmatter,
        JsValue::Object(map) if map.get("title") == Some(&JsValue::String(name.clone()))
    );
    let Some(selected) = correspondence.new_id(node.id).filter(|_| written) else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    let edit = BodyEdit {
        plan,
        text,
        correspondence,
        selected,
        rename: false,
        follow: Follow {
            renamed: Some(node.id),
            ..Follow::default()
        },
    };
    match finish(before, Ok(edit)) {
        EditSourceResult::Edited {
            splices,
            select,
            rename,
            notes,
        } => EditSourceResult::Edited {
            splices,
            select,
            rename,
            notes: [markdag_notes(&added, 0), notes].concat(),
        },
        other => other,
    }
}

fn rename_edit<'a>(
    before: &'a ParsedSource<'a>,
    target: &NodeTarget,
    label: &str,
) -> Result<BodyEdit<'a>, EditSourceResult> {
    let Some(node) = before.find(target) else {
        return Err(refused(EditReasonCode::StaleNode, STALE_NODE));
    };
    let kind = before.kind_of(node);
    if kind == NodeKind::Block {
        return Err(refused(
            EditReasonCode::BlockNode,
            "表、コード、画像のノードは名前を持たないので、名前を変えられません",
        ));
    }
    let Some(first) = before.first_line(node) else {
        return Err(refused(
            EditReasonCode::NoSourceLine,
            "このノードは原文に名前の行を持たないので、名前を変えられません",
        ));
    };
    let heading = kind == NodeKind::Heading;
    let name = normalize_label(label);
    // 名前の入力の初めの値のまま決めたときは、逃がしを当て直さず、どの文書でも原文を変えない
    if name == normalize_label(&input_label(&first, heading)) {
        return Err(unchanged(EditReasonCode::SameName, SAME_NAME));
    }
    // どのノードも名前を空にできない (今の名前が空のノードを空のまま決めたときは、上で原文を変えない)
    if name.is_empty() {
        return Err(refused(EditReasonCode::EmptyName, EMPTY_NAME));
    }
    let text = name_line(&first, &name, heading);
    if before.lines.get(first.index as usize) == Some(&text.as_str()) {
        return Err(unchanged(EditReasonCode::SameName, SAME_NAME));
    }
    let mut plan = LinePlan::new(&before.lines);
    plan.rewrite(first.index as usize, text);
    let expectation = Expectation {
        renamed: Some(node.id),
        ..Expectation::default()
    };
    let (text, correspondence) = verified(before, &plan, &expectation)?;
    let Some(selected) = correspondence.new_id(node.id) else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    Ok(BodyEdit {
        plan,
        text,
        correspondence,
        selected,
        rename: false,
        follow: Follow {
            renamed: Some(node.id),
            ..Follow::default()
        },
    })
}

// 書き換えたあとの原文と、確かめを通った対応。ねらいと違う形に読まれれば structure-changed
fn verified(
    before: &ParsedSource<'_>,
    plan: &LinePlan<'_>,
    expectation: &Expectation,
) -> Result<(String, Correspondence), EditSourceResult> {
    let text = plan.text();
    let correspondence = {
        let after = ParsedSource::read(&text);
        keeps_structure(before, &after, &plan.splices(), expectation)
    };
    match correspondence {
        Some(correspondence) => Ok((text, correspondence)),
        None => Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED)),
    }
}

/// 子は親のブロックのあとに、最後の子の形 (子がいなければ子のないときの形) で足す
pub(super) fn add_child(source: &str, target: &NodeTarget, label: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let Some(node) = before.find(target) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    finish(&before, child_edit(source, &before, node, label))
}

/// source (before はその解析) の node の子を足す本文の書き換え。番号付きのリストなら、足したあとの兄弟の番号を振り直す
/// (原文の番号がずれたリストは、前の項目も図の番号に書き直す)。参照の追随と守りは当てない (呼び出し側が当てる)
pub(super) fn child_edit<'a>(
    source: &str,
    before: &'a ParsedSource<'a>,
    node: &OutlineNode,
    label: &str,
) -> Result<BodyEdit<'a>, EditSourceResult> {
    let placement = child_placement(before, node, &Indentation::of(before))?;
    let parent = placement.parent;
    let edit = insert(source, before, placement, label)?;
    let lists = renumbered_after(before, parent, &edit.correspondence);
    Ok(renumbered(edit, &lists))
}

/// 兄弟は自分のブロックのあとに自分と同じ形で足す。親のない (ルートの) 兄弟は子として足す
pub(super) fn add_sibling(source: &str, target: &NodeTarget, label: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let Some(node) = before.find(target) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    finish(
        &before,
        sibling_edit(source, &before, node, label, Side::After),
    )
}

/// 兄弟を自分の 1 行目の前に自分と同じ形 (番号付きは同じ番号) で足す。親のない (ルートの) 兄弟は、下に足すときと同じく子として足す
pub(super) fn add_sibling_before(
    source: &str,
    target: &NodeTarget,
    label: &str,
) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let Some(node) = before.find(target) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    finish(
        &before,
        sibling_edit(source, &before, node, label, Side::Before),
    )
}

/// source (before はその解析) の node の兄弟を side に足す本文の書き換え。番号付きのリストなら、足したあとの兄弟の番号を振り直す。
/// 参照の追随と守りは当てない (呼び出し側が当てる)
pub(super) fn sibling_edit<'a>(
    source: &str,
    before: &'a ParsedSource<'a>,
    node: &OutlineNode,
    label: &str,
    side: Side,
) -> Result<BodyEdit<'a>, EditSourceResult> {
    let placement = sibling_placement(before, node, side)?;
    let parent = placement.parent;
    let edit = insert(source, before, placement, label)?;
    let lists = renumbered_after(before, parent, &edit.correspondence);
    Ok(renumbered(edit, &lists))
}

// ノードを足した親 parent (read の id。None はルートに置き換わる) の直下の番号付きの項目を振り直すリストを、足したあとの id
// (ids は read から足したあとへの対応) で指したもの。リストの書き方と始まりの番号は足す前の read で見る (全部同じ番号のリストは振り直さない)
fn renumbered_after(
    read: &ParsedSource<'_>,
    parent: Option<u32>,
    ids: &Correspondence,
) -> Vec<Renumbering> {
    renumbered_lists(read, parent)
        .into_iter()
        .filter_map(|list| {
            Some(Renumbering {
                parent: ids.new_id(list.parent)?,
                ..list
            })
        })
        .collect()
}

// 兄弟の形と位置: 自分と同じ形で、After は自分のブロックのあと、Before は自分の 1 行目の前。親のない (ルートの) 兄弟は子の形と位置
fn sibling_placement(
    before: &ParsedSource<'_>,
    node: &OutlineNode,
    side: Side,
) -> Result<Placement, EditSourceResult> {
    if node.parent.is_none() {
        return child_placement(before, node, &Indentation::of(before));
    }
    match before.kind_of(node) {
        NodeKind::Block => {
            return Err(refused(
                EditReasonCode::BlockNode,
                "表、コード、画像のノードは行の形を持たないので、兄弟を足せません",
            ));
        }
        NodeKind::List => {
            return Err(refused(
                EditReasonCode::NoSourceLine,
                "リストの入れ物 (容器) は原文に自分の行を持たないので、兄弟を足せません",
            ));
        }
        NodeKind::Heading | NodeKind::Item | NodeKind::Root => {}
    }
    let at = match side {
        Side::After => Some(before.block_end(node)),
        Side::Before => start_line(node),
    };
    let (Some(shape), Some(at)) = (sibling_shape(before, node, side), at) else {
        return Err(refused(
            EditReasonCode::NoSourceLine,
            "このノードは原文に自分の行を持たないので、兄弟を足せません",
        ));
    };
    Ok(Placement {
        shape,
        at,
        parent: node.parent,
    })
}

// 書く行の形、書く位置 (書き換える前の行の添字)、書いたノードの親 (書き換える前の id。None はルートに置き換わる)
struct Placement {
    shape: LineShape,
    at: u32,
    parent: Option<u32>,
}

// 子の形と位置: 子がいれば最後の子にそろえて親のブロックのあと。最後の子が容器なら、容器の最後の項目にそろえて
// 容器のリストの末尾 (書いたノードの親は容器)。子がいなければ、見出しは 1 段下の見出し (6 段ならリスト)、項目は入れ子の項目、
// 行を持たないルートは本文の末尾の項目。足す操作と付け替えが使う
fn child_placement(
    read: &ParsedSource<'_>,
    node: &OutlineNode,
    indentation: &Indentation,
) -> Result<Placement, EditSourceResult> {
    let kind = read.kind_of(node);
    if kind == NodeKind::Block {
        return Err(refused(
            EditReasonCode::BlockNode,
            "表、コード、画像のノードは子を持てないので、子を足せません",
        ));
    }
    let placement = match read.last_child(node) {
        Some(last) => {
            let (parent, sibling) = match read.kind_of(last) {
                NodeKind::Block => {
                    return Err(refused(
                        EditReasonCode::StructureChanged,
                        "最後の子が表、コード、画像のノードに子を足すと、今の子が子でなくなるので、子を足せません",
                    ));
                }
                NodeKind::List => (last, read.last_child(last)),
                NodeKind::Heading | NodeKind::Item | NodeKind::Root => (node, Some(last)),
            };
            let Some(shape) = sibling.and_then(|sibling| next_shape(read, sibling)) else {
                return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
            };
            Placement {
                shape,
                at: read.block_end(parent),
                parent: Some(parent.id),
            }
        }
        None => {
            let shape = match read.tag_of(node) {
                Some(BlockTag::Heading(level)) if level < 6 => LineShape::Heading {
                    level: level + 1,
                    task: false,
                },
                Some(BlockTag::Li) => match nested_shape(read, node, indentation) {
                    Some(shape) => shape,
                    None => {
                        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
                    }
                },
                _ => LineShape::bullet(),
            };
            Placement {
                shape,
                at: read.block_end(node),
                // 行も子もないルートに足した項目は、解析でルートに置き換わる
                parent: (kind != NodeKind::Root).then_some(node.id),
            }
        }
    };
    Ok(placement)
}

// 足す行 (と前後にはさむ空行) を差し込み、書き換えたあとの原文がねらいどおりに読まれれば、足したノードを選んで名前の入力を開く
fn insert<'a>(
    source: &str,
    before: &'a ParsedSource<'a>,
    placement: Placement,
    label: &str,
) -> Result<BodyEdit<'a>, EditSourceResult> {
    let Placement { shape, at, parent } = placement;
    let carriage = carriage_of(source);
    let text = added_line(&shape.lead(), &normalize_label(label), shape.is_heading());
    let mut plan = LinePlan::new(&before.lines);
    let line = insert_lines(
        &mut plan,
        at as usize,
        vec![format!("{text}{carriage}")],
        &shape.spacing(),
        carriage,
    );
    let expectation = Expectation {
        placed: Some(Placed {
            line,
            parent,
            node: PlacedNode::Added { task: shape.task() },
        }),
        ..Expectation::default()
    };
    let (text, correspondence) = verified(before, &plan, &expectation)?;
    let Some(selected) = correspondence.placed else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    Ok(BodyEdit {
        plan,
        text,
        correspondence,
        selected,
        rename: true,
        follow: Follow::default(),
    })
}

// 書く行 (行末の \r を含む) を行の列の at の位置に差し込み、前後に空行をはさむ。改行で終わらない文書の末尾では、
// 書く最後の行の \r を外し、CRLF の文書なら前の最後の行に \r を足す (改行で終わらない形を保ち、単独の \r を作らない)。
// 文書の先頭に書くときは、先頭の BOM を書く最初の行の頭へ移す (BOM は文書の先頭にだけ置ける。もとの 1 行目に残すと、
// 文書の途中の BOM で始まる行になり、見出しや項目に読まれない)。戻り値は書いた最初の行 (はさんだ空行のあと) の位置
fn insert_lines(
    plan: &mut LinePlan<'_>,
    at: usize,
    mut written: Vec<String>,
    spacing: &Spacing,
    carriage: &str,
) -> u32 {
    let previous = at.checked_sub(1).and_then(|previous| plan.line(previous));
    let (blank_before, blank_after) = blank_lines_around(spacing, previous, plan.line(at));
    let previous = previous.map(str::to_string);
    if blank_before {
        written.insert(0, carriage.to_string());
    }
    if blank_after {
        written.push(carriage.to_string());
    }
    if at == plan.len()
        && let Some(previous) = previous
    {
        if let Some(last) = written.last_mut()
            && last.ends_with('\r')
        {
            last.pop();
        }
        if !carriage.is_empty() {
            plan.rewrite(at - 1, format!("{previous}{carriage}"));
        }
    }
    if at == 0
        && let Some(rest) = plan.line(0).and_then(|first| first.strip_prefix(BOM))
    {
        let rest = rest.to_string();
        plan.rewrite(0, rest);
        if let Some(first) = written.first_mut() {
            first.insert(0, BOM);
        }
    }
    plan.insert(at, written);
    u32::try_from(at + usize::from(blank_before)).unwrap_or(u32::MAX)
}

// 足したあとの本文の書き換え edit に、lists (書き換えたあとの親の id) の番号の振り直しを重ねたもの。振り直した原文が、
// 振り直す前と違う形に読まれるか、番号が図とそろわないとき (入れ子の字下げの珍しい形など) は、振り直さずに edit のまま返す。
// 振り直さなかったことは知らせない (足すときも外すときも同じ。まれな形のために知らせを増やさない)
fn renumbered<'a>(edit: BodyEdit<'a>, lists: &[Renumbering]) -> BodyEdit<'a> {
    let Some((plan, text, ids)) = renumber_stages(&edit, lists) else {
        return edit;
    };
    BodyEdit {
        plan,
        text,
        correspondence: edit.correspondence.then(&ids),
        selected: ids.new_id(edit.selected).unwrap_or(edit.selected),
        rename: edit.rename,
        follow: edit.follow,
    }
}

// edit の原文に振り直しを当てた結果: 書き換える前の原文に当てる行の列、振り直したあとの原文、振り直す前から後への対応。
// 書き直すものがないか、確かめが通らなければ None
fn renumber_stages<'a>(
    edit: &BodyEdit<'a>,
    lists: &[Renumbering],
) -> Option<(LinePlan<'a>, String, Correspondence)> {
    let start = ParsedSource::read(&edit.text);
    let (stages, text) = renumber_lines(&start, lists, &[])?;
    let after = ParsedSource::read(&text);
    let ids = keeps_structure(&start, &after, &stages.splices(), &Expectation::default())?;
    aligned(&after, lists.iter().map(|list| list.parent))
        .then(|| (edit.plan.then(&stages), text, ids))
}

// before から cut の行を外した行の列、外したあとの原文、外す前から後への対応。lists (before の id) の番号は、外すノード
// (expectation.removed) を数えずに、外す前の原文で先に振り直しておく。振り直して外した原文がねらいどおりに読まれないか、
// 番号が図とそろわないときは、振り直さずに外す (足すときの振り直しと同じく知らせない)。振り直さずに外した原文も
// ねらいどおりに読まれなければ structure-changed で断る
fn cut_renumbered<'a>(
    before: &'a ParsedSource<'a>,
    cut: &[bool],
    lists: &[Renumbering],
    expectation: &Expectation,
) -> Result<(LinePlan<'a>, String, Correspondence), EditSourceResult> {
    if let Some((renumbering, renumbered)) = renumber_lines(before, lists, &expectation.removed) {
        let plan = renumbering.then(&cut_lines(&ParsedSource::read(&renumbered).lines, cut));
        if let Ok((text, correspondence)) = verified(before, &plan, expectation)
            && aligned(
                &ParsedSource::read(&text),
                lists
                    .iter()
                    .filter_map(|list| correspondence.new_id(list.parent)),
            )
        {
            return Ok((plan, text, correspondence));
        }
    }
    let plan = cut_lines(&before.lines, cut);
    let (text, correspondence) = verified(before, &plan, expectation)?;
    Ok((plan, text, correspondence))
}

/// ノードをブロックごと (配下ごと) 消す。配下に含まれるノードと重ねて渡したノードは除いて 1 回ずつ消し、
/// 消した所の前後で重なった空行を詰める。選ぶのは文書の順で最初に消したノードの親。ルートを含めば全体を断る
pub(super) fn delete_nodes(source: &str, targets: &[NodeTarget]) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let mut nodes: Vec<&OutlineNode> = Vec::with_capacity(targets.len());
    for target in targets {
        let Some(node) = before.find(target) else {
            return refused(EditReasonCode::StaleNode, STALE_NODE);
        };
        nodes.push(node);
    }
    if nodes.is_empty() {
        return unchanged(
            EditReasonCode::NothingToChange,
            "消すノードが選ばれていません",
        );
    }
    if nodes.iter().any(|node| node.parent.is_none()) {
        return refused(
            EditReasonCode::Root,
            "ルートは消せないので、ルートを含む削除はしません",
        );
    }
    nodes.sort_by_key(|node| node.id);
    nodes.dedup_by_key(|node| node.id);
    // 配下に含まれるノードは、上のノードのブロックと一緒に消える
    let removed: Vec<&OutlineNode> = nodes
        .iter()
        .filter(|node| {
            !nodes
                .iter()
                .any(|other| other.id != node.id && before.is_within(node, other.id))
        })
        .copied()
        .collect();
    let Some(cut) = block_flags(&before, &removed) else {
        return refused(
            EditReasonCode::NoSourceLine,
            "このノードは原文に行を持たないので、消せません",
        );
    };
    let expectation = Expectation {
        removed: removed.iter().map(|node| node.id).collect(),
        ..Expectation::default()
    };
    // 消したノードの親。番号付きのリストなら、残った兄弟の番号を振り直す (全部同じ番号のリストは振り直さない)。
    // いくつかの項目をまとめて消したときは、消した項目がいたリストをそれぞれ 1 回で振り直す (外の親から順に)
    let lists = renumbered_lists(&before, removed.iter().filter_map(|node| node.parent));
    let (plan, text, correspondence) = match cut_renumbered(&before, &cut, &lists, &expectation) {
        Ok(cut) => cut,
        Err(result) => return result,
    };
    let Some(selected) = removed
        .first()
        .and_then(|first| first.parent)
        .and_then(|parent| correspondence.new_id(parent))
    else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    // 消したノードと配下。relations の項のうち、これを指す項を外す
    let gone: Vec<u32> = before
        .parsed
        .nodes
        .iter()
        .filter(|node| removed.iter().any(|top| before.is_within(node, top.id)))
        .map(|node| node.id)
        .collect();
    let edit = BodyEdit {
        plan,
        text,
        correspondence,
        selected,
        rename: false,
        follow: Follow {
            removed: gone,
            ..Follow::default()
        },
    };
    finish(&before, Ok(edit))
}

/// ノードを配下ごと、移す先の最後の子に付け替える。ブロックを切り出し (削除と同じく空行を詰める)、切り出したあとの原文で
/// 移す先の子の形と位置を決めて、自分の形 (見出しの段か項目) で書き直して足す。選ぶのは動かしたノード
pub(super) fn move_node(
    source: &str,
    target: &NodeTarget,
    parent: &NodeTarget,
) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let (Some(node), Some(parent)) = (before.find(target), before.find(parent)) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    if node.parent.is_none() {
        return refused(EditReasonCode::Root, "ルートは動かせません");
    }
    let kind = before.kind_of(node);
    if kind == NodeKind::List {
        return refused(
            EditReasonCode::NoSourceLine,
            "リストの入れ物 (容器) は原文に自分の行を持たないので、動かせません",
        );
    }
    if before.is_within(parent, node.id) {
        return refused(
            EditReasonCode::MoveIntoSelf,
            "自分か自分の配下の下へは動かせません",
        );
    }
    if node.parent == Some(parent.id) {
        return unchanged(EditReasonCode::AlreadyChild, "すでにその親の子です");
    }
    let destination_kind = before.kind_of(parent);
    if destination_kind == NodeKind::Block {
        return refused(
            EditReasonCode::BlockNode,
            "表、コード、画像のノードは子を持てないので、その下へは動かせません",
        );
    }
    if kind == NodeKind::Block && destination_kind != NodeKind::Heading {
        return refused(
            EditReasonCode::BlockNode,
            "表、コード、画像のノードは見出しの下へだけ動かせます",
        );
    }
    // 切り出す: 削除と同じ規則で行を外し、残りの形が変わらないことを確かめる。もとのリストが番号付きなら、残った兄弟の番号を
    // 振り直す (全部同じ番号のリストは振り直さない。移す先の振り直しは足したあと)
    let Some(cut) = block_flags(&before, &[node]) else {
        return refused(
            EditReasonCode::NoSourceLine,
            "このノードは原文に行を持たないので、動かせません",
        );
    };
    let cut_expectation = Expectation {
        removed: vec![node.id],
        ..Expectation::default()
    };
    let lists = renumbered_lists(&before, node.parent);
    let (cut_plan, cut_source, cut_ids) =
        match cut_renumbered(&before, &cut, &lists, &cut_expectation) {
            Ok(cut) => cut,
            Err(result) => return result,
        };
    let remaining = ParsedSource::read(&cut_source);
    let Some(destination) = cut_ids.new_id(parent.id).and_then(|id| remaining.node(id)) else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    let indentation = Indentation::of(&before);
    let carriage = carriage_of(source);
    // 移す先での形と位置。表、コード、画像は行の形を持たないので、移す先のブロックのあとにそのまま書く
    let (shape, at, placed_parent) = if kind == NodeKind::Block {
        (None, remaining.block_end(destination), destination.id)
    } else {
        match child_placement(&remaining, destination, &indentation) {
            Ok(Placement {
                shape,
                at,
                parent: Some(parent),
            }) => (Some(shape), at, parent),
            Ok(_) => return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED),
            Err(refusal) => return refusal,
        }
    };
    // 見出しは配下の段落を読まないので、続きの段落を持つ項目は見出しで書けない (詳細は見出しの詳細として書く)
    if kind == NodeKind::Item
        && shape.as_ref().is_some_and(LineShape::is_heading)
        && before.has_continuation(node)
    {
        return refused(
            EditReasonCode::HeadingDetails,
            "見出しで書くことになり、見出しは続きの段落を持てないので、この項目はその下へ動かせません",
        );
    }
    let Some(written) = moved_lines(&before, node, shape.as_ref(), &indentation, carriage) else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    let (tag, spacing) = match &shape {
        Some(shape) => (Some(shape.tag()), shape.spacing()),
        None => (before.tag_of(node), Spacing::Apart),
    };
    let Some(tag) = tag else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    // 書き直したブロックを足し、切り出したあとの原文から見て、ねらいどおりに読まれることを確かめる
    let mut plan = LinePlan::new(&remaining.lines);
    let line = insert_lines(&mut plan, at as usize, written, &spacing, carriage);
    let expectation = Expectation {
        placed: Some(Placed {
            line,
            parent: Some(placed_parent),
            node: PlacedNode::moved(&before, node, tag),
        }),
        ..Expectation::default()
    };
    let (text, after_ids) = match verified(&remaining, &plan, &expectation) {
        Ok(verified) => verified,
        Err(result) => return result,
    };
    let Some(selected) = after_ids.placed else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    // 書き換える前から後への対応: 切り出しと書き足しの対応を重ね、動かしたノードと配下 (数が同じなら文書の順に組にする) を足す
    let mut correspondence = cut_ids.then(&after_ids);
    correspondence.insert(node.id, selected);
    {
        let after = ParsedSource::read(&text);
        let moved: Vec<u32> = before.descendants(node).map(|moved| moved.id).collect();
        let placed: Vec<u32> = after
            .node(selected)
            .map(|placed| after.descendants(placed).map(|node| node.id).collect())
            .unwrap_or_default();
        if moved.len() == placed.len() {
            for (old, new) in moved.into_iter().zip(placed) {
                correspondence.insert(old, new);
            }
        }
    }
    // 原文に当てる行の列は、切り出し (と振り直し) と足すのを重ねたもの。移す先が番号付きのリストなら、足したあとの兄弟の番号を
    // 子を足すときと同じく振り直す
    let edit = BodyEdit {
        plan: cut_plan.then(&plan),
        text,
        correspondence,
        selected,
        rename: false,
        follow: Follow::default(),
    };
    let lists = renumbered_after(&remaining, Some(placed_parent), &after_ids);
    finish(&before, Ok(renumbered(edit, &lists)))
}

// 消すか切り出す行の印 (原文の行ごと)。nodes のブロックの行が真。行を持たないノードがあれば None
fn block_flags(read: &ParsedSource<'_>, nodes: &[&OutlineNode]) -> Option<Vec<bool>> {
    let mut flags = vec![false; read.lines.len()];
    for node in nodes {
        for index in read.block_lines(node)? {
            if let Some(flag) = flags.get_mut(index as usize) {
                *flag = true;
            }
        }
    }
    Some(flags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::lines::apply_splices;

    const MD: &str = "---\nmarkdag:\n---\n";

    fn rename(source: &str, id: u32, ref_text: &str, label: &str) -> EditSourceResult {
        let target = NodeTarget {
            id: f64::from(id),
            ref_text: ref_text.to_string(),
        };
        rename_node(source, &target, label)
    }

    fn renamed(source: &str, id: u32, ref_text: &str, label: &str) -> String {
        match rename(source, id, ref_text, label) {
            EditSourceResult::Edited { splices, .. } => apply_splices(source, &splices),
            other => panic!("書き換えるはず: {other:?}"),
        }
    }

    fn refused_code(result: EditSourceResult) -> Option<EditReasonCode> {
        match result {
            EditSourceResult::Refused { reason } => Some(reason.code),
            _ => None,
        }
    }

    #[test]
    fn edit_rename_keeps_the_atx_closing_sequence_and_marks() {
        assert_eq!(renamed("# R\n## h ##\n", 2, "h", "x"), "# R\n## x ##\n");
        let source = format!("{MD}# R\n## h ## #k\n");
        assert_eq!(
            renamed(&source, 2, "h", "x"),
            format!("{MD}# R\n## x ## #k\n")
        );
    }

    #[test]
    fn edit_rename_fills_an_empty_item() {
        // 印で行が終わる空の項目は、印と名前の間に空白を置く
        assert_eq!(renamed("# R\n- a\n-\n", 3, "", "x"), "# R\n- a\n- x\n");
    }

    #[test]
    fn edit_rename_setext_headings_keep_the_underline() {
        assert_eq!(
            renamed("# R\n\n設計\n---\n- a\n", 2, "設計", "x"),
            "# R\n\nx\n---\n- a\n"
        );
        // どのノードも名前を空にできないので、下線の見出しも空の名前は empty-name で断る (D-030)
        assert_eq!(
            refused_code(rename("# R\n\n設計\n---\n- a\n", 2, "設計", "")),
            Some(EditReasonCode::EmptyName)
        );
    }
}
