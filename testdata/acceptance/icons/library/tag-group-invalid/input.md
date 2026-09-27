---
markdag:
    icons:
        github: simple-icons:github
        logo: ./logo.svg
        fire: 🔥
    groups:
        a:
            icon: ./logo.svg
        b:
            icon: fire
        c:
            icon: GitHub
        d:
            icon: 🔥
    tags:
        keys:
            tool:
                type: string
                icons:
                    github: simple-icons:github
            platform:
                type: enum
                values: [ios, web]
                icons:
                    android: github
            oncall:
                type: boolean
                icon: simple-icons:pagerduty
---

# ルート

## A %a %b %c %d
- [ ] B #tool:github #platform:ios #oncall
