// 原文: src/layout/input-types.ts、src/parse/document.ts、src/parse/task.ts、src/model/model.ts、src/model/tags.ts、src/model/hooks.ts の型 (2026-09-24)
// 層をまたいで共有する型と、境界の JSON の契約 (規則書 4 章、設計文書 (b))。
// JSON は TS の型の欄をそのまま camelCase で出す。`T | null` は Option で null を書き、`x?: T` は Option で欄を省く。
// Map の欄は配列の組 (util の pairs)、f64 の欄は有限でない数を印にする (util の js_f64)。
// 各単位はここを `use crate::types::*` で使い、手元に写しを作らない。
use std::fmt;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::model::util::JsValue;

// 文字列の union の enum に、原文の文字 (as_str)、JS の値からの変換 (from_js)、原文の配列の順の一覧 (ALL) を付ける。
// serde の名前は各 enum の属性で付け、as_str と一致することを単体テストで確かめる
macro_rules! str_enum_impl {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl $name {
            /// 原文の配列と同じ順の、すべての値
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            /// 原文の文字
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }

            /// JS の値が原文の文字のどれかならその値 (`includes(v as X)` と `find(p => p === v)` の写し)
            pub fn from_js(value: &JsValue) -> Option<Self> {
                match value {
                    JsValue::String(text) => Self::ALL.iter().copied().find(|item| item.as_str() == text),
                    _ => None,
                }
            }
        }
    };
}

// ---- 解析の層 (src/parse/document.ts、src/parse/task.ts) ----

/// 原文での位置。行と桁は 1 始まりで、桁と長さはコードポイントで数える
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePosition {
    pub line: u32,
    pub column: u32,
    pub length: u32,
}

/// ノードに付けたタグ 1 つ (`#キー:値`)。値は , で区切って複数書ける。`#キー` だけなら値は空
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeTag {
    pub key: String,
    pub values: Vec<String>,
    /// 原文での印の位置 (`#キー:値` の全体)。同じキーを 1 行に 2 回書いたときは最初のもの
    // 原文 (document.ts:23) で null にならないので Option にしない (規則 2.1、A-046)
    pub at: SourcePosition,
}

/// タスクの状態 (原文の TaskState)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Todo,
    Doing,
    Done,
    Canceled,
}
str_enum_impl!(TaskState { Todo => "todo", Doing => "doing", Done => "done", Canceled => "canceled" });

/// 行頭の状態の記号 (原文の TaskMark。TASK_MARKS の順)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaskMark {
    #[serde(rename = " ")]
    Space,
    #[serde(rename = "/")]
    Slash,
    #[serde(rename = "x")]
    X,
    #[serde(rename = "-")]
    Hyphen,
}
str_enum_impl!(TaskMark { Space => " ", Slash => "/", X => "x", Hyphen => "-" });

/// 状態ごとの記号の絵 (SVG)。原文の `Record<TaskState, string>`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIcons {
    // 欄の順は原文が組むオブジェクトの順 (document.ts の `{ todo, done, doing, canceled }`)
    pub todo: String,
    pub done: String,
    pub doing: String,
    pub canceled: String,
}

/// toggle_task の戻り値 (DESIGN (b) の `{ line, text }`)。書き換えた 1 行と、その行の番号 (0 始まり)。
/// 原文にない境界の戻り値なので「関数名 + Result」の名前で共有の型に置く (A-055)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleTaskResult {
    pub line: u32,
    pub text: String,
}

/// 原文での行の範囲 (0 始まり。end の行は含まない)。OutlineNode.lines の名前のない型
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// タスクの原文での行 (0 始まり) と状態。checked は state が done のこと。OutlineNode.task の名前のない型
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub line: u32,
    pub state: TaskState,
    pub checked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    /// 文書順 (深さ優先の先行順) の連番。ルートが 1
    pub id: u32,
    pub parent: Option<u32>,
    /// ルートが 1
    pub depth: u32,
    /// ノードの内容。詳細の引用ブロックは、書かれた位置に印 (クラス mdag-details) を付けて残す
    pub html: String,
    /// relations と groups から照合する文字列 (1 行目の、装飾を除いた文字)
    pub ref_text: String,
    pub ref_id: Option<String>,
    /// 1 行目の末尾に `%名前` で付けた、そのノード自身のグループ
    pub groups: Vec<String>,
    /// 1 行目の末尾に `#キー:値` で付けたタグ。配下には継承しない
    pub tags: Vec<NodeTag>,
    pub milestone: bool,
    /// Markdown のコメントによる折りたたみの指定。0 = なし、1 = そのノード、2 = 配下もすべて
    #[serde(with = "crate::model::util::js_f64")]
    pub fold_hint: f64,
    pub lines: Option<LineRange>,
    pub task: Option<TaskInfo>,
    /// リスト項目の中に引用ブロック (`>`) で書かれた詳細の HTML (複数あれば、つなげたもの)
    pub details: Option<String>,
}

/// 文書が数式やコードを含むか。飾り (KaTeX、色付け) と styleUrls は TS の包みが後から作る (決定 12、設計文書 (a))
// 名前は審判の harness の ParsedFeatures に合わせる (規則 4 章、決定 12)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFeatures {
    pub math: bool,
    pub code: bool,
}

/// 解析の結果。原文の styleUrls は Rust では出さず features を返す (包みが styleUrls に直して欄を消す)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocument {
    pub nodes: Vec<OutlineNode>,
    /// YAML を読んだ値。写像とは限らない (読めなければ空の写像)
    pub frontmatter: JsValue,
    /// frontmatter に markdag のキーがあり、タグなどの抽出を行ったか
    pub extracted: bool,
    /// 状態ごとの記号の絵。parse_document は常に Some を返す (記号を絵にしない構成はない。境界の型は旧実装の契約 `TaskIcons | null` のまま)
    pub task_icons: Option<TaskIcons>,
    pub features: ParsedFeatures,
}

// ---- 配置の入力 (src/layout/input-types.ts) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RelationKind {
    Fork,
    Join,
    Chain,
    Depends,
}
str_enum_impl!(RelationKind { Fork => "fork", Join => "join", Chain => "chain", Depends => "depends" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInputNode {
    /// 文書順 (深さ優先の先行順) の連番。ルートが 1
    pub id: u32,
    pub label: String,
    /// ノード本体の大きさ。余白や線の太さは含まない
    #[serde(with = "crate::model::util::js_f64")]
    pub width: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub height: f64,
    /// Markdown に書かれた、そのノード自身のグループ (継承は解決していない)
    /// 欄のない入力は空として読む。原文は `...node` で欄を読まずに通し、groups のない古い形の入力 (spike の配置の入力) も射影できた (A-199)
    #[serde(default)]
    pub groups: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInputEdge {
    pub source: u32,
    pub target: u32,
}

/// 原文は `LayoutInputEdge` を extends する
// extends は flatten で包まず欄を並べて写し、JSON の欄の順を原文の宣言の順に保つ (規則 2.6、A-047)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInputRelation {
    pub source: u32,
    pub target: u32,
    pub kind: RelationKind,
    /// 展開する前の relations の記述。1 つの記述から複数のエッジが生まれる場合は同じ値になる
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutInput {
    pub name: String,
    /// 文書順に並ぶ。兄弟の並びはこの順で決まる
    pub nodes: Vec<LayoutInputNode>,
    /// Markdown のツリーの親子
    pub tree_edges: Vec<LayoutInputEdge>,
    pub relations: Vec<LayoutInputRelation>,
    /// ルートからの線を抑制するトップレベルノード
    pub suppress_root_line: Vec<u32>,
    /// 閉じているノード。配下は見えているグラフから外れる
    pub folded: Vec<u32>,
}

/// 配置の層が投げる誤り (原文の `throw new Error(msg)`)。文面は原文のまま
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutError {
    pub message: String,
}

impl fmt::Display for LayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LayoutError {}

/// 矩形 (原文 layout.ts の Rect)。layout、frames、pipeline が使い、境界に出る (A-037)。
/// 空の図の bounds は有限でない数になるので、欄は js_f64 で印にする
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    #[serde(with = "crate::model::util::js_f64")]
    pub x: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub y: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub width: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub height: f64,
}

// Rect 以外の配置の出力の型 (VisibleGraph、PlacedNode、Frame など) は写し先 (layout.rs / project.rs / frames.rs) に置く (4 章、A-037)

// ---- モデルの層 (src/model/model.ts) ----

/// 診断の重さ (Diagnostic.severity)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Error,
    Warning,
    Info,
}
str_enum_impl!(Severity { Error => "error", Warning => "warning", Info => "info" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    /// 原文での位置 (frontmatter の指定か、本文のタグ)。場所を特定できなかったものは null
    pub at: Option<SourcePosition>,
    /// 直し方の手がかり (近い名前、書き方の例)
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDef {
    pub id: String,
    pub label: String,
    pub color: Option<String>,
    pub boundary: bool,
    /// frontmatter の markdag.groups に定義があるか (定義のないグループは文字ラベルになる)
    pub defined: bool,
}

/// ノードに添えるもの (詳細、タグ) の見せ方
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DisplayMode {
    Always,
    Hover,
    Click,
}
str_enum_impl!(DisplayMode { Always => "always", Hover => "hover", Click => "click" });

/// タグの見せ方 (原文の `DisplayMode | 'never'`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TagDisplayMode {
    Always,
    Hover,
    Click,
    Never,
}
str_enum_impl!(TagDisplayMode { Always => "always", Hover => "hover", Click => "click", Never => "never" });

/// 薄く表示するタスクのノードでの、詳細とタグの見せ方
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DimDisplayMode {
    Keep,
    Hover,
    Click,
    Never,
}
str_enum_impl!(DimDisplayMode { Keep => "keep", Hover => "hover", Click => "click", Never => "never" });

/// 薄く表示するタスクの状態と、そのノードでの詳細とタグの見せ方 (frontmatter の markdag.tasks.dim)
// GraphModel の欄が参照するので types.rs に置く (原文は model.ts。4 章、A-048)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDimOptions {
    pub states: Vec<TaskState>,
    pub details: DimDisplayMode,
    pub tags: DimDisplayMode,
}

/// 凡例に出す項目
// GraphModel の欄が参照するので types.rs に置く (原文は model.ts。4 章、A-048)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegendItem {
    Groups,
    Branches,
}
str_enum_impl!(LegendItem { Groups => "groups", Branches => "branches" });

/// 凡例を置く、図の領域の隅 (LEGEND_POSITIONS の順。先頭が既定)
// GraphModel の欄が参照するので types.rs に置く (原文は model.ts。4 章、A-048)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegendPosition {
    TopRight,
    TopLeft,
    BottomRight,
    BottomLeft,
}
str_enum_impl!(LegendPosition {
    TopRight => "top-right",
    TopLeft => "top-left",
    BottomRight => "bottom-right",
    BottomLeft => "bottom-left",
});

// ---- タグの型 (src/model/tags.ts) ----

/// タグの値の基底の型 (PRIMITIVES の順)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Primitive {
    String,
    Number,
    Integer,
    Boolean,
    Enum,
    Date,
    Datetime,
    Time,
    Duration,
    #[serde(rename = "nodeId")]
    NodeId,
}
str_enum_impl!(Primitive {
    String => "string",
    Number => "number",
    Integer => "integer",
    Boolean => "boolean",
    Enum => "enum",
    Date => "date",
    Datetime => "datetime",
    Time => "time",
    Duration => "duration",
    NodeId => "nodeId",
});

/// 原文の `number | string` の欄 (TagValueType の min / max)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NumberOrString {
    Number(#[serde(with = "crate::model::util::js_f64")] f64),
    String(String),
}

impl From<&NumberOrString> for JsValue {
    fn from(value: &NumberOrString) -> JsValue {
        match value {
            NumberOrString::Number(number) => JsValue::Number(*number),
            NumberOrString::String(text) => JsValue::String(text.clone()),
        }
    }
}

/// 1 つの値の形。基底の型と、その型に効く制約を重ねたもの
// 原文は名前付きの型から引き継いだ欄のあとに制約の欄を足す (tags.ts:320-329) ので、JSON のキーの順が宣言の順と違うことがある。キーの順は契約に入らない (4 章、A-049)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagValueType {
    pub primitive: Primitive,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patterns: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::model::util::js_f64::option"
    )]
    pub min_length: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::model::util::js_f64::option"
    )]
    pub max_length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<NumberOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<NumberOrString>,
}

/// キー 1 つの、解決済みの定義。値はどれかの形に合えば通る
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagKeyDef {
    pub key: String,
    pub alternatives: Vec<TagValueType>,
    pub multiple: bool,
    pub unique: bool,
    pub description: Option<String>,
}

/// frontmatter の中での場所を指す道すじの 1 段 (原文の SourcePath の要素 `string | number`)。
/// 文字はマップのキー、数はならびの添字 (キー "7" と添字 7 を区別する)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathStep {
    Key(String),
    Index(usize),
}

impl From<&PathStep> for JsValue {
    fn from(value: &PathStep) -> JsValue {
        match value {
            PathStep::Key(key) => JsValue::String(key.clone()),
            PathStep::Index(index) => JsValue::Number(*index as f64),
        }
    }
}

/// 原文の SourcePath (`Array<string | number>`)
pub type SourcePath = Vec<PathStep>;

/// suggestTagKeys の候補 1 つ (名前のない戻り値の型)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagKeySuggestion {
    pub key: String,
    pub description: Option<String>,
}

/// TagLintOptions.severity (Severity の部分集合)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TagLintSeverity {
    Warning,
    Error,
}
str_enum_impl!(TagLintSeverity { Warning => "warning", Error => "error" });

// 規則 4 章 (A-079): union の部分集合から元の union への変換
impl From<TagLintSeverity> for Severity {
    fn from(value: TagLintSeverity) -> Self {
        match value {
            TagLintSeverity::Warning => Severity::Warning,
            TagLintSeverity::Error => Severity::Error,
        }
    }
}

/// TagLintOptions.unknownKey (`'allow' | 'deny'`)
// 規則 4 章 (A-078): 部分集合でない union も「型名 + 欄名」で名前を付け、TagLintSeverity と同じく str_enum_impl! を持つ
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TagLintUnknownKey {
    Allow,
    Deny,
}
str_enum_impl!(TagLintUnknownKey { Allow => "allow", Deny => "deny" });

/// タグの型の定義と本文のタグの検査で見つかった問題 (原文の TagIssue)。呼び出し側が Diagnostic に直す
// 規則 4 章 (A-053): ResolvedTagKeys が参照するので共有の型の一覧に入れる
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagIssue {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
    /// frontmatter の中の場所 (呼び出し側が位置に直す)
    pub path: Option<SourcePath>,
    /// 本文のタグの位置
    pub at: Option<SourcePosition>,
}

/// resolveTagKeys の戻り値 (名前のない戻り値の型。4 章)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTagKeys {
    pub keys: Vec<TagKeyDef>,
    pub issues: Vec<TagIssue>,
}

// ---- フックの宣言 (src/model/hooks.ts、設計文書 (b)) ----

/// 呼び出し側が渡した hookRefs の、ref ごとの値 (A-034)。包みが import したモジュールから作る
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HookSpecEntry {
    /// 読めたモジュール。exports は Object.entries の順の `[名前, 関数か]`
    Module { exports: Vec<(String, bool)> },
    /// 読めたが record でない (null を含む)
    Invalid,
}

/// 呼び出し側が渡した hookRefs の写像全体 (`{ [ref]: HookSpecEntry }`。境界の JSON ではオブジェクト)
pub type HookSpec = IndexMap<String, HookSpecEntry>;

/// 宣言と突き合わせたフック 1 つ (原文の ResolvedHook から関数を除いたもの)。exports は拾った関数の名前
// 設計文書 (b) の `declared: [{ ref, exports }]` の要素。関数を持たないので原文の ResolvedHook と区別して DeclaredHook と呼ぶ (規則 4 章)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredHook {
    #[serde(rename = "ref")]
    pub ref_text: String,
    pub exports: Vec<String>,
}

/// frontmatter の markdag.rules から読んだ組み込みの規則の設定 (原文の rulesModule が作る閉包の材料)。
/// 関数は JS の包みがこの値から組み立てる
// ModelHooks の欄が参照するので types.rs に置く (4 章、A-048)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesConfig {
    pub require_upstream_done: bool,
    pub readonly_groups: Vec<String>,
    pub keep_milestones_open: bool,
}

/// GraphModel.hooks のデータ部分 (原文の ResolvedHooks)。declared は宣言の順、rules は有効な規則が 1 つもなければ null
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHooks {
    pub declared: Vec<DeclaredHook>,
    /// frontmatter の markdag.hooks.options (常に Object)
    pub options: JsValue,
    pub rules: Option<RulesConfig>,
}

// ModelOptions は 4 章の一覧に無いので既定の写し先 (原文の buildModel を写すモジュール) に置く (4 章 1 項)。形は台帳の types / hookRefs の行と 2.1

/// buildModel の結果のデータ部分 (関数の欄は持たない)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphModel {
    /// 文書 (markdag.details.display) が指定する詳細の見せ方。指定がなければ null
    pub details_mode: Option<DisplayMode>,
    /// 凡例に出す項目 (markdag.legend.display)。空なら凡例を出さない
    pub legend: Vec<LegendItem>,
    pub legend_position: LegendPosition,
    pub edge_highlight: bool,
    pub group_highlight: bool,
    /// 色を分ける単位にする枝の起点のノード (markdag.branches)。書かれた順
    pub branches: Vec<u32>,
    pub relations: Vec<LayoutInputRelation>,
    pub suppress_root_line: Vec<u32>,
    pub groups: Vec<GroupDef>,
    /// ノードごとの所属。groups の定義順、そのあとに定義のないグループを書かれた順
    #[serde(with = "crate::model::util::pairs")]
    pub groups_of: IndexMap<u32, Vec<String>>,
    pub tag_display: TagDisplayMode,
    /// ノードごとのタグ (そのノードに書かれたものだけ、書かれた順)
    #[serde(with = "crate::model::util::pairs")]
    pub tags_of: IndexMap<u32, Vec<NodeTag>>,
    /// キーごとの解決済みの定義。定義のないキーは入らない
    pub tag_keys: Vec<TagKeyDef>,
    pub task_cycle: Vec<TaskMark>,
    pub task_dim: TaskDimOptions,
    pub hooks: ModelHooks,
    pub diagnostics: Vec<Diagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 境界の JSON の形 (DESIGN (b) の `{ line, text }`)。置き場所を移しても欄の名前と順は変わらない (A-055)
    #[test]
    fn toggle_task_result_serializes_as_line_and_text() {
        let result = ToggleTaskResult {
            line: 3,
            text: "- [x] A".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&result).expect("serialize"),
            r#"{"line":3,"text":"- [x] A"}"#
        );
    }

    fn serde_name<T: Serialize>(value: T) -> String {
        match serde_json::to_value(value) {
            Ok(serde_json::Value::String(text)) => text,
            other => panic!("文字列にならない: {other:?}"),
        }
    }

    macro_rules! assert_names_agree {
        ($($name:ident),+) => {
            $(
                for item in $name::ALL {
                    assert_eq!(serde_name(*item), item.as_str(), "{}", stringify!($name));
                    assert_eq!($name::from_js(&JsValue::String(item.as_str().to_string())), Some(*item));
                }
                assert_eq!($name::from_js(&JsValue::Null), None);
                assert_eq!($name::from_js(&JsValue::String("?".to_string())), None);
            )+
        };
    }

    #[test]
    fn types_enum_serde_names_match_as_str() {
        assert_names_agree!(
            TaskState,
            TaskMark,
            RelationKind,
            Severity,
            DisplayMode,
            TagDisplayMode,
            DimDisplayMode,
            LegendItem,
            LegendPosition,
            Primitive,
            TagLintSeverity,
            TagLintUnknownKey
        );
    }

    #[test]
    fn types_null_and_omitted_fields() {
        let value = TagValueType {
            primitive: Primitive::NodeId,
            values: None,
            patterns: None,
            min_length: Some(f64::NAN),
            max_length: None,
            min: Some(NumberOrString::Number(1.0)),
            max: Some(NumberOrString::String("2026-01-01".to_string())),
        };
        assert_eq!(
            serde_json::to_value(&value).expect("serialize"),
            json!({ "primitive": "nodeId", "minLength": { "$number": "NaN" }, "min": 1, "max": "2026-01-01" })
        );
        let def = TagKeyDef {
            key: "k".to_string(),
            alternatives: vec![],
            multiple: false,
            unique: false,
            description: None,
        };
        assert_eq!(
            serde_json::to_value(&def).expect("serialize"),
            json!({ "key": "k", "alternatives": [], "multiple": false, "unique": false, "description": null })
        );
    }

    #[test]
    fn types_hook_spec_shape() {
        let spec: HookSpec = serde_json::from_value(json!({
            "./a.js": { "kind": "module", "exports": [["beforeFold", true], ["x", false]] },
            "./b.js": { "kind": "invalid" }
        }))
        .expect("deserialize");
        assert_eq!(spec.get("./b.js"), Some(&HookSpecEntry::Invalid));
        assert_eq!(
            spec.get("./a.js"),
            Some(&HookSpecEntry::Module {
                exports: vec![("beforeFold".to_string(), true), ("x".to_string(), false)]
            })
        );
        let declared = DeclaredHook {
            ref_text: "./a.js".to_string(),
            exports: vec!["beforeFold".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&declared).expect("serialize"),
            json!({ "ref": "./a.js", "exports": ["beforeFold"] })
        );
    }

    #[test]
    fn types_layout_input_node_without_groups() {
        let node: LayoutInputNode = serde_json::from_value(
            json!({ "id": 1, "label": "a", "width": 72, "height": 20, "tags": [] }),
        )
        .expect("deserialize");
        assert_eq!(node.groups, Vec::<String>::new());
        assert!(
            serde_json::from_value::<LayoutInputNode>(
                json!({ "id": 1, "label": "a", "width": 72, "height": 20, "groups": null })
            )
            .is_err()
        );
    }

    // 書いて読み戻し、もう一度書いた JSON が同じか (NaN は == で比べられないので JSON で比べる)
    fn assert_round_trip<T: Serialize + serde::de::DeserializeOwned>(
        value: &T,
        expected: serde_json::Value,
    ) {
        let written = serde_json::to_value(value).expect("serialize");
        assert_eq!(written, expected);
        let back: T = serde_json::from_value(written.clone()).expect("deserialize");
        assert_eq!(
            serde_json::to_value(&back).expect("serialize again"),
            written
        );
    }

    #[test]
    fn types_round_trip_non_finite_numbers_and_user_marks() {
        let mut frontmatter = IndexMap::new();
        frontmatter.insert("inf".to_string(), JsValue::Number(f64::INFINITY));
        frontmatter.insert("nan".to_string(), JsValue::Number(f64::NAN));
        let mut user = IndexMap::new();
        user.insert("$number".to_string(), JsValue::String("NaN".to_string()));
        frontmatter.insert("user".to_string(), JsValue::Object(user));
        let parsed = ParsedDocument {
            nodes: vec![],
            frontmatter: JsValue::Object(frontmatter),
            extracted: false,
            task_icons: None,
            features: ParsedFeatures::default(),
        };
        assert_round_trip(
            &parsed,
            json!({
                "nodes": [],
                "frontmatter": {
                    "inf": { "$number": "Infinity" },
                    "nan": { "$number": "NaN" },
                    "user": { "$object": [["$number", "NaN"]] }
                },
                "extracted": false,
                "taskIcons": null,
                "features": { "math": false, "code": false }
            }),
        );

        let value_type = TagValueType {
            primitive: Primitive::String,
            values: None,
            patterns: None,
            min_length: Some(f64::NAN),
            max_length: Some(f64::INFINITY),
            min: Some(NumberOrString::Number(f64::NEG_INFINITY)),
            max: None,
        };
        assert_round_trip(
            &value_type,
            json!({
                "primitive": "string",
                "minLength": { "$number": "NaN" },
                "maxLength": { "$number": "Infinity" },
                "min": { "$number": "-Infinity" }
            }),
        );
        let back: TagValueType =
            serde_json::from_value(serde_json::to_value(&value_type).expect("serialize"))
                .expect("deserialize");
        assert!(back.min_length.is_some_and(f64::is_nan));
        assert_eq!(back.min, Some(NumberOrString::Number(f64::NEG_INFINITY)));
    }

    #[test]
    fn types_task_icons_keep_the_original_key_order() {
        let icons = TaskIcons {
            todo: "t".to_string(),
            done: "d".to_string(),
            doing: "g".to_string(),
            canceled: "c".to_string(),
        };
        assert_eq!(
            serde_json::to_string(&icons).expect("serialize"),
            r#"{"todo":"t","done":"d","doing":"g","canceled":"c"}"#
        );
    }

    #[test]
    fn types_path_step_keeps_keys_and_indexes_apart() {
        let path: SourcePath =
            serde_json::from_value(json!(["markdag", "7", 7])).expect("deserialize");
        assert_eq!(
            path,
            vec![
                PathStep::Key("markdag".to_string()),
                PathStep::Key("7".to_string()),
                PathStep::Index(7)
            ]
        );
        assert_eq!(JsValue::from(&path[2]), JsValue::Number(7.0));
    }
}

// PORT STATUS: confidence=medium todos=0
