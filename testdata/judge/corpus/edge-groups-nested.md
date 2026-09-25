---
markdag:
    groups:
        outer:
            label: 外側
            color: "#3B7DD8"
            boundary: true
        inner:
            label: 内側
            color: "#D64545"
            boundary: true
            members:
                - Deep
        num2026:
            label: 数字を含む名前
    relations:
        fork:
            - Root --> A --> B
---

# Root

## A %outer

### Deep %inner

- [ ] Leaf 1
- [ ] Leaf 2 %inner

## B %outer %num2026

## C

