# 0017 — Write the health check and deregistration timings out, never inherit them

**Status:** Accepted
**Date:** 2026-09-14

## Context

A target group decides whether a target is alive, and when a target stops receiving traffic.
Five numbers govern that, and Elastic Load Balancing supplies all five if you do not.

| Property | Default | What the default means in practice |
|---|---|---|
| `interval` | 30s | |
| `healthyThresholdCount` | 5 for an ALB | **150 seconds** before a healthy new instance receives its first request |
| `unhealthyThresholdCount` | 2 | **60 seconds** of traffic sent to an instance that is already dead |
| `timeout` | 6s for HTTP | |
| `deregistrationDelay` | 300s | **Five minutes** per batch, on every deployment and every teardown |

The 150 seconds and the 60 seconds are the numbers this module exists to measure. An instance
that takes two and a half minutes to enter service is the difference between an auto scaling
policy that responds to a traffic spike and one that responds to the spike after it ended. Sixty
seconds of requests routed into a dead process is the failure a health check was supposed to
prevent, arriving one minute late.

### Where these numbers are not

They are not in the source, and they are not in the deployed artifact either.

Read the CDK's `TargetGroupBase` constructor. Every health check property on the generated
`CfnTargetGroup` is derived from the `healthCheck` prop — `healthCheckIntervalSeconds`,
`healthyThresholdCount`, `healthCheckTimeoutSeconds`, all of them. With no `healthCheck` block
they derive to `undefined` and **vanish from the template entirely**.

So a target group written the short way produces CloudFormation containing no timing at all. A
reader looking for the numbers finds nothing, concludes nothing was chosen, and is right. The
same shape as `new ec2.Vpc(this, 'Vpc')` provisioning three NAT Gateways at $96 a month from a
line of code containing no numbers: writing less is what makes the cost invisible.

`deregistrationDelay` behaves the opposite way and arrives at the same place — the CDK emits it
as a target group attribute only when the prop is present, so its absence is equally silent, and
its default is five minutes of waiting on infrastructure this repository destroys daily.

## Decision

Every one of the five is written explicitly, and none is left to the service:

```ts
export const HEALTH_CHECK = {
  path: '/health',
  interval: cdk.Duration.seconds(10),
  timeout: cdk.Duration.seconds(5),
  healthyThresholdCount: 2,
  unhealthyThresholdCount: 2,
} as const;

export const DEREGISTRATION_DELAY = cdk.Duration.seconds(30);
```

Twenty seconds to enter service instead of 150. Twenty seconds serving a dead target instead of
60. Thirty seconds of deregistration instead of 300.

These are overrides rather than restated defaults, so the narrow exception in
[ADR-0009](0009-declare-dns-support-explicitly.md) is not even needed to justify writing them.
It applies anyway to the principle behind them: these values are load-bearing for something
outside the file that sets them — the experiments in layer 5, and the wall-clock cost of every
`cdk destroy`.

`interval` must be greater than or equal to `timeout`, which the CDK validates and fails
synthesis over. Ten and five satisfy it with room to spare.

## Consequences

**Easier.** The numbers are readable in the TypeScript, present in the CloudFormation, and
assertable in the suite. A deployment takes twenty seconds to bring a target into service rather
than two and a half minutes, and a teardown stops waiting five minutes per batch — which is felt
on every single iteration, because that is the loop this repository is designed around.

**Harder.** Five more values to be right about, in a file that could have omitted them and still
deployed.

**What it costs, and this is the honest part.** These are not production numbers.

A ten-second interval with a healthy threshold of 2 will flap under load. A target that is
briefly slow — garbage collection, a cold cache, a burst it is still draining — fails two probes
and is pulled out of service, which moves its share of traffic onto the remaining targets and
makes them slower. The aggressive check becomes the cause of the outage it was watching for.

A thirty-second deregistration delay cuts in-flight requests. A long poll, a large upload, a
report that takes forty seconds to generate: the connection dies mid-flight when the target
deregisters, and the client sees a failure that no log on the server side explains.

Production trades minutes of deployment time for that stability, deliberately. These values are
right for infrastructure that is deployed, measured and destroyed the same day, and they are
wrong for anything that stays up. Same structure as
[ADR-0006](0006-single-nat-gateway-by-default.md): the cheap choice is named as a choice, with
what it gives up written beside it rather than discovered later.

**The guard.** One assertion checks that every timing appears **explicitly** in the template —
not that it holds a particular value, but that it is present at all. That is the unusual one and
the valuable one: every other assertion in the suite reads a value that exists, while this one
catches a value quietly reverting to the service default during a refactor. Deleting the
`healthCheck` block leaves a stack that deploys perfectly, with 150 seconds and 300 seconds
back, and nothing anywhere saying so.

**When this is revisited.** Layer 5. An auto scaling group adding targets under load is exactly
the condition that makes a ten-second interval flap, and if it does, the number changes and this
record is why that was expected rather than surprising.
