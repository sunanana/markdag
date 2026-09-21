---
title: 新機能リリースの流れ
# 参照はノードの 1 行目の文字と完全一致で書く。行末に $id を付けたノードは $名前 でも指せる
relations:
    # 1 つのノードから複数へ分かれる。X/* は X の配下の葉
    fork:
        - $req --> 設計/*
    # 複数のノードから 1 つへ合流する。& で項を並べ、同じ名前は 親/子 で区別する
    join:
        - フロントエンド/テスト & バックエンド/テスト --> 検証
    # 順につなぐ。--> は何段でも続けられる
    chain:
        - 設計 --> 実装 --> 検証 --> $release
    # 先に終わっていてほしい、という依存を足す
    depends:
        - 登録API --> 登録フォーム
markdag:
    # 詳細 (引用ブロック) の見せ方。click / hover / open
    details: hover
    # 凡例。position は置く隅 (top-right / top-left / bottom-right / bottom-left)、display は出す項目。出さないなら display: false
    legend:
        position: top-right
        display:
            - groups
            - branches
    # 色を分ける枝の起点。配下は起点の色を継ぎ、起点の中の起点 (フロントエンド) はそこから別の色になる
    branches:
        - 要件定義
        - 設計
        - 実装
        - フロントエンド
        - 検証
        - 公開
groups:
    # 本文で #design を付けたノードと、その配下がこのグループになる
    design:
        label: 設計チーム
        color: "#3B7DD8"
        # 枠で囲む
        boundary: true
    build:
        label: 開発チーム
        color: "#8A5FC2"
        boundary: true
    # タグを書かないノードは、members のセレクタで入れる。X/** は X 自身と配下
    qa:
        label: 品質保証
        color: "#E0A100"
        members:
            - 検証/**
---

# 新機能リリースの流れ

## 要件定義 $req

## 設計 #design
### 画面設計
### API設計

## 実装 #build
### フロントエンド
- [x] 一覧画面
- [ ] 登録フォーム
    > 送信先は登録API。入力の誤りは、その項目のすぐ下に出す。
- [ ] テスト #qa
### バックエンド
- [x] 検索API
- [ ] 登録API
- [ ] テスト #qa

## 検証
- [ ] 結合テスト
- [ ] 受入テスト
    > 要件定義で合意した受入条件を、本番と同じ構成で確かめる。
    >
    > - 登録から公開まで 3 分以内
    > - 主要ブラウザの最新版で動く

## **公開** $release
