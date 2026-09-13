# 0007 — Split the VPC into /24 subnets

**Status:** Accepted
**Date:** 2026-09-13

## Context

The base network is a `/16` carved into four subnets: public and private, across two
availability zones. The mask for those subnets has to be chosen up front, because **a subnet's
CIDR block is immutable once the subnet exists.** Getting it wrong is not a configuration
change; it is recreating the subnet and everything running in it.

The VPC console wizard defaults to `/20` subnets, which yields 4,091 usable addresses each —
for a network that will run a handful of instances. That is not dangerous, it is just
uninformative: a number nobody chose and nobody can explain.

The arithmetic that actually matters is what AWS takes off the top. **Five addresses are
reserved in every subnet**, regardless of size:

| Address | Purpose |
|---|---|
| first | network address |
| first + 1 | VPC router |
| first + 2 | DNS |
| first + 3 | reserved for future use |
| last | broadcast — reserved even though AWS does not support broadcast |

So a subnet never gives you the number its mask suggests. The tax is fixed, which means it
hurts small subnets disproportionately.

## Decision

Use a `/24` mask for every subnet in the base network.

- A `/24` holds 256 addresses and yields **251 usable**.
- The same five-address tax is why a `/28` yields **11 usable and not 16** — the detail that
  catches people out when they size a subnet tightly.
- A `/16` divided into `/24`s gives 256 slots. Four are used, leaving 252 free for later
  subnets in this module.

## Consequences

**Easier.** Subnet boundaries fall on octet boundaries, so ranges are readable without doing
binary arithmetic. Room to add subnets without redesigning the split.

**Harder.** Nothing meaningful at this scale.

**The cost.** 251 usable addresses per subnet is a real ceiling, not a theoretical one — a
large auto-scaling group plus load balancer interfaces plus endpoint interfaces can approach
it. At that point the subnet cannot be resized, only replaced. `/24` is chosen as the smallest
mask that leaves that possibility remote while staying legible.

**Watch for.** Subnet exhaustion presents as instances failing to launch with an address
error, not as anything that names the subnet size. Worth recognising once.
