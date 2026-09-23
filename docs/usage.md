# Using the markdag library

markdag takes a Markdown string and draws the diagram inside an element you give it. It is used like markmap: `render(element, markdown)`. It does not return an SVG string. The diagram is built from absolutely positioned HTML (the nodes) and SVG layers (lines, frames, fold circles), because nodes can contain arbitrary HTML such as video, iframes and CSS animations.

markdag is a prototype (0.x). The API may change until v1. It runs in the browser: parsing the body uses `DOMParser`.

## Install

```sh
npm install markdag
```

| Import | What it is |
| --- | --- |
| `markdag` | The default entry. Parses with markmap-lib's standard `Transformer` |
| `markdag/core` | The same API, but you pass the transformer. Does not import markmap-lib (see [Bring your own transformer](#bring-your-own-transformer)) |
| `markdag/standalone` | `buildStandaloneHtml`: writes a diagram as one HTML file that opens on its own (see [Standalone HTML](#standalone-html)) |
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
| `dist/markdag.core.iife.js` | The `markdag/core` entry in one file, without markmap-lib. Also defines the global `markdag`. This is the runtime a standalone HTML page carries |
| `dist/standalone.js` | ES module of the `markdag/standalone` entry, with the core runtime and the stylesheet baked in as strings |
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
| `details` | `'auto' \| 'always' \| 'hover' \| 'click'` | `'auto'` | How node details are shown. `auto` follows `markdag.details.display` in the document |
| `legend` | `boolean` | `true` | Show the legend. Which items appear and the corner where it is placed follow `markdag.legend.display` and `markdag.legend.position` in the document |
| `animate` | `boolean` | `true` | Animate fold and relayout |
| `injectStyle` | `boolean` | `true` | Add the stylesheet to `<head>` |
| `transformer` | `TransformerLike` | markmap-lib's standard `Transformer` | The Markdown-to-tree transformer. Required in `markdag/core` |
| `types` | `Record<string, unknown>` | none | The files referenced by `markdag.types.$ref`, keyed by the path exactly as written in the document, each parsed from YAML (`null` when it could not be read). markdag does not read files; see [Tag types from other files](#tag-types-from-other-files) |
| `onChange` | `(markdown: string) => void` | none | Called when the reader clicks a task (`- [ ]` or `## [ ]`) and the source text changes |
| `onFoldChange` | `(folded: number[], byUser: boolean) => void` | none | Called when the fold state changes (see [View callbacks](#view-callbacks)) |
| `onTransform` | `(transform: { x, y, k }, byUser: boolean) => void` | none | Called when pan or zoom changes (see [View callbacks](#view-callbacks)) |
| `onLayout` | `(snapshot: LayoutSnapshot) => void` | none | Called when a layout pass finished (see [View callbacks](#view-callbacks)) |
| `hookRefs` | `Record<string, unknown>` | none | The modules referenced by `markdag.hooks.$ref`, keyed by the path exactly as written in the document. markdag does not import anything; see [Hooks](#hooks) |
| `hooks` | `HookModule \| HookModule[]` | none | Hooks the application passes itself. They run after the ones the document declared |
| `onDiagnostic` | `(diagnostic: Diagnostic) => void` | none | A diagnostic raised while a hook ran (`hook-rejected`, `hook-failed`). Diagnostics of the document itself are in `diagnostics` |
| `onHookError` | `(error: unknown, info: { event, ref }) => void` | none | A hook threw. The hook is skipped and the rest keep running |

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

A transformer is any object with markmap-lib's `transform(markdown)` and `getUsedAssets(features)`. It must include the frontmatter plugin and the source-lines plugin. Without source lines, groups, tags, `$id`, tasks and `lines` cannot be attached to nodes, and they are dropped without a diagnostic.

## Parse, model and view separately

`render` keeps the source text itself. An application that owns the source text (an editor) can connect the three steps on its own:

```ts
import { buildModel, MarkdagView, parseDocument, toggleTask } from 'markdag';

const view = new MarkdagView(container, {
    onToggleTask: (node, cycle) => {
        if (!node.task) return;
        source = toggleTask(source, node.task.line, cycle);
        draw(false);
    },
});

function draw(fit: boolean) {
    const parsed = parseDocument(source);
    const model = buildModel(parsed.nodes, parsed.frontmatter, source); // 4th argument: { types } for markdag.types.$ref
    view.setDocument(parsed, model, fit);
    return model.diagnostics;
}
draw(true);
```

- `MarkdagView` does not add the stylesheet. Load `markdag/style.css` on the page.
- `setDocument(parsed, model, fit)`: with `fit` false, zoom and pan are kept, and the reader's fold state is kept when the tree shape and the document's initial fold state are unchanged. With `fit` true, the fold state goes back to the document's initial state and the diagram is fitted.
- `toggleTask(source, line, cycle?)` moves the mark on that line to the next one in `cycle` (default `[' ', 'x']`; pass `GraphModel.taskCycle` to follow the document's `markdag.tasks.cycle`) and keeps line endings. A line outside the source, or a mark that is not in `cycle`, returns the source unchanged. `nextTaskMark(mark, cycle)`, `taskStateOf(mark)` and `taskMarkOf(state)` are exported for applications that write their own toggling.
- A task is a list item or a heading whose first line starts with `[ ]`, `[/]`, `[x]` (`[X]`) or `[-]`. `node.task` is `{ line, state, checked }`: `line` is that source line, `state` is `todo`, `doing`, `done` or `canceled`, and `checked` is `state === 'done'`.
- Node elements carry `data-task` with the state, `data-task-fixed` when the state is not in the cycle (no pointer cursor, and a click is reported as `hook-rejected`), and `data-dimmed` when the state is in `markdag.tasks.dim`. The label of a task (everything but the details) is wrapped in `span.mdag-task-label`; the stylesheet strikes it through for `canceled`. `GraphModel.taskCycle` and `GraphModel.taskDim` hold the parsed `markdag.tasks`.
- `OutlineNode.html` keeps the details blockquotes where they are written, marked with the class `mdag-details`. The stylesheet hides them unless the details mode is `always`. `OutlineNode.details` is the same content joined into one string, used for the popover. `refText` does not include the details.
- `onToggleTask` fires for a click on the task's label, and on its details when they are shown inside the node (`details.display: always`). It does not fire for a click on a link, or inside a nested element that contains its own control (a raw `<input>`, a button, a `<select>`): there, a click on the text toggles that element's single checkbox or radio button instead.
- A checkbox written as raw HTML (`<input type="checkbox">`) keeps its state only in the page, not in the source. `setDocument` carries the state over while the tree shape and that node's content (apart from the task mark) are unchanged.
- Each `OutlineNode` has `id` (document order, root is 1), `lines` (`{ start, end }`, 0-based source lines, `end` exclusive, or `null`) and `task`. Node elements carry the same range as `data-lines="start,end"`, next to `data-id`.
- `OutlineNode.groups` is the node's own `%name` marks and `OutlineNode.tags` its `#key:value` tags (`{ key, values, at }`; `values` is empty for `#key`, `at` is the position of the tag in the source: `line` and `column` 1-based, `length` in characters). `GraphModel.groupsOf` adds the inherited groups and the `members` of the frontmatter. `GraphModel.tagsOf` lists each node's own tags in the order written; tags are not inherited. `GraphModel.tagDisplay` is `markdag.tags.display` (`always`, `hover`, `click` or `never`; `always` by default), and the view applies it with the `data-tags` attribute on the container and, as the effective mode of each node, on the node element next to `data-details` (the node's values differ from the container's when `markdag.tasks.dim` overrides them, and the stylesheet keys on the node). With `hover` and `click` the tags are rendered in the details popover, as a `p.mdag-popover-tags` after the details.
- `GraphModel.tagKeys` is the resolved definition of each key in `markdag.tags.keys` (`{ key, alternatives, multiple, unique, description }`; each alternative is a built-in `primitive` plus the constraints stacked from the named types). The values of the tags are checked against it in `buildModel`; the results are in `diagnostics`, positioned at the tag in the body.
- `suggestTagKeys(model.tagKeys, prefix)` and `suggestTagValues(model.tagKeys, key, prefix)` give completion candidates for an editor: the defined keys with their `description`, and for a key the `values` of an `enum` or `true` / `false` for a `boolean`. `formatTag(tag)` writes a tag back in the body notation. The model layer (`buildModel`, `checkFrontmatter`, these helpers) does not touch the DOM and runs in Node.

### Hooks and rules without `render`

`render` wires the [hooks](#hooks) and `markdag.rules` into the view through `createHookBridge`. An application that connects the three steps itself uses the same bridge: it turns the view's callbacks into hook calls, keeps the read-only document the hooks see, and reports what a hook cancelled through `onDiagnostic`.

```ts
import { buildModel, createHookBridge, MarkdagView, parseDocument, toggleTask } from 'markdag';

let source = markdownText;
const bridge = createHookBridge({
    source: () => source,
    onDiagnostic: (diagnostic) => showTransient(diagnostic), // hook-rejected, hook-failed
    update: (next) => {
        // ctx.api.update: the application owns the text, so it replaces it and redraws
        source = next;
        draw(false);
    },
    viewHooks: {
        // The application's own callbacks. onToggleTask is called only after beforeTaskToggle allowed the toggle
        onToggleTask: (node, cycle) => {
            if (!node.task) return;
            source = toggleTask(source, node.task.line, cycle);
            draw(false);
        },
        onFoldChange: (folded, byUser) => saveFoldState(folded),
    },
});
const view = new MarkdagView(container, bridge.viewHooks);
bridge.attach(view);

function draw(fit: boolean) {
    let parsed = parseDocument(source);
    let model = buildModel(parsed.nodes, parsed.frontmatter, source, { hookRefs });
    // Only needed when transformSource hooks are in use: parse the rewritten text instead
    const rendered = bridge.transform(model, source);
    if (rendered !== source) {
        parsed = parseDocument(rendered);
        model = buildModel(parsed.nodes, parsed.frontmatter, rendered, { hookRefs });
    }
    bridge.setDocument(parsed, model, fit); // calls view.setDocument, then onDocument
    return model.diagnostics;
}
draw(true);
```

- `bridge.viewHooks` is a complete `ViewHooks`: pass it to the constructor as it is. The `viewHooks` option holds the application's own callbacks; the bridge calls them first and then the hooks, and a `before*` callback of the application that returns `false` cancels before any hook runs.
- `bridge.setDocument(parsed, model, fit)` replaces `view.setDocument`. It swaps in the hooks the document declares (and the `markdag.rules`), rebuilds the document the hooks see, calls `view.setDocument` and then `onDocument`. Calling `view.setDocument` directly still draws, but the hooks and rules keep working on the previous document and `onDocument` is not reported, so always go through the bridge.
- `bridge.beforeUpdate(next)` runs the `beforeUpdate` hooks; call it before replacing the source from outside (an editor). `bridge.destroy()` reports `onDestroy` and destroys the view.
- `hookRefs` is optional. Without it, `markdag.rules` still work and a declared `markdag.hooks.$ref` is reported as `hooks-unresolved` with severity `info`: the application simply does not load hooks. With `hookRefs`, a path that is missing or `null` is a `warning`.
- `bridge.transform(model, source)` is only needed for `transformSource`; skip it when the application does not support that hook.

### Tag types from other files

`markdag.types.$ref` names YAML files whose content is merged into `markdag.types`. markdag never reads a file: the application resolves each path (relative to the document), reads and parses it, and passes the result as the `types` option, keyed by the path exactly as written:

```ts
const model = buildModel(parsed.nodes, parsed.frontmatter, source, {
    types: { './types.yaml': parseYaml(await readTextFile(resolve(documentDir, './types.yaml'))) },
});
```

`render` takes the same `types` option. A path that is missing from the object, or whose value is `null`, is reported as `types-unresolved`, and keys that refer to a named type are not checked. When `$ref` is a list, later files override earlier ones, and the document's own entries override all of them. Pass the same object to every call that checks the document (rendering and validation), so both report the same diagnostics.
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

### View callbacks

These are passed to the `MarkdagView` constructor. `render` forwards `onFoldChange`, `onTransform` and `onLayout` from its options, and calls the [hooks](#hooks) the document declared with the same events.

| Hook | When |
| --- | --- |
| `onToggleTask(node, cycle)` | The reader clicked a task. The view does not change the state: rewrite the source (`toggleTask(source, node.task.line, cycle)`) and call `setDocument`. `cycle` is the document's `markdag.tasks.cycle` |
| `onNodeClick(node, asTaskToggle)` | The reader clicked the node text, outside a link or a nested control |
| `beforeFold(node, folded)` | The reader clicked a fold circle. Return `false` to keep the branch as it is. Not called for `setFolded`, `expandAll`, `resetFold`, `revealNode` and `focusNode` |
| `beforeSelectEdge(edge, byUser)` / `onSelectEdge` | A line is about to be highlighted, or the highlight cleared (`edge` is `null`). `false` keeps the current selection |
| `beforeSelectGroup(id, byUser)` / `onSelectGroup` | The same for a group frame (`id` is `null` when clearing). A line and a group are never highlighted together: selecting one clears the other, and the cleared one is reported with `null` too |
| `beforeDetailsShow(node, pinned, byUser)` / `onDetailsShow` | The details popover is about to open. `false` keeps it closed |
| `onDetailsHide(node, pinned)` | The popover closed, including when a redraw closed it |
| `onFoldChange(folded, byUser)` | The fold state changed. `byUser` is `true` for a click on a fold circle, `false` for `setFolded`, `revealNode`, `focusNode`, `expandAll` and `resetFold`. Not called when `setDocument` resets the fold state, and not called when `setFolded` is given the current state |
| `onTransform(transform, byUser)` | Pan or zoom changed. `byUser` is `true` for drag, wheel and pinch, `false` for `setTransform`, `panBy`, `zoomBy`, `fit` and `focusNode` |
| `onLayout(snapshot)` | A layout pass finished. Also called from `setDocument` and after images load, so it does not tell you that the reader folded a branch |

Several diagrams can live on one page. SVG marker ids are prefixed per instance, so each diagram's arrowheads keep their own colors.

## Hooks

A document can declare callbacks for a few operations, and the application supplies the code. markdag never reads or imports a file: `markdag.hooks.$ref` only names the module, and the application resolves the path, imports it and passes the result as `hookRefs`, keyed by the path exactly as written.

```yaml
---
markdag:
    hooks:
        $ref: ./task-guard.hooks.js
        # Free-form settings, read as ctx.options inside the hooks. markdag does not check them
        options:
            transitive: true
---
```

```ts
const module = await import(new URL('./task-guard.hooks.js', documentUrl).href);
render(container, markdown, { hookRefs: { './task-guard.hooks.js': { ...module } } });
```

Some of what hooks are used for needs no code at all: `markdag.rules` (see the [writing guide](writing-guide.md)) is a small set of built-in rules that run through the same machinery, before the hooks the document declares. Prefer them when they fit, because a document carrying rules works everywhere, including where the application does not load hooks.

A hook is ordinary page code: it can touch the DOM and the network, and it is not sandboxed. Load hooks only for documents you trust. A `$ref` that is missing from `hookRefs` is reported as `hooks-unresolved` and nothing runs, so a document cannot make code run on its own. The severity says whose problem it is: `info` when the application passed no `hookRefs` at all (it does not load hooks), `warning` when it did and this module was missing or could not be read. The application can also pass its own hooks with the `hooks` option, with no declaration in the document; they run after the declared ones, so the application has the last word.

A hook module exports functions under reserved names. A function exported under any other name is reported as `hook-unknown-export` with the closest reserved name as a hint, and `default` exports are not picked up.

```js
/** @type {import('markdag').HookModule['beforeTaskToggle']} */
export function beforeTaskToggle(ctx) {
    if (!ctx.next) return;
    const blockers = ctx.doc.upstream(ctx.node.id).filter((node) => node.task !== null && !node.task.checked);
    if (blockers.length === 0) return;
    ctx.reject(`finish first: ${blockers.map((node) => node.text).join(', ')}`);
    return false;
}
```

`docs/examples/hooks.md` and `docs/examples/task-guard.hooks.js` are a working pair.

The types are exported, so a module can be written in TypeScript: `HookContext<'beforeTaskToggle'>` is the context of one hook, and `HookModule`, `HookNode`, `HookDocument`, `HookApi`, `HookDecoration`, `HookEdge` and `HookGroup` cover the rest.

```ts
import type { HookContext } from 'markdag';

export function beforeTaskToggle(ctx: HookContext<'beforeTaskToggle'>): boolean | void {
    if (ctx.next && ctx.node.tags.every((tag) => tag.key !== 'estimate')) {
        ctx.reject('add #estimate first');
        return false;
    }
}
```

markdag itself never transpiles anything, so a `.ts` module runs only where the code that loads it turns TypeScript into JavaScript: an application bundler, or `npm run check -- --hooks`, which uses Vite's transformer (no type checking; type-only imports are dropped). An application that loads hook files at run time has to bring its own transpiler, or accept `.js` only. Keep a hook module self-contained: `check` loads the file on its own, so a value import of another file cannot be resolved there.

### Reserved names

`before*` runs before the operation and cancels it by returning `false`. Anything else it returns (including `undefined`) lets the operation happen. `on*` runs after; its return value is ignored.

| Hook | When | Extra fields on the context |
| --- | --- | --- |
| `beforeUpdate` | Before `diagram.update(markdown)` replaces the source | `next`, `previous` |
| `beforeTaskToggle` | Before a click on a task rewrites the source | `node`, `nextState` (the state after the click: `todo`, `doing`, `done` or `canceled`), `next` (`true` when that is `done`), `line` |
| `beforeFold` | Before a click on a fold circle opens or closes a branch. Fold changes made by a method (`setFolded`, `expandAll`, `revealNode`, `focusNode`) do not go through it | `node`, `folded` (the state after the click) |
| `beforeSelectEdge` | Before a line is highlighted, or the highlight is cleared | `edge` (`null` when clearing) |
| `beforeSelectGroup` | Before a group is highlighted, or the highlight is cleared | `group` (`null` when clearing) |
| `beforeDetailsShow` | Before the details popover opens | `node`, `pinned` |
| `onDocument` | After a document was parsed, built and set on the view. Also after every redraw | |
| `onNodeClick` | A click on the node text that was not on a link or on a nested control | `node`, `asTaskToggle` |
| `onTaskToggle` | After the source was rewritten and the diagram redrawn | `node`, `nextState`, `next`, `line` |
| `onFoldChange` | After the fold state changed | `folded` (the ids that are now folded) |
| `onSelectEdge` / `onSelectGroup` | After the highlight changed | `edge` / `group` |
| `onDetailsShow` / `onDetailsHide` | After the details popover opened or closed | `node`, `pinned` |
| `onTransform` | After pan or zoom changed | `transform` |
| `onLayout` | After a layout pass finished | `layout` (`totalNodes`, `visibleNodes`, `layoutMs`, `excludedEdges`) |
| `onDestroy` | Before `diagram.destroy()` removes the diagram | |
| `transformSource` | Before the source is parsed. Return a string to parse and draw that instead | `source` (the text so far) |
| `decorateNode` | While a node's element is built. Return `{ className, title, badge }` to add to it | `node` |

`edge` is `{ kind, from, to, proxied }`: `kind` is `tree` for a tree line and the relation kind otherwise, `from` and `to` are the nodes the line is drawn between, and `proxied` says that a folded branch replaced one of them with the node that stands in for it. `group` is `{ id, label, color, members }`, where `members` are the ids of the nodes in the group, inherited ones included.

`transformSource` and `decorateNode` return a value instead of a verdict. Modules run in order: each `transformSource` receives what the previous one returned, and the decorations are merged (`className` values are appended to each other, `title` and `badge` come from the last hook that returned one). A hook that returns nothing (`undefined` or `null`) changes nothing. Because `decorateNode` runs once per node, a hook that throws or returns something else is reported once per draw and skipped for the remaining nodes of that draw; the next draw tries it again.

The text a `transformSource` hook returns is what gets parsed and drawn; the source the application owns is untouched, and `update` and `onChange` keep working on it. Node lines then refer to the rewritten text, so a click on a task is refused (with a `hook-rejected` diagnostic) when the rewrite moved that line. Adding at the end keeps every existing task clickable.

`decorateNode` runs when a node's element is built, which happens on every document change. Call `ctx.api.refreshDecorations()` when something outside the document changed and the decorations need to be computed again. The `badge` text is rendered as a `span.mdag-badge` inside the node, next to the tags, and `className` lands on the `.mdag-node` element so a stylesheet can pick it up.

Hooks are synchronous. A `before*` hook has to answer while the operation waits, so returning a promise does not delay anything; to ask for a confirmation, cancel the operation and call `ctx.api.update(...)` once the answer is in.

### The context

Every hook takes one object, so new fields can be added without breaking existing hooks.

| Field | Meaning |
| --- | --- |
| `event` | The name of the hook, for a function used for several events |
| `byUser` | `true` when a reader's action started it, `false` for a method call |
| `byHook` | `true` when another hook started it through `ctx.api` |
| `options` | `markdag.hooks.options` from the document |
| `reject(message)` | Records why a `before*` hook is cancelling. It ends up in the `hook-rejected` diagnostic |
| `doc` | The document (below) |
| `api` | What a hook can do to the diagram (below) |

`ctx.doc` is a read-only view of the document: `source`, `frontmatter`, `diagnostics`, `node(id)`, `nodes()`, and `upstream(id, options?)` / `downstream(id, options?)`, which follow the lines added by `markdag.relations`. Pass `{ tree: true }` to include the tree parent and children as well, and `{ transitive: true }` to follow the lines as far as they go.

A node is a copy, not the internal one: `id`, `refId`, `text` (the reference text), `depth`, `parent`, `children`, `groups` (inherited ones included), `tags`, `task` (`{ checked, state, line }` or `null`), `milestone`, `lines`, and `folded` / `visible`, which are read at the moment you look at them. The node HTML is not exposed.

`ctx.api` has `focusNode(id, scale?)`, `revealNode(id)`, `setFolded(ids)`, `getFolded()`, `fit()`, `getTransform()`, `setTransform(transform)` and `update(markdown)`. `setFolded` and the rest do not go through `beforeFold`, so a hook that blocks folding can still fold the diagram itself. A change started this way does not run the `before*` hooks again, and the `on*` hooks it triggers get `byHook: true`. Nesting deeper than four levels is dropped with a `hook-failed` diagnostic.

Modules run in the order they are declared, the application's own hooks last. A `before*` hook that returns `false` ends the round: the hooks after it are not called. A hook that throws is skipped, with a `hook-failed` diagnostic and a call to `onHookError`; the other hooks and the diagram carry on. These diagnostics arrive through `onDiagnostic` because they happen while the reader works, not when the document is rendered; the ones about the declaration itself (`hooks-unresolved`, `hook-unknown-export`, `hook-invalid-export`) are part of `diagnostics`.

## Standalone HTML

`markdag/standalone` turns a diagram into one HTML file that opens on its own (from `file://`, as an attachment, on a static host), with folding, pan, zoom, the legend, the task marks and the details popover still working. The core runtime (`dist/markdag.core.iife.js`) and the stylesheet are baked into the module at build time, so the caller's bundler needs no special handling, and the page loads nothing from outside: whatever should be visible has to be inside what you pass.

```ts
import { buildStandaloneHtml } from 'markdag/standalone';

const html = buildStandaloneHtml({
    title: 'Release plan',
    parsed, // the parseDocument result, with image URLs already rewritten to data: URIs
    types, // the same object you pass to buildModel or render
    view: { theme: 'dark' },
    state: { folded: diagram.view.getFolded() },
    css: ['.markdag { --markdag-bg: #101418; }'],
});
```

`buildStandaloneHtml` builds a string and does not touch the DOM, so it runs in Node as well. `parseDocument`, which produces `parsed`, does need the DOM (`DOMParser`): call it in a browser, or in Node supply a `DOMParser` (jsdom or similar) on `globalThis` first. Options:

| Option | Meaning |
| --- | --- |
| `parsed` | A `ParsedDocument`. The page draws it without a transformer, so the core runtime is enough. Rewrite the image URLs in `nodes[].html` (and `details`) before passing it: the page cannot reach relative paths |
| `source` | The Markdown text. With `parsed`, it only positions diagnostics. Without `parsed`, the page parses it when opened, which needs a runtime with the default transformer: pass the contents of `dist/markdag.iife.js` as `runtime.script` |
| `types` | The resolved `markdag.types.$ref` files, keyed by the path as written. Plain objects, embedded as JSON |
| `hookScripts` | The source text of the modules named by `markdag.hooks.$ref`, keyed by the path as written. They are loaded as modules when the page opens (through a blob URL), so each has to be self-contained JavaScript. Omit it and no hooks are loaded (`markdag.rules` still work). Hooks run unsandboxed in the reader's browser: include them only for trusted documents |
| `view` | `theme`, `details`, `legend`, `animate`, as in the `render` options |
| `state` | `folded`: the ids from `view.getFolded()`, applied over the document's initial fold state. `transform`: `{ x, y, k }`; when omitted the page fits the whole diagram, which is the sensible default because the transform depends on the container size |
| `title` | The page title. `markdag` by default |
| `lang` | The `lang` attribute of `<html>`. None by default |
| `containerClass` | Extra classes on the container, next to `markdag`, so that a stylesheet can target `.markdag.my-app` |
| `css` | Stylesheets added after markdag's own: color variables, `@font-face` with data: URIs, the CSS of math or code highlighting |
| `head` | HTML added at the end of `<head>`, as it is |
| `runtime` | `script` and `style` replace the baked-in runtime and stylesheet |

What the page does:

- The container fills the viewport (`body` has no margin, the container is `100vh`). Colors come from the stylesheet and `css`.
- Tasks are read-only, because there is nowhere to save a rewritten source. A click on a task changes nothing, and the cursor stays default (the container carries `data-tasks="readonly"`).
- `styleUrls` of the parsed document are ignored: the page links no external stylesheet. Put what the document needs (KaTeX, Prism) into `css`.
- Diagnostics go to the developer console (`console.warn`), and the diagram handle is `window.markdagStandalone`.
- Size: the core runtime is about 270 KB (87 KB gzipped) and the stylesheet 11 KB, plus the embedded data.

The page calls `mountStandalone(container, data, options?)`, exported from `markdag` and `markdag/core`. `data` is the same object minus the page options (the `StandaloneData` type). It resolves to `{ view, diagnostics, destroy }`. An application can call it to preview exactly what the exported page will show. In `markdag/core`, `options.transformer` is required when only `source` is given; `markdag` falls back to the default transformer.

The types are exported: `StandaloneOptions`, `StandaloneData`, `StandaloneState`, `StandaloneViewOptions`, `StandaloneRuntime` from `markdag/standalone`, and `StandaloneData`, `StandaloneDiagram`, `MountOptions` from the two entries.

## Diagnostics without rendering

```ts
import { checkFrontmatter, formatDiagnostics } from 'markdag';
import { parse } from 'yaml';

const diagnostics = checkFrontmatter(parse(frontmatterText) ?? {}, wholeMarkdownText);
console.log(formatDiagnostics(diagnostics));
```

`checkFrontmatter` needs no DOM and runs in Node. It checks the shape of the frontmatter only: unknown keys, wrong types and values, the form of relation expressions. Resolving references and detecting cycles needs the node tree, so it needs `render` (or `parseDocument` + `buildModel`) in a browser. `npm run check` does that from the command line; see [validation.md](validation.md).

`formatDiagnostics` turns diagnostics into text, one per line with the position and an indented hint.
