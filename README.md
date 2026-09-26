# markdag

A library that turns Markdown into a DAG (directed acyclic graph). You add "which node draws a line to which node" in the frontmatter, and the tree is drawn as a DAG.

It is at the prototype stage. The notation and the API may change without notice until v1.

## Usage

```sh
npm install markdag
```

```ts
import { init, render } from 'markdag';

await init(); // loads markdag.wasm, once
const diagram = render(document.getElementById('diagram'), markdownText);
console.log(diagram.diagnostics);
```

`render` draws the diagram inside the element, with pan, zoom and folding. Drawing runs in the browser. Parsing, building the model and the layout are written in Rust and run as WebAssembly (`markdag.wasm`), so `await init()` is needed before the first call; `parseDocument` and `buildModel` also run in Node. Details are in `docs/usage.md`.

`markdag/standalone` writes a diagram as one HTML file that opens on its own, with the interaction kept. See `docs/usage.md`.

### Command line

The `markdag` command checks a document, prints it as JSON, or writes it as a standalone HTML file. It is built from this repository with `npm run build:cli` (Node and a Rust toolchain are needed) and lands at `target/release/markdag`.

```sh
markdag check doc.md          # one diagnostic per line; exit 1 on an error, 2 when the file cannot be read
markdag parse doc.md --json   # { "parsed": ..., "model": ... } as one line of JSON
markdag html doc.md -o doc.html
```

Details are in `docs/validation.md`. The same checks are also available to AI clients through an MCP server, `markdag-mcp`; see `docs/mcp.md`.

## Documentation

Everything needed to use markdag is under `docs/`. If you are an AI agent:

- To write or fix a markdag document, read `docs/writing-guide.md` first, then check your document as described in `docs/validation.md`.
- To embed a diagram in a page, read `docs/usage.md`.

```
docs/
├── writing-guide.md        How to write a document: notation, frontmatter, pitfalls, what is not supported yet
├── validation.md           How to check a document (`npm run check` or the `markdag` command), how to read the diagnostics, the list of diagnostic codes
├── mcp.md                  The MCP server (`markdag-mcp`): how to build it, register it with Claude Code, and its tools
├── usage.md                How to install the library and render a diagram in a page: API, options, styling, driving the view from an application
└── examples/
    ├── notation.md         Every notation in one short document
    ├── large-project.md    A large document (138 nodes, 33 groups)
    ├── hooks.md            A document that uses the built-in rules and declares hooks
    └── task-guard.hooks.js The hooks it declares
```

The examples are written in Japanese. `docs/writing-guide.md` has an English one.

The core is the Rust crate `crates/markdag-core` (parsing, the model and diagnostics, the layout, the standalone page), compiled to WebAssembly by `crates/markdag-wasm`, to the `markdag` command by `crates/markdag-cli`, and to the MCP server by `crates/markdag-mcp`. Building needs a Rust toolchain with the `wasm32-unknown-unknown` target. The TypeScript under `src/` wraps it: `parse/`, `model/` and `layout/` call the WebAssembly module, `wasm/` loads it, `view/` does the rendering and interaction, plus `style.css`, `index.ts` (the public entry) and `core.ts` (the entry that loads nothing from a CDN). The frontmatter JSON Schema is `src/model/frontmatter.schema.json`.

## Relation to markmap

This is not a fork.

The DAG construction, layout, rendering, and frontmatter validation are our own implementation. The Markdown-to-tree rules follow markmap (markmap-lib and markmap-html-parser) and are ported to Rust; markmap is not a dependency.

What was copied, and the list of dependencies, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
