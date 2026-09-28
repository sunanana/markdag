# otamesi

markdag の Markdown 1 ファイルをデータにした、Linear / Asana 風のタスク管理の試作。
リスト・ボード・グラフ・Markdown の 4 画面を持ち、どの画面の操作も Markdown の文字列の書き換えになる。
書き換えたあとは `parseDocument` + `buildModel` で読み直し、全画面を描き直す。

## 動かす

リポジトリの直下で:

```sh
npm install
npm run build            # dist/ (markdag 本体と markdag.wasm) を作る。otamesi はこれを使う
npm run otamesi          # 開発サーバー
npm run otamesi:build    # otamesi/dist/otamesi.html (wasm まで埋め込んだ 1 枚の HTML) を作る
npm run otamesi:test     # 書き換え処理の単体テスト
npm run otamesi:typecheck
```

データはブラウザの localStorage に保存する。サイドバー下の「サンプルに戻す」で `src/sample.md` に戻る。

## Markdown とタスク管理の対応

| タスク管理 | Markdown (markdag の記法) |
| --- | --- |
| プロジェクト | 深さ 2 の見出し `## Web アプリ %web`。色と枠は `markdag.groups` |
| Issue | リスト項目のタスク `- [ ] タイトル`。入れ子の項目はサブ Issue |
| 状態 | `[ ]` 未着手、`[/]` 進行中、`[x]` 完了、`[-]` 中止 |
| ID | 行末の `$OTM-5` |
| 担当・優先度・期日・見積もり | タグ `#owner:sato #priority:high #due:2026-10-10 #estimate:5`。型は `markdag.tags.keys` で決め、外れた値は診断に出る |
| 説明 | 項目の 2 行目以降の引用 `> ...` |
| ブロック関係 | `markdag.relations.depends` の `$OTM-2 --> $OTM-5` (OTM-2 が終わってから OTM-5) |
| マイルストーン | 太字だけの見出し `## **ベータ公開** $beta` と、そこへ集まる `join` の線 |
| 完了の制限 | `markdag.rules.taskToggle.requireUpstreamDone`。グラフ上では markdag 自身が、リストとボードではアプリが同じ判断をする |

## markdag の使い方

- `src/doc.ts`: `parseDocument` と `buildModel` の結果 (`OutlineNode.lines`・`task`・`tags`・`refId`、`GraphModel.relations`・`groups`・`tagKeys`・`diagnostics`) を Issue / プロジェクト / マイルストーンに組み替える。
- `src/edit.ts`: 行の書き換え。タグは `formatTag` で書き戻す。frontmatter は `yaml` の Document で書き換えて、コメントや引用符の書き方を残す。
- `src/views/graph.ts`: `render` で文書をそのまま描く。`onChange` でタスクのクリックを受け取り、`hooks.decorateNode` で ID のバッジと「待ち」「選択中」のクラスを付ける。`onDiagnostic` の `hook-rejected` をトーストに出す。
- `src/views/source.ts`: 文書を直接編集し、`diagnostics` をその場に並べる。

## 組み込んで分かったこと

- `toggleTask` は `cycle` の次へ進めるだけなので、任意の状態へ飛ばす処理 (`setTaskMark`) はアプリ側で書いた。
- リスト項目の `lines` は子の項目まで含むが、見出しの `lines` は見出しの 1 行だけ。プロジェクト (見出し) の範囲は次の見出しの行から求めた。
- 行番号は `OutlineNode.lines` と `task.line` が 0 始まり、`NodeTag.at` と `Diagnostic.at` が 1 始まり。
- `decorateNode` のバッジはノードの中にあるので、そのままクリックするとタスクが切り替わる。バッジのクリックはコンテナの capture 段階で止めて詳細を開くようにした。
- グラフでタスクをクリックしたとき、markdag の描き直し (`decorateNode`) は `onChange` より先に走る。アプリの読み直しのあとで `ctx.api.refreshDecorations()` を呼んで「待ち」の印を付け直している。
- relations を書き換える API はないので、依存の追加と削除は frontmatter の YAML を直接編集している。`A & B --> C` のような式から 1 本だけ外す処理もアプリ側で持った。
