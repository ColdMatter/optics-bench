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

## Lens catalogue

`src/data/lenses.json` holds the Thorlabs lenses parsed from their Zemax files. The Thorlabs focal-shift curves in `src/data/thorlabs-focal-shift/` validate the tracer against them. To regenerate both (needs Playwright with Chromium, and `pdftotext` from Poppler):

```
npm run lenses              # download into scripts/vendor-cache/, then rebuild
npm run lenses -- --offline # rebuild from the cache
```
