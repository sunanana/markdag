// 原文なし。
// 原文の書き換え (GUI 編集の操作) と、読むだけの問い合わせ (inspect_node)。原文と操作を受けて、書き換えた行 (行の差し替えの列) と
// 書き換えたあとに選ぶものを返すか、変えない理由か断る理由を返す。原文の全体は返さず、包みが原文の行に継ぎ足す
// (書き換えない行の字を原文のまま保つ)。書き換えたあとの原文を解析し直し、ねらいと違う形に読まれる書き換えは断る。
// 本文の書き換えと、frontmatter の書き換え (位置の木で行を探して足す、消す、書き直す) と、両方にまたがるグループの書き換え
// (本文の %印と markdag.groups の定義)、詳細とタグの書き換え (markdag キーのない文書には markdag: を足す) を受け持つ。本文を書き換えたときは、
// frontmatter の参照を追って書き直す (名前の変更と削除の追随、読み方が変わって指せなくなった参照の守り)。
// 原文の書き方の都合では断らず、書き直して通す: 単独の \r は文書の改行にそろえてから操作を当て、frontmatter の書き方
// (フロー形式、| や > の値) で操作が断ったときは、その所を書き直した原文で操作をやり直す。書き直しは操作の書き換えと 1 つの差し替えの列にまとめ、
// 操作が書き換えないとき (変えない、断る) は書き直しも返さない。
// 操作の失敗は戻り値の status で返し、誤り (境界の封筒の error) にはしない。DOM も JS も知らない。
mod blocks;
mod body;
mod details;
mod frontmatter;
mod groups;
mod headings;
mod lines;
mod names;
mod refs;
mod relations;
mod restyle;
mod shape;
mod tags;
mod verify;

use crate::types::{
    EditOp, EditReason, EditReasonCode, EditSourceResult, InspectNodeResult, LineSplice, NodeTarget,
};

/// 原文に操作を当てる。書き換えたら行の差し替えの列と選び直すもの、そうでなければ変えない理由か断る理由
pub fn edit_source(source: &str, op: &EditOp) -> EditSourceResult {
    let Some((aligned, text)) = lines::aligned_line_endings(source) else {
        return restyling(source, op);
    };
    with_splices_before(source, &aligned, restyling(&text, op))
}

// frontmatter の書き方を書き直す回数の上限 (書き直すたびにフロー形式のブロックか複数行の文字が 1 つ減るので、ふつうは数回で止まる)
const RESTYLE_LIMIT: usize = 16;

// 操作を当て、frontmatter の書き方の都合で断ったら、その所を書き直した原文でやり直す
fn restyling(source: &str, op: &EditOp) -> EditSourceResult {
    let mut text = source.to_string();
    let mut before: Vec<LineSplice> = Vec::new();
    let mut result = apply(&text, op);
    for _ in 0..RESTYLE_LIMIT {
        let EditSourceResult::Refused { reason } = &result else {
            break;
        };
        let Some((splices, restyled)) = restyle::restyled(&text, reason) else {
            break;
        };
        before = lines::composed(source, &before, &splices);
        text = restyled;
        result = apply(&text, op);
    }
    with_splices_before(source, &before, result)
}

// 書き換えた結果の差し替えの列 (before を当てたあとの原文に対するもの) の前に before を重ね、source に当てる列にする
fn with_splices_before(
    source: &str,
    before: &[LineSplice],
    result: EditSourceResult,
) -> EditSourceResult {
    match result {
        EditSourceResult::Edited {
            splices,
            select,
            rename,
            notes,
        } => EditSourceResult::Edited {
            splices: lines::composed(source, before, &splices),
            select,
            rename,
            notes,
        },
        other => other,
    }
}

fn apply(source: &str, op: &EditOp) -> EditSourceResult {
    match op {
        EditOp::AddChild { parent, label } => body::add_child(source, parent, label),
        EditOp::AddSibling { node, label } => body::add_sibling(source, node, label),
        EditOp::RenameNode { node, label } => body::rename_node(source, node, label),
        EditOp::DeleteNodes { nodes } => body::delete_nodes(source, nodes),
        EditOp::MoveNode { node, parent } => body::move_node(source, node, parent),
        EditOp::SetDetails { node, text } => details::set_details(source, node, text),
        EditOp::SetTag {
            nodes,
            key,
            value,
            replace_key,
        } => tags::set_tag(source, nodes, key, value.as_deref(), replace_key.as_deref()),
        EditOp::RemoveTag { nodes, key } => tags::remove_tag(source, nodes, key),
        EditOp::ToggleTag { nodes, key, value } => {
            tags::toggle_tag(source, nodes, key, value.as_deref())
        }
        EditOp::AddRelation { from, to } => relations::add_relation(source, from, to),
        EditOp::JoinInto { sources, target } => relations::join_into(source, sources, target),
        EditOp::JoinIntoNew { sources, label } => relations::join_into_new(source, sources, label),
        EditOp::GroupNodes { nodes } => groups::group_nodes(source, nodes),
        EditOp::AddToGroup { group, nodes } => groups::add_to_group(source, group, nodes),
        EditOp::DefineGroup => groups::define_group(source),
        EditOp::RenameGroup { group, label } => groups::rename_group(source, group, label),
        EditOp::SetGroupColor { group, color } => groups::set_group_color(source, group, color),
        EditOp::SetGroupBoundary { group, boundary } => {
            groups::set_group_boundary(source, group, *boundary)
        }
        EditOp::Ungroup { group } => groups::ungroup(source, group),
    }
}

/// ノードの種類、名前の入力の初めの値、詳細の原文と、そのノードにできる操作。
/// id のノードがないか refText が違えば None (古い id で別のノードのことを返さない)
pub fn inspect_node(source: &str, node: &NodeTarget) -> Option<InspectNodeResult> {
    // 単独の \r のある文書は、書き換えと同じく改行をそろえた原文で読む (ノードは変わらない)
    match lines::aligned_line_endings(source) {
        Some((_, text)) => blocks::inspect(&text, node),
        None => blocks::inspect(source, node),
    }
}

// どの操作でも同じ断る理由の文
const STALE_NODE: &str = "図と原文が合っておらず、そのノードが原文に見つからないので書き換えません (描き直してからやり直してください)";
const STRUCTURE_CHANGED: &str =
    "書き換えると文書の形 (ノードの数、親子、種類) が変わって読まれるので、書き換えません";

fn reason(code: EditReasonCode, message: &str) -> EditReason {
    EditReason {
        code,
        message: message.to_string(),
        path: None,
    }
}

fn refused(code: EditReasonCode, message: &str) -> EditSourceResult {
    EditSourceResult::Refused {
        reason: reason(code, message),
    }
}

fn unchanged(code: EditReasonCode, message: &str) -> EditSourceResult {
    EditSourceResult::Unchanged {
        reason: Some(reason(code, message)),
    }
}
