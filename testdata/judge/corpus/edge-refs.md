---
markdag:
    relations:
        depends:
            - $missing --> A
            - Amb --> A
            - Ambiguous --> B
            - Root/A/Child --> B
            - (A)/* --> B
            - (Root)/** --> Z
        chain:
            - A --> B --> C
    groups:
        g1:
            members:
                - A
                - Nope
    branches:
        - A
        - Nope
---

# Root

## A

- Child
- Child

## B

## Amb 1

## Amb 2

## Ambiguous

## C

