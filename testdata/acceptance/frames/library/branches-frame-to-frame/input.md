---
title: 枝をまたぐ、枠から枠
markdag:
    relations:
        depends:
            - 設計/画面 --> 実装/画面
    groups:
        a:
            label: 画面担当
            boundary: true
            members:
                - 設計/*
                - 実装/*
---

# 枝をまたぐ、枠から枠

## 設計
- 画面
- API

## 実装
- 画面
- サーバ

## 告知
