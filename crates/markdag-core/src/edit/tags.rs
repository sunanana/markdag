// 原文なし。
// タグの書き換え。付ける (setTag)、外す (removeTag)、一覧での付け外し (toggleTag) は、選んだノードの 1 行目の末尾の印の並びを書き換える。
// 新しいタグは印の並びの末尾に空白 1 つで足し、同じキーのタグはその位置で書き換える (ほかの %、#、$ の印と間の空白は残す)。
// 1 行に同じキーのタグが 2 つあれば、最初のものだけを扱う。キーは改行を空白にして前後の空白と先頭の # を 1 つ外し、空になるキーだけを断る。
// 値は改行を空白にして前後の空白を外す (空の値を渡せば値のないタグ)。タグは本文に書く形 (format_tag) で書く: キーは文字、数字、_、- の外の字を
// 含むか数字だけなら、値は空白、`,`、`"`、`\` のどれかを含むか空なら "…" で囲み、囲みの中の " と \ を逃がす。
// toggleTag は、選んだノードの全部にそのキー (値を渡せばその値) があれば外し、なければ持たないノードに足す。複数の値を持てるキー
// (定義がないか multiple: true) には `,` で値を足し、持てないキーは値を置き換える。
// 印を読まない見出し (下線の見出しと行頭に空白のある見出し) は、ATX の見出しに書き直してから書く (外すときは書き直さない)。
// 印を書けないノード (容器と行のないルート、表とコードと画像、書き直すと名前が変わる見出し) を含めば全体を断る。markdag キーのない文書では、
// タグを書くときだけ markdag: を足す (印が読まれていないのでタグはなく、外す操作は何も変えない)。
// 書いたあとの原文を解析し直し、選んだノードのタグがねらいのキーと値の並びに読まれ、本文の形と、ほかのノードの印が変わらないことを確かめる
// (リストの容器と 1 行目を分け合う最初の項目も、その行の印は項目だけが読む (容器は読まない) ので、ほかの項目と同じく書ける)。
use super::blocks::{ParsedSource, display_name, model_of, start_line};
use super::frontmatter::Marking;
use super::headings::with_atx_headings;
use super::lines::{LinePlan, split_carriage};
use super::names::normalize_label;
use super::verify::{Expectation, keeps_structure, target_of};
use super::{STALE_NODE, STRUCTURE_CHANGED, refused, unchanged};
use crate::model::tags::format_tag;
use crate::parse::{is_mark_line, merge_tags, parse_tag, trailing_marks};
use crate::types::{
    EditReasonCode, EditSelection, EditSourceResult, GraphModel, NodeKind, NodeTag, NodeTarget,
    OutlineNode, SourcePosition,
};

// タグ 1 つのキーと値 (解析の NodeTag のうち、比べる所)
type TagRow = (String, Vec<String>);

/// 選んだノードにタグを付ける。同じキーのタグはその位置で書き換える。replace_key (キーを変える編集のもとのキー) があれば、
/// そのタグの位置に新しいタグを書き (新しいキーのタグがもうあれば、そちらを書き換えてもとのキーのタグを外す)。選ぶのは同じノード
pub(super) fn set_tag(
    source: &str,
    targets: &[NodeTarget],
    key: &str,
    value: Option<&str>,
    replace_key: Option<&str>,
) -> EditSourceResult {
    let (before, nodes) = match selected(source, targets) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    // 印を読まない見出しは、ATX の見出しに書き直した原文で付ける
    let chosen: Vec<&OutlineNode> = nodes.iter().collect();
    if let Some(result) = with_atx_headings(source, &before, &chosen, |text| {
        set_tag(text, targets, key, value, replace_key)
    }) {
        return result;
    }
    let Some(key) = tag_key(key) else {
        return key_invalid();
    };
    let replaced = match replace_key {
        None => None,
        Some(raw) => match tag_key(raw) {
            Some(old) if old == key => None,
            Some(old) => Some(old),
            None => return key_invalid(),
        },
    };
    if let Err(result) = markable(&before, &nodes, true) {
        return result;
    }
    let tag: TagRow = (key.clone(), tag_value(value).into_iter().collect());
    rewrite_marks(source, &before, &nodes, true, |line, _| {
        let at_key = line.find(&key);
        match (&replaced, at_key) {
            (Some(old), Some(at)) => {
                line.replace(at, tag.clone());
                if let Some(at_old) = line.find(old) {
                    line.remove(at_old);
                }
            }
            (Some(old), None) => match line.find(old) {
                Some(at_old) => line.replace(at_old, tag.clone()),
                None => line.append(tag.clone()),
            },
            (None, Some(at)) => line.replace(at, tag.clone()),
            (None, None) => line.append(tag.clone()),
        }
    })
}

/// 選んだノードからそのキーのタグを外す (値ごと)。どのノードにもそのキーがなければ変えない。選ぶのは同じノード
pub(super) fn remove_tag(source: &str, targets: &[NodeTarget], key: &str) -> EditSourceResult {
    let (before, nodes) = match selected(source, targets) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    // 空のキーのタグはないので、確かめずに探す (見つからなければ変えない)
    let key = trimmed_key(key);
    let key = key.as_str();
    if !nodes.iter().any(|node| has_key(node, key)) {
        return unchanged(
            EditReasonCode::NothingToChange,
            "選んだノードにそのキーのタグがないので、外すものがありません",
        );
    }
    // 外すときは印を書かないので、印を読まない見出し (外すタグを持たない) は書き直さずにそのまま残す
    if let Err(result) = markable(&before, &nodes, false) {
        return result;
    }
    rewrite_marks(source, &before, &nodes, false, |line, _| {
        if let Some(at) = line.find(key) {
            line.remove(at);
        }
    })
}

/// 一覧での付け外し: 選んだノードの全部にそのキー (value があればその値) があれば外し (値がほかにもあればその値だけ)、
/// そうでなければ持たないノードに足す。選ぶのは同じノード
pub(super) fn toggle_tag(
    source: &str,
    targets: &[NodeTarget],
    key: &str,
    value: Option<&str>,
) -> EditSourceResult {
    let (before, nodes) = match selected(source, targets) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    // 印を読まない見出しは、ATX の見出しに書き直した原文で付け外す (そういう見出しはタグを持たないので、いつも足す側になる)
    let chosen: Vec<&OutlineNode> = nodes.iter().collect();
    if let Some(result) = with_atx_headings(source, &before, &chosen, |text| {
        toggle_tag(text, targets, key, value)
    }) {
        return result;
    }
    let Some(key) = tag_key(key) else {
        return key_invalid();
    };
    if let Err(result) = markable(&before, &nodes, true) {
        return result;
    }
    let value = tag_value(value);
    // 付いているかは、今の図 (書き換える前の原文の解析) で見る。markdag キーのない文書はタグを持たないので、いつも足す
    let has = |tags: &[NodeTag]| {
        tags.iter().filter(|tag| tag.key == key).any(|tag| {
            value
                .as_ref()
                .is_none_or(|value| tag.values.contains(value))
        })
    };
    if nodes.iter().all(|node| has(&node.tags)) {
        return rewrite_marks(source, &before, &nodes, false, |line, _| {
            let Some(at) = line.find(&key) else {
                return;
            };
            let Some(value) = &value else {
                line.remove(at);
                return;
            };
            let mut values = line.values(at);
            values.retain(|item| item != value);
            if values.is_empty() {
                line.remove(at);
            } else {
                line.replace(at, (key.clone(), values));
            }
        });
    }
    rewrite_marks(source, &before, &nodes, true, |line, model| {
        if has(&line.tags()) {
            return;
        }
        let Some(at) = line.find(&key) else {
            line.append((key.clone(), value.iter().cloned().collect()));
            return;
        };
        // 値のないタグを渡したときは、キーがあれば付いている (上で返っている)
        let Some(value) = &value else {
            return;
        };
        let mut values = line.values(at);
        if values.is_empty() || !takes_many(model, &key) {
            values.clear();
        }
        values.push(value.clone());
        line.replace(at, (key.clone(), values));
    })
}

/// 指したノード (文書の順、重ねて指したものは 1 つ) と書き換える前の原文の解析。古い NodeTarget なら断り、
/// ノードがなければ変えない
pub(super) fn selected<'s>(
    source: &'s str,
    targets: &[NodeTarget],
) -> Result<(ParsedSource<'s>, Vec<OutlineNode>), EditSourceResult> {
    let before = ParsedSource::read(source);
    let mut nodes: Vec<OutlineNode> = Vec::with_capacity(targets.len());
    for target in targets {
        let Some(node) = before.find(target) else {
            return Err(refused(EditReasonCode::StaleNode, STALE_NODE));
        };
        if !nodes.iter().any(|other| other.id == node.id) {
            nodes.push(node.clone());
        }
    }
    if nodes.is_empty() {
        return Err(unchanged(
            EditReasonCode::NothingToChange,
            "ノードを選んでいないので、書き換えるものがありません",
        ));
    }
    nodes.sort_by_key(|node| node.id);
    Ok((before, nodes))
}

// キーの改行を空白にして前後の空白を外し、先頭の # を 1 つ外したもの
fn trimmed_key(raw: &str) -> String {
    let key = normalize_label(raw);
    key.strip_prefix('#').unwrap_or(&key).to_string()
}

// 書けるキー: 前後の空白と先頭の # を外して空でないもの。タグのキーに読めない字を含むキーと数字だけのキーは、format_tag が囲んで書く
fn tag_key(raw: &str) -> Option<String> {
    Some(trimmed_key(raw)).filter(|key| !key.is_empty())
}

// 値: 改行 (5 種類) を空白 1 つにし、前後の空白を外す。空なら値のないタグ
fn tag_value(value: Option<&str>) -> Option<String> {
    value.map(normalize_label).filter(|value| !value.is_empty())
}

fn has_key(node: &OutlineNode, key: &str) -> bool {
    node.tags.iter().any(|tag| tag.key == key)
}

// 複数の値を持てるキーか (markdag.tags.keys に定義がないか、multiple: true)
fn takes_many(model: &GraphModel, key: &str) -> bool {
    model
        .tag_keys
        .iter()
        .find(|definition| definition.key == key)
        .is_none_or(|definition| definition.multiple)
}

// 1 行目に印を書けるか。書けないノードがあれば、文書の順で最初のものの名前を入れて断る。
// writes が偽 (印を外すだけ) なら、印を読まない見出しは断らない (その行は変えない)
fn markable(
    read: &ParsedSource<'_>,
    nodes: &[OutlineNode],
    writes: bool,
) -> Result<(), EditSourceResult> {
    for node in nodes {
        let name = display_name(node);
        match read.kind_of(node) {
            NodeKind::Block => {
                return Err(refused(
                    EditReasonCode::BlockNode,
                    &format!(
                        "表、コード、画像のノード ({name}) は印を書く行を持たないので、タグを書けません"
                    ),
                ));
            }
            NodeKind::List | NodeKind::Root => {
                return Err(refused(
                    EditReasonCode::NoSourceLine,
                    &format!(
                        "「{name}」は原文に印を書く行を持たない (リストの入れ物か、行のないルート) ので、タグを書けません"
                    ),
                ));
            }
            NodeKind::Heading | NodeKind::Item => {
                if writes && !read.first_line(node).is_some_and(|first| first.can_mark) {
                    return Err(refused(
                        EditReasonCode::MarkerLine,
                        &format!(
                            "「{name}」は本文が 2 行以上の下線の見出しで、印を書ける 1 行の見出しにすると名前が変わるので、タグを書けません"
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

// 選んだノードの 1 行目の印の並びを change で書き換え、確かめた結果。adds_markdag なら、markdag キーのない文書に markdag: を足してから
// 書く (frontmatter がなければ作る)。どの行も変わらず markdag: も足さなければ変えない
fn rewrite_marks(
    source: &str,
    before: &ParsedSource<'_>,
    nodes: &[OutlineNode],
    adds_markdag: bool,
    mut change: impl FnMut(&mut MarkedLine, &GraphModel),
) -> EditSourceResult {
    let marking = if adds_markdag && !before.parsed.extracted {
        match Marking::of(source, before) {
            Ok(marking) => Some(marking),
            Err(result) => return result,
        }
    } else {
        None
    };
    let marked_text = marking
        .as_ref()
        .map_or(source, |marking| marking.text.as_str());
    let marked = ParsedSource::read(marked_text);
    let ids = match &marking {
        Some(marking) => {
            let nodes: Vec<&OutlineNode> = nodes.iter().collect();
            marking.ids(before, &marked, &nodes)
        }
        None => Some(nodes.iter().map(|node| node.id).collect()),
    };
    let Some(ids) = ids else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    let model = model_of(&marked);
    let mut plan = LinePlan::new(&marked.lines);
    let mut aims: Vec<(u32, Vec<TagRow>)> = Vec::with_capacity(ids.len());
    for id in &ids {
        let Some(index) = marked
            .node(*id)
            .and_then(|node| marked.first_line(node))
            .map(|first| first.index as usize)
        else {
            return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
        };
        let Some(text) = plan.line(index) else {
            return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
        };
        let mut line = MarkedLine::read(text, marked.parsed.extracted);
        change(&mut line, &model);
        aims.push((*id, tag_rows(&line.tags())));
        plan.rewrite(index, line.text());
    }
    if marking.is_none() && plan.splices().is_empty() {
        return unchanged(
            EditReasonCode::NothingToChange,
            "書くタグが今と同じなので、変えるところがありません",
        );
    }
    let selected = match verified(&marked, &plan, &aims) {
        Ok(selected) => selected,
        Err(result) => return result,
    };
    EditSourceResult::Edited {
        splices: marking.as_ref().map_or_else(
            || plan.splices(),
            |marking| marking.plan.then(&plan).splices(),
        ),
        select: EditSelection::Nodes { nodes: selected },
        rename: None,
        notes: marking
            .as_ref()
            .map_or_else(Vec::new, |marking| marking.notes(before)),
    }
}

// 書き換えたあとの原文を解析し直し、選んだノードのタグがねらいのキーと値の並びに読まれ、本文の形 (ノードの数、親子、名前、種類) と、
// ほかのノードのタグと、全部のノードのグループ、$id、タスクの状態が変わらないか。通れば、選んだノード (aims の順) を指すもの
fn verified(
    before: &ParsedSource<'_>,
    plan: &LinePlan<'_>,
    aims: &[(u32, Vec<TagRow>)],
) -> Result<Vec<NodeTarget>, EditSourceResult> {
    let text = plan.text();
    let after = ParsedSource::read(&text);
    // 1 行目は同じ位置で書き換えるだけなので、形が変わらなければ同じ id のノードが同じ行から始まる
    for (id, aim) in aims {
        let (Some(old), Some(new)) = (before.node(*id), after.node(*id)) else {
            return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
        };
        if start_line(old) != start_line(new) || &tag_rows(&new.tags) != aim {
            return Err(refused(
                EditReasonCode::StructureChanged,
                &format!(
                    "「{}」に書いたタグが、書いたとおりのキーと値に読まれないので、書き換えません",
                    display_name(old)
                ),
            ));
        }
    }
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
        let expected = aims
            .iter()
            .find(|(id, _)| *id == old.id)
            .map_or_else(|| tag_rows(&old.tags), |(_, aim)| aim.clone());
        let same_marks = tag_rows(&new.tags) == expected
            && new.groups == old.groups
            && new.ref_id == old.ref_id
            && new.task.as_ref().map(|task| task.state) == old.task.as_ref().map(|task| task.state);
        if !same_marks {
            return Err(refused(
                EditReasonCode::StructureChanged,
                "タグを書くと、選んでいないノードの印まで変わって読まれるので、書き換えません",
            ));
        }
    }
    aims.iter()
        .map(|(id, _)| {
            correspondence
                .new_id(*id)
                .and_then(|new_id| after.node(new_id))
                .map(target_of)
        })
        .collect::<Option<Vec<NodeTarget>>>()
        .ok_or_else(|| refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED))
}

fn tag_rows(tags: &[NodeTag]) -> Vec<TagRow> {
    tags.iter()
        .map(|tag| (tag.key.clone(), tag.values.clone()))
        .collect()
}

// 空のキーを断る (GUI の通知にそのまま出るので、理由を書きすぎない)
fn key_invalid() -> EditSourceResult {
    refused(EditReasonCode::TagKeyInvalid, "タグのキーを空にできません")
}

// 印の位置はタグの読み方に使わないので、何も指さない値
fn nowhere() -> SourcePosition {
    SourcePosition {
        line: 0,
        column: 0,
        length: 0,
    }
}

// 1 行目の末尾の印 1 つ
struct Mark {
    // 前の空白
    gap: String,
    // 印の字 (`#キー:値`、`%名前`、`$名前`)
    text: String,
    // タグなら、解析が読むキーと値
    tag: Option<NodeTag>,
}

// 1 行目を、印の前 (行頭と本文)、末尾の印の並び、最後の印のあとの空白、行末の \r に分けたもの。つなげると行に戻る
struct MarkedLine {
    head: String,
    marks: Vec<Mark>,
    tail: String,
    carriage: String,
    // 行末の印を外したので、残った行末の空白も外す
    trim_end: bool,
}

impl MarkedLine {
    // 末尾の印は解析と同じく、markdag キーのある文書の、印を読む形の行でだけ読む
    fn read(line: &str, extracted: bool) -> Self {
        let (content, carriage) = split_carriage(line);
        let found = if extracted && is_mark_line(content) {
            trailing_marks(content)
        } else {
            Vec::new()
        };
        let head_end = found.first().map_or(content.len(), |mark| mark.start);
        let tail_start = found.last().map_or(content.len(), |mark| mark.token.end);
        let marks = found
            .iter()
            .map(|mark| {
                let text = &content[mark.token.clone()];
                Mark {
                    gap: content[mark.start..mark.token.start].to_string(),
                    text: text.to_string(),
                    tag: text.starts_with('#').then(|| parse_tag(text, nowhere())),
                }
            })
            .collect();
        MarkedLine {
            head: content[..head_end].to_string(),
            marks,
            tail: content[tail_start..].to_string(),
            carriage: carriage.to_string(),
            trim_end: false,
        }
    }

    // そのキーの最初のタグの位置
    fn find(&self, key: &str) -> Option<usize> {
        self.marks
            .iter()
            .position(|mark| mark.tag.as_ref().is_some_and(|tag| tag.key == key))
    }

    // at の位置のタグの値
    fn values(&self, at: usize) -> Vec<String> {
        self.marks
            .get(at)
            .and_then(|mark| mark.tag.as_ref())
            .map(|tag| tag.values.clone())
            .unwrap_or_default()
    }

    // 解析が読むタグの並び (同じキーは最初の位置に値をつなげる)
    fn tags(&self) -> Vec<NodeTag> {
        merge_tags(
            self.marks
                .iter()
                .filter_map(|mark| mark.tag.clone())
                .collect(),
        )
    }

    // at の位置の印を、そのタグに書き換える (前の空白は残す)
    fn replace(&mut self, at: usize, (key, values): TagRow) {
        let tag = NodeTag {
            key,
            values,
            at: nowhere(),
        };
        if let Some(mark) = self.marks.get_mut(at) {
            mark.text = format_tag(&tag);
            mark.tag = Some(tag);
        }
    }

    // at の位置の印を、前の空白ごと外す。行末の印を外したら、残った行末の空白も外す
    fn remove(&mut self, at: usize) {
        if at >= self.marks.len() {
            return;
        }
        self.marks.remove(at);
        if at == self.marks.len() {
            self.tail.clear();
            self.trim_end = true;
        }
    }

    // 印の並びの末尾に、空白 1 つとそのタグを足す (行末の空白は外す)
    fn append(&mut self, (key, values): TagRow) {
        let tag = NodeTag {
            key,
            values,
            at: nowhere(),
        };
        if self.marks.is_empty() {
            let head = self.head.trim_end_matches([' ', '\t']).len();
            self.head.truncate(head);
        }
        self.tail.clear();
        self.marks.push(Mark {
            gap: " ".to_string(),
            text: format_tag(&tag),
            tag: Some(tag),
        });
    }

    fn text(&self) -> String {
        let mut content = self.head.clone();
        for mark in &self.marks {
            content.push_str(&mark.gap);
            content.push_str(&mark.text);
        }
        content.push_str(&self.tail);
        if self.trim_end {
            let end = content.trim_end_matches([' ', '\t']).len();
            content.truncate(end);
        }
        format!("{content}{}", self.carriage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_tags_key_drops_surrounding_spaces_and_a_leading_hash() {
        for (raw, key) in [
            ("k", "k"),
            ("#owner", "owner"),
            ("  #owner  ", "owner"),
            ("\u{3000}prio\u{3000}", "prio"),
            ("due-date", "due-date"),
        ] {
            assert_eq!(tag_key(raw).as_deref(), Some(key), "{raw:?}");
        }
    }

    #[test]
    fn edit_tags_key_refuses_only_empty_keys() {
        // 前後の空白と先頭の # を外して空になるキーだけは書けない (D-072)
        for raw in ["", "  ", "#"] {
            assert_eq!(tag_key(raw), None, "{raw:?}");
        }
        // 空白、:、#、%、$、"、, を含むキーも書ける (" で囲んで書く。B-134)
        for raw in ["a b", "a:b", "a#b", "a%b", "a$b", "a\"b", "a,b"] {
            assert_eq!(tag_key(raw).as_deref(), Some(raw), "{raw:?}");
        }
    }

    #[test]
    fn edit_tags_value_turns_line_breaks_into_spaces_and_empty_into_none() {
        assert_eq!(tag_value(Some("  a\r\nb  ")).as_deref(), Some("a b"));
        assert_eq!(
            tag_value(Some("a\u{2028}b\u{2029}c\rd")).as_deref(),
            Some("a b c d")
        );
        assert_eq!(tag_value(Some("   ")), None);
        assert_eq!(tag_value(Some("")), None);
        assert_eq!(tag_value(None), None);
    }
}
