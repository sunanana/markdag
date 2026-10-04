---
title: エピック「アプリ刷新」複数チームの依存
markdag:
    relations:
        chain:
            - $kickoff --> 情報設計 --> デザインシステム更新
            - $freeze --> 回帰テスト
            - $store --> App Store 審査
        # 画面のデザインが決まると、3 つのプラットフォームが同時に着手する
        fork:
            - デザインシステム更新 --> ホーム画面 & 検索画面 & 商品詳細画面 & 購入フロー
            - ホーム画面 --> iOS/ホーム & Android/ホーム & Web/ホーム
            - 検索画面 --> iOS/検索 & Android/検索 & Web/検索
            - 商品詳細画面 --> iOS/商品詳細 & Android/商品詳細 & Web/商品詳細
            - 購入フロー --> iOS/購入 & Android/購入 & Web/購入
            - $kickoff --> 認証の刷新 & 商品検索API & おすすめAPI & 購入API & 通知API
            - $freeze --> 端末別テスト & 決済の実機テスト & アクセシビリティ監査
            - $store --> Google Play 審査 & Web の公開準備
            - $launch --> 公開後/*
        # プラットフォームごとに、画面がそろうとテスト配布へ集まる
        join:
            - iOS/ホーム & iOS/検索 & iOS/商品詳細 & iOS/購入 & iOS/プッシュ通知 --> TestFlight 配布
            - Android/ホーム & Android/検索 & Android/商品詳細 & Android/購入 & Android/プッシュ通知 --> 社内テスト配布
            - Web/ホーム & Web/検索 & Web/商品詳細 & Web/購入 --> ステージング反映
            - TestFlight 配布 & 社内テスト配布 & ステージング反映 & APIドキュメント公開 --> $freeze
            - QA/* --> $store
            - リリース/* --> $launch
        # API ができていないと、画面をつなげない
        depends:
            - おすすめAPI --> iOS/ホーム
            - おすすめAPI --> Android/ホーム
            - おすすめAPI --> Web/ホーム
            - 商品検索API --> iOS/検索
            - 商品検索API --> Android/検索
            - 商品検索API --> Web/検索
            - 購入API --> iOS/購入
            - 購入API --> Android/購入
            - 購入API --> Web/購入
            - 通知API --> iOS/プッシュ通知
            - 通知API --> Android/プッシュ通知
            - 認証の刷新 --> iOS/新ナビゲーション
            - 認証の刷新 --> Android/新ナビゲーション
            - 購入API --> APIドキュメント公開
            - アクセシビリティ確認 --> アクセシビリティ監査
    groups:
        design:
            label: デザイン
            color: "#E8833A"
            boundary: true
        api:
            label: API
            color: "#D64545"
            boundary: true
        ios:
            label: iOS
            color: "#3B7DD8"
            boundary: true
        android:
            label: Android
            color: "#2E9E6B"
            boundary: true
        web:
            label: Web
            color: "#8A5FC2"
            boundary: true
        qa:
            label: QA
            color: "#E0A100"
            boundary: true
    branches:
        - デザイン
        - API
        - iOS
        - Android
        - Web
        - QA
        - リリース
---

# アプリ刷新

## **キックオフ** $kickoff

## デザイン %design
- 情報設計
- デザインシステム更新
- ホーム画面
- 検索画面
- 商品詳細画面
- 購入フロー
- アクセシビリティ確認

## API %api
- 認証の刷新
- 商品検索API
- おすすめAPI
- 購入API
- 通知API
- APIドキュメント公開

## iOS %ios
- 新ナビゲーション
- ホーム
- 検索
- 商品詳細
- 購入
- プッシュ通知
- TestFlight 配布

## Android %android
- 新ナビゲーション
- ホーム
- 検索
- 商品詳細
- 購入
- プッシュ通知
- 社内テスト配布

## Web %web
- ホーム
- 検索
- 商品詳細
- 購入
- ステージング反映

## **機能凍結** $freeze

## QA %qa
- 回帰テスト
- 端末別テスト
- 決済の実機テスト
- アクセシビリティ監査

## **ストア申請** $store

## リリース
- App Store 審査
- Google Play 審査
- Web の公開準備

## **同時リリース** $launch

## 公開後
- クラッシュ監視
- ストアレビューへの返信
- 利用状況の分析
