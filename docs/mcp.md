# The markdag MCP server

`markdag-mcp` is an MCP (Model Context Protocol) server that lets an AI client check a markdag document, read it as JSON, and fetch the writing guide. It runs over stdio: the client starts the binary, talks JSON-RPC on its stdin and stdout, and the server exits when stdin is closed. It is built from the Rust crate `crates/markdag-mcp` and calls the Rust core directly, the same way as the `markdag` command (see [validation.md](validation.md#the-markdag-command)).

## Build

From the root of this repository:

```sh
cargo build -p markdag-mcp --release
```

The binary is `target/release/markdag-mcp`. Only a Rust toolchain is needed; unlike the `markdag` command, it does not embed anything from `dist/`, so `npm run build` is not required. The writing guide is embedded at build time, so build again after `docs/writing-guide.md` changes.

## Register it with Claude Code

Use the absolute path of the binary:

```sh
claude mcp add markdag -- /absolute/path/to/markdag/target/release/markdag-mcp
```

This registers the server for you in the current project. Add `--scope project` to write it to the project's `.mcp.json` instead, so that everyone working in that project gets it, or `--scope user` to use it in every project. `claude mcp list` shows whether the server connects.

The same registration written by hand in a project's `.mcp.json`:

```json
{
    "mcpServers": {
        "markdag": {
            "type": "stdio",
            "command": "/absolute/path/to/markdag/target/release/markdag-mcp",
            "args": []
        }
    }
}
```

The server takes no arguments and no environment variables. Other MCP clients that start stdio servers use the same command.

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `check_markdag` | `source` (required), `types`, `icons` | The diagnostics of the document |
| `parse_markdag` | `source` (required), `types`, `icons` | The document as JSON, the same as `markdag parse --json` |
| `get_writing_guide` | none | The text of [writing-guide.md](writing-guide.md) |

`source` is the whole document as text (Markdown with its frontmatter), not a file path. The server never reads files.

### `check_markdag`

Runs the same checks as `markdag check`. The structured content is:

```json
{
    "diagnostics": [
        { "severity": "error", "code": "cycle", "message": "...", "at": { "line": 7, "column": 21, "length": 1 }, "hint": "..." }
    ],
    "hasError": true
}
```

`at` is `null` when a diagnostic has no position, and `hint` is `null` when there is none; positions are 1-based within `source`. The text content has the same lines as `markdag check` (see [Reading the output](validation.md#reading-the-output)), and `no diagnostics` when there is nothing to report. A document with errors is still a successful call: `isError` is `false`, and `hasError` tells whether the document has an `error`.

As with the `markdag` command, a document without a `markdag` key in its frontmatter gets `info not-extracted`, and modules in `markdag.hooks.$ref` are never loaded, so each of them is reported as `info hooks-unresolved`.

### `parse_markdag`

Returns `{ "parsed": ..., "model": ... }` as structured content, the same JSON that `markdag parse --json` prints for the same document, types and icons. The text content is that JSON as a string.

### `types`

Files referenced by `markdag.types.$ref` are not read by the server. Pass their contents in `types`: each key is the `$ref` string exactly as written in the frontmatter, and each value is the content of that file, either as a JSON object or as the YAML text.

```json
{
    "source": "---\nmarkdag:\n    types:\n        $ref: ./types.yaml\n...",
    "types": {
        "./types.yaml": "priority:\n    type: enum\n    values: [high, medium, low]\n"
    }
}
```

A `$ref` missing from `types`, a value of `null`, and YAML text that cannot be parsed are all reported as `types-unresolved`, and the keys that use those types are not checked.

The two ways of passing a file are not read exactly alike. A JSON object is read as the JSON the library exchanges with its wasm core, where an object with a single key `$undefined`, `$object` or `$number` is a marker: `{ "$undefined": true }` is read as a missing value, `{ "$object": [[key, value], ...] }` as an object with those entries, and `{ "$number": "Infinity" }` as a number. YAML text has no markers (a `$` key stays a key) and is read up to 100 levels of nesting. Pass a file whose keys start with `$` as YAML text. This applies to `types` and `icons` alike.

### `icons`

Files referenced by `markdag.icons.$ref` are not read by the server either. Pass their contents in `icons`, in the same shape as `types`: each key is the `$ref` string exactly as written in the frontmatter, and each value is the content of that file (the alias table), either as a JSON object or as the YAML text.

```json
{
    "source": "---\nmarkdag:\n    icons:\n        $ref: ./icons.yaml\n...",
    "icons": {
        "./icons.yaml": "github: simple-icons:github\naws: logos:aws\n"
    }
}
```

With `icons`, the aliases in those files are merged into the alias table (see the [writing guide](writing-guide.md) for what a file cannot set, such as `color` and a nested `$ref`), so `check_markdag` and `parse_markdag` give the same result as `markdag check` and `markdag parse --json` for the same files, and `model.icons` in the parse result holds the merged alias table. A `$ref` missing from `icons` (or no `icons` at all), a value of `null`, and YAML text that cannot be parsed are all reported as `icons-unresolved`, and marks such as `:name:` are not reported as unknown aliases while a table could not be read. The server never reads the SVG files that aliases point to.

### Errors

A call without `source`, or with arguments of the wrong type, returns a result with `isError: true` and the reason in its text.
