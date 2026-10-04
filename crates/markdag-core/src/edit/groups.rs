// 原文なし。
// グループの書き換え。まとめる (groupNodes) は、選んだノードの 1 行目の末尾に %group<番号> を付け、markdag.groups に定義
// (label、color、boundary) を足す。番号は定義と本文の印のどちらにも使われていない最小のもので、色は番号から 6 色を巡る。
// 定義だけを作る (defineGroup)、あとから入れる (addToGroup)、名前と色と枠の有無を変える (renameGroup、setGroupColor、
// setGroupBoundary)、解除する (ungroup。全部のノードの印と定義を外し、ノードは残す) も受け持つ。
// 印を付けるのは、ルートと、もう入っているノードと、選んだほかのノードの配下を除いたノード。印を読まない見出し (下線の見出しと
// 行頭に空白のある見出し) は ATX の見出しに書き直してから付ける。印を書けないノード (容器、表とコードと画像、書き直すと名前が変わる見出し) が
// 残れば全体を断る。
// 書き換えたあとの原文を解析し直し、本文の形が変わらず、グループの定義と所属がねらいどおり (印を付けたノードと配下だけが新しく入る)
// に読まれることを確かめる。リストの容器と 1 行目を分け合う最初の項目も、その行の印は項目だけが読む (容器は読まない) ので、ほかの項目と同じく印を付ける。
use std::collections::BTreeSet;

use super::blocks::{ParsedSource, display_name, model_of};
use super::frontmatter::{MapAppend, Marking, remove_value, set_value, split_key_line, yaml_value};
use super::headings::with_atx_headings;
use super::lines::{LinePlan, split_carriage};
use super::names::normalize_label;
use super::verify::{Correspondence, Expectation, keeps_structure, target_of};
use super::{STALE_NODE, STRUCTURE_CHANGED, refused, unchanged};
use crate::model::locator::{BlockShape, FrontmatterLocator};
use crate::model::schema::check_frontmatter;
use crate::model::util::JsValue;
use crate::parse::trailing_marks;
use crate::types::{
    EditReasonCode, EditRename, EditSelection, EditSourceResult, GraphModel, GroupDef, NodeKind,
    NodeTarget, OutlineNode, PathStep,
};

/// 新しいグループの色。group<番号> は番号から 1 を引いた位置の色で、6 色を巡る
pub(super) const GROUP_COLORS: [&str; 6] = [
    "#3B7DD8", "#2E9E6B", "#E8833A", "#8A5FC2", "#D64545", "#E0A100",
];

// 新しいグループの名前の頭 (group<番号>) と、label の頭 (グループ <番号>)
const GROUP_PREFIX: &str = "group";
const LABEL_PREFIX: &str = "グループ ";

/// 選んだノードを新しいグループにまとめる。グループを選び、名前の入力を開く
pub(super) fn group_nodes(source: &str, targets: &[NodeTarget]) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let Some(nodes) = found(&before, targets) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    if nodes.is_empty() {
        return unchanged(
            EditReasonCode::NothingToChange,
            "ノードを選んでいないので、まとめるものがありません",
        );
    }
    let marked_nodes = to_mark(&before, &nodes, |_| false);
    if marked_nodes.is_empty() {
        return refused(
            EditReasonCode::Root,
            "ルートはグループに入れられません。ルートのほかのノードを選んでください",
        );
    }
    // 印を読まない見出しは、ATX の見出しに書き直した原文で印を付ける
    if let Some(result) = with_atx_headings(source, &before, &marked_nodes, |text| {
        group_nodes(text, targets)
    }) {
        return result;
    }
    if let Err(result) = markable(&before, &marked_nodes) {
        return result;
    }
    let marking = match Marking::of(source, &before) {
        Ok(marking) => marking,
        Err(result) => return result,
    };
    let marked = ParsedSource::read(&marking.text);
    let Some(ids) = marking.ids(&before, &marked, &marked_nodes) else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    let model = model_of(&marked);
    let (group, definition) = new_group(&model);
    let mut plan = LinePlan::new(&marked.lines);
    mark_lines(&marked, &mut plan, &ids, &group);
    if let Err(result) = define(&marking.text, &mut plan, &definition) {
        return result;
    }
    let aim = Aim {
        group: &group,
        definition: Some(definition),
        membership: Membership::Added(ids),
    };
    if let Err(result) = verified(&marked, &model, &plan, &aim, &[]) {
        return result;
    }
    EditSourceResult::Edited {
        splices: marking.plan.then(&plan).splices(),
        select: EditSelection::Group { id: group.clone() },
        rename: Some(EditRename::Group { id: group }),
        notes: marking.notes(&before),
    }
}

/// メンバーのいないグループ (定義だけ) を作る。グループを選び、名前の入力を開く
pub(super) fn define_group(source: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let marking = match Marking::of(source, &before) {
        Ok(marking) => marking,
        Err(result) => return result,
    };
    let marked = ParsedSource::read(&marking.text);
    let model = model_of(&marked);
    let (group, definition) = new_group(&model);
    let mut plan = LinePlan::new(&marked.lines);
    if let Err(result) = define(&marking.text, &mut plan, &definition) {
        return result;
    }
    let aim = Aim {
        group: &group,
        definition: Some(definition),
        membership: Membership::Same,
    };
    if let Err(result) = verified(&marked, &model, &plan, &aim, &[]) {
        return result;
    }
    EditSourceResult::Edited {
        splices: marking.plan.then(&plan).splices(),
        select: EditSelection::Group { id: group.clone() },
        rename: Some(EditRename::Group { id: group }),
        notes: marking.notes(&before),
    }
}

/// 選んだノードを既存のグループ (定義か本文の印があるもの) に入れる。選んだノードをそのまま選ぶ
pub(super) fn add_to_group(source: &str, group: &str, targets: &[NodeTarget]) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let Some(nodes) = found(&before, targets) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    let model = model_of(&before);
    let Some(current) = known(&model, group) else {
        return group_unknown(group);
    };
    let marked_nodes = to_mark(&before, &nodes, |node| belongs(&model, node.id, group));
    if marked_nodes.is_empty() {
        return unchanged(
            EditReasonCode::NothingToChange,
            "選んだノードはどれも、もうグループに入っているか、グループに入れないルートなので、変えるところがありません",
        );
    }
    if let Some(result) = with_atx_headings(source, &before, &marked_nodes, |text| {
        add_to_group(text, group, targets)
    }) {
        return result;
    }
    if let Err(result) = markable(&before, &marked_nodes) {
        return result;
    }
    let ids: Vec<u32> = marked_nodes.iter().map(|node| node.id).collect();
    let mut plan = LinePlan::new(&before.lines);
    mark_lines(&before, &mut plan, &ids, group);
    let selected: Vec<u32> = nodes.iter().map(|node| node.id).collect();
    let aim = Aim {
        group,
        definition: Some(current.clone()),
        membership: Membership::Added(ids),
    };
    let selected = match verified(&before, &model, &plan, &aim, &selected) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    EditSourceResult::Edited {
        splices: plan.splices(),
        select: EditSelection::Nodes { nodes: selected },
        rename: None,
        notes: Vec::new(),
    }
}

/// グループの label を書き換える (定義がなければ label だけの定義を足す)。グループを選ぶ
pub(super) fn rename_group(source: &str, group: &str, label: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let model = model_of(&before);
    let Some(current) = known(&model, group) else {
        return group_unknown(group);
    };
    let label = normalize_label(label);
    if label.is_empty() {
        return refused(
            EditReasonCode::GroupLabelEmpty,
            "グループの名前を空にはできません",
        );
    }
    if current.label == label {
        return unchanged(EditReasonCode::SameName, "グループの名前が今と同じです");
    }
    let definition = GroupDef {
        label: label.clone(),
        defined: true,
        ..current.clone()
    };
    let field = Field {
        name: "label",
        written: yaml_value(&label),
        definition,
    };
    set_field(source, &before, &model, group, field)
}

/// グループの色を書き換える (定義がなければ color だけの定義を足す)。グループを選ぶ
pub(super) fn set_group_color(source: &str, group: &str, color: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let model = model_of(&before);
    let Some(current) = known(&model, group) else {
        return group_unknown(group);
    };
    if !is_color(color) {
        return refused(
            EditReasonCode::ColorInvalid,
            "色の書き方が違います。CSS の色 (#rgb、#rrggbb、#rrggbbaa、色の名前、rgb() など) で書いてください",
        );
    }
    if current.color.as_deref() == Some(color) {
        return unchanged(
            EditReasonCode::NothingToChange,
            "グループの色が今と同じです",
        );
    }
    let definition = GroupDef {
        color: Some(color.to_string()),
        defined: true,
        ..current.clone()
    };
    let field = Field {
        name: "color",
        written: yaml_value(color),
        definition,
    };
    set_field(source, &before, &model, group, field)
}

/// グループの枠の有無を書き換える (定義がなければ boundary だけの定義を足す)。グループを選ぶ
pub(super) fn set_group_boundary(source: &str, group: &str, boundary: bool) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let model = model_of(&before);
    let Some(current) = known(&model, group) else {
        return group_unknown(group);
    };
    // 書いていない boundary は false と同じなので、false を入れても書き足さない
    if current.boundary == boundary {
        return unchanged(
            EditReasonCode::NothingToChange,
            "グループの枠の有無が今と同じです",
        );
    }
    let definition = GroupDef {
        boundary,
        defined: true,
        ..current.clone()
    };
    let field = Field {
        name: "boundary",
        written: boundary.to_string(),
        definition,
    };
    set_field(source, &before, &model, group, field)
}

/// グループを解除する: 全部のノードの 1 行目からその %印を外し、定義を外す (空になった groups のキーも外す)。ノードは残す。選択を解く
pub(super) fn ungroup(source: &str, group: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let model = model_of(&before);
    if known(&model, group).is_none() {
        return group_unknown(group);
    }
    let mut plan = LinePlan::new(&before.lines);
    unmark_lines(&before, &mut plan, group);
    let path = definition_path(group);
    if FrontmatterLocator::new(Some(source)).block(&path).is_some()
        && let Err(reason) = remove_value(source, &mut plan, &path, 1)
    {
        return EditSourceResult::Refused { reason };
    }
    let aim = Aim {
        group,
        definition: None,
        membership: Membership::Removed,
    };
    if let Err(result) = verified(&before, &model, &plan, &aim, &[]) {
        return result;
    }
    EditSourceResult::Edited {
        splices: plan.splices(),
        select: EditSelection::Empty,
        rename: None,
        notes: Vec::new(),
    }
}

// グループの定義の値 1 つの書き換え
struct Field {
    // 定義のキー (label、color、boundary)
    name: &'static str,
    // YAML に書く字 (引用符を含む)
    written: String,
    // 書き換えたあとに読まれるはずのグループ
    definition: GroupDef,
}

// グループの定義の値 1 つを書き換えて (定義やキーがなければ足して)、確かめた結果。グループを選び、名前の入力は開かない。
// 定義の値がキーと値の組でない (1 行の文字、複数行の文字、- の一覧) なら、その値を消して値のないキーにしてから組で書く
// (その値は定義として読まれていない。別名とフロー形式は書き直さない)
fn set_field(
    source: &str,
    before: &ParsedSource<'_>,
    model: &GraphModel,
    group: &str,
    field: Field,
) -> EditSourceResult {
    let cleared = cleared_definition(source, &before.lines, group);
    let (first, text) = match &cleared {
        Some((plan, text)) => (Some(plan), text.as_str()),
        None => (None, source),
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let mut step = LinePlan::new(&lines);
    if let Err(reason) = set_value(
        text,
        &mut step,
        &["markdag", "groups", group, field.name],
        &field.written,
    ) {
        return EditSourceResult::Refused { reason };
    }
    let plan = match first {
        Some(first) => first.then(&step),
        None => LinePlan::new(&before.lines).then(&step),
    };
    let aim = Aim {
        group,
        definition: Some(field.definition),
        membership: Membership::Same,
    };
    if let Err(result) = verified(before, model, &plan, &aim, &[]) {
        return result;
    }
    EditSourceResult::Edited {
        splices: plan.splices(),
        select: EditSelection::Group {
            id: group.to_string(),
        },
        rename: None,
        notes: Vec::new(),
    }
}

// グループの定義 (markdag.groups.<名前>) の値がキーと値の組でなく、1 行の文字、複数行の文字、- の一覧なら、その値を消して
// 値のないキーにした行の列と原文。ほかの形 (組、値のない定義、別名、フロー形式) なら None
fn cleared_definition<'a>(
    source: &str,
    original: &'a [&'a str],
    group: &str,
) -> Option<(LinePlan<'a>, String)> {
    let locator = FrontmatterLocator::new(Some(source));
    let path = definition_path(group);
    let block = locator.block(&path)?;
    let wrong = match block.shape {
        BlockShape::Scalar => !block.value_is_null,
        BlockShape::Seq => !block.flow,
        _ => false,
    };
    if !wrong {
        return None;
    }
    let key_line = block.key_line? as usize;
    let key_column = locator
        .key(&path)
        .map_or(0, |position| position.column.saturating_sub(1) as usize);
    let line = original.get(key_line)?;
    let (head, _) = split_key_line(line, key_column)?;
    let mut plan = LinePlan::new(original);
    let last = (block.last_line as usize).max(key_line);
    plan.remove(key_line + 1, last - key_line);
    plan.rewrite(key_line, format!("{head}{}", split_carriage(line).1));
    let text = plan.text();
    Some((plan, text))
}

// 指したノードを渡した順に、重ねて指したノードを 1 つにしたもの。どれかが見つからなければ None
fn found<'p>(read: &'p ParsedSource<'_>, targets: &[NodeTarget]) -> Option<Vec<&'p OutlineNode>> {
    let mut nodes: Vec<&OutlineNode> = Vec::with_capacity(targets.len());
    for target in targets {
        let node = read.find(target)?;
        if !nodes.iter().any(|other| other.id == node.id) {
            nodes.push(node);
        }
    }
    Some(nodes)
}

// 印を付けるノード (文書の順): ルートと、もう入っているノード (inside) を除き、残りのうちほかの残ったノードの配下を除く
fn to_mark<'p>(
    read: &ParsedSource<'_>,
    nodes: &[&'p OutlineNode],
    inside: impl Fn(&OutlineNode) -> bool,
) -> Vec<&'p OutlineNode> {
    let candidates: Vec<&OutlineNode> = nodes
        .iter()
        .copied()
        .filter(|node| node.parent.is_some() && !inside(node))
        .collect();
    let mut marked: Vec<&OutlineNode> = candidates
        .iter()
        .copied()
        .filter(|node| {
            !candidates
                .iter()
                .any(|other| other.id != node.id && read.is_within(node, other.id))
        })
        .collect();
    marked.sort_by_key(|node| node.id);
    marked
}

// 1 行目に印を書けるか。書けないノードがあれば、文書の順で最初のものの名前を入れて断る
fn markable(read: &ParsedSource<'_>, nodes: &[&OutlineNode]) -> Result<(), EditSourceResult> {
    for node in nodes {
        let name = display_name(node);
        match read.kind_of(node) {
            NodeKind::Block => {
                return Err(refused(
                    EditReasonCode::BlockNode,
                    &format!(
                        "表、コード、画像のノード ({name}) は印を書く行を持たないので、グループに入れられません"
                    ),
                ));
            }
            NodeKind::List | NodeKind::Root => {
                return Err(refused(
                    EditReasonCode::NoSourceLine,
                    &format!(
                        "「{name}」は原文に印を書く行を持たない (リストの入れ物か、行のないルート) ので、グループに入れられません"
                    ),
                ));
            }
            NodeKind::Heading | NodeKind::Item => {
                if !read.first_line(node).is_some_and(|first| first.can_mark) {
                    return Err(refused(
                        EditReasonCode::MarkerLine,
                        &format!(
                            "「{name}」は本文が 2 行以上の下線の見出しで、印を書ける 1 行の見出しにすると名前が変わるので、グループに入れられません"
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

// ノード (ids) の 1 行目の末尾 (印の並びの末尾) に、空白 1 つと %group を足す。行末の \r は残す
fn mark_lines(read: &ParsedSource<'_>, plan: &mut LinePlan<'_>, ids: &[u32], group: &str) {
    for node in ids.iter().filter_map(|id| read.node(*id)) {
        let Some(index) = node.lines.as_ref().map(|lines| lines.start as usize) else {
            continue;
        };
        let Some(line) = plan.line(index) else {
            continue;
        };
        let (content, carriage) = split_carriage(line);
        let written = format!(
            "{} %{group}{carriage}",
            content.trim_end_matches([' ', '\t'])
        );
        plan.rewrite(index, written);
    }
}

// その %印を読んだノードの 1 行目から、印と前の空白を外す (ほかの印と間の空白 1 つは残す)。
// 行末の印を外したら、残った行末の空白も外す
fn unmark_lines(read: &ParsedSource<'_>, plan: &mut LinePlan<'_>, group: &str) {
    let mark = format!("%{group}");
    let mut lines: Vec<usize> = read
        .parsed
        .nodes
        .iter()
        .filter(|node| node.groups.iter().any(|name| name == group))
        .filter_map(|node| node.lines.as_ref().map(|lines| lines.start as usize))
        .collect();
    lines.sort_unstable();
    lines.dedup();
    for index in lines {
        let Some(line) = read.lines.get(index) else {
            continue;
        };
        let (content, carriage) = split_carriage(line);
        let marks = trailing_marks(content);
        let mut kept = String::with_capacity(content.len());
        let mut from = 0;
        let mut last_removed = false;
        for found in &marks {
            last_removed = content.get(found.token.clone()) == Some(mark.as_str());
            if last_removed {
                kept.push_str(&content[from..found.start]);
                from = found.token.end;
            }
        }
        if last_removed {
            kept = kept.trim_end_matches([' ', '\t']).to_string();
        } else {
            kept.push_str(&content[from..]);
        }
        plan.rewrite(index, format!("{kept}{carriage}"));
    }
}

// markdag.groups に定義を足す (groups がなければ作る)
fn define(
    text: &str,
    plan: &mut LinePlan<'_>,
    definition: &GroupDef,
) -> Result<(), EditSourceResult> {
    let mut entries = vec![
        (0, format!("{}:", yaml_value(&definition.id))),
        (1, format!("label: {}", yaml_value(&definition.label))),
    ];
    if let Some(color) = &definition.color {
        entries.push((1, format!("color: {}", yaml_value(color))));
    }
    entries.push((1, format!("boundary: {}", definition.boundary)));
    MapAppend::prepare(text, &["markdag", "groups"])
        .map(|append| append.apply(plan, &entries))
        .map_err(|reason| EditSourceResult::Refused { reason })
}

// 使われていない最小の group<番号> (定義と本文の印の両方を見る) と、その定義 (label はグループ <番号>、色は番号の位置、枠あり)
fn new_group(model: &GraphModel) -> (String, GroupDef) {
    let (number, id) = (1usize..)
        .map(|number| (number, format!("{GROUP_PREFIX}{number}")))
        .find(|(_, id)| !model.groups.iter().any(|group| &group.id == id))
        .unwrap_or_default();
    let color = GROUP_COLORS[number.saturating_sub(1) % GROUP_COLORS.len()];
    let definition = GroupDef {
        id: id.clone(),
        label: format!("{LABEL_PREFIX}{number}"),
        color: Some(color.to_string()),
        boundary: true,
        defined: true,
        icon: None,
    };
    (id, definition)
}

// 書き換えのねらい: グループの定義 (None は定義がなくなり、グループも図から消える) と、所属の変わり方
struct Aim<'a> {
    group: &'a str,
    definition: Option<GroupDef>,
    membership: Membership,
}

// 所属の変わり方
enum Membership {
    // どのノードの所属も変わらない
    Same,
    // 印を付けたノード (書き換える前の id) と配下が新しく入り、ほかは変わらない
    Added(Vec<u32>),
    // どのノードもそのグループから外れ、ほかのグループの所属は変わらない
    Removed,
}

// 書き換えたあとの原文を解析し直し、本文の形 (ノードの数、親子、名前、種類) が変わらず、所属とグループの定義がねらいどおりか。
// 通れば、select (書き換える前の id) のノードを書き換えたあとの原文で指すもの
fn verified(
    before: &ParsedSource<'_>,
    model: &GraphModel,
    plan: &LinePlan<'_>,
    aim: &Aim<'_>,
    select: &[u32],
) -> Result<Vec<NodeTarget>, EditSourceResult> {
    let text = plan.text();
    let after = ParsedSource::read(&text);
    let Some(correspondence) =
        keeps_structure(before, &after, &plan.splices(), &Expectation::default())
    else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    let after_model = model_of(&after);
    if !memberships_hold(before, model, &after_model, &correspondence, aim) {
        return Err(refused(
            EditReasonCode::StructureChanged,
            "印を付けると、選んでいないノードまでグループに入るか、所属がねらいと違って読まれるので、書き換えません",
        ));
    }
    if !definitions_hold(model, &after_model, aim) {
        return Err(refused(
            EditReasonCode::FrontmatterInvalid,
            "書き換えた frontmatter のグループの定義が、書いたとおりに読まれないので、書き換えません",
        ));
    }
    select
        .iter()
        .map(|id| {
            correspondence
                .new_id(*id)
                .and_then(|id| after.node(id))
                .map(target_of)
        })
        .collect::<Option<Vec<NodeTarget>>>()
        .ok_or_else(|| refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED))
}

// 書き換えたあとのノードの所属 (並びは問わない) が、書き換える前の所属をねらいどおりに変えたものと同じか
fn memberships_hold(
    before: &ParsedSource<'_>,
    model: &GraphModel,
    after: &GraphModel,
    correspondence: &Correspondence,
    aim: &Aim<'_>,
) -> bool {
    let groups_of = |model: &GraphModel, id: u32| -> BTreeSet<String> {
        model
            .groups_of
            .get(&id)
            .into_iter()
            .flatten()
            .cloned()
            .collect()
    };
    before.parsed.nodes.iter().all(|node| {
        let Some(new_id) = correspondence.new_id(node.id) else {
            return false;
        };
        let mut expected = groups_of(model, node.id);
        match &aim.membership {
            Membership::Same => {}
            Membership::Added(marked) => {
                if marked.iter().any(|id| before.is_within(node, *id)) {
                    expected.insert(aim.group.to_string());
                }
            }
            Membership::Removed => {
                expected.remove(aim.group);
            }
        }
        groups_of(after, new_id) == expected
    })
}

// 書き換えたあとのグループの一覧 (並びは問わない) が、そのグループをねらいの定義にし、ほかのグループを変えないものか
fn definitions_hold(model: &GraphModel, after: &GraphModel, aim: &Aim<'_>) -> bool {
    let mut expected: Vec<&GroupDef> = model
        .groups
        .iter()
        .filter(|group| group.id != aim.group)
        .collect();
    expected.extend(aim.definition.as_ref());
    after.groups.len() == expected.len()
        && expected.iter().all(|group| after.groups.contains(group))
}

// グループの定義 (markdag.groups.<名前>) の道すじ
fn definition_path(group: &str) -> Vec<PathStep> {
    ["markdag", "groups", group]
        .iter()
        .map(|name| PathStep::Key((*name).to_string()))
        .collect()
}

// グループ (定義か本文の印があるもの)
fn known<'m>(model: &'m GraphModel, group: &str) -> Option<&'m GroupDef> {
    model.groups.iter().find(|candidate| candidate.id == group)
}

// ノードがそのグループに入っているか (本文の印、祖先の印、members のどれか)
fn belongs(model: &GraphModel, id: u32, group: &str) -> bool {
    model
        .groups_of
        .get(&id)
        .is_some_and(|groups| groups.iter().any(|name| name == group))
}

// frontmatter のスキーマが groups の color に受ける値か (スキーマの検査をそのまま使う)
fn is_color(color: &str) -> bool {
    let object = |key: &str, value: JsValue| JsValue::Object([(key.to_string(), value)].into());
    let frontmatter = object(
        "markdag",
        object(
            "groups",
            object("g", object("color", JsValue::String(color.to_string()))),
        ),
    );
    check_frontmatter(&frontmatter, None).is_empty()
}

fn group_unknown(group: &str) -> EditSourceResult {
    refused(
        EditReasonCode::GroupUnknown,
        &format!(
            "グループ「{group}」は frontmatter の定義にも本文の %印にもないので、書き換えられません"
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_groups_colors_are_six_distinct_hex_colors_the_schema_accepts() {
        assert_eq!(GROUP_COLORS.len(), 6);
        // グループにまとめたときの 1 番目の色 (受け入れの例のグループにまとめる例と同じ)
        assert_eq!(GROUP_COLORS[0], "#3B7DD8");
        for (index, color) in GROUP_COLORS.iter().enumerate() {
            assert!(
                color.len() == 7
                    && color.starts_with('#')
                    && color[1..].chars().all(|digit| digit.is_ascii_hexdigit()),
                "{color}"
            );
            assert!(is_color(color), "{color}");
            assert!(!GROUP_COLORS[..index].contains(color), "{color}");
        }
    }

    #[test]
    fn edit_groups_is_color_accepts_css_hex_colors_and_refuses_broken_ones() {
        for color in ["#123456", "#abcdef", "#ABC", "#abc", "#3B7DD8"] {
            assert!(is_color(color), "{color}");
        }
        for color in ["#12", "#12345", "#ggg", "# 123456"] {
            assert!(!is_color(color), "{color}");
        }
    }
}
