# Implementation Plan — Module 1, Layer 2: Security Groups

**Status:** implemented
**Scope:** `lib/module1-security-groups.ts` + its assertions, wired into the module 1 stack
**Date:** 2026-09-13

Layer 1 built the roads. This layer decides who is allowed to drive on them.

The decisions behind this plan are recorded individually in [`docs/adr/`](../adr/README.md).
This document is the work plan: what gets written, in what order, and what is deliberately left
for later.

---

## 1. What this layer is

Five security groups, each one naming the previous by **identity** rather than by address.

A security group rule can name a CIDR block or another security group. Naming a CIDR means the
rule breaks when an instance moves, and means nothing when two tiers share a subnet. Naming a
group means the rule describes the architecture instead of the addressing, and stays true from
two instances to two hundred.

```
      the internet
           │ 443
           ▼
    externalAlbSg ───────── the only group that accepts a CIDR
           │ 8080
           ▼
      frontendSg ◄──── 22 ──── eiceSg
           │ 80
           ▼
    internalAlbSg
           │ 8080
           ▼
       backendSg ◄──── 22 ──── eiceSg
```

### The part that is not obvious

`backendSg` accepts `internalAlbSg`, **not** `frontendSg`. The instinct is to let the backend
trust the frontend, and it is wrong twice over.

The frontend never opens a connection to the backend. It opens one to the internal load
balancer, which opens its own connection to the backend. The packet arriving at a backend
instance comes from a load balancer node, so a rule naming `frontendSg` would match nothing.

The same is true of health checks, and that is where the mistake gets expensive. A load
balancer polls every target every few seconds to decide whether it is alive, and those probes
originate from the balancer's own network interfaces, carrying the balancer's security group.
A backend that trusted only the frontend would fail every probe, every target would be marked
unhealthy, and the balancer would have nothing to route to — with no error message anywhere
naming a security group.

Each tier trusts **its balancer**. That is the shape of the chain, and the reason for it.

---

## 2. Scope boundary

### In scope

| File | Contents |
|---|---|
| `lib/module1-security-groups.ts` | The five groups, the six rules, and the port constants they use |
| `lib/module1-stack.ts` | Renamed from `module1-base-network-stack.ts`; instantiates the groups and exposes them |
| `test/module1-security-groups.test.ts` | The assertions below |
| `test/support/synth.ts` | Shared synthesis helper, extracted so both test files use one |

### Out of scope

Load balancers, listeners, target groups, TLS certificates, EC2 instances, launch templates,
auto scaling, the EC2 Instance Connect Endpoint resource itself. This layer creates the groups
those resources will attach to; it does not create them. Attaching an empty security group to
nothing is valid and deploys cleanly.

### Two renames that land with this layer

| Item | Why now |
|---|---|
| `Module1BaseNetworkStack` → `Module1Stack` | [ADR-0014](../adr/0014-one-stack-per-module.md) put every layer in one stack. The class stops being accurate the moment this layer adds security groups to it — so it renames in the commit that makes it false, as the layer 1 plan recorded. A TypeScript identifier has no CloudFormation consequence; this is free. |
| `synth()` helper → `test/support/synth.ts` | The new warning assertion needs the `Stack`, not just the `Template`. Rather than two copies drifting, one helper returns both. |

---

## 3. The trust chain in code

### Shape

Two phases in one constructor, and the order matters for reading rather than for correctness:

```ts
// phase 1 — five empty groups
this.externalAlb = new ec2.SecurityGroup(this, 'ExternalAlb', { vpc, ... });
// ... four more

// phase 2 — the chain, as one readable block
this.frontend.addIngressRule(this.externalAlb, ec2.Port.tcp(PORTS.frontend), '...');
// ... five more
```

**This is not a workaround for a dependency cycle**, which is what the shape looks like. There
is no cycle to avoid: `SecurityGroupProps` has no ingress or egress properties at all, so rules
can only be added after construction, and the CDK emits every group-to-group rule as a
standalone `AWS::EC2::SecurityGroupIngress` resource rather than inlining it — precisely so the
two groups never depend on each other. Two mutually-referencing groups in one stack synthesize
cleanly; this was verified rather than assumed.

The reason to keep the six rules in one block is that **the chain is a single decision**. Spread
across the file next to the group each one touches, it becomes six local facts and stops being
readable as a policy.

### Ports

Module-level constants in this file, exported so the tests do not retype them:

```ts
export const PORTS = {
  public: 443,   // TLS terminates at the external balancer
  frontend: 8080,
  internal: 80,  // inside the VPC, plaintext — see the open question below
  backend: 8080,
  ssh: 22,
} as const;
```

**Not in `lib/config.ts`**, and the boundary is worth stating because it is close. That module
holds what *outlives a single stack* — the address plan survives rewrites of every construct in
this repository ([ADR-0005](../adr/0005-framework-free-configuration-module.md)). A port number
does not: it is a fact about this module's application, and layer 3 may well change it when the
listeners become real. Values with different lifetimes should not share a home.

`PORTS.internal` is the one a later layer can invalidate. If layer 3 decides on TLS between the
frontend and the internal balancer, this becomes 443 and nothing else changes — which is the
entire reason it is a named constant and not an `80` typed into a rule.

### `allowAllOutbound` stays `true`, and is written out

Every group is created with `allowAllOutbound: true` explicitly, even though that is the
default. The precedent for restating a default is
[ADR-0009](../adr/0009-declare-dns-support-explicitly.md), and this qualifies under the same
narrow rule: the value is load-bearing for something outside the file that sets it.

Setting it to `false` breaks two things silently. Instances reach Systems Manager over HTTPS, so
a session simply never establishes — no error names the security group. And package installs
during user data hang, which is the failure mode layer 1 already documented for
`PRIVATE_ISOLATED`.

Hardening egress is a real goal, and it waits for module 4, where the interface endpoints exist
to make a narrow rule survivable. That sequencing is the decision; the comment says so at the
point of use.

### Every rule is an ingress rule

There are no egress rules in this layer, and that is not an accident of the design — it is
forced by the previous decision, and the way the CDK enforces it is the sharpest trap in this
layer.

**With `allowAllOutbound: true`, `addEgressRule` is silently discarded.** Verified: a call to
`alb.addEgressRule(tier, ec2.Port.tcp(8080))` emits zero egress resources. The CDK attaches a
warning annotation and synthesis succeeds. The rule is in the source, visible in review,
absent from the template.

All six rules in the chain express as ingress, including SSH — "the endpoint reaches the
frontend on 22" is an ingress rule on `frontendSg` naming `eiceSg` as its source. So the trap is
avoidable entirely, and §5 adds an assertion that keeps it avoided.

---

## 4. What changes outside this file

`Module1Stack` gains one field, following the precedent of `public readonly vpc`:

```ts
/** Consumed by layers 3 through 5, which attach balancers and instances to these groups. */
public readonly securityGroups: SecurityGroups;
```

No stack properties are added. The NAT Gateway count is a property because it changes the bill
per deployment ([ADR-0006](../adr/0006-single-nat-gateway-by-default.md)); nothing in this layer
does.

---

## 5. The assertions, and what each one catches

Six assertions. Each one guards something that fails without producing an error.

| # | Assertion | The silent failure it catches |
|---|---|---|
| 1 | Five groups exist | — the baseline the rest read against |
| 2 | Exactly six ingress rules | A rule dropped in a refactor leaves a tier unreachable, and the symptom appears at deploy time as a health check that never passes |
| 3 | Only `externalAlbSg` accepts a CIDR, and only `0.0.0.0/0` on 443 | The whole premise. A second group accepting a CIDR is the chain quietly becoming address-based, and nothing fails |
| 4 | Every other rule's source is a `GroupId`, wired in the order above | A rule pointed at the wrong group still deploys; it just permits the wrong traffic |
| 5 | Every group carries the allow-all default egress | Records [ADR-0016](../adr/0016-ingress-only-while-egress-stays-open.md) in the template, so tightening it is a visible diff rather than a silent one |
| 6 | **The stack synthesizes with zero warning annotations** | The egress trap, and the only way to catch it |

Assertion 6 deserves its own paragraph, because it is the one that would not be obvious.

The dropped egress rule cannot be detected by looking at the template — the whole problem is
that nothing is there to find. What the CDK does leave behind is an annotation:

```
Ignoring Egress rule since 'allowAllOutbound' is set to true;
To add customized rules, set allowAllOutbound=false on the SecurityGroup
[ack: @aws-cdk/aws-ec2:ipv4IgnoreEgressRule]
```

`Annotations.fromStack(stack).findWarning('*', Match.anyValue())` returns it. Verified both
directions: zero warnings as the layer is designed, exactly one the moment an `addEgressRule`
call is added. So the assertion is `expect(warnings).toHaveLength(0)`.

It is deliberately broad — *any* CDK warning fails the suite, not only this one. For a
repository this size that is a feature. If an unrelated warning ever appears and is genuinely
acceptable, narrow the matcher to the `ipv4IgnoreEgressRule` ack key rather than deleting the
assertion.

**Every assertion gets mutation-tested before the work is called done**, as with the address
collision and the endpoint service name. An assertion that has never been seen to fail has not
been verified.

---

## 6. Verification — done

`npx tsc --noEmit` and `npx cdk synth` both clean. `npx jest` — 19 passed, six of them new.

Every new assertion was mutation-tested, and each mutation was reverted:

| Mutation | Result |
|---|---|
| `backend` trusts `frontend` instead of `internalAlb` | the wiring assertion fails |
| the SSH rule into `frontend` is deleted | the rule-count and wiring assertions fail |
| `internalAlb` accepts `Peer.anyIpv4()` | the CIDR, rule-count and wiring assertions all fail |
| an `addEgressRule` call is added | **only** the warning assertion fails — the trap, caught |

The last row is the one that mattered. It is also the narrowest: the egress trap has exactly
one detector, and the mutation confirms that detector is the one that fires.

### What the guard did not catch

Writing this layer produced a real defect that the suite stayed green through. Em dashes in the
five `GroupDescription` strings violate the field's allowed character pattern, and
CloudFormation's template validation reported it at synth time as
`GroupDescription ... does not match pattern (CloudFormation Validate)`.

Because `cdk.json` sets `@aws-cdk/core:validateAgainstDefaultRules`, that is an error rather
than a warning in the real app, and `cdk synth` would have failed. Descriptions now use colons.

Worth recording because it was checked rather than assumed: these findings travel a separate
channel and **never reach `Annotations.fromStack`**, so assertion 6 was blind to them. The two
guards are complementary — the suite watches annotations, synthesis watches the schema — and
neither substitutes for running both.

---

## 7. The records this layer produced

| ADR | Decision |
|---|---|
| [0015](../adr/0015-reference-security-groups-by-identity.md) | Security groups reference each other by identity, never by CIDR — and each tier trusts its balancer, not the tier before it |
| [0016](../adr/0016-ingress-only-while-egress-stays-open.md) | Ingress-only rules while `allowAllOutbound` stays true; egress hardening deferred to module 4 |

---

## 8. Open questions, carried not buried

| Question | Why it is not answered here |
|---|---|
| Does the external balancer need port 80? | Only if layer 3 adds an HTTP→HTTPS redirect listener. That is a listener decision, and adding 80 to a group with no listener behind it opens a port for nothing. Revisit in layer 3 |
| Is traffic inside the VPC plaintext? | `PORTS.internal` is 80 today. End-to-end TLS needs certificates and an internal trust story, which belongs with the listeners in layer 3 or with module 2's edge security |
| Does the EC2 Instance Connect Endpoint preserve the client IP? | `PreserveClientIp` defaults to `false` in CloudFormation, so targets see the endpoint's own interface and a rule naming `eiceSg` is correct. **If a later layer sets it to `true`, rules 3 and 6 stop matching.** Flagged here so the connection is not lost |
