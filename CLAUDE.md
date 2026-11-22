# CLAUDE.md

A 2D optics bench simulator that runs in the browser. `npm run build` gives one self-contained `dist/index.html` that opens from disk. `README.md` covers what it does, its controls and the save format.

```
npm install
npm test                             # unit tests, then the timing test alone
npm run build                        # type-check, then dist/index.html
npm run e2e                          # build, then the Chromium smoke test (npx playwright install chromium once)
npm run check-setup -- <setup.json>  # parse a setup and print foci, waists, screen spots, warnings
```

- TypeScript, no UI framework, no runtime dependencies. The engine (`src/engine/`) never touches the DOM.
- Units: mm, nm and degrees in setups and the UI; radians only inside the engine.
- UK English in UI text and docs.
- The `docs/` design and plan record how the app was first built. They are history, not a spec to keep in sync.

| Working on | Skill |
| --- | --- |
| The engine, app plumbing, a wrong readout, a failing test | `optics-bench-engine` |
| Making a setup file from a description, or adding to `examples/` | `create-optics-setup` |
