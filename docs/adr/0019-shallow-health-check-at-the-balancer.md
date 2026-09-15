# 0019 — The balancer's health check is shallow; the dependency check is a separate path

**Status:** Accepted — amended by [0029](0029-the-deep-check-is-a-reachability-probe.md)
**Date:** 2026-09-14

## Context

A target group's health check decides which instances receive traffic. Two things have to be
chosen: what path it requests, and how deeply that path should look.

### Why the default path is wrong

The default is `/`. A web tier serving HTML returns 200 from `/` whether or not the backend it
depends on is reachable, whether or not its database connection pool is exhausted, and whether
or not it can do anything a user came for. Every target stays healthy, the balancer keeps
routing, and the failure surfaces as a page that loads and does nothing.

The check reports on the web server. Nobody was asking about the web server.

So the path is `/health`, and it is named here rather than discovered later — because the target
group carries it, and the target group is built in layer 3 while the application that answers it
is written in layer 4. That inverts the usual order, and the inversion is deliberate: **the
infrastructure states the contract and the application obeys it**, not "the app happens to have
a health endpoint, point the target group at it".

### Why the obvious depth is also wrong

The instinct is to make the frontend's `/health` call the backend, so a broken backend marks the
frontend unhealthy and the failure propagates honestly. It is a good instinct and it builds a
cascading failure into the architecture.

Follow it through:

1. The backend degrades.
2. Every frontend target fails its health check, because every check calls the backend.
3. The external target group now has **zero** healthy targets.
4. The ALB **fails open**: when no target in a target group is healthy, it routes requests to
   all of them anyway.

The end state is traffic flowing exactly as it did before the backend broke. The deep check did
not shed load, did not fail fast, and did not protect anything. What it did do is destroy the one
signal that was worth having — with every frontend target red, there is no longer any way to
distinguish a broken frontend from a broken backend by looking at the console. The aggregate
hides which tier actually failed, which is the opposite of what a health check is for.

There is a second cost, and it lands at the worst moment. With an interval of ten seconds across
N frontend targets, every probe becomes a backend request. The dependency check generates its
heaviest load on the dependency precisely while that dependency is already struggling.

## Decision

The health check the balancer calls is **shallow**. The dependency check is a **separate path**
that no balancer ever calls.

| Path | Called by | What it does |
|---|---|---|
| `/health` | the load balancer, every 10 seconds | Shallow. The process is up and serving. Nothing downstream is touched |
| `/health/deep` | a human, by hand, during the experiment | Calls the backend and reports what it found |

Only `/health` appears in this layer, because only `/health` is a target group property.
`/health/deep` is a requirement recorded against layer 4.

This follows the reasoning AWS publishes for its own services: shallow checks at the load
balancer, deep checks reported separately, because a health check that fails for reasons outside
the instance turns a dependency's bad day into every tier's bad day simultaneously.

## Consequences

**Easier.** A frontend target is marked unhealthy when the frontend is unhealthy, which makes
the console readable: the tier showing red is the tier that broke. The backend is not polled by
the frontend's health checks, so its load does not scale with the frontend's instance count.

**Harder.** The demonstration takes two readings instead of one. `curl /health` and
`curl /health/deep` tell different stories, and understanding the module means understanding why
they differ. A single aggregate number would have been simpler to look at and would have meant
less.

**What it costs.** A frontend whose backend is unreachable stays in service and serves errors.
That is a genuine gap, not a technicality — the balancer will keep routing to a tier that cannot
complete a request. The answer is that it would have done so anyway through the fail-open
behaviour above; this record makes the outcome intentional and visible rather than an accident
discovered during an incident. Shedding load when a dependency fails is a circuit breaker's job,
and a circuit breaker is application code, not a target group property.

**What cannot be guarded.** `/health/deep` is asserted by nothing. No test can check an endpoint
that no infrastructure references, so it survives only by being carried forward in layer 4's
plan. That is a weaker guarantee than this repository usually accepts, and it is stated plainly
here rather than left to look like an oversight.

> **Amended by [ADR-0029](0029-the-deep-check-is-a-reachability-probe.md), 2026-09-14.** Two
> corrections, and the decision above survives both.
>
> The argument here is the weaker of the two available. The stronger one is that the backend's
> health is **already measured, better** — it has its own target group behind the internal
> balancer, polled per target, and `UnHealthyHostCount` is the signal. Chaining would not add a
> measurement; it would duplicate an existing one at lower resolution and pay the cascade for it.
>
> And the paragraph above is wrong about the gap. `/health/deep` is not an under-guarded health
> endpoint — it is not a health endpoint. It is a reachability probe across the chain layers 2
> and 3 built, which covers hops the backend's own check cannot. The only thing worth asserting
> about it is the negative: that no target group ever points at it.

**The guard that does exist.** One assertion: the health check path in both target groups is
`/health` and not `/`. It catches the default silently returning during a refactor, which is the
failure with the longest diagnosis time in this record — everything is green, and nothing works.

**When this is revisited.** When layer 4 writes the application, and again if the experiments
show the shallow check missing a failure mode worth catching. Adding depth is then a decision
with this record as its starting point, including the fail-open behaviour that has to be
designed around rather than rediscovered.
