---
title: 型つきのタグ
markdag:
    types:
        $ref: ./types.yaml
    tags:
        lint: error
        keys:
            priority:
                type: priority
            ticket:
                type: ticket
                unique: true
            due:
                type: date
---

# 型つきのタグ

## 正しい行 #priority:high #ticket:T-1 #due:2026-10-01

## 誤った行 #priority:hgih #ticket:T-1 #due:2026/10/01
