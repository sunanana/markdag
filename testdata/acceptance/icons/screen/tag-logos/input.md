---
markdag:
    icons:
        gh: simple-icons:github
        grafana: simple-icons:grafana
        sentry: simple-icons:sentry
        pager: simple-icons:pagerduty
    tags:
        display: always
        keys:
            tool:
                type: string
                multiple: true
                icons:
                    grafana: grafana
                    sentry: sentry
                    gh: gh
            oncall:
                type: boolean
                icon: pager
            alert:
                type: string
                icon: pager
                icons:
                    sentry: sentry
            owner:
                type: string
---

# タグのロゴ

## 監視
- [ ] 値のロゴを順に #tool:grafana,sentry,jira
- [ ] 表にない値だけ #tool:datadog
- [ ] boolean のキーの印 #oncall
- [ ] キーの印と値のロゴ #alert:sentry
- [ ] 対応のないキー #owner:suna
