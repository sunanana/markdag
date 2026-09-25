---
markdag:
    tasks:
        cycle: [' ', '/', 'x']
    rules:
        taskToggle:
            readonlyGroups:
                - locked
    hooks:
        $ref: ./watch.hooks.js
---

# Root

## Work

- [ ] Task A
- [x] Task B

## Fixed %locked

- [ ] Task C

