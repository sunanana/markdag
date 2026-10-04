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
            label: 設計班
            color: "#2E9E6B"
            boundary: false
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
- フロント %g1
- バック %g1

## 公開
