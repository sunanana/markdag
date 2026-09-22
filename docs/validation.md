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

The check covers YAML syntax, unknown keys, wrong types and values, the shape of relation expressions, reference resolution, cycles and duplicates. It also draws the diagram, so a document that makes rendering throw fails here too.

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
- `line:column` is the position in the source file, 1-based, counted in characters. Positions are given for the frontmatter only.
- The message and the hint are in Japanese. The hint says how to fix the problem, and often names the closest valid key or node (`もしかして「details」` = "did you mean `details`"). Fix the document from the hint rather than from the code alone.
- `info not-extracted` means the frontmatter has no `markdag` key, so tags, `$id`, details and milestones were not extracted. It also appears after a `yaml-syntax` error, because a frontmatter that fails to parse is ignored as a whole.
- Aim for no diagnostics. `ref-prefix` is `info`, but it usually means a misspelled node name that happened to match by prefix.

## Diagnostic codes

| Code | Severity | Layer | Meaning |
| --- | --- | --- | --- |
| `yaml-syntax` | error | YAML | The frontmatter is not valid YAML. All of it is ignored |
| `option-unknown` | warning | Shape and type | Unknown key under `markdag` or `markmap`, or a top-level key that looks like a typo of a known key |
| `option-misplaced` | warning | Shape and type | A key written at the wrong level: `relations`, `groups` or `branches` outside `markdag` (the top-level `relations` and `groups` are the form used up to 0.2.0), or `fork` directly under `markdag`. It is ignored |
| `option-invalid` | warning | Shape and type | Wrong type or value under `markdag` or `markmap`. Also a `markdag.branches` item that is not a single node or repeats a node |
| `relation-unknown-key` | warning | Shape and type | A key under `markdag.relations` other than `fork`, `join`, `chain`, `depends` |
| `relation-not-string` | error | Shape and type | A relation expression that YAML did not read as a string (usually `: ` inside it) |
| `relation-syntax` | error | Shape and type | No ` --> ` with spaces around it, an empty term, or `(X)` combined with `/*` |
| `group-invalid` | warning | Shape and type | Wrong type or value under `markdag.groups` (unquoted color, `boundary: yes`), or `(X)` in `members` |
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
