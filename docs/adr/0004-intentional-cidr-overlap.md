# 0004 — Reserve an intentional CIDR overlap for the PrivateLink experiment

**Status:** Accepted
**Date:** 2026-09-13

## Context

[0003](0003-repo-wide-ipv4-addressing-plan.md) exists because overlapping address ranges make
VPC peering impossible. That constraint is usually presented as a warning to be avoided.

It is more useful as a demonstration. The sharpest question a private-connectivity module can
answer is: *what do you do when peering is not merely inconvenient but structurally
unavailable?* Two VPCs using the same address range cannot be peered — there is no route table
entry that can disambiguate `10.1.0.42` when it exists on both sides.

PrivateLink is indifferent to this. The consumer reaches the service through an endpoint
network interface placed inside the consumer's own subnet, addressed from the consumer's own
range. No route between the two address spaces is ever needed, so there is nothing to
conflict. The overlap that kills peering is invisible to it.

Demonstrating that requires an overlap to actually exist. It cannot be described; it has to be
deployed and observed failing.

## Decision

Module 4's consumer VPC reuses `10.1.0.0/16` — module 3's VPC A range — byte for byte, on
purpose.

Three measures keep the collision from being read as a defect and "corrected":

1. **It is expressed as a reference, not a literal.** The module 4 entry points at the module 3
   value rather than repeating the string. The duplication is a link that cannot silently drift
   apart, and anyone changing it has to notice they are unlinking something.
2. **The field name carries the intent.** Named so that the collision is visible at every
   usage site, not only where it is defined.
3. **A test asserts the collision still holds.** A comment asks a reader not to fix something;
   a failing test stops them. This is the only reliable guard, because the change that breaks
   the experiment leaves every stack green.

## Consequences

**Easier.** Module 4 gets its central demonstration: the same pair of VPCs where peering is
impossible and PrivateLink is unbothered. The comparison is direct, not hypothetical.

**Harder.** The plan in [0003](0003-repo-wide-ipv4-addressing-plan.md) now has an exception in
it, and exceptions invite exceptions. This is the only one, and it is argued in its own record
for exactly that reason.

**The cost.** Module 3's VPC A and module 4's consumer can never be peered, by construction.
That is not a limitation to work around — it is the finding.

**Watch for.** Anyone skimming the configuration sees what looks like a copy-paste error. The
three measures above exist solely to survive that skim.
