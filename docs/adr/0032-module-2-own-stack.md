# 0032 — Module 2 gets its own stack, and what that seam costs

**Status:** Accepted
**Date:** 2026-10-07

## Context

Module 2 adds a NACL over module 1's public subnets and a flow log to measure it. Both need
module 1's VPC. The question [ADR-0014](0014-one-stack-per-module.md) already answered for
module 1's five layers — one stack or many — comes back here at the module boundary: does
module 2 live inside `Module1Stack` as another construct, or in a stack of its own?

ADR-0014 decided module boundaries are where stack boundaries fall, because module 3 peers
three separate VPCs and cannot share a stack with module 1 regardless. That precedent extends
here rather than being re-argued: module 2 is a second stack, `Net-M2`, receiving module 1's VPC
as a prop from the same `App`, not a construct instantiated inside `Module1Stack`.
[ADR-0011](0011-name-stacks-by-module-before-the-first-deploy.md) is why the name stops at
`Net-M2` and does not continue into a layer suffix — `Net-M2-Nacl` would be exactly the mistake
ADR-0011 priced once already and ADR-0014 corrected: a name that is accurate only while the
stack holds one layer, and permanent the moment it is deployed.

Two things fell out of building that seam that neither ADR-0014 nor ADR-0011 could have
anticipated, because neither had a second stack to test against yet.

### The `addFlowLog` scoping finding

`node_modules/aws-cdk-lib/aws-ec2/lib/vpc.js` defines `Vpc.addFlowLog` as:

```js
addFlowLog(id, options) { return new FlowLog(this, id, { resourceType: FlowLogResourceType.fromVpc(this), ...options }) }
```

`this` is the VPC construct, and the VPC construct lives in `Net-M1`. Calling
`m1.vpc.addFlowLog(...)` from `Module2Stack` would scope the new `FlowLog` construct — and the
`AWS::EC2::FlowLog` resource with it — to module 1's stack, not module 2's. That inverts the
reference direction this design depends on: instead of `Net-M2` reading module 1's VPC id,
`Net-M1` would be consuming module 2's log group and its IAM role.

Nothing reports this. `cdk synth` succeeds on both stacks. `cdk deploy` succeeds. The flow log
runs, the NACL's ACCEPT/REJECT decisions get recorded, and every number in the evidence table
looks right. The only place it surfaces is `cdk destroy Net-M2`, which leaves the flow log
behind — because it was never module 2's resource to delete — orphaned in a stack whose own
teardown this record never touches.

A code-review convention — "always build the flow log with `new ec2.FlowLog(...)`, never
`vpc.addFlowLog()`" — is the kind of rule that holds until someone reaches for the method with
the shorter name. `lib/module2-flow-logs.ts`'s `FlowLogs` construct uses
`new ec2.FlowLog(this, 'All', { resourceType: ec2.FlowLogResourceType.fromVpc(vpc), ... })`, and
`test/module2-flow-logs.test.ts` asserts exactly one `AWS::EC2::FlowLog` on `Net-M2` and zero on
`Template.fromStack(module1)`. The guard is a test, not a convention someone has to remember at
the one call site that matters.

### What this does to ADR-0018

[ADR-0018](0018-the-certificate-is-optional.md) made the public port a function,
`publicPort(certificateArn)`, because the certificate is optional and the external listener
binds 80 or 443 depending on it. That ADR named two consumers of the one decision: the listener
and the security group. Module 2's NACL is the third.

A NACL ingress rule hardcoded to `tcp/80` against a `443` listener still synthesizes, still
deploys, and blackholes every request: the listener binds, the security group's rule matches
the traffic the NACL already dropped, and the stateless REJECT names neither the listener nor
the security group nor the NACL. That is the same silent-drift failure ADR-0018 described for
two consumers, now with a third place it can reappear.

The fix follows ADR-0018's own mechanism rather than inventing a second one: `Module1Stack`
gains `public readonly publicPort: number`, assigned from the exact same `publicPort()` call
that feeds `SecurityGroups` (`lib/module1-stack.ts`), and `Module2Stack` receives it as a
required prop, read by object reference rather than recomputed. A second, independently-derived
port would let the NACL and the listener disagree, and that disagreement would be silent in
exactly the way ADR-0018 already described — the request fails with no resource named in any
error. Resolving the port once and handing out the reference is what keeps it one decision
with three readers instead of three decisions that happen to agree today.

## Decision

`Net-M2` is a second CloudFormation stack in the same `App` as `Net-M1`, built from module 1's
VPC and resolved public port by reference. It is not a construct inside `Module1Stack`, and its
name does not carry a layer suffix.

```ts
new Module2Stack(app, 'Net-M2', {
  vpc: m1.vpc,
  publicPort: m1.publicPort,
  deniedSources: MODULE_2_NACL.deniedSources,
  openEphemeralEgress: MODULE_2_NACL.openEphemeralEgress,
  env: resolveEnvironment(process.env),
});
```

## Consequences

**Easier.** Module 2 can be deployed and destroyed independently of module 1's five layers,
which is the same dividend ADR-0014 recorded for splitting at module boundaries. The public
port travels as one object reference instead of a second call to `publicPort()` or a second
`certificateArn` prop threaded into a layer that has no business knowing what a certificate is.

**Harder.** Nothing inside `Net-M2` is free of module 1 — it cannot synthesize without `m1.vpc`
and `m1.publicPort` — so the two stacks must always be instantiated in the same `App`, in the
right order, for `Net-M2` to exist at all.

**What it costs — the correction to the plan's own wording.** The module 2 plan states that
`Net-M1`'s template is "identical with and without `Module2Stack` present." **That is false at
the `Outputs` level, and it cannot be made true while any cross-stack reference exists.**

`cdk.json:95` sets `@aws-cdk/core:defaultCrossStackReferences: "weak"` — the setting
[ADR-0014](0014-one-stack-per-module.md) adopted repo-wide. Under `weak`, a cross-stack
reference is published as a plain output on the producer stack and read by the consumer through
`Fn::GetStackOutput`, instead of `strong`'s `Export`/`Fn::ImportValue` pair, which locks the
producer against change for as long as anything imports it. Wiring `Net-M2` to read `m1.vpc`
adds exactly three such outputs to `Net-M1`'s template — `PublishOutputRefVpc8378EB385002A76F`,
`PublishOutputRefVpcPublicSubnet1Subnet5C2D37C4F5EE3F2D`, and
`PublishOutputRefVpcPublicSubnet2Subnet691E08A328131BFA` — each a plain `Output` with no
`Export` key.

The invariant that actually holds, and the one `test/module2-stack.test.ts` asserts: `Net-M1`'s
`Resources` section is byte-for-byte identical whether `Net-M2` is present or not, the NAT
gateway count stays at 1, and `Net-M1` carries zero `AWS::EC2::FlowLog` resources. Asserting
full-template identity — the plan's literal claim — would produce a test that fails against a
correct implementation, for a reason that has nothing to do with module 1's own infrastructure
changing. The three `Outputs` entries are the unavoidable, correct bookkeeping cost of any
cross-stack reference under either mode; they are not a mutation of module 1, and the test is
written to say so precisely rather than to overclaim.

**What this does not decide.** Whether `cdk destroy Net-M1` ahead of `Net-M2` fails with a VPC
`DependencyViolation` or silently orphans module 2 is an empirical question this record does not
answer — `weak` removes the export lock along with the protection it provided, and nothing in
CloudFormation polices the order on module 2's behalf.
