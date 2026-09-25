# THIRD PARTY NOTICES

markdag uses the software listed below. Both the parts that were copied and modified, and the parts that are bundled as dependencies, are listed.

## Copied and modified

### markmap (markmap-view, markmap-lib, markmap-html-parser)

- The CSS and CSS custom properties for the HTML inside a node, in `src/style.css`, were copied from markmap-view's `src/style.css` with the selectors changed to `.mdag-content` and friends.
- Several rules also follow markmap's implementation: how branch colors are assigned, the initial expand level, and the fit-to-view calculation.
- The Rust parse layer (`crates/markdag-core`) contains hand ports of rules from markmap-lib 0.18.12 (the markdown-it setup, the frontmatter plugin and its option normalization, `cleanNode`, and the source-lines and checkbox plugins) and markmap-html-parser 0.18.11 (`parseHtml`, `convertNode`, `buildTree`, and the magic comments), used to build the outline tree the same way. The task state icons are drawn separately and are not copied from markmap.

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

### markdown-it

- The Rust parse layer (`crates/markdag-core`) contains a hand port of markdown-it 14.3.2's renderer (`lib/renderer.mjs`) and `normalizeLink` / `validateLink` (`lib/index.mjs`), used to write the HTML of each node the same way.

```
Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### mdurl

- The Rust parse layer (`crates/markdag-core`) contains a hand port of mdurl 2.1.0's `parse`, `format`, and `encode`, used to normalize link and image URLs the same way markdown-it's `normalizeLink` does.

```
Copyright (c) 2015 Vitaly Puzrin, Alex Kocharin.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

--------------------------------------------------------------------------------

.parse() is based on Joyent's node.js `url` code:

Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

### punycode.js

- The Rust parse layer (`crates/markdag-core`) contains a hand port of punycode.js 2.3.1's `encode` and `toASCII`, used to convert internationalized host names in link and image URLs.

```
Copyright Mathias Bynens <https://mathiasbynens.be/>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### d3-flextree

- The Rust layout layer (`crates/markdag-core`) contains a hand port of d3-flextree 2.1.2's layout algorithm (`src/flextree.js`), used to place tree nodes of varying sizes.

```
        DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
                    Version 2, December 2004

 Copyright (C) 2004 Sam Hocevar <sam@hocevar.net>

 Everyone is permitted to copy and distribute verbatim or modified
 copies of this license document, and changing it is allowed as long
 as the name is changed.

            DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
   TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION

  0. You just DO WHAT THE FUCK YOU WANT TO.
```

## Dependencies

What ships in the build, and what those packages depend on.

### JavaScript (bundled into `dist/`)

The full license text of each is in `node_modules/<name>/LICENSE`.

| Package | License | Used for |
| --- | --- | --- |
| d3-selection | ISC | Applying zoom and pan |
| d3-zoom | ISC | Zoom and pan |
| d3-dispatch, d3-drag, d3-interpolate, d3-color, d3-transition, d3-timer | ISC | Dependencies of d3-zoom |
| d3-ease | BSD-3-Clause | Dependency of d3-zoom (through d3-transition) |

KaTeX (MIT) and highlight.js (BSD-3-Clause) are not bundled. The default entry's `render` loads them from jsDelivr at run time when a document uses math or code, and `markdag/core` uses them only when the page already has them.

### Rust (compiled into `dist/markdag.wasm`)

The versions are the ones in `Cargo.lock`. The full license text of each is in the crate's source on crates.io (`<name>-<version>/LICENSE*`).

| Crate | Version | License | Used for |
| --- | --- | --- | --- |
| comrak | 0.55.0 | BSD-2-Clause | Turning Markdown into an AST |
| caseless | 0.2.2 | MIT | Dependency of comrak |
| finl_unicode | 1.5.0 | (MIT OR Apache-2.0) AND Unicode-DFS-2016 | Same |
| jetscii | 0.5.3 | MIT OR Apache-2.0 | Same |
| phf, phf_shared | 0.13.1 | MIT | Same |
| siphasher | 1.0.3 | MIT/Apache-2.0 | Dependency of phf |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | Dependency of comrak |
| smallvec | 1.16.1 | MIT OR Apache-2.0 | Same |
| typed-arena | 2.0.2 | MIT | Same |
| saphyr-parser | 0.0.12 | MIT OR Apache-2.0 | Position-aware frontmatter (YAML) parsing |
| arraydeque | 0.5.1 | MIT/Apache-2.0 | Dependency of saphyr-parser |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | Same |
| regress | 0.10.5 | MIT OR Apache-2.0 | JavaScript-compatible regular expressions (user-written patterns in tag types and the schema, and task marks) |
| hashbrown | 0.16.1, 0.17.1 | MIT OR Apache-2.0 | Dependency of regress and indexmap |
| allocator-api2 | 0.2.21 | MIT OR Apache-2.0 | Dependency of hashbrown |
| foldhash | 0.2.0 | Zlib | Same |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | Dependency of indexmap and hashbrown |
| regex | 1.13.1 | MIT OR Apache-2.0 | Regular expressions in the parse and model layers |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 | Dependency of regex |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 | Same |
| aho-corasick | 1.1.5 | Unlicense OR MIT | Same |
| memchr | 2.8.3 | Unlicense OR MIT | Dependency of regex, regress, and serde_json |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | Maps that keep insertion order |
| serde, serde_core | 1.0.229 | MIT OR Apache-2.0 | The JSON at the wasm boundary |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | Same |
| itoa | 1.0.18 | MIT OR Apache-2.0 | Dependency of serde_json |
| zmij | 1.0.23 | MIT | Same |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 | Unicode normalization (also a dependency of caseless) |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | Dependency of unicode-normalization |

Build-time only (procedural macros, not in the `.wasm`): serde_derive, thiserror-impl, proc-macro2, quote, syn (MIT OR Apache-2.0), unicode-ident ((MIT OR Apache-2.0) AND Unicode-3.0).

Development-only (not in the build): typescript (Apache-2.0), vite (MIT), vitest (MIT), @playwright/test (Apache-2.0), @dagrejs/dagre (MIT), vite-node (MIT), yaml (ISC), d3-shape (ISC), monaco-editor (MIT), @types/* (MIT), saphyr (MIT OR Apache-2.0).
