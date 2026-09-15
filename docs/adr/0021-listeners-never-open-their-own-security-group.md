# 0021 — Listeners never open their own security group

**Status:** Accepted
**Date:** 2026-09-14

## Context

[ADR-0015](0015-reference-security-groups-by-identity.md) states the trust chain as a single
decision: five groups, six rules, declared once in one block, and exactly one of them accepting
a CIDR because the internet has no security group to name. The argument for putting all six
rules in one place was that a chain assembled from rules added wherever a resource happens to be
created is a residue of creation order rather than a policy.

Layer 3 creates the listeners. `ApplicationLoadBalancer.addListener` has a property called
`open`, it defaults to `true`, and it is not a convenience toggle:

```js
props.open !== false && this.connections.allowDefaultPortFrom(ec2().Peer.anyIpv4(), ...)
```

**The listener writes a firewall rule into the balancer's security group.** Creating a listener
is a routing decision that quietly becomes an access decision.

On the external balancer that produces a second `0.0.0.0/0` rule next to the one layer 2 already
declared — redundant, and a duplicate of a decision that was supposed to live in one file.

On the internal balancer it is worse, and this is the part that matters. `internalAlbSg` exists
to accept the web tier and nothing else. With `open` left at its default it accepts the entire
internet on the listener port instead. Verified against `aws-cdk-lib` 2.269.0 with a probe:

```
open = default   internalAlbSg ingress: [{ CidrIp: "0.0.0.0/0", FromPort: 80, ToPort: 80, ... }]
open = false     internalAlbSg ingress: null
```

The balancer is still internal, so it has no public address and nothing outside the VPC can
reach it today. That is a routing accident protecting a security decision, and it survives
exactly until something with a public path into the VPC exists — which is what modules 3 and 4
are for. Nothing in `lib/module1-security-groups.ts` would change. Nothing would fail. The chain
would simply no longer be what ADR-0015 says it is.

## Decision

Both listeners are created with `open: false`, and the rule is general: **a listener in this
repository never opens its own security group.** Access is stated in the trust chain, by
identity, once, in the block that holds the whole policy.

This is not a rejection of what `open` does. It is a rejection of *where* it does it. A listener
that opens a port is the same policy written in a second place, and two places is how the policy
and the architecture stop matching.

## Consequences

**Easier.** The answer to "what may reach this balancer" is in one file, and it is the file
called `module1-security-groups.ts`. A reader who wants the access policy does not have to know
that listeners can write rules.

**Harder.** `open: false` must be remembered on every listener added from now on, including in
layers 4 and 5 and in every later module. A forgotten one is a rule appearing in a group from a
file that is not about groups. The guard below is what makes forgetting survivable.

**What it costs.** Two lines that look like noise to anyone who does not know what the default
does, which is the reason the comment at the point of use spells out the mechanism rather than
citing this record alone.

**The guard, and where it came from.** Layer 2's premise assertion catches this without being
modified: with `open` at its default, two groups accept an address and `expect(withCidr)
.toHaveLength(1)` fails. Layer 3 adds a local assertion as well, so the failure names the cause
rather than only the symptom.

Mutation-tested. Removing `open: false` from the internal listener alone turns five assertions
red across both suites, including both modes of the layer 2 premise test.

That is the second time a guard written for layer 2 has caught a consequence of layer 3 —
[ADR-0020](0020-empty-target-groups-declare-their-target-type.md) was the first. Both were found
before the layer was deployed, and neither was something the layer 3 plan predicted. The
argument for broad assertions keeps paying.

**What this does not cover.** `allowDefaultPortFrom` is reachable directly through
`balancer.connections`, and nothing prevents a later layer from calling it. The assertion
catches the result rather than the call, which is the right place to catch it: it fails whoever
opens the group, by whatever route.

**When this is revisited.** If a later module has a legitimate reason for a listener to manage
its own access — a public endpoint with no chain to belong to, for instance — the rule bends
there and this record is amended rather than silently broken.
