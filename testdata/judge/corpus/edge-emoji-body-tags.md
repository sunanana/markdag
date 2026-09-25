---
markdag:
    groups:
        zoo:
            label: 🦁 動物園
    relations:
        depends:
            - "🐈 猫 --> $dog"
---

# Root

## 🐈 猫 %zoo #kind:cat

## 🐕 犬 #owner:🐧,alice %zoo $dog

- [ ] 🐟 魚 #note:"絵文字 🐙 の値" #owner:bob
- 🐦🐦 鳥 $bird #due:2026-10-01

