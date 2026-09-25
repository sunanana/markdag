---
markdag:
    types:
        priority:
            type: enum
            values: [high, medium, low]
        ticket:
            type: string
            pattern: "^T-\\d+$"
        due:
            type: date
    tags:
        lint: error
        unknownKey: deny
        keys:
            priority:
                type: priority
            ticket:
                type: ticket
                multiple: true
            due:
                type: due
            flag:
                type: boolean
---

# Root

- [ ] A #priority:high #ticket:T-1,T-22 #due:2026-09-24
- [ ] B #priority:urgent #ticket:X-1 #due:2026-13-01
- [ ] C #flag #unknown:1
- [ ] D #flag:yes #priority:"high"

