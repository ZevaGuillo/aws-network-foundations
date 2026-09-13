# 0013 — Refuse to install on an unsupported Node version

**Status:** Accepted
**Date:** 2026-09-13

## Context

The README has always named Node.js 22 as a prerequisite. Nothing checked it. A reader on Node
18 could clone, `npm install`, `npm run build` and watch all three succeed, because
`@types/node` describes a runtime rather than detecting one — the failure would arrive later,
at execution, as a missing API with nothing pointing back at the Node version.

That is the same shape as the problem [ADR-0010](0010-resolve-the-deployment-environment-from-the-cli.md)
solved for credentials: a stated requirement that the tooling did not enforce, degrading
quietly instead of stopping. The answer there was to fail loudly and name the missing thing.

`engines` alone does not do that. npm treats it as advisory and prints `EBADENGINE` as a
warning, then installs anyway — and a warning in the middle of a few hundred lines of install
output is not a stop. Only `engine-strict=true` turns it into a refusal, and that setting lives
in `.npmrc`, which has to be committed for it to apply to anyone but its author.

## Decision

Declare `"engines": { "node": ">=22" }` in `package.json`, and commit an `.npmrc` containing
`engine-strict=true` so the declaration is enforced rather than suggested.

The floor is 22 because that is what the README promises and what `@types/node` is pinned to.
Those two belong together: types describe the oldest supported runtime, `engines` refuses
anything below it, and until now the types said 24 while the README said 22 and neither was
checked. They state the same fact again, in the two places that can act on it.

## Consequences

**Easier.** The prerequisite in the README is now true rather than aspirational. Someone on an
older runtime is stopped at `npm install`, by an error naming the required and actual versions,
rather than at some later point with no clue attached:

```
npm error code EBADENGINE
npm error notsup Required: {"node":">=22"}
npm error notsup Actual:   {"npm":"11.4.2","node":"v22.17.0"}
```

That output is from a deliberate mutation — requiring `>=99` against the real runtime — because
a guard that has never been seen to fire is a guard nobody has verified. It was reverted.

**Harder.** `engine-strict` applies to dependencies too, not only to this package. A dependency
that declares an `engines` range excluding the local runtime now blocks the install instead of
warning. A clean `npm ci` on Node 22.17.0 was run to confirm the current tree installs cleanly,
but a future dependency bump can turn this into a hard stop where it used to be noise. That is
the intended trade, and it is the kind of stop that should be read rather than worked around.

**What it costs.** A committed `.npmrc`, which is a file that usually deserves suspicion — it
is where registry credentials and auth tokens live. This one contains a single line and no
secret, and it must stay that way. Anything requiring a token belongs in a machine-level
`~/.npmrc`, never here. This repository is public.

**The alternative rejected.** A `preinstall` script running a version check would work without
`.npmrc`, but it is a script where a declaration will do, it runs arbitrary code on install,
and it duplicates a field npm already understands. `engines` is the mechanism designed for
this; the only thing missing was making it binding.
