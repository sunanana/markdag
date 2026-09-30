---
title: 単体 HTML の、薄く表示の本文と中止のタスクとリンク
markdag:
    relations:
        chain:
            - 準備 --> 確認
        depends:
            - 中止した作業 --> 通す
    tasks:
        dim:
            states: ['x', '-']
---

# 単体 HTML の薄く表示

## 準備
- [ ] 作業中の行と [リンク](https://example.com) 🎉
- [x] 完了の行と [リンク](https://example.com) 🎉
- [-] 中止した作業

## 確認
- [ ] 通す
