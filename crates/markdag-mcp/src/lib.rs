// markdag の MCP サーバーの本体。道具は server モジュールの MarkdagServer が持ち、
// 転送路は呼び出し側が選ぶ (バイナリは stdio、試験はプロセス内の転送路)。
pub mod server;
