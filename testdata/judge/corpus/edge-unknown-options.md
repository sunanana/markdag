---
title: 123
markdag:
    detail:
        display: always
    details:
        display: sometimes
    legend: true
    groups:
        a:
            colour: "#fff"
            color: まっか
            members: A
    tags:
        display: never
        keys:
            owner:
                type: nope
relations:
    depends:
        - A --> B
Markdag:
    x: 1
---

# Root

## A #owner:alice

## B

