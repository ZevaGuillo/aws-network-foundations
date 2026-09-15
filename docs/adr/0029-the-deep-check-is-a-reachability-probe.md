# 0029 — The deep check is a reachability probe, not a health check

**Status:** Accepted — amends [0019](0019-shallow-health-check-at-the-balancer.md)
**Date:** 2026-09-14

## Context

[ADR-0019](0019-shallow-health-check-at-the-balancer.md) decided that the balancer's health check
stays shallow and that the dependency check lives on a separate path, `/health/deep`. The
argument was the cascade: chain the checks and a degraded backend marks every frontend target
unhealthy, at which point the ALB fails open and routes to all of them anyway — traffic flowing
exactly as before, with the one useful signal destroyed.

That argument is correct. It is also the weaker of the two available, and the stronger one was
missed.

### The argument that was missing

**The backend's health is already measured, and measured better.**

Layer 3 gave the backend its own target group behind the internal balancer, with its own health
check. The internal ALB therefore polls every backend target directly, every ten seconds, and
`UnHealthyHostCount` on that target group is the signal — per target, with a count, rather than a
boolean inference of "something downstream is unwell" derived from the frontend failing.

Chaining the checks would not have added a measurement. It would have **duplicated an existing
one at lower resolution**, and paid for it with the cascade.

That reframes the original decision from "we avoid a failure mode" to "we decline to rebuild,
worse, something we already have" — which is a better reason, and one that holds even in a world
where the ALB did not fail open.

### Why `/health/deep` survives anyway

The two are not the same measurement, and the difference is precisely this repository's subject:

```
backend target group health check    internal ALB ──────────────────→ backend
/health/deep from the frontend       frontend ──→ internal ALB ──────→ backend
```

The second additionally traverses the frontend's egress, the layer 2 ingress rule
`internalAlb ← frontend:80`, the internal balancer's listener, and DNS resolution of the internal
balancer's name from inside the VPC. None of that is covered by the backend's own health check,
and all of it is what layers 1 through 3 spent their time building.

So the endpoint is not asking whether the backend is alive. That question is answered elsewhere,
better, by something that was going to poll anyway.

## Decision

`/health/deep` is a **reachability probe**, and the name it is given, the thing it returns and the
way it is exercised all follow from that.

It answers: *can this tier reach that tier through the chain layers 2 and 3 built.* It returns the
backend's response **and the time it took**, so the reading is a number rather than a boolean. It
is called by a human during an experiment, and by nothing else.

**No target group references it, ever.** That is the load-bearing clause.

## Consequences

**Easier.** The two questions are now separate and each has one instrument. "Is the backend
healthy" is a CloudWatch metric that already exists and costs nothing to read. "Does the chain
work end to end" is a curl that returns a duration. Neither is a degraded version of the other.

**Harder.** Someone looking for backend health will find `/health/deep` first, because it is in
the source and the metric is in a console. The naming is the only defence, which is why the
record insists on "probe" rather than "check".

**What it costs.** A frontend whose backend is unreachable still serves errors, unchanged from
ADR-0019. Neither record fixes that, and neither should: shedding load when a dependency fails is
a circuit breaker, which is application logic and not a target group property.

**What this settles.** ADR-0019 recorded a weakness — that `/health/deep` is asserted by nothing,
and that this is "a weaker guarantee than this repository usually accepts". That framing was
wrong, and correcting it is part of this amendment. The endpoint is not under-guarded; it is not
infrastructure at all. It is the experiment's instrument, and the only thing worth asserting
about it is the negative: that no target group's `HealthCheckPath` ever points at it. That
assertion is cheap, exact, and catches the one change that would matter — someone deciding the
deep check should drive routing after all, which is the cascade coming back through the door
ADR-0019 closed.

**What does not change.** ADR-0019's decision stands entirely: shallow at the balancer, deep on a
separate path. Its reasoning gains a leg and loses a mistaken confession. Nothing in
`lib/module1-load-balancers.ts` moves.

**When this is revisited.** If a later module puts something between the frontend and the internal
balancer — a service mesh, a proxy, an interface endpoint — the probe's path changes and what it
proves changes with it. Worth re-reading then, because the value of the probe is entirely in
which hops it crosses.
