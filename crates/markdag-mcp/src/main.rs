// markdag の MCP サーバーの入口。stdio で 1 つのクライアントとやり取りし、クライアントが閉じたら終わる。
// 道具の中身はライブラリ側 (markdag_mcp::server) が持ち、ここは実行環境 (tokio の単一スレッド) と転送路の用意だけを受け持つ。
// stdout は MCP の通信路なので、知らせは stderr にだけ書く。
use std::process::ExitCode;

use rmcp::ServiceExt;
use rmcp::transport::stdio;

use markdag_mcp::server::MarkdagServer;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let service = match MarkdagServer::new().serve(stdio()).await {
        Ok(service) => service,
        Err(error) => {
            eprintln!("markdag-mcp: MCP の初期化に失敗しました: {error}");
            return ExitCode::FAILURE;
        }
    };
    match service.waiting().await {
        Ok(_) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("markdag-mcp: サーバーが異常終了しました: {error}");
            ExitCode::FAILURE
        }
    }
}
