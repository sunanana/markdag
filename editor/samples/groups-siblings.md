---
title: 隣り合う兄弟だけの枠
markdag:
    groups:
        # 名前を並べると、そのノードだけがグループになる。隣り合う兄弟は 1 つの枠にまとまる
        target:
            label: 今回の対象
            color: "#E0A100"
            boundary: true
            members:
                - 会員登録画面
                - パスワード再設定画面
        # X/* は X の配下の葉。X 自身は入らない
        metrics:
            label: 計測
            color: "#2E9E6B"
            boundary: true
            members:
                - 計測/*
---

# 新規登録の改善

## 画面
- ログイン画面
- 会員登録画面
- パスワード再設定画面
- 設定画面

## 計測
- 登録率
- 離脱率
