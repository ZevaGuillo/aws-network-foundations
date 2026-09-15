# 0031 — One runtime: Node

**Status:** Accepted — supersedes [0025](0025-the-runtime-is-a-deployment-property.md)
**Date:** 2026-09-14

## Context

[ADR-0025](0025-the-runtime-is-a-deployment-property.md) shipped two applications, made the
runtime a stack property, and declared that the difference in boot time between them was layer
4's output. Python was the default because Amazon Linux 2023 ships it; Node was the opt-in that
paid for a `dnf install`.

It closed with a condition for undoing itself:

> If the difference turns out to be small enough not to change any layer 5 decision, the right
> move is to keep the measurement in the README and drop one runtime from the code — the table
> is the deliverable, the second code path is only the means.

This is that reversal arriving early, and by a different route. **The comparison was never
run.** No deployment was made, no boot time was taken, and there is no table to keep. The second
code path is being dropped before it produced the thing that justified it.

That is a decision about scope rather than a finding, and recording it as anything else would be
dishonest.

### What the second runtime was costing in the meantime

Two programs that have to be identical route for route, with nothing enforcing the
correspondence except their length and a comment saying so. A comparison between two programs
that have drifted is not a comparison of runtimes, and the drift would not fail anything.

Every experiment downstream inherits an extra dimension. A layer 5 result is "under Python" or
"under Node", which is a variable layer 5 did not ask for.

## Decision

**Node, and only Node.** `lib/app/server.js` stays, `lib/app/server.py` is deleted, and the
`runtime` stack property and its context lookup go with it.

Module 1's tiers run `/usr/bin/node`, installed at boot with `dnf install -y nodejs`.

## Consequences

**Easier.** One application. One boot path. One number for layer 5 to use as its warm-up
estimate, measured once rather than measured twice and compared. `bin/app.ts` goes back to
having no context lookups at all, which was true of this repository until layer 4 and is true
again.

**Harder.** Nothing.

**What it costs, and this is the part that is not free.** The expensive boot path is now the only
boot path.

Amazon Linux 2023 ships Python and does not ship Node, so every instance this module launches
runs `dnf install -y nodejs` before it can serve a request. That is minutes of boot time, and
bytes through the NAT Gateway at the $0.045/GB [ADR-0008](0008-s3-gateway-endpoint.md) already
wrote down — on every launch, on every scale-out, on every instance refresh.

Under ADR-0025 that cost was opt-in and there was a free alternative sitting next to it. Now it
is unconditional and there is nothing to fall back to. Layer 5 inherits it directly: a slower
boot means a larger `estimatedInstanceWarmup`, which means a scaling policy that responds later,
and it means rolling replacement is more expensive than it would have been.

The number is still worth taking — it is simply a measurement now rather than a comparison.

**What this does not change.** [ADR-0026](0026-the-application-contract.md)'s contract stands
entirely: the application still carries no dependencies, still binds `0.0.0.0`, and still takes
its port from the target group's constant. One of that record's four reasons — keeping the
comparison measuring runtimes rather than package managers — no longer applies, and the other
three do. The 16 KB user data limit, the cost of a slow instance refresh, and the boot-time
dependency on a package registry are all still real, and the last one is more real than it was,
because `dnf install` is now on every boot with no alternative.

**The guard.** The assertion that the boot script installs a runtime stays, inverted: it asserted
that Python installed nothing and Node installed something, and it now asserts unconditionally
that `dnf install -y nodejs` is present. A boot script that stopped installing Node would produce
an instance whose `ExecStart` points at an interpreter that is not there — systemd would retry
forever under `Restart=always`, the target would never turn healthy, and nothing would name the
missing package.

**When this is revisited.** If boot time turns out to be the thing limiting layer 5's
experiments. At that point the options are a baked AMI, a container image, or reinstating the
runtime that needed no install — and this record is why the last one was removed before it was
measured.
