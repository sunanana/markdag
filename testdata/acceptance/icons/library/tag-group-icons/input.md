---
markdag:
    icons:
        grafana: simple-icons:grafana
        sentry: simple-icons:sentry
        pagerduty: simple-icons:pagerduty
    groups:
        ops:
            label: 運用
            icon: grafana
        design:
            label: デザイン
            icon: simple-icons:figma
    tags:
        keys:
            tool:
                type: string
                multiple: true
                icons:
                    grafana: grafana
                    sentry: sentry
            oncall:
                type: boolean
                icon: pagerduty
            alert:
                type: string
                icon: pagerduty
                icons:
                    sentry: sentry
---

# ルート

## 監視 %ops
- [ ] 例外 #tool:grafana,sentry,jira #oncall #alert:sentry

## 画面 %design
