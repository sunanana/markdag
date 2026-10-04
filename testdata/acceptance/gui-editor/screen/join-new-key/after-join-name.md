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
    relations:
        depends:
            - 画面 --> 公開
        join:
            - 画面 & API --> 結合
---

# 計画

## 設計 %g1
- 画面 #owner:alice
- API
  > 認証つき

## 結合

## 実装
- フロント
- バック

## 公開
