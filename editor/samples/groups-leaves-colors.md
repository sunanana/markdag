---
title: 葉だけの指定と色だけのグループ
markdag:
    groups:
        # 枠のないグループは、ノードの左の色の帯と凡例だけになる (担当者など、構造と関係なく付けるもの)
        alice:
            label: 佐藤
            color: "#E07A5F"
        bob:
            label: 鈴木
            color: "#3D85C6"
        carol:
            label: 高橋
            color: "#81B29A"
        # 4月/基盤/* と 5月/基盤/* は、それぞれの基盤の配下の葉。見出しの「基盤」は入らないので、月ごとに別の枠になる
        infra:
            label: 基盤の作業
            color: "#6B7280"
            boundary: true
            members:
                - 4月/基盤/*
                - 5月/基盤/*
---

# 四半期のロードマップ

## 4月
### 基盤
- DB の移行 %alice
- CI の整備 %bob
### 機能
- 検索の改善 %alice
- 通知 %carol

## 5月
### 基盤
- 監視の強化 %bob
- バックアップの見直し %carol
### 機能
- エクスポート %carol
- 招待機能 %alice
