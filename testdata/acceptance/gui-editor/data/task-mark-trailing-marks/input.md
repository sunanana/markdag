---
markdag:
    groups:
        g1:
            label: 当日の組
    relations:
        depends:
            - 見積もりを取る --> 鍵の返却
            - $hand --> 鍵の返却
---

# 引っ越し

## 準備
- 見積もりを取る #owner:alice
- 荷物を運ぶ $hand

## 当日
- 鍵の返却 %g1 #owner:bob $key
