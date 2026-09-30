---
title: ノードの中に開いた詳細 (リンクと入れ子のリストを含む)
markdag:
    relations:
        chain:
            - 調べる --> 作る
        depends:
            - 既存の挙動を読む --> 部品を組み立てる
    details:
        display: always
    tasks:
        dim:
            states: ['x', '-']
---

# 詳細を開いたノード

## 調べる
- [ ] 作業中の行
    > 詳細の文字と [詳細のリンク](https://example.com)
    >
    > - 外の項目
    >     - 入れ子の項目
- [x] 完了の行
    > 詳細の文字と [詳細のリンク](https://example.com)
    >
    > - 外の項目
    >     - 入れ子の項目
- [x] 既存の挙動を読む

## 作る
- [ ] 部品を組み立てる
