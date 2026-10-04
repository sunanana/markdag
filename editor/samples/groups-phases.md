---
title: 工程ごとの枠を chain でつなぐ
markdag:
    relations:
        # 工程の順番。選考と入社準備は前の工程の枠の中には入らず、枠の外で線がつながる
        chain:
            - 募集 --> 選考 --> 入社準備
        depends:
            - 最終面接 --> 内定通知
    groups:
        recruit:
            label: 募集
            color: "#3B7DD8"
            boundary: true
        select:
            label: 選考
            color: "#8A5FC2"
            boundary: true
        onboard:
            label: 入社準備
            color: "#2E9E6B"
            boundary: true
---

# 採用プロセス

## 募集 %recruit
- 求人票の作成
- 媒体への掲載

## 選考 %select
- 書類選考
- 一次面接
- 最終面接

## 入社準備 %onboard
- 内定通知
- 機材の手配
