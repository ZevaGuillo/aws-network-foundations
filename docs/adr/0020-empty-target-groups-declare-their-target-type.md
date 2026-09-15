# 0020 — Empty target groups declare their target type

**Status:** Accepted
**Date:** 2026-09-14

## Context

Layer 3 creates two target groups with no targets in them. That is the same discipline layer 2
used for the trust chain: define the structure once, attach later. The instances arrive in layer
5, and a target group with nothing registered is valid, deploys cleanly, and reports zero
healthy targets — the correct state for a tier that does not exist yet.

The CDK has an opinion about it. In `aws-cdk-lib` 2.269.0, `TargetGroupBase.validateTargetGroup()`
reads:

```
targetType === undefined && targets.length === 0
  → Annotations.addWarningV2(
      '@aws-cdk/aws-elbv2:targetGroupSpecifyTargetTypeForEmptyTargetGroup',
      "When creating an empty TargetGroup, you should specify a 'targetType'
       (this warning may become an error in the future)." )
```

Normally `targetType` is inferred from the first target registered. With no targets there is
nothing to infer from, so CloudFormation falls back to `instance` — which happens to be what
this module wants, arrived at by accident.

### Why this is not merely a tidiness question

[ADR-0016](0016-ingress-only-while-egress-stays-open.md) put a deliberately broad assertion in
the suite: **any** CDK warning annotation, anywhere in the stack, fails the tests.

```ts
const warnings = Annotations.fromStack(synth().stack).findWarning('*', Match.anyValue());
expect(warnings).toEqual([]);
```

It exists to catch the silently-discarded egress rule, which cannot be detected by inspecting a
template because the whole problem is that nothing is there to inspect. Its breadth was called a
feature at the time, with a note that if an unrelated warning ever appeared and was genuinely
acceptable, the matcher should narrow to the ack key rather than the assertion being deleted.

Two empty target groups are two warnings. The broad assertion fires, on a layer written months
after the assertion was, for a reason that has nothing to do with egress.

This was verified rather than predicted. A probe against the installed version produced exactly
one warning carrying that ack key with `targetType` omitted, and an empty list with
`targetType: TargetType.INSTANCE` supplied.

## Decision

Both target groups declare `targetType: elbv2.TargetType.INSTANCE` explicitly.

The broad assertion in ADR-0016 is **not** narrowed, and the warning is not acknowledged away.
It is fixed.

That is the right call twice over. The annotation is correct on its own merits — it says the
targets will be EC2 instances rather than IP addresses or a Lambda function, stated before a
single instance exists, which is the same thing layer 2 did when it wrote a trust chain for
resources that did not exist yet. And a value CloudFormation currently defaults to is a value
that can change: the CDK's own warning says the condition may become an error in a future
version, and relying on the fallback makes an upgrade a breaking change with no diff in this
repository to explain it.

## Consequences

**Easier.** The target groups say what they hold. An upgrade of `aws-cdk-lib` that promotes the
warning to an error passes through this repository without incident.

**Harder.** Nothing meaningful. One property on two constructs.

**What it costs.** The `INSTANCE` choice is now committed in layer 3 rather than inferred in
layer 5. If a later layer wanted IP targets — which is what a container-based tier would need —
the change is a visible edit here rather than an emergent property of what got registered. That
is a feature in a repository built on recording decisions, and it is still a constraint that
layer 5 inherits without being consulted.

**The guard.** The ADR-0016 warning assertion, unchanged and still broad, is what catches this.
Removing `targetType` from either target group turns exactly one assertion red — the warning
one — and nothing else. That is this layer's equivalent of the egress trap: a single detector,
with a mutation confirming which detector fires.

**What this says about the broad assertion.** It worked. A guard written for one specific trap
in layer 2 caught an unrelated consequence of layer 3 at planning time, before a line of the
layer was written. The temptation when a broad assertion fires for an unexpected reason is to
narrow it; the value it just delivered is the argument for leaving it alone.
