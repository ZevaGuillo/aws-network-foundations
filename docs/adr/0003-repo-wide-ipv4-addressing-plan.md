# 0003 — Fix the IPv4 addressing plan before the first VPC

**Status:** Accepted
**Date:** 2026-09-13

## Context

This repository builds five modules that grow into each other. Two of them are about
connecting VPCs: one peers them across regions, one exposes services privately between them.

VPC peering requires non-overlapping CIDR blocks. That requirement has no workaround and no
remedy after the fact. A VPC's address range cannot be changed once the VPC exists — a
secondary range can be added, but the primary is fixed, and two VPCs whose ranges overlap can
never be peered under any configuration. The only fix is to destroy one and rebuild it, along
with everything inside it.

The trap is that `10.0.0.0/16` is the range everyone reaches for. It is the console wizard's
suggestion and the example in most documentation. A repository built module by module, each
one choosing its range at the moment it is written, ends up with five identical VPCs and a
peering module that cannot start.

The decision is cheap now and expensive later. That asymmetry is the whole argument.

## Decision

Fix the address plan for the entire repository now, before the first VPC is created, and keep
it in one place.

| Module | VPC | CIDR |
|---|---|---|
| 1 | base network | `10.0.0.0/16` |
| 3 | VPC A | `10.1.0.0/16` |
| 3 | VPC B | `10.2.0.0/16` |
| 3 | VPC C — proves peering is not transitive | `10.3.0.0/16` |
| 4 | consumer — intentionally overlapping | `10.1.0.0/16` |

Each module gets a distinct `/16` from the `10.0.0.0/8` private space, numbered to match the
module. A reader can tell which module owns an address by looking at its second octet.

The plan lives in `lib/config.ts` as plain data. No module hardcodes a CIDR at the point of
use; every VPC derives its range from this table.

The final row is a deliberate exception and is argued separately in
[0004](0004-intentional-cidr-overlap.md).

## Consequences

**Easier.** The peering module works when it is reached, with no rework. Any two ranges can be
compared at a glance. Adding a module means adding a row, not editing an existing stack.

**Harder.** The plan is being chosen with incomplete knowledge of what modules 3 through 5 will
actually need. Some of it is a guess.

**The cost.** Each module is capped at one `/16` — 65,536 addresses. Given that a module here
runs a handful of subnets, that ceiling will not be reached. If it ever is, the module gets a
second range and a new record explains why.

**Related.** [0005](0005-framework-free-configuration-module.md) — where the plan lives and why
it has no CDK dependency.
