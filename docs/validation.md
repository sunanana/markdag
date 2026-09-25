# Validating a markdag document

Check every document with the `check` command, run from the root of this repository. It runs in Node: it loads the built library (`dist/markdag.js` and `dist/markdag.wasm`), parses the document, builds the model and prints the diagnostics. No browser is needed.

Setup, once:

```sh
npm install
npm run build
```

`npm run build` also compiles the Rust crates, so it needs a Rust toolchain with the `wasm32-unknown-unknown` target. Run it again whenever the code under `src/` or `crates/` changes.

```sh
npm run check -- path/to/document.md
```

The exit code is 1 when there is at least one `error`, 0 otherwise, and 2 when the file or the build is missing. A document with no problems prints `no diagnostics`.

The check covers YAML syntax, unknown keys, wrong types and values, the shape of relation expressions, reference resolution, cycles and duplicates, the values of the tags in the body when `markdag.tags.keys` is defined, and body notation that is not drawn as written (`nesting-too-deep`, `html-heading-ignored`, `block-on-first-line`). Files referenced by `markdag.types.$ref` are read relative to the document. It does not lay out or draw the diagram, since that needs a browser, so an error raised while drawing is not caught here.

Modules referenced by `markdag.hooks.$ref` are **not** loaded unless you pass `--hooks`, since checking a document would otherwise run the code it points at. Without the flag, each of them is reported as `hooks-unresolved` with severity `info` (the check does not load hooks); with the flag, a module that cannot be loaded is a `warning`.

```sh
npm run check -- --hooks path/to/document.md
```

The modules are imported in Node. A module written in TypeScript is transpiled with Vite's transformer before it is loaded; it is not type-checked, and type-only imports are dropped. When a module cannot be read, transpiled or imported, the reason is printed on stderr and the library reports `hooks-unresolved`.

To check a document from your own Node code, call `await init()`, then `parseDocument` and `buildModel` (see [usage.md](usage.md)). `checkFrontmatter` checks only the shape of the frontmatter. It cannot resolve references: `Desing --> Build` passes it, because resolving a name needs the node tree.

## The `markdag` command

The same check is also available as a native command, built from the Rust crate `crates/markdag-cli`. It calls the Rust core directly, without Node or WebAssembly, and prints the same lines as `npm run check` without `--hooks`. Build it from the root of this repository:

```sh
npm install
npm run build:cli
```

`npm run build:cli` runs `npm run build` and then `cargo build -p markdag-cli --release`. The order matters: the binary embeds `dist/markdag.core.iife.js` and `dist/style.css` for the `html` command, and `cargo build` stops with a message asking for `npm run build` when they are missing. The binary is `target/release/markdag`.

```sh
target/release/markdag check path/to/document.md
```

The exit code is 0 when there is no `error` (warnings and infos are allowed), 1 when there is at least one `error`, and 2 when the file cannot be read or the arguments are wrong. The output is the same as described in [Reading the output](#reading-the-output), and a document with no problems prints `no diagnostics`.

Files referenced by `markdag.types.$ref` are read relative to the document, not to the working directory. Modules referenced by `markdag.hooks.$ref` are never loaded (there is no `--hooks` flag), so each of them is reported as `hooks-unresolved` with severity `info`.

Two more commands use the same parsing:

- `markdag parse <file> --json` prints the result as one line of JSON, `{ "parsed": ..., "model": ... }`. `parsed` has the shape returned by `parseDocument`. `model` is the data returned by `buildModel`, except that `groupsOf` and `tagsOf` are arrays of `[nodeId, value]` pairs (a `Map` in JavaScript) and `hooks` is `{ declared, options, rules }` without functions. The diagnostics are in `model.diagnostics`. The exit code is 0, or 2 when the file cannot be read.
- `markdag html <file> -o out.html` writes the same standalone page as `buildStandaloneHtml` (see [usage.md](usage.md#standalone-html)). Without `-o`, the page goes to stdout. JavaScript modules in `markdag.hooks.$ref` are read relative to the document and embedded as source, and they run in the browser that opens the page. Modules written in TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) and files that cannot be read are not embedded: a note is printed on stderr, and the page reports them as `hooks-unresolved`. The exit code is 2 when the document cannot be read or the page cannot be written.

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
- `line:column` is the position in the source file, 1-based, counted in characters. Positions are given for the frontmatter, for the tags in the body (`#key:value` at the end of a node line), and for the body notation that is not drawn.
- The message and the hint are in Japanese. The hint says how to fix the problem, and often names the closest valid key or node (`もしかして「details」` = "did you mean `details`"). Fix the document from the hint rather than from the code alone.
- `info not-extracted` means the frontmatter has no `markdag` key, so groups, tags, `$id`, details and milestones were not extracted. It also appears after a `yaml-syntax` error, because a frontmatter that fails to parse is ignored as a whole.
- Aim for no diagnostics. `ref-prefix` is a `warning`: the reference is only the start of a node's name, so nothing was drawn for it. Write the full name from the hint.

## Diagnostic codes

| Code | Severity | Layer | Meaning |
| --- | --- | --- | --- |
| `yaml-syntax` | error | YAML | The frontmatter is not valid YAML, or its collections nest deeper than 100 levels (入れ子が深すぎます). All of it is ignored. Only the first syntax error is reported |
| `option-unknown` | warning | Shape and type | Unknown key under `markdag`, or a top-level key that looks like a typo of a known key |
| `option-misplaced` | warning | Shape and type | A key written at the wrong level: `relations`, `groups`, `branches` or `initialExpandLevel` outside `markdag` (the top-level `relations` and `groups` are the form used up to 0.2.0), or `fork` directly under `markdag`. It is ignored |
| `option-invalid` | warning | Shape and type | Wrong type or value under `markdag` (for example `initialExpandLevel: "2"`, which is not an integer). Also a `markdag.branches` item that is not a single node or repeats a node, a `markdag.rules.taskToggle.readonlyGroups` name that is on no node, and a `markdag.tasks.cycle` with fewer than two marks |
| `option-removed` | warning | Shape and type | The top-level `markmap` key, which is no longer read. Everything under it is ignored. The hint says to move `initialExpandLevel` to `markdag.initialExpandLevel` and to delete the other markmap options, which were removed |
| `relation-unknown-key` | warning | Shape and type | A key under `markdag.relations` other than `fork`, `join`, `chain`, `depends` |
| `relation-not-string` | error | Shape and type | A relation expression that YAML did not read as a string (usually `: ` inside it) |
| `relation-syntax` | error | Shape and type | No ` --> ` with spaces around it, an empty term, `(X)` combined with `/*`, or a term that opens a `"` and does not close it |
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
| `hook-failed` | warning | Hooks | A hook threw or returned a value of the wrong kind, or hooks nested deeper than four levels. Raised while the reader works, so it arrives through `onDiagnostic`. For `decorateNode`, once per draw: the failing hook is skipped for the remaining nodes |
| `hook-rejected` | info | Hooks | A `before*` hook, or a rule in `markdag.rules`, cancelled an operation. Also through `onDiagnostic` |
| `ref-not-found` | error (warning in `groups` and `branches`) | References | No node has exactly this name, and no name starts with it. The hint gives the closest name, or explains that the text is inside a node without a name (a list item whose first line is empty, or a table or code block directly under a heading) |
| `ref-ambiguous` | error (warning in `groups` and `branches`) | References | Two or more nodes match the reference, or the same `$id` is on several nodes |
| `ref-prefix` | warning | References | No node has exactly this name, but one or more names start with it. The reference is not resolved (no line, membership or branch start is added); the hint lists those nodes |
| `selector-empty` | error | References | `X/*` where `X` has no children |
| `self-loop` | error | Graph | A line from a node to itself |
| `cycle` | error | Graph | The line would close a cycle. It is not added |
| `duplicate-edge` | warning | Graph | The same line already exists, as a tree line or an earlier relation |
| `shape-mismatch` | warning | Graph | The expression does not have the shape its key expects (see `relations` in the writing guide) |
| `not-extracted` | info | Body | The frontmatter has no `markdag` key. The document is shown as a plain markmap |
| `html-heading-ignored` | info | Body | A raw HTML block at the level of headings and list items contains a heading (`<h2>` and so on). The block is not drawn; write the heading as Markdown (`## Heading`) |
| `block-on-first-line` | warning | Body | The first line of a node starts a block (a table row, a fence, an HTML block, a blockquote, a nested list marker, a heading). The first line is shown as the text written, and the lines below are read on their own. Write the block from the second line on, under a label on the first line or an empty first line |
| `nesting-too-deep` | error | Body | Markdown nested deeper than 500 levels (lists, blockquotes, emphasis and other inline containers). The part below that depth is not drawn. Points at the first node that is too deep |
| `not-supported` | warning | Graph | `(X)` is not supported yet and is treated as `X` |

The reference errors are reported as warnings when they come from `markdag.groups.*.members` or `markdag.branches` instead of `markdag.relations`.

The `Tags` rows take their severity from `markdag.tags.lint` (`warning` by default, or `error`). An `error` there only changes the severity and the exit code: the tag stays as written and the diagram is drawn.

Errors in the input of the layout (a node size or a spacing that is NaN, infinite, or 1e300 or more in absolute value) are not diagnostics: the layout throws `MarkdagError` with `code` `layout-error` (see [usage.md](usage.md)). `check` does not lay out, so it does not report them.
