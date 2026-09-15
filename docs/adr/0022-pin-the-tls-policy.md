# 0022 — Pin the TLS policy on the public listener

**Status:** Accepted
**Date:** 2026-09-14

## Context

[ADR-0017](0017-write-health-check-timings-out.md) recorded a mechanism: the CDK derives a
property from a prop and emits **nothing** when the prop is absent, so a service default takes
over without appearing in the TypeScript or in the CloudFormation. It was written about health
check timings. It is not specific to them.

`ApplicationListenerProps.sslPolicy` behaves identically. Its documented default is "the current
predefined security policy", and verified against `aws-cdk-lib` 2.269.0 by synthesizing this
repository's own stack with a certificate:

```
LoadBalancersExternalListene | Port 443 | SslPolicy: (ABSENT)
```

The property is not in the template. ELB therefore applies `ELBSecurityPolicy-2016-08`, which
still negotiates **TLS 1.0 and TLS 1.1** — protocols deprecated by the IETF in 2021 and
disallowed by PCI DSS since 2018.

This is the same invisible default as the 150 seconds, on the only surface in this architecture
that faces the internet. A repository whose thesis is that unexamined defaults cost something
left the most consequential one unexamined.

### The trap inside the fix

The enum has a member called `RECOMMENDED`. It is the wrong one:

```js
SslPolicy.RECOMMENDED     = "ELBSecurityPolicy-2016-08"          // the default, TLS 1.0 and up
SslPolicy.RECOMMENDED_TLS = "ELBSecurityPolicy-TLS13-1-2-2021-06" // TLS 1.2 and 1.3 only
```

Reaching for the obvious name returns exactly the default you were trying to escape, and the
diff reads like a fix. `RECOMMENDED` was accurate when it was named and AWS did not rename it,
because the string is a customer-visible policy identifier. The CDK could not fix this without
breaking every stack that used it.

## Decision

The external listener pins `SslPolicy.RECOMMENDED_TLS` — `ELBSecurityPolicy-TLS13-1-2-2021-06`.
TLS 1.2 and TLS 1.3, nothing older.

It is set alongside the protocol and the certificate as a single value rather than as a third
independent ternary, because the three cannot be chosen separately: the CDK rejects an HTTPS
listener with no certificate and an HTTP listener carrying one, and a TLS policy on a plaintext
listener is meaningless.

Not TLS 1.3 only (`TLS13_13`). That would be the strictest choice and it drops clients that
cannot negotiate 1.3, which is a real population and not an interesting thing for this module to
demonstrate. 1.2 as the floor removes the deprecated protocols without making the balancer a
test of the client's age.

## Consequences

**Easier.** The policy is in the source and in the template, so it can be read, reviewed and
asserted. When AWS publishes a newer policy the change is a one-line diff against a value that
is visible, rather than a discovery that the balancer has been on a 2016 policy for two years.

**Harder.** The value has to be revisited. A pinned policy does not follow AWS forward, which is
the exact trade `ELBSecurityPolicy-2016-08` being a *frozen* policy already made — it has not
moved since 2016 either. Pinning makes the staleness visible instead of ambient.

**What it costs.** A client that can only do TLS 1.0 or 1.1 can no longer connect. That is the
intent, and on a demonstration deployed for an afternoon it costs nothing at all.

**The guard.** Two assertions in one test. That `SslPolicy` is present — the ADR-0017 shape,
catching a silent revert to the service default. And that it is **not**
`ELBSecurityPolicy-2016-08`, which catches the `RECOMMENDED` trap specifically: someone
"tightening" the listener by reaching for the well-named member turns the suite red instead of
shipping the default under a reassuring name.

The second assertion is the unusual one and the reason this record exists. Asserting the exact
value alone would have caught it too, but it would not have said why, and the next person to
edit that line would walk into the same enum.

**When this is revisited.** When AWS publishes a policy worth moving to, or when a later module
needs FIPS or post-quantum ciphers — both of which are members of this same enum, and both of
which are decisions rather than upgrades.
