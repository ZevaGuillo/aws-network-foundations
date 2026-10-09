# Implementation Plan — Module 2: Network ACLs + VPC Flow Logs

**Status:** implemented and test-guarded; not yet deployed, and nothing measured
**Scope:** `lib/module2-stack.ts` + `lib/module2-network-acls.ts` + `lib/module2-flow-logs.ts`
and their assertions, the `MODULE_2_*` block in `lib/config.ts`, one new field on
`Module1Stack`, wired into `bin/app.ts`
**Date:** 2026-10-07

Module 1 built a network, put balancers on it, and ran an application behind them. Every control
it added is an **allow**: a security group can say who may come in and cannot say who may not.
This module is the first one that denies, and the first one that produces evidence of its own
decisions rather than inferring them from whether a request succeeded.

The decisions behind this plan are recorded individually in [`docs/adr/`](../adr/README.md).
This document is the work plan: what gets written, in what order, and what is deliberately left
for later. Where a choice needs justifying, it links to its record rather than restating it.

---

## 1. What this module is

A second stack over module 1's public subnets. Two constructs and one number that matters.

```
          the internet
               │
               ▼
   ┌───────────────────────────────┐
   │  public subnets  (×2, AZ a/b) │   ← Net-M2's NACL is associated here
   │   • external ALB nodes        │
   │   • NAT gateway               │
   └───────────────────────────────┘
               │
               ▼
   ┌───────────────────────────────┐
   │  private subnets (×2)         │   ← still on the VPC's default NACL
   │   • frontend / backend tiers  │
   └───────────────────────────────┘

   VPC flow log (ALL, 1 min, CloudWatch Logs)  ──→  net-m2's own log group, 7 days, DESTROY
```

| Construct | Resources | Job |
|---|---|---|
| `NetworkAcls` | 1 `AWS::EC2::NetworkAcl`, 2 `AWS::EC2::SubnetNetworkAclAssociation`, N `AWS::EC2::NetworkAclEntry` | The filter: ordered denies below allows, over the public subnets only |
| `FlowLogs` | 1 `AWS::Logs::LogGroup`, 1 `AWS::EC2::FlowLog` (+ its IAM role) | The instrument: makes the filter's ACCEPT/REJECT decisions readable |

`Net-M2` is a stack of its own, not a construct inside `Module1Stack`
([ADR-0032](../adr/0032-module-2-own-stack.md)). It receives module 1's VPC and resolved public
port as object references from the same `App`, and it cannot synthesize without them.

### Where this stops following the lab

The SAA-C03 lab proves one thing — a NACL can deny by source IP and a security group cannot —
by editing a brand-new VPC's **default** NACL, which already ships `100 allow all` in both
directions. That shortcut hides the two failures worth learning: rule ordering, because an
allow-all is already there at 100 and nothing you add below it is ever dead letter; and
statelessness, because the default's outbound allow-all is never closed.

This module builds the NACL from scratch instead, so both failures are reachable — and one of
them is reachable **on purpose**, through a config toggle rather than a hand edit
([ADR-0036](../adr/0036-scripted-breakage-toggle.md)).

---

## 2. Scope boundary

### In scope

| File | Contents |
|---|---|
| `lib/module2-network-acls.ts` | `NetworkAcls`: the NACL, its associations, banded rule numbering, the `openEphemeralEgress` slot |
| `lib/module2-flow-logs.ts` | `FlowLogs`: an owned log group and `new ec2.FlowLog(…, fromVpc(vpc))` |
| `lib/module2-stack.ts` | `Module2Stack`, its props, and `declareOutputs()` |
| `lib/config.ts` | `MODULE_2_NAME_PREFIX`, `MODULE_2_NACL`, `MODULE_2_FLOW_LOGS`, two literal-union types. No CDK import — [ADR-0005](../adr/0005-framework-free-configuration-module.md) |
| `lib/module1-stack.ts` | One addition: `public readonly publicPort: number`. **Zero template change** |
| `bin/app.ts` | `const m1 = new Module1Stack(…)`, then `new Module2Stack(app, 'Net-M2', { vpc: m1.vpc, publicPort: m1.publicPort, … })` |

### Out of scope

Durable observability. Module 2's flow log is an instrument with a one-week life, and module 5
owns the destination and the query layer over it
([ADR-0035](../adr/0035-the-flow-log-is-disposable-evidence.md)); the ownership split is stated
in [§1 of the layer 1 plan](module1-layer1-base-network.md) so the two halves are written in one
place a reader will actually meet.

Also out: any NACL over the private subnets, IPv6 entries, a second NACL, and every module 1
resource. No module 1 resource is mutated by this change.

### What module 1 already settled, and does not need revisiting

- **The public port is one decision.** [ADR-0018](../adr/0018-the-certificate-is-optional.md)
  made it `publicPort(certificateArn)`; this module is its **third** reader, through
  `m1.publicPort`, never a second call and never a literal `80`. A tcp/80 ingress rule against a
  443 listener synthesizes, deploys, and blackholes every request while naming no resource.
- **Stacks are named by module, not by layer.** `Net-M2`, not `Net-M2-Nacl`
  ([ADR-0011](../adr/0011-name-stacks-by-module-before-the-first-deploy.md),
  [ADR-0014](../adr/0014-one-stack-per-module.md)).
- **Cross-stack references are `weak`** (`cdk.json`). What that costs this module is in §7.

---

## 3. The rule set, written out

Rule numbers come from two disjoint bands, and the action a code path may emit is bound to its
band ([ADR-0033](../adr/0033-rule-number-bands.md)). Allow numbers come from each slot's
position in a declaration array, never from a counter advanced per emitted entry.

**Ingress**

| # | Entry | Traffic | Action |
|---|---|---|---|
| 10…99 | `Deny0`…`DenyN` | all traffic, from each `deniedSources` CIDR | DENY |
| 100 | `AllowPublicPortIn` | tcp `publicPort` — 80, or 443 with a certificate | ALLOW |
| 110 | `AllowIcmpIn` | ICMP `{ type: -1, code: -1 }` | ALLOW |
| 120 | `AllowEphemeralIn` | tcp 1024-65535 | ALLOW |
| `*` | implicit, added by AWS | everything else | DENY |

**Egress**

| # | Entry | Traffic | Action |
|---|---|---|---|
| 100 | `AllowEphemeralOut` | tcp 1024-65535 — **omitted when `openEphemeralEgress: false`** | ALLOW |
| 110 | `AllowHttpsOut` | tcp/443 | ALLOW |
| 120 | `AllowPublicPortOut` | tcp `publicPort` | ALLOW |
| 130 | `AllowIcmpOut` | ICMP `{ type: -1, code: -1 }` | ALLOW |
| `*` | implicit, added by AWS | everything else | DENY |

Three things in those tables are not what the lab's reasoning would predict.

**The ephemeral range serves AWS, not the client.** `AllowEphemeralIn` is not here to let a
browser's reply ports back in. The compute tiers sit in private subnets and never cross this
boundary at all; what arrives on 1024-65535 is the NAT gateway's and the external ALB's own
ephemeral **source** ports. AWS fixes a NAT gateway's source-port range at 1024-65535
regardless of any client's operating system, which is a second, client-independent argument for
the full range — [ADR-0034](../adr/0034-ephemeral-range-rationale.md).

**Disabling a slot must not renumber the ones after it.** `RuleNumber` participates in an
entry's identity in CloudFormation, so changing it is a replacement and old and new coexist
mid-update. A counter advanced only for *enabled* slots would move `AllowHttpsOut` from 110 to
100 the moment `openEphemeralEgress: false` removes the slot above it, colliding with whatever
already holds 100 — breaking the very deploy the toggle exists to demonstrate. Numbering by
declaration index and filtering *after* numbering keeps every surviving rule's number fixed.

**The deny band throws when it fills.** 10-99 step 1 holds 90 denied CIDRs. A 91st would
otherwise be numbered 100 and sit above every ALLOW — a DENY above an ALLOW is dead letter, with
a clean `cdk synth`, a successful deploy, and no symptom beyond a request that should have been
rejected succeeding. `denyIngress()` throws at synth instead, naming the construct and the limit.

### Append, never insert

`deniedSources` is data, and `denyIngress()` numbers by position within that list. The list is
sorted before numbering, so re-running the same set in a different order is a no-op — but
inserting a CIDR at the **front** renumbers every entry after it, which is the replace-on-update
hazard above applied to rules nobody touched.

The convention is therefore append-only, stated at the config value itself. And because `Net-M2`
holds no stateful resource, the complete escape from any renumbering hazard is
`cdk destroy Net-M2 && cdk deploy Net-M2` — a real dividend of ADR-0032's separate stack, not a
workaround.

---

## 4. The default NACL is evidence this stack cannot produce

E0's baseline records the default NACL's rules and its id, and that is **not** an output of
either stack. CDK has no addressable handle on a VPC's default NACL, so `declareOutputs()`
cannot name it (G2-01). It stays one documented CLI step rather than a hunt:

```bash
# The VPC id first — neither stack declares it as an output (see §11)
VPC=$(aws cloudformation describe-stack-resources --stack-name Net-M1 \
        --query "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" \
        --output text)

aws ec2 describe-network-acls \
  --filters Name=vpc-id,Values=$VPC Name=default,Values=true \
  --query 'NetworkAcls[0].{Id:NetworkAclId,Entries:Entries}'
```

**This has to run before `cdk deploy Net-M2`.** Associating a subnet with a NACL is *replacing*,
not layering: the default NACL's allow-all stops applying to module 1's public subnets the moment
the association exists, and removing the association restores it. Run the step afterwards and the
baseline it records is a NACL that no longer governs the subnets being measured.

The private subnets stay on the default NACL throughout, which is also why E0's figures remain a
valid "before" for the public path only.

---

## 5. The flow log is an instrument, not an archive

`ec2.FlowLogDestination.toCloudWatchLogs()` called with no log group does not fail — it creates
one, with `RemovalPolicy.RETAIN` and two-year retention. That log group survives
`cdk destroy Net-M2` and keeps billing storage against a retention period nobody chose, and the
only place it surfaces is a bill (G2-05). `FlowLogs` owns its log group explicitly: `ONE_WEEK`
retention, `RemovalPolicy.DESTROY`, both asserted in the template.

Two further mechanisms, both recorded in
[ADR-0035](../adr/0035-the-flow-log-is-disposable-evidence.md):

- **No casts at the enum boundary.** `logs.RetentionDays` and
  `ec2.FlowLogMaxAggregationInterval` are numeric enums whose members equal the plain numbers, so
  `retentionDays as logs.RetentionDays` compiles and a bad value fails twenty minutes into a
  deploy. The construct converts through exhaustive `Record<union, Enum>` maps instead, which is
  also why the conversion lives here and not in `lib/config.ts` — building the map there would
  require the `aws-cdk-lib` import ADR-0005 forbids.
- **The log format is CDK's default list plus two fields.** `pkt-dstaddr` and `flow-direction`
  are what turn a REJECT into a direction-attributable fact; building the list from scratch
  instead would silently drop whatever field a later CDK release adds to its own default.

What the flow log does **not** record is which control decided. A log line says ACCEPT or REJECT,
not "the NACL did this" — so a NACL deny and a security group with no matching allow are
indistinguishable in the data and are attributed by elimination. The one pattern attributable
from the log alone is E2's, below, because a security group never blocks a reply.

---

## 6. The experiments, and the order they run in

The procedure, the commands and the expected values live in `modulo 2/guion-experimentos.md`;
the measurements land in `modulo 2/evidencia-modulo2.md`. This section carries only what the
infrastructure imposes on them.

| Order | Experiment | Infrastructure state |
|---|---|---|
| 1 | E0 — baseline | Before `cdk deploy Net-M2`. §4's CLI step belongs here |
| 2 | E3 — flow logs recording | `cdk deploy Net-M2` with defaults: zero denies, egress ephemeral open |
| 3 | E1 — deny by source | `deniedSources: ['<my-ip>/32']`, redeploy |
| 4 | E2 — the stateless gotcha | `openEphemeralEgress: false`, redeploy |

E3 lands **before** E1, not at the end, so the flow log is already recording when the first
REJECT happens. A deny measured against a log that started afterwards produces a timeout and no
evidence.

One note deliberately not duplicated here: an ALB does not answer ICMP, so E0's ping row is only
meaningful when `$TARGET` is an instance. That already sits in the E0 row of
`guion-experimentos.md`, where the command is, and it is a runbook caveat rather than anything
this template can assert.

### E2 produces two REJECT patterns, and only one of them is the lesson

`PORTS.frontend = 8080` sits inside 1024-65535, so `openEphemeralEgress: false` does not only
remove the reply path for the experiment's own probe — it removes `AllowEphemeralOut` for the
external ALB's forwarding and health-check traffic toward the frontend tier as well. Both appear
in the flow log while the toggle is `false`, and they are separable:

| Pattern | Flow-log signature | Cadence |
|---|---|---|
| **E2's lesson** — the stateless reply | `flow-direction=egress`, `srcPort=publicPort`, `dstAddr=$ME`, `dstPort=` the measured client ephemeral port | one per probe |
| **Collateral** — health checks | `flow-direction=egress`, `dstPort=8080`, `dstAddr` inside `10.0.0.0/16` | every 10 s, for as long as the toggle is `false` (`HEALTH_CHECK.interval`) |

This collateral is expected, and it is the direct consequence of the range
[ADR-0034](../adr/0034-ephemeral-range-rationale.md) already documents — not a second failure
mode the toggle introduces. A permanent, narrower `AllowTargetsOut tcp/8080` below the ephemeral
slot would have isolated E2 from it, and was rejected: it would survive the toggle and conceal
that a public-subnet ephemeral egress rule legitimately carries in-VPC traffic, which is part of
what E2 teaches. The option stays available if the evidence proves unreadable in practice.

The dropped packet is the **SYN-ACK**, not an HTTP response. The handshake never completes, so
`curl -v` stays at `Trying <ip>:80` and never prints `Connected`. From outside, E2 looks exactly
like E1's drop and the health-check collateral is invisible — only the flow log and target health
show it.

### Measuring the fix too early records it as a failure

Reverting E2 is `openEphemeralEgress: true` and a redeploy. The entry is restored in one
create, but the frontend targets are already **unhealthy** from the collateral above, and the
balancer will not route to them until two consecutive checks pass.

So: wait one health-check cycle — 2 × 10 s, per `HEALTH_CHECK.interval` and
`healthyThresholdCount` — after the redeploy before filling `http_code · time_total tras el
arreglo`. Probing immediately records a `000` that the NACL had nothing to do with, and files it
under the row that is supposed to prove the fix worked.

---

## 7. Teardown, and the order nothing enforces

**`cdk destroy Net-M2` first, then `cdk destroy Net-M1`.**

Nothing in CDK or CloudFormation enforces that. `Net-M2.addDependency(Net-M1)` is already
implicit from the references, and it orders a combined operation — but `cdk destroy Net-M1`
named alone does not consult `Net-M2` at all. The three candidate guards and what each costs are
in [ADR-0032](../adr/0032-module-2-own-stack.md) and design D8; all three were rejected, and the
shortest reason is that the only real CloudFormation-level guard is the `Export`/`Fn::ImportValue`
lock that `@aws-cdk/core:defaultCrossStackReferences: weak` deliberately traded away repo-wide,
and that module 3 still depends on.

So the guard is the checklist, which is why `modulo 2/guion-experimentos.md` and
`evidencia-modulo2.md` naming the stacks correctly is part of the guard rather than tidying — a
checklist with the wrong stack names guards nothing.

What `weak` costs in exchange is three lines in module 1's template. Wiring `Net-M2` to read
`m1.vpc` adds three plain `Output` entries to `Net-M1` — `PublishOutputRefVpc…` and one per
public subnet — each with no `Export` key. So "module 1 is untouched" is true of its
`Resources`, which is byte-for-byte identical with and without `Net-M2` present, and false of its
`Outputs`. The test asserts the invariant that actually holds rather than the one the claim
implied; ADR-0032 carries the correction.

`Net-M2` holds no stateful resource and nothing outside it reads its outputs, so destroying it is
clean: the public subnets return to the default allow-all NACL and the log group goes with the
stack.

---

## 8. The assertions, and what each one catches

| Guard | Assertion | What fails silently without it |
|---|---|---|
| G2-07 | exactly 1 `NetworkAcl`, exactly 2 `SubnetNetworkAclAssociation` | A subnet selected by name instead of type, silently covering nothing after a rename |
| G2-02 | `(direction, ruleNumber)` pairs unique, per direction | Two entries fighting over one number |
| G2-02 (toggle) | `AllowHttpsOut` is `RuleNumber: 110` under both `openEphemeralEgress` values | A counter-based scheme renumbering a surviving rule mid-update |
| G2-03 | every DENY number < the lowest ALLOW number, per direction | A deny that is never evaluated, against a green suite |
| exhaustion | 91 denied CIDRs throw `/deny band exhausted/` | The 91st deny landing at 100, above every allow |
| G2-04 | ingress ALLOW tcp 1024-65535 exists | NAT and ALB return traffic dropped at the subnet edge |
| G2-06 | every entry carrying `Icmp` is exactly `{ Code: -1, Type: -1 }` | ICMP narrowed to one type on one direction only |
| ADR-0018, both modes | ingress port is 80 with no certificate, 443 with one, driven only by module 1's prop | A 443 listener behind an 80 rule — every request blackholed, no resource named |
| G2-05 | `RetentionInDays === MODULE_2_FLOW_LOGS.retentionDays`, `DeletionPolicy: Delete` | A log group outliving the stack at two-year retention |
| flow-log shape | `TrafficType: ALL`, aggregation matches config, `LogFormat` contains `pkt-dstaddr` and `flow-direction` | REJECTs that cannot be attributed to a direction |
| `addFlowLog` scoping | `Net-M2` has exactly 1 `AWS::EC2::FlowLog`; module 1's template has **zero** | `vpc.addFlowLog()` scoping the resource into `Net-M1`, orphaning it on `destroy Net-M2` |
| module 1 untouched | `Net-M1`'s `Resources` deep-equal with and without `Net-M2`; NAT count 1; zero flow logs | This module quietly changing the thing it is measuring |
| inherited habit | `Annotations.fromStack(Net-M2)` has no warnings | — |

The toggle cases run under `test.each([[true], [false]])` against the same construct with one
data value different, which is the whole argument of
[ADR-0036](../adr/0036-scripted-breakage-toggle.md): E2's broken deploy and the healthy deploy
are not two code paths that happen to agree.

One harness fix came out of the no-warnings assertion rather than out of production code. Jest
never loads `cdk.json`, so the test app defaulted to `strong` cross-stack references and raised
a warning `bin/app.ts` never actually produces. `synthModule2()` now builds its `cdk.App` with
the same `weak` context, so the suite tests the mode that ships instead of a stricter one.

---

## 9. Verification — done

`npm test` — 10 suites, 82 tests passed. `npx tsc --noEmit` — clean.
`npx cdk synth --strict` — clean for both `Net-M1` and `Net-M2`.

What `cdk.out/Net-M2.template.json` actually contains: 1 `NetworkAcl`, 2 associations, 1
`FlowLog`, 1 `LogGroup` with `RetentionInDays: 7` and `DeletionPolicy: Delete`, and all 7
outputs. The NACL's `VpcId` renders as `Fn::GetStackOutput`, confirming the `weak` path in the
real CLI synth and not only under jest.

**Not verified, because it cannot be:** every number in `evidencia-modulo2.md`. Nothing in this
module has been deployed. The suite's job is to make the measurements trustworthy, not to
replace them.

---

## 10. The records this module produced

| Record | What it settles |
|---|---|
| [ADR-0032](../adr/0032-module-2-own-stack.md) | Own stack, the VPC-as-prop seam, the `addFlowLog` scoping finding, and what `weak` costs module 1's `Outputs` |
| [ADR-0033](../adr/0033-rule-number-bands.md) | Bands, declaration-slot numbering, and the exhaustion throw |
| [ADR-0034](../adr/0034-ephemeral-range-rationale.md) | Why 1024-65535 is about the NAT gateway and the balancer, not the client |
| [ADR-0035](../adr/0035-the-flow-log-is-disposable-evidence.md) | Disposable evidence vs. module 5's durable observability, and the cast-free enum boundary |
| [ADR-0036](../adr/0036-scripted-breakage-toggle.md) | `openEphemeralEgress` as a test-guarded toggle rather than a hand edit |

---

## 11. Open questions, carried not buried

| Question | Why it is still open |
|---|---|
| Does `cdk destroy Net-M1` ahead of `Net-M2` fail with a VPC `DependencyViolation`, or succeed and orphan module 2? | Empirical, and `weak` removed the export lock that would have policed it. The failure is arguably the better outcome — the alternative is a silently orphaned NACL and flow log. Record the observed behaviour in the evidence table if it happens |
| Neither stack outputs the VPC id | §4's CLI step needs it, and reaches it through `describe-stack-resources`. A `VpcId` output on `Net-M2` would be one line of code, which is outside this plan's doc-only slice |
| `MODULE_2_NAME_PREFIX` is exported and unread | Design D7 intended `networkAclName: 'net-m2-public'` and `flowLogName: 'net-m2-all'`, both of which set the `Name` tag the console and `describe-*` output are unreadable without. Neither landed. The cost is paid during the experiments, reading ids instead of names |
| Retention is 7 days | `FlowLogRetentionDays` makes `1` or `3` a one-character change if a day of measuring argues for shorter |
| Two PR3 review WARNINGs on `declareOutputs()` | The fallback defaults are duplicated between the stack and `NetworkAcls`, and the non-empty branch of the `DeniedSources` ternary is unasserted. Both carried as follow-ups, neither blocking |
| G2-07's "routed through the IGW, not the NAT gateway" has no assertion of its own | The clause holds by construction — `lib/module2-stack.ts:46` selects `subnetType: PUBLIC`, and module 1 only routes that group through the internet gateway. Two tests each prove half of it: `test/module1-base-network.test.ts:82` proves exactly two subnets take their default route through the `GatewayId`, and `test/module2-network-acls.test.ts` proves the two associations target module 1's two public subnets. Nothing joins the halves, so a module 1 change that re-pointed the public route table would leave both tests green and this NACL guarding NAT-routed traffic. `synthModule2()` already hands back the `Module1Stack` alongside module 2's template, so the joined assertion is one `Template.fromStack(module1)` away — what is undecided is which module owns it, since every resource it would read is module 1's |
