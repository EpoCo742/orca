# sample-target

A deliberately broken tiny Node project used as the target repository for Orca's "fix until green" workflow. `npm test` fails on three tests until `src/math.js` is fixed. Orca templates reset this file before each run (see `docs/demos/`).
