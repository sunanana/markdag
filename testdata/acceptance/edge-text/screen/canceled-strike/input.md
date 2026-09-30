---
title: 中止のタスクの取り消し線と、本文の打ち消し線と下線
markdag:
    relations:
        chain:
            - 前 --> 間 --> 後
        depends:
            - 前 --> 後
    details:
        display: always
    tasks:
        dim:
            states: ['x', '-']
---

# 取り消し線と下線

## 前
- [ ] 作業中の ~~打ち消し~~ と ++挿入++
    > 詳細の <del>削除</del> と <u>下線</u>
- [x] 完了の ~~打ち消し~~ と ++挿入++
    > 詳細の <del>削除</del> と <u>下線</u>
- [-] 中止した作業

## 間
- [ ] 間の作業

## 後
- [ ] 後の作業
