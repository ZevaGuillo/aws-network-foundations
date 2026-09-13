# 0014 — One stack per module

**Status:** Accepted
**Date:** 2026-09-13

Supersedes the naming scheme of [ADR-0011](0011-name-stacks-by-module-before-the-first-deploy.md).
The deadline that record establishes is unchanged and still binding.

## Context

Module 1 has five layers: the base network, the security groups, the load balancers, the
compute tiers, and auto scaling. They can be one CloudFormation stack or five. The question had
to be answered before layer 2, because the answer is written into a stack name that cannot be
changed after the first deploy.

The usual argument against splitting is the export lock. When one stack consumes a value from
another, CloudFormation exports it, and an exported value cannot be changed or deleted while
anything imports it — so the producing stack becomes partly frozen by its consumers. **That
argument does not apply to this repository**, and it was worth checking rather than repeating:
`cdk.json` sets `@aws-cdk/core:defaultCrossStackReferences` to `weak`. Synthesizing both modes
side by side shows what changes.

```
strong (the CDK default)   producer   "Export": { "Name": "Net:ExportsOutput..." }
                           consumer   { "Fn::ImportValue": "Net:ExportsOutput..." }

weak (this repository)     producer   a plain Output, no Export
                           consumer   { "Fn::GetStackOutput": { "StackName": "Net", ... } }
```

No export, no lock. So splitting is not blocked by the reason most often given for not
splitting. Three other reasons remain, and together they decide it.

**The dependency cycle.** Security groups reference each other by identity, and the chain runs
in both directions once egress is described: the balancer's group permits traffic out to the
tier, the tier's group permits traffic in from the balancer. Inside one stack this is free —
the CDK emits every security-group rule as a standalone `AWS::EC2::SecurityGroupIngress`
resource rather than inlining it, precisely so the two groups never depend on each other.
Across two stacks there is no such escape, and synthesis fails:

```
'Net' depends on 'Compute' (Net -> Compute/Tier/Resource.GroupId).
Adding this dependency (Compute -> Net/V/Resource.Ref) would create a cyclic reference.
```

**`weak` is not free either.** It removes the lock by removing the protection the lock was:
nothing now stops the network stack being deleted while the compute stack is still using its
VPC. A boundary that CloudFormation no longer polices is a boundary this repository would have
to police by hand.

**Nothing has been deployed.** `Fn::GetStackOutput` has been observed in synthesized output and
nowhere else. Choosing an architecture whose seams depend on a mechanism that has never run
once here would be building on an assumption.

## Decision

One CloudFormation stack per module. Module 1's five layers all deploy into it.

Stacks are named `Net-M<module>` — this one is `Net-M1`. The name stops at the module. ADR-0011
prescribed `Net-M<module>-<layer>` and named this stack `Net-M1-Base`, which was correct only
while the stack held one layer; that suffix is superseded here.

Stack boundaries fall on module boundaries, where they are already forced — module 3 peers
three separate VPCs and cannot share one stack with module 1 regardless of this record.

## Consequences

**Easier.** Layer 2 can be written as plain object references with no export machinery, no
ordering constraints between deployments, and no cycles. The trust chain between security
groups stays one readable unit instead of being split across a stack seam.

**Harder.** Every layer redeploys together: a change to an auto scaling policy submits the VPC
in the same changeset. CloudFormation caps a stack at 500 resources, which module 1 will not
approach — layer 1 alone synthesizes about 30 — but the ceiling exists and is worth knowing
before it is discovered.

**What it costs.** Blast radius. A failed deployment of layer 5 rolls back a stack that
contains the network. That is the real price, and it is accepted because the alternative trades
it for a cycle and for a seam held together by an untested mechanism.

**What it does not decide.** Whether to keep `defaultCrossStackReferences: weak` at all. It is
still the right default for module 3, which spans separate VPCs and will genuinely cross stacks.
That record belongs to module 3.

**What is now wrong but not yet urgent.** The class is still `Module1BaseNetworkStack` in
`lib/module1-base-network-stack.ts`, which will stop being accurate the moment layer 2 adds
security groups to it. Unlike the stack name, that rename is free forever — it is a TypeScript
identifier with no CloudFormation consequence — so it is deliberately deferred to the commit
that makes it false rather than done speculatively here.
