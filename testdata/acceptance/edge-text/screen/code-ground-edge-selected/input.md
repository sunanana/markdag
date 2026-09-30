---
title: 線を選んでいる間の code と pre の地
markdag:
    relations:
        depends:
            - $done --> $recv
    tasks:
        dim:
            states: ['x', '-']
---

# code と pre の地の透かし

## 書式
- [ ] 作業中の `code` と ==mark==
    ```
    pre の中の文字
    ```
- [x] 完了の `code` と ==mark== $done
    ```
    pre の中の文字
    ```
- [x] 外れて完了の `code`

## 受け側
- [ ] 受け取る `code` $recv
