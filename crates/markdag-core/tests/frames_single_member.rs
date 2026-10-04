// メンバーが 1 つの所の枠 (GUI 編集を足したときに、依頼者が図を触って決めた挙動)。
// 決まり:
// - boundary: true のグループで、見えているメンバーのまとまり (ツリーの線で直接つながるか、同じ配置上の親の下で縦に隣り合う) のうち、
//   メンバーが 1 つのものも枠にする。グループ全体でメンバーが 1 つ (子のない 1 つのノードだけ) でも枠にする。
// - 数えるのは見えているメンバーだけ (閉じた枝の中のメンバーは数えない)。閉じて見えているメンバーが 1 つになった所も枠にし、0 なら枠なし。
// - boundary: false のグループは今のまま枠なし。
// - 1 つのメンバーの枠も 2 つ以上の枠と同じ: 配置の箱として置き、余白 (frame_padding) で囲み、まわりの間 (上の辺の外のラベルの行を含む) を空ける。
//   入れ子の決まり (相手のメンバーを全部含む枠が外側。メンバーが同じなら groups で先に定義されたほうが外側) も同じ。
// 文書は Markdown から公開の parse_document と build_model で組む (審判の harness と同じ疑似の大きさ。配置の流れの単体テストの document と同じ形)。
// 位置の確かめは配置の流れの単体テストの不変条件と同じ読み方 (枠の矩形はラベルの行を上に足したもの、0.5 の許容)
use std::collections::HashSet;

use indexmap::IndexMap;
use markdag_core::layout::frames::{
    Frame, LABEL_HEIGHT, compute_frames, frame_blocks, frame_padding, frame_rect,
};
use markdag_core::layout::layout::layout_children_of;
use markdag_core::layout::pipeline::{
    FrameBoxCounts, LayoutDocumentResult, layout_document_with_counts,
};
use markdag_core::layout::project::project;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::parse::parse_document;
use markdag_core::types::{
    GroupDef, LayoutInput, LayoutInputEdge, LayoutInputNode, Rect, Severity,
};

const TOLERANCE: f64 = 0.5;

struct Document {
    input: LayoutInput,
    groups: Vec<GroupDef>,
    groups_of: IndexMap<u32, Vec<String>>,
    // ノードの id → 1 行目の文字 (refText)
    labels: IndexMap<u32, String>,
}

fn document(source: &str) -> Document {
    let parsed = parse_document(source);
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions::default(),
    );
    let errors: Vec<&str> = model
        .diagnostics
        .iter()
        .filter(|item| item.severity == Severity::Error)
        .map(|item| item.code.as_str())
        .collect();
    assert!(errors.is_empty(), "文書に error がある: {errors:?}");
    let nodes = parsed
        .nodes
        .iter()
        .map(|node| LayoutInputNode {
            id: node.id,
            label: node.ref_text.clone(),
            width: if node.ref_text.is_empty() {
                0.0
            } else {
                node.ref_text.chars().count() as f64 * 8.0 + 16.0
            },
            height: 20.0 + node.html.matches('\n').count() as f64 * 14.0,
            groups: node.groups.clone(),
        })
        .collect();
    let tree_edges = parsed
        .nodes
        .iter()
        .filter_map(|node| {
            node.parent.map(|parent| LayoutInputEdge {
                source: parent,
                target: node.id,
            })
        })
        .collect();
    Document {
        input: LayoutInput {
            name: "single-member".to_string(),
            nodes,
            tree_edges,
            relations: model.relations.clone(),
            suppress_root_line: model.suppress_root_line.clone(),
            folded: Vec::new(),
        },
        groups: model.groups.clone(),
        groups_of: model.groups_of.clone(),
        labels: parsed
            .nodes
            .iter()
            .map(|node| (node.id, node.ref_text.clone()))
            .collect(),
    }
}

impl Document {
    // 1 行目の文字でノードを引く (この試験の文書では同じ文字のノードはない)
    fn id(&self, label: &str) -> u32 {
        let found: Vec<u32> = self
            .labels
            .iter()
            .filter(|(_, text)| text.as_str() == label)
            .map(|(id, _)| *id)
            .collect();
        assert_eq!(found.len(), 1, "「{label}」のノードがちょうど 1 つ");
        found[0]
    }

    fn fold(mut self, labels: &[&str]) -> Self {
        self.input.folded = labels.iter().map(|label| self.id(label)).collect();
        self
    }

    // compute_frames の結果を (グループ, メンバーの文字, level) の並びで (frames の順のまま)
    fn frames(&self) -> Vec<(String, Vec<String>, u32)> {
        let graph = project(&self.input).unwrap();
        let frames = compute_frames(
            &graph,
            &self.groups,
            &self.groups_of,
            &layout_children_of(&graph),
        );
        frames.iter().map(|frame| self.row(frame)).collect()
    }

    fn row(&self, frame: &Frame) -> (String, Vec<String>, u32) {
        (
            frame.group.id.clone(),
            frame
                .members
                .iter()
                .map(|id| self.labels[id].clone())
                .collect(),
            frame.level,
        )
    }

    fn layout(&self) -> (LayoutDocumentResult, FrameBoxCounts) {
        layout_document_with_counts(&self.input, &self.groups, &self.groups_of, None, None).unwrap()
    }
}

fn row(group: &str, members: &[&str], level: u32) -> (String, Vec<String>, u32) {
    (
        group.to_string(),
        members.iter().map(|text| text.to_string()).collect(),
        level,
    )
}

// 確認ページの見本「枝をまたぐグループ」と同じ groups と本文 (editor の指定は配置に関わらないので省く)。
// sec のメンバーは、フロントエンドの子 2 つ、バックエンドの子 2 つ、運用の子の鍵のローテーション 1 つ (監視の設定の下で、隣にメンバーがない)
const CROSS: &str = concat!(
    "---\n",
    "title: 枝をまたぐグループ\n",
    "markdag:\n",
    "    groups:\n",
    "        sec:\n",
    "            label: セキュリティレビュー\n",
    "            color: \"#D64545\"\n",
    "            boundary: true\n",
    "---\n",
    "\n",
    "# 決済機能\n",
    "\n",
    "## フロントエンド\n",
    "- カード入力フォーム %sec\n",
    "- 3Dセキュア画面 %sec\n",
    "- 購入完了画面\n",
    "\n",
    "## バックエンド\n",
    "- 決済API %sec\n",
    "- トークン管理 %sec\n",
    "- 領収書メール\n",
    "\n",
    "## 運用\n",
    "- 監視の設定\n",
    "- 鍵のローテーション %sec\n",
);

// グループ全体でメンバーが 1 つ: a は子のない見出し 1 つ、b は子のない項目 1 つ
const WHOLE_SINGLE: &str = concat!(
    "---\n",
    "markdag:\n",
    "    groups:\n",
    "        a:\n",
    "            label: 設計チーム\n",
    "            boundary: true\n",
    "        b:\n",
    "            label: 公開\n",
    "            boundary: true\n",
    "---\n",
    "\n",
    "# ルート\n",
    "\n",
    "## 設計 %a\n",
    "\n",
    "## 実装\n",
    "- フロント\n",
    "- バック %b\n",
    "\n",
    "## 告知\n",
);

// boundary: false のグループ: lone はメンバー 1 つ、pair は隣り合うメンバー 2 つ。shown は boundary: true でメンバー 1 つ (比べる相手)
const BOUNDARY_FALSE: &str = concat!(
    "---\n",
    "markdag:\n",
    "    groups:\n",
    "        lone:\n",
    "            label: 一人\n",
    "            boundary: false\n",
    "        pair:\n",
    "            label: 二人\n",
    "            boundary: false\n",
    "        shown:\n",
    "            label: 見える\n",
    "            boundary: true\n",
    "---\n",
    "\n",
    "# ルート\n",
    "\n",
    "## 設計\n",
    "- 画面 %pair\n",
    "- API %pair\n",
    "\n",
    "## 実装\n",
    "- フロント %lone\n",
    "- バック\n",
    "\n",
    "## 告知 %shown\n",
);

// 閉じる文書: a は設計とその子 2 つ、b は設計の子の API だけ (閉じた枝の中)、c は実装の子の テスト だけ
const FOLDING: &str = concat!(
    "---\n",
    "markdag:\n",
    "    groups:\n",
    "        a:\n",
    "            label: 設計チーム\n",
    "            boundary: true\n",
    "        b:\n",
    "            label: API担当\n",
    "            boundary: true\n",
    "        c:\n",
    "            label: 試験\n",
    "            boundary: true\n",
    "---\n",
    "\n",
    "# ルート\n",
    "\n",
    "## 設計 %a\n",
    "- 画面 %a\n",
    "- API %a %b\n",
    "\n",
    "## 実装\n",
    "- テスト %c\n",
    "\n",
    "## 告知\n",
);

// 入れ子: ops は運用と子 2 つ、sec は運用の子の鍵 1 つ (ops の枠の内側の 1 つのメンバーの枠)。
// 同じノードの 2 つのグループ: x と y はどちらも告知 1 つ (groups で先の x が外側)
const NESTED: &str = concat!(
    "---\n",
    "markdag:\n",
    "    groups:\n",
    "        ops:\n",
    "            label: 運用チーム\n",
    "            boundary: true\n",
    "        sec:\n",
    "            label: セキュリティ\n",
    "            boundary: true\n",
    "        x:\n",
    "            label: 広報\n",
    "            boundary: true\n",
    "        y:\n",
    "            label: 法務\n",
    "            boundary: true\n",
    "---\n",
    "\n",
    "# ルート\n",
    "\n",
    "## 運用 %ops\n",
    "- 監視 %ops\n",
    "- 鍵 %ops %sec\n",
    "\n",
    "## 告知 %x %y\n",
    "\n",
    "## 実装\n",
);

// ---- compute_frames (枠のまとまり) ----

#[test]
fn single_member_frames_frame_the_lone_member_apart_from_the_others() {
    // 離れたメンバー 1 つのまとまり (鍵のローテーション) も枠になる。2 つ以上のまとまりは今のまま。どれも入れ子でないので level 0
    let doc = document(CROSS);
    assert_eq!(
        doc.frames(),
        vec![
            row("sec", &["カード入力フォーム", "3Dセキュア画面"], 0),
            row("sec", &["決済API", "トークン管理"], 0),
            row("sec", &["鍵のローテーション"], 0),
        ]
    );
}

#[test]
fn single_member_frames_frame_a_group_with_only_one_member() {
    // グループ全体でメンバーが 1 つ (子のない見出し、子のない項目) でも枠になる
    let doc = document(WHOLE_SINGLE);
    assert_eq!(
        doc.frames(),
        vec![row("a", &["設計"], 0), row("b", &["バック"], 0)]
    );
}

#[test]
fn single_member_frames_skip_boundary_false_groups() {
    // boundary: false のグループは、メンバーが 1 つでも 2 つでも枠にしない (今のまま)。boundary: true の 1 つは枠になる
    let doc = document(BOUNDARY_FALSE);
    assert_eq!(doc.frames(), vec![row("shown", &["告知"], 0)]);
}

#[test]
fn single_member_frames_count_only_visible_members() {
    // 開いているとき: a は 3 つ (b の枠を含むので level 1)、b は API 1 つ、c は テスト 1 つ
    let doc = document(FOLDING);
    assert_eq!(
        doc.frames(),
        vec![
            row("a", &["設計", "画面", "API"], 1),
            row("b", &["API"], 0),
            row("c", &["テスト"], 0),
        ]
    );
    // 設計を閉じると、a の見えているメンバーは設計 1 つで枠になる。b は見えているメンバーが 0 で枠なし
    let folded = document(FOLDING).fold(&["設計"]);
    assert_eq!(
        folded.frames(),
        vec![row("a", &["設計"], 0), row("c", &["テスト"], 0)]
    );
    // 実装を閉じると、c は見えているメンバーが 0 で枠なし
    let folded = document(FOLDING).fold(&["実装"]);
    assert_eq!(
        folded.frames(),
        vec![row("a", &["設計", "画面", "API"], 1), row("b", &["API"], 0),]
    );
}

#[test]
fn single_member_frames_nest_by_the_same_rules() {
    // sec (鍵 1 つ) は ops (運用、監視、鍵) のメンバーに全部含まれるので内側 (level 0)、ops は外側 (level 1)。
    // x と y はメンバーが同じ (告知 1 つ) なので、groups で先に定義した x が外側 (level 1)。外側の枠から先に並ぶ
    let doc = document(NESTED);
    assert_eq!(
        doc.frames(),
        vec![
            row("ops", &["運用", "監視", "鍵"], 1),
            row("x", &["告知"], 1),
            row("sec", &["鍵"], 0),
            row("y", &["告知"], 0),
        ]
    );
    // groups で y を先に定義すると、y が外側
    let swapped = NESTED.replace(
        "        x:\n            label: 広報\n            boundary: true\n        y:\n            label: 法務\n            boundary: true\n",
        "        y:\n            label: 法務\n            boundary: true\n        x:\n            label: 広報\n            boundary: true\n",
    );
    assert_ne!(swapped, NESTED);
    let doc = document(&swapped);
    let rows = doc.frames();
    assert!(rows.contains(&row("y", &["告知"], 1)), "{rows:?}");
    assert!(rows.contains(&row("x", &["告知"], 0)), "{rows:?}");
}

#[test]
fn single_member_frames_are_blocks_of_the_placement() {
    // 1 つのメンバーの枠も 2 つ以上の枠と同じく、配置の箱になる (loose にならない)。
    // 文書ごとの (枠の数, そのうちメンバー 1 つの枠の数) は上の試験の並びと同じ
    for (source, counts) in [
        (CROSS, (3, 1)),
        (WHOLE_SINGLE, (2, 2)),
        (BOUNDARY_FALSE, (1, 1)),
        (FOLDING, (3, 2)),
        (NESTED, (4, 3)),
    ] {
        let doc = document(source);
        let graph = project(&doc.input).unwrap();
        let children_of = layout_children_of(&graph);
        let frames = compute_frames(&graph, &doc.groups, &doc.groups_of, &children_of);
        let singles = frames
            .iter()
            .filter(|frame| frame.members.len() == 1)
            .count();
        assert_eq!((frames.len(), singles), counts, "{:?}", doc.frames());
        let blocks = frame_blocks(&graph, &frames, &children_of);
        assert!(blocks.loose.is_empty(), "{:?}", doc.frames());
        assert_eq!(blocks.blocks.len(), frames.len(), "{:?}", doc.frames());
        let boxed: HashSet<usize> = blocks.blocks.iter().map(|block| block.frame).collect();
        assert_eq!(boxed.len(), frames.len(), "{:?}", doc.frames());
    }
}

// ---- 配置 (layout_document) ----

fn overlaps(a: &Rect, b: &Rect) -> bool {
    let x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    x > TOLERANCE && y > TOLERANCE
}

fn contains(outer: &Rect, inner: &Rect) -> bool {
    inner.x >= outer.x - TOLERANCE
        && inner.y >= outer.y - TOLERANCE
        && inner.x + inner.width <= outer.x + outer.width + TOLERANCE
        && inner.y + inner.height <= outer.y + outer.height + TOLERANCE
}

// 枠の矩形 (outline) を上へラベルの行のぶん広げたもの
fn with_label(outline: &Rect) -> Rect {
    Rect {
        y: outline.y - LABEL_HEIGHT,
        height: outline.height + LABEL_HEIGHT,
        ..*outline
    }
}

fn with_gap(rect: &Rect, gap: f64) -> Rect {
    Rect {
        x: rect.x - gap,
        width: rect.width + gap,
        ..*rect
    }
}

fn same_rect(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() <= TOLERANCE
        && (a.y - b.y).abs() <= TOLERANCE
        && (a.width - b.width).abs() <= TOLERANCE
        && (a.height - b.height).abs() <= TOLERANCE
}

// 配置の結果の、枠ごとの不変条件 (配置の流れの単体テストの I1、I2、I10 と同じ読み方)。
// どの枠の矩形 (ラベルの行を含む) にも、メンバーでない見えているノード (本体か、左の余白を足した矩形) が入らない。
// メンバーが交わらない 2 つの枠は、ラベルの行ごと重ならない。メンバーを全部含む外側の枠は、内側の枠をラベルの行ごと囲む
fn check_frames(name: &str, result: &LayoutDocumentResult) {
    for entry in &result.frames {
        let outline = entry.outline.expect("outline");
        let area = with_label(&outline);
        let intruders: Vec<u32> = result
            .rects
            .iter()
            .filter(|(id, rect)| {
                let gap = result.gaps.get(*id).copied().unwrap_or(0.0);
                rect.width > 0.0
                    && rect.height > 0.0
                    && !entry.frame.members.contains(id)
                    && (overlaps(rect, &area) || overlaps(&with_gap(rect, gap), &area))
            })
            .map(|(id, _)| *id)
            .collect();
        assert!(
            intruders.is_empty(),
            "{name}: 枠 {} {:?} にメンバーでないノード {intruders:?} が入る",
            entry.frame.group.id,
            entry.frame.members
        );
    }
    for (index, a) in result.frames.iter().enumerate() {
        for b in &result.frames[index + 1..] {
            let members_a: HashSet<u32> = a.frame.members.iter().copied().collect();
            let common = b
                .frame
                .members
                .iter()
                .filter(|id| members_a.contains(id))
                .count();
            let (outline_a, outline_b) = (a.outline.unwrap(), b.outline.unwrap());
            let path = format!(
                "{name}: 枠 {} {:?} と {} {:?}",
                a.frame.group.id, a.frame.members, b.frame.group.id, b.frame.members
            );
            if common == 0 {
                assert!(
                    !overlaps(&with_label(&outline_a), &with_label(&outline_b)),
                    "{path}: メンバーが交わらない枠が重なる"
                );
            } else if common == b.frame.members.len() && a.frame.level > b.frame.level {
                assert!(
                    contains(&outline_a, &with_label(&outline_b)),
                    "{path}: 内側の枠がラベルの行ごと外側の枠に収まらない"
                );
            } else if common == a.frame.members.len() && b.frame.level > a.frame.level {
                assert!(
                    contains(&outline_b, &with_label(&outline_a)),
                    "{path}: 内側の枠がラベルの行ごと外側の枠に収まらない"
                );
            }
        }
    }
}

// group の枠のうち、メンバーがちょうど [id] のもの
fn single_frame<'a>(
    result: &'a LayoutDocumentResult,
    group: &str,
    id: u32,
) -> &'a markdag_core::layout::pipeline::LayoutDocumentFrame {
    let found: Vec<_> = result
        .frames
        .iter()
        .filter(|entry| entry.frame.group.id == group && entry.frame.members == [id])
        .collect();
    assert_eq!(found.len(), 1, "{group} の [{id}] の枠がちょうど 1 つ");
    found[0]
}

#[test]
fn single_member_frames_are_placed_with_padding_and_a_clear_label_row() {
    // groups-cross: 枠 3 つ (どれも箱) を 1 回で置く。鍵のローテーションの枠は、そのノードの矩形に 2 つ以上の枠と同じ余白
    // (frame_padding(0)) を四辺に足した矩形。上の監視の設定は、枠のラベルの行より上 (重ならない)
    let doc = document(CROSS);
    let (result, counts) = doc.layout();
    assert_eq!(result.frames.len(), 3);
    assert_eq!(counts, FrameBoxCounts { boxed: 3, loose: 0 });
    assert_eq!(result.passes, 1);
    check_frames("groups-cross", &result);

    let key = doc.id("鍵のローテーション");
    let frame = single_frame(&result, "sec", key);
    let outline = frame.outline.expect("outline");
    let rect = result.rects[&key];
    assert!(
        same_rect(&outline, &frame_rect(&rect, 0)),
        "outline {outline:?} / ノード {rect:?}"
    );
    let padding = frame_padding(0);
    assert_eq!((padding.top, padding.side, padding.bottom), (8.0, 8.0, 8.0));
    let above = result.rects[&doc.id("監視の設定")];
    assert!(
        above.y + above.height <= outline.y - LABEL_HEIGHT + TOLERANCE,
        "監視の設定 {above:?} が枠 {outline:?} のラベルの行に掛かる"
    );
    // 2 つ以上の枠も、メンバーの外接矩形に同じ余白を足した矩形 (同じ作り)
    for entry in result
        .frames
        .iter()
        .filter(|entry| entry.frame.members.len() == 2)
    {
        let rects: Vec<Rect> = entry
            .frame
            .members
            .iter()
            .map(|id| result.rects[id])
            .collect();
        let left = rects.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
        let top = rects.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
        let right = rects
            .iter()
            .map(|r| r.x + r.width)
            .fold(f64::NEG_INFINITY, f64::max);
        let bottom = rects
            .iter()
            .map(|r| r.y + r.height)
            .fold(f64::NEG_INFINITY, f64::max);
        let bounds = Rect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        };
        assert!(same_rect(&entry.outline.unwrap(), &frame_rect(&bounds, 0)));
    }
}

#[test]
fn single_member_frames_of_whole_groups_and_folded_roots_are_placed_as_boxes() {
    // グループ全体でメンバーが 1 つの枠と、閉じて見えているメンバーが 1 つになった枠も、箱として置き、入り込みがない
    let cases = [
        ("whole-single", document(WHOLE_SINGLE), 2usize),
        ("boundary-false", document(BOUNDARY_FALSE), 1),
        ("folding", document(FOLDING), 3),
        ("folding-design", document(FOLDING).fold(&["設計"]), 2),
    ];
    for (name, doc, count) in cases {
        let (result, counts) = doc.layout();
        assert_eq!(result.frames.len(), count, "{name}");
        assert_eq!(
            counts,
            FrameBoxCounts {
                boxed: count,
                loose: 0
            },
            "{name}"
        );
        assert_eq!(result.passes, 1, "{name}");
        check_frames(name, &result);
        for entry in result
            .frames
            .iter()
            .filter(|entry| entry.frame.members.len() == 1)
        {
            let id = entry.frame.members[0];
            let outline = entry.outline.expect("outline");
            assert!(
                same_rect(&outline, &frame_rect(&result.rects[&id], entry.frame.level)),
                "{name}: {} の枠 {outline:?} / ノード {:?}",
                entry.frame.group.id,
                result.rects[&id]
            );
        }
    }
}

#[test]
fn single_member_frames_nest_inside_and_outside_with_the_label_row() {
    // sec (鍵) の枠は ops の枠の中にラベルの行ごと収まる。x (外、level 1) は y (内、level 0) を囲み、
    // x の枠は告知の矩形に frame_padding(1) を足した矩形
    let doc = document(NESTED);
    let (result, counts) = doc.layout();
    assert_eq!(result.frames.len(), 4);
    assert_eq!(counts, FrameBoxCounts { boxed: 4, loose: 0 });
    assert_eq!(result.passes, 1);
    check_frames("nested", &result);

    let key = doc.id("鍵");
    let ops = result
        .frames
        .iter()
        .find(|entry| entry.frame.group.id == "ops")
        .unwrap();
    let sec = single_frame(&result, "sec", key);
    assert!(contains(
        &ops.outline.unwrap(),
        &with_label(&sec.outline.unwrap())
    ));

    let notice = doc.id("告知");
    let (x, y) = (
        single_frame(&result, "x", notice),
        single_frame(&result, "y", notice),
    );
    assert_eq!((x.frame.level, y.frame.level), (1, 0));
    assert!(same_rect(
        &x.outline.unwrap(),
        &frame_rect(&result.rects[&notice], 1)
    ));
    assert!(same_rect(
        &y.outline.unwrap(),
        &frame_rect(&result.rects[&notice], 0)
    ));
    assert!(contains(
        &x.outline.unwrap(),
        &with_label(&y.outline.unwrap())
    ));
}
