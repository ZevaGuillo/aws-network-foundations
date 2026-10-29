# Implementation Plan — Module 3: VPC Peering across three VPCs

**Status:** planned, nothing deployed. No code exists yet.
**Stack names:** `Net-M3-A`, `Net-M3-B`, `Net-M3-C` — see §4, and the open question in §11.
**Source material:** the AWS lab *Managing Peer Connections between Amazon Virtual Private
Clouds*, read and corrected in [`module3/lab-notes.md`](../../module3/lab-notes.md).

This module is the first one the repository committed to before it existed. The address plan was
fixed on 2026-09-13 precisely so this module would have something it could peer
([ADR-0003](../adr/0003-repo-wide-ipv4-addressing-plan.md)), and
[ADR-0014](../adr/0014-one-stack-per-module.md) deferred its cross-stack record here by name.
Both debts are collected below.

---

## 1. What this module is

Peering connects two VPCs so addresses in one are routable from the other. The claim that comes
attached to it — *"it behaves as if they were in the same VPC"* — is false in five specific ways,
and this module exists to measure the two that cost the most:

1. **Peering is not transitive.** A peered to B and B peered to C does not make A reach C.
2. **A route is one-directional.** The peering is symmetric; the route table entries are not. One
   side routed and the other not is a connection that half-opens and then dies, and from the
   client it is indistinguishable from a closed port.

The other three — no edge-to-edge routing, no cross-region security-group references, private DNS
resolution off by default — are asserted or recorded, not measured. §5 says which is which.

### What the source lab does, and where it stops

The lab builds two VPCs in two regions, peers them, and runs an application across the link. It is
honest about the essential thing: the frontend's call to the backend leaves the frontend's *server*,
not the visitor's browser, so the peering really is what makes the demo work. A great many peering
tutorials fail that test.

It stops at two places this module continues:

| The lab | This module |
|---|---|
| Creates both routes in one step | Creates one, measures the failure, then creates the second (§5 P1) |
| Two VPCs | Three — the third is the entire non-transitivity finding |
| Explains the two routes backwards in its verification step | §3 writes out which route carries which direction |

That last one is worth naming because it is a teaching error, not a typo: the lab says the
backend's route table "receives requests". A route table directs **outbound** traffic only. The
frontend's route carries the request; the backend's route carries the reply. Reverse that and the
asymmetric failure in §5 becomes unexplainable.

---

## 2. Scope boundary

**In.** Three VPCs, two peering connections, the route tables, one probe endpoint per VPC, and the
instrument that makes a one-directional route readable.

**Out, and owned elsewhere:**

- **PrivateLink, and the overlapping-CIDR pair.** Module 4
  ([ADR-0004](../adr/0004-intentional-cidr-overlap.md)). Module 3's VPC A is the range module 4
  deliberately collides with, so this module must not be the one that proves peering impossible —
  it proves peering *limited*.
- **Transit Gateway.** The answer to non-transitivity, and the reason non-transitivity is worth
  measuring rather than asserting. Not in this repository's five modules.
- **Durable log retention.** Module 5. The flow log here is disposable on the same terms
  [ADR-0035](../adr/0035-the-flow-log-is-disposable-evidence.md) already set.
- **Anything in `Net-M1`.** Module 1's VPC is on `10.0.0.0/16` and is not peered to anything. See
  §3 for why that is a deliberate refusal rather than an omission.

---

## 3. The three VPCs, and which route carries which direction

### The ranges are not a choice this module gets to make

| VPC | CIDR | Region | Role |
|---|---|---|---|
| A | `10.1.0.0/16` | `us-east-1` | peered to B. Module 4 will collide with this range on purpose |
| B | `10.2.0.0/16` | `us-east-2` | peered to A **and** to C. The only VPC that reaches both others |
| C | `10.3.0.0/16` | `us-east-2` | peered to B only. Unreachable from A, which is the finding |

All three come from `IPV4_ADDRESS_PLAN.module3` in `lib/config.ts`, fixed since 2026-09-13.

**The source lab's ranges are both unusable here, and one of them dangerously so.** The lab puts
its backend on `10.0.0.0/16` — which in this repository is module 1's base network. ADR-0003 names
that exact range as the trap it was written to prevent: *"the range everyone reaches for ... the
console wizard's suggestion."* Translating the lab literally would collide module 3 with `Net-M1`,
and that collision would be read as the intentional one. It is not. The only intentional overlap in
this repository is module 4 against VPC A, it is argued in its own record, and a second accidental
one would not demonstrate anything — it would make the deliberate one unreadable. The lab's
frontend range, `9.255.0.0/16`, is publicly assigned space chosen only to avoid the first
collision; ADR-0003 allocates every module from `10.0.0.0/8`.

### Why C sits beside B instead of in a third region

Non-transitivity has to be measured without a competing explanation. If C lived in a third region,
a failed probe from A to C would have two candidate causes — peering is not transitive, or
something about the second region — and the experiment could not distinguish them. With C in B's
region, the A→C failure has exactly one available cause, and the module gets both peering flavours
(one cross-region, one same-region) for one extra VPC.

### The routes, written out

Six route table entries would make every pair reachable. This module declares four, and the two it
refuses to declare are the experiment.

| Route table | Destination | Target | Carries |
|---|---|---|---|
| A's subnet | `10.2.0.0/16` | `pcx` A↔B | A's requests toward B |
| B's subnet | `10.1.0.0/16` | `pcx` A↔B | B's replies toward A |
| B's subnet | `10.3.0.0/16` | `pcx` B↔C | B's requests toward C |
| C's subnet | `10.2.0.0/16` | `pcx` B↔C | C's replies toward B |
| *A's subnet* | *`10.3.0.0/16`* | *none — and there is no `pcx` A↔C to point at* | **nothing. This is §5 P2** |

A reaches B. B reaches C. A does not reach C, and no route table entry could fix it: there is no
peering connection between A and C to use as a target. That is the mechanism — not a missing rule,
a missing *attachment* — and it is why Transit Gateway exists.

### Module 1 is not peered to anything, on purpose

`Net-M1` is on `10.0.0.0/16` and does not overlap A, B or C, so peering it would work. It is still
refused. Module 1 is deployed, measured and carries a $93/month idle bill; attaching it to an
experiment that gets destroyed repeatedly makes module 1's teardown order depend on module 3's,
and the repository already has one unenforced ordering constraint it had to document instead of
police (README, Status). One is enough.

---

## 4. The stack shape, and the record ADR-0014 deferred here

[ADR-0014](../adr/0014-one-stack-per-module.md) chose one CloudFormation stack per module. It also
wrote this module's exception into itself, twice:

> *"Stack boundaries fall on module boundaries, where they are already forced — module 3 peers
> three separate VPCs and cannot share one stack with module 1 regardless of this record."*

> *"It is still the right default for module 3, which spans separate VPCs and will genuinely cross
> stacks. That record belongs to module 3."*

So the multi-stack shape here is a debt being collected, not a rule being broken. **This module
owes ADR-0037 for it**, and §10 reserves the number.

### Why a single stack cannot work, and why the obvious split cannot either

A CloudFormation stack is scoped to one region. Three VPCs in two regions is therefore at least two
stacks, before any design argument.

The design argument is about the third. The lab requests the peering **from the backend**, which in
CDK terms means the stack that owns the requester also needs the accepter's VPC id, while the
accepter's stack needs the peering id to write its route. That is a reference cycle across regions,
and it is the same class of failure ADR-0014 already hit between module 1's layers:

```
'Net-M3-A' depends on 'Net-M3-B' (Net-M3-A -> Net-M3-B/Vpc.VpcId).
Adding this dependency (Net-M3-B -> Net-M3-A/Pcx.Ref) would create a cyclic reference.
```

The acyclic shape puts the requester on the side that can afford to know everything, and gives the
accepter's routes their own stack. Three stacks, deployed in order.

### `weak` does not reach across a region, and what replaces it costs something

`cdk.json` sets `@aws-cdk/core:defaultCrossStackReferences: "weak"`, which produces
`Fn::GetStackOutput` instead of an export/import pair. ADR-0014 verified that mechanism in
synthesized output and chose it partly on the strength of having no export lock.

**`Fn::GetStackOutput` is same-region.** A cross-region reference in the CDK is a different
mechanism entirely: `crossRegionReferences: true` on the stack props, which writes the producing
value into an SSM parameter in the producing region and reads it back through a **custom resource
backed by a Lambda function** in the consuming region. That is deployed infrastructure — functions,
roles, log groups — appearing in a networking module that otherwise declares none, and it runs
during every deploy and every destroy.

That cost is real enough that the alternative stays open: pass the peering id in by CDK context and
deploy in two passes, which trades the Lambda for a manual step and a value that is not held by
anything. Both options are written out in §11; neither is chosen here.

---

## 5. The experiments

The order is chosen so that each measurement has exactly one available explanation, which is the
same constraint module 2's E0→E3→E1→E2 order was built to satisfy.

| | Name | What it measures | Kind |
|---|---|---|---|
| **E0** | Baseline | Both probes answer locally; neither answers across an unpeered gap | measured |
| **P1** | The route in two steps | One route: half-open, then dead. Two routes: connected | **measured — the centrepiece** |
| **P2** | Non-transitivity | A→B works, B→C works, A→C does not | measured |
| **E3** | The instrument | The flow log that makes P1 readable rather than inferred | measured |
| **A1** | No cross-region SG reference | A security group in A cannot name a group in B | asserted — synth fails |
| **A2** | Private DNS across peering | Off by default; the hostname does not resolve | measured, cheap |
| **A3** | MTU across the peering | 1500, not the 9001 an intra-VPC path allows | measured, cheap |

### P1 — the route in two steps, and why this is the module

Module 2's finding was that a stateless filter drops the reply to a request it accepted, and that
from the client it looks identical to the request never arriving — `module2-direction-flip.svg`
exists because that sentence needs a picture. **P1 is the same shape one layer down.**

With only A's route declared:

1. A's probe sends a SYN to B's private address. A has a route; it leaves.
2. It arrives. B's security group permits it — the rule is by CIDR, so it is satisfied.
3. B replies SYN-ACK to `10.1.x.x`. **B's route table has no entry for `10.1.0.0/16`.**
4. The reply follows B's default route, or no route at all, and never comes back.
5. A's probe times out.

The client sees a timeout. A closed port, a wrong address, a dropped SG rule and a missing return
route all produce that same timeout, which is exactly why the lab creating both routes in one step
removes the lesson: nothing ever fails, so nothing is ever explained.

**Where the source lab's version dies differently.** The lab's backend has a NAT Gateway, so the
orphaned SYN-ACK leaves through the NAT and dies out on the internet. This module declares no NAT
(§6), so the same packet dies at the route table instead. Same observation from the client,
different mechanism — and the flow log in E3 is what tells them apart.

### E3 — the instrument, reused rather than reinvented

A timeout is not evidence. Module 2 established the flow log as an instrument that makes a drop
readable and is explicitly disposable
([ADR-0035](../adr/0035-the-flow-log-is-disposable-evidence.md)); P1 is the case it was built for.
The log on B's subnet should show the inbound SYN as `ACCEPT` and no corresponding outbound reply —
which is the difference between *"the connection failed"* and *"the request arrived and the answer
had nowhere to go."*

This is the repository growing into itself rather than adding scope: same construct, same retention
argument, same disposability.

### The probe is not an application

The lab installs Node 16 from an external repository and runs a proxy. This module runs no
application, for three reasons: Node 16 is out of support, an external repository is a dependency
[ADR-0002](../adr/0002-self-contained-repository.md) refuses, and **an application needs internet
access to install, which needs a NAT Gateway, which is more than 80% of the lab's cost.**

What peering has to demonstrate is that an address in one VPC is reachable from another. A TCP
connect proves that; an HTTP proxy proves it plus a lot of theatre. The probe is therefore whatever
answers a TCP port using only what the AMI already ships — resolved against a real AL2023 instance
before the runbook is written, not assumed here (§11).

---

## 6. Cost — and the NAT that is absent by design

Module 1 costs about $93/month idle, and the NAT Gateway is the largest line in it
([ADR-0006](../adr/0006-single-nat-gateway-by-default.md)). The source lab's cost is dominated the
same way: roughly two hours of NAT Gateway plus its Elastic IP, against two `t3.micro`.

**Module 3 declares no NAT Gateway, and that is a design position, not an omission.** It follows
from the probe in §5: nothing in this module needs to reach the internet. Instances are reached
through an EC2 Instance Connect Endpoint, which works without internet access because it reaches
the network interface privately — that is what it is for, and module 1 already uses it
([ADR-0030](../adr/0030-instance-connect-endpoint-keeps-the-client-ip-off.md)).

The consequence worth stating: **the lab's most expensive cleanup bug cannot happen here.** The lab
deletes the NAT Gateway and never releases the Elastic IP the wizard allocated, so an unassociated
public address keeps billing by the hour — and deleting the VPC does not touch it, because Elastic
IPs do not belong to a VPC. With no NAT there is no Elastic IP to leak. The §7 sweep still checks,
in both regions, because *nothing* enforces this.

What remains, to be priced on the day of the run rather than trusted here: three `t3.micro`, their
`gp3` root volumes, the inter-region data transfer the probes generate (bytes, not gigabytes), and
the flow log's CloudWatch Logs ingestion. No hourly charge for the Instance Connect Endpoints.

---

## 7. Teardown, in order, and what nothing enforces

Two regions means every sweep runs twice. The order below is the lab's corrected one, with the step
it omits.

1. **Destroy the stacks in reverse dependency order.** The routes go with the stack that declares
   them, in the region that owns them — which is the one real advantage of the three-stack shape
   over the console. In the console, deleting a cross-region peering with *"delete related routes"*
   removes the route in the region you are standing in and fails to remove the other, because a
   regional console cannot edit another region's route table. The remaining entry sits in
   `blackhole` until that VPC is deleted. The lab tells the student to ignore that error. It is not
   noise; it is the mechanism, and in two separate accounts nobody deletes the other side's VPC.
2. **Wait for `deleted`, not `deleting`.** Anything holding a network interface keeps its subnet
   and its security group alive, and a VPC delete inside that window fails on dependencies. A
   security group that refuses to delete is almost never the security group.
3. **Instances to `terminated`,** then the Instance Connect Endpoints, then anything that shared
   their groups.
4. **Sweep, unfiltered, in both regions:** Elastic IPs, NAT Gateways, peering connections, and
   `available` EBS volumes. Every list has to come back empty. Since 2024-02-01 every allocated
   IPv4 address is billed whether it is associated or not.
5. **The flow log's log group** goes with its stack, the same way module 2's did — verified, not
   assumed.

---

## 8. The assertions, and what each one catches

No code exists yet, so this is the contract the first commit has to satisfy, not a description of
tests that pass. Strict TDD: each row is a failing test before it is an implementation.

| Assertion | What it catches |
|---|---|
| Each VPC's CIDR equals its `IPV4_ADDRESS_PLAN.module3` entry | A literal creeping back in at the point of use, which ADR-0003 forbids |
| No module 3 CIDR equals `IPV4_ADDRESS_PLAN.module1.baseNetwork` | The lab's `10.0.0.0/16` being translated literally — the one collision that would be misread as module 4's |
| Exactly two peering connections synthesize, and neither has A and C as its pair | A→C quietly becoming reachable, which deletes P2 while leaving every stack green |
| Exactly four peering routes synthesize, with the destination/target pairs of §3 | A fifth route making the module transitive by accident |
| No `AWS::EC2::NatGateway` and no `AWS::EC2::EIP` in any module 3 stack | §6's cost position silently reverting, and the Elastic IP leak coming back with it |
| Each route's destination is the *other* VPC's range, never its own | The copy-paste error that produces a route to itself and no error message |
| The B↔C pair is same-region and the A↔B pair is not | §3's confound-removal argument being undone by moving a VPC |

The third and fifth rows are the ADR-0004 pattern: a comment asking a reader not to change
something stops nobody, and a failing test stops everybody.

---

## 9. Verification — not started

Nothing is deployed. No measurement in this document has been taken, and the two marked
*asserted* in §5 have not been synthesized. `module3/evidence.md` does not exist yet, by the same
rule module 2 closed on: an empty cell is information, and a cell filled with what should have
happened is indistinguishable from a measurement six months later.

---

## 10. The records this module owes

| # | Title | Why it is owed |
|---|---|---|
| 0037 | Three stacks and the cross-region reference mechanism | Deferred here by name in ADR-0014's *"What it does not decide"*. Blocked on §11's first open question |
| 0038 | No NAT Gateway in module 3 | §6 is a reversal of the default module 1 set in ADR-0006, for a reason specific to this module. ADR-0006 is parameterized, so this is a per-module value, not a contradiction |
| 0039 | The third VPC, and why it sits in B's region | §3. The confound argument is the whole content |

Numbers are reserved, not written. The index in `docs/adr/README.md` stops at 0036.

---

## 11. Open questions, carried not buried

**1. `crossRegionReferences` or a context handoff.** §4 writes out both. The first is one
`cdk deploy` and a Lambda-backed custom resource in a module that declares no compute; the second
is two passes, a value passed by hand, and nothing holding it true. This blocks ADR-0037 and it is
not a question this plan should answer alone.

**2. Does CloudFormation auto-accept a same-account cross-region peering?** Carried as *expected,
not verified*. The `AWS::EC2::VPCPeeringConnection` resource accepts automatically within one
account, and the cross-region case is believed to behave the same way — but believed is not
measured. If it does not, the accepter needs a custom resource calling
`AcceptVpcPeeringConnection`, which changes §4's stack count. **Verify on the first deploy, before
anything depends on it.**

**3. What answers a TCP port on AL2023 with no packages installed.** §5's probe depends on it.
`python3` is expected to be present and `bash`'s `/dev/tcp` needs nothing at all, but neither has
been confirmed against the actual AMI this repository would launch. If both fail, the probe needs a
package, a package needs internet, and §6's no-NAT position has to be re-argued.

**4. Does the flow log on B's subnet actually show the orphaned reply?** E3 assumes an inbound
`ACCEPT` with no matching outbound record. The reply is generated by B's kernel and dropped by
routing, and which side of the flow log's capture point that happens on is not something this plan
can assert. If the reply never appears at all, P1's evidence is an absence — weaker, and the
runbook has to say so instead of quietly reporting a timeout as proof.

**5. `preserveClientIp` on the Instance Connect Endpoints.** Module 1 recorded that the endpoint
does not preserve the client IP ([ADR-0030](../adr/0030-instance-connect-endpoint-keeps-the-client-ip-off.md)).
Module 3 has no reason to differ, but the value should be declared explicitly rather than inherited,
the way every other non-default in this repository is.
