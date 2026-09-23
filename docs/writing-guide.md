# Writing a markdag document

A markdag document is a [markmap](https://markmap.js.org/)-style Markdown outline plus a YAML frontmatter. The outline is the tree. The frontmatter has one key, `markdag`, that holds lines between nodes (`relations`), groups of nodes (`groups`), tag keys (`tags`), and display options.

markdag is a prototype (0.x). The notation may change until v1. Everything on this page was checked against the current implementation.

Complete documents are in [examples/](examples/). Their node names and comments are in Japanese.

## 1. A working document

This document uses every notation that works today and produces no diagnostics.

```markdown
---
title: Feature release
markdag:
    relations:
        fork:
            - $req --> Design/*
        join:
            - Frontend/Test & Backend/Test --> Verify
        chain:
            - Design --> Build --> Verify --> $release
        depends:
            - Signup API --> Signup form
    groups:
        design:
            label: Design team
            color: "#3B7DD8"
            boundary: true
        qa:
            label: QA
            color: "#E0A100"
            members:
                - Verify/**
    details:
        display: hover
    branches:
        - Requirements
        - Design
        - Build
        - Verify
        - Release
---

# Feature release

## Requirements $req

## Design %design
### Screen design
### API design

## Build
### Frontend
- [x] List screen
- [ ] Signup form #owner:alice #priority:high
    > Posts to the signup API. Show input errors right under each field.
- [ ] Test %qa
### Backend
- [x] Search API #owner:bob
- [ ] Signup API #owner:alice,bob #urgent
- [ ] Test %qa

## Verify
- [ ] Integration test
- [ ] Acceptance test

## **Release** $release
```

## 2. The frontmatter turns the notation on

Groups, tags, `$id`, details and milestones are extracted only when the frontmatter has the key `markdag`. A document whose frontmatter has only `title` (or no frontmatter) is shown exactly as markmap shows it, and `%group`, `#tag` and `$id` stay in the node as plain text. A `markdag:` key with no value is enough to turn extraction on, and it is not reported as a wrong type.

The frontmatter must start on the first line of the file with `---` and end with a line that is only `---`.

## 3. Notation in the body

Nodes are headings and list items. The first line of a node is what `markdag.relations`, `markdag.groups.*.members` and `markdag.branches` refer to.

| Notation | Where | Meaning |
| --- | --- | --- |
| `%name` | End of the first line of a heading or list item | Puts the node and all its descendants in group `name` |
| `#key:value`, `#key` | End of the first line of a heading or list item | A tag on this node only: a key with a value, several values (`#key:a,b`), a value with spaces (`#key:"a b"`), or no value (`#key`). Shown in the node as written |
| `$name` | End of the first line of a heading or list item | An id for the node, referenced as `$name` |
| `> ...` | A blockquote inside a list item | Details of the node, shown on click or hover instead of inside the node. With `details.display: always` they are shown inside the node, at the position where they are written (content written after the blockquote comes after it) |
| `**...**` | The whole first line is one bold span | Marks the node as a milestone |
| `[ ]`, `[/]`, `[x]`, `[-]` | Start of a list item or a heading (`- [ ] Name`, `## [/] Name`) | A task: `[ ]` open, `[/]` in progress, `[x]` done, `[-]` canceled. `[X]` is the same as `[x]`. Clicking the label moves the task to the next mark in `tasks.cycle` (by default `[ ]` and `[x]` alternate, and `[/]` and `[-]` are changed by editing the text), and so does clicking the details when they are shown inside the node (`details.display: always`). A click on a link, or inside a nested element that has its own control (a raw `<input>`, a button), does not change the task. See `tasks` below |

Rules:

- `%name`, `#key:value` and `$name` must be separated from the text by a half-width space, and must be at the end of the line. Several marks can follow each other in any order (`Deploy %backend #owner:alice #urgent $deploy`). One `$id` per node.
- Only the first line of a node is scanned. A mark on the second line of a list item stays as text.
- Group names and tag keys are letters, digits, `_` and `-` in any script (`%開発`, `#担当:山田` work). `$name` is `$` + an ASCII letter + ASCII letters, digits, `_`, `-`. `$日本` is not an id.
- A tag value runs to the next space. `,` separates values (`#owner:alice,bob`). A value in `"…"` may contain spaces and `,` and is one value (`#owner:"山田 太郎"`). `#key:` with nothing after the colon stays as text. The same key written twice on one line joins the values.
- A name made only of digits is not a mark: `Issue #123` and `%50` stay as text. `C#` is not a tag because there is no space before `#`. Write `\%name` or `\#name` to keep a trailing mark as text.
- A full-width space (U+3000) is not a separator. `Deploy　%backend` keeps the mark as text.
- Details work only inside a list item. A blockquote directly under a heading is dropped and does not become details.
- A milestone needs the entire first line in one bold span. `**Release** prep` and `**a** and **b**` are not milestones.
- A group is inherited by all descendants. There is no notation for putting a parent only in a group. A tag is not inherited: it belongs to the node it is written on.
- A group with no entry in `markdag.groups` is shown as a text label (`%name`) without a color. A tag needs no definition; it is shown as written (`#owner:alice`, `#urgent`) next to the node text, unless the document changes `markdag.tags.display`.
- Tag values are checked only for keys defined in `markdag.tags.keys` (see `types` and `tags` in section 4). Without a definition, any value is accepted.

## 4. Frontmatter

The shape of the frontmatter is defined by one JSON Schema, `src/model/frontmatter.schema.json` (`dist/frontmatter.schema.json` after a build). Read it for the full list of keys, types and allowed values.

Everything markdag reads is under the `markdag` key. `title` and `markmap` are markmap's keys and stay at the top level. `relations` or `groups` written at the top level (the form used up to 0.2.0) are reported as `option-misplaced` and ignored.

### relations

```yaml
markdag:
    relations:
        fork:
            - A --> B/*
        join:
            - B/* --> C
        chain:
            - C --> D --> E
        depends:
            - X --> Y
```

- The four keys are the kinds of lines. `chain`: nodes connected in sequence. `join`: several nodes converge on one. `fork`: one node fans out to several. `depends`: any other "should be finished first" dependency.
- The arrow always points from the side that finishes first to the side that starts later. `Signup API --> Signup form` reads "the signup form depends on the signup API".
- `-->` and `&` are operators only when they have half-width spaces or tabs on both sides. `A-->B` and `A&B` are not parsed. This lets names such as `R&D` be written as they are.
- `A & B --> C & D` makes four lines (every left term to every right term). `A --> B --> C` makes `A --> B` and `B --> C`.
- The expected shapes are: `join` = two or more nodes `-->` one node; `fork` = one node `-->` two or more nodes; `chain` = every term is one node. A different shape still draws, with a `shape-mismatch` warning.
- Relations are processed in the order they are written. A line that would close a cycle is skipped with a `cycle` error, and the rest of the expression is still drawn.

### Selectors (how a term points at nodes)

| Form | Points at |
| --- | --- |
| `Name` | The node whose first line is `Name` |
| `Parent/Name` | `Name` that has `Parent` among its ancestors (not only the direct parent) |
| `$id` | The node that has `$id` at the end of its first line |
| `Name/*` | All leaves under `Name`, not `Name` itself |
| `Name/**` | `Name` and all its descendants |

- The text to match is the first line of the node without decoration, tags, `$id` and the task checkbox. `## **Release** $release` is matched by `Release`.
- An exact match wins. If there is no exact match, a prefix match is tried, and an `info` diagnostic `ref-prefix` reports it. Treat `ref-prefix` as a typo to fix.
- If the same text appears on several nodes, the reference is an error (`ref-ambiguous`). Write `Parent/Name`, or put a `$id` on the node. Prefer `$id` for nodes that many relations point at, and in documents that will grow: adding a node later can make a text reference ambiguous.
- Matching is case-sensitive. Runs of half-width spaces are treated as one.
- `/` in a selector is the path separator. For a node named `CI/CD` write `CI\/CD`. For a node whose name starts with `$` write `\$100 budget`. For a node whose name starts with `(` write `\(draft)`.
- `Name/*` on a node without children is an error (`selector-empty`).

### groups

```yaml
markdag:
    groups:
        backend:
            label: Backend team
            color: "#D64545"
            boundary: true
            members:
                - API/**
```

- The key is the group name, used in the body as `%backend`.
- `label` is the name shown in the legend, on the frame and in the text label of a group without a color. `color` is a CSS color. `boundary: true` draws a frame around the members.
- `members` adds nodes by selector instead of by the `%name` mark. Membership given by `members` is inherited by descendants, the same as a mark. `(X)` cannot be used in `members`.
- A group name made only of digits cannot be used as a mark (`%2024` is not a mark). Put such a group in `members`.

### types

```yaml
markdag:
    types:
        $ref: ./types.yaml
        ticket:
            type: string
            pattern: "^[A-Z]+-\\d+$"
        priority:
            type: enum
            values: [high, medium, low]
        level:
            type: integer
            min: 1
            max: 5
```

- A named type is a base type (`type`) plus constraints. `tags.keys` refers to it by name. `type` is one of the built-in types below, or the name of another entry in `types`: a derived type adds constraints to its base and cannot loosen them. Omitting `type` means `string`.
- Built-in types and how a value is written in the body:

| Type | Value | Constraints |
| --- | --- | --- |
| `string` | any text | `pattern` (a JavaScript regular expression), `minLength`, `maxLength` |
| `number` | `3`, `-1.5` | `min`, `max` (numbers) |
| `integer` | `3`, `-1` | `min`, `max` (numbers) |
| `boolean` | `true`, `false`. `#key` with no value means `true` | none |
| `enum` | one of `values` | `values` (required) |
| `date` | `2026-10-01` | `min`, `max` (written the same way) |
| `datetime` | `2026-10-01T09:30`. Seconds and a zone (`Z`, `+09:00`) are optional. With a space instead of `T`, quote it: `#start:"2026-10-01 09:30"` | `min`, `max` |
| `time` | `09:30`. Seconds are optional | `min`, `max` |
| `duration` | `30m`, `2h`, `3d`, `1w` | `min`, `max` |
| `nodeId` | `$name`: the node that has `$name` at the end of its first line. It must exist, and only once | none |

- `type` can be a list (`type: [level, enum]`): a value passes when it fits any of them. Constraints written next to a list apply to the entries they fit.
- When the same constraint is written on the base and on the derived type, both apply: `min` takes the larger, `max` the smaller, and every `pattern` must match. `values` on a derived type replaces the base's list.
- `description` is free text for editors, shown next to the key in completion.
- `$ref` loads types from another YAML file: one path or a list, relative to the document. markdag itself does not read files. The application reads them and passes the parsed YAML to `buildModel` (see [usage.md](usage.md)); `npm run check` reads them itself. Later files override earlier ones, and the document's own `types` override all of them. A file that could not be read is reported as `types-unresolved`, and keys that refer to a named type are then not checked.
- A built-in type name cannot be redefined (`type-reserved`). An unknown name is `type-unknown`, a type that refers to itself is `type-cycle`, and a constraint that does not fit the base type (`pattern` on a number, `values` on a string, a numeric `min` on a date) is `type-invalid`.

### tags

```yaml
markdag:
    tags:
        display: always
        lint: warning
        unknownKey: allow
        keys:
            owner:
                type: string
                multiple: true
            priority:
                type: priority
            estimate:
                type: number
                min: 0
            ticket:
                type: ticket
                unique: true
            blockedBy:
                type: nodeId
```

- Tags (`#key:value`, `#key` in the body) work without any definition. `tags` holds display options and, under `keys`, the definitions of the keys to check.
- `display` decides how every tag is shown; there is no per-key setting. `always` (the default) writes them after the node text, next to the text labels of groups without a color, and they count towards the size of the node. `hover` and `click` put them in the same popover as the details, after the details text, and give the node the same `i` button: the popover opens when the pointer is over the node (`hover`) or when the button is clicked (`click`). A node with tags gets the button even when it has no details. `never` hides them. With `details.display: always` there is no popover, so the tags are written in the node as with `always`.
- `keys.<key>` defines one key. It takes the same fields as a `types` entry (`type`, the constraints, `description`), written inline or referring to a named type, plus how the key is used: `multiple: true` allows several values (`#owner:alice,bob`; without it a second value is `tag-multiple`), and `unique: true` forbids the same value on two nodes (`tag-unique`, reported on every node that has the value, with the lines of the others).
- A value that does not fit the type is `tag-type`. `#key` with no value on a key that is not `boolean` is `tag-missing-value`. These are reported with the position of the tag in the body.
- `lint` is the severity of those reports: `warning` (default) or `error`. With `error`, `npm run check` exits with 1. The tag still stays as written and the diagram is still drawn; unlike an error in `relations`, nothing is dropped.
- `unknownKey` says what to do with a key that is not in `keys`: `allow` (default: the tag is free, as without any definition) or `deny` (`tag-unknown-key`, at the `lint` severity).
- Tags are data on the node: they are not inherited, they do not draw frames or colors, and they are not in the legend. Applications read them from `GraphModel.tagsOf` and the definitions from `GraphModel.tagKeys` (see [usage.md](usage.md)).

### rules

```yaml
markdag:
    rules:
        taskToggle:
            requireUpstreamDone: true
            readonlyGroups:
                - 確定済み
        fold:
            keepMilestonesOpen: true
```

- `rules` are built-in rules for what the reader may do. They need no JavaScript, so they work in any application that renders the document.
- `taskToggle.requireUpstreamDone`: a task cannot be checked (`[x]`) while a task it waits for is still open. "Waits for" follows the lines from `relations`, starting at the node and at each of its ancestors, as far as they go. Lines are usually drawn between headings, and this is what makes a list item under a heading wait for what the heading waits for. An upstream `[/]` counts as open, an upstream `[-]` as finished. Only the move to `[x]` is checked: unchecking, and moving to `[/]`, is never blocked.
- `taskToggle.readonlyGroups`: tasks on nodes in these groups cannot be toggled at all. Write the names without `%`. A name that is on no node in the document is reported as `option-invalid`.
- `fold.keepMilestonesOpen`: the fold circle does not close a milestone (`## **Release**`). Methods such as `setFolded` still do.
- A blocked action is reported as `hook-rejected` (severity `info`) with the reason, which the application receives through `onDiagnostic`; the diagram itself does not change.
- `rules` run before the hooks in `hooks`, so a hook can only add to them, not undo them.

### tasks

```yaml
markdag:
    tasks:
        cycle: [' ', '/', 'x']
        dim:
            states: ['x', '-']
            details: hover
            tags: keep
```

- `cycle` is the order a click moves a task through, left to right, and from the last mark back to the first. The marks are the characters written between the brackets: `' '` (open), `'/'` (in progress), `'x'` (done), `'-'` (canceled). Quote them: YAML reads a bare space or `-` differently. Default: `[' ', 'x']`. A task whose mark is not in `cycle` does not change on click, and the click is reported as `hook-rejected` (severity `info`); change it by editing the text. Fewer than two marks is reported as `option-invalid` and the default order is used; an unknown or repeated mark is reported and skipped.
- `dim` lists the states whose nodes are drawn faded, the way nodes outside a highlighted line or group are. Write the marks (`dim: ['x', '-']`), or a mapping with `states` and how details and tags behave on those nodes:
    - `details`: `keep` (default: as `details.display` says), `hover` (not inside the node; a popover when the pointer is over it), `click` (a popover from the `i` button), `never` (not shown at all, no button).
    - `tags`: `keep` (default: as `tags.display` says), `hover` and `click` (in the popover), `never`. When `tags.display` is `never`, they stay hidden.
    - Pointing at a faded node shows it at full strength while the pointer is there. The popover is never faded. A faded node stays faded while a line or a group is highlighted.
- `[/]` and `[-]` are recognized whether or not `tasks` is written. `[/]` is drawn as a half-filled box, `[-]` as a box with a bar and the label struck through.

### hooks

```yaml
markdag:
    hooks:
        $ref: ./task-guard.hooks.js
        options:
            transitive: true
```

- `hooks` declares JavaScript that runs on a few operations: before a task is checked, after the fold state changed, and so on. It is for documents that need a rule the notation cannot express, such as "this task cannot be checked while the task it depends on is open".
- The document only names the module. markdag never reads or imports it: the application that renders the document resolves the path, imports it and hands the result to markdag. A document alone therefore cannot make any code run, and a `$ref` nobody loaded is reported as `hooks-unresolved` (`info` in an application that does not load hooks, `warning` when the application tried and the module was missing).
- `npm run check` loads them only when you pass `--hooks`, because checking a document would otherwise run the code it points at.
- `options` is free-form and is passed to the hooks as `ctx.options`. markdag does not check its contents.
- Write the module in JavaScript unless you know that the application which loads hooks transpiles TypeScript. markdag never transpiles: a `.ts` module works only where the loader (a bundler, or `npm run check -- --hooks`) turns it into JavaScript first, and a `.ts` that nobody transpiles is reported as `hooks-unresolved`.
- The module exports functions under reserved names (`beforeTaskToggle`, `onFoldChange`, `decorateNode`, ...). See [usage.md](usage.md) for the list, what each one receives, how a `before*` hook cancels an operation, and what `transformSource` and `decorateNode` return. `docs/examples/hooks.md` is a working example.
- When `rules` already covers what you need, use `rules` instead: it needs no code and therefore no decision from the application about whether to run it.

### Display options

The other keys under `markdag`:

| Key | Values | Default |
| --- | --- | --- |
| `details.display` | `always` (open inside the node), `hover` (a popover when the pointer is over the node), `click` (a popover from the `i` button) | `hover` |
| `legend.position` | `top-right`, `top-left`, `bottom-right`, `bottom-left` (the corner of the diagram area where the legend is placed) | `top-right` |
| `legend.display` | `false`, or a list of `groups` and `branches` | both |
| `tags.display` | `always` (in the node), `hover` and `click` (in the details popover), `never` (see `tags` above) | `always` |
| `branches` | List of nodes (one node each; no `/*`, `/**`, `(X)`) | none |
| `edgeHighlight` | boolean | `true` |
| `groupHighlight` | boolean | `true` |
| `tasks.cycle` | List of marks (`' '`, `'/'`, `'x'`, `'-'`) in the order a click moves through them (see `tasks` above) | `[' ', 'x']` |
| `tasks.dim` | List of marks to fade, or `states` with `details` and `tags` (see `tasks` above) | none |

- `details`, `legend`, `tags` and `tasks` are mappings. Writing a value directly under them (`details: hover`, a list under `legend`) is reported as `option-invalid` and ignored.

    ```yaml
    markdag:
        legend:
            position: bottom-left
            display:
                - groups
    ```

- `branches` names the nodes where a color starts. Colors are assigned in the order written. Descendants take the color of the nearest branch start above them. A relation line takes the color of the branch of its source node.
- When `branches` is present, a node under no branch start is drawn in gray, and so are the lines that start from it.
- Without `branches`, colors follow markmap (`markmap.colorFreezeLevel`).

### markmap

`markmap.initialExpandLevel` and `markmap.colorFreezeLevel` take effect. Other markmap options pass validation but have no effect in the current prototype.

## 5. YAML pitfalls

| Wrong | What YAML does | Right |
| --- | --- | --- |
| `color: #3B7DD8` | A space followed by `#` starts a comment. The value becomes null | `color: "#3B7DD8"` |
| `- Launch #urgent --> Review` | Same. The value becomes `Launch` | Refer to the node by its text without the marks: `- Launch --> Review` (`%name`, `#tag` and `$id` are not part of the text a relation matches) |
| `- Phase 1: design --> build` | `: ` makes the item a mapping, not a string | `- "Phase 1: design --> build"` |
| `boundary: yes` | `yes` is a string in YAML 1.2, not a boolean | `boundary: true` |
| `- @mention --> B`, `` - `cmd` --> B `` | `@` and `` ` `` cannot start a plain value. The whole frontmatter fails to parse | `- "@mention --> B"` |
| `- *A --> B`, `- &A --> B`, `- [A] --> B`, `- {A} --> B`, `- !A --> B`, `- >A --> B`, `- \|A --> B`, `- %A --> B` | The first character is a YAML indicator | Quote the whole line |
| `- A　-->　B` (full-width spaces) | Not a YAML problem, but `-->` is not recognized as an operator (`relation-syntax`) | Half-width spaces around `-->` and `&` |
| `members: [API, Spec/*]` with names containing `,` `[` `]` `{` `}` | Flow syntax splits on these characters | Use the block form, one `- item` per line |

When the frontmatter fails to parse as YAML, all of it is ignored, including everything under `markdag`, and the document is shown as a plain markmap.

## 6. Graph pitfalls

- Keep a `join` target outside the set it collects. With `## Build` containing `### Build done`, the selector `Build/*` includes `Build done` itself, so `Build/* --> Build done` reports `self-loop` for `Build done --> Build done`. Put the target outside: a separate `## Build done`. The same happens with `X/** --> Y` when `Y` is under `X`.
- A relation from a node to one of its ancestors is a cycle, because the tree already has lines from parent to child. `X/* --> X` is the common case.
- A top-level node (a direct child of the root) that is the target of any relation loses its line from the root. This is intended: the node is positioned after its predecessors instead.
- A relation that duplicates a tree line or an earlier relation is skipped with a `duplicate-edge` warning.
- A node whose first line is a table, a code block or an HTML block has no text to match, so it cannot be referenced by name and cannot take a tag or `$id`. It is still included in `X/*` and `X/**`.
- Under one heading, do not mix list items with deeper headings. When a heading has list items and is then followed by a deeper heading, the transformer (markmap-lib) drops those list items without a diagnostic. Give the list its own subheading.

## 7. Not supported yet

- `(X)` (treat the branch of X as one unit and draw a frame around it). It is parsed, reports a `not-supported` warning, and behaves as `X`.
- A dedicated warning for full-width spaces. In a relation, the expression fails with `relation-syntax`. At the end of a node line, the group mark, tag or `$id` silently stays as text.
- Filtering the diagram by tags. Tags are extracted and shown, and applications can read them, but the view has no filter yet.

## 8. Guidelines for a readable diagram

- Use `chain` for the backbone of the process, `join` where several results meet at a milestone, `fork` where one decision starts several things at once, and `depends` for the remaining cross dependencies. `depends` lines are the ones that cross other lines most, so keep them few.
- Set `tags.display` to `hover` or `click` in a document with many tags: the tags then move into the details popover, the nodes stay narrow, and the layout stays close to the one without tags.
- In a large document set `markmap.initialExpandLevel` (3 works well). Closed nodes merge the lines of their descendants into one line with a count badge, so the first view stays readable. [examples/large-project.md](examples/large-project.md) uses this.
- Choose 6 to 10 branch starts. The palette has 10 colors and repeats after that. Using the top-level phases as branch starts makes the color of a line tell which phase it comes from.
- Put `boundary: true` only on the large groups. `examples/large-project.md` defines 33 groups and draws a frame for 9 of them.
- Give a group a `color` when it should read as a unit. Without a color it is only a text label beside each node.
- Use `%name` marks for membership that follows the structure of the outline, and `members` for membership that cuts across it.
- In a checklist that is mostly done, set `tasks.dim` to `states: ['x', '-']` with `details: hover`: finished and canceled items shrink to one line and fade, and the open ones stand out. Mark what is being worked on with `[/]`, and set `tasks.cycle` to `[' ', '/', 'x']` when readers should be able to do that from the diagram.
- Use groups for what should be visible as a unit (a team, a phase) and tags for attributes of single nodes (`#owner:alice`, `#priority:high`, `#urgent`). A tag on a heading says nothing about the items under it.

## 9. Check the document

Validate every document you write. See [validation.md](validation.md). Each diagnostic has a position and a hint that says how to fix it.
