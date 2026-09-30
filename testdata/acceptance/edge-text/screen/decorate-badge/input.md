---
title: decorateNode の飾り (アプリの色の本文とバッジ) と薄く表示
markdag:
    relations:
        chain:
            - 受付 --> 対応
        depends:
            - 至急 作業中の行 --> 対応する
    tasks:
        dim:
            states: ['x', '-']
---

# アプリの飾り

## 受付
- [ ] 至急 作業中の行
- [x] 至急 完了の行
- [ ] 普通の行

## 対応
- [ ] 対応する
