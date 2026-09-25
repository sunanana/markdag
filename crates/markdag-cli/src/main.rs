// markdag のコマンドラインの入口。markdag-core を直接呼び (wasm を通らない)、ファイルの読み書きはこの crate だけが行う。
// サブコマンドごとの処理は別のモジュールに置き、ここは引数の読み取りと終了コードの受け渡しだけを受け持つ。
// 引数の誤り (clap が知らせる) の終了コードは 2 で、docs/validation.md の「ファイルがない」と同じ扱いになる。
mod check;
mod document;
mod html;
mod parse;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "markdag",
    version = markdag_core::VERSION,
    about = "markdag の文書を検査し、JSON や単体の HTML にする"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 文書を解析して診断を 1 件 1 行で出す。error があれば終了コード 1、ファイルを読めなければ 2
    Check {
        /// 検査する Markdown の文書
        file: PathBuf,
    },
    /// 解析の結果とグラフのモデルを JSON ({ "parsed": ..., "model": ... }) で stdout に出す
    Parse {
        /// 解析する Markdown の文書
        file: PathBuf,
        /// JSON で出す (今の出力の形はこれだけ)
        #[arg(long, required = true)]
        json: bool,
    },
    /// 単体で開ける HTML (ランタイムとスタイルシートを埋めたもの) を書き出す
    Html {
        /// 図にする Markdown の文書
        file: PathBuf,
        /// 書き出す先。省くと stdout
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Check { file } => check::run(&file),
        Command::Parse { file, json: _ } => parse::run(&file),
        Command::Html { file, output } => html::run(&file, output.as_deref()),
    }
}
