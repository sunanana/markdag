# Writing a markdag document

A markdag document is a [markmap](https://markmap.js.org/)-style Markdown outline plus a YAML frontmatter. The outline is the tree. The frontmatter has one key, `markdag`, that holds lines between nodes (`relations`), groups of nodes (`groups`), and display options.

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
    details: hover
    branches:
        - Requirements
        - Design
        - Build
        - Verify
        - Release
---

# Feature release

## Requirements $req

## Design #design
### Screen design
### API design

## Build
### Frontend
- [x] List screen
- [ ] Signup form
    > Posts to the signup API. Show input errors right under each field.
- [ ] Test #qa
### Backend
- [x] Search API
- [ ] Signup API
- [ ] Test #qa

## Verify
- [ ] Integration test
- [ ] Acceptance test

## **Release** $release
```

## 2. The frontmatter turns the notation on

Tags, `$id`, details and milestones are extracted only when the frontmatter has the key `markdag`. A document whose frontmatter has only `title` (or no frontmatter) is shown exactly as markmap shows it, and `#tag` and `$id` stay in the node as plain text. A `markdag:` key with no value is enough to turn extraction on, and it is not reported as a wrong type.

The frontmatter must start on the first line of the file with `---` and end with a line that is only `---`.

## 3. Notation in the body

Nodes are headings and list items. The first line of a node is what `markdag.relations`, `markdag.groups.*.members` and `markdag.branches` refer to.

| Notation | Where | Meaning |
| --- | --- | --- |
| `#name` | End of the first line of a heading or list item | Puts the node and all its descendants in group `name` |
| `$name` | End of the first line of a heading or list item | An id for the node, referenced as `$name` |
| `> ...` | A blockquote inside a list item | Details of the node, shown on click or hover instead of inside the node. With `details: open` they are shown inside the node, at the position where they are written (content written after the blockquote comes after it) |
| `**...**` | The whole first line is one bold span | Marks the node as a milestone |
| `[ ]`, `[x]` | Start of a list item or a heading (`- [ ] Name`, `## [ ] Name`) | A task. Clicking the label toggles it, and so does clicking the details when they are shown inside the node (`details: open`). A click on a link, or inside a nested element that has its own control (a raw `<input>`, a button), does not toggle the task. `[X]` is the same as `[x]` |

Rules:

- `#name` and `$name` must be separated from the text by a half-width space, and must be at the end of the line. Several tags can follow each other (`Deploy #backend #qa`). Tags and one `$id` can be mixed in any order.
- Only the first line of a node is scanned. A tag on the second line of a list item stays as text.
- `$name` is `$` + an ASCII letter + ASCII letters, digits, `_`, `-`. `$日本` is not an id. One id per node.
- `#123` (digits only) is not a tag, so `Issue #123` is safe. `C#` is not a tag because there is no space before `#`. Write `\#name` to keep a trailing `#name` as text.
- A full-width space (U+3000) is not a separator. `Deploy　#backend` keeps the tag as text.
- Details work only inside a list item. A blockquote directly under a heading is dropped and does not become details.
- A milestone needs the entire first line in one bold span. `**Release** prep` and `**a** and **b**` are not milestones.
- A tag is inherited by all descendants. There is no notation for tagging a parent only.
- A tag with no entry in `markdag.groups` is shown as a text label without a color.

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

- The key is the group name, used in the body as `#backend`.
- `label` is the name shown in the legend and on the frame. `color` is a CSS color. `boundary: true` draws a frame around the members.
- `members` adds nodes by selector instead of by tag. Membership given by `members` is inherited by descendants, the same as a tag. `(X)` cannot be used in `members`.
- A group name made only of digits cannot be used as a tag (`#2024` is not a tag).

### Display options

The other keys under `markdag`:

| Key | Values | Default |
| --- | --- | --- |
| `details` | `click`, `hover`, `open` | `hover` |
| `legend.position` | `top-right`, `top-left`, `bottom-right`, `bottom-left` (the corner of the diagram area where the legend is placed) | `top-right` |
| `legend.display` | `false`, or a list of `groups` and `branches` | both |
| `branches` | List of nodes (one node each; no `/*`, `/**`, `(X)`) | none |
| `edgeHighlight` | boolean | `true` |
| `groupHighlight` | boolean | `true` |

- `legend` is a mapping with the keys `position` and `display`. Writing the list or `false` directly under `legend` (the form used in 0.1.0) is reported as `option-invalid` and ignored.

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
| `- Launch #backend --> Review` | Same. The value becomes `Launch` | Refer to the node by its text without the tag: `- Launch --> Review` |
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

## 7. Not supported yet

- `(X)` (treat the branch of X as one unit and draw a frame around it). It is parsed, reports a `not-supported` warning, and behaves as `X`.
- Task states other than `[ ]` and `[x]` (`[X]`). `[/]` and `[-]` stay in the node as text.
- A dedicated warning for full-width spaces. In a relation, the expression fails with `relation-syntax`. At the end of a node line, the tag or `$id` silently stays as text.

## 8. Guidelines for a readable diagram

- Use `chain` for the backbone of the process, `join` where several results meet at a milestone, `fork` where one decision starts several things at once, and `depends` for the remaining cross dependencies. `depends` lines are the ones that cross other lines most, so keep them few.
- In a large document set `markmap.initialExpandLevel` (3 works well). Closed nodes merge the lines of their descendants into one line with a count badge, so the first view stays readable. [examples/large-project.md](examples/large-project.md) uses this.
- Choose 6 to 10 branch starts. The palette has 10 colors and repeats after that. Using the top-level phases as branch starts makes the color of a line tell which phase it comes from.
- Put `boundary: true` only on the large groups. `examples/large-project.md` defines 33 groups and draws a frame for 9 of them.
- Give a group a `color` when it should read as a unit. Without a color it is only a text label beside each node.
- Use tags for membership that follows the structure of the outline, and `members` for membership that cuts across it.

## 9. Check the document

Validate every document you write. See [validation.md](validation.md). Each diagnostic has a position and a hint that says how to fix it.
