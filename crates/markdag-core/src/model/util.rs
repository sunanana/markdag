// 原文: src/model/util.ts (2026-09-24)
// JS の癖を写す助け (helper) と、境界の JSON の書き方 (serde の補助) の置き場所。
// 原文の isRecord / editDistance / closest の写しと、規則書 2 章が中身を決める helper (4 章の一覧)、
// JsValue (frontmatter などの利用者の値)、serde の補助モジュール pairs / js_f64 を持つ。各単位は再実装せずここを呼ぶ。
use std::fmt;
use std::hash::Hash;

use indexmap::{IndexMap, IndexSet};
use saphyr_parser::{ScalarStyle, Tag};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::types::PathStep;

/// 有限でない数の印のキー (境界の JSON の `{ "$number": "NaN" }`。規則書 4 章)
const NUMBER_MARK: &str = "$number";

/// 利用者のオブジェクトが印と取り違えられないように包む印のキー (`{ "$object": [[k, v]] }`)。
/// 欄が 1 つだけで、そのキーが `$number`、`$object`、`$undefined` のどれかのオブジェクトを、欄の組の配列にして包む
const OBJECT_MARK: &str = "$object";

/// Undefined の印のキー (`{ "$undefined": true }`。A-197)。旧実装は利用者の値をメモリのまま渡していたので、
/// オブジェクトの undefined の欄も配列の undefined の要素も残っていた。その値を境界の往復で保つ
const UNDEFINED_MARK: &str = "$undefined";

// 欄が 1 つだけで、そのキーが印のキーなら、印と取り違えられる
fn looks_like_mark(key: &str) -> bool {
    key == NUMBER_MARK || key == OBJECT_MARK || key == UNDEFINED_MARK
}

// これより大きい整数値は JS でも f64 のまま書くので、整数として出すのはこの範囲だけにする
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// YAML から来た利用者の値 (frontmatter、types の値)。JS の値の形をそのまま持つ。
/// 境界の JSON では Undefined は `$undefined` の印 (オブジェクトの欄でも配列の要素でも。A-197)、有限でない数は `$number` の印。
/// JSON.stringify と同じ形 (欄を落とす、配列では null) が要る所 (単体 HTML に埋める JSON) は js_json_stringify を使う
#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Null,
    Undefined,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    Object(IndexMap<String, JsValue>),
}

fn non_finite_label(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value > 0.0 {
        "Infinity"
    } else {
        "-Infinity"
    }
}

fn non_finite_from_label(label: &str) -> Option<f64> {
    match label {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}

// JS の JSON.stringify と同じく整数値は小数点なしで書く (serde_json の f64 は `3.0` と書く)。
// 有限でない数は印にする
fn serialize_js_number<S: Serializer>(value: f64, serializer: S) -> Result<S::Ok, S::Error> {
    if !value.is_finite() {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(NUMBER_MARK, non_finite_label(value))?;
        return map.end();
    }
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
        // -0 は JS の JSON.stringify と同じく 0 になる
        return serializer.serialize_i64(value as i64);
    }
    serializer.serialize_f64(value)
}

impl Serialize for JsValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            JsValue::Null => serializer.serialize_unit(),
            JsValue::Undefined => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry(UNDEFINED_MARK, &true)?;
                map.end()
            }
            JsValue::Bool(value) => serializer.serialize_bool(*value),
            JsValue::Number(value) => serialize_js_number(*value, serializer),
            JsValue::String(value) => serializer.serialize_str(value),
            JsValue::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            JsValue::Object(entries) => {
                // Undefined の欄も印で書くので、欄の数に入れる (JS の包みも markUndefined のあとの値で数える)
                let present: Vec<(&String, &JsValue)> = entries.iter().collect();
                if let [(key, value)] = present.as_slice()
                    && looks_like_mark(key)
                {
                    // 欄が 1 つで印のキーに見える利用者のオブジェクトは $object に包む。JS の境界も同じ判定をする (規則 4 章、A-044、A-177)
                    let mut map = serializer.serialize_map(Some(1))?;
                    map.serialize_entry(OBJECT_MARK, &[(key, value)])?;
                    return map.end();
                }
                let mut map = serializer.serialize_map(Some(present.len()))?;
                for (key, value) in present {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

struct JsValueVisitor;

impl<'de> Visitor<'de> for JsValueVisitor {
    type Value = JsValue;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<JsValue, E> {
        Ok(JsValue::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<JsValue, E> {
        Ok(JsValue::Number(value as f64))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<JsValue, E> {
        Ok(JsValue::Number(value as f64))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<JsValue, E> {
        Ok(JsValue::Number(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<JsValue, E> {
        Ok(JsValue::String(value.to_string()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<JsValue, E> {
        Ok(JsValue::String(value))
    }

    fn visit_unit<E: de::Error>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<JsValue, D::Error> {
        JsValue::deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JsValue, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<JsValue>()? {
            items.push(item);
        }
        Ok(JsValue::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JsValue, A::Error> {
        let mut entries = IndexMap::new();
        while let Some((key, value)) = map.next_entry::<String, JsValue>()? {
            entries.insert(key, value);
        }
        // 欄が `$undefined` だけで、値が true なら Undefined に戻す
        if entries.len() == 1 && entries.get(UNDEFINED_MARK) == Some(&JsValue::Bool(true)) {
            return Ok(JsValue::Undefined);
        }
        // 欄が `$number` だけで、値が印の文字なら有限でない数に戻す
        if entries.len() == 1
            && let Some(JsValue::String(label)) = entries.get(NUMBER_MARK)
            && let Some(number) = non_finite_from_label(label)
        {
            return Ok(JsValue::Number(number));
        }
        // 欄が `$object` だけで、値が `[キー, 値]` の組の配列なら、包んだ利用者のオブジェクトに戻す
        if entries.len() == 1
            && let Some(JsValue::Array(pairs)) = entries.get(OBJECT_MARK)
            && let Some(unwrapped) = object_from_pairs(pairs)
        {
            return Ok(unwrapped);
        }
        Ok(JsValue::Object(entries))
    }
}

fn object_from_pairs(pairs: &[JsValue]) -> Option<JsValue> {
    let mut entries = IndexMap::with_capacity(pairs.len());
    for pair in pairs {
        match pair {
            JsValue::Array(items) => match items.as_slice() {
                [JsValue::String(key), value] => {
                    entries.insert(key.clone(), value.clone());
                }
                _ => return None,
            },
            _ => return None,
        }
    }
    Some(JsValue::Object(entries))
}

impl<'de> Deserialize<'de> for JsValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<JsValue, D::Error> {
        deserializer.deserialize_any(JsValueVisitor)
    }
}

/// JS の Map を境界の JSON で配列の組 `[[k, v], ...]` にする (`#[serde(with = "crate::model::util::pairs")]`)。
/// 読むときに同じキーが 2 度あれば、最初の位置に最後の値を入れる (JS の `new Map(entries)` と同じ)
pub mod pairs {
    use super::*;

    pub fn serialize<K, V, S>(map: &IndexMap<K, V>, serializer: S) -> Result<S::Ok, S::Error>
    where
        K: Serialize,
        V: Serialize,
        S: Serializer,
    {
        serializer.collect_seq(map.iter())
    }

    pub fn deserialize<'de, K, V, D>(deserializer: D) -> Result<IndexMap<K, V>, D::Error>
    where
        K: Deserialize<'de> + Hash + Eq,
        V: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        let entries = Vec::<(K, V)>::deserialize(deserializer)?;
        let mut map = IndexMap::with_capacity(entries.len());
        for (key, value) in entries {
            map.insert(key, value);
        }
        Ok(map)
    }

    /// 値が f64 の Map (`IndexMap<K, f64>`)。値は js_f64 と同じく有限でない数を印で書く (A-165)
    pub mod f64_values {
        use super::super::js_f64::Number;
        use super::*;

        pub fn serialize<K, S>(map: &IndexMap<K, f64>, serializer: S) -> Result<S::Ok, S::Error>
        where
            K: Serialize,
            S: Serializer,
        {
            serializer.collect_seq(map.iter().map(|(key, value)| (key, Number(*value))))
        }

        pub fn deserialize<'de, K, D>(deserializer: D) -> Result<IndexMap<K, f64>, D::Error>
        where
            K: Deserialize<'de> + Hash + Eq,
            D: Deserializer<'de>,
        {
            let entries = Vec::<(K, Number)>::deserialize(deserializer)?;
            let mut map = IndexMap::with_capacity(entries.len());
            for (key, Number(value)) in entries {
                map.insert(key, value);
            }
            Ok(map)
        }
    }

    /// 値が f64 の 2 つ組の Map (`IndexMap<K, [f64; 2]>`)。各要素を js_f64 と同じく書く (A-165)
    pub mod f64_pair_values {
        use super::super::js_f64::Number;
        use super::*;

        pub fn serialize<K, S>(
            map: &IndexMap<K, [f64; 2]>,
            serializer: S,
        ) -> Result<S::Ok, S::Error>
        where
            K: Serialize,
            S: Serializer,
        {
            serializer.collect_seq(
                map.iter()
                    .map(|(key, [a, b])| (key, [Number(*a), Number(*b)])),
            )
        }

        pub fn deserialize<'de, K, D>(deserializer: D) -> Result<IndexMap<K, [f64; 2]>, D::Error>
        where
            K: Deserialize<'de> + Hash + Eq,
            D: Deserializer<'de>,
        {
            let entries = Vec::<(K, [Number; 2])>::deserialize(deserializer)?;
            let mut map = IndexMap::with_capacity(entries.len());
            for (key, [Number(a), Number(b)]) in entries {
                map.insert(key, [a, b]);
            }
            Ok(map)
        }
    }
}

/// f64 の欄を境界の JSON に書く (`#[serde(with = "crate::model::util::js_f64")]`)。
/// 有限でない数は `{ "$number": "NaN" | "Infinity" | "-Infinity" }` の印、整数値は小数点なし
pub mod js_f64 {
    use super::*;

    // 数か、有限でない数の印か
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Repr {
        Number(f64),
        Mark {
            #[serde(rename = "$number")]
            label: String,
        },
    }

    fn from_repr<E: de::Error>(repr: Repr) -> Result<f64, E> {
        match repr {
            Repr::Number(value) => Ok(value),
            Repr::Mark { label } => non_finite_from_label(&label)
                .ok_or_else(|| E::custom(format!("unknown $number mark: {label}"))),
        }
    }

    // 入れ物の中の f64 を js_f64 で読み書きするための包み (pair、pairs::f64_values などが使う)
    pub(in crate::model::util) struct Number(pub f64);

    impl Serialize for Number {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serialize_js_number(self.0, serializer)
        }
    }

    impl<'de> Deserialize<'de> for Number {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Number, D::Error> {
            from_repr(Repr::deserialize(deserializer)?).map(Number)
        }
    }

    pub fn serialize<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
        serialize_js_number(*value, serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
        from_repr(Repr::deserialize(deserializer)?)
    }

    /// `Option<f64>` の欄 (`x?: number`) 用。`#[serde(default, skip_serializing_if = "Option::is_none", with = "crate::model::util::js_f64::option")]`
    pub mod option {
        use super::*;

        pub fn serialize<S: Serializer>(
            value: &Option<f64>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            match value {
                Some(value) => serialize_js_number(*value, serializer),
                None => serializer.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<f64>, D::Error> {
            match Option::<Repr>::deserialize(deserializer)? {
                Some(repr) => from_repr(repr).map(Some),
                None => Ok(None),
            }
        }
    }

    /// `[f64; 2]` の欄 (座標の組)。各要素を js_f64 と同じく書く (A-165)
    pub mod pair {
        use super::*;

        pub fn serialize<S: Serializer>(
            value: &[f64; 2],
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            [Number(value[0]), Number(value[1])].serialize(serializer)
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<[f64; 2], D::Error> {
            let [Number(a), Number(b)] = <[Number; 2]>::deserialize(deserializer)?;
            Ok([a, b])
        }
    }

    /// `Option<Vec<[f64; 2]>>` の欄 (中継点の列)。`#[serde(default, skip_serializing_if = "Option::is_none", with = "crate::model::util::js_f64::option_pair_list")]`
    pub mod option_pair_list {
        use super::*;

        pub fn serialize<S: Serializer>(
            value: &Option<Vec<[f64; 2]>>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            match value {
                Some(points) => {
                    serializer.collect_seq(points.iter().map(|[a, b]| [Number(*a), Number(*b)]))
                }
                None => serializer.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<Vec<[f64; 2]>>, D::Error> {
            let points = Option::<Vec<[Number; 2]>>::deserialize(deserializer)?;
            Ok(points.map(|points| {
                points
                    .into_iter()
                    .map(|[Number(a), Number(b)]| [a, b])
                    .collect()
            }))
        }
    }
}

// ---- 原文 util.ts の写し (isRecord、editDistance、closest) ----

/// 原文: isRecord。配列でない object で、null を含まない
// 規則 2.1「isRecord は配列でない object で null を含まない」
// 型の述語の Option の形の例外で bool を返す。中身が要る呼ぶ側は if let JsValue::Object で取り出す (規則 2.1、2.6、A-060)
pub fn is_record(value: &JsValue) -> bool {
    matches!(value, JsValue::Object(_))
}

/// 原文: editDistance。2 つの文字列の編集距離 (コードポイント単位)。
/// 隣り合う 2 文字の入れ替え (chain と chian) も 1 回と数える
// 規則 2.2「closest / editDistance は Vec<char> の上で比べる。UTF-16 ではない」
// 原文の editDistance を名前ごと写す。入れ替えを 1 回と数えるので Levenshtein ではない (規則 4 章、A-059)
pub fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut before_previous: Vec<usize> = Vec::new();
    // 規則 2.3「util.ts:8 の Array.from は (0..=n).collect()」
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut current = vec![i];
        for j in 1..=b.len() {
            let substitution = if a.get(i - 1) == b.get(j - 1) { 0 } else { 1 };
            let mut best = (previous.get(j).copied().unwrap_or(0) + 1)
                .min(current.get(j - 1).copied().unwrap_or(0) + 1)
                .min(previous.get(j - 1).copied().unwrap_or(0) + substitution);
            if i > 1 && j > 1 && a.get(i - 1) == b.get(j - 2) && a.get(i - 2) == b.get(j - 1) {
                best = best.min(before_previous.get(j - 2).copied().unwrap_or(0) + 1);
            }
            // current は j の順に伸びるので、current[j] = best は push と同じ
            current.push(best);
        }
        before_previous = previous;
        previous = current;
    }
    previous.get(b.len()).copied().unwrap_or(0)
}

/// 原文: closest。書き間違いらしい入力に対して、いちばん近い候補を 1 つ返す。離れた候補しかなければ None。
/// 同じ距離の候補が複数あれば、先に現れたものが勝つ
pub fn closest<S: AsRef<str>>(input: &str, candidates: &[S]) -> Option<String> {
    // 規則 2.2「[...s] は chars().collect::<Vec<char>>()」
    let source: Vec<char> = input.chars().collect();
    // 規則 2.1「Math.floor(a / b) は (a as f64 / b as f64).floor()」「Math.max は js_max」
    let limit = if source.len() <= 2 {
        1.0
    } else {
        js_max(1.0, (source.len() as f64 / 3.0).floor())
    };
    let mut best: Option<(&str, usize)> = None;
    // 規則 2.3「Set<T> は IndexSet<T>」(new Set(candidates) の順で回す)
    let unique: IndexSet<&str> = candidates.iter().map(AsRef::as_ref).collect();
    for candidate in unique {
        if candidate == input || candidate.is_empty() {
            continue;
        }
        let score = edit_distance(&source, &candidate.chars().collect::<Vec<char>>());
        if score as f64 <= limit && best.is_none_or(|(_, best_score)| score < best_score) {
            best = Some((candidate, score));
        }
    }
    best.map(|(text, _)| text.to_string())
}

// ---- JS の癖を写す helper (規則書 2 章が中身の仕様。4 章の一覧) ----

/// JS の WhiteSpace と LineTerminator (String.prototype.trim と StringToNumber が落とす文字)。
/// Rust の `char::is_whitespace` は U+FEFF を含まず U+0085 を含むので使わない
// 規則 2.2「js_trim 系 (JS の WhiteSpace + LineTerminator = JS_WHITESPACE)」
pub const JS_WHITESPACE: &[char] = &[
    '\u{0009}', '\u{000A}', '\u{000B}', '\u{000C}', '\u{000D}', '\u{0020}', '\u{00A0}', '\u{1680}',
    '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}',
    '\u{2008}', '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}', '\u{3000}',
    '\u{FEFF}',
];

/// JS の `s.trim()`
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(JS_WHITESPACE)
}

/// JS の `s.trimStart()`
pub fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(JS_WHITESPACE)
}

/// JS の `s.trimEnd()`
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(JS_WHITESPACE)
}

/// JS の `Math.max(a, b)`。NaN が混じれば NaN、+0 と -0 なら +0
// 規則 2.1「js_max / js_min: NaN が混じれば NaN。0 と -0 は JS に合わせる」(A-043)
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() { a } else { b };
    }
    if a >= b { a } else { b }
}

/// JS の `Math.min(a, b)`。NaN が混じれば NaN、+0 と -0 なら -0
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { a } else { b };
    }
    if a <= b { a } else { b }
}

/// JS の `[...new Set(xs)]`。重複を除いて最初の出現の順
// 規則 2.3「[...new Set(xs)] は unique_in_order(xs) (IndexSet を経由)」
pub fn unique_in_order<T: Hash + Eq, I: IntoIterator<Item = T>>(items: I) -> Vec<T> {
    items
        .into_iter()
        .collect::<IndexSet<T>>()
        .into_iter()
        .collect()
}

// 2、8、16 進の数字の並びを f64 にする (最近接の偶数丸め)。数字でない文字か空なら None。
// JS の StringToNumber と parseInt は 2 のべきの基数では数学的な値を丸めるので、桁が多くても u64 に収めない
fn power_of_two_radix_to_f64(digits: &str, radix: u32) -> Option<f64> {
    let width = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        _ => return None,
    };
    if digits.is_empty() {
        return None;
    }
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * width);
    for c in digits.chars() {
        let digit = c.to_digit(radix)?;
        for shift in (0..width).rev() {
            bits.push((digit >> shift) & 1 == 1);
        }
    }
    let Some(first) = bits.iter().position(|&bit| bit) else {
        return Some(0.0);
    };
    bits.drain(..first);
    let mantissa_bits = bits.len().min(53);
    let mut mantissa: u64 = bits
        .iter()
        .take(mantissa_bits)
        .fold(0, |acc, &bit| (acc << 1) | u64::from(bit));
    let round = bits.get(53).copied().unwrap_or(false);
    let sticky = bits.iter().skip(54).any(|&bit| bit);
    if round && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let shift = bits.len() - mantissa_bits;
    Some(mantissa as f64 * 2f64.powf(shift as f64))
}

// JS の StrDecimalLiteral (符号のあとの Infinity か 10 進) に合うか。`_`、`inf`、`nan` は合わない
fn is_js_decimal_literal(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return true;
    }
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (unsigned, None),
    };
    let (integer, fraction) = match mantissa.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (mantissa, None),
    };
    let all_digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = all_digits(integer)
        && fraction.is_none_or(all_digits)
        && (!integer.is_empty() || fraction.is_some_and(|f| !f.is_empty()));
    let exponent_ok = exponent.is_none_or(|e| {
        let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
        !digits.is_empty() && all_digits(digits)
    });
    mantissa_ok && exponent_ok
}

/// JS の `Number(s)` (StringToNumber)。前後の JS_WHITESPACE を落とし、空なら 0。
/// 10 進、`0x` / `0o` / `0b` (符号なしだけ)、`Infinity` を受け、それ以外は NaN
// 規則 2.1「Number(s) は js_number(&str) -> f64。str::parse::<f64> を直接使わない」
pub fn js_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return power_of_two_radix_to_f64(digits, radix).unwrap_or(f64::NAN);
        }
    }
    if !is_js_decimal_literal(trimmed) {
        return f64::NAN;
    }
    match trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed) {
        "Infinity" if trimmed.starts_with('-') => f64::NEG_INFINITY,
        "Infinity" => f64::INFINITY,
        // 形は上で確かめたので、Rust の parse は JS と同じ値を返す (最近接への丸め)
        // TODO(port): Rust 側の不到達 (parse の Err。形は上で確かめた)
        _ => trimmed.parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// JS の `Number(match[i])`。捕まえなかった組 (undefined) は Number(undefined) と同じく NaN
// 規則 2.1「Number(s) は js_number」と「Number(v) の Undefined は NaN (js_to_number)」を、regex の組 (Option<Match>) に当てたもの。
// None は原文の undefined そのもので、Rust の API が作る分岐ではない (2.5 の A-031 に当たらない) ので印を付けない。
// 必ず捕まる組では None は来ないが、来ても原文と同じ NaN になる
pub fn js_number_of_group(group: Option<regex::Match<'_>>) -> f64 {
    group.map_or(f64::NAN, |found| js_number(found.as_str()))
}

/// JS の `new RegExp(pattern, 'u')`。SyntaxError なら None
// 規則 2.4、2.5: 利用者の pattern は regress の with_flags(pattern, "u")、throw は Err。
// regress 0.10 は u フラグで SyntaxError になる「文字クラスの外の \b / \B の直後の量指定子」(`\b+`、`\B*`、`\b{2}`) を通すので、前段で誤りにする
// regress と V8 の差のうち前段で塞げるものはここで塞ぐ (規則 2.4、A-067)
// 前段で塞げない差 (`\p{Script=Unknown}`、修飾子 `(?i:a)`、Unicode の版) は写さない (規則 2.4、A-068)
pub fn js_regexp_u(pattern: &str) -> Option<regress::Regex> {
    if quantified_word_boundary(pattern) {
        return None;
    }
    regress::Regex::with_flags(pattern, "u").ok()
}

// 文字クラスの外で、\b か \B の直後に * + ? { が続くか。u フラグでは { の単独も誤りなので、{ は量指定子かどうかを見ない。
// u フラグ (v でない) の文字クラスの中の [ は字なので入れ子を数えない
fn quantified_word_boundary(pattern: &str) -> bool {
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let Some(escaped) = chars.next() else {
                    return false;
                };
                if !in_class
                    && matches!(escaped, 'b' | 'B')
                    && matches!(chars.peek(), Some('*' | '+' | '?' | '{'))
                {
                    return true;
                }
            }
            '[' => in_class = true,
            ']' => in_class = false,
            _ => {}
        }
    }
    false
}

/// JS の `+v` / `Number(v)` (文字列以外も受ける ToNumber)
// 規則 2.1「+v、Number(v) は js_to_number(&JsValue) -> f64」
pub fn js_to_number(value: &JsValue) -> f64 {
    match value {
        JsValue::Null => 0.0,
        JsValue::Undefined => f64::NAN,
        JsValue::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        JsValue::Number(number) => *number,
        JsValue::String(text) => js_number(text),
        // 配列は String(配列) を数にする ([true] は NaN、[null] と [undefined] は 0、[[7]] は 7) (規則 2.1、A-058)
        JsValue::Array(_) => js_number(&js_to_string(value)),
        JsValue::Object(_) => f64::NAN,
    }
}

// `{:e}` の形 (d.ddde-7) を、桁の並びと指数に分ける
fn split_exponent(formatted: &str) -> Option<(String, i64)> {
    let (mantissa, exponent) = formatted.split_once('e')?;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    Some((digits, exponent.parse().ok()?))
}

// 0 でない有限の数の、往復できる最短の 10 進の桁と、指数 (d.ddd × 10^exponent の exponent)。
// 桁数 k は Rust の `{:e}` (往復できる最短) から取り、桁そのものは k 桁への正確な丸めで取り直す。
// 最短の k 桁の候補が 2 つあるとき、`{:e}` は大きいほうを選ぶことがあるが、ECMA-262 Number::toString は
// 値に近いほう (等距離なら偶数) を選ぶ (2^50 + 0.25 は "1125899906842624.2"。規則 2.1 への追記は A-066)
fn shortest_digits(value: f64) -> Option<(String, i64)> {
    let (shortest, _) = split_exponent(&format!("{:e}", value.abs()))?;
    let precision = shortest.len().saturating_sub(1);
    split_exponent(&format!("{:.*e}", precision, value.abs()))
}

/// JS の Number::toString (`${n}`、`String(n)`)。
/// 絶対値が 1e-6 未満か 1e21 以上なら指数形 (`1e+21`、`5e-7`)、-0 は "0"
// 規則 2.1「数の文字列化は js_number_to_string(f64) -> String (JS の Number::toString)」
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let Some((digits, exponent)) = shortest_digits(value) else {
        // TODO(port): Rust 側の不到達 (`{:e}` は常に e と指数を書く)
        return format!("{value}");
    };
    // ECMA-262 Number::toString の k (桁数) と n (小数点の位置)
    let k = digits.len() as i64;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let integer: String = digits.chars().take(n as usize).collect();
        let fraction: String = digits.chars().skip(n as usize).collect();
        format!("{integer}.{fraction}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let exponent_sign = if n - 1 < 0 { '-' } else { '+' };
        let first: String = digits.chars().take(1).collect();
        let rest: String = digits.chars().skip(1).collect();
        let fraction = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        format!("{first}{fraction}e{exponent_sign}{}", (n - 1).abs())
    };
    format!("{sign}{body}")
}

/// JS の `String(v)` と `${v}`
// 規則 2.1「String(v) と ${v} は js_to_string(&JsValue) -> String」
pub fn js_to_string(value: &JsValue) -> String {
    match value {
        JsValue::Null => "null".to_string(),
        JsValue::Undefined => "undefined".to_string(),
        JsValue::Bool(flag) => flag.to_string(),
        JsValue::Number(number) => js_number_to_string(*number),
        JsValue::String(text) => text.clone(),
        JsValue::Array(items) => js_array_join(items, ","),
        JsValue::Object(_) => "[object Object]".to_string(),
    }
}

// 配列の添字の形のキー (`0` か、先頭が 0 でない 10 進の数字だけで 2^32 - 2 以下)。JS はこのキーを数の昇順に先頭へ並べる
fn array_index_of(key: &str) -> Option<u64> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|index| *index <= 4_294_967_294)
}

fn write_json_string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_json(value: &JsValue, out: &mut String) {
    match value {
        JsValue::Null | JsValue::Undefined => out.push_str("null"),
        JsValue::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        JsValue::Number(number) if number.is_finite() => {
            out.push_str(&js_number_to_string(*number))
        }
        JsValue::Number(_) => out.push_str("null"),
        JsValue::String(text) => write_json_string(text, out),
        JsValue::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        JsValue::Object(entries) => {
            let mut indexed: Vec<(u64, &String, &JsValue)> = Vec::new();
            let mut named: Vec<(&String, &JsValue)> = Vec::new();
            for (key, item) in entries {
                match array_index_of(key) {
                    Some(index) => indexed.push((index, key, item)),
                    None => named.push((key, item)),
                }
            }
            indexed.sort_by(|a, b| a.0.cmp(&b.0));
            out.push('{');
            let mut first = true;
            let ordered = indexed
                .into_iter()
                .map(|(_, key, item)| (key, item))
                .chain(named);
            for (key, item) in ordered {
                if *item == JsValue::Undefined {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                write_json_string(key, out);
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// JS の `JSON.stringify(v)` (空白なし)。キーは JS の順 (配列の添字の形のキーを数の昇順に先頭へ、残りは書いた順)。
/// 有限でない数は "null"、Undefined の欄は落とし、配列の中では "null"
// 規則 2.1「JSON.stringify(v) は js_json_stringify(&JsValue) -> String。キーは JS の順。serde_json::to_string を使わない」(A-026)
pub fn js_json_stringify(value: &JsValue) -> String {
    if *value == JsValue::Undefined {
        // 最上位の undefined は、呼ぶ側 (asText の `?? String(value)`、uniqueItems の `item ?? null`) の結果と同じになる "undefined" を返す (規則 2.1、A-064)
        return "undefined".to_string();
    }
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

/// SourcePath の `path.join('.')`
// 規則 4 章「js_path_join (SourcePath の join('.'))」。PathStep は From<&PathStep> for JsValue を経て js_to_string (A-030)
pub fn js_path_join(path: &[PathStep]) -> String {
    path.iter()
        .map(|step| js_to_string(&JsValue::from(step)))
        .collect::<Vec<String>>()
        .join(".")
}

/// JS の `s.slice(a, b)` (a と b は非負のバイト添字)。長さで切り詰め、a > b なら空
// 規則 2.2「s.slice(a, b) は &s[a.min(len)..b.max(a).min(len)]」(A-032)
pub fn js_slice(text: &str, start: usize, end: usize) -> &str {
    let len = text.len();
    // TODO(port): Rust 側の不到達 (添字が文字の境界でない。規則 2.2 は呼ぶ側がバイト添字を文字の境界で渡す前提。写し先の書き換えは A-065)
    text.get(start.min(len)..end.max(start).min(len))
        .unwrap_or_default()
}

/// JS の `Object.keys(v)` (frontmatter の値に対して)。オブジェクトは書かれた順のキー、
/// 文字列は UTF-16 の添字、配列は添字、それ以外は空
// 規則 2.1「Object.keys(obj) は JsValue の Object ならキーの一覧。文字列なら文字の添字、配列なら添字、それ以外は空」
// 規則 2.3「Object.keys (YAML から来たオブジェクト) は書かれた順。整数に見えるキーを先頭へ並べる癖は写さない」(決定 8)
// 規則 2.2「文字列の Object.keys は UTF-16 の添字を返す」(A-032)
pub fn js_object_keys(value: &JsValue) -> Vec<String> {
    match value {
        JsValue::Object(entries) => entries.keys().cloned().collect(),
        JsValue::String(text) => (0..text.encode_utf16().count())
            .map(|index| index.to_string())
            .collect(),
        JsValue::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// usize から u32 への変換 (ノードの id、行、桁、長さ)。u32 に収まらなければ u32::MAX に張り付ける
// 規則 2.1「usize から u32 への変換は to_u32」。呼ぶ側に印を付けない (A-136)
pub fn to_u32(value: usize) -> u32 {
    // TODO(port): Rust 側の不到達 (文書は 4 GiB に届かないので、行、桁、長さ、id は u32 に収まる。A-031)
    u32::try_from(value).unwrap_or(u32::MAX)
}

// ---- 日時 (Date.UTC と getUTC*) ----

const MS_PER_DAY: f64 = 86_400_000.0;

// ECMA-262 の ToIntegerOrInfinity (NaN は 0、-0 は +0)
fn to_integer_or_infinity(value: f64) -> f64 {
    if value.is_nan() {
        return 0.0;
    }
    let truncated = value.trunc();
    if truncated == 0.0 { 0.0 } else { truncated }
}

fn is_leap_year(year: f64) -> bool {
    (year % 4.0 == 0.0 && year % 100.0 != 0.0) || year % 400.0 == 0.0
}

// ECMA-262 の DayFromYear (先発グレゴリオ暦。1970 年 1 月 1 日からの日数)
fn day_from_year(year: f64) -> f64 {
    365.0 * (year - 1970.0) + ((year - 1969.0) / 4.0).floor() - ((year - 1901.0) / 100.0).floor()
        + ((year - 1601.0) / 400.0).floor()
}

// 平年の月 (0 始まり、0〜11) の 1 日の、年の始めからの日数 (0, 31, 59, 90, …, 334)。
// 3 月始まりの月の長さ (31, 30, 31, 30, 31 の繰り返し) の式で数える
fn month_start_day(month_in_year: f64) -> f64 {
    if month_in_year >= 2.0 {
        ((153.0 * (month_in_year - 2.0) + 2.0) / 5.0).floor() + 59.0
    } else {
        31.0 * month_in_year
    }
}

// V8 の MakeDay が受ける年と月の範囲 (ToIntegerOrInfinity のあと)。越えると日で打ち消されても NaN
const MAX_ABS_YEAR: f64 = 1_000_000.0;
const MAX_ABS_MONTH: f64 = 10_000_000.0;

// ECMA-262 の MakeDay。月と日の繰り上がり (月 12 は翌年の 1 月、日 0 は前月の末日) を含む
fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !year.is_finite() || !month.is_finite() || !date.is_finite() {
        return f64::NAN;
    }
    let (year, month, date) = (
        to_integer_or_infinity(year),
        to_integer_or_infinity(month),
        to_integer_or_infinity(date),
    );
    // 仕様は「作れなければ NaN」で範囲を決めていない。V8 (node v22) の範囲を写す
    if year.abs() > MAX_ABS_YEAR || month.abs() > MAX_ABS_MONTH {
        return f64::NAN;
    }
    let full_year = year + (month / 12.0).floor();
    if !full_year.is_finite() {
        return f64::NAN;
    }
    let month_in_year = month - 12.0 * (month / 12.0).floor();
    let month_start = month_start_day(month_in_year);
    let leap = if is_leap_year(full_year) && month_in_year >= 2.0 {
        1.0
    } else {
        0.0
    };
    day_from_year(full_year) + month_start + leap + date - 1.0
}

// ECMA-262 の MakeTime (ミリ秒は 0)
fn make_time(hour: f64, minute: f64, second: f64) -> f64 {
    if !hour.is_finite() || !minute.is_finite() || !second.is_finite() {
        return f64::NAN;
    }
    to_integer_or_infinity(hour) * 3_600_000.0
        + to_integer_or_infinity(minute) * 60_000.0
        + to_integer_or_infinity(second) * 1000.0
}

/// JS の `Date.UTC(y, m0, d, h, mi, s)` (ミリ秒)。0 ≤ y ≤ 99 は 1900 + y (MakeFullYear)、
/// 月と日は繰り上がり、先発グレゴリオ暦。±8.64e15 を越えるか有限でない入力は NaN。
/// 年が ±1000000、月が ±10000000 を越えても NaN (V8 の MakeDay の範囲)
// 規則 2.8「Date.UTC は js_date_utc(y, m0, d, h, mi, s) -> f64 (ミリ秒)」
// 日と時が打ち消し合う極端な値 (Date.UTC(1970, 0, -1e20, 2.4e21, 0, 0) は V8 で 26843545600、仕様の式では 0) は写さない。原文の日付の形 (年 4 桁、月日時分秒 2 桁) から届かない (規則 2.8、A-063 (3))
pub fn js_date_utc(year: f64, month: f64, date: f64, hour: f64, minute: f64, second: f64) -> f64 {
    if year.is_nan() {
        return f64::NAN;
    }
    let truncated = to_integer_or_infinity(year);
    let full_year = if (0.0..=99.0).contains(&truncated) {
        1900.0 + truncated
    } else {
        year
    };
    let time = make_day(full_year, month, date) * MS_PER_DAY + make_time(hour, minute, second);
    // TimeClip
    if !time.is_finite() || time.abs() > 8.64e15 {
        return f64::NAN;
    }
    to_integer_or_infinity(time)
}

/// JS の `getUTCFullYear()`、`getUTCMonth()` (0 始まり)、`getUTCDate()` の組。
/// 時刻が NaN か TimeClip の範囲 (±8.64e15) の外なら None (JS の Date は Invalid Date で NaN)
// 規則 2.8「getUTCFullYear / getUTCMonth / getUTCDate はミリ秒から先発グレゴリオ暦の年月日を出す helper」
pub fn js_date_parts(time: f64) -> Option<(i64, u32, u32)> {
    if !time.is_finite() || time.abs() > 8.64e15 {
        return None;
    }
    let days = (time / MS_PER_DAY).floor() as i64;
    // 1970-01-01 からの日数を年月日にする (0000-03-01 起点の 400 年周期で数える)
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_month = (5 * day_of_year + 2) / 153;
    let date = (day_of_year - (153 * march_month + 2) / 5 + 1) as u32;
    let month0 = if march_month < 10 {
        march_month + 2
    } else {
        march_month - 10
    } as u32;
    let year = year_of_era + era * 400 + if month0 <= 1 { 1 } else { 0 };
    Some((year, month0, date))
}

// ---- YAML のスカラの解決 (eemeli/yaml の core schema) ----

fn all_ascii_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

// /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/ (floatExp) と /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/ (float)
fn is_yaml_float(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (unsigned, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some(("", fraction)) => all_ascii_digits(fraction),
        Some((integer, fraction)) => {
            all_ascii_digits(integer) && fraction.bytes().all(|b| b.is_ascii_digit())
        }
        // 小数点のない仮数は指数があるときだけ (floatExp)
        None => exponent.is_some() && all_ascii_digits(mantissa),
    };
    let exponent_ok =
        exponent.is_none_or(|e| all_ascii_digits(e.strip_prefix(['+', '-']).unwrap_or(e)));
    mantissa_ok && exponent_ok
}

/// YAML のスカラを eemeli/yaml の core schema で値にする。引用符つき (quoted) は常に文字列。
/// null / bool / int (10 進、0o、0x) / float (.inf、.nan、小数、指数) の順に試し、どれでもなければ文字列
// 規則 2.3「YAML のスカラの解決は util.rs の yaml_core_scalar で、eemeli/yaml の core schema の正規表現どおりに解決する」
pub fn yaml_core_scalar(text: &str, quoted: bool) -> JsValue {
    if quoted {
        return JsValue::String(text.to_string());
    }
    match text {
        // /^(?:~|[Nn]ull|NULL)?$/
        "" | "~" | "null" | "Null" | "NULL" => return JsValue::Null,
        // /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/
        "true" | "True" | "TRUE" => return JsValue::Bool(true),
        "false" | "False" | "FALSE" => return JsValue::Bool(false),
        // /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => {
            return JsValue::Number(f64::INFINITY);
        }
        "-.inf" | "-.Inf" | "-.INF" => return JsValue::Number(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => return JsValue::Number(f64::NAN),
        _ => {}
    }
    // /^0o[0-7]+$/ と /^0x[0-9a-fA-F]+$/ (parseInt(str.substring(2), radix))
    for (prefix, radix) in [("0o", 8), ("0x", 16)] {
        if let Some(digits) = text.strip_prefix(prefix)
            && let Some(number) = power_of_two_radix_to_f64(digits, radix)
        {
            return JsValue::Number(number);
        }
    }
    // /^[-+]?[0-9]+$/ (parseInt(str, 10)。"-0" は -0) と float / floatExp (parseFloat)
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if all_ascii_digits(unsigned) || is_yaml_float(text) {
        // 形は上で確かめたので、Rust の parse は parseInt / parseFloat と同じ値を返す
        // TODO(port): Rust 側の不到達 (parse の Err で文字列に落ちる。形は上で確かめた)
        if let Ok(number) = text.parse::<f64>() {
            return JsValue::Number(number);
        }
    }
    JsValue::String(text.to_string())
}

// スカラの値。eemeli/yaml の composeScalar と同じく、タグがあればタグで解決する: core の !!null / !!bool / !!int / !!float は
// 書き方がそのタグの形 (core schema の test) に合うときだけその値、合わなければ文字 (Unresolved tag は警告で doc.errors に積まれない)。
// ほかのタグ (!!str、!x、!) は文字。タグがなければ書き方で解決する (引用つきと折り返しは文字)
pub(crate) fn scalar_value(text: &str, style: ScalarStyle, tag: Option<&Tag>) -> JsValue {
    let Some(tag) = tag else {
        return yaml_core_scalar(text, !matches!(style, ScalarStyle::Plain));
    };
    let resolved = yaml_core_scalar(text, false);
    let suffix = if tag.is_yaml_core_schema() {
        tag.suffix.as_str()
    } else {
        ""
    };
    let fits = match (suffix, &resolved) {
        ("null", JsValue::Null) | ("bool", JsValue::Bool(_)) => true,
        ("int", JsValue::Number(_)) => is_core_int(text),
        ("float", JsValue::Number(_)) => !is_core_int(text),
        _ => false,
    };
    if fits {
        resolved
    } else {
        yaml_core_scalar(text, true)
    }
}

// core schema の int の形 (/^[-+]?[0-9]+$/、/^0o[0-7]+$/、/^0x[0-9a-fA-F]+$/)。yaml_core_scalar が数にした書き方だけを受ける
fn is_core_int(text: &str) -> bool {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    text.starts_with("0o") || text.starts_with("0x") || unsigned.chars().all(|c| c.is_ascii_digit())
}

/// JS の `a === b` を YAML のスカラの値 (JsValue) に当てる。数は f64 の == (NaN は等しくない、0 と -0 は等しい)、
/// 型が違えば等しくない (`1` と `"1"`)。配列とオブジェクトは同一性なので、値の写しの上では常に等しくない
// eemeli/yaml の mapIncludes (util-map-includes.js の `a.value === b.value`) の写し (A-085)
pub fn js_strict_equals(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Null, JsValue::Null) | (JsValue::Undefined, JsValue::Undefined) => true,
        (JsValue::Bool(a), JsValue::Bool(b)) => a == b,
        (JsValue::Number(a), JsValue::Number(b)) => a == b,
        (JsValue::String(a), JsValue::String(b)) => a == b,
        _ => false,
    }
}

/// JS の `Array.prototype.join(separator)`。null と undefined の要素は ""、それ以外は js_to_string
// 規則 2.1 の配列の行 (String(配列) は join(',')) を区切りを選べる形にしたもの (A-089)
pub fn js_array_join(items: &[JsValue], separator: &str) -> String {
    items
        .iter()
        .map(|item| match item {
            JsValue::Null | JsValue::Undefined => String::new(),
            other => js_to_string(other),
        })
        .collect::<Vec<String>>()
        .join(separator)
}

/// JS の SameValueZero (`includes` の等しさ)。`===` と同じで、NaN だけは NaN に等しい
// 規則 2.1 (A-033): includes は SameValueZero (A-089)
pub fn js_same_value_zero(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Number(a), JsValue::Number(b)) if a.is_nan() && b.is_nan() => true,
        _ => js_strict_equals(a, b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Holder {
        #[serde(with = "js_f64")]
        value: f64,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "js_f64::option"
        )]
        optional: Option<f64>,
        #[serde(with = "pairs")]
        map: IndexMap<u32, Vec<String>>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    struct NumberContainers {
        #[serde(with = "js_f64::pair")]
        pair: [f64; 2],
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "js_f64::option_pair_list"
        )]
        points: Option<Vec<[f64; 2]>>,
        #[serde(with = "pairs::f64_values")]
        values: IndexMap<u32, f64>,
        #[serde(with = "pairs::f64_pair_values")]
        pair_values: IndexMap<u32, [f64; 2]>,
    }

    fn same_bits(a: f64, b: f64) -> bool {
        (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
    }

    #[test]
    fn number_containers_mark_non_finite_numbers_and_read_them_back() {
        let holder = NumberContainers {
            pair: [f64::INFINITY, 1.5],
            points: Some(vec![[f64::NAN, 2.0], [0.25, f64::NEG_INFINITY]]),
            values: [(1, f64::NAN), (2, 3.0)].into_iter().collect(),
            pair_values: [(1, [20.0, f64::INFINITY]), (2, [f64::NEG_INFINITY, 0.5])]
                .into_iter()
                .collect(),
        };
        let json = serde_json::to_value(&holder).expect("serialize");
        assert_eq!(
            json,
            json!({
                "pair": [{ "$number": "Infinity" }, 1.5],
                "points": [[{ "$number": "NaN" }, 2], [0.25, { "$number": "-Infinity" }]],
                "values": [[1, { "$number": "NaN" }], [2, 3]],
                "pair_values": [[1, [20, { "$number": "Infinity" }]], [2, [{ "$number": "-Infinity" }, 0.5]]]
            })
        );
        let back: NumberContainers = serde_json::from_value(json).expect("deserialize");
        let flat = |h: &NumberContainers| -> Vec<f64> {
            let mut all = h.pair.to_vec();
            all.extend(h.points.iter().flatten().flatten());
            all.extend(h.values.values());
            all.extend(h.pair_values.values().flatten());
            all
        };
        let (expected, actual) = (flat(&holder), flat(&back));
        assert_eq!(expected.len(), actual.len());
        assert!(expected.iter().zip(&actual).all(|(a, b)| same_bits(*a, *b)));
        assert_eq!(back.values.keys().copied().collect::<Vec<_>>(), vec![1, 2]);

        let without_points: NumberContainers =
            serde_json::from_value(json!({ "pair": [0, 0], "values": [], "pair_values": [] }))
                .expect("deserialize");
        assert!(without_points.points.is_none());
        assert!(
            !serde_json::to_string(&without_points)
                .expect("serialize")
                .contains("points")
        );
    }

    #[test]
    fn js_value_marks_non_finite_numbers() {
        let value = JsValue::Array(vec![
            JsValue::Number(f64::INFINITY),
            JsValue::Number(f64::NEG_INFINITY),
            JsValue::Number(3.0),
            JsValue::Number(0.5),
        ]);
        let json = serde_json::to_value(&value).expect("serialize");
        assert_eq!(
            json,
            json!([{ "$number": "Infinity" }, { "$number": "-Infinity" }, 3, 0.5])
        );
        let back: JsValue = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, value);
        let nan: JsValue =
            serde_json::from_value(json!({ "$number": "NaN" })).expect("deserialize");
        assert!(matches!(nan, JsValue::Number(n) if n.is_nan()));
    }

    // A-197: 境界の JSON では Undefined を印で書き、欄と要素を残す (JSON.stringify と同じ形は js_json_stringify が受け持つ)
    #[test]
    fn js_value_marks_undefined_in_objects_and_arrays() {
        let mut entries = IndexMap::new();
        entries.insert("a".to_string(), JsValue::Undefined);
        entries.insert(
            "b".to_string(),
            JsValue::Array(vec![JsValue::Undefined, JsValue::Null]),
        );
        let value = JsValue::Object(entries);
        let json = serde_json::to_string(&value).expect("serialize");
        assert_eq!(
            json,
            r#"{"a":{"$undefined":true},"b":[{"$undefined":true},null]}"#
        );
        let back: JsValue = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, value);
        assert_eq!(js_json_stringify(&value), r#"{"b":[null,null]}"#);
        assert_eq!(
            serde_json::to_string(&JsValue::Undefined).expect("serialize"),
            r#"{"$undefined":true}"#
        );
    }

    #[test]
    fn js_value_reads_only_the_exact_undefined_mark() {
        let value: JsValue =
            serde_json::from_value(json!({ "$undefined": true })).expect("deserialize");
        assert_eq!(value, JsValue::Undefined);
        for other in [
            json!({ "$undefined": false }),
            json!({ "$undefined": 1 }),
            json!({ "$undefined": true, "b": 1 }),
        ] {
            let value: JsValue = serde_json::from_value(other.clone()).expect("deserialize");
            assert!(matches!(value, JsValue::Object(_)), "{other}");
        }
    }

    #[test]
    fn js_value_wraps_user_objects_named_like_the_undefined_mark() {
        let user = object(vec![("$undefined", JsValue::Bool(true))]);
        let json = serde_json::to_value(&user).expect("serialize");
        assert_eq!(json, json!({ "$object": [["$undefined", true]] }));
        let back: JsValue = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, user);

        let holding_undefined = object(vec![("$undefined", JsValue::Undefined)]);
        let json = serde_json::to_value(&holding_undefined).expect("serialize");
        assert_eq!(
            json,
            json!({ "$object": [["$undefined", { "$undefined": true }]] })
        );
        let back: JsValue = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, holding_undefined);
    }

    #[test]
    fn js_value_keeps_objects_that_only_look_like_marks() {
        let value: JsValue =
            serde_json::from_value(json!({ "$number": "1" })).expect("deserialize");
        assert!(matches!(value, JsValue::Object(_)));
    }

    fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
        JsValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    #[test]
    fn js_value_wraps_user_objects_that_collide_with_marks() {
        let user = object(vec![("$number", JsValue::String("NaN".to_string()))]);
        let json = serde_json::to_value(&user).expect("serialize");
        assert_eq!(json, json!({ "$object": [["$number", "NaN"]] }));
        let back: JsValue = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, user);

        let nested = object(vec![(
            "$object",
            object(vec![("$number", JsValue::Number(f64::INFINITY))]),
        )]);
        let json = serde_json::to_value(&nested).expect("serialize");
        assert_eq!(
            json,
            json!({ "$object": [["$object", { "$object": [["$number", { "$number": "Infinity" }]] }]] })
        );
        let back: JsValue = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, nested);

        // 欄が 2 つあれば印と取り違えないので包まない。Undefined の欄も印で書くので数に入る (A-197)
        let two = object(vec![
            ("$number", JsValue::String("NaN".to_string())),
            ("b", JsValue::Bool(true)),
        ]);
        assert_eq!(
            serde_json::to_value(&two).expect("serialize"),
            json!({ "$number": "NaN", "b": true })
        );
        let with_undefined = object(vec![
            ("$number", JsValue::String("NaN".to_string())),
            ("b", JsValue::Undefined),
        ]);
        let json = serde_json::to_value(&with_undefined).expect("serialize");
        assert_eq!(
            json,
            json!({ "$number": "NaN", "b": { "$undefined": true } })
        );
        let back: JsValue = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back, with_undefined);
    }

    #[test]
    fn js_value_writes_negative_zero_as_zero() {
        assert_eq!(
            serde_json::to_string(&JsValue::Number(-0.0)).expect("serialize"),
            "0"
        );
        let holder = Holder {
            value: -0.0,
            optional: Some(-0.0),
            map: IndexMap::new(),
        };
        assert_eq!(
            serde_json::to_value(&holder).expect("serialize"),
            json!({ "value": 0, "optional": 0, "map": [] })
        );
    }

    #[test]
    fn serde_helpers_round_trip() {
        let mut map = IndexMap::new();
        map.insert(7, vec!["x".to_string()]);
        map.insert(1, vec![]);
        let holder = Holder {
            value: f64::NEG_INFINITY,
            optional: Some(f64::NAN),
            map,
        };
        let json = serde_json::to_value(&holder).expect("serialize");
        assert_eq!(
            json,
            json!({ "value": { "$number": "-Infinity" }, "optional": { "$number": "NaN" }, "map": [[7, ["x"]], [1, []]] })
        );
        let back: Holder = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back.value, f64::NEG_INFINITY);
        assert!(back.optional.is_some_and(f64::is_nan));
        assert_eq!(back.map.keys().copied().collect::<Vec<_>>(), vec![7, 1]);
        let missing: Holder =
            serde_json::from_value(json!({ "value": 2, "map": [[1, ["a"]], [1, ["b"]]] }))
                .expect("deserialize");
        assert_eq!(missing.optional, None);
        assert_eq!(missing.map.get(&1), Some(&vec!["b".to_string()]));
    }

    // ---- 原文 util.ts の写し。期待値は node --experimental-strip-types で原文の util.ts を呼んだ結果 ----

    // (入力、候補、closest の結果、各候補への editDistance)
    type ClosestCase = (
        &'static str,
        &'static [&'static str],
        Option<&'static str>,
        &'static [usize],
    );
    // (Date.UTC の引数、ミリ秒、getUTCFullYear / Month / Date)
    type DateCase = ([f64; 6], f64, Option<(i64, u32, u32)>);

    fn chars(text: &str) -> Vec<char> {
        text.chars().collect()
    }

    #[test]
    fn util_is_record_matches_only_objects() {
        assert!(is_record(&JsValue::Object(IndexMap::new())));
        assert!(!is_record(&JsValue::Null));
        assert!(!is_record(&JsValue::Array(vec![])));
        assert!(!is_record(&JsValue::String("x".to_string())));
        assert!(!is_record(&JsValue::Undefined));
    }

    #[test]
    fn util_closest_boundaries_match_the_original() {
        let table: &[ClosestCase] = &[
            // 長さ 1 と 2: 上限は 1
            ("a", &["b"], Some("b"), &[1]),
            ("a", &["bc"], None, &[2]),
            ("ab", &["ba"], Some("ba"), &[1]),
            ("ab", &["abc"], Some("abc"), &[1]),
            ("ab", &["xy"], None, &[2]),
            // 長さ 3: floor(3 / 3) = 1
            ("abc", &["abd"], Some("abd"), &[1]),
            ("abc", &["xyc"], None, &[2]),
            ("abc", &["bac"], Some("bac"), &[1]),
            // 長さ 5: floor(5 / 3) = 1。入れ替えは 1 回
            ("chain", &["chian"], Some("chian"), &[1]),
            ("chain", &["chan"], Some("chan"), &[1]),
            ("chain", &["chn"], None, &[2]),
            ("chain", &["hcian"], None, &[2]),
            // 長さ 6: 上限 2 (ちょうどと 1 つ超え)
            ("groups", &["gorups"], Some("gorups"), &[1]),
            ("groups", &["grxxps"], Some("grxxps"), &[2]),
            ("groups", &["gxxxps"], None, &[3]),
            // 長さ 9: 上限 3
            ("highlight", &["hixxxight"], Some("hixxxight"), &[3]),
            ("highlight", &["hixxxxght"], None, &[4]),
            ("highlight", &["ihgxlihgt"], Some("ihgxlihgt"), &[3]),
            // 同点は先勝ち、近いものが後にあればそれ、入力と同じ語と空は飛ばす、重複は 1 つ
            ("cat", &["bat", "cot"], Some("bat"), &[1, 1]),
            ("cat", &["cot", "bat"], Some("cot"), &[1, 1]),
            ("cat", &["cxx", "bat"], Some("bat"), &[2, 1]),
            ("cat", &["cat", ""], None, &[0, 3]),
            ("cat", &["bat", "bat", "cab"], Some("bat"), &[1, 1, 1]),
            // コードポイントで数える (UTF-16 なら長さ 6 の絵文字の列は上限 4 になる)
            ("😀", &["😁"], Some("😁"), &[1]),
            ("😀a", &["😀b"], Some("😀b"), &[1]),
            ("😀😀😀😀😀😀", &["😀😀😀😀xy"], Some("😀😀😀😀xy"), &[2]),
            ("😀😀😀😀😀😀", &["😀😀😀xyz"], None, &[3]),
            ("", &["a"], Some("a"), &[1]),
            ("", &["ab"], None, &[2]),
        ];
        for (input, candidates, expected, distances) in table {
            assert_eq!(
                closest(input, candidates).as_deref(),
                *expected,
                "closest({input:?}, {candidates:?})"
            );
            let actual: Vec<usize> = candidates
                .iter()
                .map(|c| edit_distance(&chars(input), &chars(c)))
                .collect();
            assert_eq!(
                &actual, distances,
                "editDistance({input:?}, {candidates:?})"
            );
        }
    }

    // ---- helper。期待値は node v22 の実物の値 (Number、String、JSON.stringify、Date.UTC、Math.max、yaml の parse) ----

    fn same_number(actual: f64, expected: f64) -> bool {
        (actual.is_nan() && expected.is_nan())
            || (actual == expected && actual.is_sign_negative() == expected.is_sign_negative())
    }

    #[test]
    fn util_js_number_matches_node() {
        let table: &[(&str, f64)] = &[
            ("", 0.0),
            ("  ", 0.0),
            (" 42 ", 42.0),
            ("\u{FEFF}7\u{3000}", 7.0),
            ("\u{2028}\n5\t", 5.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("1e3", 1000.0),
            ("-1.5e-3", -0.0015),
            ("0x1F", 31.0),
            ("0X1f", 31.0),
            ("0o17", 15.0),
            ("0b101", 5.0),
            ("-0x10", f64::NAN),
            ("+0x10", f64::NAN),
            ("0x", f64::NAN),
            ("0b", f64::NAN),
            ("0o8", f64::NAN),
            ("Infinity", f64::INFINITY),
            ("+Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("inf", f64::NAN),
            ("nan", f64::NAN),
            ("infinity", f64::NAN),
            ("1_0", f64::NAN),
            ("007", 7.0),
            ("-0", -0.0),
            ("1e400", f64::INFINITY),
            ("\u{0085}1", f64::NAN),
            ("0x1FFFFFFFFFFFFF1", 144_115_188_075_855_860.0),
            ("0x20000000000001", 9_007_199_254_740_992.0),
            ("0x20000000000003", 9_007_199_254_740_996.0),
            ("12abc", f64::NAN),
            (".", f64::NAN),
            ("e5", f64::NAN),
            ("+.5", 0.5),
            ("1.e2", 100.0),
        ];
        for (text, expected) in table {
            assert!(
                same_number(js_number(text), *expected),
                "Number({text:?}) = {}",
                js_number(text)
            );
        }
    }

    #[test]
    fn util_js_number_to_string_matches_node() {
        let table: &[(f64, &str)] = &[
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (5e-7, "5e-7"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (-0.0, "0"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123.456, "123.456"),
            (-1.5e-10, "-1.5e-10"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1.5e300, "1.5e+300"),
            (0.000_001_234, "0.000001234"),
            (100.0, "100"),
            (9_007_199_254_740_992.0, "9007199254740992"),
            (1.5e21, "1.5e+21"),
            (-1234.5e-9, "-0.0000012345"),
            // 最短の桁の候補が 2 つで等距離なら偶数、近いほうがあればそちら (node の String の値)
            (1_125_899_906_842_624.0 + 0.25, "1125899906842624.2"),
            (1_860_160_425_084_840.0 + 0.25, "1860160425084840.2"),
            (-(22_055_010_346_499.0 + 0.0625), "-22055010346499.062"),
            (118_720_471_666_715.0 + 0.625, "118720471666715.62"),
        ];
        for (number, expected) in table {
            assert_eq!(
                js_number_to_string(*number),
                *expected,
                "String({number:e})"
            );
        }
    }

    fn js_object(entries: &[(&str, JsValue)]) -> JsValue {
        JsValue::Object(
            entries
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect(),
        )
    }

    fn num(value: f64) -> JsValue {
        JsValue::Number(value)
    }

    fn text(value: &str) -> JsValue {
        JsValue::String(value.to_string())
    }

    #[test]
    fn util_js_json_stringify_matches_node() {
        assert_eq!(
            js_json_stringify(&js_object(&[("b", num(1.0)), ("2", num(1.0))])),
            r#"{"2":1,"b":1}"#
        );
        assert_eq!(
            js_json_stringify(&js_object(&[("a", num(1.0)), ("1", num(2.0))])),
            r#"{"1":2,"a":1}"#
        );
        // uniqueItems の重複の判定: {a:1,1:2} と {1:2,a:1} は同じ文字列になる
        assert_eq!(
            js_json_stringify(&js_object(&[("a", num(1.0)), ("1", num(2.0))])),
            js_json_stringify(&js_object(&[("1", num(2.0)), ("a", num(1.0))]))
        );
        let keys = js_object(&[
            ("01", num(1.0)),
            ("1", num(2.0)),
            ("4294967294", num(3.0)),
            ("4294967295", num(4.0)),
            ("-1", num(5.0)),
            ("0", num(6.0)),
        ]);
        assert_eq!(
            js_json_stringify(&keys),
            r#"{"0":6,"1":2,"4294967294":3,"01":1,"4294967295":4,"-1":5}"#
        );
        assert_eq!(
            js_json_stringify(&text(
                "\"\\\u{8}\u{c}\n\r\t\u{1}\u{1f}\u{7f}\u{2028}\u{2029}é"
            )),
            "\"\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\u{2028}\u{2029}é\""
        );
        let array = JsValue::Array(vec![
            num(1.0),
            JsValue::Undefined,
            JsValue::Null,
            num(f64::NAN),
            num(f64::INFINITY),
            num(1e-6),
            num(1e21),
            num(-0.0),
            js_object(&[
                ("x", JsValue::Undefined),
                ("y", JsValue::Array(vec![JsValue::Undefined])),
            ]),
            JsValue::Bool(true),
            text("s"),
        ]);
        assert_eq!(
            js_json_stringify(&array),
            r#"[1,null,null,null,null,0.000001,1e+21,0,{"y":[null]},true,"s"]"#
        );
        assert_eq!(
            js_json_stringify(&js_object(&[("min", num(1_125_899_906_842_624.0 + 0.25))])),
            r#"{"min":1125899906842624.2}"#
        );
        // JSON.stringify(undefined) ?? String(undefined)
        assert_eq!(js_json_stringify(&JsValue::Undefined), "undefined");
    }

    #[test]
    fn util_js_to_string_matches_node() {
        let array = JsValue::Array(vec![
            num(1.0),
            JsValue::Array(vec![num(2.0), num(3.0)]),
            JsValue::Null,
            JsValue::Undefined,
            JsValue::Bool(true),
            JsValue::Array(vec![JsValue::Null]),
        ]);
        assert_eq!(js_to_string(&array), "1,2,3,,,true,");
        assert_eq!(
            js_to_string(&JsValue::Object(IndexMap::new())),
            "[object Object]"
        );
        assert_eq!(js_to_string(&num(1e21)), "1e+21");
        assert_eq!(js_to_string(&JsValue::Null), "null");
        assert_eq!(js_to_string(&JsValue::Undefined), "undefined");
        assert_eq!(js_to_string(&JsValue::Array(vec![])), "");
        assert_eq!(js_to_string(&JsValue::Bool(false)), "false");
        assert_eq!(js_to_string(&text("s")), "s");
        assert_eq!(js_to_string(&text(" 0x1F ")), " 0x1F ");
    }

    #[test]
    fn util_js_to_number_matches_node() {
        let table: Vec<(JsValue, f64)> = vec![
            (JsValue::Array(vec![]), 0.0),
            (JsValue::Array(vec![num(5.0)]), 5.0),
            (JsValue::Array(vec![text("5")]), 5.0),
            (JsValue::Array(vec![JsValue::Bool(true)]), f64::NAN),
            (JsValue::Array(vec![JsValue::Null]), 0.0),
            (JsValue::Array(vec![JsValue::Undefined]), 0.0),
            (JsValue::Array(vec![JsValue::Array(vec![num(7.0)])]), 7.0),
            (JsValue::Array(vec![num(1.0), num(2.0)]), f64::NAN),
            (JsValue::Array(vec![text("0x10")]), 16.0),
            (JsValue::Object(IndexMap::new()), f64::NAN),
            (JsValue::Null, 0.0),
            (JsValue::Undefined, f64::NAN),
            (JsValue::Bool(true), 1.0),
            (JsValue::Bool(false), 0.0),
            (text(" 12 "), 12.0),
        ];
        for (value, expected) in table {
            assert!(
                same_number(js_to_number(&value), expected),
                "Number({value:?})"
            );
        }
    }

    #[test]
    fn util_js_trim_uses_js_whitespace() {
        assert_eq!(js_trim("\u{FEFF}\u{3000} a b \u{2028}\u{00A0}"), "a b");
        // U+0085 は JS の空白ではない
        assert_eq!(js_trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}");
        assert_eq!(js_trim_start("\t a \t"), "a \t");
        assert_eq!(js_trim_end("\t a \t"), "\t a");
        assert_eq!(JS_WHITESPACE.len(), 25);
    }

    #[test]
    fn util_js_max_min_match_node() {
        assert!(same_number(js_max(0.0, -0.0), 0.0));
        assert!(same_number(js_max(-0.0, 0.0), 0.0));
        assert!(same_number(js_min(0.0, -0.0), -0.0));
        assert!(same_number(js_min(-0.0, 0.0), -0.0));
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
        assert_eq!(js_max(2.0, 3.0), 3.0);
        assert_eq!(js_min(2.0, 3.0), 2.0);
        // 規則 2.1 の可変長の写し: 空なら Infinity / -Infinity
        let empty: [f64; 0] = [];
        assert_eq!(
            empty.iter().copied().fold(f64::INFINITY, js_min),
            f64::INFINITY
        );
        assert_eq!(
            empty.iter().copied().fold(f64::NEG_INFINITY, js_max),
            f64::NEG_INFINITY
        );
    }

    #[test]
    fn util_unique_in_order_keeps_first_occurrences() {
        assert_eq!(
            unique_in_order(vec!["x", "o", "x", " ", "o"]),
            vec!["x", "o", " "]
        );
        assert_eq!(unique_in_order(Vec::<u32>::new()), Vec::<u32>::new());
    }

    #[test]
    fn util_js_date_utc_matches_node() {
        let table: &[DateCase] = &[
            (
                [99.0, 0.0, 1.0, 0.0, 0.0, 0.0],
                915_148_800_000.0,
                Some((1999, 0, 1)),
            ),
            (
                [0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
                -2_208_988_800_000.0,
                Some((1900, 0, 1)),
            ),
            (
                [2024.0, 1.0, 29.0, 0.0, 0.0, 0.0],
                1_709_164_800_000.0,
                Some((2024, 1, 29)),
            ),
            (
                [2023.0, 1.0, 29.0, 0.0, 0.0, 0.0],
                1_677_628_800_000.0,
                Some((2023, 2, 1)),
            ),
            (
                [2024.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                1_703_980_800_000.0,
                Some((2023, 11, 31)),
            ),
            (
                [2024.0, 12.0, 1.0, 0.0, 0.0, 0.0],
                1_735_689_600_000.0,
                Some((2025, 0, 1)),
            ),
            (
                [2024.0, -1.0, 1.0, 0.0, 0.0, 0.0],
                1_701_388_800_000.0,
                Some((2023, 11, 1)),
            ),
            (
                [100.0, 0.0, 1.0, 0.0, 0.0, 0.0],
                -59_011_459_200_000.0,
                Some((100, 0, 1)),
            ),
            (
                [-1.0, 0.0, 1.0, 0.0, 0.0, 0.0],
                -62_198_755_200_000.0,
                Some((-1, 0, 1)),
            ),
            (
                [275_760.0, 8.0, 13.0, 0.0, 0.0, 0.0],
                8.64e15,
                Some((275_760, 8, 13)),
            ),
            ([275_760.0, 8.0, 14.0, 0.0, 0.0, 0.0], f64::NAN, None),
            (
                [-271_821.0, 3.0, 20.0, 0.0, 0.0, 0.0],
                -8.64e15,
                Some((-271_821, 3, 20)),
            ),
            ([-271_821.0, 3.0, 19.0, 0.0, 0.0, 0.0], f64::NAN, None),
            (
                [2024.0, 0.0, 1.0, 23.0, 59.0, 59.0],
                1_704_153_599_000.0,
                Some((2024, 0, 1)),
            ),
            (
                [2024.0, 0.0, 1.0, -1.0, 0.0, 0.0],
                1_704_063_600_000.0,
                Some((2023, 11, 31)),
            ),
            (
                [2000.0, 0.0, 1.0, 24.0, 60.0, 60.0],
                946_774_860_000.0,
                Some((2000, 0, 2)),
            ),
            ([f64::NAN, 0.0, 1.0, 0.0, 0.0, 0.0], f64::NAN, None),
            ([1970.0, 0.0, 1.0, 0.0, 0.0, 0.0], 0.0, Some((1970, 0, 1))),
            (
                [1600.0, 1.0, 29.0, 0.0, 0.0, 0.0],
                -11_670_998_400_000.0,
                Some((1600, 1, 29)),
            ),
            (
                [1900.0, 1.0, 29.0, 0.0, 0.0, 0.0],
                -2_203_891_200_000.0,
                Some((1900, 2, 1)),
            ),
            (
                [2024.7, 0.9, 1.5, 0.0, 0.0, 0.0],
                1_704_067_200_000.0,
                Some((2024, 0, 1)),
            ),
            (
                [99.5, 0.0, 1.0, 0.0, 0.0, 0.0],
                915_148_800_000.0,
                Some((1999, 0, 1)),
            ),
            // 2.8 の例: 日 32 は翌月へ、月 13 (0 始まり) は翌年の 2 月
            (
                [2024.0, 0.0, 32.0, 0.0, 0.0, 0.0],
                1_706_745_600_000.0,
                Some((2024, 1, 1)),
            ),
            (
                [2024.0, 13.0, 1.0, 0.0, 0.0, 0.0],
                1_738_368_000_000.0,
                Some((2025, 1, 1)),
            ),
            // V8 の MakeDay の範囲 (年 ±1000000、月 ±10000000)。日で打ち消されても NaN
            (
                [1_000_001.0, 0.0, -365_000_000.0, 0.0, 0.0, 0.0],
                f64::NAN,
                None,
            ),
            (
                [-1_000_001.0, 0.0, 365_000_000.0, 0.0, 0.0, 0.0],
                f64::NAN,
                None,
            ),
            (
                [2_000_000.0, 0.0, -700_000_000.0, 0.0, 0.0, 0.0],
                f64::NAN,
                None,
            ),
            (
                [1_000_000.0, 0.0, -364_000_000.0, 0.0, 0.0, 0.0],
                45_184_694_400_000.0,
                Some((3401, 10, 6)),
            ),
            (
                [-800_000.0, 10_000_001.0, 1.0, 0.0, 0.0, 0.0],
                f64::NAN,
                None,
            ),
            (
                [-800_000.0, 10_000_000.0, 1.0, 0.0, 0.0, 0.0],
                989_731_094_400_000.0,
                Some((33333, 4, 1)),
            ),
            (
                [800_000.0, -10_000_001.0, 1.0, 0.0, 0.0, 0.0],
                f64::NAN,
                None,
            ),
        ];
        for ([y, m, d, h, mi, s], expected, parts) in table {
            let time = js_date_utc(*y, *m, *d, *h, *mi, *s);
            assert!(
                same_number(time, *expected),
                "Date.UTC({y}, {m}, {d}, {h}, {mi}, {s}) = {time}"
            );
            assert_eq!(
                js_date_parts(time),
                *parts,
                "parts of Date.UTC({y}, {m}, {d})"
            );
        }
        // TimeClip の外の時刻は Invalid Date (getUTC* は NaN)
        assert_eq!(js_date_parts(8.64e15 + 1.0), None);
        assert_eq!(js_date_parts(-8.64e15 - 1.0), None);
        assert_eq!(js_date_parts(1e300), None);
        assert_eq!(js_date_parts(8.64e15), Some((275_760, 8, 13)));
    }

    #[test]
    fn util_yaml_core_scalar_matches_eemeli_yaml() {
        let table: Vec<(&str, JsValue)> = vec![
            ("~", JsValue::Null),
            ("null", JsValue::Null),
            ("Null", JsValue::Null),
            ("NULL", JsValue::Null),
            ("", JsValue::Null),
            ("nULL", text("nULL")),
            ("true", JsValue::Bool(true)),
            ("True", JsValue::Bool(true)),
            ("TRUE", JsValue::Bool(true)),
            ("tRUE", text("tRUE")),
            ("false", JsValue::Bool(false)),
            ("False", JsValue::Bool(false)),
            ("FALSE", JsValue::Bool(false)),
            ("yes", text("yes")),
            ("007", num(7.0)),
            ("+12", num(12.0)),
            ("-0", num(-0.0)),
            ("0o17", num(15.0)),
            ("0o8", text("0o8")),
            ("0o", text("0o")),
            ("0x1F", num(31.0)),
            ("0X1F", text("0X1F")),
            (".inf", num(f64::INFINITY)),
            (".Inf", num(f64::INFINITY)),
            (".INF", num(f64::INFINITY)),
            ("+.inf", num(f64::INFINITY)),
            ("-.inf", num(f64::NEG_INFINITY)),
            (".nan", num(f64::NAN)),
            (".NaN", num(f64::NAN)),
            (".NAN", num(f64::NAN)),
            (".NAn", text(".NAn")),
            ("1.5", num(1.5)),
            ("1.", num(1.0)),
            (".5", num(0.5)),
            ("-.5", num(-0.5)),
            ("1.0", num(1.0)),
            ("1e3", num(1000.0)),
            ("1.0e-3", num(0.001)),
            ("+1.5E+2", num(150.0)),
            ("+.5e1", num(5.0)),
            ("1_000", text("1_000")),
            (
                "123456789012345678901234567890",
                num(1.234_567_890_123_456_8e29),
            ),
            ("0x1FFFFFFFFFFFFF1", num(144_115_188_075_855_860.0)),
            ("<<", text("<<")),
        ];
        for (source, expected) in table {
            let actual = yaml_core_scalar(source, false);
            let same = match (&actual, &expected) {
                (JsValue::Number(a), JsValue::Number(b)) => same_number(*a, *b),
                _ => actual == expected,
            };
            assert!(same, "yaml {source:?} = {actual:?}");
        }
        // 引用符つきは常に文字列
        assert_eq!(yaml_core_scalar("true", true), text("true"));
        assert_eq!(yaml_core_scalar("", true), text(""));
        // 規則 2.3 のキーの文字列化の例 (007 → "7"、1.0 → "1"、True → "true"、.inf → "Infinity"、-0 → "0")
        for (source, key) in [
            ("007", "7"),
            ("1.0", "1"),
            ("True", "true"),
            (".inf", "Infinity"),
            ("-0", "0"),
            ("0x1F", "31"),
        ] {
            assert_eq!(js_to_string(&yaml_core_scalar(source, false)), key);
        }
    }

    #[test]
    fn util_js_strict_equals() {
        assert!(js_strict_equals(&JsValue::Null, &JsValue::Null));
        assert!(js_strict_equals(
            &JsValue::Number(0.0),
            &JsValue::Number(-0.0)
        ));
        assert!(!js_strict_equals(
            &JsValue::Number(f64::NAN),
            &JsValue::Number(f64::NAN)
        ));
        assert!(!js_strict_equals(
            &JsValue::Number(1.0),
            &JsValue::String("1".to_string())
        ));
        assert!(!js_strict_equals(
            &JsValue::Bool(true),
            &JsValue::String("true".to_string())
        ));
        assert!(!js_strict_equals(
            &JsValue::Array(Vec::new()),
            &JsValue::Array(Vec::new())
        ));
    }

    #[test]
    fn util_js_array_join_and_same_value_zero() {
        let items = vec![
            JsValue::Null,
            JsValue::Number(1.0),
            JsValue::Undefined,
            JsValue::String("a".to_string()),
        ];
        assert_eq!(js_array_join(&items, ", "), ", 1, , a");
        assert_eq!(js_to_string(&JsValue::Array(items)), ",1,,a");
        assert!(js_same_value_zero(
            &JsValue::Number(f64::NAN),
            &JsValue::Number(f64::NAN)
        ));
        assert!(js_same_value_zero(
            &JsValue::Number(0.0),
            &JsValue::Number(-0.0)
        ));
        assert!(!js_same_value_zero(
            &JsValue::Number(f64::NAN),
            &JsValue::Null
        ));
        assert!(!js_same_value_zero(
            &JsValue::Number(1.0),
            &JsValue::String("1".to_string())
        ));
    }

    #[test]
    fn util_js_path_join_slice_and_object_keys() {
        let path = vec![
            PathStep::Key("markdag".to_string()),
            PathStep::Key("tags".to_string()),
            PathStep::Index(7),
        ];
        assert_eq!(js_path_join(&path), "markdag.tags.7");
        assert_eq!(js_path_join(&[]), "");

        assert_eq!(js_slice("abcdef", 1, 3), "bc");
        assert_eq!(js_slice("abc", 2, 10), "c");
        assert_eq!(js_slice("abc", 5, 10), "");
        // 空の frontmatter で close (3) < start (4) になる
        assert_eq!(js_slice("---\n---\n# A", 4, 3), "");

        assert_eq!(js_object_keys(&text("a😀b")), vec!["0", "1", "2", "3"]);
        assert_eq!(
            js_object_keys(&JsValue::Array(vec![num(5.0), num(6.0)])),
            vec!["0", "1"]
        );
        assert_eq!(js_object_keys(&num(5.0)), Vec::<String>::new());
        // 書かれた順 (整数に見えるキーを先頭へ並べない。決定 8)。値が Undefined でもキーはある
        let object = js_object(&[
            ("b", JsValue::Undefined),
            ("2", JsValue::Null),
            ("a", num(1.0)),
        ]);
        assert_eq!(js_object_keys(&object), vec!["b", "2", "a"]);
    }

    // 期待値は node v22.12.0 の new RegExp(p, 'u') が throw するか (2026-09-24)
    #[test]
    fn util_regexp_u_matches_node() {
        let cases: &[(&str, bool)] = &[
            (r"\b+", false),
            (r"\B*", false),
            (r"\b?", false),
            (r"\b{2}", false),
            (r"\b{", false),
            (r"\b*?", false),
            (r"(?<=a)*", false),
            (r"(?<!a)?", false),
            (r"^*", false),
            (r"$+", false),
            (r"(", false),
            (r"[\b]+", true),
            (r"\\b+", true),
            (r"a\b", true),
            (r"\bx+", true),
            (r"[\]\b]+", true),
            (r"^[a-z]+$", true),
        ];
        for (pattern, compiles) in cases {
            assert_eq!(js_regexp_u(pattern).is_some(), *compiles, "{pattern}");
        }
        // 捕まえなかった組は Number(undefined) の NaN
        let Some(found) = regex::Regex::new(r"^([0-9]+)(:[0-9]+)?$")
            .expect("固定の正規表現")
            .captures("0042")
        else {
            panic!("0042 に当たる");
        };
        assert_eq!(js_number_of_group(found.get(1)), 42.0);
        assert!(js_number_of_group(found.get(2)).is_nan());
    }

    // タグつきのスカラはタグで解決する。書き方がタグの形に合わなければ文字
    #[test]
    fn util_scalar_value_resolves_by_tag() {
        assert_eq!(
            scalar_value("2", ScalarStyle::Plain, Some(&core_tag("float"))),
            JsValue::String("2".to_string())
        );
        assert_eq!(
            scalar_value("1.5", ScalarStyle::Plain, Some(&core_tag("float"))),
            JsValue::Number(1.5)
        );
        assert_eq!(
            scalar_value("1.5", ScalarStyle::Plain, Some(&core_tag("int"))),
            JsValue::String("1.5".to_string())
        );
        assert_eq!(
            scalar_value("yes", ScalarStyle::Plain, Some(&core_tag("bool"))),
            JsValue::String("yes".to_string())
        );
    }

    fn core_tag(suffix: &str) -> Tag {
        Tag {
            handle: "tag:yaml.org,2002:".to_string(),
            suffix: suffix.to_string(),
        }
    }
}

// PORT STATUS: confidence=high todos=5
