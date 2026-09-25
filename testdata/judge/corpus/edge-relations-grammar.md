---
markdag:
    relations:
        depends:
            - Root/** --> Sink
            - A --> B & C
            - A & B --> C & D
            - (A)
            - Leafless/* --> Sink
            - CI\/CD --> Sink
            - \$100 budget --> Sink
            - \(draft) --> Sink
            - R&D --> Sink
            - A-->B
            - "- Launch #urgent --> Review"
            - A/* --> A
            - $dupid --> Sink
            - 12
        chian:
            - A --> B
        chain:
            - A --> B --> C
    groups:
        g:
            members:
                - (A)
                - Missing
    branches:
        - A/*
        - A
        - Root/A
---

# Root

## A

- A1
- A2

## B

## C

## D

## Sink

## Leafless

## CI/CD

## $100 budget

## (draft)

## R&D

## Launch #urgent

## Review

## X $dupid

## Y $dupid

