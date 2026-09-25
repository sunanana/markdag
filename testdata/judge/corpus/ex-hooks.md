---
title: 規則とフックで操作を止める例
markdag:
    relations:
        chain:
            - 設計 --> 実装 --> テスト --> $release
    # コードを書かずに使える規則。フックより先に評価する
    rules:
        taskToggle:
            # 上流 (自分と祖先に入ってくる線) のタスクが終わるまで、チェックを付けさせない
            requireUpstreamDone: true
        fold:
            # マイルストーンの枝は閉じさせない
            keepMilestonesOpen: true
    hooks:
        # 規則では書けない見せ方の部分を受け持つモジュール。読み込むのは呼び出し側で、markdag はここの名前を見るだけ
        $ref: ./task-guard.hooks.js
    details:
        display: hover
---

# リリースまで

## [ ] 設計

- [ ] 画面の流れを決める
    > 上流がないので、いつでもチェックできる

## [ ] 実装

- [ ] 画面を作る

## [ ] テスト

- [ ] 受け入れの確認
    > 「設計」と「実装」が終わるまで、このチェックは止められる

## **リリース** $release

- [ ] 公開の連絡
    > マイルストーンなので、この枝は閉じられない
