---
markdag:
    editor:
        mode: switch
        default: edit
    legend:
        display: false
    groups:
        g1:
            label: 当日の組
            color: "#3b7dd8"
            boundary: true
    relations:
        depends:
            - 見積もりを取る --> 鍵の返却
---

# 引っ越し

## 準備
- [ ] 見積もりを取る

## 当日 %g1
- 鍵の返却
