---
title: 新機能エピック
markmap:
    colorFreezeLevel: 2
    initialExpandLevel: 3
markdag:
    relations:
        join:
            - 仕様策定/* --> 開発完了
        chain:
            - 開発完了 --> リリース準備 --> リリースノート作成 --> リリース --> 効果測定
        depends:
            - 登録API --> 登録画面
    groups:
        backend:
            label: バックエンド
            color: "#D64545"
            boundary: true
        frontend:
            label: フロントエンド
            color: "#3B7DD8"
            boundary: true
        qa:
            label: QA
            color: "#E0A100"
---

# 新機能エピック

## 仕様策定

### 画面開発 #frontend
- [x] 一覧画面
- [ ] 登録画面

### API開発 #backend
- [x] 登録API `POST /items`
- [ ] 削除API `DELETE /items/:id`
- [ ] 一覧取得API `GET /items`

## **開発完了**

## リリース準備
- [ ] デプロイ手順の確認 #backend
- [ ] ロールバック手順の確認 #backend
- [ ] 受け入れテスト #qa

## リリースノート作成

## **リリース**

## 効果測定 #backend #frontend
