# 0001 — Record architecture decisions in ADRs

**Status:** Accepted
**Date:** 2026-09-13

## Context

This repository is built to be read. It is infrastructure, but its purpose is to explain
itself: what was built, why that shape and not another, and what the choice costs per month.

Code alone cannot carry that. A construct shows the option that won. It cannot show the two
that lost, the price attached to each, or the constraint three modules away that forced the
outcome. Decisions made without a record become folklore — by the time the multi-VPC work
starts, nobody remembers why the base network has the address range it has, and the reasoning
gets reconstructed badly or ignored entirely.

Comments help, but they live at a single call site and are scoped to one line of code. Some
decisions span files, or span modules, or are about something deliberately *not* built.

## Decision

Record every non-obvious decision as a numbered ADR in `docs/adr/`, committed alongside the
change it justifies.

- Numbering is sequential and permanent. Records are never deleted or renumbered.
- A decision that changes does not edit the old record. The old record is marked `Superseded`
  with a pointer forward, and a new record explains what changed and why. The sequence is the
  project's history.
- Division of labour with code comments: the **comment** states the why at the point of use,
  briefly, for someone reading the code. The **ADR** holds the full record — alternatives,
  numbers, date, and consequences.
- Every price is stated with its region and the date it was true.

## Consequences

**Easier.** A reviewer can read the decisions without reading the code, in the order they were
made. The development of the project becomes visible as a sequence rather than as a final
state. Arguments already settled do not get relitigated.

**Harder.** Discipline. An ADR written weeks after the fact is a reconstruction, and worth
much less than one written at the moment of choosing.

**The cost.** Two places to touch when a decision changes: the record and the comment. Accepted
deliberately — the comment stays short precisely because the ADR exists to hold the detail.
