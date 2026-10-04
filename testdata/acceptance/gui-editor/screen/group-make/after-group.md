---
title: GUI 編集の例
markdag:
    editor:
        mode: switch
        default: edit
    legend:
        position: bottom-right
    groups:
        g1:
            label: 設計
            color: "#3366cc"
            boundary: true
        group1:
            label: グループ 1
            color: "#3B7DD8"
            boundary: true
    relations:
        depends:
            - 画面 --> 公開
---

# 計画

## 設計 %g1
- 画面 #owner:alice
- API
  > 認証つき

## 実装
- フロント %group1
- バック %group1

## 公開
