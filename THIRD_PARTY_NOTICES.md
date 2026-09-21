# THIRD PARTY NOTICES

markdag uses the software listed below. Both the parts that were copied and modified, and the parts that are bundled as dependencies, are listed.

## Copied and modified

### markmap (markmap-view)

- The CSS and CSS custom properties for the HTML inside a node, in `src/style.css`, were copied from markmap-view's `src/style.css` with the selectors changed to `.mdag-content` and friends.
- Several rules also follow markmap's implementation: how branch colors are assigned, the initial expand level, and the fit-to-view calculation.

```
MIT License

Copyright (c) 2020 Gerald

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Dependencies

What ships in the build, and what those packages depend on. The full license text of each is in `node_modules/<name>/LICENSE`.

| Package | License | Used for |
| --- | --- | --- |
| markmap-lib | MIT | Turning Markdown into a tree of nodes |
| markmap-view | MIT | Pulled in as a dependency of markmap-lib |
| markmap-common | MIT | Same |
| markmap-html-parser | MIT | Same |
| markdown-it (with the ins, mark, sub, sup plugins) | MIT | Dependency of markmap-lib |
| @vscode/markdown-it-katex | MIT | Same |
| katex | MIT | Math rendering |
| highlight.js | BSD-3-Clause | Code highlighting |
| prismjs | MIT | Code highlighting |
| yaml | ISC | Position-aware frontmatter parsing |
| d3-flextree | WTFPL | Tree layout with variable node sizes |
| d3-hierarchy | ISC | Dependency of d3-flextree |
| d3-selection | ISC | Applying zoom and pan |
| d3-zoom | ISC | Zoom and pan |
| @babel/runtime | MIT | Dependency of markmap-lib |

Development-only (not in the build): typescript (Apache-2.0), vite (MIT), vitest (MIT), @playwright/test (Apache-2.0), @dagrejs/dagre (MIT), vite-node (MIT), d3-shape (ISC), @types/* (MIT).
