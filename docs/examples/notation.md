---
title: 新機能リリースの流れ
markdag:
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
    groups:
        # 本文で %design を付けたノードと、その配下がこのグループになる
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
    # タグの値の型。tags.keys の type から名前で指す。組み込みの型は string, number, integer, boolean, enum, date, datetime, time, duration, nodeId
    types:
        priority:
            type: enum
            values: [high, medium, low]
    # タグ (本文の #キー:値。値がなければ #キー) の表示と検査。タグ自体は定義なしで使える
    tags:
        # タグの見せ方。always は常に出す、hover は重ねたとき、click は印のクリック、never は出さない
        display: always
        # keys に定義したキーだけ値を検査する。lint は知らせる重大度 (warning / error)、unknownKey は定義のないキーの扱い (allow / deny)
        lint: warning
        unknownKey: allow
        keys:
            owner:
                type: string
                multiple: true
            priority:
                type: priority
    # 詳細 (引用ブロック) の見せ方。always は最初から開いて表示、hover は重ねたとき、click は印のクリック
    details:
        display: hover
    # タスク。cycle はクリックで進む記号の順 (省略すると [ ] と [x] の行き来)。dim は薄く表示する状態と、そのノードでの詳細とタグの見せ方
    tasks:
        cycle: [' ', '/', 'x']
        dim:
            states: ['x', '-']
            details: hover
            tags: keep
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
---

# 新機能リリースの流れ

## 要件定義 $req

## 設計 %design
### 画面設計
### API設計

## 実装 %build
### フロントエンド
- [x] 一覧画面
- [ ] 登録フォーム #owner:alice #priority:high
    > 送信先は登録API。入力の誤りは、その項目のすぐ下に出す。
- [ ] テスト %qa
### バックエンド
- [x] 検索API #owner:bob
- [/] 登録API #owner:alice,bob
- [-] 削除API
    > 今回の範囲から外した。
- [ ] テスト %qa

## 検証
- [ ] 結合テスト
- [ ] 受入テスト
    > 要件定義で合意した受入条件を、本番と同じ構成で確かめる。
    >
    > - 登録から公開まで 3 分以内
    > - 主要ブラウザの最新版で動く

## **公開** $release
