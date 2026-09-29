---
title: 一部だけ見える、中から外
markdag:
    relations:
        depends:
            - 設計/画面 --> 告知
    groups:
        a:
            label: 画面担当
            boundary: true
            members:
                - 設計/*
                - 実装/*
---

# 一部だけ見える、中から外

## 設計
- 画面
- API

## 実装 <!-- markmap: fold -->
- フロント
- バック

## 告知
