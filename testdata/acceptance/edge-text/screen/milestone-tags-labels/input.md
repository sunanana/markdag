---
title: タグ、色のないグループの文字ラベル、マイルストーンの ◆ と薄く表示
markdag:
    relations:
        chain:
            - 始め --> 終わり
        depends:
            - 担当を決める --> 全部そろう
    groups:
        team:
            label: チーム
    tasks:
        dim:
            states: ['x', '-']
---

# タグとマイルストーン

## 始め
- [ ] 担当を決める #owner:alice %team
- [x] 期限を決める #owner:bob %team
- [ ] **作業中のマイルストーン**
- [x] **完了のマイルストーン**

## 終わり
- [ ] 全部そろう
