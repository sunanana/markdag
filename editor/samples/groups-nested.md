---
title: 入れ子の枠
markdag:
    # 見出しに %名前 を付けると、その見出しと配下がグループになる。枠の中に別の枠を入れられる
    groups:
        dev:
            label: 開発チーム
            color: "#8A5FC2"
            boundary: true
        front:
            label: フロントエンド
            color: "#3B7DD8"
            boundary: true
        back:
            label: バックエンド
            color: "#D64545"
            boundary: true
---

# アプリ開発

## 企画
- 要件の整理
- 画面の方針

## 開発 %dev
### 画面 %front
- 一覧画面
- 詳細画面
### API %back
- 一覧API
- 詳細API
### 結合
- 結合テスト

## リリース
