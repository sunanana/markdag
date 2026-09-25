// 結合試験が共有する道具。markdag のバイナリをリポジトリの根で動かし、入力はリポジトリの文書 (コーパスと docs/examples) か
// 一時ディレクトリに書いた文書を使う。ネットワークとブラウザは使わない。
// html を含むバイナリは dist/markdag.core.iife.js と dist/style.css を焼き込むので、これらの試験の前に
// リポジトリの根で `npm run build` が済んでいる必要がある (ないと build.rs が手順を添えてビルドを止める)。
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use assert_cmd::Command;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// リポジトリの根を作業ディレクトリにした markdag のコマンド
pub fn markdag() -> Command {
    let mut command = assert_cmd::cargo::cargo_bin_cmd!("markdag");
    command.current_dir(repo_root());
    command
}

/// 一時ディレクトリの下の相対パスにファイルを書く (途中のディレクトリも作る)
pub fn write(dir: &Path, relative: &str, content: &str) -> PathBuf {
    let path = dir.join(relative);
    fs::create_dir_all(path.parent().expect("ファイルの親がある")).expect("ディレクトリを作れる");
    fs::write(&path, content).expect("一時ファイルに書ける");
    path
}
