# Optics bench simulator

A standalone 2D optics bench simulator that runs in the browser. `npm run build` produces a single `dist/index.html` that opens from disk with no server.

```
npm install
npm run dev     # development server
npm run build   # type-check and build dist/index.html
npm test        # unit tests
npm run e2e     # build, then smoke test
```

## Glass data

`src/data/glasses.json` is generated from the CC0 [refractiveindex.info database](https://github.com/polyanskiy/refractiveindex.info-database). To regenerate it:

```
git clone --depth 1 https://github.com/polyanskiy/refractiveindex.info-database
npm run glasses -- <path-to-clone>
```
