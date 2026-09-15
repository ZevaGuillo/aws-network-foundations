# Implementation Plan — Module 1, Layer 3: Load Balancers

**Status:** implemented
**Scope:** `lib/module1-load-balancers.ts` + its assertions, an amendment to layer 2, wired into
the module 1 stack
**Date:** 2026-09-14

Layer 1 built the roads. Layer 2 decided who is allowed to drive on them. This layer is where
the port numbers stop being names and become listeners that something is actually bound to.

The decisions behind this plan are recorded individually in [`docs/adr/`](../adr/README.md).
This document is the work plan: what gets written, in what order, and what is deliberately left
for later.

---

## 1. What this layer is

Two Application Load Balancers, two listeners, two target groups — and the target groups are
empty, because the instances that fill them arrive in layer 5.

```
      the internet
           │
           ▼
   ┌───────────────┐   public subnets, internet-facing
   │ external ALB  │   listener :80  (or :443 with a certificate)
   └───────┬───────┘
           │ forward
           ▼
    ┌──────────────┐   targetType: INSTANCE, no targets yet
    │ frontend TG  │   :8080, health check GET /health
    └──────────────┘

           ( layer 5 puts the web tier here )

   ┌───────────────┐   private subnets, internal
   │ internal ALB  │   listener :80
   └───────┬───────┘
           │ forward
           ▼
    ┌──────────────┐   targetType: INSTANCE, no targets yet
    │ backend TG   │   :8080, health check GET /health
    └──────────────┘
```

The same discipline layer 2 used applies here: define the structure now, attach later. A target
group with no targets is valid, deploys cleanly, and reports zero healthy targets — which is
the correct state for a tier that does not exist yet, not a failure.

### The port mapping, written out because it inverts

The listener port and the target port are different numbers on both balancers, and the pairs
are easy to swap by accident:

| | listens on | forwards to |
|---|---|---|
| external ALB | `publicPort` — 80, or 443 with a certificate | frontend TG `:8080` (`PORTS.frontend`) |
| internal ALB | `:80` (`PORTS.internal`) | backend TG `:8080` (`PORTS.backend`) |

Each row has to match the layer 2 chain exactly. The listener port must be what the balancer's
security group accepts; the target port must be what the tier's security group accepts from
that balancer. Getting either backwards produces a deploy that succeeds and a request that
times out.

---

## 2. Scope boundary

### In scope

| File | Contents |
|---|---|
| `lib/module1-load-balancers.ts` | Two balancers, two listeners, two target groups, the health check contract, the timing constants |
| `lib/module1-security-groups.ts` | **Amended** — `PORTS.public` splits into `https`/`http`, and the external rule takes its port from the certificate decision |
| `lib/module1-stack.ts` | Gains a `certificateArn` property and instantiates the balancers |
| `test/module1-load-balancers.test.ts` | The assertions in §8 |
| `test/module1-security-groups.test.ts` | **Amended** — the external CIDR rule assertion now runs in both modes |
| `README.md` | Status table, and the cost section, which this layer roughly doubles |

### Out of scope

EC2 instances, launch templates, user data, auto scaling, the application itself, ALB access
logs, WAF, Route 53 records, HTTP-to-HTTPS redirect listeners. Also out of scope: attaching
anything to the target groups. That is layer 5, and the empty target group is the seam between
them.

### What layer 1 already settled, and does not need revisiting

The internet-facing balancer goes in the public subnets, which layer 1 created with
`mapPublicIpOnLaunch: false`. That is not a conflict. The property governs addresses handed to
*instances launched into* the subnet; a load balancer is addressed through its own DNS name and
its nodes get their interfaces regardless. Layer 1's comment says exactly this, and it is being
relied on now rather than re-argued.

---

## 3. The certificate, and why the public port stopped being a constant

`PORTS.public = 443` was written in layer 2 as a statement about the architecture. Making it
true costs more than it looks.

An internet-facing HTTPS listener needs an ACM certificate, and a certificate needs a domain
name you control. Three ways to get one, all of which were priced:

| Approach | What it costs |
|---|---|
| Create the certificate in the stack, DNS validation via a Route 53 hosted zone | A registered domain and a hosted zone become prerequisites. Both cost money, neither can be created by `cdk deploy`, and the README's quick start stops working on a fresh clone |
| Create it in the stack, publish the validation record by hand | The deploy blocks in `CREATE_IN_PROGRESS` until someone publishes a CNAME, or until ACM's validation window expires. Unacceptable for infrastructure that is destroyed daily |
| Take an ARN from outside — context, SSM, an environment variable | `cdk synth` on a clean clone either fails or silently produces a different template. Breaks [ADR-0002](../adr/0002-self-contained-repository.md) |
| Generate a self-signed certificate and import it into ACM | Works technically, and dies on reproducibility: either private key material gets committed, or the deploy depends on a step no one else can run |

**Decision: the certificate is optional, and its absence is the default.**

```ts
export interface Module1StackProps extends cdk.StackProps {
  readonly natGateways?: number;

  /**
   * ACM certificate ARN for the external listener. Absent — the default — means the external
   * balancer listens on plain HTTP. See docs/adr/0018-the-certificate-is-optional.md.
   */
  readonly certificateArn?: string;
}
```

This follows the precedent of `natGateways` exactly: a stack property is justified when the
value changes what a given deployment *is*, and everything else stays in config where it is
reviewed once ([ADR-0006](../adr/0006-single-nat-gateway-by-default.md)).

### The part that reaches back into layer 2

This is the cost of the decision, and it is not confined to the listener.

`externalAlbSg` accepts `0.0.0.0/0` on **443 and nothing else**. An HTTP listener on port 80
behind that group would exist, bind, and receive nothing at all — the security group drops the
packet before the listener ever sees it. No error names either resource. That is precisely the
class of silent failure this repository is built to refuse.

So the public port is one decision with two consumers, and it gets written as one:

```ts
export const PORTS = {
  https: 443,
  http: 80,
  frontend: 8080,
  /** The internal balancer's listener port. Plaintext inside the VPC, for now. */
  internal: 80,
  backend: 8080,
  ssh: 22,
} as const;

/**
 * The port the external balancer listens on, and the one the external security group must
 * accept from the internet. Derived in a single place so the two cannot disagree: they are
 * the same decision seen from two resources, and a repeated ternary is how they drift.
 */
export function publicPort(certificateArn?: string): number {
  return certificateArn === undefined ? PORTS.http : PORTS.https;
}
```

`SecurityGroups` gains a required `publicPort` prop. The chain from
[ADR-0015](../adr/0015-reference-security-groups-by-identity.md) does not branch — it still has
five groups and six rules, and `externalAlbSg` is still the only one accepting a CIDR. Only the
number on the first arrow moves, and the diagram in that ADR is amended to read `publicPort`
rather than `443`.

---

## 4. The health check contract

The load balancer decides whether a target is alive, and it decides it by asking. What it asks
for is a decision this layer must make, because the target group carries it — even though
nothing will answer until layer 4 writes the application.

**The infrastructure names the contract; the application obeys it.** That is the inversion
worth stating: not "the app has a `/health`, point the target group at it", but "the target
group requires `GET /health` returning 200, and layer 4 is not done until something serves it".

### Why not `/`

The default health check path is `/`. A frontend serving HTML returns 200 from `/` whether or
not the backend it depends on is reachable. Every target stays healthy, the balancer keeps
routing, and users get a page that cannot do anything. The health check reports on the web
server, which was never the question.

### Why `/health` is shallow, and the dependency check is not

The instinct is to make the frontend's `/health` call the backend, so that a broken backend
marks the frontend unhealthy. That instinct builds a cascading failure into the architecture,
and the ALB's own behaviour makes it worse rather than better:

1. The backend degrades.
2. Every frontend target fails its health check, because every check calls the backend.
3. The external target group now has **zero** healthy targets.
4. The ALB **fails open**: when no target in a target group is healthy, it routes to all of
   them anyway.

The end state is that traffic flows exactly as it did before, and you have lost the ability to
tell a broken frontend from a broken backend — the one distinction the health check existed to
make. The second cost is load: an interval of 10 seconds across N frontend targets turns every
probe into a backend request, so the dependency check is heaviest precisely when the dependency
is already struggling.

The contract splits:

| Path | Who calls it | What it does |
|---|---|---|
| `/health` | the load balancer | Shallow. The process is up and serving. Nothing downstream is touched |
| `/health/deep` | you, by hand, during the experiment | Calls the backend and reports what it found |

The dependency is still demonstrable, which was the point — and it produces two readings to
compare instead of one aggregate that hides which tier failed. Only `/health` is named in this
layer, because only `/health` is a target group property. `/health/deep` is recorded here as a
requirement on layer 4.

---

## 5. The timings, written out rather than inherited

This is the decision with the most content behind it, because the defaults are invisible in
both directions.

Read the CDK's `TargetGroupBase` constructor: every `healthCheck*` property is derived from the
`healthCheck` prop, and derives to `undefined` when it is absent. **A target group written
without a health check block emits no health check properties at all.** The 150 seconds are not
in the TypeScript and not in the CloudFormation. They are chosen by Elastic Load Balancing and
inherited in silence — the same shape of problem as three NAT Gateways from a line of code
containing no numbers.

| Property | Default | What the default means | This repo |
|---|---|---|---|
| `interval` | 30s | | **10s** |
| `healthyThresholdCount` | 5 (ALB) | **150s** before a new instance receives traffic | **2** → 20s |
| `unhealthyThresholdCount` | 2 | **60s** serving traffic to a dead instance | **2** → 20s |
| `timeout` | 6s (HTTP) | | **5s** |
| `deregistrationDelay` | 300s | **5 minutes** per batch on every deploy and every destroy | **30s** |

Restating a default is normally forbidden here; the narrow exception from
[ADR-0009](../adr/0009-declare-dns-support-explicitly.md) is that a value may be written out
when it is load-bearing for something outside the file that sets it. These are not restated
defaults — they are overrides, and they are load-bearing twice over: they are the numbers the
module's experiments measure, and they are five minutes per destroy on infrastructure that is
destroyed daily.

**The honest caveat goes next to them.** These numbers are right for infrastructure that is
deployed, measured and torn down the same day, and they are not production numbers. A 10-second
interval with a threshold of 2 will flap under load — a target briefly slow gets pulled out of
service, which makes the remaining targets slower. A 30-second deregistration delay cuts
in-flight requests that a long-poll or a large upload would still have been using. Production
trades minutes of deploy time for that stability, deliberately. Same structure as
[ADR-0006](../adr/0006-single-nat-gateway-by-default.md): the cheap choice is named as a choice,
with what it gives up written beside it.

`interval` must be greater than or equal to `timeout` — the CDK validates this and fails synth
otherwise. 10 and 5 satisfy it with room.

---

## 6. `targetType`, and the test it would have broken

Both target groups are created empty. In `aws-cdk-lib` 2.269.0, `validateTargetGroup()` does
this:

```
targetType === undefined && targets.length === 0
  → Annotations.addWarningV2(
      '@aws-cdk/aws-elbv2:targetGroupSpecifyTargetTypeForEmptyTargetGroup',
      "When creating an empty TargetGroup, you should specify a 'targetType' ..." )
```

And `test/module1-security-groups.test.ts` asserts **zero** warning annotations across the whole
stack, deliberately broad. Two empty target groups would be two warnings and a red suite.

Verified in both directions with a probe against the installed version: without `targetType`,
one warning with that exact ack key; with `targetType: TargetType.INSTANCE`, an empty list.

So both target groups declare it explicitly. That is the right annotation on its own merits —
it says the targets will be EC2 instances rather than IP addresses or a Lambda function, before
a single instance exists — and it keeps the layer 2 guard intact. The broad assertion did its
job here: it caught a consequence of this layer at planning time rather than at review time.

---

## 7. Cost, because this layer roughly doubles the module

[ADR-0006](../adr/0006-single-nat-gateway-by-default.md) spends thirty lines justifying one NAT
Gateway at ~$32/month. This layer adds two Application Load Balancers, and they deserve the
same treatment rather than a footnote:

```
  2 × $0.0225/hour  ≈  $33/month, plus LCU charges, just to exist
```

Module 1 idle goes from roughly **$32/month to roughly $65/month**. The internal balancer is
half of that on its own, and it is not removable — a tier reachable only from inside the VPC is
the concept the module exists to demonstrate, and one balancer cannot show it. So the cost is
accepted and stated at the point of use, and the README's cost section is updated in the same
commit rather than later.

The operational conclusion is the one already in the README: deploy, measure, destroy. This
layer makes leaving the stack up materially more expensive than it was.

---

## 8. The assertions, and what each one catches

| # | Assertion | The silent failure it catches |
|---|---|---|
| 1 | Two load balancers: one `internet-facing`, one `internal` | An internal balancer created internet-facing is reachable from outside the VPC and nothing fails |
| 2 | The external balancer is in the public subnets, the internal one in the private subnets | Placement is inferred from the scheme; if that inference ever changes, the topology changes with no diff in this file |
| 3 | The external listener's port equals `publicPort(certificateArn)`, asserted in **both** modes | The §3 coupling. A listener the security group blocks |
| 4 | With a certificate ARN: the listener protocol is HTTPS and the certificate is attached. Without: HTTP, and no certificate property | Half-applied conditionals — a 443 listener with no certificate fails at deploy, a 443 listener the SG blocks does not fail at all |
| 5 | The external security group's CIDR rule port tracks `publicPort` too | Layer 2's assertion 3, extended. The two halves of one decision, asserted together |
| 6 | Both target groups: port 8080, `targetType: instance`, health check path `/health` | `/` returning 200 from a dead stack is the failure this layer exists to prevent |
| 7 | Every health check timing and the deregistration delay appear **explicitly** in the template | The whole §5 argument. If these vanish in a refactor the stack still deploys, with 150s and 300s, and nothing says so |
| 8 | Each listener's default action forwards to the target group in front of the correct tier | A deploy that succeeds and routes the external balancer at the backend |
| 9 | **The stack still synthesizes with zero warning annotations** | Inherited from layer 2, and §6 is why it is not free here |
| 10 | The HTTPS listener pins an `SslPolicy`, and it is **not** `ELBSecurityPolicy-2016-08` | The §5 mechanism again, on the public surface: omitted, ELB applies a 2016 policy that still negotiates TLS 1.0. The second half catches the enum member named `RECOMMENDED`, which *is* that policy |
| 11 | The external balancer drops invalid header fields | Default `false` forwards malformed headers to targets, which is the input to request smuggling |
| 12 | With a certificate, the external balancer has exactly one listener and the complete set of CIDR rule ports is `[443]` | Makes a shut port 80 a decision rather than a consequence. `not.toContain` would pass with 80 open alongside; the set comparison does not |

Assertion 7 is the one that would be tempting to skip, and it is the most valuable in the file.
Every other assertion in this suite reads a value that is present; this one asserts that values
are present *at all*, which is the only way to catch a default silently taking over.

**Every assertion gets mutation-tested before the work is called done**, as with the address
collision, the endpoint service name and the egress trap. An assertion that has never been seen
to fail has not been verified. The mutations to run, at minimum:

| Mutation | Expected |
|---|---|
| Delete the `healthCheck` block from a target group | 6 and 7 fail |
| Delete `deregistrationDelay` | only 7 fails |
| Swap the two listeners' target groups | 8 fails |
| Create the internal balancer with `internetFacing: true` | 1 and 2 fail |
| Pass a `certificateArn` but leave the SG rule on `PORTS.http` | 3 and 5 fail |
| Remove `targetType` from a target group | only 9 fails |

The last row is this layer's equivalent of the egress trap: one detector, and the mutation
confirms which one fires.

---

## 9. Verification — done

`npx tsc --noEmit` and `npx cdk synth` both clean. `npx jest` — **34 passed**, up from 19.
Fourteen assertions are new in `test/module1-load-balancers.test.ts`, and layer 2's premise
assertion now runs twice because the public port is no longer a constant.

Every assertion was mutation-tested, and each mutation was reverted:

| Mutation | Result |
|---|---|
| the `healthCheck` block is deleted | the path and the timings assertions fail |
| `deregistrationDelay` is deleted | **only** the timings assertion fails |
| the listeners forward to each other's target groups | the forwarding assertion fails |
| the internal balancer is created `internetFacing: true` | five fail, across the scheme, the subnets, the forwarding and both listener modes |
| the public port drifts — the listener follows the certificate, the group does not | the HTTPS-mode assertion and **layer 2's premise assertion** both fail |
| `targetType` is removed | three fail: both warning assertions and the target group assertion |
| `open: false` is removed from the internal listener | **five** fail, including both modes of layer 2's premise assertion |
| `sslPolicy` is removed | the TLS assertion fails |
| `sslPolicy` is set to `SslPolicy.RECOMMENDED` | the TLS assertion fails — the trap, caught |
| `dropInvalidHeaderFields` is removed | the header assertion fails |
| a redirect listener is added on port 80 | **five** fail, including the shut-port assertion |

Two rows deserve a note, because the plan predicted them narrower than they turned out.

`targetType` was expected to trip only the warning assertion. It trips the target group
assertion too, which asserts `TargetType` is `instance` rather than absent. Two detectors
instead of one is a better outcome than the plan asked for, and the warning assertion is still
the one that catches it stack-wide.

The last row is the finding this layer did not see coming, and it became
[ADR-0021](../adr/0021-listeners-never-open-their-own-security-group.md).

### The trap this plan missed

`addListener` defaults `open` to `true`, and that default calls
`allowDefaultPortFrom(Peer.anyIpv4())` on the balancer's own security group. The listener writes
a firewall rule.

On the internal balancer that means `CidrIp: 0.0.0.0/0` landing in `internalAlbSg` — the group
whose whole purpose is to accept the web tier and nothing else. Probed against 2.269.0 before
writing a line of the layer: with `open` left alone the group gains an inline `0.0.0.0/0` rule
on the listener port, with `open: false` it gains nothing.

Nothing fails. The balancer is internal, so it has no public path today, and the chain in
`lib/module1-security-groups.ts` reads exactly as it always did. It is a routing accident
covering for a security decision, and it lasts until a module with a path into this VPC exists.

Both listeners are created `open: false`, and layer 2's premise assertion — written for an
entirely different reason, months earlier — is what catches it. That is the second time a layer 2
guard has caught a layer 3 consequence; [ADR-0020](../adr/0020-empty-target-groups-declare-their-target-type.md)
was the first, at planning time rather than implementation time.

---

## 10. The records this layer produces

| ADR | Decision |
|---|---|
| [0017](../adr/0017-write-health-check-timings-out.md) | Health check and deregistration timings are written out, never inherited — and the daily-teardown numbers are not production numbers |
| [0018](../adr/0018-the-certificate-is-optional.md) | The certificate is optional; HTTP is the default, and the public port is one decision shared by the listener and the security group |
| [0019](../adr/0019-shallow-health-check-at-the-balancer.md) | The health check the balancer calls is shallow; the dependency check is a separate path called by hand |
| [0020](../adr/0020-empty-target-groups-declare-their-target-type.md) | Empty target groups declare `targetType` explicitly |
| [0021](../adr/0021-listeners-never-open-their-own-security-group.md) | Listeners never open their own security group - the CDK default writes a 0.0.0.0/0 rule into it |
| [0022](../adr/0022-pin-the-tls-policy.md) | Pin the TLS policy on the public listener, and not to the enum member named `RECOMMENDED` |
| [0023](../adr/0023-no-redirect-listener.md) | Port 80 stays shut when there is a certificate, and the cost to `publicPort()` of the alternative |
| [0024](../adr/0024-drop-invalid-header-fields.md) | Drop invalid header fields at the edge, on the external balancer only |

[ADR-0015](../adr/0015-reference-security-groups-by-identity.md) is amended, not superseded: its
diagram's first arrow becomes `publicPort` instead of `443`. The chain, the five groups and the
six rules are unchanged, and its argument stands untouched.

---

## 11. Open questions, carried not buried

| Question | Why it is not answered here |
|---|---|
| Does the external balancer need an HTTP→HTTPS redirect listener? | **Answered, in [ADR-0023](../adr/0023-no-redirect-listener.md): no.** Layer 2 carried this forward and the review forced it to be decided rather than inherited. With a certificate, port 80 does not exist and `http://` times out. A redirect would need two ports open, turning `publicPort()` from a number into a list and weakening the guarantee that made layer 2 safe — the cost is on the record |
| Is traffic inside the VPC plaintext? | Still yes. `PORTS.internal` is 80. End-to-end TLS needs an internal trust story, and the same certificate problem §3 solved by deferring applies inside the VPC. Revisit with module 2's edge security |
| Should the balancers write access logs? | Access logs are how you prove what actually reached what, which is squarely this repository's subject — and they need an S3 bucket with a policy granting the regional ELB account write access, which is a layer of its own rather than a property. Deferred, deliberately, and now said in the code as well as here, so it is not read as something nobody considered |
| What happens to `/health/deep` if layer 4 never writes it? | Nothing fails. It is a requirement recorded in a plan, and no test can assert an endpoint that no infrastructure references. Layer 4's plan has to carry it forward or it is lost |
| Does the 10-second interval survive layer 5? | Unknown, and measurable. An auto scaling group adding targets under load is exactly the condition that makes an aggressive health check flap. If it does, the number changes and §5's caveat is the record of why it was expected |
