# Using the markdag library

markdag takes a Markdown string and draws the diagram inside an element you give it. It is used like markmap: `render(element, markdown)`. It does not return an SVG string. The diagram is built from absolutely positioned HTML (the nodes) and SVG layers (lines, frames, fold circles), because nodes can contain arbitrary HTML such as video, iframes and CSS animations.

markdag is a prototype (0.x). The API may change until v1. Parsing, building the model and the layout run in a WebAssembly module (`markdag.wasm`, compiled from Rust); the view is TypeScript. Load the module once with `await init()` before the first call that parses or draws (see [Initialize](#initialize)). Parsing and building the model need no DOM and run in Node; drawing needs a browser.

## Install

```sh
npm install markdag
```

| Import | What it is |
| --- | --- |
| `markdag` | The default entry. `render` loads KaTeX and highlight.js from a CDN when a document needs them |
| `markdag/core` | The same API. Never loads scripts from outside the page (see [`markdag` and `markdag/core`](#markdag-and-markdagcore)) |
| `markdag/editor` | `mountEditor`: the diagram with a GUI editing layer that rewrites the Markdown (see [GUI editing](#gui-editing-markdageditor)). Built on `markdag/core`, with no `init` of its own |
| `markdag/standalone` | `buildStandaloneHtml`: writes a diagram as one HTML file that opens on its own (see [Standalone HTML](#standalone-html)) |
| `markdag/style.css` | The stylesheet, for pages that set `injectStyle: false` |
| `markdag/frontmatter.schema.json` | JSON Schema of the frontmatter |

## Build from source

```sh
npm install
npm run build
```

The build compiles the Rust crates first (`cargo build -p markdag-wasm --target wasm32-unknown-unknown --release`), so it needs a Rust toolchain with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`). `npm run build:wasm` rebuilds only `dist/markdag.wasm`.

| File | What it is |
| --- | --- |
| `dist/markdag.js` | ES module of the default entry. Dependencies are left as imports for your bundler |
| `dist/core.js` | ES module of the `markdag/core` entry |
| `dist/editor.js`, `dist/editor.dev.js` | ES module of the `markdag/editor` entry, and its development entry (a plain re-export). It has no `init`: it shares the WebAssembly module with `dist/markdag.js` and `dist/core.js` through `dist/chunks/`. There is no IIFE file for it |
| `dist/chunks/` | Code shared by the two ES modules, and `wasm-embedded.js` (`markdag.wasm` as base64, read only by the development entries) |
| `dist/markdag.wasm` | The WebAssembly module. The ES modules load it from next to themselves |
| `dist/markdag.dev.js`, `dist/core.dev.js`, `dist/standalone.dev.js` | Development entries: re-export the matching ES module, but `init()` without a source uses the embedded copy in `dist/chunks/wasm-embedded.js`. Selected by the `development` export condition |
| `dist/markdag.iife.js` | Everything in one file for a `<script>` tag, with `markdag.wasm` embedded (base64). Defines the global `markdag` (default entry only) |
| `dist/markdag.core.iife.js` | The `markdag/core` entry in one file, with `markdag.wasm` embedded. Also defines the global `markdag`. This is the runtime a standalone HTML page carries |
| `dist/standalone.js` | ES module of the `markdag/standalone` entry, with the core runtime and the stylesheet baked in as strings |
| `dist/style.css` | The stylesheet |
| `dist/frontmatter.schema.json` | JSON Schema of the frontmatter |
| `dist/types/` | Type declarations |

## Initialize

Each entry exports `init(source?)`. It loads `markdag.wasm` and resolves when the module is ready. Await it once before the first call that parses, builds a model, lays out or draws:

```ts
import { init, render } from 'markdag';

await init();
const diagram = render(document.getElementById('diagram'), markdownText);
```

- `source` is optional. Without it, the ES module entries load `markdag.wasm` from next to the entry file (`new URL('./markdag.wasm', import.meta.url)`), and the development entries and the IIFE files use an embedded copy. Pass a URL (string or `URL`), a `Response`, the bytes (`BufferSource`) or a compiled `WebAssembly.Module` to load it from somewhere else.
- Calling `init` again after it resolved does nothing, and calls made while it is loading wait for the same load. If loading fails, the promise rejects and the next `init` tries again.
- Called before `init` resolved, the functions that need the module throw `WasmNotReadyError`: `parseDocument`, `buildModel`, `checkFrontmatter`, `render`, `toggleTask`, `nextTaskMark`, `replaceLeadingMark`, `suggestTagKeys`, `suggestTagValues`, `buildStandaloneHtml`, `editSource`, `inspectNode`, `mountEditor` (from `markdag/editor`), and `MarkdagView.setDocument` (the layout). These work without it: `createHookBridge`, `formatTag`, `formatDiagnostics`, `taskMarkOf`, `taskStateOf`, `isTaskMark` and the constants. `isReady()` tells whether the module is loaded.
- `markdag/standalone` is bundled separately and does not share the module with the other entries: import and await its own `init` before `buildStandaloneHtml`.
- `markdag/editor` has no `init`. Await `init` from `markdag/core` (or `markdag`) before `mountEditor`: the three entries come from one build and share the loaded module.
- Errors: `WasmNotReadyError` (called before `init`), `WasmTrapError` (the module aborted inside a call; `functionName` and `panicMessage` say where. The module is re-created, so the next call works), and `MarkdagError` (a call rejected its input; `code` is `invalid-input`, `layout-error`, `standalone-error` or `output`, and `functionName` names the call). All three are exported from every entry.

In Node, `await init()` reads `markdag.wasm` from the installed package as a file. `parseDocument`, `buildModel` and `checkFrontmatter` then run without a DOM:

```ts
import { readFile } from 'node:fs/promises';
import { buildModel, formatDiagnostics, init, parseDocument } from 'markdag';

await init();
const source = await readFile('plan.md', 'utf8');
const parsed = parseDocument(source);
const model = buildModel(parsed.nodes, parsed.frontmatter, source);
console.log(formatDiagnostics(model.diagnostics));
```

With a bundler, `await init()` needs no configuration. `package.json` picks the entry by the `development` export condition:

- Development (Vite's dev server, webpack with `mode: 'development'`, or Node with `--conditions=development`): the entries `dist/*.dev.js`, where `init()` decodes the embedded copy of `markdag.wasm`. Nothing depends on where the dev server puts the entry (Vite's dependency pre-bundling moves it), so no `optimizeDeps` setting is needed and no `.wasm` file is requested. The embedded copy adds about 3.7 MB to the development bundle.
- Production and everything else without the `development` condition (Vite's `vite build`, webpack with `mode: 'production'`, plain Node): the entries write the location as `new URL('./markdag.wasm', import.meta.url)`, which bundlers recognize as an asset. The build copies `markdag.wasm` into the output as a separate file (Vite: `assets/markdag-<hash>.wasm`, webpack: `<hash>.wasm`), rewrites the URL, and does not include the embedded copy.

Verified with Vite 8.3 (dev server, `vite build` and `vite preview`) and webpack 5.111 (both modes). webpack's `mode: 'development'` still emits `markdag.wasm` as an asset, because the development entry imports the production entry, but the page does not request it. `markdag/standalone` always carries the core runtime with its own embedded copy (it is what the exported page runs), so it stays about 3.8 MB in production too.

To load `markdag.wasm` from somewhere else, pass its URL to `init`. The file is exported as `markdag/markdag.wasm`: in Vite, `import wasmUrl from 'markdag/markdag.wasm?url'`; in webpack, `new URL('markdag/markdag.wasm', import.meta.url)`.

## Render a document

With a bundler:

```ts
import { init, render } from 'markdag';

await init();
const diagram = render(document.getElementById('diagram'), markdownText);
console.log(diagram.diagnostics);
```

With a script tag (the IIFE file embeds `markdag.wasm`, so `init()` takes no argument and makes no request):

```html
<div id="diagram" style="height: 600px"></div>
<script src="dist/markdag.iife.js"></script>
<script>
    markdag.init().then(() => {
        const diagram = markdag.render(document.getElementById('diagram'), markdownText);
    });
</script>
```

- Give the container a height. The diagram fills the container and pans and zooms inside it. A container with no height is given `480px`.
- `render` adds the class `markdag` to the container and replaces its content.
- The stylesheet is added to `<head>` once, automatically. Pass `injectStyle: false` and load `markdag/style.css` yourself if the page forbids inline styles.
- When the document uses math or code highlighting, the KaTeX and highlight.js stylesheets are loaded from a CDN. If the page has no `window.katex` or `window.hljs`, `render` from `markdag` also loads the missing script from jsDelivr once per page and redraws the diagram when it arrives (if it cannot be loaded, math stays as TeX source and code stays uncolored). `render` from `markdag/core` never loads scripts: it uses KaTeX and highlight.js only when the page already has them. The loaded scripts are pinned to exact versions (`katex@0.16.18/dist/katex.min.js` and `@highlightjs/cdn-assets@11.11.1/highlight.min.js`) and carry Subresource Integrity (`integrity` with a sha384 hash and `crossorigin="anonymous"`), so if the CDN serves different bytes the browser refuses to run the script and the diagram stays as it is when the script cannot be loaded. Changing either version requires replacing its hash, computed from the new file (`curl -s <URL> | openssl dgst -sha384 -binary | openssl base64 -A`). The stylesheets are not covered by SRI.
- The HTML in the Markdown is inserted into the page as it is, without sanitizing (`<script>` tags do not run, but event handler attributes do). Render only Markdown you trust.

## `render(container, markdown, options?)`

Returns a `MarkdagDiagram`:

| Member | Meaning |
| --- | --- |
| `diagnostics` | Diagnostics of the last rendered document (see [validation.md](validation.md)) |
| `update(markdown)` | Render a new version of the document, keeping zoom, pan and fold state where the tree shape is unchanged. Returns the diagnostics |
| `source` | The current source text: the last text given to `update`, or the text a task click, `toggleTasks` or a hook's `ctx.api.update` wrote. It is the text before `transformSource`. When a `beforeUpdate` hook cancelled `update`, it is still the previous text, so the caller can tell |
| `toggleTasks(ids)` | Advance the task mark of several nodes in one rewrite, as a click on each mark would (`markdag/editor` uses it for Space). `ids` are node ids of the drawn document (`view.getDocument().parsed`); ids that are not in it or are not tasks are skipped, and duplicates count once. Each task is checked as a click checks it: the state is in `markdag.tasks.cycle`, a `transformSource` hook did not move the line, then `markdag.rules` and `beforeTaskToggle` (with `byUser` `true`). The tasks are checked upstream first: a task comes after the tasks among `ids` that are upstream of it, the same upstream that `taskToggle.requireUpstreamDone` checks (the lines from `markdag.relations`, starting at the task and at each of its ancestors, as far as they go, also through tasks that are not in `ids`). Tasks with no such link between them keep document order; where both orders cannot hold, the next task is the first in document order with no unchecked upstream task among `ids`, and when a cycle of relations leaves none, the rest follow in document order. The order of `ids` does not matter, and the lines of the source stay in their order. From the second task on, the hooks see the document with the earlier tasks already advanced, so a task selected together with its upstream task can advance. When all pass, the source is rewritten and drawn once, `onChange` is called once, then `onTaskToggle` for each task, and it returns `true`. Checking stops at the first task refused: the tasks after it are not checked (their `beforeTaskToggle` is not called), only that refusal is reported, as a click would report it (`hook-rejected` through `onDiagnostic`), nothing changes, and it returns `false`. Advanced or not, the `onToggleTask` callbacks added with `view.addHooks` are then called once for each task, in the order checked, as for a click (see [View callbacks](#view-callbacks)). It also returns `false` when no id is a task. `beforeUpdate` does not run, as for a click |
| `fit()` | Fit the whole diagram in the container |
| `expandAll()` / `resetFold()` | Open every node / go back to the initial fold state |
| `destroy()` | Remove the diagram and its listeners |
| `view` | The underlying `MarkdagView` (see [Driving the view](#driving-the-view)) |

An application that builds an object of the `MarkdagDiagram` type itself (without `render`) has to add `toggleTasks`. `createHookBridge` does not offer it.

Options:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `theme` | `'light' \| 'dark'` | `'light'` | Background and the colors that depend on it |
| `details` | `'auto' \| 'always' \| 'hover' \| 'click'` | `'auto'` | How node details are shown. `auto` follows `markdag.details.display` in the document |
| `legend` | `boolean` | `true` | Show the legend. Which items appear and the corner where it is placed follow `markdag.legend.display` and `markdag.legend.position` in the document |
| `animate` | `boolean` | `true` | Animate fold and relayout |
| `injectStyle` | `boolean` | `true` | Add the stylesheet to `<head>` |
| `types` | `Record<string, unknown>` | none | The files referenced by `markdag.types.$ref`, keyed by the path exactly as written in the document, each parsed from YAML (`null` when it could not be read). markdag does not read files; see [Tag types from other files](#tag-types-from-other-files) |
| `icons` | `Record<string, unknown>` | none | The files referenced by `markdag.icons.$ref`, in the same shape as `types`. See [Logo aliases from other files](#logo-aliases-from-other-files) |
| `resolveIcon` | `IconResolver` | none | Returns the SVG of a logo the document names. Without it, logos stay as text. See [Logos](#logos) |
| `onChange` | `(markdown: string) => void` | none | Called when the reader clicks a task (`- [ ]` or `## [ ]`) or `toggleTasks` advances tasks, and the source text changes |
| `onFoldChange` | `(folded: number[], byUser: boolean) => void` | none | Called when the fold state changes (see [View callbacks](#view-callbacks)) |
| `onTransform` | `(transform: { x, y, k }, byUser: boolean) => void` | none | Called when pan or zoom changes (see [View callbacks](#view-callbacks)) |
| `onLayout` | `(snapshot: LayoutSnapshot) => void` | none | Called when a layout pass finished (see [View callbacks](#view-callbacks)) |
| `hookRefs` | `Record<string, unknown>` | none | The modules referenced by `markdag.hooks.$ref`, keyed by the path exactly as written in the document. markdag does not import anything; see [Hooks](#hooks) |
| `hooks` | `HookModule \| HookModule[]` | none | Hooks the application passes itself. They run after the ones the document declared |
| `onDiagnostic` | `(diagnostic: Diagnostic) => void` | none | A diagnostic raised while a hook ran (`hook-rejected`, `hook-failed`). Diagnostics of the document itself are in `diagnostics` |
| `onHookError` | `(error: unknown, info: { event, ref }) => void` | none | A hook threw. The hook is skipped and the rest keep running |

The `transformer` option of versions up to 0.7 is deprecated and ignored (the same goes for `ParseOptions.transformer` and `MountOptions.transformer`): parsing is done in `markdag.wasm`. The `TransformerLike` type is still exported so that existing code compiles.

Colors are CSS custom properties on `.markdag` (`--markdag-bg`, `--markdag-accent`, `--markdag-border`, `--markdag-edge-tree`, and markmap's `--markmap-*`). Override them on the container or an ancestor.

## `markdag` and `markdag/core`

The two entries export the same names and parse the same way. The difference is what `render` does when a document uses math or code highlighting and the page has no `window.katex` or `window.hljs`: `render` from `markdag` loads the missing script from jsDelivr (see [Render a document](#render-a-document)), and `render` from `markdag/core` does not, so math stays as TeX source and code stays uncolored unless the page loaded KaTeX or highlight.js itself. Use `markdag/core` when the page must not load scripts from outside.

## GUI editing (`markdag/editor`)

`mountEditor` draws a document with `render` from `markdag/core` and puts an editing layer on top: a toolbox, a bar of operations over the selection, name, details and tag inputs, a legend panel for line colors and groups, hints, notices, undo and redo, keys and drags. Each operation rewrites the Markdown with [`editSource`](#rewriting-the-source) and redraws. While it is mounted the editor holds the source text, and it reports every change it makes through `onChange`.

```ts
import { init } from 'markdag/core';
import { mountEditor } from 'markdag/editor';

await init(); // markdag/editor has no init of its own
const editor = mountEditor(container, markdownText, {
    mode: 'switch',
    onChange: (markdown) => saveFile(markdown),
    onModeChange: (mode, byUser) => console.log(mode, byUser),
    onSelectionChange: (selection) => console.log(selection.kind),
});
```

- Give the container a height, as for `render`. The stylesheet is added the same way; with `injectStyle: false`, load `markdag/style.css`, which also holds the rules of the editing layer.
- Math and code highlighting work as with `render` from `markdag/core`: KaTeX and highlight.js are used only when the page already has them. Nothing is loaded from outside.
- The document's hooks and `markdag.rules` run as with `render` (pass `hookRefs` and `hooks`). An editing operation, `setSource`, undo and redo go through `beforeUpdate`; when a hook cancels, the source stays as it was (an operation shows a notice that says so).
- The labels, hints and notices of the editing layer are in Japanese, and so are `EditReason.message` and `EditNote.message`. The notice after an edit ends with the `message` of each note, except `bom-removed`: a BOM removed from the start of the document is not mentioned.
- `markdag/editor` exports `mountEditor` and the types `EditorOptions`, `MarkdagEditor`, `EditorSelection`, `EditorMode` and `EditorModeOption`.

### `mountEditor(container, markdown, options?)`

Options:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `'document' \| 'view' \| 'edit' \| 'switch'` | `'document'` | Which modes the diagram offers. `document` follows `markdag.editor.mode` in the document; the other values override it (see [Modes](#modes)) |
| `onChange` | `(markdown: string) => void` | none | The source changed through the diagram: an editing operation, undo or redo, a task click, Space on selected tasks, or a hook's `ctx.api.update`. Not called for `setSource` |
| `onModeChange` | `(mode: EditorMode, byUser: boolean) => void` | none | The mode changed between `view` and `edit`. `byUser` is `true` only for a click on the segment (the view / edit switch in the diagram). Not called on mount |
| `onSelectionChange` | `(selection: EditorSelection) => void` | none | The selection changed, including the selection the editor picks after a rewrite or a redraw, and the clearing when the mode switches to `view`. Not called on mount |
| `theme`, `animate`, `injectStyle`, `types`, `icons`, `resolveIcon`, `hookRefs`, `hooks`, `onDiagnostic`, `onHookError`, `onFoldChange`, `onTransform`, `onLayout` | | | As in the [`render` options](#rendercontainer-markdown-options). `onFoldChange`, `onTransform` and `onLayout` are not called after `destroy` |

`legend` and `details` are not options. The editor does not draw the view's legend; it shows its own legend panel (line colors and groups) in the corner `markdag.legend.position` names: in `view` mode with the items `markdag.legend.display` asks for, in `edit` mode with both sections, opened and closed from its heading. In `edit` mode the details are shown as chosen in the toolbox (on hover at first), in `view` mode as the document says. Neither changes the source.

Returns a `MarkdagEditor`:

| Member | Meaning |
| --- | --- |
| `view` | The `MarkdagView` (see [Driving the view](#driving-the-view)). The application can read it (`getFolded`, `getTransform`) and add its own callbacks with `view.addHooks` |
| `diagnostics` | Diagnostics of the last drawn document, as `render` reports them |
| `getSource()` | The current source text |
| `setSource(markdown)` | Replace the source (the application's own text field changed). Redraws like `update`, keeping zoom, pan and fold state, and pushes the previous text onto the undo history. Does not call `onChange`. An open name or details input is closed without saving (undo and redo do the same). The same text as now does nothing. When a `beforeUpdate` hook cancels, the source stays as it was. Returns the diagnostics |
| `getMode()` | `'view'` or `'edit'` |
| `setMode(mode)` | Switch the mode and return `true`, only when the mode setting is `switch` (also with `segment.display: false`). Otherwise does nothing and returns `false`. Calls `onModeChange` with `byUser` `false` when the mode changed |
| `getSelection()` | A copy of the selection. `{ kind: 'none' }` in `view` mode |
| `undo()` / `redo()` | Step through the history, in either mode. Calls `onChange` when the source changed. `false` when there is nothing to undo or redo, or a `beforeUpdate` hook cancelled. Up to 200 steps are kept |
| `setTheme(theme)` | `'light'` or `'dark'` |
| `fit()` | Fit the whole diagram. In `edit` mode it uses the area to the right of the toolbox and of a segment in a left corner; in `view` mode the whole container |
| `destroy()` | See [Destroying the editor](#destroying-the-editor) |

The selection:

```ts
type EditorSelection =
    | { kind: 'none' }
    | { kind: 'nodes'; nodes: NodeTarget[] } // in the order selected; the last one is the most recent
    | { kind: 'edge'; edge: EdgeTarget }
    | { kind: 'group'; id: string }
    | { kind: 'groups'; ids: string[] }; // two or more groups, in the order selected
```

It is `EditSelection` from `markdag/core` (see [Rewriting the source](#rewriting-the-source)) plus `groups`. A node is `{ id, refText }` of the drawn document. After a redraw a node stays selected only when the same id still has the same `refText`, and a line or a group only while the document still has it. Undo and redo bring back the selection stored with that step. A selected node that becomes hidden in a folded branch (the reader folds an ancestor, or a redraw puts the fold state back to the document's initial state) is dropped from the selection, and stays unselected when the branch is opened again; a group is dropped when all its nodes are hidden, a line when one of its ends is. An open name or details input on such a node is committed first, as a press outside it would.

### Saving the source

Save what `onChange` delivers, and send the application's own edits with `setSource`:

```ts
const editor = mountEditor(container, await loadFile(), {
    mode: 'switch',
    onChange: (markdown) => {
        textField.value = markdown;
        void saveFile(markdown);
    },
});

let pending = 0;
textField.addEventListener('input', () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(flush, 200);
});
// An operation on the diagram applies to the text the editor holds: hand over the pending text first
document.addEventListener(
    'pointerdown',
    (event) => {
        if (pending !== 0 && event.target instanceof Node && container.contains(event.target)) flush();
    },
    { capture: true },
);

function flush(): void {
    window.clearTimeout(pending);
    pending = 0;
    showDiagnostics(editor.setSource(textField.value));
}
```

- `onChange` is not called for `setSource`, so a text field that forwards its changes does not get them back.
- `setSource` goes onto the undo history, so undo in the diagram also reverts a change made in the text field.
- An operation applies to the source the editor holds. An application that forwards its text field after a delay hands over the pending text before the reader operates the diagram, as above; otherwise the operation applies to the older text, and `onChange` delivers a text without the pending input.

### Modes

A diagram is in one of two modes: `view` (reading: the diagram behaves as with `render`) or `edit` (GUI editing). The mode setting decides which ones are offered:

| Mode setting | What the diagram offers |
| --- | --- |
| `view` | Reading only. No segment |
| `edit` | GUI editing only. No segment |
| `switch` | Both. Starts in `markdag.editor.default`, and shows the segment in the place `markdag.editor.segment.position` names when `markdag.editor.segment.display` is `true` |

- The setting comes from `markdag.editor.mode` in the document (see [Display options](writing-guide.md#display-options) in the writing guide). A document without `markdag.editor` is `view`: with the default `mode: 'document'` it opens read-only, with no segment.
- The `mode` option overrides the document's `mode` only; `default` and `segment` always come from the document. `mode: 'switch'` on a document without `markdag.editor` starts in `view`, with the segment at the top left.
- To change the override after mounting, `destroy` the editor and call `mountEditor` again. The undo history, the selection and the view position are not carried over.
- When a redraw finds that the document's `markdag.editor` changed (after an operation, `setSource`, undo or redo), the mode goes back to the start mode of the new setting (`onModeChange` with `byUser` `false`), and the segment follows. Other changes keep the mode the reader or `setMode` chose.
- Switching to `view` commits an open name or details input, clears the selection, and sets the tool back to Select.
- `GraphModel.editor` (`EditorSettings`: `mode`, `default`, `segment: { display, position }`) is the parsed `markdag.editor`, with the defaults filled in: `view`, `view`, `true`, `top-left`. `render` does not use it.

### Keys and focus

- Keys work as commands in `edit` mode only, and only when focus is inside the container, or when nothing has focus and the pointer was last over the container. Keys typed in another field of the page are left alone, and two editors on one page do not take each other's keys.
- In `view` mode, under the same conditions, Delete and Backspace (alone or with Shift) do nothing: the editor prevents their default action (in some browsers, going back a page) outside text fields, as it does in `edit` mode when nothing is selected. A diagram drawn with `render` does not do this.
- The keys: Enter (rename; in a node's name input, commit only), Shift+Enter (add a sibling below), Tab (add a child), Shift+Tab (rename the parent; a nameless list container is skipped), Delete / Backspace (delete), J (join into a new node), D (details), T (tags), X (make the selected nodes tasks, or clear their task marks when all of them are tasks; see [Making nodes tasks](#making-nodes-tasks)), H / V (hand / select tool), arrow keys (move the selection), Esc (clear the selection), ⌘Z / Ctrl+Z (undo), ⌘⇧Z / Ctrl+Shift+Z and ⌘Y / Ctrl+Y (redo), ⌘G / Ctrl+G (group), Space (press and release to advance the task mark of the selected nodes, one undo step for all; nothing changes when one of them is refused; hold to pan). Enter with a modifier depends on the platform (below).
- When the container has no `tabindex`, the editor sets `tabindex="-1"` so that the container can take focus, and removes it on `destroy`. A press on the diagram moves focus to the container.

Enter with a modifier works with one node selected and in a node's name input. What each modifier does depends on the platform, which the editor reads from `navigator.platform` once, when it is mounted (macOS and iOS, or the rest):

| Enter with a modifier | macOS | Windows, Linux and the rest |
| --- | --- | --- |
| Add a sibling below (as Shift+Enter) | ⌘Enter | Ctrl+Enter |
| Add a sibling above | Shift+⌘Enter | Shift+Ctrl+Enter |
| Move to the next sibling and rename it | Ctrl+Enter | Alt+Enter |
| Move to the previous sibling and rename it | Shift+Ctrl+Enter | Shift+Alt+Enter |
| Nothing | ⌥Enter | The Windows key + Enter |

- Enter with two or more of ⌘, Ctrl, ⌥ / Alt and the Windows key (Shift is not counted) does nothing either. Keys other than Enter treat ⌘ and Ctrl alike on every platform, and are not commands while Alt is held.
- Adding opens the name input of the new node. Moving (Shift+Tab and the move keys) selects the node and opens its name input. It follows the order the nodes are written in and does not wrap around (the arrow keys follow the screen). Where there is nothing to move to (Shift+Tab on the root, the next sibling of the last one, the previous sibling of the first one), nothing happens. A node that cannot be renamed (a list container, a table, a code block, an image) is selected, and a notice says why.
- These keys act on one selected node. With a group selected, Enter opens the group's name input and the other Enter keys do nothing. When the selection is not one node (two or more nodes, a group, a line, or while picking the node to join into), Tab and Shift+Tab do nothing and focus stays in the diagram; with two or more nodes selected, Enter with or without a modifier does nothing either. In both cases the browser's default action is prevented. With nothing selected, Tab and Shift+Tab move focus as usual.
- While a button inside the container has focus (the toolbox, the bar, the legend panel, a details mark in a node), the keys are the button's, whatever is selected: Enter and Space press it, Tab and Shift+Tab move focus as usual, and Enter with a modifier does nothing.
- In a node's name input, Enter commits the name and keeps the node selected. Shift+Enter, Tab, Shift+Tab and the keys in the table commit it first, then add or move. When the name cannot be committed (an empty name) or there is nothing to move to, the input stays open. Esc cancels; for a node that was just added, the source and the selection go back to before it was added. In a group's name input, only Enter commits: Shift+Enter, Enter with a modifier, Tab and Shift+Tab do nothing. Keys typed while an IME is composing are left to the input.
- In the details input, Enter and Shift+Enter break the line, and only ⌘Enter on macOS (Ctrl+Enter on the other platforms) saves; Enter with another modifier does nothing. Esc closes it without saving.
- Space advances the marks when it is released with nothing else in between: a pointer press or a drag, another key, or Shift (pressed before or after Space) leaves the marks as they are, and so does picking the node to join into. The selected nodes that are tasks advance together through [`toggleTasks`](#rendercontainer-markdown-options), with the checks of a click on each mark, upstream first (the order of selection and of the source does not matter), in one rewrite: one `onChange` and one undo step. When one of them is refused, checking stops there and none changes; only the reason of that first refusal arrives through `onDiagnostic`. The `onToggleTask` callbacks the application added with `view.addHooks` are called for each selected task, as for a click. Selected nodes that are not tasks are skipped. In a text field and on a button, Space is the element's.

### Making nodes tasks

The bar's `task` button, X and the check to the left of a selected node add a task mark to nodes or remove it, with the [`toggleTaskMark`](#rewriting-the-source) operation. Space only advances the mark of nodes that are tasks already.

- The `task` button is on the bar of one node (the root included) and on the bar of two or more nodes, after `tag-select` and before `delete`; not on the bar of a group. It acts on the selected nodes that can be tasks (`canToggleTask` of `inspectNode`): when one of them is not a task, it makes those nodes tasks (`[ ]`, always open) and leaves the tasks as they are; when all of them are tasks, it removes their marks, whatever the state. Its label and icon say which one a press does (`data-task`: `add` or `remove`), and the button keeps its width when the label changes.
- Selected nodes that cannot be tasks are skipped, and the notice counts them. When there is no node to rewrite, the button looks disabled (`aria-disabled="true"`) but still takes a press: like X, it rewrites nothing and shows the reason in a notice.
- Right after a press of the `task` button, the bar keeps its place on the screen although the node box grows or shrinks by the mark, so the button stays under the pointer and a second press turns the change back. The next time the bar is placed (another selection, another button of the bar), it is centered on the selection again. X and the check do not keep the bar's place.
- X without a modifier (Caps Lock does not matter) does what the button does. With ⌘, Ctrl, Alt or Shift it is not a command (⌘X and Ctrl+X stay the browser's). During a drag (a drag selection, dragging a node to move it, drawing a line) and while picking the node to join into, X does nothing and the drag or the picking goes on. In an input it is typed as text. With no node selected (nothing, a group or a line), it rewrites nothing and shows a notice on how to select nodes.
- The check (`.mdag-editor-task-check`) appears to the left of the selected node when exactly one node is selected and it can be made a task (`canToggleTask`, not a task yet, not in a read-only group), under the same conditions as the handles: in `edit` mode, with the Select tool (not while picking the node to join into), while no input or panel is open. A press makes that node a task and keeps the selection. Nothing appears on a task: marks are removed with the button or X.
- Nodes in the groups of `markdag.rules.taskToggle.readonlyGroups` are neither made tasks nor cleared. With two or more nodes selected, they are skipped and the rest are rewritten; whether the rest are made tasks or cleared is decided without them. When nothing else is left, nothing is rewritten and a notice names the group. `requireUpstreamDone` and the `beforeTaskToggle` hook do not apply, and `onToggleTask` is not called: this is an editing operation, which goes through `beforeUpdate` and calls `onChange` once, as one undo step.
- The selection stays as it was (skipped nodes included), and the diagram does not move. When the mark is written on the first line of a document that starts with a BOM, the BOM is removed (see `toggleTaskMark`); as with the other operations, the notice does not mention it.

### Destroying the editor

`destroy()` closes an open name or details input without saving it, removes the editing layer's elements, its listeners on `document`, `window` and the container, the callbacks it added to the view, the elements it put on the overlay layer, `data-editor-mode`, `data-editor-tool` and the `tabindex` it added, stops calling the application's callbacks, and then destroys the diagram. Calling it again does nothing.

- After `destroy`, `getSource()` and `diagnostics` return the last source text and diagnostics. `setSource`, `setMode`, `undo`, `redo`, `setTheme` and `fit` do nothing (`setMode`, `undo` and `redo` return `false`).
- When an application callback (such as `onSelectionChange`) destroys the editor in the middle of an operation, the rest of the operation stops and `onChange` is not called; `getSource()` returns the rewritten text.

### Markup of the editing layer

The editor adds these to the container, for stylesheets and tests. Their rules are in the last section of `markdag/style.css`. Selected nodes and the drop target of a drag carry the view's markers `data-selected` and `data-drop-target` (see [Markers](#markers)).

| Element or attribute | Meaning |
| --- | --- |
| `.markdag[data-editor-mode="view"\|"edit"]` | The current mode |
| `.markdag[data-editor-tool="select"\|"hand"\|"join-target"]` | The current tool in `edit` mode (`join-target`: picking the node to join into). Not set in `view` mode |
| `.mdag-editor` | The layer: the last child of the container, the same size. Only its parts take presses |
| `.mdag-editor-corner[data-corner]` | The holders in the corners and edge centers (`top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`) for the segment, the legend panel, the hint and the notices |
| `.mdag-editor-segment` | The view / edit switch. Its buttons carry `data-mode` and `aria-pressed` |
| `.mdag-editor-toolbox` | The toolbox on the left edge. Buttons are `.mdag-editor-tool[data-tool]`, with `aria-pressed` on the current tool (`data-tool`: `select`, `hand`, `join`, `group`, `tag-add`, `tag-select`, `details`, `undo`, `redo`, `fit`) |
| `.mdag-editor-bar[data-for="node"\|"nodes"\|"group"]` | The bar of operations over the selection. Buttons are `.mdag-editor-bar-button[data-command]` (`rename`, `child`, `sibling`, `details`, `tag-add`, `tag-select`, `task`, `delete`, `join-new`, `join-existing`, `group`, `rename-group`, `ungroup`). The `task` button carries `data-task` (`add` or `remove`, what a press does) and, when there is nothing to rewrite, `aria-disabled="true"` instead of `disabled`, so that a press shows the reason |
| `.mdag-editor-legend` | The legend panel, with `data-open` while open. Group rows are `.mdag-editor-legend-row[data-group]`, with `data-selected` on the selected groups |
| `.mdag-editor-name-input[data-for="node"\|"group"]`, `.mdag-editor-details-editor`, `.mdag-editor-tag-panel[data-panel="add"\|"select"]`, `.mdag-editor-color-picker` | The inputs and panels |
| `.mdag-editor-handle[data-handle="child"\|"sibling"\|"link"\|"join"]` | The handles of the selection: `+` for a child and for a sibling, the dot that draws a line, and the dot that joins a multiple selection |
| `.mdag-editor-task-check` | The check to the left of the one selected node when it can be made a task. A press makes it a task (see [Making nodes tasks](#making-nodes-tasks)) |
| `.mdag-editor-selection-bounds`, `.mdag-editor-marquee` | The outline around a multiple selection, and the rectangle of a drag selection |
| `.mdag-editor-hint`, `.mdag-editor-snackbar[data-kind="info"\|"error"]` | The hint for the current tool, and the notices |

Colors: the editing layer uses the public color variables `--markdag-bg`, `--markdag-panel`, `--markdag-border`, `--markdag-text`, `--markdag-muted` and `--markdag-accent` (the selection outline, the pressed tool, the handles, the task check). Override them on the container or an ancestor, as for the diagram; the `dark` theme (`.markdag-dark`) switches them. The `--mdag-editor-*` variables in the stylesheet are internal to the editing layer and not part of the API.

## Parse, model and view separately

`render` keeps the source text itself. An application that owns the source text (an editor) can connect the three steps on its own:

```ts
import { buildModel, init, MarkdagView, parseDocument, toggleTask } from 'markdag';

await init();
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
- Node elements carry `data-task` with the state, `data-task-fixed` when the state is not in the cycle (no pointer cursor, and a click is reported as `hook-rejected`), and `data-dimmed` when the state is in `markdag.tasks.dim`. The label of a task (everything but the details) is wrapped in `span.mdag-task-label`; the stylesheet strikes it through for `canceled`. The stylesheet fades a `data-dimmed` node by mixing its colors with `--markdag-bg` rather than with `opacity`, so that a line passing under the node does not show through the text; emoji in the text are wrapped in `span.mdag-emoji` and faded on their own. A color that an application sets through a `decorateNode` class is not faded: fade it in the application's stylesheet, for example `.mdag-node.my-class[data-dimmed]:not(:hover) .mdag-content { color: ... }`. `GraphModel.taskCycle` and `GraphModel.taskDim` hold the parsed `markdag.tasks`.
- `ParsedDocument.taskIcons` holds the SVG of each task state (the type allows `null` for documents parsed by versions up to 0.7). `replaceLeadingMark(html, state, icons)` swaps the mark at the start of a node's `html` for another state, for applications that move a task without parsing the source again.
- `OutlineNode.html` keeps the details blockquotes (inside a list item, or right under a heading) where they are written, marked with the class `mdag-details`. The stylesheet hides them unless the details mode is `always`. `OutlineNode.details` is the same content joined into one string, used for the popover. `refText` does not include the details. It is the first line of the node, the name that references match exactly, and it is an empty string for a node without a name (a list item whose first line is empty; see section 6 of the [writing guide](writing-guide.md)). In a document with the `markdag` key, raw HTML on the first line is kept in `refText` as written (`名前 <!-- メモ -->`), and `html` shows it as text.
- `onToggleTask` fires for a click on the task's label, and on its details when they are shown inside the node (`details.display: always`). It does not fire for a click on a link, or inside a nested element that contains its own control (a raw `<input>`, a button, a `<select>`): there, a click on the text toggles that element's single checkbox or radio button instead. In a diagram drawn by `render`, the callbacks added with `view.addHooks` also receive it from `toggleTasks`, once for each task (see [View callbacks](#view-callbacks)).
- A checkbox written as raw HTML (`<input type="checkbox">`) keeps its state only in the page, not in the source. `setDocument` carries the state over while the tree shape and that node's content (apart from the task mark) are unchanged.
- Each `OutlineNode` has `id` (document order, root is 1), `lines` (`{ start, end }`, 0-based source lines, `end` exclusive, or `null`) and `task`. Node elements carry the same range as `data-lines="start,end"`, next to `data-id`.
- `OutlineNode.groups` is the node's own `%name` marks and `OutlineNode.tags` its `#key:value` tags (`{ key, values, at }`; `values` is empty for `#key`, `at` is the position of the tag in the source: `line` and `column` 1-based, `length` in characters). `key` and `values` are read without the quotes and escapes: `#"api.version":"say \"hi\""` has the key `api.version` and the value `say "hi"`. `GraphModel.groupsOf` adds the inherited groups and the `members` of the frontmatter. `GraphModel.tagsOf` lists each node's own tags in the order written; tags are not inherited. `GraphModel.tagDisplay` is `markdag.tags.display` (`always`, `hover`, `click` or `never`; `always` by default), and the view applies it with the `data-tags` attribute on the container and, as the effective mode of each node, on the node element next to `data-details` (the node's values differ from the container's when `markdag.tasks.dim` overrides them, and the stylesheet keys on the node). With `hover` and `click` the tags are rendered in the details popover, as a `p.mdag-popover-tags` after the details.
- `GraphModel.tagKeys` is the resolved definition of each key in `markdag.tags.keys` (`{ key, alternatives, multiple, unique, description }`; each alternative is a built-in `primitive` plus the constraints stacked from the named types). The values of the tags are checked against it in `buildModel`; the results are in `diagnostics`, positioned at the tag in the body.
- `suggestTagKeys(model.tagKeys, prefix)` and `suggestTagValues(model.tagKeys, key, prefix)` give completion candidates for an editor: the defined keys with their `description`, and for a key the `values` of an `enum` or `true` / `false` for a `boolean`. `formatTag(tag)` writes a tag back in the body notation, with quotes only where they are needed: a key that has characters other than letters, digits, `_` and `-`, or only ASCII digits, and a value that is empty or has white space, `,`, `"` or `\`, are put in `"…"`, with `"` and `\` inside written as `\"` and `\\` (`{ key: 'api.version', values: ['say "hi"'] }` is `#"api.version":"say \"hi\""`). The diagram shows tags the same way. The model layer (`buildModel`, `checkFrontmatter`, these helpers) does not touch the DOM and runs in Node.

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

### Logo aliases from other files

`markdag.icons.$ref` names YAML files of logo aliases (see `icons` in the [writing guide](writing-guide.md)). They are passed the same way as `markdag.types.$ref`: the application reads and parses each file (relative to the document) and passes the result as the `icons` option of `buildModel` or `render`, keyed by the path exactly as written:

```ts
const model = buildModel(parsed.nodes, parsed.frontmatter, source, {
    icons: { './team-icons.yaml': parseYaml(await readTextFile(resolve(documentDir, './team-icons.yaml'))) },
});
```

- A path that is missing from the object, or whose value is `null`, is reported as `icons-unresolved`. While it is missing, `:alias:` marks in the body are not reported as `icon-unknown`.
- The result is `GraphModel.icons` (`IconTable`): `color` (`mono` or `original`) and `aliases`, a `Map` from the alias name to an `IconDef` (`{ kind, ref, color? }`; `kind` is `set`, `path` or `emoji`). It holds the names only; the SVG is supplied by `resolveIcon` (see [Logos](#logos)).
- A relative path inside such a file is relative to the document, not to the file, so `IconDef.ref` can be resolved against the document in every case.

### Limits on the input

- Markdown nested deeper than 500 levels (lists, blockquotes, and inline containers such as emphasis and links) is cut at that depth: the deeper part is not drawn, and `buildModel` reports `nesting-too-deep` (error) when it is given the source.
- A frontmatter whose YAML collections nest deeper than 100 levels (counting the values that aliases expand to) is not read, and is reported as `yaml-syntax` with the message 入れ子が深すぎます (上限 100 段).
- The layout rejects numbers it cannot place: a node width or height, or a spacing, that is NaN, infinite, or 1e300 or more in absolute value makes the layout throw `MarkdagError` with `code` `layout-error`. The sizes measured from the DOM do not reach this; it guards against broken input. The depth of the tree itself is not limited.

## Rewriting the source

`editSource(source, op)` and `inspectNode(source, node)`, exported from `markdag` and `markdag/core`, are the rewriting functions `markdag/editor` uses. They take the source text and return text and facts; they do not touch the DOM and run in Node after `init`.

```ts
import { editSource, init, inspectNode, parseDocument, type NodeTarget } from 'markdag/core';

await init();
let source = '# Release\n\n- Design\n    - Screens\n- Build\n';
const design = parseDocument(source).nodes.find((node) => node.refText === 'Design');
if (design) {
    const target: NodeTarget = { id: design.id, refText: design.refText };
    if (inspectNode(source, target)?.canAddChild) {
        const outcome = editSource(source, { kind: 'addChild', parent: target, label: 'API' });
        if (outcome.status === 'edited') source = outcome.source; // '# Release\n\n- Design\n    - Screens\n    - API\n- Build\n'
        else if (outcome.status === 'refused') console.warn(outcome.reason.code, outcome.reason.message);
    }
}
```

- A node is named by `NodeTarget`, `{ id, refText }` of a node in the parsed document the application draws (`view.getDocument().parsed`). The source is parsed again; when it has no node with that `id`, or that node's `refText` differs (the source changed since the last draw, or a `transformSource` hook moved lines or names), `editSource` refuses with `stale-node` and `inspectNode` returns `null`. Ids change with a rewrite: take them from the new parse or from `select`.
- Lines are rewritten as whole lines (lines are `source.split('\n')`, as in `toggleTask`). Lines the operation does not touch keep every character, including `\r`. In a CRLF document (the first line break is `\r\n`) new lines end with `\r\n`. A lone `\r` (one not followed by `\n`) is first replaced with that line break (`\n` in a document without one), and the lines it was on are part of the rewrite.
- The rewritten text is parsed again and compared with the intended tree. When other nodes would change (their number, order, parents or names), the operation is refused with `structure-changed` and nothing is written.
- An operation that needs the notation (marks at the end of the first line, details, frontmatter entries) adds `markdag:` to the frontmatter, and the frontmatter itself when there is none (notes `markdag-added`, `frontmatter-added`). It also removes a BOM at the start of the document (`bom-removed`), also when the BOM is followed by `---`: the frontmatter that the BOM kept from being read is then read and written to. Operations that do not need the notation leave the BOM as it is, except `toggleTaskMark` when it writes the first line (see the table).
- Where the way the source is written keeps an operation from writing, that part is rewritten first. The rewrite is part of the returned text when the operation writes, without a note:
    - Frontmatter in flow style (`{ }`, `[ ]`) on the way to the entry to write is rewritten in block style (keys and `-` items, one per line), with the same values.
    - A `|` or `>` value of a relation kind (`depends`, `chain`, `join`, `fork`) is rewritten as a `-` list, one item per non-empty line.
    - A group definition that is not a mapping (`dev: Development`, or a `-` list) is replaced with a mapping when `renameGroup`, `setGroupColor` or `setGroupBoundary` writes to it. The old value, which was not read, is dropped.
    - Marks at the end of a setext heading (text underlined with `===` or `---`) or of an ATX heading indented by 1 to 3 spaces are not read. An operation that writes a mark on such a heading (a tag, a group, a `$n` reference) first rewrites it as an ATX heading of the same level without the indent (`## Name`).
- References in `markdag.relations`, `markdag.branches` and `markdag.groups.*.members` follow the nodes. Renaming a node rewrites the references that pointed to it. A rewrite that would make a reference point elsewhere or nowhere (the numbers of an ordered list shift, a name becomes a duplicate, a parent in `parent/name` changes) rewrites it (`refs-rewritten`). When neither the name nor `parent/name` points to one node, the node gets `$n<number>` at the end of its first line and is referenced by it (`id-added`).
- `deleteNodes` removes from `markdag.relations` the terms that pointed to the deleted nodes and everything under them, and the items left with nothing on one side (a `relations-removed` note per item it changed).
- In an ordered list, `addChild`, `addSibling`, `addSiblingBefore`, `deleteNodes`, `moveNode` (the list the node leaves and the list it goes into) and `joinIntoNew` renumber the items of the list in the source, so that the numbers written match the numbers the diagram shows. Adding at the end of a list numbered in sequence writes the next number and leaves the other items as they are; a list numbered out of sequence is rewritten as a whole, also when the item is added at its end (adding to `1. 5. 6.` gives `1. 2. 3. 4.`), except a list written with one number (below). The list keeps the number it started with, also when its first item is deleted or moved out (`3. a / 4. b / 5. c` without `a` becomes `3. b / 4. c`). Several items deleted from one list are renumbered once. A list whose items are all written with one number (`1. 1. 1.`, leaving the counting to the renderer) keeps that number on every item after any operation, the added item included. The delimiter (`.` or `)`) is kept. Indents are left as they are, except when a number gains a digit (`9.` becomes `10.`) and the item's children and details are no longer indented enough to stay inside it: they are indented further, all by the same amount. A number that loses a digit leaves the indents as they are. A document that starts with a BOM is renumbered as it would be without one. When the renumbered text would be read as a different tree, or its numbers would still not match the diagram (rare forms, such as unusual indents of nested lists), the operation is applied without renumbering, with no note.
- A name is written as text: markdag adds `\` where the name would otherwise be read as a mark, a list marker, a task mark or the closing `#` of a heading. It reads the whole line, with the list marker or heading marks before the name and the marks after it: a name that would form a task mark or a thematic break with them gets a `\` at its start (renaming `- Design %ui` to `[x]` writes `- \[x] %ui`, and renaming an item to `--` writes `- \--`). `inspectNode(...).label` gives the name without those `\`, so passing it back to `renameNode` changes nothing.
- One call is one operation. An operation on several nodes is refused as a whole when one of them cannot be rewritten (the `message` names it), except the nodes that the table below says an operation skips.
- `editSource` and `inspectNode` do not read `markdag.rules` and do not run hooks: `toggleTaskMark` also rewrites nodes in a group of `taskToggle.readonlyGroups`, as the other operations do. The rules are applied where the reader acts: by the view for a task click and `toggleTasks` (see [Hooks](#hooks)), and by `markdag/editor`, which leaves such nodes out of `toggleTaskMark` (see [Making nodes tasks](#making-nodes-tasks)).
- `editSource` throws `MarkdagError` (`code` `invalid-input`) only when `op` cannot be read (an unknown `kind`, a field of the wrong type), and `WasmNotReadyError` before `init`.

The operations (`EditOp`, by `kind`):

| `kind` | Fields | What it writes |
| --- | --- | --- |
| `addChild` | `parent`, `label` | A new last child of `parent`, in the form of its last child (heading level, list indent and marker, the next number, a `[ ]` task mark). Without children: a heading one level deeper (a `- ` item under a level 6 heading) or a nested `- ` item. An ordered list numbered out of sequence is renumbered as a whole (see above) |
| `addSibling` | `node`, `label` | A node after `node`, in the same form. In an ordered list, the items after it are renumbered (a list numbered out of sequence is renumbered as a whole; see above). For the root, a child. Refused for a table, code block or image (`block-node`) and for a list container (`no-source-line`) |
| `addSiblingBefore` | `node`, `label` | A node before `node`'s first line, in the same form (heading level, list indent and marker, a `[ ]` task mark). In an ordered list, the new item takes `node`'s number and the items from `node` on are renumbered (a list numbered out of sequence is renumbered as a whole; see above). For the root, a child, as `addSibling`. Refused for the same nodes as `addSibling` |
| `renameNode` | `node`, `label` | The text of the first line, keeping the list marker, the task mark and the marks at the end. Line breaks in `label` become spaces. An empty `label` is refused (`empty-name`). For a root without a line of its own (its name is the frontmatter `title`; also the list that is the root of a document that is only a list), the `title`: its value is replaced, or `title` is added at the end of the frontmatter when there is none, and the frontmatter is created when there is none (`frontmatter-added`). The `markdag` key is not added. A name that YAML would read as another value (`yes`, `null`, a number such as `42`) is written in quotes. A date such as `2026-10-06` is written without quotes, as in the other values markdag writes to the frontmatter: markdag reads it as text, and a YAML 1.1 reader may read it as a date |
| `deleteNodes` | `nodes` | Removes the lines of the nodes, with everything under them. In an ordered list, the items left are renumbered (see above). Refused when the root is among them |
| `moveNode` | `node`, `parent` | Moves the node with everything under it to the end of `parent`'s children, rewritten in the form there (a heading under a list item becomes a list item). A list item that becomes a heading keeps its details as the heading's details. In an ordered list, the items left behind are renumbered, and so is the list it goes into when that list is numbered out of sequence (see above) |
| `setDetails` | `node`, `text` | The details of a list item (the `> ` lines after the first line, before the children) or a heading (the `> ` lines right under it). The current details, lazy continuation lines (lines inside the blockquote without `>`) included, are replaced as a whole, each line of `text` written with `> `. A `text` equal to the current details changes nothing, unless they have a lazy continuation line: then they are written again with `> ` on every line. An empty `text` removes them |
| `setTag` | `nodes`, `key`, `value`, `replaceKey` | `#key:value` (`#key` when `value` is `null`) at the end of the first line, in place of a tag with the same key, with quotes where needed as `formatTag` writes them (`#"api.version":"x y"`). `replaceKey` (not `null`) also removes the tag with that key, for changing the key of a tag |
| `removeTag` | `nodes`, `key` | Removes the tag with that key |
| `toggleTag` | `nodes`, `key`, `value` | Removes the value when every node has it (the whole tag when no value is left); otherwise adds it. A node with another value for the key gets this one added (`,`) when the key is not defined in `markdag.tags.keys` or has `multiple: true`, and replaced otherwise |
| `toggleTaskMark` | `nodes` | Adds or removes task marks on the nodes that can be tasks (`canToggleTask`). When one of them is not a task, `[ ] ` (always open) after the marks at the start of the first line (indent, list marker or number, the `#` of a heading) of each one that is not, and the tasks keep their state (`# Plan` becomes `# [ ] Plan`, `2. Plan` becomes `2. [ ] Plan`). When all of them are tasks, removes every mark (`[ ]`, `[/]`, `[x]`, `[X]`, `[-]`) with the space after it. A setext heading gets the mark at the start of its text line, and the underline stays. The marks at the start of the line and at its end stay, names (`refText`) and ids do not change, and references are not rewritten. When the text after a removed mark would be read as something else (a number, `#`, `>`, a thematic break, a task mark), it gets a `\`, as a name does (`- [ ] 1. Plan` becomes `- 1\. Plan`, `- [x] # Note` becomes `- \# Note`); marking it again keeps the `\`. A task without a name (`- [ ] `, named `[ ]`) becomes `- \[ ]`, an item named `[ ]`. Skipped: a list container and a root without a line, a table, code block or image, an item without a name, an item whose first line is not text (nothing after the marker, with the name on the next line; 5 columns or more of spaces or tabs after the marker, which Markdown reads as indented code; or text after it that does not start a paragraph: a heading, blockquote, list, fence, thematic break or link reference definition), and a setext heading task whose text would be read as an HTML block without the mark (the heading would be lost). An item whose first line is not text is skipped also in a document with the `markdag` key, where the diagram reads that line as text, because Markdown would read the item differently with the mark (`-     Plan` written as `-     [ ] Plan` puts the mark inside indented code). An item whose text starts an HTML block takes and loses the mark without a `\` (`- <div>Plan</div>` and `- [ ] <div>Plan</div>`), as an ATX heading does, in documents with or without the `markdag` key; it is skipped when the diagram would read it differently with and without the mark (in a document without the `markdag` key: lines right below it that the HTML block would take in, such as details or children, or an ordered item, whose name would change). When nothing is left, it is refused with the reason of those nodes (`no-source-line`, `block-node`, `empty-name` or `marker-line`). On the first line of a document that starts with a BOM, the BOM is removed (`bom-removed`), because a task mark right after it is not read. `select` is the given nodes, the skipped ones included |
| `addToGroup` | `group`, `nodes` | `%group` at the end of the first line. Skips the root, nodes already in the group, and descendants of other given nodes |
| `addRelation` | `from`, `to` | `from --> to` in `markdag.relations.depends` |
| `joinInto` | `sources`, `target` | `a & b --> target` in `markdag.relations.join` (`depends` when one source is left). Sources that `target` already reaches, and sources that already have a line to `target`, are left out |
| `joinIntoNew` | `sources`, `label` | A new top-level node after the top-level branch that holds the last source in document order, and the join into it. When that branch is a list container, the node is added as the last item of that list. When the node goes into an ordered list, the list is renumbered as `addChild` (the last item of a list container) or `addSibling` (after a numbered item) renumbers it (see above). Needs two sources or more |
| `groupNodes` | `nodes` | A new group in `markdag.groups` and its `%` mark on the nodes (with the same skips as `addToGroup`) |
| `defineGroup` | none | A new group with no members |
| `renameGroup` | `group`, `label` | The group's `label` |
| `setGroupColor` | `group`, `color` | The group's `color` (a CSS color) |
| `setGroupBoundary` | `group`, `boundary` | The group's `boundary` |
| `ungroup` | `group` | Removes the group's definition and its `%` marks. The nodes stay |

The result (`EditOutcome`, by `status`):

| `status` | Fields | Meaning |
| --- | --- | --- |
| `edited` | `source`, `select`, `rename`, `notes` | `source` is the whole rewritten text. `select` (`EditSelection`) is what to select next, with ids of the rewritten text: `{ kind: 'nodes', nodes }`, `{ kind: 'edge', edge }` (`EdgeTarget`: `{ kind, source, target }`, `kind` is `tree` or the relation kind), `{ kind: 'group', id }` or `{ kind: 'none' }`. `rename` is the node (`{ kind: 'node', node }`) or group (`{ kind: 'group', id }`) whose name input should open next (after adding one), or `null`. `notes` (`EditNote[]`) says what else changed |
| `unchanged` | `reason` | There is nothing to change. `reason` is `null` or says why (`same-name`, `already-child`, `nothing-to-change`) |
| `refused` | `reason` | The operation cannot be applied. Nothing is written |

`reason` is an `EditReason`: `code`, `message` (one sentence for the reader) and `path` (the frontmatter path it is about, such as `markdag.relations.depends`, or `null`).

| `code` | Meaning |
| --- | --- |
| `stale-node` | The node is not in the source (see above) |
| `no-source-line` | The node has no line of its own to write to: a root without a line, or a list container (`inspectNode` kinds `root` and `list`). `renameNode` on such a root (also a `list` that is the root) is not refused: it writes the `title` |
| `block-node` | A table, code block or image node. It can be deleted, and moved under a heading |
| `marker-line` | The first line cannot carry marks, and rewriting it as an ATX heading would change the name: a setext heading whose text spans two lines or more. Other setext headings and indented ATX headings are rewritten (see above). For `toggleTaskMark`: an item whose first line is not text, or a task that cannot lose its mark before HTML (see the table) |
| `root` | The root cannot be deleted or moved, nor grouped on its own |
| `heading-details` | `moveNode` would make a heading of a list item that has paragraphs after its first line. A heading can have details, but the paragraphs under it are not read |
| `empty-name` | `renameNode` with an empty name, or `toggleTaskMark` on items without a name only (a mark would be read as the name). No node can have an empty name |
| `move-into-self` | The new parent is the node itself or under it |
| `structure-changed` | Parsing the rewritten text gives a different tree than intended |
| `same-node` | A line from a node to itself |
| `edge-exists` | The line is already there |
| `cycle` | The line would close a cycle (the end already reaches the start through tree lines and relations) |
| `ambiguous-reference` | The node cannot be referenced: it has a `$id` that another node also has, and its name does not point to it alone |
| `too-few-sources` | `joinIntoNew` with fewer than two sources |
| `all-sources-skipped` | Every source of a join was left out |
| `tag-key-invalid` | The tag key is empty after the spaces around it and one leading `#` are removed. Any other key is written, in quotes when needed |
| `group-unknown` | There is no group with that id |
| `group-label-empty` | `renameGroup` with an empty label |
| `color-invalid` | `setGroupColor` with a value that is not a CSS color |
| `flow-style` | The frontmatter part to write is in flow style (`{ }` or `[ ]`) that cannot be rewritten in block style: it has a comment, an anchor, an alias, a tag (`!`), an explicit key (`?`), a single pair in a list (`[a: b]`), a list in a list, a value that spans lines, or text after the closing bracket |
| `block-scalar` | The value of a relation kind to write to spans lines and does not start with `\|` or `>`: a plain or quoted value continued on the next line, or one that starts on the line after the key |
| `frontmatter-invalid` | The frontmatter is not valid YAML |
| `frontmatter-not-map` | The top of the frontmatter is not a mapping, or the entry to write to is neither a mapping nor a `-` list and is not one of the forms rewritten above (for example `markdag.groups` written as a list, or a group definition that is an alias) |
| `same-name` | (`unchanged`) The new name is the current one |
| `already-child` | (`unchanged`) The node is already a child of that parent |
| `nothing-to-change` | (`unchanged`) The operation would write nothing new |

`notes` (`EditNote`: `code`, `count`, `message`):

| `code` | `count` | Meaning |
| --- | --- | --- |
| `refs-rewritten` | References rewritten | References in the frontmatter that the rewrite would break were rewritten to point to the same nodes |
| `id-added` | Ids added | `$n<number>` was added to the first line of nodes that a name cannot point to alone |
| `relations-removed` | 1 | An item of `markdag.relations` was changed or removed because a deleted node was in it. One note per item; `message` shows it before and after |
| `sources-cycle` | Sources left out | A join left out sources that the target reaches (the line would close a cycle) |
| `sources-existing` | Sources left out | A join left out sources that already have a line to the target |
| `markdag-added` | Nodes read differently | `markdag:` was added to the frontmatter. `count` is the number of nodes whose name now reads differently, because the `%`, `#` and `$` at the end of their first line became marks |
| `frontmatter-added` | 1 | The document had no frontmatter; one was created at the top |
| `bom-removed` | 1 | The BOM at the start was removed so that the frontmatter is read: the new one, or the one right after the BOM. With `toggleTaskMark`, so that the task mark on the first line is read. `markdag/editor` does not show this note, whatever the operation |

`inspectNode(source, node)` returns what the editing layer needs before an operation (`InspectNodeResult`), or `null` when the source does not have that node:

| Field | Meaning |
| --- | --- |
| `id` | The node id |
| `kind` | `heading`, `item` (a list item), `root` (a root without a line of its own: its `lines` is `null`), `list` (a list container: a node without a text of its own that holds the items of a list; its `lines` start at the first item) or `block` (a table, a code block or an image) |
| `label` | The initial value of a name input: the text of the first line without the list marker, the task mark, the marks at the end and the `\` markdag would add. Markdown stays as written. In a document without the `markdag` key, the marks at the end are part of it. For a root without a line of its own, the value of `title` as YAML reads it, on one line (line breaks become spaces), with HTML tags and character references as written (`title: <b>Plan</b>` gives `<b>Plan</b>`, where the diagram shows Plan), so editing it keeps them, and passing it back to `renameNode` changes nothing (`same-name`). When `title` is missing or is not a string, the name the diagram shows. Empty for a node that cannot be renamed |
| `details` | The details text, or `null`: the lines of the details joined with `\n`, each without its indent and the `>` and one space after it (a lazy continuation line without its indent). For a heading, the blockquote right under it, read only in a document with the `markdag` key |
| `task` | The node is a task |
| `canRename`, `canDelete`, `canMove`, `canHaveDetails`, `canAddChild`, `canAddSibling` | Whether those operations can apply to the node |
| `canMark` | The first line can carry `%`, `#` and `$` marks (tags, groups, `$n`), also after rewriting a setext or indented heading as an ATX heading |
| `canToggleTask` | `toggleTaskMark` can write the node: a mark can be added when the node is not a task, or removed when it is. `false` for an item without a name, an item whose first line is not text (with or without the `markdag` key), a node whose text starts an HTML block when the mark cannot be added or removed without changing how the diagram reads it (see `toggleTaskMark`), and the kinds `root`, `list` and `block`. `markdag.rules` is not read (see above) |

The types are exported from both entries: `NodeTarget`, `EdgeTarget`, `EditOp`, `EditOutcome`, `EditSelection`, `EditRename`, `EditNote`, `EditNoteCode`, `EditReason`, `EditReasonCode` and `InspectNodeResult`.

## Driving the view

Methods of `MarkdagView` (also reachable as `diagram.view`):

| Method | Meaning |
| --- | --- |
| `getTransform()` | The current `{ x, y, k }`. A diagram point `(px, py)` is drawn at `(x + px * k, y + py * k)` from the top-left of the container |
| `setTransform({ x, y, k })` | Replace the transform. Not clamped to the zoom limits. Non-finite values are ignored |
| `panBy(dx, dy)` | Move the diagram by screen pixels |
| `zoomBy(factor, { x, y })` | Multiply the scale. The diagram point under `{ x, y }` (container coordinates) stays in place. Clamped to the zoom limits (0.05 to 8) |
| `fit(inset?)` | Fit the whole diagram. `inset` (`{ left, top, right, bottom }`, screen pixels, a missing side is 0) leaves that much of the container's edges out; when nothing is left, the whole container is used |
| `focusNode(id, k)` | Open the ancestors of the node, then put it near the top-left at scale `k` |
| `revealNode(id)` | Open the ancestors of the node. Does not move the transform |
| `getFolded()` | Ids of the folded nodes, ascending |
| `setFolded(ids)` | Replace the fold state. Ids that are not in the document, and ids of nodes without children, are dropped |
| `expandAll()` / `resetFold()` | Open every node / go back to the document's initial fold state (`markdag.initialExpandLevel`) |
| `contentBounds()` | The rectangle the content occupies, in diagram coordinates: the same range `fit()` uses. It includes group frames and the label row above each frame, but not the part of a frame label that is wider than its frame: a label longer than the frame runs past the frame's right edge, and `fit()` can cut that part off. `null` when nothing is drawn. During an animation it answers with the final layout |
| `setOptions(options)` | Change view options (`theme`, `details`, `legend`, `animate`, and `interaction` and `dragToPan`, see [Building an editing layer on the view](#building-an-editing-layer-on-the-view)) |
| `setIconSvg(ref, svg)` | Store the SVG of a logo (`null`: it could not be resolved, the logo stays as text) and redraw only the places that use `ref`. See [Logos](#logos) |
| `selectEdge(key)` | Highlight a line as a click on it does (`null` clears). `key` is `kind:source>target`, for example `tree:1>2` or `depends:2>4`: `kind` is `tree` or the relation kind, `source` and `target` are node ids, as in `PlacedEdge.edge` (for a tree line, `source` is the parent). Calls `beforeSelectEdge` and `onSelectEdge` with `byUser` `false` |
| `selectGroup(id)` | Highlight a group as a click on its frame does (`null` clears). Calls `beforeSelectGroup` and `onSelectGroup` with `byUser` `false` |
| `selectGroups(ids)` | Highlight several groups together: the members of any of them, their lines and the nodes at the other end stay, the rest fades. The first id is the one `selectGroup` reports, and the callbacks are called only when it changes. `[]` is `selectGroup(null)` |
| `setSelection(ids)` | Put `data-selected` on these nodes and remove it from the others. Ids not in the document are dropped; a node inside a folded branch gets it when its element is built. A new document clears it |
| `setDropTarget(id)` | Put `data-drop-target` on one node (`null` removes it). Not set on a node inside a folded branch |
| `nodeRects(ids?, { settled? })` | A `Map` from id to the `Rect` of each visible node box, in container coordinates (as for `zoomBy`). During an animation, where the box is drawn now; with `settled: true`, where it will end up. Without `ids`, every visible node |
| `ensureVisible(id, margin?)` | Open the ancestors of the node (`onFoldChange` with `byUser` `false`), then pan the shortest distance that puts it inside the container with `margin` pixels to spare (default 24). Does not zoom, and does not move when the node is already inside |
| `attachOverlay(element, anchor)` | Put `element` on the overlay layer and keep it at `anchor` while the diagram redraws, pans, zooms and resizes. Returns a function that detaches it. See [Overlays](#overlays) |
| `addHooks(listeners)` | Add callbacks that run after the constructor's (`ViewListeners`: the members of `ViewHooks` except `decorateNode`). Returns a function that removes them; `destroy` removes them all. See [View callbacks](#view-callbacks) |
| `getDocument()` | `{ parsed, model }` last given to `setDocument` (for `render`, the document after `transformSource`), or `null` |
| `branchColors()` | `{ id, label, color }` for each branch start in `markdag.branches`: the line color the legend shows, whether or not the legend is shown. `label` is the node's `refText`, or `#id` |
| `groupLogo(id)` | A new element with the logo of the group's `icon`, as in the legend: the SVG or the emoji, the text as written when the logo cannot be resolved, or an empty placeholder while its SVG is pending. `null` for a group without `icon` and for an unknown id. When the SVG arrives, `onIconSvg` is called; call `groupLogo` again to get it |
| `destroy()` | Remove the diagram and its listeners |

### View callbacks

These are passed to the `MarkdagView` constructor, or added later with `view.addHooks`. `render` forwards `onFoldChange`, `onTransform` and `onLayout` from its options, and calls the [hooks](#hooks) the document declared with the same events.

| Hook | When |
| --- | --- |
| `onToggleTask(node, cycle)` | The reader clicked a task. The view does not change the state: rewrite the source (`toggleTask(source, node.task.line, cycle)`) and call `setDocument`. `cycle` is the document's `markdag.tasks.cycle`. In a diagram drawn by `render` or `mountEditor`, markdag rewrites the source itself, and a callback added with `view.addHooks` is only told: it must not rewrite the source (the task would advance twice). It is called after the source was rewritten and the diagram redrawn, and also when a check refused the toggle and nothing changed. `toggleTasks` (Space in `markdag/editor`) calls it too, once for each task, in the order the tasks were checked |
| `onNodeClick(node, asTaskToggle)` | The reader clicked the node text, outside a link or a nested control |
| `beforeFold(node, folded)` | The reader clicked a fold circle. Return `false` to keep the branch as it is. Not called for `setFolded`, `expandAll`, `resetFold`, `revealNode` and `focusNode` |
| `beforeSelectEdge(edge, byUser)` / `onSelectEdge` | A line is about to be highlighted, or the highlight cleared (`edge` is `null`). `false` keeps the current selection |
| `beforeSelectGroup(id, byUser)` / `onSelectGroup` | The same for a group frame (`id` is `null` when clearing). A line and a group are never highlighted together: selecting one clears the other, and the cleared one is reported with `null` too |
| `beforeDetailsShow(node, pinned, byUser)` / `onDetailsShow` | The details popover is about to open. `false` keeps it closed |
| `onDetailsHide(node, pinned)` | The popover closed, including when a redraw closed it |
| `onFoldChange(folded, byUser)` | The fold state changed. `byUser` is `true` for a click on a fold circle, `false` for `setFolded`, `revealNode`, `focusNode`, `expandAll` and `resetFold`. Not called when `setDocument` resets the fold state, and not called when `setFolded` is given the current state |
| `onTransform(transform, byUser)` | Pan or zoom changed. `byUser` is `true` for drag, wheel and pinch, `false` for `setTransform`, `panBy`, `zoomBy`, `fit` and `focusNode` |
| `onLayout(snapshot)` | A layout pass finished. Also called from `setDocument` and after images load, so it does not tell you that the reader folded a branch |
| `onNodePointerDown(node, event)` | `pointerdown` on a node box, with any button, before the node's own handlers. `event.preventDefault()` here stops text selection and the other default actions |
| `onNodeDoubleClick(node, place, event)` | Double click on the node text (`place` `label`), on details shown inside the node (`details`) or in the popover (`popover`). Not on tags. The diagram does not zoom |
| `onTagClick(node, key, place, event)` | Click on one tag, in the node (`node`) or in the popover (`popover`). Only with `interaction: 'edit'`, where each tag is its own element. A double click calls it twice |
| `onEdgeClick(edge, event)` | Click on a line (its hit band) |
| `onFrameClick(id, event, frame)` / `onFrameDoubleClick(id, event, frame)` | Click / double click on a group frame or its label. `frame` is the index of that frame among the group's frames, in drawing order, from 0 |
| `onCanvasPointerDown(event, target)` | `pointerdown` anywhere but a node box and a fold circle, also when it starts a pan. `target` is `{ kind: 'blank' }`, `{ kind: 'frame', id }` or `{ kind: 'edge', edge }` |
| `onCanvasClick(event)` | Click on empty space |
| `onIconSvg(ref)` | `setIconSvg` changed the SVG of a logo, after the diagram redrew the places that use it |

- The callbacks from `onNodePointerDown` down are called only when passed, with either `interaction` (except `onTagClick`, as above). A press that moved 4 pixels or more before release is not a click (`onTagClick`, `onEdgeClick`, `onFrameClick`, `onCanvasClick`).
- Lines and frames take clicks only where they can be clicked: with `interaction: 'view'`, a document with `edgeHighlight: false` has no hit bands on its lines and one with `groupHighlight: false` has no clickable frames, so `onEdgeClick` and `onFrameClick` are not called and a press inside such a frame is `blank`.
- `addHooks` adds callbacks after the constructor's, in the order added. For a `before*` callback, the first `false` cancels and the ones after it are not called.
- `createHookBridge` passes these callbacks from its `viewHooks` option to the view as they are; they are not hook events. `render` has no options for them: add them with `diagram.view.addHooks(...)`.

Several diagrams can live on one page. SVG marker ids are prefixed per instance, so each diagram's arrowheads keep their own colors. Esc closes the details popover and clears the line and group highlight (with `interaction: 'edit'`, it only closes the popover); a diagram takes Esc only when focus is inside its container, or when nothing has focus and the pointer was last over the container, so Esc typed elsewhere on the page or meant for another diagram leaves it alone.

### Building an editing layer on the view

The options, callbacks, methods and markers added for `markdag/editor` (`interaction`, `dragToPan`, the press and click callbacks above, `addHooks`, `setSelection`, `attachOverlay` and the rest) let an application put its own layer over a diagram. A diagram that uses none of them looks and behaves as before: the defaults are `interaction: 'view'` and `dragToPan: 'primary'`, the markers below are not set, and callbacks that are not passed are not called.

| Option (`setOptions`) | Type | Default | Meaning |
| --- | --- | --- | --- |
| `interaction` | `'view' \| 'edit'` | `'view'` | `edit` leaves the meaning of clicks to the layer above. Lines and frames can be clicked whatever `edgeHighlight` and `groupHighlight` say. Clicks on lines, frames and empty space, and Esc, do not change the line and group highlight (only `selectEdge`, `selectGroup` and `selectGroups` do), and Esc only closes the popover. A task changes state only from a click on the state icon at its start, not on its text. A primary-button press on a node box does not pan. Tags become one element each (`.mdag-tag[data-tag-key]`) |
| `dragToPan` | `'primary' \| 'middle' \| 'both'` | `'primary'` | The mouse button that pans by dragging empty space. The wheel, ctrl + wheel and touch drags work with every value. With `middle` and `both`, the browser's middle-click autoscroll is prevented. Changing only `dragToPan` does not lay out again |

A minimal layer on a diagram drawn by `render`: select a node by pressing it and show a label above it.

```ts
import { init, render } from 'markdag/core';

await init();
const { view } = render(container, markdownText);
view.setOptions({ interaction: 'edit', dragToPan: 'middle' });

const label = document.createElement('div');
label.textContent = 'selected';
let detach: (() => void) | null = null;

const removeHooks = view.addHooks({
    onNodePointerDown: (node, event) => {
        if (event.button !== 0) return;
        view.setSelection([node.id]);
        detach?.();
        detach = view.attachOverlay(label, { target: { node: node.id }, place: ['top', 'bottom'], gap: 12 });
    },
    onCanvasClick: () => {
        view.setSelection([]);
        detach?.();
        detach = null;
    },
});
// Later: removeHooks(), detach?.() and view.setOptions({ interaction: 'view', dragToPan: 'primary' }) go back to the plain diagram
```

#### Overlays

`attachOverlay(element, anchor)` puts `element` in `.mdag-overlays`, a layer over the diagram area that is created on the first call. Presses go through the layer except on its children. `anchor` is `{ target, place, gap?, within? }`:

- `target`: `{ node: id }` (the node box), `{ nodes: ids }` (the rectangle around the visible ones), or `{ group: id, frame? }` (the group's frame, or the rectangle around its visible members when the group has no frame; `frame` picks one of several frames in drawing order, and the first is used when it is missing or gone).
- `place`: `top`, `bottom`, `left`, `right` (outside that side, centered, `gap` pixels away, default 8), `top-right` (the element's center on the top-right corner), `label` (over the node text or the frame label, scaled with the zoom: give the element's size in diagram units) or `cover` (over the whole rectangle, not scaled). An array tries each in turn and takes the first that fits in the container (the first when none fits). `{ nodes }` treats `label` as `cover`, and a group without a frame treats it as `top`.
- `within`: a function that returns `{ left, right }` (container pixels), called at each placement. `top` and `bottom` are then shifted sideways into that span (an element wider than the span is aligned to its right end), and chosen by whether they fit vertically. Returning `null` leaves the element unshifted.
- While the target is not visible (inside a folded branch, or gone), `element.hidden` is `true`. The returned function detaches the element and restores the `style` values the view wrote. `destroy` detaches everything.

#### Markers

| Marker | When |
| --- | --- |
| `.mdag-node[data-selected]` | `setSelection`. The stylesheet draws an outline around the box in `--markdag-accent`; the text is not restyled |
| `.mdag-node[data-drop-target]` | `setDropTarget`. A dashed outline |
| `.mdag-tag[data-tag-key="<key>"]` | `interaction: 'edit'`: one element per tag in the node's `.mdag-tags` and the popover's `.mdag-popover-tags`, with the same text content as with `view` |
| `.mdag-popover[data-id="<id>"]` | The node whose details popover is open, with any `interaction` |
| `.markdag[data-interaction="edit"]` | `interaction: 'edit'` (not set for `view`) |
| `.markdag[data-drag-to-pan="middle"\|"both"]` | `dragToPan` other than `primary` |
| `.mdag-overlays` | After the first `attachOverlay` |

The types are exported from `markdag` and `markdag/core`: `ViewInteraction`, `DragToPan`, `ViewListeners`, `ViewDocument`, `BranchColor`, `CanvasTarget`, `NodeRectsOptions`, `OverlayAnchor`, `OverlayTarget`, `OverlayPlacement`, `OverlaySpan`, `FitInset`, and the line types `PlacedEdge`, `VisibleEdge` and `RelationKind`.

## Logos

A document names logos in `markdag.icons` (see `icons` in the [writing guide](writing-guide.md)): a `set:name` in the style of Iconify, or the path of an SVG file relative to the document. markdag has no default resolver: it never fetches an icon set and never reads a file. The application supplies the SVG through `resolveIcon`, an option of `render` and of `createHookBridge`:

```ts
type IconResolver = (ref: string) => string | null | Promise<string | null>;
```

- `ref` is the value written in the document (`simple-icons:github`, `./images/our-logo.svg`), after aliases are resolved. Emoji aliases are drawn as characters and never passed.
- A string returned synchronously is in the diagram from the first draw.
- A `Promise` is drawn as the text `:alias:` first. When it resolves, only the places that use that logo are redrawn (node text, details, tags, group frames, legend).
- `null` (returned or resolved), anything that is not a string, or a string that cannot be read as an SVG means the logo is not available: it stays as the text written. Return `null` for a known miss such as a 404: it is still reported as `icon-unresolved` like the other failures below, but the message does not show it as an error.
- A resolver that throws or rejects leaves the logo as text too. The other logos carry on, also when the thrown value cannot be turned into text (the message then says so instead of quoting it).
- Each of these failures is reported once per `ref` as `icon-unresolved` (severity `warning`, no position) through `onDiagnostic`. The message says which kind of failure it was (`null`, not an SVG, or the error). It is not added to `diagnostics` or the return value of `update`. Without `resolveIcon`, no logo is resolved and `icon-unresolved` is never reported.
- Each `ref` is asked once per diagram: several places that use it, `update`, and a redraw after a task click do not ask again, including for a `ref` that failed. Only refs that a new version of the document adds are asked.

A resolver that takes `set:name` from the Iconify API and reads a relative path from where the document lives:

```ts
import { init, render, type IconResolver } from 'markdag';

const resolveIcon: IconResolver = async (ref) => {
    const url = ref.includes(':')
        ? `https://api.iconify.design/${ref.replace(':', '/')}.svg`
        : new URL(ref, documentUrl);
    const response = await fetch(url);
    return response.ok ? response.text() : null;
};

await init();
render(container, markdown, { resolveIcon, onDiagnostic: (diagnostic) => console.info(diagnostic) });
```

### What markdag does with the SVG

- The SVG is sanitized before it is inserted, whatever it comes from. Only an allowlist of SVG elements and attributes is written back; everything else is dropped (`<script>`, `on*` attributes, `<foreignObject>`, HTML elements, comments), and so is anything that would load from outside: `href` and `xlink:href` are kept only when they start with `#`, `url(...)` only when it points to `#...`, and values with character references or `\` are dropped. A string that cannot be read as an SVG document (one `<svg>` root and nothing after it) stays as text; when it came from `resolveIcon`, it is reported as `icon-unresolved`.
- The SVG is inserted inline, not as an `<img>`, so `currentColor` works. With `color: mono` (the default), the stylesheet paints the logo in the current text color, overriding the `fill` and `stroke` attributes of a multi-colored logo: the text color in the body, the muted color in tags and the legend, and the group's color on a frame. `color` in a `style` attribute is not overridden. With `color: original` the logo keeps its own colors.
- The stored SVG is kept when the document changes (`update`, `setDocument`), so the same `ref` is not resolved again.
- Each place that shows a logo gets its own copy of the SVG, with its `id` attributes renamed and the references to them (`url(#id)`, `href="#id"`) updated inside the copy. The same SVG can appear in many places (body, tags, frames, legend) with gradients and clip paths intact.

### Logos without `render`

An application that connects the steps itself (see [Hooks and rules without `render`](#hooks-and-rules-without-render)) passes the same `resolveIcon` to `createHookBridge`. `bridge.setDocument` asks for the refs the document uses and hands the results to the view; `icon-unresolved` goes to the bridge's `onDiagnostic`:

```ts
const bridge = createHookBridge({ source: () => source, resolveIcon, onDiagnostic: showTransient });
```

A `MarkdagView` used without the bridge does not resolve anything. Call `view.setIconSvg(ref, svg)` with each SVG; it is sanitized the same way, and only the places that use `ref` are redrawn. `null` marks the logo as unavailable (text). The refs a document can use are the `ref` of each non-emoji entry in `model.icons.aliases`, plus a `set:name` written directly as `GroupDef.icon`.

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
| `beforeTaskToggle` | Before a click on a task rewrites the source, and for each task `toggleTasks` checks (Space in `markdag/editor`), until one is refused | `node`, `nextState` (the state after the click: `todo`, `doing`, `done` or `canceled`), `next` (`true` when that is `done`), `line` |
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

A node is a copy, not the internal one: `id`, `refId`, `text` (the reference text, empty for a node without a name), `depth`, `parent`, `children`, `groups` (inherited ones included), `tags`, `task` (`{ checked, state, line }` or `null`), `milestone`, `lines`, and `folded` / `visible`, which are read at the moment you look at them. The node HTML is not exposed.

`ctx.api` has `focusNode(id, scale?)`, `revealNode(id)`, `setFolded(ids)`, `getFolded()`, `fit()`, `getTransform()`, `setTransform(transform)` and `update(markdown)`. `setFolded` and the rest do not go through `beforeFold`, so a hook that blocks folding can still fold the diagram itself. A change started this way does not run the `before*` hooks again, and the `on*` hooks it triggers get `byHook: true`. Nesting deeper than four levels is dropped with a `hook-failed` diagnostic.

Modules run in the order they are declared, the application's own hooks last. A `before*` hook that returns `false` ends the round: the hooks after it are not called. A hook that throws is skipped, with a `hook-failed` diagnostic and a call to `onHookError`; the other hooks and the diagram carry on. These diagnostics arrive through `onDiagnostic` because they happen while the reader works, not when the document is rendered; the ones about the declaration itself (`hooks-unresolved`, `hook-unknown-export`, `hook-invalid-export`) are part of `diagnostics`.

## Standalone HTML

`markdag/standalone` turns a diagram into one HTML file that opens on its own (from `file://`, as an attachment, on a static host), with folding, pan, zoom, the legend, the task marks and the details popover still working. The core runtime (`dist/markdag.core.iife.js`, with `markdag.wasm` embedded) and the stylesheet are baked into the module at build time, so the caller's bundler needs no special handling, and the page loads nothing from outside: whatever should be visible has to be inside what you pass.

```ts
import { buildStandaloneHtml, init } from 'markdag/standalone';

await init(); // this entry has its own init, separate from the one in markdag
const html = buildStandaloneHtml({
    title: 'Release plan',
    parsed, // the parseDocument result, with image URLs already rewritten to data: URIs
    types, // the same object you pass to buildModel or render
    view: { theme: 'dark' },
    state: { folded: diagram.view.getFolded() },
    css: ['.markdag { --markdag-bg: #101418; }'],
});
```

`buildStandaloneHtml` builds a string and does not touch the DOM, so it runs in Node as well, and so does `parseDocument`, which produces `parsed` (after the `init` of its own entry). Options:

| Option | Meaning |
| --- | --- |
| `parsed` | A `ParsedDocument`. Rewrite the image URLs in `nodes[].html` (and `details`) before passing it: the page cannot reach relative paths |
| `source` | The Markdown text. With `parsed`, it only positions diagnostics. Without `parsed`, the page parses it when opened |
| `types` | The resolved `markdag.types.$ref` files, keyed by the path as written. Plain objects, embedded as JSON |
| `hookScripts` | The source text of the modules named by `markdag.hooks.$ref`, keyed by the path as written. They are loaded as modules when the page opens (through a blob URL), so each has to be self-contained JavaScript. Omit it and no hooks are loaded (`markdag.rules` still work). Hooks run unsandboxed in the reader's browser: include them only for trusted documents |
| `iconAliases` | The resolved `markdag.icons.$ref` files, keyed by the path as written. The same object you pass as `icons` to `buildModel` or `render` |
| `icons` | The resolved logos: `ref` (`set:name` or relative path, as written) to SVG string. See [Logos in standalone HTML](#logos-in-standalone-html) |
| `view` | `theme`, `details`, `legend`, `animate`, as in the `render` options |
| `state` | `folded`: the ids from `view.getFolded()`, applied over the document's initial fold state. `transform`: `{ x, y, k }`; when omitted the page fits the whole diagram, which is the sensible default because the transform depends on the container size |
| `tasks` | `readonly` (default): a click on a task changes nothing. `scratch`: a click moves the task along `markdag.tasks.cycle` inside the page only, by swapping the state and the mark on the parsed document (`ParsedDocument.taskIcons`); `markdag.rules` and the hooks still decide first. Nothing is saved: reopening the file shows the exported state |
| `title` | The page title. `markdag` by default |
| `lang` | The `lang` attribute of `<html>`. None by default |
| `containerClass` | Extra classes on the container, next to `markdag`, so that a stylesheet can target `.markdag.my-app` |
| `css` | Stylesheets added after markdag's own: color variables, `@font-face` with data: URIs, the CSS of math or code highlighting |
| `head` | HTML added at the end of `<head>`, as it is |
| `runtime` | `script` and `style` replace the baked-in runtime and stylesheet |

What the page does:

- The container fills the viewport (`body` has no margin, the container is `100vh`). Colors come from the stylesheet and `css`.
- Tasks are read-only by default, because there is nowhere to save a rewritten source: a click changes nothing and the cursor stays default. With `tasks: 'scratch'` a click moves the mark inside the page. The container carries the mode as `data-tasks`.
- `styleUrls` of the parsed document are ignored: the page links no external stylesheet. Put what the document needs (KaTeX, Prism) into `css`.
- When the page opens, it awaits `markdag.init()` (the embedded module) and then draws. If that fails, the reason is shown in the container and logged with `console.error`.
- Diagnostics go to the developer console (`console.warn`), and the diagram handle is `window.markdagStandalone`.
- Size: the core runtime is about 3.8 MB (1.4 MB gzipped), almost all of it the embedded `markdag.wasm` in base64, and the stylesheet 11 KB, plus the embedded data. `docs/examples/notation.md` exports to 3.85 MB (1.40 MB gzipped), about 30 times the size of the same export in 0.7.

The page calls `mountStandalone(container, data, options?)`, exported from `markdag` and `markdag/core`. `data` is the same object minus the page options (the `StandaloneData` type). It resolves to `{ view, diagnostics, destroy }`. It does not call `init`: await `init` first. Like `MarkdagView`, it does not add the stylesheet: the exported page embeds it, and an application that calls `mountStandalone` itself (to preview exactly what the exported page will show) loads `markdag/style.css`. Given only `source`, both entries parse it.

The types are exported: `StandaloneOptions`, `StandaloneData`, `StandaloneState`, `StandaloneViewOptions`, `StandaloneRuntime` from `markdag/standalone`, and `StandaloneData`, `StandaloneDiagram`, `MountOptions` from the two entries.

### Logos in standalone HTML

The page has no `resolveIcon` and does not go to the network. Resolve the logos before exporting and pass them as `icons`, a plain table from `ref` to SVG; pass the `markdag.icons.$ref` files as `iconAliases`:

```ts
const refs = new Set<string>();
for (const def of model.icons.aliases.values()) if (def.kind !== 'emoji') refs.add(def.ref);
for (const group of model.groups) if (group.icon?.includes(':')) refs.add(group.icon);

const icons: Record<string, string> = {};
for (const ref of refs) {
    const svg = await Promise.resolve(resolveIcon(ref)).catch(() => null);
    if (svg !== null) icons[ref] = svg;
}
const html = buildStandaloneHtml({ parsed, iconAliases, icons });
```

- `buildStandaloneHtml` sanitizes each SVG before embedding it (see [What markdag does with the SVG](#what-markdag-does-with-the-svg)) and leaves out strings that are not an SVG. The page sanitizes again when it inserts them.
- When the page opens, `icons` becomes a synchronous resolver, so the logos are there from the first draw. A `ref` that is not in the table stays as text and is reported as `icon-unresolved` (warning, no position) in the page's diagnostics, which are logged with `console.warn` and are in `window.markdagStandalone.diagnostics`. `mountStandalone` does the same with `data.icons` and `data.iconAliases`, and adds these diagnostics to the `diagnostics` it returns. Without `icons`, the page resolves nothing and reports nothing.
- Without `icons` and `iconAliases`, the embedded data has no extra fields: the page is the same as one exported without logos.
- The CLI's `markdag html` reads `markdag.icons.$ref` itself and embeds only the logos given as relative `.svg` paths that the document uses, read relative to the document. `set:name` logos stay as text in its output (reported as `icon-unresolved` when the page opens, if at least one SVG file was embedded). A file it cannot read is reported on stderr, and the exit code stays 0. It embeds the file as read; the page sanitizes it when it opens.

## Diagnostics without rendering

```ts
import { checkFrontmatter, formatDiagnostics, init } from 'markdag';
import { parse } from 'yaml';

await init();
const diagnostics = checkFrontmatter(parse(frontmatterText) ?? {}, wholeMarkdownText);
console.log(formatDiagnostics(diagnostics));
```

`checkFrontmatter` checks the shape of the frontmatter only: unknown keys, wrong types and values, the form of relation expressions. Resolving references and detecting cycles needs the node tree: use `parseDocument` + `buildModel` (see the Node example in [Initialize](#initialize)), which need no DOM either. `npm run check` does that from the command line; see [validation.md](validation.md).

`formatDiagnostics` turns diagnostics into text, one per line with the position and an indented hint.
