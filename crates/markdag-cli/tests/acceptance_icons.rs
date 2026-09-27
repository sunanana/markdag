// アイコン機能の受け入れテスト (cli の面)。testdata/acceptance/icons/cli/<名前>/ の例を、markdag のバイナリで 1 件ずつ回す。
// 期待は各例の expect.yaml から読み、ここに写さない。コマンドは例のディレクトリで打つ (文書と $ref とロゴのパスは例のとおり)。
// `-o out.html` の書き出し先だけは一時ディレクトリに差し替え、例のディレクトリにファイルを増やさない。
// expect.yaml の opened (書いた HTML をブラウザで開いたとき) はブラウザが要るので e2e/acceptance-icons.spec.ts が見る。
// 例を足したら下の examples! に名前を足す (足し忘れは every_example_is_listed が落とす)
mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::repo_root;
use saphyr::{LoadableYamlNode, Scalar, Yaml};
use serde_json::{Map, Value};

const DATA_OPEN: &str = "<script id=\"markdag-data\" type=\"application/json\">";

// MARKDAG_ICONS_ACCEPTANCE で別の置き場 (例を写して期待を変えた一時の置き場など) を指せる。試験が何も見ていない欄がないかを確かめるため
fn cli_root() -> PathBuf {
    match std::env::var_os("MARKDAG_ICONS_ACCEPTANCE") {
        Some(root) => PathBuf::from(root).join("cli"),
        None => repo_root().join("testdata/acceptance/icons/cli"),
    }
}

fn yaml_to_json(yaml: &Yaml) -> Value {
    match yaml {
        Yaml::Value(Scalar::Null) => Value::Null,
        Yaml::Value(Scalar::Boolean(value)) => Value::Bool(*value),
        Yaml::Value(Scalar::Integer(value)) => Value::from(*value),
        Yaml::Value(Scalar::FloatingPoint(value)) => Value::from(value.into_inner()),
        Yaml::Value(Scalar::String(text)) => Value::String(text.to_string()),
        Yaml::Representation(text, _, _) => Value::String(text.to_string()),
        Yaml::Sequence(items) => Value::Array(items.iter().map(yaml_to_json).collect()),
        Yaml::Mapping(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    let key = match yaml_to_json(key) {
                        Value::String(text) => text,
                        other => other.to_string(),
                    };
                    (key, yaml_to_json(value))
                })
                .collect::<Map<String, Value>>(),
        ),
        Yaml::Tagged(_, inner) => yaml_to_json(inner),
        Yaml::Alias(_) | Yaml::BadValue => Value::Null,
    }
}

fn load_expect(dir: &Path) -> Value {
    let text = fs::read_to_string(dir.join("expect.yaml")).expect("expect.yaml を読める");
    let docs = Yaml::load_from_str(&text).expect("expect.yaml は YAML");
    yaml_to_json(docs.first().expect("expect.yaml に文書がある"))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().expect("文字の一覧").to_string())
            .collect(),
        Some(Value::String(text)) => vec![text.clone()],
        Some(other) => panic!("文字の一覧として読めない: {other}"),
    }
}

fn unknown_keys(value: &Value, known: &[&str], label: &str, problems: &mut Vec<String>) {
    if let Some(map) = value.as_object() {
        let extra: Vec<&str> = map
            .keys()
            .map(String::as_str)
            .filter(|key| !known.contains(key))
            .collect();
        if !extra.is_empty() {
            problems.push(format!(
                "{label}: テストが読まない欄がある: {}",
                extra.join(", ")
            ));
        }
    }
}

struct Ran {
    exit: i32,
    stdout: String,
    stderr: String,
    html: Option<String>,
}

// 例の command の文字列 (`markdag <引数…>`) を、例のディレクトリで打つ。`-o <ファイル>` は一時ディレクトリへ差し替える
fn run(dir: &Path, command: &str, out_dir: &Path) -> Ran {
    let mut words = command.split_whitespace();
    assert_eq!(
        words.next(),
        Some("markdag"),
        "command は markdag で始まる: {command}"
    );
    let mut args: Vec<String> = Vec::new();
    let mut out: Option<PathBuf> = None;
    let mut rest = words.peekable();
    while let Some(word) = rest.next() {
        if word == "-o" {
            let name = rest.next().expect("-o の後にファイル名がある");
            let path = out_dir.join(Path::new(name).file_name().expect("ファイル名"));
            args.push("-o".into());
            args.push(path.to_string_lossy().into_owned());
            out = Some(path);
        } else {
            args.push(word.to_string());
        }
    }
    let output = assert_cmd::cargo::cargo_bin_cmd!("markdag")
        .current_dir(dir)
        .args(&args)
        .output()
        .expect("markdag を起動できる");
    Ran {
        exit: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8(output.stdout).expect("stdout は UTF-8"),
        stderr: String::from_utf8(output.stderr).expect("stderr は UTF-8"),
        html: out.map(|path| fs::read_to_string(path).expect("-o に書いたファイルがある")),
    }
}

fn embedded_data(html: &str) -> Value {
    let start = html.find(DATA_OPEN).expect("素材の script がある") + DATA_OPEN.len();
    let end = start + html[start..].find("</script>").expect("script が閉じる");
    serde_json::from_str(&html[start..end]).expect("素材は JSON")
}

fn check_embedded(html: Option<&str>, want: &Value, problems: &mut Vec<String>) {
    unknown_keys(
        want,
        &[
            "keys_include",
            "keys_lack",
            "iconAliases",
            "icons_keys",
            "icons_contain",
        ],
        "embedded",
        problems,
    );
    let Some(html) = html else {
        problems.push("embedded: -o で HTML を書くコマンドでない".into());
        return;
    };
    let data = embedded_data(html);
    let keys: Vec<&str> = data
        .as_object()
        .expect("素材はオブジェクト")
        .keys()
        .map(String::as_str)
        .collect();
    for key in strings(want.get("keys_include")) {
        if !keys.contains(&key.as_str()) {
            problems.push(format!(
                "embedded.keys_include: {key} がない (実際 {keys:?})"
            ));
        }
    }
    for key in strings(want.get("keys_lack")) {
        if keys.contains(&key.as_str()) {
            problems.push(format!("embedded.keys_lack: {key} がある (実際 {keys:?})"));
        }
    }
    if let Some(aliases) = want.get("iconAliases")
        && data.get("iconAliases") != Some(aliases)
    {
        problems.push(format!(
            "embedded.iconAliases: 期待 {aliases}、実際 {:?}",
            data.get("iconAliases")
        ));
    }
    let icons = data.get("icons").and_then(Value::as_object);
    if want.get("icons_keys").is_some() {
        let mut expected = strings(want.get("icons_keys"));
        expected.sort();
        let mut actual: Vec<String> = icons
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default();
        actual.sort();
        if expected != actual {
            problems.push(format!(
                "embedded.icons_keys: 期待 {expected:?}、実際 {actual:?}"
            ));
        }
    }
    if let Some(contain) = want.get("icons_contain").and_then(Value::as_object) {
        for (reference, part) in contain {
            let part = part.as_str().expect("icons_contain の値は文字");
            let svg = icons
                .and_then(|map| map.get(reference))
                .and_then(Value::as_str);
            if !svg.is_some_and(|svg| svg.contains(part)) {
                problems.push(format!(
                    "embedded.icons_contain: {reference} に {part} がない (実際 {svg:?})"
                ));
            }
        }
    }
}

// 1 つのコマンドの期待。opened はブラウザの面 (e2e) が見るので、ここでは欄の名前だけ受け付ける
fn check_step(dir: &Path, command: &str, want: &Value, out_dir: &Path, problems: &mut Vec<String>) {
    unknown_keys(
        want,
        &[
            "exit",
            "stdout",
            "stderr",
            "stderr_has",
            "diagnostic_lines",
            "lacks",
            "embedded",
            "opened",
        ],
        "expect",
        problems,
    );
    let ran = run(dir, command, out_dir);
    let label = format!("「{command}」");
    if let Some(exit) = want.get("exit").and_then(Value::as_i64)
        && i64::from(ran.exit) != exit
    {
        problems.push(format!(
            "{label} exit: 期待 {exit}、実際 {} (stderr: {})",
            ran.exit, ran.stderr
        ));
    }
    if let Some(stdout) = want.get("stdout").and_then(Value::as_str)
        && ran.stdout != stdout
    {
        problems.push(format!(
            "{label} stdout: 期待 {stdout:?}、実際 {:?}",
            ran.stdout
        ));
    }
    if let Some(stderr) = want.get("stderr").and_then(Value::as_str)
        && ran.stderr != stderr
    {
        problems.push(format!(
            "{label} stderr: 期待 {stderr:?}、実際 {:?}",
            ran.stderr
        ));
    }
    for part in strings(want.get("stderr_has")) {
        if !ran.stderr.contains(&part) {
            problems.push(format!(
                "{label} stderr_has: {part:?} が stderr {:?} にない",
                ran.stderr
            ));
        }
    }
    if want.get("diagnostic_lines").is_some() {
        // 診断の 1 行目 (字下げのない行)。字下げした手がかりの行は見ない
        let lines: Vec<&str> = ran
            .stdout
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with(char::is_whitespace))
            .collect();
        let expected = strings(want.get("diagnostic_lines"));
        let fits = lines.len() == expected.len()
            && lines
                .iter()
                .zip(&expected)
                .all(|(line, prefix)| line.starts_with(prefix.as_str()));
        if !fits {
            problems.push(format!(
                "{label} diagnostic_lines: 期待 {expected:?}、実際 {lines:?}"
            ));
        }
    }
    for word in strings(want.get("lacks")) {
        if ran.stdout.contains(&word) {
            problems.push(format!("{label} lacks: stdout に {word} がある"));
        }
    }
    if let Some(embedded) = want.get("embedded") {
        check_embedded(ran.html.as_deref(), embedded, problems);
    }
}

fn run_example(name: &str) {
    let dir = cli_root().join(name);
    let spec = load_expect(&dir);
    let mut problems = Vec::new();
    unknown_keys(
        &spec,
        &["kind", "checks", "command", "commands", "expect"],
        name,
        &mut problems,
    );
    let out_dir = tempfile::tempdir().expect("一時ディレクトリ");
    let steps: Vec<(String, Value)> = match (spec.get("command"), spec.get("commands")) {
        (Some(command), None) => vec![(
            command.as_str().expect("command は文字").trim().to_string(),
            spec.get("expect").cloned().expect("expect がある"),
        )],
        (None, Some(Value::Array(items))) => items
            .iter()
            .map(|item| {
                unknown_keys(item, &["command", "expect"], "commands[]", &mut problems);
                (
                    item["command"]
                        .as_str()
                        .expect("command は文字")
                        .trim()
                        .to_string(),
                    item["expect"].clone(),
                )
            })
            .collect(),
        _ => panic!("{name}: command か commands のどちらか 1 つを書く"),
    };
    assert!(!steps.is_empty(), "{name}: コマンドがない");
    for (command, want) in &steps {
        check_step(&dir, command, want, out_dir.path(), &mut problems);
    }
    // 書き出しは一時ディレクトリだけで、例のディレクトリにファイルを増やさない
    for leftover in ["out.html", "doc/out.html"] {
        if dir.join(leftover).exists() {
            problems.push(format!("例のディレクトリに {leftover} が残った"));
        }
    }
    assert!(
        problems.is_empty(),
        "受け入れの例 cli/{name} が期待と合わない:\n{}",
        problems.join("\n")
    );
}

macro_rules! examples {
    ($($test:ident => $name:literal),* $(,)?) => {
        const LISTED: &[&str] = &[$($name),*];
        $(
            #[test]
            fn $test() {
                run_example($name);
            }
        )*
    };
}

examples! {
    check_clean => "check-clean",
    check_diagnostics => "check-diagnostics",
    check_ref_missing => "check-ref-missing",
    html_bake_svg => "html-bake-svg",
    html_missing_svg => "html-missing-svg",
    html_png => "html-png",
    html_ref_relative_path => "html-ref-relative-path",
    html_set_only => "html-set-only",
    html_unused_alias => "html-unused-alias",
}

#[test]
fn every_example_is_listed() {
    let mut found: Vec<String> = fs::read_dir(cli_root())
        .expect("cli の例のディレクトリがある")
        .map(|entry| entry.expect("ディレクトリの項目").path())
        .filter(|path| path.join("expect.yaml").is_file())
        .map(|path| {
            path.file_name()
                .expect("名前")
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    found.sort();
    let mut listed: Vec<String> = LISTED.iter().map(|name| name.to_string()).collect();
    listed.sort();
    assert_eq!(found, listed, "examples! の一覧と cli/ の例がずれている");
}
