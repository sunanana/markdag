// 本文の `:alias:` (ロゴの印) の取り出し。comrak の文字のノード 1 つを、その原文の区間と突き合わせて読む。
// 印とみなす条件: 開きの `:` の前が文字のノードの始まりか英数字 (ASCII) 以外、alias が [a-z][a-z0-9_-]*、閉じの `:` の次が
// 文字のノードの終わりか英数字 (ASCII) 以外。`\:` のエスケープや文字参照から来た字は印の一部にしない (エスケープの `\` は comrak が消す)。
// インラインのコード、数式、リンクの URL、画像の alt、生の HTML は文字のノードでないので、ここを通らず印にならない。
// 印は、文字を残したまま印の要素 (クラス mdag-icon、data-icon に alias) で包む。ロゴへの差し替えは描画の側が行い、
// 差し替えなければ書いたとおりの文字が見える。ノードの名前 (refText) は、この要素を svg と同じく数えずに作る
// 「英数字」は ASCII の英数字だけなので、かなや漢字に続けた `詳細は:grafana:で` も印になる。
// 解析は $ref の表を知らないので、定義のない alias も印の要素にして refText から除く (表示は文字のまま)。
// 名前が $ref の読み込みの成否で変わらないことを優先している
use std::sync::LazyLock;

use regex::Regex;

use super::html::escape_html;
use crate::model::util::JsValue;
use crate::types::SourcePosition;

/// 印の要素に付けるクラス
pub(crate) const ICON_CLASS: &str = "mdag-icon";
/// 印の要素の、alias を書く属性
pub(crate) const ICON_ATTRIBUTE: &str = "data-icon";

// 文字参照 (`&amp;` `&#58;` `&#x3a;`)。文字のノードでは 1 字になっている
static CHAR_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});")
        .expect("固定の正規表現")
});

/// 本文から取り出した印 1 つ。at は原文での `:alias:` 全体の位置
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct IconMark {
    pub(crate) alias: String,
    pub(crate) at: SourcePosition,
}

/// 文書が markdag.icons を書いているか。書いていない文書は `:word:` を印にせず、HTML も refText も変えない
pub(super) fn icons_declared(frontmatter: Option<&JsValue>) -> bool {
    let Some(JsValue::Object(entries)) = frontmatter else {
        return false;
    };
    matches!(entries.get("markdag"), Some(JsValue::Object(markdag)) if markdag.contains_key("icons"))
}

// 文字のノードの 1 字。literal は原文にその字のまま書かれていたか (エスケープと文字参照は偽)、
// offset は原文の区間の中のバイト位置 (突き合わせられなかった字は None)
#[derive(Debug, Clone, Copy, PartialEq)]
struct Glyph {
    ch: char,
    literal: bool,
    offset: Option<usize>,
}

// 文字のノードの字を、原文の区間と前から突き合わせる。突き合わせが崩れたら (複数の字になる文字参照など)、
// そこから後ろは literal を偽にして印にしない (見逃すだけで、誤って印にはしない)
fn glyphs(text: &str, source: Option<&str>, escaped_start: bool) -> Vec<Glyph> {
    let Some(source) = source else {
        return text
            .chars()
            .map(|ch| Glyph {
                ch,
                literal: false,
                offset: None,
            })
            .collect();
    };
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    let mut lost = false;
    for (index, ch) in text.chars().enumerate() {
        let rest = source.get(at..).unwrap_or("");
        let (literal, width) = if lost {
            (false, None)
        } else if index == 0 && escaped_start && rest.starts_with(ch) {
            (false, Some(ch.len_utf8()))
        } else if ch.is_ascii_punctuation()
            && rest
                .strip_prefix('\\')
                .is_some_and(|after| after.starts_with(ch))
        {
            (false, Some(1 + ch.len_utf8()))
        } else if rest.starts_with('&')
            && let Some(found) = CHAR_REF.find(rest)
            && !(ch == '&' && text_continues_literally(rest))
        {
            (false, Some(found.end()))
        } else if rest.starts_with(ch) {
            (true, Some(ch.len_utf8()))
        } else {
            (false, None)
        };
        match width {
            Some(width) => {
                out.push(Glyph {
                    ch,
                    literal,
                    offset: Some(at),
                });
                at += width;
            }
            None => {
                lost = true;
                out.push(Glyph {
                    ch,
                    literal: false,
                    offset: None,
                });
            }
        }
    }
    out
}

// `&name;` が文字参照として読まれず `&` のまま文字に残る場合 (知らない名前)。comrak の表と突き合わせる代わりに、
// 名前つきの参照は `&amp;` など確かなものだけを参照とみなす
// TODO(spec): 名前つきの文字参照の全表とは突き合わせていない。`&AMP;` のように一覧にない名前で `&` になる参照の後ろの印は見逃す (誤って印にはしない)
fn text_continues_literally(rest: &str) -> bool {
    let known = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;", "&nbsp;"];
    !(rest.starts_with("&#") || known.iter().any(|name| rest.starts_with(name)))
}

/// 文字のノードを印と文字に分けたもの
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Piece {
    Text(String),
    /// offset は原文の区間の中のバイト位置 (開きの `:`)
    Mark {
        alias: String,
        offset: usize,
    },
}

// alias の名前の形 (英小文字で始め、英小文字、数字、_ と - が続く) を字ごとに見る。frontmatter の alias の名前と同じ並び
fn is_alias_start(glyph: &Glyph) -> bool {
    glyph.literal && glyph.ch.is_ascii_lowercase()
}

fn is_alias_rest(glyph: &Glyph) -> bool {
    glyph.literal && matches!(glyph.ch, 'a'..='z' | '0'..='9' | '_' | '-')
}

// 字ごとに URL の中か。URL は、英数字 (ASCII) に続かない位置のスキーム (`[A-Za-z][A-Za-z0-9+.-]*://`) か `www.` から、
// 空白の手前まで (GFM の自動リンクの終わりと同じく空白で切る)。URL の中の `:name:` は印にしない
fn url_ranges(span: &[Glyph]) -> Vec<bool> {
    let mut in_url = vec![false; span.len()];
    let mut index = 0;
    while index < span.len() {
        let boundary = index
            .checked_sub(1)
            .and_then(|before| span.get(before))
            .is_none_or(|before| !before.ch.is_ascii_alphanumeric());
        if boundary && starts_url(span.get(index..).unwrap_or_default()) {
            while let Some(glyph) = span.get(index) {
                if glyph.ch.is_whitespace() {
                    break;
                }
                if let Some(flag) = in_url.get_mut(index) {
                    *flag = true;
                }
                index += 1;
            }
        }
        index += 1;
    }
    in_url
}

fn starts_url(rest: &[Glyph]) -> bool {
    let lower = |at: usize| rest.get(at).map(|glyph| glyph.ch.to_ascii_lowercase());
    if (0..4).map(lower).eq("www.".chars().map(Some)) {
        return true;
    }
    if !rest
        .first()
        .is_some_and(|glyph| glyph.ch.is_ascii_alphabetic())
    {
        return false;
    }
    let scheme = rest
        .iter()
        .skip(1)
        .take_while(|glyph| glyph.ch.is_ascii_alphanumeric() || matches!(glyph.ch, '+' | '.' | '-'))
        .count();
    rest.get(1 + scheme..)
        .unwrap_or_default()
        .iter()
        .take(3)
        .map(|glyph| glyph.ch)
        .eq("://".chars())
}

/// 文字のノードの字 (text) を、原文の区間 (source。1 行に収まらないなどで読めなければ None) と突き合わせて印と文字に分ける。
/// escaped_start は、区間の直前に `\` があり、最初の字がエスケープで書かれていること (comrak は文字のノードの区間を
/// エスケープの `\` のあとから始める)。lead と trail は、前と後ろから削る字の数 (表のセルの端の空白)
pub(super) fn split_icon_marks(
    text: &str,
    source: Option<&str>,
    escaped_start: bool,
    lead: usize,
    trail: usize,
) -> Vec<Piece> {
    let all = glyphs(text, source, escaped_start);
    let start = lead.min(all.len());
    let end = all.len().saturating_sub(trail).max(start);
    let span = all.get(start..end).unwrap_or_default();
    let in_url = url_ranges(span);
    let mut pieces: Vec<Piece> = Vec::new();
    let mut plain = String::new();
    let mut index = 0;
    while let Some(&glyph) = span.get(index) {
        let opens = glyph.ch == ':'
            && glyph.literal
            && !in_url.get(index).copied().unwrap_or(false)
            && index
                .checked_sub(1)
                .and_then(|before| span.get(before))
                .is_none_or(|before| !before.ch.is_ascii_alphanumeric());
        if opens && span.get(index + 1).is_some_and(is_alias_start) {
            let mut close = index + 2;
            while span.get(close).is_some_and(is_alias_rest) {
                close += 1;
            }
            let closes = span
                .get(close)
                .is_some_and(|glyph| glyph.ch == ':' && glyph.literal)
                && span
                    .get(close + 1)
                    .is_none_or(|next| !next.ch.is_ascii_alphanumeric());
            if closes && let Some(offset) = glyph.offset {
                if !plain.is_empty() {
                    pieces.push(Piece::Text(std::mem::take(&mut plain)));
                }
                pieces.push(Piece::Mark {
                    alias: span
                        .get(index + 1..close)
                        .unwrap_or_default()
                        .iter()
                        .map(|glyph| glyph.ch)
                        .collect(),
                    offset,
                });
                index = close + 1;
                continue;
            }
        }
        plain.push(glyph.ch);
        index += 1;
    }
    if !plain.is_empty() {
        pieces.push(Piece::Text(plain));
    }
    pieces
}

/// 印の要素の HTML。中身は書いたとおりの `:alias:` (描画の側がロゴに差し替えなければ、そのまま見える)
// 絵文字の alias (kind emoji) もここでは文字に置き換えず印のまま残す。表はモデルにあり、描画の側が置き換える
pub(super) fn render_icon_mark(alias: &str) -> String {
    let alias = escape_html(alias);
    format!("<span class=\"{ICON_CLASS}\" {ICON_ATTRIBUTE}=\"{alias}\">:{alias}:</span>")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marks(text: &str, source: &str) -> Vec<String> {
        split_icon_marks(text, Some(source), false, 0, 0)
            .into_iter()
            .map(|piece| match piece {
                Piece::Text(text) => text,
                Piece::Mark { alias, offset } => format!("[{alias}@{offset}]"),
            })
            .collect()
    }

    #[test]
    fn 行頭と空白と句読点に続く印を取り出す() {
        assert_eq!(
            marks(":github: Push", ":github: Push"),
            ["[github@0]", " Push"]
        );
        assert_eq!(
            marks("通知は、:slack: Slack に", "通知は、:slack: Slack に"),
            ["通知は、", "[slack@12]", " Slack に"]
        );
        assert_eq!(
            marks("(:aws-lambda_2:)", "(:aws-lambda_2:)"),
            ["(", "[aws-lambda_2@1]", ")"]
        );
        // 英数字 (ASCII) だけを区切りにしないので、かなに続けても印になる
        assert_eq!(
            marks("詳細は:grafana:で", "詳細は:grafana:で"),
            ["詳細は", "[grafana@9]", "で"]
        );
    }

    #[test]
    fn 時刻と_url_と英数字に挟まれたものは印にしない() {
        for text in [
            "10:30:00",
            "https://example.com/a:b:c",
            "a:github:",
            ":github:x",
            ":Github:",
            ":1abc:",
            "::",
            ":a b:",
        ] {
            assert_eq!(marks(text, text), [text], "{text}");
        }
    }

    // URL (スキームの `://` か `www.` から空白の手前まで) の中の `:name:` は文字のまま。URL の外の印は読む
    #[test]
    fn url_の中の印は文字のまま() {
        for text in [
            "https://example.com/:gitub:/x",
            "www.example.com/:gitub:",
            "HTTP://example.com/:a:",
            "x+y.z://h/:a:",
            "(https://example.com/:a:)",
        ] {
            assert_eq!(marks(text, text), [text], "{text}");
        }
        assert_eq!(
            marks(
                "自動 https://example.com/:a:/x :b: 後",
                "自動 https://example.com/:a:/x :b: 後"
            ),
            ["自動 https://example.com/:a:/x ", "[b@33]", " 後"]
        );
        assert_eq!(
            marks("前 :a: www.x.com/:b:", "前 :a: www.x.com/:b:"),
            ["前 ", "[a@4]", " www.x.com/:b:"]
        );
        // 英数字に続く `www.` と `://` は URL の始まりに数えない (前の語の一部)
        assert_eq!(marks("awww.:x:", "awww.:x:"), ["awww.", "[x@5]"]);
    }

    #[test]
    fn エスケープと文字参照の_colon_は印にしない() {
        // `\:x:` は comrak が `\` を消して `:x:` になる。原文と突き合わせて、開きの `:` がエスケープだと分かる
        assert_eq!(marks(":x: y", r"\:x: y"), [":x: y"]);
        // 文字のノードがエスケープで始まると、comrak の区間は `\` のあとから始まる
        assert_eq!(
            split_icon_marks(":x: y", Some(":x: y"), true, 0, 0),
            [Piece::Text(":x: y".to_string())]
        );
        assert_eq!(marks(":x:", "&#58;x:"), [":x:"]);
        // `\\` のあとの `:` はエスケープでない
        assert_eq!(marks(r"\ :x:", r"\\ :x:"), [r"\ ", "[x@3]"]);
        // 文字参照の後ろも突き合わせが続く
        assert_eq!(marks("a & :x:", "a &amp; :x:"), ["a & ", "[x@8]"]);
    }

    #[test]
    fn 原文が読めない文字のノードは印にしない() {
        assert_eq!(
            split_icon_marks(":x:", None, false, 0, 0),
            [Piece::Text(":x:".to_string())]
        );
    }

    #[test]
    fn 端を削った字の上で読む() {
        assert_eq!(
            split_icon_marks("  :x:  ", Some("  :x:  "), false, 2, 2),
            [Piece::Mark {
                alias: "x".to_string(),
                offset: 2
            }]
        );
    }

    #[test]
    fn icons_を書いた文書だけで印を読む() {
        let parse = |text: &str| serde_json::from_str::<JsValue>(text);
        let with = parse(r#"{"markdag":{"icons":{}}}"#).expect("json");
        let without = parse(r#"{"markdag":{"tags":{}}}"#).expect("json");
        assert!(icons_declared(Some(&with)));
        assert!(!icons_declared(Some(&without)));
        assert!(!icons_declared(None));
    }

    #[test]
    fn 正規表現の_lazy_lock_をすべて一度触る() {
        assert_eq!(CHAR_REF.find("&#x3a;x").map(|m| m.end()), Some(6));
        assert!(CHAR_REF.find("&;").is_none());
    }

    // 描画の側 (TS の plainMark と ICON_MARK)、モデルの側 (document_icon_defs の ICON_MARK) が読む形。
    // 同じ文字列を testdata/unit/icons/marks.json が持ち、TS の単体テストが突き合わせる
    #[test]
    fn 印の要素の形() {
        assert_eq!(
            render_icon_mark("aws-lambda_2"),
            r#"<span class="mdag-icon" data-icon="aws-lambda_2">:aws-lambda_2:</span>"#
        );
        assert_eq!(ICON_CLASS, "mdag-icon");
        assert_eq!(ICON_ATTRIBUTE, "data-icon");
        // alias の字は印の取り出しで絞ってあるが、書く側でも逃がす
        assert_eq!(
            render_icon_mark("a\"&"),
            r#"<span class="mdag-icon" data-icon="a&quot;&amp;">:a&quot;&amp;:</span>"#
        );
    }

    // 本文で印になる alias の字の並びは、frontmatter の alias の名前の形 (ALIAS_NAME) と同じ
    #[test]
    fn 印になる字の並びは_alias_の名前の形と同じ() {
        use crate::model::icons::ALIAS_NAME;
        for alias in [
            "a",
            "z9",
            "a-",
            "a_",
            "a--b",
            "aws-lambda_2",
            "9a",
            "-a",
            "_a",
            "A",
            "aB",
            "a.b",
            "a b",
            "a:b",
            "é",
            "ａ",
        ] {
            let text = format!(" :{alias}: ");
            let marked = split_icon_marks(&text, Some(&text), false, 0, 0)
                .iter()
                .any(|piece| matches!(piece, Piece::Mark { alias: found, .. } if found == alias));
            assert_eq!(marked, ALIAS_NAME.is_match(alias), "{alias}");
        }
    }

    #[test]
    fn 並んだ印と端の印と多バイトの字のあとの位置() {
        assert_eq!(marks(":a::b:", ":a::b:"), ["[a@0]", "[b@3]"]);
        assert_eq!(marks(":a:b:", ":a:b:"), [":a:b:"]);
        assert_eq!(marks(":a: :b:", ":a: :b:"), ["[a@0]", " ", "[b@4]"]);
        assert_eq!(marks("日本:x:", "日本:x:"), ["日本", "[x@6]"]);
        assert_eq!(marks(":x", ":x"), [":x"]);
        assert_eq!(marks(":", ":"), [":"]);
        assert_eq!(marks("", ""), Vec::<String>::new());
    }

    #[test]
    fn 削る字の数が字の数を超えても空を返す() {
        for (lead, trail) in [(5, 0), (0, 5), (2, 2), (3, 3), (9, 9)] {
            assert_eq!(
                split_icon_marks(":x:", Some(":x:"), false, lead, trail),
                Vec::<Piece>::new(),
                "{lead} {trail}"
            );
        }
        assert_eq!(
            split_icon_marks(" :x: ", Some(" :x: "), false, 1, 0),
            [
                Piece::Mark {
                    alias: "x".to_string(),
                    offset: 1
                },
                Piece::Text(" ".to_string())
            ]
        );
    }

    #[test]
    fn 突き合わせが崩れたら後ろは印にしない() {
        // 原文にない字が来たら、そこから後ろは印にしない (見逃すだけで、誤って印にはしない)
        assert_eq!(marks("? :x:", "! :x:"), ["? :x:"]);
        // 知らない名前の文字参照は & を字のまま読み、後ろの印を読み続ける
        assert_eq!(marks("&foo; :x:", "&foo; :x:"), ["&foo; ", "[x@6]"]);
    }
}
