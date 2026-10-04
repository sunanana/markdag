// 原文なし。
// frontmatter の書き換え。YAML を丸ごと書き直さず、位置の木 (FrontmatterLocator の block) で行を探して、その行の前後に足すか、
// その行を消すか、その行の値の範囲を書き直す。キーの並び、字下げ、コメントの行を保つ (足すキーは写像の末尾、足す項目は一覧の末尾)。
// 道すじを手前からたどり、フロー形式の写像と一覧には足せないので断り (書き直しの側が字下げの形にしてやり直す)、
// 写像のいる所が写像でなければ断る。
// markdag キーのない文書には、書き換える前に markdag: を (frontmatter のない文書には frontmatter ごと) 足す
// (markdag キーのない文書では本文の行末の %、#、$ が印として読まれないため)。文書の先頭の BOM は frontmatter を作るときと、
// BOM のせいで読まれていない frontmatter (BOM のすぐあとが --- の行) に足すときに外す。
// 値は、そのまま書いて同じ文字列として読めるなら引用符なしで、読めなければ引用符で囲んで書く。
use std::ops::RangeInclusive;

use super::blocks::ParsedSource;
use super::lines::{LinePlan, carriage_of, is_blank, split_carriage};
use super::refused;
use super::verify::map_line;
use crate::model::locator::{BlockShape, FrontmatterBlock, FrontmatterLocator};
use crate::model::util::{JsValue, yaml_core_scalar};
use crate::parse::{is_mark_line, trailing_marks};
use crate::types::{
    EditNote, EditNoteCode, EditReason, EditReasonCode, EditSourceResult, LineSplice, NodeKind,
    OutlineNode, PathStep,
};

// 新しく作る階層の字下げの幅 (frontmatter に字下げした行がないとき)
const DEFAULT_WIDTH: usize = 4;
// 引用符なしでは書けない書き始めの字
const INDICATORS: &str = "-?:,[]{}#&*!|>'\"%@`";
// 引用符なしで書くと文字列でない値に読まれる語 (大文字と小文字を問わない)
const RESERVED_WORDS: [&str; 8] = ["null", "true", "false", "yes", "no", "on", "off", "~"];

/// markdag キーのある原文にしたこと (frontmatter を作ったか、先頭の BOM を外したか、markdag: を足したか)
pub(super) struct MarkdagAdded {
    frontmatter: bool,
    bom: bool,
    markdag: bool,
}

/// markdag キーのある原文にする行の列。キーがあれば原文のまま (None)。
/// frontmatter がなければ文書の先頭に作り (もとの 1 行目が空でなければ閉じの --- のあとに空行をはさむ。先頭の BOM は外す)、
/// markdag キーがなければ最上位の写像の末尾 (空の frontmatter なら閉じの --- の前) に `markdag:` を足す。
/// 先頭の BOM のすぐあとが --- の行の文書は、BOM を外して読まれるようになった frontmatter に足す (markdag キーがあれば外すだけ)
pub(super) fn with_markdag<'a>(
    source: &str,
    original: &'a [&'a str],
) -> Result<(LinePlan<'a>, Option<MarkdagAdded>), EditReason> {
    let locator = FrontmatterLocator::new(Some(source));
    let carriage = carriage_of(source);
    let mut plan = LinePlan::new(original);
    let Some((_, close)) = locator.fence_lines() else {
        let (first, first_carriage) = split_carriage(original.first().copied().unwrap_or(""));
        let unmarked = first.strip_prefix('\u{feff}');
        // BOM のすぐあとが --- の行なら、BOM を外すとその frontmatter が読まれるので、外した原文の frontmatter に足す
        if unmarked == Some("---")
            && let Some(text) = source.strip_prefix('\u{feff}')
            && FrontmatterLocator::new(Some(text)).fence_lines().is_some()
        {
            let lines: Vec<&str> = text.split('\n').collect();
            let (inner, added) = with_markdag(text, &lines)?;
            plan.rewrite(0, format!("---{first_carriage}"));
            return Ok((
                plan.then(&inner),
                Some(MarkdagAdded {
                    frontmatter: false,
                    bom: true,
                    markdag: added.is_some(),
                }),
            ));
        }
        if let Some(rest) = unmarked {
            plan.rewrite(0, format!("{rest}{first_carriage}"));
        }
        let mut lines: Vec<String> = ["---", "markdag:", "---"]
            .iter()
            .map(|line| format!("{line}{carriage}"))
            .collect();
        if !is_blank(unmarked.unwrap_or(first)) {
            lines.push(carriage.to_string());
        }
        plan.insert(0, lines);
        return Ok((
            plan,
            Some(MarkdagAdded {
                frontmatter: true,
                bom: unmarked.is_some(),
                markdag: true,
            }),
        ));
    };
    if !locator.syntax_errors().is_empty() {
        return Err(refusal(
            EditReasonCode::FrontmatterInvalid,
            "frontmatter を YAML として読めないので、書き足せません。YAML の誤りを直してください",
            None,
        ));
    }
    let at = match locator.block(&[]) {
        // 空の frontmatter (コメントだけのものを含む)
        None => close as usize,
        Some(whole) if whole.flow => {
            return Err(flow_style(None));
        }
        Some(whole) if whole.shape != BlockShape::Map => {
            return Err(not_map(None));
        }
        Some(_) if locator.block(&[key("markdag")]).is_some() => return Ok((plan, None)),
        Some(whole) => whole.last_line as usize + 1,
    };
    let indent = locator
        .block(&[])
        .and_then(|whole| whole.child_indent)
        .unwrap_or(0) as usize;
    plan.insert(
        at,
        vec![format!("{}markdag:{carriage}", " ".repeat(indent))],
    );
    Ok((
        plan,
        Some(MarkdagAdded {
            frontmatter: false,
            bom: false,
            markdag: true,
        }),
    ))
}

/// markdag キーを足したことの知らせ。changed は markdag: を足して名前の読み方が変わるノードの数
pub(super) fn markdag_notes(added: &MarkdagAdded, changed: u32) -> Vec<EditNote> {
    let mut notes = Vec::new();
    if added.frontmatter {
        notes.push(EditNote {
            code: EditNoteCode::FrontmatterAdded,
            count: 1,
            message: "frontmatter がなかったので、文書の先頭に作りました".to_string(),
        });
    }
    if added.bom {
        notes.push(EditNote {
            code: EditNoteCode::BomRemoved,
            count: 1,
            message: "frontmatter は文書の先頭の --- でしか読まれないので、文書の先頭の BOM (U+FEFF) を外しました".to_string(),
        });
    }
    if !added.markdag {
        return notes;
    }
    notes.push(EditNote {
        code: EditNoteCode::MarkdagAdded,
        count: changed,
        message: if changed > 0 {
            format!(
                "frontmatter に markdag: を足しました。行末の %、#、$ が印として読まれるようになり、名前の読み方が変わったノードが {changed} 個あります"
            )
        } else {
            "frontmatter に markdag: を足しました (行末の %、#、$ は印として読まれます)".to_string()
        },
    });
    notes
}

/// markdag: を足すと名前の読み方が変わるノード (1 行目が印を読む形の行で、行末が印に読める見出しと項目) の数。
/// markdag キーのない文書の解析で数える
pub(super) fn names_read_differently(read: &ParsedSource<'_>) -> u32 {
    let count = read
        .parsed
        .nodes
        .iter()
        .filter(|node| matches!(read.kind_of(node), NodeKind::Heading | NodeKind::Item))
        .filter_map(|node| node.lines.as_ref())
        .filter_map(|lines| read.lines.get(lines.start as usize))
        .filter(|line| {
            let content = split_carriage(line).0;
            is_mark_line(content) && !trailing_marks(content).is_empty()
        })
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// markdag キーのある原文にしたもの (キーがあれば原文のまま)。参照の書き方と書き換えたあとの確かめは、この原文で数える
pub(super) struct Marking<'a> {
    /// 書き換える前の原文の行に対する、markdag キーのある原文の行の列
    pub(super) plan: LinePlan<'a>,
    /// markdag キーのある原文
    pub(super) text: String,
    added: Option<MarkdagAdded>,
}

impl<'a> Marking<'a> {
    /// markdag キーがなければ足す (frontmatter がなければ作る)。足したあとの原文で markdag の指定が読まれなければ断る
    pub(super) fn of(source: &str, before: &'a ParsedSource<'a>) -> Result<Self, EditSourceResult> {
        let (plan, added) = with_markdag(source, &before.lines)
            .map_err(|reason| EditSourceResult::Refused { reason })?;
        let text = plan.text();
        if !ParsedSource::read(&text).parsed.extracted {
            return Err(refused(
                EditReasonCode::FrontmatterInvalid,
                "frontmatter の markdag の指定が読まれていないので、書き足せません。frontmatter の書き方を確かめてください",
            ));
        }
        Ok(Marking { plan, text, added })
    }

    /// 書き換える前のノードに当たる、markdag キーのある原文のノードの id (並びは nodes のまま)
    pub(super) fn ids(
        &self,
        before: &ParsedSource<'_>,
        marked: &ParsedSource<'_>,
        nodes: &[&OutlineNode],
    ) -> Option<Vec<u32>> {
        if self.added.is_none() {
            return Some(nodes.iter().map(|node| node.id).collect());
        }
        let splices = self.plan.splices();
        nodes
            .iter()
            .map(|node| counterpart(before, marked, &splices, node))
            .collect()
    }

    /// markdag キーを足したことの知らせ (足していなければ空)
    pub(super) fn notes(&self, before: &ParsedSource<'_>) -> Vec<EditNote> {
        match &self.added {
            Some(added) => markdag_notes(added, names_read_differently(before)),
            None => Vec::new(),
        }
    }
}

// markdag: を足す前のノードに当たる、足したあとのノード。1 行目の行を差し替えで写し、同じ行から始まる同じ種類と深さのノード。
// 行を持たないルートは、足したあとも行を持たないルート
fn counterpart(
    before: &ParsedSource<'_>,
    after: &ParsedSource<'_>,
    splices: &[LineSplice],
    node: &OutlineNode,
) -> Option<u32> {
    let Some(lines) = &node.lines else {
        return after
            .node(1)
            .filter(|root| root.lines.is_none() && node.parent.is_none())
            .map(|root| root.id);
    };
    let line = map_line(splices, lines.start)?;
    let tag = before.tag_of(node);
    let found: Vec<&OutlineNode> = after
        .parsed
        .nodes
        .iter()
        .filter(|other| {
            other
                .lines
                .as_ref()
                .is_some_and(|lines| lines.start == line)
                && other.depth == node.depth
                && after.tag_of(other) == tag
        })
        .collect();
    match found.as_slice() {
        [only] => Some(only.id),
        _ => None,
    }
}

// 道すじの先に行を足す所。rewrites を当ててから、at の行の前に lines (足りないキー) を足し、その下の行を indent の字下げで書く
struct Insertion {
    // 書き直す行 (原文の行の添字と、書き直したあとの字。行末の \r を含む)
    rewrites: Vec<(usize, String)>,
    // この行の前に足す
    at: usize,
    // 足りないキーの行 (行末の \r を含む)
    lines: Vec<String>,
    // 足す行 (一覧の項目か、写像の組) の字下げ
    indent: usize,
    // 新しく作る階層の字下げの幅
    width: usize,
    carriage: &'static str,
}

// 道すじをたどった先
enum Reached {
    // 道すじの途中か最後の値がないか、値のない null。足りないキーを作って足す所
    Absent(Insertion),
    // 道すじの最後の値 (フロー形式でない写像、一覧、値の字のあるスカラ、別名)
    Present(Found),
}

// 道すじの最後にあった値
struct Found {
    block: FrontmatterBlock,
    key_line: usize,
    // キーの字の始まりの桁 (字数)
    key_column: usize,
    width: usize,
    carriage: &'static str,
    // 道すじを . でつないだもの (断る理由の path)
    place: String,
}

// 道すじ (frontmatter に markdag キーがある原文) を手前からたどる。たどった値が写像か値の字のない null なら続け、
// `~` などの null は値の範囲を消して値の字のない null として続ける。ないキーは親の写像の末尾に作る所を返す。
// フロー形式なら flow-style、最後より手前で写像のいる所が写像でなければ frontmatter-not-map で断る
fn reach(text: &str, path: &[&str]) -> Result<Reached, EditReason> {
    let locator = FrontmatterLocator::new(Some(text));
    let lines: Vec<&str> = text.split('\n').collect();
    let carriage = carriage_of(text);
    let Some(fences) = locator.fence_lines() else {
        return Err(not_map(None));
    };
    let width = indent_width(&lines, fences);
    let mut parent = match locator.block(&[]) {
        Some(whole) if whole.flow => return Err(flow_style(None)),
        Some(whole) if whole.shape == BlockShape::Map => whole,
        _ => return Err(not_map(None)),
    };
    let mut steps: Vec<PathStep> = Vec::new();
    // keys を indent から幅 width ずつ下げて書き (キーは値と同じ書き方)、その下の行の字下げを決める
    let below = |rewrites: Vec<(usize, String)>, at: usize, keys: &[&str], indent: usize| {
        let lines = keys
            .iter()
            .enumerate()
            .map(|(depth, name)| {
                format!(
                    "{}{}:{carriage}",
                    " ".repeat(indent + depth * width),
                    yaml_value(name)
                )
            })
            .collect();
        Reached::Absent(Insertion {
            rewrites,
            at,
            lines,
            indent: indent + keys.len() * width,
            width,
            carriage,
        })
    };
    for (depth, name) in path.iter().enumerate() {
        steps.push(key(name));
        let place = dotted(path, depth);
        let last = depth + 1 == path.len();
        let Some(block) = locator.block(&steps) else {
            // ないキー: 親の写像の末尾に、ここから下のキーを足す
            let indent = parent.child_indent.unwrap_or(0) as usize;
            return Ok(below(
                Vec::new(),
                parent.last_line as usize + 1,
                &path[depth..],
                indent,
            ));
        };
        if block.flow {
            return Err(flow_style(Some(place)));
        }
        let key_line = block.key_line.unwrap_or(block.first_line) as usize;
        let key_column = locator
            .key(&steps)
            .map_or(0, |position| position.column.saturating_sub(1) as usize);
        match block.shape {
            BlockShape::Null => {
                return Ok(below(
                    Vec::new(),
                    key_line + 1,
                    &path[depth + 1..],
                    key_column + width,
                ));
            }
            BlockShape::Scalar if block.value_is_null => {
                // `~` の下に子を書くと YAML の誤りになるので、値の範囲を消して値の字のない null にする
                let Some(line) = lines.get(key_line) else {
                    return Err(not_map(Some(place)));
                };
                let value = locator.value(&steps, None);
                return Ok(below(
                    vec![(key_line, without_value(line, value.as_ref()))],
                    key_line + 1,
                    &path[depth + 1..],
                    key_column + width,
                ));
            }
            _ if last => {
                return Ok(Reached::Present(Found {
                    block,
                    key_line,
                    key_column,
                    width,
                    carriage,
                    place,
                }));
            }
            BlockShape::Map => parent = block,
            _ => return Err(not_map(Some(place))),
        }
    }
    // 道すじが空のとき (呼び出し側は渡さない)
    Err(not_map(None))
}

/// 道すじの一覧の末尾に項目を 1 つ足す書き換え。足す先を確かめ、足りないキーと書き直す行を決めたもの
pub(super) struct ListAppend {
    // 書き直す行 (原文の行の添字と、書き直したあとの字。行末の \r を含む)
    rewrites: Vec<(usize, String)>,
    // この行の前に足す
    at: usize,
    // 項目の前に足す行 (足りないキーと、一覧に書き直した式 1 つの値。行末の \r を含む)
    lines: Vec<String>,
    // 項目の行頭 (字下げと「- 」)
    lead: String,
    carriage: &'static str,
}

impl ListAppend {
    /// 道すじ (markdag.relations.depends など。frontmatter に markdag キーがある原文) の一覧の末尾に足す用意。
    /// たどった値が写像か値の字のない null なら続け、`~` などの null は値の範囲を消して続ける。ないキーは写像の末尾に足す。
    /// 最後の値が式 1 つのスカラなら、キーの行と「- もとの式」の 2 行の一覧に書き直す。
    /// フロー形式なら flow-style、写像のいる所が写像でないか一覧のいる所が一覧でなければ frontmatter-not-map、
    /// 最後の値が複数行のスカラなら block-scalar で断る (flow-style と | や > の block-scalar は、書き直しの側が原文を書き直して操作をやり直す)
    pub(super) fn prepare(text: &str, path: &[&str]) -> Result<ListAppend, EditReason> {
        let found = match reach(text, path)? {
            Reached::Absent(insertion) => {
                return Ok(ListAppend {
                    rewrites: insertion.rewrites,
                    at: insertion.at,
                    lines: insertion.lines,
                    lead: format!("{}- ", " ".repeat(insertion.indent)),
                    carriage: insertion.carriage,
                });
            }
            Reached::Present(found) => found,
        };
        let block = &found.block;
        let carriage = found.carriage;
        match block.shape {
            BlockShape::Seq => Ok(ListAppend {
                rewrites: Vec::new(),
                at: block.last_line as usize + 1,
                lines: Vec::new(),
                lead: format!("{}- ", " ".repeat(block.child_indent.unwrap_or(0) as usize)),
                carriage,
            }),
            BlockShape::Scalar => {
                let key_line = found.key_line;
                let line = text.split('\n').nth(key_line).unwrap_or("");
                let Some((head, value)) = split_key_line(line, found.key_column) else {
                    return Err(block_scalar(Some(found.place)));
                };
                // 複数行のスカラ (| と > と、行をまたぐ値) は一覧に書き直せない
                if value.is_empty()
                    || value.starts_with(['|', '>'])
                    || block.first_line as usize != key_line
                    || block.last_line as usize != key_line
                {
                    return Err(block_scalar(Some(found.place)));
                }
                let (_, line_carriage) = split_carriage(line);
                let lead = format!("{}- ", " ".repeat(found.key_column + found.width));
                Ok(ListAppend {
                    rewrites: vec![(key_line, format!("{head}{line_carriage}"))],
                    at: key_line + 1,
                    lines: vec![format!("{lead}{value}{carriage}")],
                    lead,
                    carriage,
                })
            }
            _ => Err(not_map(Some(found.place))),
        }
    }

    /// 値を項目として行の列に書く。行の列は prepare に渡した原文の行の並びのままであること (書き直した行はあってよい)
    pub(super) fn apply(self, plan: &mut LinePlan<'_>, value: &str) {
        for (index, line) in self.rewrites {
            plan.rewrite(index, line);
        }
        let mut lines = self.lines;
        lines.push(format!(
            "{}{}{}",
            self.lead,
            yaml_value(value),
            self.carriage
        ));
        plan.insert(self.at, lines);
    }
}

/// 道すじの写像の末尾に組を足す書き換え。足す先を確かめ、足りないキー (写像) と書き直す行を決めたもの
pub(super) struct MapAppend(Insertion);

impl MapAppend {
    /// 道すじ (markdag.groups など。frontmatter に markdag キーがある原文) の写像の末尾に足す用意。
    /// たどった値が写像か値の字のない null なら続け、`~` などの null は値の範囲を消して続ける。ないキーは写像の末尾に作る。
    /// フロー形式なら flow-style、写像のいる所が写像でなければ frontmatter-not-map で断る
    pub(super) fn prepare(text: &str, path: &[&str]) -> Result<MapAppend, EditReason> {
        match reach(text, path)? {
            Reached::Absent(insertion) => Ok(MapAppend(insertion)),
            Reached::Present(found) if found.block.shape == BlockShape::Map => {
                Ok(MapAppend(Insertion {
                    rewrites: Vec::new(),
                    at: found.block.last_line as usize + 1,
                    lines: Vec::new(),
                    indent: found.block.child_indent.unwrap_or(0) as usize,
                    width: found.width,
                    carriage: found.carriage,
                }))
            }
            Reached::Present(found) => Err(not_map(Some(found.place))),
        }
    }

    /// 組の行 (段と、字下げと行末を除いた字) を写像の末尾に書く。段 0 は写像の組、段 1 はその下の組 (幅 1 つ下げる)。
    /// 行の列は prepare に渡した原文の行の並びのままであること (書き直した行はあってよい)
    pub(super) fn apply(self, plan: &mut LinePlan<'_>, entries: &[(usize, String)]) {
        let MapAppend(insertion) = self;
        for (index, line) in insertion.rewrites {
            plan.rewrite(index, line);
        }
        let mut lines = insertion.lines;
        lines.extend(entries.iter().map(|(level, entry)| {
            format!(
                "{}{entry}{}",
                " ".repeat(insertion.indent + level * insertion.width),
                insertion.carriage
            )
        }));
        plan.insert(insertion.at, lines);
    }
}

/// 道すじ (写像の中のキーまで) の値を written (YAML に書く字。引用符を含む) にする。キーがあれば、値が 1 行のスカラなら
/// 値の範囲だけを書き直し (行末のコメントを残す)、それ以外 (複数行の値、値のない組、写像や一覧の値) は組の行を
/// `<キー>: <値>` の 1 行にする。キーがなければ写像の末尾に足す (写像がなければ作る)。
/// YAML として読めなければ frontmatter-invalid、道すじの手前がフロー形式なら flow-style で断る。plan は text の行のままの列であること
pub(super) fn set_value(
    text: &str,
    plan: &mut LinePlan<'_>,
    path: &[&str],
    written: &str,
) -> Result<(), EditReason> {
    let steps: Vec<PathStep> = path.iter().map(|name| key(name)).collect();
    let locator = editable(text, &steps)?;
    let Some((name, parent)) = path.split_last() else {
        return Err(not_map(None));
    };
    let Some(block) = locator.block(&steps) else {
        MapAppend::prepare(text, parent)?
            .apply(plan, &[(0, format!("{}: {written}", yaml_value(name)))]);
        return Ok(());
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let place = Some(dotted_steps(&steps));
    let key_line = block.key_line.ok_or_else(|| not_map(place.clone()))? as usize;
    let line = *lines.get(key_line).ok_or_else(|| not_map(place.clone()))?;
    if block.shape == BlockShape::Scalar
        && block.first_line as usize == key_line
        && block.last_line as usize == key_line
        && let Some(position) = locator.value(&steps, None)
        && position.line as usize == key_line + 1
        && let Some(rewritten) = with_value(line, &position, written)
    {
        plan.rewrite(key_line, rewritten);
        return Ok(());
    }
    let key_column = locator
        .key(&steps)
        .map_or(0, |position| position.column.saturating_sub(1) as usize);
    let (head, _) = split_key_line(line, key_column).ok_or_else(|| not_map(place.clone()))?;
    let (_, line_carriage) = split_carriage(line);
    let last = (block.last_line as usize).max(key_line);
    plan.remove(key_line, last + 1 - key_line);
    plan.insert(key_line, vec![format!("{head} {written}{line_carriage}")]);
    Ok(())
}

/// 一覧の項目 (道すじの最後が添字) を消す行の範囲。消して空になる一覧のキーと、空になる写像のキーも上へ順に範囲に入れる。
/// 道すじの最初の keep 段のキー (markdag など) は消さない。項目の範囲の中のコメントは一緒に消え、外のコメントは残る。
/// 項目がなければ None
pub(super) fn removed_lines(
    locator: &FrontmatterLocator,
    path: &[PathStep],
    keep: usize,
) -> Option<RangeInclusive<u32>> {
    let item = locator.block(path)?;
    let (mut first, mut last) = (item.first_line, item.last_line);
    // 項目を入れている入れ物の道すじの長さ
    let mut depth = path.len().checked_sub(1)?;
    while depth > keep {
        let container = locator.block(&path[..depth])?;
        let (Some(key_line), true) = (container.key_line, container.items.len() <= 1) else {
            break;
        };
        first = key_line;
        last = last.max(container.last_line);
        depth -= 1;
    }
    Some(first..=last)
}

/// 一覧の項目 (道すじの最後が添字) か、relations の式 1 つのスカラ (道すじの最後がキー) の値を values に書き直す。
/// 項目を 1 行の値 1 つに書き直すときは値の範囲だけを書き直し (行末のコメントを残す)、そうでなければ項目の行を
/// 「- 値」の行の並びにする。式 1 つのスカラは、キーの行と「- 値」の行の一覧にし、キーの行の後ろのコメントは最初の項目の行へ移す
/// (複数行のスカラは block-scalar で断る。| や > の値は書き直しの側が一覧に書き直して操作をやり直す)。
/// plan は text の行のままの列であること
pub(super) fn rewrite_value(
    text: &str,
    plan: &mut LinePlan<'_>,
    path: &[PathStep],
    values: &[String],
) -> Result<(), EditReason> {
    let locator = editable(text, path)?;
    let lines: Vec<&str> = text.split('\n').collect();
    let carriage = carriage_of(text);
    let place = Some(dotted_steps(path));
    let block = match locator.block(path) {
        Some(block) if block.shape == BlockShape::Scalar => block,
        _ => return Err(not_map(place)),
    };
    match path.split_last() {
        Some((PathStep::Index(_), list)) => {
            let (first, last) = (block.first_line as usize, block.last_line as usize);
            if let [value] = values
                && first == last
                && let Some(position) = locator.value(path, None)
                && position.line as usize == first + 1
                && let Some(line) = lines.get(first)
                && let Some(written) = with_value(line, &position, &yaml_value(value))
            {
                plan.rewrite(first, written);
                return Ok(());
            }
            let indent = locator
                .block(list)
                .and_then(|list| list.child_indent)
                .unwrap_or(0) as usize;
            plan.remove(first, last + 1 - first);
            plan.insert(first, item_lines(indent, values, carriage));
            Ok(())
        }
        Some((PathStep::Key(_), _)) => {
            let (key_line, head, line_carriage) = scalar_key_line(&locator, &lines, path, &block)
                .ok_or_else(|| block_scalar(place.clone()))?;
            let key_column = locator
                .key(path)
                .map_or(0, |position| position.column.saturating_sub(1) as usize);
            let width = locator
                .fence_lines()
                .map_or(DEFAULT_WIDTH, |fences| indent_width(&lines, fences));
            // キーの行の値のあとのコメントは、項目を足すときと同じく、もとの空白ごと最初の項目の行の末尾に移す
            let comment = locator
                .value(path, None)
                .filter(|position| position.line as usize == key_line + 1)
                .map(|position| {
                    trailing_comment(lines.get(key_line).copied().unwrap_or(""), &position)
                })
                .unwrap_or_default();
            let mut items = item_lines(key_column + width, values, carriage);
            if !comment.is_empty()
                && let Some(first) = items.first_mut()
            {
                let (content, end) = split_carriage(first);
                let line = format!("{content}{comment}{end}");
                *first = line;
            }
            plan.rewrite(key_line, format!("{head}{line_carriage}"));
            plan.insert(key_line + 1, items);
            Ok(())
        }
        None => Err(not_map(None)),
    }
}

/// 一覧の項目か、relations の式 1 つのスカラの組を消す。消して空になる一覧と写像のキーは、道すじの最初の keep 段を残して上へ順に消す。
/// 道すじの長さが keep 以下の式 1 つのスカラはキーを残し、値の字だけを消して値のないキーにする (あとで項目を足す)。
/// plan は text の行のままの列であること
pub(super) fn remove_value(
    text: &str,
    plan: &mut LinePlan<'_>,
    path: &[PathStep],
    keep: usize,
) -> Result<(), EditReason> {
    let locator = editable(text, path)?;
    let lines: Vec<&str> = text.split('\n').collect();
    let place = Some(dotted_steps(path));
    let Some(block) = locator.block(path) else {
        return Err(not_map(place));
    };
    let single = matches!(path.last(), Some(PathStep::Key(_)));
    if single && path.len() <= keep {
        let (key_line, head, line_carriage) = scalar_key_line(&locator, &lines, path, &block)
            .ok_or_else(|| block_scalar(place.clone()))?;
        plan.rewrite(key_line, format!("{head}{line_carriage}"));
        return Ok(());
    }
    let Some(range) = removed_lines(&locator, path, keep) else {
        return Err(not_map(place));
    };
    // 式 1 つのスカラはキーの行から消す (値がキーの次の行から始まることがある)
    let first = match (single, block.key_line) {
        (true, Some(key_line)) => (*range.start()).min(key_line),
        _ => *range.start(),
    } as usize;
    plan.remove(first, *range.end() as usize + 1 - first);
    Ok(())
}

// 書き換える道すじの frontmatter が YAML として読め、道すじの手前にフロー形式の写像か一覧がないこと。読めればその位置の木
fn editable(text: &str, path: &[PathStep]) -> Result<FrontmatterLocator, EditReason> {
    let locator = FrontmatterLocator::new(Some(text));
    if !locator.syntax_errors().is_empty() {
        return Err(refusal(
            EditReasonCode::FrontmatterInvalid,
            "frontmatter を YAML として読めないので、書き直せません。YAML の誤りを直してください",
            None,
        ));
    }
    if locator.block(&[]).is_some_and(|whole| whole.flow) {
        return Err(flow_style(None));
    }
    for depth in 1..=path.len() {
        if locator
            .block(&path[..depth])
            .is_some_and(|block| block.flow)
        {
            return Err(flow_style(Some(dotted_steps(&path[..depth]))));
        }
    }
    Ok(locator)
}

// 式 1 つのスカラのキーの行と、その行のキーと `:` まで、行末の \r。値が 1 行でなければ None
fn scalar_key_line(
    locator: &FrontmatterLocator,
    lines: &[&str],
    path: &[PathStep],
    block: &FrontmatterBlock,
) -> Option<(usize, String, String)> {
    let key_line = block.key_line? as usize;
    let key_column = locator
        .key(path)
        .map_or(0, |position| position.column.saturating_sub(1) as usize);
    let line = *lines.get(key_line)?;
    let (head, value) = split_key_line(line, key_column)?;
    let one_line = !value.is_empty()
        && !value.starts_with(['|', '>'])
        && block.first_line as usize == key_line
        && block.last_line as usize == key_line;
    one_line.then(|| (key_line, head, split_carriage(line).1.to_string()))
}

// 一覧の項目の行 (字下げと「- 」と値。行末の \r を含む)
fn item_lines(indent: usize, values: &[String], carriage: &str) -> Vec<String> {
    values
        .iter()
        .map(|value| format!("{}- {}{carriage}", " ".repeat(indent), yaml_value(value)))
        .collect()
}

// 1 行の値の範囲 (SourcePosition) のあとにある行末のコメント (前の空白を含み、後ろの空白は除く)。なければ空
fn trailing_comment(line: &str, position: &crate::types::SourcePosition) -> String {
    let end = (position.column.saturating_sub(1) as usize).saturating_add(position.length as usize);
    let after: String = split_carriage(line).0.chars().skip(end).collect();
    if after.trim_start().starts_with('#') {
        after.trim_end().to_string()
    } else {
        String::new()
    }
}

// 1 行の値の範囲 (SourcePosition。行と桁は 1 始まり、桁と長さはコードポイント) を written に置き換えた行。
// 範囲が行に収まらないか、値が複数行のスカラの記号 (| か >) で始まれば None
fn with_value(
    line: &str,
    position: &crate::types::SourcePosition,
    written: &str,
) -> Option<String> {
    let (content, carriage) = split_carriage(line);
    let chars: Vec<char> = content.chars().collect();
    let start = position.column.checked_sub(1)? as usize;
    let end = start.checked_add(position.length as usize)?;
    if end > chars.len() || chars.get(start).is_none_or(|c| matches!(c, '|' | '>')) {
        return None;
    }
    let before: String = chars[..start].iter().collect();
    let after: String = chars[end..].iter().collect();
    Some(format!("{before}{written}{after}{carriage}"))
}

/// frontmatter に書く値の書き方: そのまま書いて同じ文字列として読める値は引用符なしで、読めない値は "…" で囲む
/// (中に " か \ があれば '…' で囲み、' は '' にする)
pub(super) fn yaml_value(text: &str) -> String {
    if reads_as_plain(text) {
        text.to_string()
    } else if text.contains(['"', '\\']) {
        format!("'{}'", text.replace('\'', "''"))
    } else {
        format!("\"{text}\"")
    }
}

fn reads_as_plain(text: &str) -> bool {
    let Some(first) = text.chars().next() else {
        return false;
    };
    let lower = text.to_lowercase();
    !(INDICATORS.contains(first)
        || text.starts_with([' ', '\t'])
        || text.ends_with([' ', '\t', ':'])
        || text.contains(": ")
        || text.contains(" #")
        || text.contains(['\n', '\r', '\t'])
        || RESERVED_WORDS.contains(&lower.as_str()))
        && yaml_core_scalar(text, false) == JsValue::String(text.to_string())
}

// 新しく作る階層の字下げの幅: frontmatter の行 (空行とコメントの行を除く) の字下げのうち最小の正の値。なければ 4
pub(super) fn indent_width(lines: &[&str], (open, close): (u32, u32)) -> usize {
    lines
        .iter()
        .take(close as usize)
        .skip(open as usize + 1)
        .filter_map(|line| {
            let content = split_carriage(line).0;
            let rest = content.trim_start_matches(' ');
            let indent = content.len() - rest.len();
            (!rest.trim().is_empty() && !rest.starts_with('#') && indent > 0).then_some(indent)
        })
        .min()
        .unwrap_or(DEFAULT_WIDTH)
}

// キーの行を、キーと `:` まで (行頭の字下げを含む) と、そのあとの値の字 (前後の空白を除く。行末のコメントを含む) に分ける。
// key_column はキーの字の始まりの桁 (字数)
pub(super) fn split_key_line(line: &str, key_column: usize) -> Option<(String, String)> {
    let content = split_carriage(line).0;
    let start = content
        .char_indices()
        .nth(key_column)
        .map_or(content.len(), |(at, _)| at);
    let colon = start + find_key_colon(&content[start..])?;
    let head = content[..=colon].to_string();
    let value = content[colon + 1..].trim().to_string();
    Some((head, value))
}

// キーの字から見て、キーを終える `:` (後ろが空白か行末) の位置。引用符で囲んだキーの中の `:` は飛ばす
fn find_key_colon(text: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match (quote, c) {
            (Some('"'), '\\') => {
                chars.next();
            }
            (Some(open), _) if c == open => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') if at == 0 => quote = Some(c),
            (None, ':')
                if chars
                    .peek()
                    .is_none_or(|(_, next)| matches!(next, ' ' | '\t')) =>
            {
                return Some(at);
            }
            (None, _) => {}
        }
    }
    None
}

// キーの行から値の範囲 (1 行の SourcePosition) の字を消した行。値のあとに空白しか残らなければ、`:` のあとの空白も外す
fn without_value(line: &str, value: Option<&crate::types::SourcePosition>) -> String {
    let (content, carriage) = split_carriage(line);
    let Some(value) = value else {
        return line.to_string();
    };
    let chars: Vec<char> = content.chars().collect();
    let start = (value.column.saturating_sub(1) as usize).min(chars.len());
    let end = (start + value.length as usize).min(chars.len());
    let before: String = chars[..start].iter().collect();
    let after: String = chars[end..].iter().collect();
    let joined = if after.trim().is_empty() {
        before.trim_end_matches([' ', '\t']).to_string()
    } else {
        format!("{before}{after}")
    };
    format!("{joined}{carriage}")
}

fn key(name: &str) -> PathStep {
    PathStep::Key(name.to_string())
}

// 道すじの最初から depth 段までを . でつないだもの (markdag.relations.depends)
fn dotted(path: &[&str], depth: usize) -> String {
    path[..=depth].join(".")
}

// 道すじのキーを . でつないだもの (一覧の添字は入れない。markdag.relations.depends)
fn dotted_steps(path: &[PathStep]) -> String {
    path.iter()
        .filter_map(|step| match step {
            PathStep::Key(name) => Some(name.as_str()),
            PathStep::Index(_) => None,
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn refusal(code: EditReasonCode, message: &str, path: Option<String>) -> EditReason {
    EditReason {
        code,
        message: message.to_string(),
        path,
    }
}

fn flow_style(path: Option<String>) -> EditReason {
    let message = match &path {
        Some(path) => format!(
            "{path} がフロー形式 ({{ }} か [ ]) で書かれているので、書き足せません。ブロック形式 (キーと - で 1 行ずつ) に書き直してください"
        ),
        None => "frontmatter の全体がフロー形式 ({ }) で書かれているので、書き足せません。ブロック形式 (キーごとに 1 行) に書き直してください".to_string(),
    };
    EditReason {
        code: EditReasonCode::FlowStyle,
        message,
        path,
    }
}

fn not_map(path: Option<String>) -> EditReason {
    let message = match &path {
        Some(path) => {
            format!("{path} が書き足せる形 (キーと値の組か、- の一覧) でないので、書き足せません")
        }
        None => "frontmatter の最上位がキーと値の組でないので、書き足せません".to_string(),
    };
    EditReason {
        code: EditReasonCode::FrontmatterNotMap,
        message,
        path,
    }
}

fn block_scalar(path: Option<String>) -> EditReason {
    let message = format!(
        "{} の値が複数の行にまたがる文字で書かれているので、一覧に書き足せません。- で 1 行ずつの一覧に書き直してください",
        path.as_deref().unwrap_or("値")
    );
    EditReason {
        code: EditReasonCode::BlockScalar,
        message,
        path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(frontmatter: &str) -> FrontmatterLocator {
        FrontmatterLocator::new(Some(&format!("---\n{frontmatter}---\n# R\n")))
    }

    fn depends(index: usize) -> Vec<PathStep> {
        vec![
            key("markdag"),
            key("relations"),
            key("depends"),
            PathStep::Index(index),
        ]
    }

    #[test]
    fn edit_frontmatter_value_is_quoted_only_when_plain_text_reads_differently() {
        // 引用符なしの値の中の \ と ' は字のまま読まれる
        for plain in [
            "a --> b",
            "$n1 --> y",
            "A/x --> B/x",
            "a:b",
            "画面",
            "入\\/出力 --> it's",
        ] {
            assert_eq!(yaml_value(plain), plain);
        }
        for (text, written) in [
            ("#1 案 --> b", "\"#1 案 --> b\""),
            ("注意: 重要 --> b", "\"注意: 重要 --> b\""),
            ("b --> #x", "\"b --> #x\""),
            ("true", "\"true\""),
            ("12", "\"12\""),
            ("x:", "\"x:\""),
            ("", "\"\""),
            ("\"A --> B\" --> b", "'\"A --> B\" --> b'"),
            ("\\(仮) --> it's: x", "'\\(仮) --> it''s: x'"),
        ] {
            assert_eq!(yaml_value(text), written, "{text:?}");
        }
    }

    #[test]
    fn edit_frontmatter_removed_lines_climb_to_emptied_keys() {
        // 項目が残る一覧は項目の行だけ
        let fm = "markdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n";
        assert_eq!(removed_lines(&locator(fm), &depends(1), 1), Some(5..=5));
        // 空になる一覧はキーごと。ほかの kind が残る relations は残す
        let fm = "markdag:\n    relations:\n        chain:\n            - a --> b\n        depends:\n            - b --> c\n";
        assert_eq!(removed_lines(&locator(fm), &depends(0), 1), Some(5..=6));
        // 空になる relations も消し、markdag キーは消さない (コメントは範囲の外に残る)
        let fm = "markdag:\n    relations:\n        depends:\n            - a --> b\n    # c\n";
        assert_eq!(removed_lines(&locator(fm), &depends(0), 1), Some(2..=4));
        let fm = "markdag:\n    edgeHighlight: true\n    relations:\n        depends:\n            - a --> b\n";
        assert_eq!(removed_lines(&locator(fm), &depends(0), 1), Some(3..=5));
        // ない項目は None
        assert_eq!(removed_lines(&locator(fm), &depends(3), 1), None);
    }
}

#[cfg(test)]
mod append_tests {
    use super::*;

    const DEPENDS: [&str; 3] = ["markdag", "relations", "depends"];
    const GROUPS: [&str; 2] = ["markdag", "groups"];

    fn list_appended(text: &str, path: &[&str], value: &str) -> Result<String, EditReason> {
        let lines: Vec<&str> = text.split('\n').collect();
        let append = ListAppend::prepare(text, path)?;
        let mut plan = LinePlan::new(&lines);
        append.apply(&mut plan, value);
        Ok(plan.text())
    }

    fn map_appended(
        text: &str,
        path: &[&str],
        entries: &[(usize, &str)],
    ) -> Result<String, EditReason> {
        let lines: Vec<&str> = text.split('\n').collect();
        let append = MapAppend::prepare(text, path)?;
        let mut plan = LinePlan::new(&lines);
        let entries: Vec<(usize, String)> = entries
            .iter()
            .map(|(level, entry)| (*level, entry.to_string()))
            .collect();
        append.apply(&mut plan, &entries);
        Ok(plan.text())
    }

    fn without_trailing_spaces(text: &str) -> String {
        text.split('\n')
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn edit_frontmatter_list_append_after_a_bare_key_keeps_the_comment_and_blank_lines_after_it() {
        // 値のないキーは、キーの行のすぐあとに足りないキーと項目を足す。あとのコメントと空行は足した行のあとに残る
        let text = "---\nmarkdag:\n    relations:\n    # メモ\n\n---\n# R\n";
        assert_eq!(
            list_appended(text, &DEPENDS, "a --> b").expect("足せる"),
            "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n    # メモ\n\n---\n# R\n"
        );
    }

    #[test]
    fn edit_frontmatter_list_append_uses_the_indent_of_the_existing_items() {
        // 項目がキーと同じ字下げの一覧
        let text = "---\nmarkdag:\n  relations:\n    depends:\n    - a --> b\n---\n";
        assert_eq!(
            list_appended(text, &DEPENDS, "c --> d").expect("足せる"),
            "---\nmarkdag:\n  relations:\n    depends:\n    - a --> b\n    - c --> d\n---\n"
        );
        // 深く字下げした一覧
        let text = "---\nmarkdag:\n  relations:\n    depends:\n          - a --> b\n---\n";
        assert_eq!(
            list_appended(text, &DEPENDS, "c --> d").expect("足せる"),
            "---\nmarkdag:\n  relations:\n    depends:\n          - a --> b\n          - c --> d\n---\n"
        );
    }

    #[test]
    fn edit_frontmatter_list_append_refuses_blocks_it_cannot_write_into() {
        let text = "---\nmarkdag:\n    relations:\n        depends: |\n            a --> b\n---\n";
        let reason = list_appended(text, &DEPENDS, "c --> d").expect_err("複数行のスカラ");
        assert_eq!(reason.code, EditReasonCode::BlockScalar);
        assert_eq!(reason.path.as_deref(), Some("markdag.relations.depends"));
        let text = "---\nmarkdag:\n    relations: {}\n---\n";
        let reason = list_appended(text, &DEPENDS, "c --> d").expect_err("フロー形式");
        assert_eq!(reason.code, EditReasonCode::FlowStyle);
        assert_eq!(reason.path.as_deref(), Some("markdag.relations"));
        let text = "---\nmarkdag:\n    relations:\n        - a --> b\n---\n";
        let reason = list_appended(text, &DEPENDS, "c --> d").expect_err("写像でない");
        assert_eq!(reason.code, EditReasonCode::FrontmatterNotMap);
    }

    #[test]
    fn edit_frontmatter_map_append_uses_the_child_indent_and_the_frontmatter_width() {
        // 既存の子の字下げ (6) で組を足し、新しく作る階層はそのキーの字下げ + 幅 (frontmatter の字下げの最小 4)
        let text = "---\nmarkdag:\n    groups:\n      g:\n        label: G\n---\n";
        assert_eq!(
            map_appended(text, &GROUPS, &[(0, "h:"), (1, "label: H")]).expect("足せる"),
            "---\nmarkdag:\n    groups:\n      g:\n        label: G\n      h:\n          label: H\n---\n"
        );
    }

    #[test]
    fn edit_frontmatter_map_append_creates_missing_keys_and_fills_null_values() {
        // ないキーは写像の末尾に作る
        let text = "---\nmarkdag:\n    legend:\n        display: false\n---\n";
        assert_eq!(
            map_appended(text, &GROUPS, &[(0, "g:"), (1, "label: G")]).expect("足せる"),
            "---\nmarkdag:\n    legend:\n        display: false\n    groups:\n        g:\n            label: G\n---\n"
        );
        // 値の字がある null は値の範囲を消して、値のないキーと同じに足す (行末の空白は比べない)
        let text = "---\nmarkdag:\n    groups: ~\n---\n";
        assert_eq!(
            without_trailing_spaces(
                &map_appended(text, &GROUPS, &[(0, "g:"), (1, "label: G")]).expect("足せる")
            ),
            "---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n"
        );
        // 写像のいる所が一覧なら断る
        let text = "---\nmarkdag:\n    groups:\n        - g\n---\n";
        let reason = map_appended(text, &GROUPS, &[(0, "h:")]).expect_err("写像でない");
        assert_eq!(reason.code, EditReasonCode::FrontmatterNotMap);
    }
}
