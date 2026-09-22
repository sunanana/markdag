# Validating a markdag document

Check every document with the `check` command, run from the root of this repository. It renders the document with the built library in a headless browser (the body is parsed with the DOM) and prints the diagnostics.

Setup, once:

```sh
npm install
npx playwright install chromium
npm run build
```

Run `npm run build` again whenever the code under `src/` changes.

```sh
npm run check -- path/to/document.md
```

The exit code is 1 when there is at least one `error`, 0 otherwise, and 2 when the file or the build is missing. A document with no problems prints `no diagnostics`.

The check covers YAML syntax, unknown keys, wrong types and values, the shape of relation expressions, reference resolution, cycles and duplicates, and the values of the tags in the body when `markdag.tags.keys` is defined. Files referenced by `markdag.types.$ref` are read relative to the document. It also draws the diagram, so a document that makes rendering throw fails here too.

Modules referenced by `markdag.hooks.$ref` are **not** loaded unless you pass `--hooks`, since checking a document would otherwise run the code it points at. Without the flag, each of them is reported as `hooks-unresolved` with severity `info` (the check does not load hooks); with the flag, a module that cannot be loaded is a `warning`.

```sh
npm run check -- --hooks path/to/document.md
```

A module written in TypeScript is transpiled with Vite's transformer before it is loaded; it is not type-checked, and type-only imports are dropped. When a module cannot be read, transpiled or imported, the reason is printed on stderr and the library reports `hooks-unresolved`.

To check only the shape of the frontmatter from Node, without a browser, use `checkFrontmatter` (see [usage.md](usage.md)). It cannot resolve references: `Desing --> Build` passes it, because resolving a name needs the node tree.

## Reading the output

One diagnostic per line, followed by an indented hint when there is one.

```
<severity> <code> <line>:<column> <message>
    <hint>
```

```
warning option-unknown 10:5 markdag のキー「detail」は使えません (relations, groups, edgeHighlight, groupHighlight ほか)
    もしかして「details」
error ref-ambiguous 6:11 「Test --> Release」: 「Test」に一致するノードが 2 個あります (Test、Test)
    親のノードを付けて「親/子」と書くか、指したいノードの行末に $id を付けると 1 つに絞れます
```

- `severity` is `error`, `warning` or `info`. An error means that part of the frontmatter was skipped. The diagram is still drawn from the rest.
- `line:column` is the position in the source file, 1-based, counted in characters. Positions are given for the frontmatter and for the tags in the body (`#key:value` at the end of a node line).
- The message and the hint are in Japanese. The hint says how to fix the problem, and often names the closest valid key or node (`もしかして「details」` = "did you mean `details`"). Fix the document from the hint rather than from the code alone.
- `info not-extracted` means the frontmatter has no `markdag` key, so groups, tags, `$id`, details and milestones were not extracted. It also appears after a `yaml-syntax` error, because a frontmatter that fails to parse is ignored as a whole.
- Aim for no diagnostics. `ref-prefix` is `info`, but it usually means a misspelled node name that happened to match by prefix.

## Diagnostic codes

| Code | Severity | Layer | Meaning |
| --- | --- | --- | --- |
| `yaml-syntax` | error | YAML | The frontmatter is not valid YAML. All of it is ignored |
| `option-unknown` | warning | Shape and type | Unknown key under `markdag` or `markmap`, or a top-level key that looks like a typo of a known key |
| `option-misplaced` | warning | Shape and type | A key written at the wrong level: `relations`, `groups` or `branches` outside `markdag` (the top-level `relations` and `groups` are the form used up to 0.2.0), or `fork` directly under `markdag`. It is ignored |
| `option-invalid` | warning | Shape and type | Wrong type or value under `markdag` or `markmap`. Also a `markdag.branches` item that is not a single node or repeats a node, and a `markdag.rules.taskToggle.readonlyGroups` name that is on no node |
| `relation-unknown-key` | warning | Shape and type | A key under `markdag.relations` other than `fork`, `join`, `chain`, `depends` |
| `relation-not-string` | error | Shape and type | A relation expression that YAML did not read as a string (usually `: ` inside it) |
| `relation-syntax` | error | Shape and type | No ` --> ` with spaces around it, an empty term, or `(X)` combined with `/*` |
| `group-invalid` | warning | Shape and type | Wrong type or value under `markdag.groups` (unquoted color, `boundary: yes`), or `(X)` in `members` |
| `type-invalid` | warning | Shape and type, Types | Wrong type or value under `markdag.types` or `markdag.tags.keys`; a constraint that does not fit the base type; `enum` without `values`; a `pattern` that is not a valid regular expression |
| `type-unknown` | warning | Types | `type` names neither a built-in type nor an entry of `markdag.types` |
| `type-cycle` | warning | Types | A type whose `type` chain comes back to itself |
| `type-reserved` | warning | Types | An entry of `markdag.types` with the name of a built-in type. It is ignored |
| `types-unresolved` | warning | Types | A file in `markdag.types.$ref` could not be read (or was not passed to `buildModel`). Keys that refer to a named type are not checked |
| `tag-type` | `lint` | Tags | A tag value does not fit the type of its key (wrong form, out of range, not one of `values`, an unknown or duplicated `$id` for `nodeId`) |
| `tag-missing-value` | `lint` | Tags | `#key` with no value on a key whose type is not `boolean` |
| `tag-multiple` | `lint` | Tags | Several values on a key without `multiple: true` |
| `tag-unique` | `lint` | Tags | The same value on several nodes for a key with `unique: true`. Reported on each of them |
| `tag-unknown-key` | `lint` | Tags | A key that is not in `markdag.tags.keys`, when `unknownKey: deny` |
| `hooks-unresolved` | info / warning | Hooks | A module in `markdag.hooks.$ref` was not passed to `render`, so its hooks do not run. `info` when the application does not load hooks at all (no `hookRefs`; `npm run check` without `--hooks`), `warning` when it does and this module was missing or unreadable |
| `hook-unknown-export` | warning | Hooks | A hook module exports a function under a name that is not reserved, or a `default` export. It is not called |
| `hook-invalid-export` | warning | Hooks | A reserved name is exported as something other than a function |
| `hook-failed` | warning | Hooks | A hook threw, or hooks nested deeper than four levels. Raised while the reader works, so it arrives through `onDiagnostic` |
| `hook-rejected` | info | Hooks | A `before*` hook, or a rule in `markdag.rules`, cancelled an operation. Also through `onDiagnostic` |
| `ref-not-found` | error | References | No node matches the reference |
| `ref-ambiguous` | error | References | Two or more nodes match the reference, or the same `$id` is on several nodes |
| `ref-prefix` | info | References | The reference matched by prefix, not exactly |
| `selector-empty` | error | References | `X/*` where `X` has no children |
| `self-loop` | error | Graph | A line from a node to itself |
| `cycle` | error | Graph | The line would close a cycle. It is not added |
| `duplicate-edge` | warning | Graph | The same line already exists, as a tree line or an earlier relation |
| `shape-mismatch` | warning | Graph | The expression does not have the shape its key expects (see `relations` in the writing guide) |
| `not-extracted` | info | Body | The frontmatter has no `markdag` key. The document is shown as a plain markmap |
| `not-supported` | warning | Graph | `(X)` is not supported yet and is treated as `X` |

The reference errors are reported as warnings when they come from `markdag.groups.*.members` or `markdag.branches` instead of `markdag.relations`.

The `Tags` rows take their severity from `markdag.tags.lint` (`warning` by default, or `error`). An `error` there only changes the severity and the exit code: the tag stays as written and the diagram is drawn.
