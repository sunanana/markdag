---
title: 単体 HTML の、色のないグループの文字ラベルの絵文字と開いた詳細
markdag:
    relations:
        chain:
            - 始め --> 終わり
        depends:
            - 担当を決める --> 全部そろう
    groups:
        hot:
            label: 🔥急ぎ
        family:
            label: 👨‍👩‍👧家族
    details:
        display: always
    tasks:
        dim:
            states: ['x', '-']
---

# 単体 HTML のラベルの絵文字

## 始め
- [ ] 担当を決める %hot %family
    > 詳細の文字
- [x] 期限を決める %hot %family
    > 詳細の文字

## 終わり
- [ ] 全部そろう
