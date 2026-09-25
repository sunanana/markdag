---
markdag:
    types:
        $ref:
            - ./types.yaml
            - ./missing-types.yaml
        level:
            type: integer
            min: 1
            max: 5
            description: 重要度
        high:
            type: level
            min: 3
        loopA:
            type: loopB
        loopB:
            type: loopA
        string:
            type: enum
            values: [x]
        badnum:
            type: number
            pattern: "^x$"
        short:
            type: string
            minLength: 2
            maxLength: 4
    tags:
        keys:
            n:
                type: number
                min: -2
                max: 10
            i:
                type: integer
            lv:
                type: high
            mix:
                type: [level, enum]
                values: [none]
            dt:
                type: datetime
                min: 2026-01-01T00:00
            t:
                type: time
                max: "18:00"
            d:
                type: duration
                min: 1h
            ref:
                type: nodeId
            due:
                type: date
                min: 2000-01-01
            s:
                type: short
            single:
                type: string
            loop:
                type: loopA
            priority:
                type: priority
---

# Root

## Target $t1

## Dup $dup

## Dup 2 $dup

- [ ] N #n:-1.5 #i:3.0 #lv:4 #mix:none
- [ ] N2 #n:3.0 #i:-1 #lv:1 #mix:2 #mix:9
- [ ] T #dt:"2026-10-01 09:30" #t:24:00
- [ ] T2 #dt:2026-10-01T09:30:15+09:00 #t:09:30:00
- [ ] T3 #dt:2025-12-31T23:59 #t:18:01
- [ ] D #d:1.5h #ref:$t1
- [ ] D2 #d:30m #ref:$nope
- [ ] D3 #d:2w #ref:$dup
- [ ] D4 #d:3
- [ ] Due #due:2026-02-30
- [ ] Due2 #due:2024-02-29
- [ ] Due3 #due:0099-01-01
- [ ] Due4 #due:1999-12-31
- [ ] S #s:abcd #single:a,b #n
- [ ] S2 #s:a #single
- [ ] S3 #s:abcdef #priority:low #loop:x

