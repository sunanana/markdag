---
title: 色のあるグループの色の帯と、詳細の印 (詳細はノードの中に開かない)
markdag:
    relations:
        chain:
            - 起点 --> 終点
        depends:
            - 上の端 --> まとめる
    groups:
        team:
            label: 開発
            color: "#3B7DD8"
    tasks:
        dim:
            states: ['x', '-']
---

# 色の帯と詳細の印

## 起点
- [ ] 上の端
- [ ] 作業中の行 %team
    > 詳細の文字
- [x] 完了の行 %team
    > 詳細の文字

## 終点
- [ ] まとめる
