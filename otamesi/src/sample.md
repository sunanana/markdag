---
title: Otamesi
markdag:
    tasks:
        cycle: [' ', '/', 'x']
        dim:
            states: ['x', '-']
            details: hover
    tags:
        display: hover
        keys:
            owner:
                type: enum
                values: [sato, suzuki, tanaka, yamada]
                description: 担当者
            priority:
                type: enum
                values: [urgent, high, medium, low]
                description: 優先度
            due:
                type: date
                description: 期日
            estimate:
                type: integer
                min: 1
                max: 8
                description: 見積もり (ポイント)
    groups:
        web:
            label: Web アプリ
            color: "#5E6AD2"
            boundary: true
        api:
            label: API
            color: "#0E9FB8"
            boundary: true
        infra:
            label: インフラ
            color: "#E07B28"
            boundary: true
    relations:
        depends:
            - $OTM-6 --> $OTM-2
            - $OTM-2 --> $OTM-5
            - $OTM-3 --> $OTM-4
            - $OTM-9 --> $OTM-8
            - $OTM-2 --> $OTM-12
        join:
            - $OTM-5 & $OTM-4 & $OTM-9 --> $beta
    rules:
        taskToggle:
            requireUpstreamDone: true
    details:
        display: hover
---

# Otamesi

## Web アプリ %web
- [x] ログイン画面のデザイン #owner:sato #priority:high #estimate:3 $OTM-1
    > Figma のワイヤーを元にレイアウトを確定する
- [/] サインアップフォーム #owner:suzuki #priority:high #due:2026-10-10 #estimate:5 $OTM-5
    > 入力エラーは各フィールドの直下に出す
    - [x] バリデーションの実装 $OTM-10
    - [ ] エラーメッセージの文言 $OTM-11
- [ ] ダッシュボードの一覧 #owner:sato #priority:medium #due:2026-10-20 #estimate:5 $OTM-4
    > 最新 20 件を更新日の新しい順に出す。空のときは作成ボタンを大きく出す
- [ ] ダークモード対応 #owner:sato #priority:low $OTM-13

## API %api
- [/] サインアップ API #owner:tanaka #priority:urgent #due:2026-10-05 #estimate:5 $OTM-2
    > メール確認トークンを発行して送信する
- [ ] 一覧取得 API #owner:tanaka #priority:medium #estimate:3 $OTM-3
- [ ] レート制限 #owner:tanaka #priority:high #due:2026-10-12 #estimate:2 $OTM-12
    > サインアップは IP ごとに 1 分 5 回まで
- [-] GraphQL の検証 #owner:yamada #priority:low $OTM-7
    > REST で進めることにしたので中止

## インフラ %infra
- [x] DB スキーマの作成 #owner:yamada #priority:high #estimate:2 $OTM-6
- [ ] ステージング環境 #owner:yamada #priority:medium #due:2026-10-15 #estimate:3 $OTM-9
- [ ] 監視ダッシュボード #owner:suzuki #priority:low $OTM-8

## **ベータ公開** $beta
