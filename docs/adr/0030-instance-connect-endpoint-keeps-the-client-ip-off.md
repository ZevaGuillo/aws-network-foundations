# 0030 — The Instance Connect Endpoint keeps the client IP off

**Status:** Accepted
**Date:** 2026-09-14

## Context

Layer 2 wrote two SSH rules naming `eiceSg` as their source — one into the frontend, one into the
backend — before the endpoint that wears that group existed. It also carried a warning forward,
in its own plan's open questions:

> `PreserveClientIp` defaults to `false` in CloudFormation, so targets see the endpoint's own
> interface and a rule naming `eiceSg` is correct. **If a later layer sets it to `true`, rules 3
> and 6 stop matching.**

This is that later layer, and the warning is the reason this record exists rather than a comment.

With `PreserveClientIp` set to `true`, packets arrive at the instance carrying the *client's*
address rather than the endpoint's network interface. A security group rule naming `eiceSg` then
matches nothing, because the traffic no longer comes from anything wearing that group. Both SSH
rules become decorative, administrative access closes, and the error is a connection timeout that
names no security group, no rule and no endpoint.

It closes the only administrative path into these instances. They are in private subnets with no
public address by [ADR-0012](0012-never-auto-assign-public-ipv4-addresses.md), so there is no
second way in to debug why the first way stopped working.

### A CDK gap worth recording

There is **no L2 construct**. Confirmed against `aws-cdk-lib` 2.269.0: `aws-ec2/lib/` contains
`client-vpn-endpoint` and friends and nothing for instance connect. The only available shape is
`ec2.CfnInstanceConnectEndpoint`, the generated L1.

That matters for more than ergonomics. An L1 resource has no `Connections` object, so it cannot
participate in the CDK's security group plumbing the way layer 2's constructs do — the group is
attached by passing `securityGroupIds` explicitly, and nothing in the type system connects it to
the two rules that depend on it. The link between this endpoint and those rules exists only in
this record and in the assertions.

## Decision

`preserveClientIp: false`, written out explicitly on the L1 resource, even though it is already
the CloudFormation default.

This is the narrow exception from [ADR-0009](0009-declare-dns-support-explicitly.md), and it is
the clearest case of it in the repository: a default may be restated when it is load-bearing for
something outside the file that sets it. Two ingress rules in
`lib/module1-security-groups.ts` depend on this value being `false`, and nothing in either file
says so unless it is written.

The endpoint wears `securityGroups.eice` — the group layer 2 created to be a *source* and never a
destination. It accepts nothing itself, which is why it has no ingress rules of its own and why
layer 2's assertion checks that nothing ever lands on it.

## Consequences

**Easier.** Administrative access is a named identity rather than a bastion host with a public
address and a key to manage. The two SSH rules read as architecture — "the endpoint may reach the
tiers" — and stay true regardless of who is connecting or from where.

**Harder.** Nothing operationally. The cost is conceptual: an explicit `false` looks like noise
to anyone who does not know what depends on it, which is why the comment at the point of use
names the two rules rather than citing this record alone.

**What it costs.** Instances see the endpoint's address in their SSH logs, not the operator's. So
`last` and `/var/log/secure` cannot tell you who connected — every session looks the same. For an
environment with one operator that is nothing; in an audited environment it is the reason
`PreserveClientIp` exists, and the answer there is CloudTrail's record of
`OpenTunnel` calls rather than flipping this value and silently breaking the rules.

That trade is the whole content of this record: the attribution you would gain is available
elsewhere, and the connectivity you would lose has no second source.

**Using an L1 is a consequence, not a choice.** No L2 exists. When one appears, moving to it is a
resource replacement rather than a refactor, because the logical id changes — worth knowing
before someone does it casually on a deployed stack.

**The guard.** One assertion: the endpoint sets `PreserveClientIp: false` and its security group
list is exactly `eiceSg`. Mutation-tested by flipping it to `true`, which must turn the suite red
— and which would otherwise deploy perfectly, close the only door in, and explain nothing.

**When this is revisited.** If an L2 construct ships, or if this repository ever needs per-operator
attribution at the instance rather than in CloudTrail. Both change the shape; neither changes the
dependency on layer 2's two rules, which is the thing to check first.
