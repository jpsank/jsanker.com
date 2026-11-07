Vendored, pinned, unmodified (apart from a stripped sourceMappingURL comment) ES modules. No build step.

- marked 18.1.3 (MIT) - marked/marked.esm.js, from lib/marked.esm.js
- DOMPurify 3.4.17 (Apache-2.0 / MPL-2.0) - dompurify/purify.es.mjs, from dist/purify.es.mjs
- NGL 2.5.0 (MIT) - ngl/ngl.js, the minified UMD build `dist/ngl.js` from the npm package `ngl` (defines a global `NGL`; loaded as a classic script, on demand, by the ProTop pages). Works under the site's default CSP: it only starts blob: workers for features ProTop does not use (surfaces, density maps).
