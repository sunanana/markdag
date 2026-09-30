---
title: 本文のリンクと code と mark、リンクの中の code
markdag:
    relations:
        chain:
            - 書式 --> 中間 --> 受け側
        depends:
            - 書式 --> 受け側
    tasks:
        dim:
            states: ['x', '-']
---

# リンクと code と mark

## 書式
- [ ] 作業中の [リンク](https://example.com) と `code` と ==mark== と [`code` を含むリンク](https://example.com)
- [x] 完了の [リンク](https://example.com) と `code` と ==mark== と [`code` を含むリンク](https://example.com)

## 中間
- [ ] 中間の行

## 受け側
- [ ] 受け取る
