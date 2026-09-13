# 0002 — The repository is self-contained

**Status:** Accepted
**Date:** 2026-09-13

## Context

Every design here came from somewhere — reading, practice, mistakes made against a live
account. That is true of all engineering work and it does not need announcing.

But a reader of this repository has only this repository. A pointer to anything outside it is
either a dead end for them or an invitation to read something that was never written for
them. Worse, it reframes the work: a document that cites its own scaffolding reads as a study
log, not as a designed system. The thing being presented is the architecture and the reasoning
behind it, and that reasoning has to stand up on its own terms.

## Decision

Everything needed to understand a decision is written here, in this project's own words.

- No document, comment, or commit message in this repository points to a file, course, note,
  or artifact that lives outside it.
- External material may inform a decision. It is never offered as the justification for one.
- When a fact carries the argument — a price, a service default, a count of reserved
  addresses — it is stated directly and plainly, so a reader can check it against AWS
  documentation rather than take it on trust.

The practical test: if a claim can only be verified by reading something that is not in this
repository, the claim is written wrong.

## Consequences

**Easier.** The repository can be cloned, read, and judged on its own. Nothing dangles. No
unrelated material leaks into it.

**Harder.** Reasoning has to be rewritten rather than linked, every time. Each claim must be
independently checkable, which is a higher bar than "I read this somewhere".

**The cost.** Some context that exists elsewhere is genuinely lost to the reader. Accepted:
the reasoning is what matters, and rewriting it is what forces it to be understood rather than
repeated.

**Related.** [0001](0001-record-architecture-decisions.md) — the ADRs are where that rewritten
reasoning goes.
