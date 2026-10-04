// 原文なし。
// frontmatter の参照 (relations の式、markdag.branches と groups の members の項目) の書き方と書き直し。
// 参照の書き方は (1) 文書で 1 つの $id、(2) 文書で 1 つの名前、(3) 名前のある祖先の名前/名前 の順に、式の項として読み直して
// (`-->` と `&` の前後のどこでも項 1 つに読まれるか) 同じノードに解決するものを選び、どれでも決まらなければ 1 行目の末尾に足す
// $n<番号> (使われていない最小の番号) で指す。印を読まない見出しは、ATX の見出しに書き直してから $n を足す。
// 本文を書き換えたあとには、書き換える前に 1 つのノードに解決していた参照を追う: 名前を変えたノードに一致した区間は新しい名前に
// 書き直し (名前の変更の追随)、残ったノードを指せなくなった参照はそのノードの今の書き方に書き直す (参照の守り)。
// ノードを消したときは、relations の項のうち消したノード (と配下) を指す項だけを外す (削除の追随。chain は前後で分け、
// join と fork は始点か終点が 1 つになれば depends に移す)。branches と members の項目は外さない。
// 書き直しと relations の書き足し (線を引く、合流) は、本文を書き換えたあとの原文の frontmatter の行に当て、書いたあとの原文を
// 解析し直して、本文の形が変わらず、frontmatter が書いたとおりの値に読まれ、書いた参照がねらいのノードを指すことを確かめる。
// 式の読み方と解決には解析の読み方 (式の区切り、参照の読み方、解決) をそのまま使い、書き換えの側で写しを作らない。
// 数えるのは markdag キーのある原文 (markdag: を足す操作では足したあとの原文。足す前は行末の印が名前に入るため)。
use std::ops::Range;

use indexmap::IndexMap;

use super::blocks::{ParsedSource, display_name};
use super::frontmatter::{ListAppend, remove_value, rewrite_value};
use super::headings::{AtxHeading, atx_heading};
use super::lines::{LinePlan, split_carriage};
use super::verify::{Correspondence, Expectation, keeps_structure};
use super::{STRUCTURE_CHANGED, reason as fixed_reason};
use crate::model::locator::FrontmatterLocator;
use crate::model::model::{
    AMPERSAND, ARROW, Resolver, SelectorScope, escape_segment, split_outside_quotes,
};
use crate::model::util::{JsValue, js_trim};
use crate::types::{
    EditNote, EditNoteCode, EditReason, EditReasonCode, NodeKind, OutlineNode, PathStep,
    RelationKind,
};

/// ノードを指す参照
pub(super) enum Reference {
    /// そのまま書ける参照
    Written(String),
    /// 1 行目 (行の添字) の末尾に $n<番号> を足して指す。番号は呼び出し側が決める。印を読まない見出しは、ATX の見出しに書き直してから足す
    Marker {
        line: u32,
        heading: Option<AtxHeading>,
    },
}

/// ノードを指す参照の書き方。決まらず、$n も書けなければ断る理由
pub(super) fn reference_of(
    read: &ParsedSource<'_>,
    node: &OutlineNode,
) -> Result<Reference, EditReason> {
    let mut resolver = Resolver::new(&read.parsed.nodes);
    let mut candidates: Vec<String> = Vec::new();
    if let Some(ref_id) = &node.ref_id {
        candidates.push(format!("${ref_id}"));
    }
    if !node.ref_text.is_empty() {
        candidates.push(escape_segment(&node.ref_text, true));
        // 容器 (名前のないリストの入れ物) を飛ばした、いちばん近い名前のある祖先
        if let Some(ancestor) = named_ancestor(read, node) {
            candidates.push(format!(
                "{}/{}",
                escape_segment(&ancestor.ref_text, true),
                escape_segment(&node.ref_text, false)
            ));
        }
    }
    if let Some(found) = candidates
        .into_iter()
        .find(|candidate| reads_back(&mut resolver, candidate, node.id))
    {
        return Ok(Reference::Written(found));
    }
    let name = display_name(node);
    if node.ref_id.is_some() {
        return Err(reason(
            EditReasonCode::AmbiguousReference,
            format!(
                "「{name}」は同じ $id のノードがほかにもあり、名前でも 1 つに決まらないので、参照を書けません。$id を 1 つにしてください"
            ),
        ));
    }
    match read.first_line(node) {
        Some(first) if first.can_mark => Ok(Reference::Marker {
            line: first.index,
            heading: None,
        }),
        Some(first) => match atx_heading(read, node) {
            Some(heading) => Ok(Reference::Marker {
                line: first.index,
                heading: Some(heading),
            }),
            None => Err(reason(
                EditReasonCode::MarkerLine,
                format!(
                    "「{name}」は名前で 1 つに決まらず、本文が 2 行以上の下線の見出しで、$id を書ける 1 行の見出しにすると名前が変わるので、参照を書けません"
                ),
            )),
        },
        None if read.kind_of(node) == NodeKind::Block => Err(reason(
            EditReasonCode::BlockNode,
            "表、コード、画像のノードは名前も印の行も持たないので、参照を書けません".to_string(),
        )),
        None => Err(reason(
            EditReasonCode::NoSourceLine,
            format!(
                "「{name}」は名前で 1 つに決まらず、原文に $id を書く行を持たないので、参照を書けません"
            ),
        )),
    }
}

/// 使われていない最小の $n の番号の id (n1、n2、…)。返した id は used に入れる
pub(super) fn free_marker(used: &mut Vec<String>) -> String {
    let id = (1u32..)
        .map(|number| format!("n{number}"))
        .find(|id| !used.contains(id))
        .unwrap_or_default();
    used.push(id.clone());
    id
}

/// 1 行目の末尾 (印の並びの末尾) に、空白 1 つと $id を足した行。行末の \r は残す
pub(super) fn marked_line(line: &str, ref_id: &str) -> String {
    let (content, carriage) = split_carriage(line);
    format!(
        "{} ${ref_id}{carriage}",
        content.trim_end_matches([' ', '\t'])
    )
}

/// 「始点 & … --> 終点」の式が、解析と同じ読み方で from の各ノード (並びのとおり) から to への線に読まれるか
pub(super) fn expression_points_at(
    resolver: &mut Resolver<'_>,
    expression: &str,
    from: &[u32],
    to: u32,
) -> bool {
    let Ok(parts) = split_outside_quotes(expression, &ARROW) else {
        return false;
    };
    let [source, target] = parts.as_slice() else {
        return false;
    };
    let Ok(sources) = split_outside_quotes(source, &AMPERSAND) else {
        return false;
    };
    sources.len() == from.len()
        && sources
            .iter()
            .zip(from)
            .all(|(raw, id)| selector_points_at(resolver, raw, *id))
        && term_points_at(resolver, target, to)
}

// 参照 (範囲の記号のないもの) が、式のどの位置に置いても項 1 つとして読まれ、そのノードに解決するか
fn reads_back(resolver: &mut Resolver<'_>, reference: &str, id: u32) -> bool {
    stands_alone(resolver, reference, SelectorScope::SelfScope, id)
}

// 書いた項 (範囲の記号を付けたもの) が、`-->` と `&` の前と後ろのどこに置いても項 1 つとして読まれ、その範囲の記号のまま
// そのノードに解決するか。名前の端の `-->` や `&` は、前後の区切りの空白と合わさって区切りに読まれる
fn stands_alone(resolver: &mut Resolver<'_>, written: &str, scope: SelectorScope, id: u32) -> bool {
    let expression = format!("{written} & {written} --> {written} & {written}");
    let Ok(stages) = split_outside_quotes(&expression, &ARROW) else {
        return false;
    };
    stages.len() == 2
        && stages.iter().all(|stage| {
            split_outside_quotes(stage, &AMPERSAND).is_ok_and(|terms| {
                terms.len() == 2
                    && terms.iter().all(|raw| {
                        resolver.parse_selector(raw).is_ok_and(|selector| {
                            selector.scope == scope && resolves_to(resolver, &selector.ref_text, id)
                        })
                    })
            })
        })
}

// 項が参照 1 つ (& で分かれず、/* や (X) でない) で、そのノードに解決するか
fn term_points_at(resolver: &mut Resolver<'_>, term: &str, id: u32) -> bool {
    let Ok(parts) = split_outside_quotes(term, &AMPERSAND) else {
        return false;
    };
    let [raw] = parts.as_slice() else {
        return false;
    };
    selector_points_at(resolver, raw, id)
}

// 参照 1 つ (/* や (X) でない) が、そのノードに解決するか
fn selector_points_at(resolver: &mut Resolver<'_>, raw: &str, id: u32) -> bool {
    let Ok(selector) = resolver.parse_selector(raw) else {
        return false;
    };
    selector.scope == SelectorScope::SelfScope
        && resolver
            .resolve_ref(&selector.ref_text)
            .is_ok_and(|found| found == id)
}

// 名前のある祖先のうち、いちばん近いもの
fn named_ancestor<'p>(read: &'p ParsedSource<'_>, node: &OutlineNode) -> Option<&'p OutlineNode> {
    let mut parent = node.parent.and_then(|id| read.node(id));
    while let Some(current) = parent {
        if !current.ref_text.is_empty() {
            return Some(current);
        }
        parent = current.parent.and_then(|id| read.node(id));
    }
    None
}

fn reason(code: EditReasonCode, message: String) -> EditReason {
    EditReason {
        code,
        message,
        path: None,
    }
}

/// 本文の書き換えが参照に求めること
#[derive(Default)]
pub(super) struct Follow {
    /// 名前を変えたノード (書き換える前の id)。そのノードに一致した区間を新しい名前で書き直す
    pub(super) renamed: Option<u32>,
    /// 消したノードと配下 (書き換える前の id)。relations の項のうち、これを指す項を外す
    pub(super) removed: Vec<u32>,
}

/// 本文の書き換えの前の原文と、書き換える前のノードから書き換えたあとのノードへの対応 (参照の守りと追随に使う)
pub(super) struct Guard<'g> {
    pub(super) before: &'g ParsedSource<'g>,
    pub(super) correspondence: &'g Correspondence,
    pub(super) follow: &'g Follow,
}

/// 書き足す relations の式 (始点と終点は、本文を書き換えたあとの原文の id。始点は書く順)
pub(super) struct NewRelation {
    pub(super) kind: RelationKind,
    pub(super) sources: Vec<u32>,
    pub(super) target: u32,
}

/// 参照の書き直しと relations の書き足しを当てた結果
pub(super) struct Rewritten<'a> {
    /// 本文を書き換えたあとの原文の行に対する、書き換えたあとの行の列
    pub(super) plan: LinePlan<'a>,
    /// 書き直したあとの原文
    pub(super) text: String,
    /// 本文を書き換えたあとのノードから、書き直したあとのノードへの対応
    pub(super) correspondence: Correspondence,
    /// 書き足した式の始点と終点 (書き直したあとの原文の id)
    pub(super) drawn: Option<(Vec<u32>, u32)>,
    pub(super) notes: Vec<EditNote>,
}

/// 本文を書き換えたあとの原文 (after) の frontmatter に、参照の追随と守り (guard) と relations の書き足し (drawing) を当てる。
/// 書き直すものがなければ None。frontmatter の形で書けないとき、参照を書けないとき、書いたあとの確かめに通らないときは断る理由
pub(super) fn rewrite_references<'a>(
    after: &'a ParsedSource<'a>,
    guard: Option<Guard<'_>>,
    drawing: Option<&NewRelation>,
) -> Result<Option<Rewritten<'a>>, EditReason> {
    let mut planner = Planner::new(after);
    let mut edits: Vec<SiteEdit> = Vec::new();
    if let Some(guard) = &guard {
        let mut before_resolver = Resolver::new(&guard.before.parsed.nodes);
        for site in sites_of(&guard.before.parsed.frontmatter) {
            if let Some(edit) = planner.plan_site(guard, &mut before_resolver, site)? {
                edits.push(edit);
            }
        }
    }
    // 書き足す先の形を、参照を書く前に確かめる (frontmatter の形で断るときは、本文に $n を書く前に断る)
    let drawn = match drawing {
        Some(relation) => {
            let path = relation_path(relation.kind);
            ListAppend::prepare(&planner.after_text, &path)?;
            let mut references = Vec::with_capacity(relation.sources.len());
            for id in relation.sources.iter().chain([&relation.target]) {
                references.push(planner.reference(*id)?);
            }
            let target = references.pop().unwrap_or_default();
            Some((
                relation.kind,
                format!("{} --> {target}", references.join(" & ")),
            ))
        }
        None => None,
    };
    if edits.is_empty() && drawn.is_none() && planner.markers.given.is_empty() {
        return Ok(None);
    }

    // 行に当てる: 本文の行の末尾の $n、frontmatter の後ろの値から順に書き直しと削除、最後に一覧の末尾への書き足し。
    // frontmatter の書き換えは 1 つずつ当て、そのたびに位置の木を作り直す
    let mut combined = LinePlan::new(&after.lines);
    // 印を読まない見出しは ATX の見出しに書き直して $n を足す (下線の行を外すと後ろの行がずれるので、後ろの行から当てる)
    let mut given: Vec<&(u32, u32, String)> = planner.markers.given.iter().collect();
    given.sort_by_key(|(_, line, _)| std::cmp::Reverse(*line));
    for (_, line, ref_id) in given {
        let heading = planner
            .markers
            .headings
            .iter()
            .find(|heading| heading.start == *line);
        match heading {
            Some(heading) => {
                combined.remove(
                    *line as usize + 1,
                    (heading.count as usize).saturating_sub(1),
                );
                combined.rewrite(*line as usize, marked_line(&heading.line, ref_id));
            }
            None => {
                if let Some(text) = after.lines.get(*line as usize) {
                    combined.rewrite(*line as usize, marked_line(text, ref_id));
                }
            }
        }
    }
    let mut text = combined.text();
    let mut notes: Vec<EditNote> = edits.iter().filter_map(|edit| edit.note.clone()).collect();
    edits.sort_by_cached_key(|edit| std::cmp::Reverse(edit.position(&planner.after_text)));
    let moved_any = edits.iter().any(|edit| edit.moved.is_some());
    for edit in &edits {
        let keep = match (moved_any, edit.site.place) {
            // depends に移す項目があれば、空になる depends のキーと relations のキーを残す (移した項目を同じ所に足す)
            (true, Place::Relation(RelationKind::Depends)) => 3,
            (true, _) => 2,
            (false, _) => 1,
        };
        let next = {
            let lines: Vec<&str> = text.split('\n').collect();
            let mut step = LinePlan::new(&lines);
            match &edit.outcome {
                Outcome::Replace(values) => {
                    rewrite_value(&text, &mut step, &edit.site.path, values)?
                }
                Outcome::Remove => remove_value(&text, &mut step, &edit.site.path, keep)?,
            }
            combined = combined.then(&step);
            step.text()
        };
        text = next;
    }
    let mut appended: Vec<(RelationKind, String)> = edits
        .iter()
        .filter_map(|edit| edit.moved.clone())
        .map(|moved| (RelationKind::Depends, moved))
        .collect();
    appended.extend(drawn.clone());
    for (kind, value) in &appended {
        let next = {
            let append = ListAppend::prepare(&text, &relation_path(*kind))?;
            let lines: Vec<&str> = text.split('\n').collect();
            let mut step = LinePlan::new(&lines);
            append.apply(&mut step, value);
            combined = combined.then(&step);
            step.text()
        };
        text = next;
    }

    // 書いたあとの確かめ: 本文の形が変わらず、$n が印として読まれ、frontmatter が書いたとおりの値に読まれ、書いた参照がねらいのノードを指す
    let splices = combined.splices();
    let rewritten = ParsedSource::read(&text);
    let Some(correspondence) =
        keeps_structure(after, &rewritten, &splices, &Expectation::default())
    else {
        return Err(fixed_reason(
            EditReasonCode::StructureChanged,
            STRUCTURE_CHANGED,
        ));
    };
    let markers_read = planner.markers.given.iter().all(|(id, _, ref_id)| {
        correspondence
            .new_id(*id)
            .and_then(|id| rewritten.node(id))
            .is_some_and(|node| node.ref_id.as_deref() == Some(ref_id.as_str()))
    });
    if !markers_read {
        return Err(fixed_reason(
            EditReasonCode::StructureChanged,
            STRUCTURE_CHANGED,
        ));
    }
    let expected = expected_lists(&after.parsed.frontmatter, &edits, &appended);
    if expected != reference_lists(&rewritten.parsed.frontmatter) {
        return Err(fixed_reason(
            EditReasonCode::FrontmatterInvalid,
            "書き換えると frontmatter が書いた値と別の値に読まれるので、書き換えません",
        ));
    }
    let mut resolver = Resolver::new(&rewritten.parsed.nodes);
    let terms_point = planner.written.iter().all(|(term, id)| {
        correspondence.new_id(*id).is_some_and(|id| {
            resolver
                .parse_selector(term)
                .is_ok_and(|selector| resolves_to(&mut resolver, &selector.ref_text, id))
        })
    });
    if !terms_point {
        return Err(fixed_reason(
            EditReasonCode::AmbiguousReference,
            "書き直した参照が同じノードを指すように書けないので、書き直せません",
        ));
    }
    let drawn_ends = match (drawing, &drawn) {
        (Some(relation), Some((_, expression))) => {
            let ends: Option<Vec<u32>> = relation
                .sources
                .iter()
                .chain([&relation.target])
                .map(|id| correspondence.new_id(*id))
                .collect();
            let Some((target, sources)) = ends.as_deref().and_then(<[u32]>::split_last) else {
                return Err(fixed_reason(
                    EditReasonCode::StructureChanged,
                    STRUCTURE_CHANGED,
                ));
            };
            if !expression_points_at(&mut resolver, expression, sources, *target) {
                return Err(fixed_reason(
                    EditReasonCode::AmbiguousReference,
                    "書き足す式が線の端のノードを指すように書けないので、線を引けません",
                ));
            }
            Some((sources.to_vec(), *target))
        }
        _ => None,
    };

    if planner.rewritten > 0 {
        notes.push(EditNote {
            code: EditNoteCode::RefsRewritten,
            count: planner.rewritten,
            message: format!(
                "書き換えで指せなくなる frontmatter の参照を {} 個、同じノードを指す書き方に書き直しました",
                planner.rewritten
            ),
        });
    }
    if !planner.markers.given.is_empty() {
        notes.push(id_added_note(after, &planner.markers.given));
    }
    Ok(Some(Rewritten {
        plan: combined,
        text,
        correspondence,
        drawn: drawn_ends,
        notes,
    }))
}

/// relations の kind の一覧の道すじ
pub(super) fn relation_path(kind: RelationKind) -> [&'static str; 3] {
    ["markdag", "relations", kind.as_str()]
}

// 1 行目の末尾に $n を足したことの知らせ
fn id_added_note(read: &ParsedSource<'_>, markers: &[(u32, u32, String)]) -> EditNote {
    let named: Vec<String> = markers
        .iter()
        .map(|(id, _, ref_id)| {
            let name = read
                .node(*id)
                .map(|node| node.ref_text.as_str())
                .filter(|name| !name.is_empty())
                .map_or_else(|| format!("#{id}"), str::to_string);
            format!("「{name}」に ${ref_id}")
        })
        .collect();
    EditNote {
        code: EditNoteCode::IdAdded,
        count: u32::try_from(markers.len()).unwrap_or(u32::MAX),
        message: format!(
            "名前で 1 つに決まらないノードを指すため、1 行目の末尾に印を足しました ({})",
            named.join("、")
        ),
    }
}

// 参照の置き場
#[derive(Debug, Clone, Copy, PartialEq)]
enum Place {
    Relation(RelationKind),
    Branch,
    Member,
}

// frontmatter の参照の値 1 つ (relations の式、branches と members の項目)
struct Site {
    place: Place,
    // 値の道すじ。一覧の項目は添字まで、relations の式 1 つのスカラはキーまで
    path: Vec<PathStep>,
    // 値の入っている一覧 (markdag の下のキーの並び) と、その中の添字 (式 1 つのスカラは 0)
    list: Vec<String>,
    index: usize,
    text: String,
}

// 値の書き直し
enum Outcome {
    Replace(Vec<String>),
    Remove,
}

struct SiteEdit {
    site: Site,
    outcome: Outcome,
    // depends の一覧の末尾に移す式 (join と fork の始点か終点が 1 つになった)
    moved: Option<String>,
    // 削除の追随で直した項目の知らせ
    note: Option<EditNote>,
}

impl SiteEdit {
    // 書き換える値の frontmatter の中の行 (後ろから当てる順を決める)
    fn position(&self, text: &str) -> u32 {
        let locator = FrontmatterLocator::new(Some(text));
        locator
            .block(&self.site.path)
            .map_or(0, |block| block.key_line.unwrap_or(block.first_line))
    }
}

// 式の項 1 つ
struct Term {
    // 値の中の項の字の範囲 (前後の空白を除く)
    range: Range<usize>,
    // 参照の範囲と、範囲の記号を除いた参照。読めない項は None
    selector: Option<(SelectorScope, String)>,
    // 書き換える前の原文で区間ごとに一致したノード (最後が指すノード)。解決できない項は None
    matched: Option<Vec<u32>>,
}

// $n を足すノード (本文を書き換えたあとの原文の id)、その 1 行目の行、足す $id。headings は $n を足す前に ATX の見出しに書き直す見出し
#[derive(Default)]
struct Markers {
    used: Vec<String>,
    given: Vec<(u32, u32, String)>,
    headings: Vec<AtxHeading>,
}

// 参照の書き直しを決める。書き方は本文を書き換えたあとの原文で決め、$n は同じノードに 1 つだけ足す
struct Planner<'p> {
    after: &'p ParsedSource<'p>,
    after_text: String,
    resolver: Resolver<'p>,
    markers: Markers,
    // 参照の守りで書き直した参照の数
    rewritten: u32,
    // 書き直した項と、指すノード (本文を書き換えたあとの原文の id)
    written: Vec<(String, u32)>,
}

impl<'p> Planner<'p> {
    fn new(after: &'p ParsedSource<'p>) -> Self {
        let used = after
            .parsed
            .nodes
            .iter()
            .filter_map(|node| node.ref_id.clone())
            .collect();
        Planner {
            after,
            after_text: after.lines.join("\n"),
            resolver: Resolver::new(&after.parsed.nodes),
            markers: Markers {
                used,
                given: Vec::new(),
                headings: Vec::new(),
            },
            rewritten: 0,
            written: Vec::new(),
        }
    }

    // ノード (本文を書き換えたあとの原文の id) を指す参照。$n が要れば 1 行目に足すものとして控える
    fn reference(&mut self, id: u32) -> Result<String, EditReason> {
        let Some(node) = self.after.node(id) else {
            return Err(fixed_reason(
                EditReasonCode::StructureChanged,
                STRUCTURE_CHANGED,
            ));
        };
        match reference_of(self.after, node)? {
            Reference::Written(text) => Ok(text),
            Reference::Marker { line, heading } => {
                if let Some((_, _, ref_id)) =
                    self.markers.given.iter().find(|(given, _, _)| *given == id)
                {
                    return Ok(format!("${ref_id}"));
                }
                let ref_id = free_marker(&mut self.markers.used);
                self.markers.given.push((id, line, ref_id.clone()));
                self.markers.headings.extend(heading);
                Ok(format!("${ref_id}"))
            }
        }
    }

    // 値 1 つの書き直し。書き直さなければ None
    // before_resolver は本文を書き換える前の原文のノードの解決
    fn plan_site(
        &mut self,
        guard: &Guard<'_>,
        before_resolver: &mut Resolver<'_>,
        site: Site,
    ) -> Result<Option<SiteEdit>, EditReason> {
        let Some(stages) = stages_of(&site, before_resolver) else {
            return Ok(None);
        };
        // 消したノード (と配下) を指す項。branches と members の項目は外さない
        let removed = &guard.follow.removed;
        let is_hit = |term: &Term| {
            matches!(site.place, Place::Relation(_))
                && term
                    .matched
                    .as_ref()
                    .and_then(|matched| matched.last())
                    .is_some_and(|id| removed.contains(id))
        };
        let kept: Vec<Vec<&Term>> = stages
            .iter()
            .map(|stage| stage.iter().filter(|term| !is_hit(term)).collect())
            .collect();
        let hit = stages.iter().flatten().any(is_hit);
        let Place::Relation(kind) = site.place else {
            return self.rewrite_in_place(guard, site, &stages);
        };
        if !hit {
            return self.rewrite_in_place(guard, site, &stages);
        }
        let before = site.text.clone();
        let name = kind.as_str();
        let (outcome, moved, note) = if kind == RelationKind::Chain {
            // 項が全部なくなった段で前後に分け、2 つ以上の段がつながる所だけを残す
            let runs: Vec<&[Vec<&Term>]> = kept
                .split(Vec::is_empty)
                .filter(|run| run.len() >= 2)
                .collect();
            if runs.is_empty() {
                let note = format!("chain「{before}」を外した (2 つ以上つながる所が残らない)");
                (Outcome::Remove, None, note)
            } else {
                let mut pieces = Vec::with_capacity(runs.len());
                for run in runs {
                    pieces.push(self.written_stages(guard, &site, run)?);
                }
                let named: Vec<String> =
                    pieces.iter().map(|piece| format!("「{piece}」")).collect();
                let note = format!("chain「{before}」→{}", named.join("、"));
                (Outcome::Replace(pieces), None, note)
            }
        } else if kept.iter().any(Vec::is_empty) {
            let note = format!("{name}「{before}」を外した (片側の項が全部なくなった)");
            (Outcome::Remove, None, note)
        } else {
            let value = self.written_stages(guard, &site, &kept)?;
            // 1 つのノード (X/* でも X/** でもない項 1 つ) か
            let single = |terms: &Vec<&Term>| match terms.as_slice() {
                [term] => !matches!(
                    term.selector,
                    Some((SelectorScope::Leaves | SelectorScope::All, _))
                ),
                _ => false,
            };
            let one_side = match (kind, kept.as_slice()) {
                (RelationKind::Join, [sources, _]) if single(sources) => Some("始点"),
                (RelationKind::Fork, [_, targets]) if single(targets) => Some("終点"),
                _ => None,
            };
            match one_side {
                Some(side) => {
                    let note =
                        format!("{name}「{before}」→ depends「{value}」({side}が 1 つになった)");
                    (Outcome::Remove, Some(value), note)
                }
                None => {
                    let note = format!("{name}「{before}」→「{value}」");
                    (Outcome::Replace(vec![value]), None, note)
                }
            }
        };
        Ok(Some(SiteEdit {
            site,
            outcome,
            moved,
            note: Some(EditNote {
                code: EditNoteCode::RelationsRemoved,
                count: 1,
                message: note,
            }),
        }))
    }

    // 項を外さない値: 書き直す項だけを差し替え、ほかの字 (区切りの空白など) は原文のまま残す
    fn rewrite_in_place(
        &mut self,
        guard: &Guard<'_>,
        site: Site,
        stages: &[Vec<Term>],
    ) -> Result<Option<SiteEdit>, EditReason> {
        let mut value = String::with_capacity(site.text.len());
        let mut from = 0;
        let mut changed = false;
        for term in stages.iter().flatten() {
            if let Some(written) = self.rewrite_term(guard, term)? {
                value.push_str(site.text.get(from..term.range.start).unwrap_or_default());
                value.push_str(&written);
                from = term.range.end;
                changed = true;
            }
        }
        if !changed {
            return Ok(None);
        }
        value.push_str(site.text.get(from..).unwrap_or_default());
        Ok(Some(SiteEdit {
            site,
            outcome: Outcome::Replace(vec![value]),
            moved: None,
            note: None,
        }))
    }

    // 残った段と項をつなぎ直した式 (段を ` --> `、項を ` & ` でつなぐ。項は原文の字のままか、書き直した字)
    fn written_stages(
        &mut self,
        guard: &Guard<'_>,
        site: &Site,
        stages: &[Vec<&Term>],
    ) -> Result<String, EditReason> {
        let mut written = Vec::with_capacity(stages.len());
        for stage in stages {
            let mut terms = Vec::with_capacity(stage.len());
            for term in stage {
                let raw = site.text.get(term.range.clone()).unwrap_or_default();
                terms.push(
                    self.rewrite_term(guard, term)?
                        .unwrap_or_else(|| raw.to_string()),
                );
            }
            written.push(terms.join(" & "));
        }
        Ok(written.join(" --> "))
    }

    // 書き換える前に解決していた項が、本文を書き換えたあとの原文で同じノード (対応するノード) を指さなくなれば、書き直した項。
    // 名前を変えたノードに一致した区間を新しい名前にした書き方で指せればそれ (名前の変更の追随)、指せなければそのノードの今の書き方 (参照の守り)
    fn rewrite_term(
        &mut self,
        guard: &Guard<'_>,
        term: &Term,
    ) -> Result<Option<String>, EditReason> {
        let (Some((scope, ref_text)), Some(matched)) = (&term.selector, &term.matched) else {
            return Ok(None);
        };
        let Some(target) = matched
            .last()
            .and_then(|id| guard.correspondence.new_id(*id))
        else {
            return Ok(None);
        };
        if resolves_to(&mut self.resolver, ref_text, target) {
            return Ok(None);
        }
        // 新しい名前で書いた項が、式の中で区切りか範囲の記号に読まれるなら使わず、今の書き方で指す
        if let Some(renamed) = guard.follow.renamed
            && matched.contains(&renamed)
            && let Some(candidate) = self.renamed_path(guard, matched)
            && let written = scoped(*scope, &candidate)
            && stands_alone(&mut self.resolver, &written, *scope, target)
        {
            self.written.push((written.clone(), target));
            return Ok(Some(written));
        }
        let written = scoped(*scope, &self.reference(target)?);
        self.rewritten += 1;
        self.written.push((written.clone(), target));
        Ok(Some(written))
    }

    // 区間ごとに一致したノードの、本文を書き換えたあとの名前を逃がしてつないだ参照 (名前を変えたノードの区間は新しい名前になる)
    fn renamed_path(&self, guard: &Guard<'_>, matched: &[u32]) -> Option<String> {
        let segments: Option<Vec<String>> = matched
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let node = self.after.node(guard.correspondence.new_id(*id)?)?;
                (!node.ref_text.is_empty()).then(|| escape_segment(&node.ref_text, index == 0))
            })
            .collect();
        segments.map(|segments| segments.join("/"))
    }
}

// 参照 (範囲の記号を除いたもの) がそのノードに解決するか
fn resolves_to(resolver: &mut Resolver<'_>, ref_text: &str, id: u32) -> bool {
    resolver
        .resolve_ref(ref_text)
        .is_ok_and(|found| found == id)
}

// 参照に範囲の記号を付けた項 (X/*、X/**、(X))
fn scoped(scope: SelectorScope, reference: &str) -> String {
    match scope {
        SelectorScope::SelfScope => reference.to_string(),
        SelectorScope::Leaves => format!("{reference}/*"),
        SelectorScope::All => format!("{reference}/**"),
        SelectorScope::Branch => format!("({reference})"),
    }
}

// frontmatter の参照の値。relations は 4 つの kind の式 (一覧の項目か式 1 つのスカラ)、branches と members は一覧の項目
fn sites_of(frontmatter: &JsValue) -> Vec<Site> {
    let mut sites = Vec::new();
    let Some(markdag) = object(frontmatter).and_then(|top| object(top.get("markdag")?)) else {
        return sites;
    };
    let mut push = |place: Place, path: Vec<PathStep>, list: Vec<String>, value: &JsValue| {
        let mut add = |path: Vec<PathStep>, index: usize, text: &str| {
            sites.push(Site {
                place,
                path,
                list: list.clone(),
                index,
                text: text.to_string(),
            });
        };
        match value {
            JsValue::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    if let JsValue::String(text) = item {
                        let mut item_path = path.clone();
                        item_path.push(PathStep::Index(index));
                        add(item_path, index, text);
                    }
                }
            }
            JsValue::String(text) if matches!(place, Place::Relation(_)) => add(path, 0, text),
            _ => {}
        }
    };
    if let Some(relations) = markdag.get("relations").and_then(object) {
        for (name, value) in relations {
            if let Some(kind) = RelationKind::from_js(&JsValue::String(name.clone())) {
                push(
                    Place::Relation(kind),
                    steps(&["markdag", "relations", name]),
                    vec!["relations".to_string(), name.clone()],
                    value,
                );
            }
        }
    }
    if let Some(branches) = markdag.get("branches") {
        push(
            Place::Branch,
            steps(&["markdag", "branches"]),
            vec!["branches".to_string()],
            branches,
        );
    }
    if let Some(groups) = markdag.get("groups").and_then(object) {
        for (id, def) in groups {
            if let Some(members) = object(def).and_then(|def| def.get("members")) {
                push(
                    Place::Member,
                    steps(&["markdag", "groups", id, "members"]),
                    vec!["groups".to_string(), id.clone(), "members".to_string()],
                    members,
                );
            }
        }
    }
    sites
}

// 値の項を、解析と同じ読み方で段 (`-->` で分けたもの) と項 (`&` で分けたもの) に分けて解決する。
// branches と members は値の全体が項 1 つ。式として読めない値は None
fn stages_of(site: &Site, resolver: &mut Resolver<'_>) -> Option<Vec<Vec<Term>>> {
    let text = site.text.as_str();
    let parts: Vec<&str> = match site.place {
        Place::Relation(_) => {
            let parts = split_outside_quotes(text, &ARROW).ok()?;
            if parts.len() < 2 {
                return None;
            }
            parts
        }
        Place::Branch | Place::Member => vec![text],
    };
    let mut stages = Vec::with_capacity(parts.len());
    for part in parts {
        let raws = match site.place {
            Place::Relation(_) => split_outside_quotes(part, &AMPERSAND).ok()?,
            Place::Branch | Place::Member => vec![part],
        };
        let terms = raws
            .into_iter()
            .map(|raw| {
                let trimmed = js_trim(raw);
                let start = offset_in(text, trimmed);
                let selector = resolver.parse_selector(raw).ok();
                let matched = selector
                    .as_ref()
                    .and_then(|selector| resolver.resolve_path(&selector.ref_text).ok());
                Term {
                    range: start..start + trimmed.len(),
                    selector: selector.map(|selector| (selector.scope, selector.ref_text)),
                    matched,
                }
            })
            .collect();
        stages.push(terms);
    }
    Some(stages)
}

// part は text を分けた字 (text の一部) なので、text の中の位置はポインタの差
fn offset_in(text: &str, part: &str) -> usize {
    (part.as_ptr() as usize).saturating_sub(text.as_ptr() as usize)
}

// 参照の値の一覧 (relations の kind、branches、groups の members) を、一覧ごとの値の並びにしたもの。
// relations の式 1 つのスカラは 1 項目の一覧、値のない一覧と空の一覧は入れない (キーを外したことと空の一覧を同じに見る)
fn reference_lists(frontmatter: &JsValue) -> IndexMap<Vec<String>, Vec<JsValue>> {
    let mut lists = IndexMap::new();
    let Some(markdag) = object(frontmatter).and_then(|top| object(top.get("markdag")?)) else {
        return lists;
    };
    let mut put = |list: Vec<String>, value: &JsValue, single: bool| {
        let items = match value {
            JsValue::Array(items) => items.clone(),
            JsValue::Null | JsValue::Undefined => Vec::new(),
            other if single => vec![other.clone()],
            _ => Vec::new(),
        };
        if !items.is_empty() {
            lists.insert(list, items);
        }
    };
    if let Some(relations) = markdag.get("relations").and_then(object) {
        for (name, value) in relations {
            if RelationKind::from_js(&JsValue::String(name.clone())).is_some() {
                put(vec!["relations".to_string(), name.clone()], value, true);
            }
        }
    }
    if let Some(branches) = markdag.get("branches") {
        put(vec!["branches".to_string()], branches, false);
    }
    if let Some(groups) = markdag.get("groups").and_then(object) {
        for (id, def) in groups {
            if let Some(members) = object(def).and_then(|def| def.get("members")) {
                put(
                    vec!["groups".to_string(), id.clone(), "members".to_string()],
                    members,
                    false,
                );
            }
        }
    }
    lists
}

// 書き直しと書き足しを当てたあとに読まれるはずの一覧
fn expected_lists(
    frontmatter: &JsValue,
    edits: &[SiteEdit],
    appended: &[(RelationKind, String)],
) -> IndexMap<Vec<String>, Vec<JsValue>> {
    let mut lists = reference_lists(frontmatter);
    for (list, items) in &mut lists {
        let mut rebuilt = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            let outcome = edits
                .iter()
                .find(|edit| &edit.site.list == list && edit.site.index == index)
                .map(|edit| &edit.outcome);
            match outcome {
                Some(Outcome::Replace(values)) => {
                    rebuilt.extend(values.iter().cloned().map(JsValue::String));
                }
                Some(Outcome::Remove) => {}
                None => rebuilt.push(item.clone()),
            }
        }
        *items = rebuilt;
    }
    for (kind, value) in appended {
        lists
            .entry(vec!["relations".to_string(), kind.as_str().to_string()])
            .or_default()
            .push(JsValue::String(value.clone()));
    }
    lists.retain(|_, items| !items.is_empty());
    lists
}

fn object(value: &JsValue) -> Option<&IndexMap<String, JsValue>> {
    match value {
        JsValue::Object(entries) => Some(entries),
        _ => None,
    }
}

fn steps(names: &[&str]) -> Vec<PathStep> {
    names
        .iter()
        .map(|name| PathStep::Key((*name).to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_refs_free_marker_takes_the_smallest_unused_number() {
        let mut used: Vec<String> = Vec::new();
        assert_eq!(free_marker(&mut used), "n1");
        // 1 回の操作で 2 つ目を足すときは、足した番号を使ったものとして数える
        assert_eq!(free_marker(&mut used), "n2");
        let mut used = vec!["n1".to_string(), "n3".to_string(), "x".to_string()];
        assert_eq!(free_marker(&mut used), "n2");
        assert_eq!(free_marker(&mut used), "n4");
    }

    #[test]
    fn edit_refs_marked_line_appends_the_id_after_one_space_and_keeps_the_carriage() {
        assert_eq!(marked_line("- a", "n1"), "- a $n1");
        assert_eq!(marked_line("- a  \t", "n1"), "- a $n1");
        assert_eq!(marked_line("- a #k %g\r", "n2"), "- a #k %g $n2\r");
        assert_eq!(marked_line("## 見出し\r", "n1"), "## 見出し $n1\r");
        assert_eq!(marked_line("-", "n1"), "- $n1");
    }
}
