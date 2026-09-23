# markdag

A library that turns Markdown into a DAG (directed acyclic graph). You add "which node draws a line to which node" in the frontmatter, and the tree is drawn as a DAG.

It is at the prototype stage. The notation and the API may change without notice until v1.

## Usage

```ts
import { render } from 'markdag';

const diagram = render(document.getElementById('diagram'), markdownText);
console.log(diagram.diagnostics);
```

`render` draws the diagram inside the element, with pan, zoom and folding. It runs in the browser. Install it with `npm install markdag`. Details are in `docs/usage.md`.

`markdag/standalone` writes a diagram as one HTML file that opens on its own, with the interaction kept. See `docs/usage.md`.

## Documentation

Everything needed to use markdag is under `docs/`. If you are an AI agent:

- To write or fix a markdag document, read `docs/writing-guide.md` first, then check your document as described in `docs/validation.md`.
- To embed a diagram in a page, read `docs/usage.md`.

```
docs/
├── writing-guide.md        How to write a document: notation, frontmatter, pitfalls, what is not supported yet
├── validation.md           How to check a document (`npm run check`), how to read the diagnostics, the list of diagnostic codes
├── usage.md                How to install the library and render a diagram in a page: API, options, styling, driving the view from an application
└── examples/
    ├── notation.md         Every notation in one short document
    ├── large-project.md    A large document (138 nodes, 33 groups)
    ├── hooks.md            A document that uses the built-in rules and declares hooks
    └── task-guard.hooks.js The hooks it declares
```

The examples are written in Japanese. `docs/writing-guide.md` has an English one.

The source is under `src/`: `parse/` (Markdown to a node tree), `model/` (relations, groups, diagnostics, and the frontmatter JSON Schema), `layout/` (fold projection and coordinates), `view/` (rendering and interaction), `style.css`, `index.ts` (the public entry) and `core.ts` (the entry that takes your own transformer).

## Relation to markmap

This is not a fork.

The DAG construction, layout, rendering, and frontmatter validation are our own implementation.

What was copied, and the list of dependencies, are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
