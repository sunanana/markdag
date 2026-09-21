# Using the markdag library

markdag takes a Markdown string and draws the diagram inside an element you give it. It is used like markmap: `render(element, markdown)`. It does not return an SVG string. The diagram is built from absolutely positioned HTML (the nodes) and SVG layers (lines, frames, fold circles), because nodes can contain arbitrary HTML such as video, iframes and CSS animations.

markdag is a prototype (0.1.0). The API may change until v1. It runs in the browser: parsing the body uses `DOMParser`.

## Install

```sh
npm install markdag
```

| Import | What it is |
| --- | --- |
| `markdag` | The default entry. Parses with markmap-lib's standard `Transformer` |
| `markdag/core` | The same API, but you pass the transformer. Does not import markmap-lib (see [Bring your own transformer](#bring-your-own-transformer)) |
| `markdag/style.css` | The stylesheet, for pages that set `injectStyle: false` |
| `markdag/frontmatter.schema.json` | JSON Schema of the frontmatter |

## Build from source

```sh
npm install
npm run build
```

| File | What it is |
| --- | --- |
| `dist/markdag.js` | ES module of the default entry. Dependencies are left as imports for your bundler |
| `dist/core.js` | ES module of the `markdag/core` entry |
| `dist/chunks/` | Code shared by the two ES modules |
| `dist/markdag.iife.js` | Everything in one file for a `<script>` tag. Defines the global `markdag` (default entry only) |
| `dist/style.css` | The stylesheet |
| `dist/frontmatter.schema.json` | JSON Schema of the frontmatter |
| `dist/types/` | Type declarations |

## Render a document

With a bundler:

```ts
import { render } from 'markdag';

const diagram = render(document.getElementById('diagram'), markdownText);
console.log(diagram.diagnostics);
```

With a script tag:

```html
<div id="diagram" style="height: 600px"></div>
<script src="dist/markdag.iife.js"></script>
<script>
    const diagram = markdag.render(document.getElementById('diagram'), markdownText);
</script>
```

- Give the container a height. The diagram fills the container and pans and zooms inside it. A container with no height is given `480px`.
- `render` adds the class `markdag` to the container and replaces its content.
- The stylesheet is added to `<head>` once, automatically. Pass `injectStyle: false` and load `markdag/style.css` yourself if the page forbids inline styles.
- When the document uses math or code highlighting, the KaTeX and highlight.js stylesheets are loaded from a CDN. In the browser, markmap-lib's standard `Transformer` also loads the KaTeX and highlight.js scripts from a CDN. To avoid network access, use `markdag/core` with your own transformer.
- The HTML in the Markdown is inserted into the page as it is, without sanitizing (`<script>` tags do not run, but event handler attributes do). Render only Markdown you trust.

## `render(container, markdown, options?)`

Returns a `MarkdagDiagram`:

| Member | Meaning |
| --- | --- |
| `diagnostics` | Diagnostics of the last rendered document (see [validation.md](validation.md)) |
| `update(markdown)` | Render a new version of the document, keeping zoom, pan and fold state where the tree shape is unchanged. Returns the diagnostics |
| `fit()` | Fit the whole diagram in the container |
| `expandAll()` / `resetFold()` | Open every node / go back to the initial fold state |
| `destroy()` | Remove the diagram and its listeners |
| `view` | The underlying `MarkdagView` (see [Driving the view](#driving-the-view)) |

Options:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `theme` | `'light' \| 'dark'` | `'light'` | Background and the colors that depend on it |
| `details` | `'auto' \| 'click' \| 'hover' \| 'open'` | `'auto'` | How node details are shown. `auto` follows `markdag.details` in the document |
| `legend` | `boolean` | `true` | Show the legend. Which items appear follows `markdag.legend` in the document |
| `animate` | `boolean` | `true` | Animate fold and relayout |
| `injectStyle` | `boolean` | `true` | Add the stylesheet to `<head>` |
| `transformer` | `TransformerLike` | markmap-lib's standard `Transformer` | The Markdown-to-tree transformer. Required in `markdag/core` |
| `onChange` | `(markdown: string) => void` | none | Called when the reader clicks a task (`- [ ]` or `## [ ]`) and the source text changes |
| `onFoldChange` | `(folded: number[], byUser: boolean) => void` | none | Called when the fold state changes (see [Hooks](#hooks)) |
| `onTransform` | `(transform: { x, y, k }, byUser: boolean) => void` | none | Called when pan or zoom changes (see [Hooks](#hooks)) |

Colors are CSS custom properties on `.markdag` (`--markdag-bg`, `--markdag-accent`, `--markdag-border`, `--markdag-edge-tree`, and markmap's `--markmap-*`). Override them on the container or an ancestor.

## Bring your own transformer

`markdag/core` exports the same names as `markdag`, but `parseDocument` and `render` require a `transformer`, and the entry does not import markmap-lib. Use it when the application builds its own transformer (its own plugin set, no CDN access) and does not want markmap-lib's standard one in its bundle.

```ts
import { Transformer } from 'markmap-lib/no-plugins';
import { pluginCheckbox, pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import { render } from 'markdag/core';

const transformer = new Transformer([pluginFrontmatter, pluginCheckbox, pluginSourceLines]);
const diagram = render(container, markdownText, { transformer });
```

A transformer is any object with markmap-lib's `transform(markdown)` and `getUsedAssets(features)`. It must include the frontmatter plugin and the source-lines plugin. Without source lines, tags, `$id`, tasks and `lines` cannot be attached to nodes, and they are dropped without a diagnostic.

## Parse, model and view separately

`render` keeps the source text itself. An application that owns the source text (an editor) can connect the three steps on its own:

```ts
import { buildModel, MarkdagView, parseDocument, toggleTask } from 'markdag';

const view = new MarkdagView(container, {
    onToggleTask: (node) => {
        if (!node.task) return;
        source = toggleTask(source, node.task.line);
        draw(false);
    },
});

function draw(fit: boolean) {
    const parsed = parseDocument(source);
    const model = buildModel(parsed.nodes, parsed.frontmatter, source);
    view.setDocument(parsed, model, fit);
    return model.diagnostics;
}
draw(true);
```

- `MarkdagView` does not add the stylesheet. Load `markdag/style.css` on the page.
- `setDocument(parsed, model, fit)`: with `fit` false, zoom and pan are kept, and the reader's fold state is kept when the tree shape and the document's initial fold state are unchanged. With `fit` true, the fold state goes back to the document's initial state and the diagram is fitted.
- `toggleTask(source, line)` flips `[ ]` / `[x]` (`[X]`) on that line and keeps line endings. A line outside the source returns the source unchanged.
- A task is a list item or a heading whose first line starts with `[ ]`, `[x]` or `[X]`. `node.task.line` is that source line.
- `onToggleTask` fires for a click on the task's label, and on its details when they are shown inside the node (`details: open`). It does not fire for a click inside a nested element that contains its own control (a raw `<input>`, a link, a button): there, a click on the text toggles that element's single checkbox or radio button instead.
- A checkbox written as raw HTML (`<input type="checkbox">`) keeps its state only in the page, not in the source. `setDocument` carries the state over while the tree shape and that node's content (apart from the task mark) are unchanged.
- Each `OutlineNode` has `id` (document order, root is 1), `lines` (`{ start, end }`, 0-based source lines, `end` exclusive, or `null`) and `task`. Node elements carry the same range as `data-lines="start,end"`, next to `data-id`.
- CRLF documents are parsed the same as LF documents.

## Driving the view

Methods of `MarkdagView` (also reachable as `diagram.view`):

| Method | Meaning |
| --- | --- |
| `getTransform()` | The current `{ x, y, k }`. A diagram point `(px, py)` is drawn at `(x + px * k, y + py * k)` from the top-left of the container |
| `setTransform({ x, y, k })` | Replace the transform. Not clamped to the zoom limits. Non-finite values are ignored |
| `panBy(dx, dy)` | Move the diagram by screen pixels |
| `zoomBy(factor, { x, y })` | Multiply the scale. The diagram point under `{ x, y }` (container coordinates) stays in place. Clamped to the zoom limits (0.05 to 8) |
| `fit()` | Fit the whole diagram |
| `focusNode(id, k)` | Open the ancestors of the node, then put it near the top-left at scale `k` |
| `revealNode(id)` | Open the ancestors of the node. Does not move the transform |
| `getFolded()` | Ids of the folded nodes, ascending |
| `setFolded(ids)` | Replace the fold state. Ids that are not in the document, and ids of nodes without children, are dropped |
| `expandAll()` / `resetFold()` | Open every node / go back to the document's initial fold state |
| `contentBounds()` | The rectangle the content occupies, in diagram coordinates: the same range `fit()` uses, including group frames and their labels. `null` when nothing is drawn. During an animation it answers with the final layout |
| `setOptions(options)` | Change view options (`theme`, `details`, `legend`, `animate`) |
| `destroy()` | Remove the diagram and its listeners |

### Hooks

Hooks are passed to the `MarkdagView` constructor. `render` forwards `onFoldChange` and `onTransform` from its options.

| Hook | When |
| --- | --- |
| `onToggleTask(node)` | The reader clicked a task item. The view does not change the state: rewrite the source and call `setDocument` |
| `onFoldChange(folded, byUser)` | The fold state changed. `byUser` is `true` for a click on a fold circle, `false` for `setFolded`, `revealNode`, `focusNode`, `expandAll` and `resetFold`. Not called when `setDocument` resets the fold state, and not called when `setFolded` is given the current state |
| `onTransform(transform, byUser)` | Pan or zoom changed. `byUser` is `true` for drag, wheel and pinch, `false` for `setTransform`, `panBy`, `zoomBy`, `fit` and `focusNode` |
| `onLayout(snapshot)` | A layout pass finished. Also called from `setDocument` and after images load, so it does not tell you that the reader folded a branch |

Several diagrams can live on one page. SVG marker ids are prefixed per instance, so each diagram's arrowheads keep their own colors.

## Diagnostics without rendering

```ts
import { checkFrontmatter, formatDiagnostics } from 'markdag';
import { parse } from 'yaml';

const diagnostics = checkFrontmatter(parse(frontmatterText) ?? {}, wholeMarkdownText);
console.log(formatDiagnostics(diagnostics));
```

`checkFrontmatter` needs no DOM and runs in Node. It checks the shape of the frontmatter only: unknown keys, wrong types and values, the form of relation expressions. Resolving references and detecting cycles needs the node tree, so it needs `render` (or `parseDocument` + `buildModel`) in a browser. `npm run check` does that from the command line; see [validation.md](validation.md).

`formatDiagnostics` turns diagnostics into text, one per line with the position and an indented hint.
