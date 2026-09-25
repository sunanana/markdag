// JS と Rust の境界。wasm-bindgen を使わず、`extern "C"` の関数と線形メモリだけで受け渡す。
// 入出力は UTF-8 の JSON のバイト列。JS 側の境界のレイヤーが mdag_alloc で場所を取って書き込み、
// 返された (ptr, len) を読んでから mdag_free で返す。Rust から JS を呼ぶ import は持たない。
// 生ポインタを扱うのでこの crate だけ unsafe を許す (中核の crate は forbid)。
//
// JSON の契約は設計文書 (b) の表: 入力は関数ごとの引数をまとめたオブジェクト、出力は `{ "ok": 値 }` か
// `{ "error": { "code", "message" } }`。Map は配列の組、有限でない数は `$number` の印 (中核の crate の serde のまま)。
// panic は wasm32 では unwind しないので trap になる。文面は set_hook で静的な緩衝に書き、JS が trap のあと
// mdag_last_panic で読んでからインスタンスを作り直す。呼び出しの間に持つ状態はこの緩衝だけ。
#![deny(unsafe_op_in_unsafe_fn)]

use std::sync::{Mutex, Once};

use indexmap::IndexMap;
use markdag_core::layout::frames::{Frame, compute_frames};
use markdag_core::layout::layout::LayoutOptions;
use markdag_core::layout::pipeline::layout_document;
use markdag_core::layout::project::{VisibleGraph, project};
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::schema::check_frontmatter;
use markdag_core::model::tags::{suggest_tag_keys, suggest_tag_values};
use markdag_core::model::util::JsValue;
use markdag_core::parse::task::{next_task_mark, toggle_task};
use markdag_core::parse::{parse_document, replace_leading_mark};
use markdag_core::standalone::{
    StandaloneError, StandaloneOptions, StandaloneRuntime, render_standalone_page,
};
use markdag_core::types::{
    GraphModel, GroupDef, HookSpec, LayoutError, LayoutInput, OutlineNode, ParsedDocument,
    TagKeyDef, TaskIcons, TaskMark, TaskState,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// 戻り値の詰め方: 上位 32 bit が ptr、下位 32 bit が len
fn pack(ptr: usize, len: usize) -> u64 {
    ((ptr as u64) << 32) | (len as u64)
}

/// バイト列を線形メモリに置いたまま JS に渡す。JS が読み終えたら mdag_free で返す
fn hand_over(bytes: Vec<u8>) -> u64 {
    let boxed = bytes.into_boxed_slice();
    let len = boxed.len();
    let ptr = Box::into_raw(boxed) as *mut u8 as usize;
    pack(ptr, len)
}

/// JS が書き込む場所を len バイト確保して先頭を返す。読み終えたら mdag_free で返すこと
#[unsafe(no_mangle)]
pub extern "C" fn mdag_alloc(len: usize) -> *mut u8 {
    // 各呼び出しで最初に走る export なので、ここで panic しても文面が残るように hook を先に入れる
    install_panic_hook();
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// mdag_alloc で取った場所か、戻り値として渡された (ptr, len) を返す。len は取ったときと同じ値
///
/// # Safety
/// ptr と len は mdag_alloc か戻り値の (ptr, len) のままで、まだ返していないこと
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mdag_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: ptr と len は mdag_alloc か hand_over が渡したもので、それ以降は触っていない
    unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))) };
}

/// 疎通の確認。引数が渡り、値が返ることだけを見る
#[unsafe(no_mangle)]
pub extern "C" fn mdag_ping(n: u32) -> u32 {
    n.wrapping_add(1)
}

/// 中核の crate の版を UTF-8 で返す
#[unsafe(no_mangle)]
pub extern "C" fn mdag_version() -> u64 {
    hand_over(markdag_core::VERSION.as_bytes().to_vec())
}

/// 受け取ったバイト列をそのまま写して返す。境界のレイヤーの往復 (書く、呼ぶ、読む、返す) の確認用
///
/// # Safety
/// ptr と len は JS が mdag_alloc で取って書き込んだ範囲であること
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mdag_echo(ptr: *const u8, len: usize) -> u64 {
    // SAFETY: ptr と len は JS が mdag_alloc で取って書き込んだ範囲
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    hand_over(input.to_vec())
}

// ---- panic の文面 ----

// 最後の panic の文面。wasm32 はスレッドを持たないので Mutex は取り合わない。
// trap のあとインスタンスは作り直されるので、書くのは 1 インスタンスにつき高々 1 回
static LAST_PANIC: Mutex<Option<String>> = Mutex::new(None);
static HOOK: Once = Once::new();

fn install_panic_hook() {
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            // 文面の組み立ての中で再び panic しても trap になるだけなので、try_lock で取れなければ諦める
            if let Ok(mut slot) = LAST_PANIC.try_lock() {
                *slot = Some(info.to_string());
            }
        }));
    });
}

/// 最後の panic の文面 (UTF-8) の (ptr, len)。静的な緩衝を指すので **JS は mdag_free を呼ばない**。
/// panic がまだなければ len は 0
#[unsafe(no_mangle)]
pub extern "C" fn mdag_last_panic() -> u64 {
    match LAST_PANIC.try_lock() {
        Ok(slot) => match slot.as_deref() {
            Some(text) => pack(text.as_ptr() as usize, text.len()),
            None => 0,
        },
        Err(_) => 0,
    }
}

/// 境界の試験だけで使う、必ず panic する関数。`--features test-panic` のビルドにだけ入り、配布物には入らない
///
/// # Safety
/// ptr と len は JS が mdag_alloc で取って書き込んだ範囲であること
#[cfg(feature = "test-panic")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mdag_test_panic(ptr: *const u8, len: usize) -> u64 {
    install_panic_hook();
    // SAFETY: ptr と len は JS が mdag_alloc で取って書き込んだ範囲
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    panic!("test-panic: {}", String::from_utf8_lossy(input));
}

// ---- JSON の封筒 ----

/// 出力の error の欄。code は境界の誤りの種類 (中核の診断の code とは別の名前空間)
struct BoundaryError {
    code: &'static str,
    message: String,
}

impl BoundaryError {
    fn invalid_input(error: serde_json::Error) -> Self {
        BoundaryError {
            code: "invalid-input",
            message: error.to_string(),
        }
    }
}

impl From<LayoutError> for BoundaryError {
    fn from(error: LayoutError) -> Self {
        BoundaryError {
            code: "layout-error",
            message: error.message,
        }
    }
}

impl From<StandaloneError> for BoundaryError {
    fn from(error: StandaloneError) -> Self {
        BoundaryError {
            code: "standalone-error",
            message: error.message,
        }
    }
}

fn error_bytes(error: &BoundaryError) -> Vec<u8> {
    use serde_json::{Map, Value};
    let mut body = Map::new();
    body.insert("code".to_string(), Value::String(error.code.to_string()));
    body.insert("message".to_string(), Value::String(error.message.clone()));
    let mut envelope = Map::new();
    envelope.insert("error".to_string(), Value::Object(body));
    // Value の Display は失敗しないので、書けない場合の分岐を作らない
    Value::Object(envelope).to_string().into_bytes()
}

// `{"ok":` と `}` の間に値を直接書く (serde_json::Value を経ない)
fn ok_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, BoundaryError> {
    let mut out = Vec::from(&b"{\"ok\":"[..]);
    serde_json::to_writer(&mut out, value).map_err(|error| BoundaryError {
        code: "output",
        message: error.to_string(),
    })?;
    out.push(b'}');
    Ok(out)
}

/// 入力の JSON を I に読み、run の結果を封筒に入れて返す。各 mdag_<name> はこれを 1 回呼ぶだけ
///
/// # Safety
/// ptr と len は JS が mdag_alloc で取って書き込んだ範囲であること
unsafe fn call<I, O, F>(ptr: *const u8, len: usize, run: F) -> u64
where
    I: DeserializeOwned,
    O: Serialize,
    F: FnOnce(I) -> Result<O, BoundaryError>,
{
    install_panic_hook();
    // SAFETY: 呼び手の約束 (ptr と len は JS が mdag_alloc で取って書き込んだ範囲)
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let result = serde_json::from_slice::<I>(input)
        .map_err(BoundaryError::invalid_input)
        .and_then(run)
        .and_then(|value| ok_bytes(&value));
    hand_over(match result {
        Ok(bytes) => bytes,
        Err(error) => error_bytes(&error),
    })
}

// 入力の関数を持つ extern "C" の口を作る。本体は call に任せ、関数ごとの違いは入力の型と run だけにする
macro_rules! export_json {
    ($(#[$doc:meta])* $name:ident, $input:ty, $run:expr) => {
        $(#[$doc])*
        ///
        /// # Safety
        /// ptr と len は JS が mdag_alloc で取って書き込んだ範囲であること
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(ptr: *const u8, len: usize) -> u64 {
            // SAFETY: ptr と len は JS が mdag_alloc で取って書き込んだ範囲 (境界のレイヤーの約束)
            unsafe { call::<$input, _, _>(ptr, len, $run) }
        }
    };
}

// ---- 利用者がキーを決める写像の印 ----

// JS の境界のレイヤー (replaceMarks) は、どの深さのどのオブジェクトにも「undefined でない欄が 1 つで、キーが $number、
// $object、$undefined のどれかなら `{ "$object": [[キー, 値]] }` に包む」をかける。`{ "$undefined": true }` の印を付けるのは
// 包みが指定した JsValue の位置 (frontmatter と types の値) だけ (A-197)。Rust で JSON のオブジェクトを読む位置は 3 種類ある:
//   (1) derive した構造体と enum: 欄の名前は固定で、`$number` / `$object` / `$undefined` の欄を持つ型はない (js_f64 の印を除く) ので包まれない
//   (2) JsValue::Object: JsValue の Deserialize が包みを外す
//   (3) 文字列キーの写像 (IndexMap<String, _>): キーは利用者が書くので包まれうる。入力では types と hooks の 2 つだけ
// (3) をこのモジュールで読み、JsValue と同じ判定で包みを外す。出力の側には (3) がない (Map は配列の組、利用者の値は JsValue)
mod marked_map {
    use indexmap::IndexMap;
    use serde::de::{DeserializeOwned, Error};
    use serde::{Deserialize, Deserializer};
    use serde_json::Value;

    const OBJECT_MARK: &str = "$object";

    // 欄が `$object` だけで、値が `[キー, 値]` の組の配列なら包み (JsValue の object_from_pairs と同じ判定)
    fn unwrap_pairs(raw: &IndexMap<String, Value>) -> Option<Vec<(String, Value)>> {
        if raw.len() != 1 {
            return None;
        }
        let Some(Value::Array(pairs)) = raw.get(OBJECT_MARK) else {
            return None;
        };
        pairs
            .iter()
            .map(|pair| match pair.as_array().map(Vec::as_slice) {
                Some([Value::String(key), value]) => Some((key.clone(), value.clone())),
                _ => None,
            })
            .collect()
    }

    /// `Option<IndexMap<String, V>>` の欄 (`#[serde(default, deserialize_with = "marked_map::deserialize")]`)。
    /// 欄がないか null なら None。同じキーが 2 度あれば最初の位置に最後の値を入れる (JS のオブジェクトと同じ)
    pub fn deserialize<'de, V, D>(deserializer: D) -> Result<Option<IndexMap<String, V>>, D::Error>
    where
        V: DeserializeOwned,
        D: Deserializer<'de>,
    {
        let Some(raw) = Option::<IndexMap<String, Value>>::deserialize(deserializer)? else {
            return Ok(None);
        };
        let entries = match unwrap_pairs(&raw) {
            Some(pairs) => pairs,
            None => raw.into_iter().collect(),
        };
        let mut map = IndexMap::with_capacity(entries.len());
        for (key, value) in entries {
            map.insert(key, V::deserialize(value).map_err(D::Error::custom)?);
        }
        Ok(Some(map))
    }
}

// ---- 入力の形 (設計文書 (b) の表の「入力」の欄) ----
// 欄のない Option と null はどちらも None (TS の `x?: T` と `T | null` の両方を受ける)。余分な欄は読み捨てる

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseDocumentInput {
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildModelInput {
    nodes: Vec<OutlineNode>,
    frontmatter: JsValue,
    source: Option<String>,
    #[serde(default, deserialize_with = "marked_map::deserialize")]
    types: Option<IndexMap<String, JsValue>>,
    #[serde(default, deserialize_with = "marked_map::deserialize")]
    hooks: Option<HookSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckFrontmatterInput {
    frontmatter: JsValue,
    source: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderDocumentInput {
    source: String,
    #[serde(default, deserialize_with = "marked_map::deserialize")]
    types: Option<IndexMap<String, JsValue>>,
    #[serde(default, deserialize_with = "marked_map::deserialize")]
    hooks: Option<HookSpec>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderDocumentOutput {
    parsed: ParsedDocument,
    model: GraphModel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutDocumentInput {
    input: LayoutInput,
    groups: Vec<GroupDef>,
    #[serde(with = "markdag_core::model::util::pairs")]
    groups_of: IndexMap<u32, Vec<String>>,
    options: Option<LayoutOptions>,
    max_passes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAndFramesInput {
    input: LayoutInput,
    groups: Vec<GroupDef>,
    #[serde(with = "markdag_core::model::util::pairs")]
    groups_of: IndexMap<u32, Vec<String>>,
    #[serde(with = "markdag_core::model::util::pairs")]
    sibling_order: IndexMap<u32, Vec<u32>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAndFramesOutput {
    graph: VisibleGraph,
    frames: Vec<Frame>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInput {
    input: LayoutInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToggleTaskInput {
    source: String,
    // 原文の型 (number) のまま受ける。整数でない・範囲外・有限でない数の判定は toggle_task に任せる
    #[serde(with = "markdag_core::model::util::js_f64")]
    line: f64,
    cycle: Option<Vec<TaskMark>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextTaskMarkInput {
    mark: TaskMark,
    cycle: Vec<TaskMark>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NextTaskMarkOutput {
    mark: Option<TaskMark>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceLeadingMarkInput {
    html: String,
    state: TaskState,
    icons: Option<TaskIcons>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceLeadingMarkOutput {
    html: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestTagKeysInput {
    tag_keys: Vec<TagKeyDef>,
    prefix: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestTagValuesInput {
    tag_keys: Vec<TagKeyDef>,
    key: String,
    prefix: Option<String>,
}

// runtime は既定のランタイムのコード (core の IIFE)、css はその既定のスタイルシート (包みの defaults)。
// data は素材 (StandaloneData の欄を持つオブジェクト。利用者の値なので JsValue で受け、$object の包みも外れる)。
// options は素材を除いたページの指定 (title、lang、containerClass、css、head、runtime の差し替え)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StandalonePageInput {
    runtime: String,
    css: String,
    data: JsValue,
    options: Option<StandaloneOptions>,
}

// ---- 出す関数 (設計文書 (b) の表の順) ----

export_json!(
    /// 原文を解析してノードの木にする (包みの parseDocument)
    mdag_parse_document,
    ParseDocumentInput,
    |input: ParseDocumentInput| Ok(parse_document(&input.source))
);

export_json!(
    /// ノードの木と frontmatter からグラフのモデルを組み立てる (包みの buildModel)。GraphModel のデータ部分を返す
    mdag_build_model,
    BuildModelInput,
    |input: BuildModelInput| {
        let extra = ModelOptions { types: input.types, hook_refs: input.hooks };
        Ok(build_model(&input.nodes, &input.frontmatter, input.source.as_deref(), &extra))
    }
);

export_json!(
    /// frontmatter の形と型だけを検査する (包みの checkFrontmatter)
    mdag_check_frontmatter,
    CheckFrontmatterInput,
    |input: CheckFrontmatterInput| Ok(check_frontmatter(&input.frontmatter, input.source.as_deref()))
);

export_json!(
    /// parse と build_model を 1 回の呼び出しで行う (render と単体 HTML の原文の経路。N+1 を避ける)
    mdag_render_document,
    RenderDocumentInput,
    |input: RenderDocumentInput| {
        let parsed = parse_document(&input.source);
        let extra = ModelOptions { types: input.types, hook_refs: input.hooks };
        let model = build_model(&parsed.nodes, &parsed.frontmatter, Some(&input.source), &extra);
        Ok(RenderDocumentOutput { parsed, model })
    }
);

export_json!(
    /// 射影、枠、配置の繰り返しを 1 回で行う (view の配置)。LayoutError は error の封筒 (code は layout-error)
    mdag_layout_document,
    LayoutDocumentInput,
    |input: LayoutDocumentInput| {
        Ok(layout_document(&input.input, &input.groups, &input.groups_of, input.options, input.max_passes)?)
    }
);

export_json!(
    /// 射影と枠のまとまりだけを返す (view の layoutOverride の経路。配置の繰り返しは呼ばない)
    mdag_project_and_frames,
    ProjectAndFramesInput,
    |input: ProjectAndFramesInput| {
        let graph = project(&input.input)?;
        let frames = compute_frames(&graph, &input.groups, &input.groups_of, &input.sibling_order);
        Ok(ProjectAndFramesOutput { graph, frames })
    }
);

export_json!(
    /// 折りたたみを反映した射影 (テストと審判)
    mdag_project,
    ProjectInput,
    |input: ProjectInput| Ok(project(&input.input)?)
);

export_json!(
    /// タスクの行を順の次に進める。書き換えた 1 行 `{ line, text }` か、変えないなら null
    mdag_toggle_task,
    ToggleTaskInput,
    |input: ToggleTaskInput| Ok(toggle_task(&input.source, input.line, input.cycle.as_deref()))
);

export_json!(
    /// クリックで次に進む記号。順にない記号なら `{ mark: null }`
    mdag_next_task_mark,
    NextTaskMarkInput,
    |input: NextTaskMarkInput| Ok(NextTaskMarkOutput { mark: next_task_mark(input.mark, &input.cycle) })
);

export_json!(
    /// ノードの内容の先頭の状態の記号を差し替える (単体 HTML の scratch の切り替え)
    mdag_replace_leading_mark,
    ReplaceLeadingMarkInput,
    |input: ReplaceLeadingMarkInput| {
        Ok(ReplaceLeadingMarkOutput { html: replace_leading_mark(&input.html, input.state, input.icons.as_ref()) })
    }
);

export_json!(
    /// タグのキーの候補
    mdag_suggest_tag_keys,
    SuggestTagKeysInput,
    |input: SuggestTagKeysInput| Ok(suggest_tag_keys(&input.tag_keys, input.prefix.as_deref()))
);

export_json!(
    /// タグの値の候補
    mdag_suggest_tag_values,
    SuggestTagValuesInput,
    |input: SuggestTagValuesInput| {
        Ok(suggest_tag_values(&input.tag_keys, &input.key, input.prefix.as_deref()))
    }
);

export_json!(
    /// 単体 HTML のページの文字列を組み立てる (包みの buildStandaloneHtml と CLI の html。A-017)。
    /// 組み立てられないとき (parsed も source もない、埋め込めないランタイム) は standalone-error の封筒
    mdag_standalone_page,
    StandalonePageInput,
    |input: StandalonePageInput| {
        let defaults = StandaloneRuntime { script: input.runtime, style: input.css };
        Ok(render_standalone_page(&input.options.unwrap_or_default(), &input.data, &defaults)?)
    }
);

#[cfg(test)]
mod tests {
    use super::*;
    use markdag_core::types::HookSpecEntry;

    fn render_input(json: &str) -> RenderDocumentInput {
        serde_json::from_str(json).expect("契約の形の入力")
    }

    #[test]
    fn types_と_hooks_は_object_の包みを外して読む() {
        let input = render_input(
            r#"{"source":"","types":{"$object":[["$number",{"a":1}]]},"hooks":{"$object":[["$object",{"kind":"invalid"}]]}}"#,
        );
        let types = input.types.expect("types がある");
        assert_eq!(types.keys().collect::<Vec<_>>(), ["$number"]);
        assert_eq!(
            types["$number"],
            JsValue::Object(IndexMap::from([("a".to_string(), JsValue::Number(1.0))]))
        );
        let hooks = input.hooks.expect("hooks がある");
        assert_eq!(hooks.keys().collect::<Vec<_>>(), ["$object"]);
        assert_eq!(hooks["$object"], HookSpecEntry::Invalid);
    }

    #[test]
    fn 包みでない写像はそのまま読む() {
        // 欄が 2 つなら JS は包まない。$object の値が組の配列でなければ包みとみなさない (JsValue と同じ)
        let input = render_input(r#"{"source":"","types":{"$number":1,"b":2},"hooks":null}"#);
        assert_eq!(
            input
                .types
                .expect("types がある")
                .keys()
                .collect::<Vec<_>>(),
            ["$number", "b"]
        );
        assert!(input.hooks.is_none());
        let input = render_input(r#"{"source":"","types":{"$object":[1]}}"#);
        assert_eq!(
            input
                .types
                .expect("types がある")
                .keys()
                .collect::<Vec<_>>(),
            ["$object"]
        );
        assert!(input.hooks.is_none());
    }

    #[test]
    fn 包みの中の同じキーは最初の位置に最後の値() {
        let input = render_input(r#"{"source":"","types":{"$object":[["a",1],["b",2],["a",3]]}}"#);
        let types = input.types.expect("types がある");
        assert_eq!(types.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(types["a"], JsValue::Number(3.0));
    }

    #[test]
    fn 包みの中の値が型に合わなければ読めない() {
        let result = serde_json::from_str::<RenderDocumentInput>(
            r#"{"source":"","hooks":{"$object":[["$number",{"kind":"x"}]]}}"#,
        );
        assert!(result.is_err());
    }

    #[test]
    fn 誤りの封筒は文面を_json_の文字列として書く() {
        let bytes = error_bytes(&BoundaryError {
            code: "invalid-input",
            message: "\"引用\" と \\".to_string(),
        });
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON");
        assert_eq!(
            value,
            serde_json::json!({ "error": { "code": "invalid-input", "message": "\"引用\" と \\" } })
        );
    }
}
