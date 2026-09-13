# 0016 — Ingress-only rules while egress stays open

**Status:** Accepted
**Date:** 2026-09-13

## Context

A security group has two directions. Ingress says who may reach this group; egress says where
this group may reach. The CDK opens egress completely by default — `allowAllOutbound` is `true`
— and narrowing it is the textbook next step in defence in depth.

Taking that step now would break two things, and neither of them produces an error message.

Instances reach AWS Systems Manager over HTTPS. With egress closed and no rule permitting 443
outbound, a Session Manager session simply never establishes; the agent retries quietly and the
console offers no explanation involving a security group. And package installs during user data
hang, which is precisely the failure this repository already documented for `PRIVATE_ISOLATED`
in layer 1: the instance never reports healthy, the auto scaling group loops terminating
newborn instances, and nothing in any log names the cause.

Both are survivable once module 4 exists, because interface endpoints put Systems Manager
inside the VPC and a narrow egress rule can then name them. That module does not exist yet.

### The mechanic that decides the shape of the code

There is a second reason, and it is sharper than the first.

**With `allowAllOutbound` set to `true`, `addEgressRule` is silently discarded.** Not rejected —
discarded. Calling it emits zero egress resources, synthesis succeeds, and the rule sits in the
source file looking effective. It appears in code review as a tightened egress policy. The
template has nothing to find.

The CDK does leave a trace, but not in the template:

```
Ignoring Egress rule since 'allowAllOutbound' is set to true;
To add customized rules, set allowAllOutbound=false on the SecurityGroup
[ack: @aws-cdk/aws-ec2:ipv4IgnoreEgressRule]
```

So a codebase that mixes `allowAllOutbound: true` with egress rules is a codebase where some
security policy is real and some is decorative, with nothing in the deployed artifact to tell
them apart.

## Decision

`allowAllOutbound: true` on all five groups, written out explicitly rather than inherited, and
**every rule in the trust chain expressed as an ingress rule**.

The chain loses nothing by this. All six rules are naturally ingress, including administrative
access: "the Instance Connect Endpoint reaches the frontend on 22" is an ingress rule on the
frontend naming the endpoint's group as its source. There is no direction the layer needs that
ingress cannot express.

Restating the default follows the narrow exception established in
[ADR-0009](0009-declare-dns-support-explicitly.md): a default may be written out when it is
load-bearing for something outside the file that sets it. Systems Manager access and boot-time
package installs qualify.

Narrowing egress is deferred to module 4, where the interface endpoints exist to make a narrow
rule survivable.

## Consequences

**Easier.** Every rule in the layer is real. There is no category of rule that compiles, reviews
well and does nothing.

**Harder.** Egress is wide open: any instance in any tier can reach any address it can route to.
That is a genuine gap, not a technicality, and it is the price of the sequencing above.

**What it costs.** A reader who knows security groups will look for egress rules and find none,
and may read that as an oversight. The comment at the point of use and this record both answer
it directly; the assertion below makes the answer checkable.

**The guard, and why it is unusual.** The trap cannot be caught by inspecting the template,
because the whole problem is that nothing is there to inspect. It is caught through the
annotation instead:

```ts
const warnings = Annotations.fromStack(synth().stack).findWarning('*', Match.anyValue());
expect(warnings).toEqual([]);
```

Verified in both directions — zero warnings as the layer is written, exactly one the moment an
`addEgressRule` call is added. The assertion is deliberately broad: *any* CDK warning fails the
suite. For a repository this size that is a feature, and if an unrelated warning ever becomes
acceptable the matcher narrows to the ack key rather than the test being deleted.

**What it does not cover.** CloudFormation's own template validation travels a separate channel
and never reaches annotations — this was checked, not assumed. Those findings are caught by
`cdk synth`, which fails on them because `cdk.json` sets
`@aws-cdk/core:validateAgainstDefaultRules`. The two guards are complementary and neither
replaces the other. Writing this layer produced one such finding immediately: an em dash in a
`GroupDescription` violates the field's allowed character pattern, which the suite did not
notice and synthesis did.

**When this is revisited.** Module 4, when interface endpoints for Systems Manager exist. At
that point `allowAllOutbound` becomes `false`, egress rules become real, and the assertion above
has to be narrowed rather than deleted — because the warning it watches for would no longer be
the right signal.
