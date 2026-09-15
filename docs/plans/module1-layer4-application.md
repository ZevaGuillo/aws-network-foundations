# Implementation Plan — Module 1, Layer 4: The Application

**Status:** planned
**Scope:** `lib/module1-compute.ts` + `lib/app/` + its assertions, wired into the module 1 stack
**Date:** 2026-09-14

Layer 1 built the roads. Layer 2 decided who may drive on them. Layer 3 put balancers on them and
declared a contract. This layer is the first one that writes something other than infrastructure,
and it exists to answer a question layer 3 left open: **what actually responds.**

The decisions behind this plan are recorded individually in [`docs/adr/`](../adr/README.md).
This document is the work plan: what gets written, in what order, and what is deliberately left
for later.

---

## 1. What this layer is

Two compute tiers running the smallest application that can demonstrate the chain, plus the
administrative access path layer 2 already wrote rules for.

```
   external ALB ──→ frontend TG ──→ frontend instance   :8080   Python or Node
                                          │
                                          │  /health/deep only
                                          ▼
   internal ALB ──→ backend TG  ──→ backend instance    :8080   Python or Node

   EC2 Instance Connect Endpoint ──22──→ both tiers
```

And one thing that is not a resource: **a number.** The runtime is a deployment property, the
same deployment happens twice, and the difference in boot time is the output of this layer.

### The boundary that moves

Layer 3's plan said the target groups stay empty "until layer 5". That changes here, and the
reason is the experiment.

| Layer | Owns |
|---|---|
| 4 — this one | Launch templates, the instance role, the Instance Connect Endpoint, the application, and **one fixed instance per tier registered in the target groups** |
| 5 | Auto scaling: the groups, the policies, instance refresh, and the thrashing experiment |

A launch template that nothing launches from has no boot time. Measuring the thing this layer
exists to measure requires something running, and a fixed instance per tier is the smallest thing
that makes the whole chain live: a request reaching the external balancer, a page coming back, and
`/health/deep` proving the frontend can reach the backend through the internal balancer.

Layer 5 replaces the fixed instances with auto scaling groups built from the *same* launch
templates. That is churn, and it is the cheap kind — the launch template is the unit of boot
behaviour and it does not change.

---

## 2. Scope boundary

### In scope

| File | Contents |
|---|---|
| `lib/module1-compute.ts` | Launch templates, instance role, Instance Connect Endpoint, one instance per tier, the user data builder |
| `lib/app/server.py` | The application, Python |
| `lib/app/server.js` | The application, Node |
| `lib/module1-stack.ts` | Gains a `runtime` property and instantiates the tiers |
| `test/module1-compute.test.ts` | The assertions in §9 |
| `README.md` | Status, cost, the measurement table once it has numbers |

### Out of scope

Auto scaling groups, scaling policies, instance refresh, `estimatedInstanceWarmup`, load
generation, and the thrashing experiment. All layer 5. Also out of scope: a database, session
state, TLS inside the VPC, and anything that would make the application interesting in its own
right — it exists to be reached, not to be useful.

### The application lives in real files

`lib/app/server.py` and `lib/app/server.js` are actual source files read at synth time with
`fs.readFileSync`, not TypeScript template literals.

A template literal cannot be linted, cannot be syntax-highlighted correctly, cannot be run
locally, and hides a syntax error until an instance fails to boot in a private subnet. A real
file can be executed with `python3 lib/app/server.py` before it is ever deployed. The cost is
that the CDK app now reads from disk at synth time, which is a dependency `lib/config.ts`
deliberately does not have — and that is why this lives in the compute module and not there.

---

## 3. The runtime experiment

Both runtimes ship. The runtime is a stack property, the same stack is deployed twice, and the
difference is the layer's published output.

```ts
export type Runtime = 'python' | 'node';

export interface Module1StackProps extends cdk.StackProps {
  readonly natGateways?: number;
  readonly certificateArn?: string;

  /** Default 'python'. See docs/adr/0025-the-runtime-is-a-deployment-property.md */
  readonly runtime?: Runtime;
}
```

Third property on this stack, and it earns the place on the same rule as the first two: a value
becomes a property when it changes what a given deployment *is*
([ADR-0006](../adr/0006-single-nat-gateway-by-default.md),
[ADR-0018](../adr/0018-the-certificate-is-optional.md)).

### What the two actually differ by

Amazon Linux 2023 ships Python 3. It does not ship Node.

| | Python | Node |
|---|---|---|
| Runtime install at boot | none | `dnf install -y nodejs` |
| Bytes over the NAT Gateway | 0 | the Node package and its dependencies |
| Depends on a repository answering at boot | no | yes |

That is the whole experiment, and it is one variable because of the next decision.

### Why the default is Python

Every default in this repository is the cheap, fast, self-contained one —
`natGateways: 1`, `certificateArn: undefined`. Python continues it: nothing is downloaded, boot
has no external dependency, and a clone-and-deploy produces the fastest path. Node is the opt-in
that costs something, which is exactly what makes it worth measuring.

### The cost lens nobody expects

`dnf install` leaves through the **NAT Gateway** at $0.045/GB.
[ADR-0008](../adr/0008-s3-gateway-endpoint.md) already wrote those numbers down for S3 traffic
and then said the NAT remains required for "package installs during user data, OS updates,
third-party APIs". This layer is the first one where that sentence has a measurable price
attached, on a line that looks like a runtime preference.

---

## 4. What the infrastructure requires of the application

Layer 3 established the inversion: the target group names the contract and the application obeys
it ([ADR-0019](../adr/0019-shallow-health-check-at-the-balancer.md)). Here is the whole contract.

| Requirement | Why, and what breaks without it |
|---|---|
| Listen on **8080** | `PORTS.frontend` and `PORTS.backend`. The security group permits 8080 and the target group polls 8080. An app on 3000 or 80 is unreachable and unhealthy, with nothing naming the port |
| Bind **`0.0.0.0`**, never `127.0.0.1` | The health check arrives from the balancer's network interface, not from the instance. An app bound to loopback answers `curl localhost:8080` perfectly while every probe fails and every target goes unhealthy. Nothing in any log names the bind address |
| `GET /health` → **200**, shallow | Touches nothing downstream. ADR-0019 |
| **No dependencies** | §5 |
| Frontend only: `GET /health/deep` | §6 |

The bind address deserves its place in that table rather than a footnote. It is the failure with
the widest gap between where it is caused and where it is observed: the cause is one string in a
source file and the symptom is a load balancer with no healthy targets.

---

## 5. The application carries no dependencies

Neither server imports anything outside its language's standard library. Python uses
`http.server`; Node uses `http`.

That is a constraint chosen for four reasons, and the first is the one that would be missed:

**It keeps the experiment honest.** With dependencies, the Node column measures `dnf install
nodejs` *plus* `npm install`, and the comparison stops being about runtimes and starts being about
package managers. Zero dependencies isolates the single variable §3 claims to be measuring.

**It fits in user data.** The limit is **16 KB in raw form, before base64 encoding** — and the
CDK does not validate it. Verified by reading `aws-cdk-lib/aws-ec2`: there is no length check
anywhere, so an oversized script synthesizes cleanly, passes review, and fails at deploy. Sixty
lines of dependency-free HTTP server is nowhere near the limit; the same application with a
framework is not, and would force S3 or a baked AMI on a layer that does not need them.

**It keeps instance refresh cheap**, which is a layer 5 concern designed for now. If boot takes
four minutes because half a package registry is being downloaded, a rolling replacement becomes
expensive enough that people stop doing it — and that is the road to instances quietly running
old code with every dashboard green.

**It removes a dependency on someone else's uptime.** A boot path that requires a package
registry to answer is a boot path that fails when that registry does not.

So S3 is **not** used to deliver the application, and that is a decision rather than an omission.
An app that does not fit in user data would need it; this one does, and reaching for S3 anyway
would be infrastructure added for a hypothetical.

---

## 6. `/health/deep` is a reachability probe, not a health check

This corrects [ADR-0019](../adr/0019-shallow-health-check-at-the-balancer.md) in a way that makes
it stronger, and the correction came from review.

ADR-0019 argued the frontend's health check should not call the backend, because chaining creates
a cascade and the ALB fails open. All true. It missed a simpler argument: **the backend's health
is already measured, better.** The backend has its own target group with its own health check, so
the internal balancer polls every backend target directly. `UnHealthyHostCount` on that target
group is the signal, per target, rather than "something downstream is unwell".

Chaining the checks would duplicate an existing measurement at lower resolution.

But the two are not the same measurement, and the difference is this repository's actual subject:

```
backend target group health check    internal ALB ──────────────────→ backend
/health/deep from the frontend       frontend ──→ internal ALB ──────→ backend
```

The second additionally traverses the frontend's egress, the layer 2 rule
`internalAlb ← frontend:80`, the internal balancer's listener, and DNS resolution of the internal
balancer's name from inside the VPC. None of that is covered by the backend's own health check.

So `/health/deep` survives, for a different reason than ADR-0019 gave it. It is not asking "is
the backend alive" — that is answered elsewhere and better. It is asking **"can this tier reach
that tier through the chain layers 2 and 3 built"**, which is the module's entire thesis, wired
as an instrument.

That also settles the weakness ADR-0019 admitted. It said no test can assert `/health/deep`, and
recorded that as a gap. It is not a gap: the endpoint was never a health check, so no target group
should ever reference it. It is the experiment's instrument, and it is exercised by hand.

It returns the backend's response and the time it took, so the reading is a number rather than a
boolean.

---

## 7. How the application boots

### The user data must terminate

If the last line of the script is the server running in the foreground, cloud-init never returns.
The instance stays in a pending-ish state from cloud-init's perspective, signals never fire, and
in layer 5 an auto scaling group's creation policy would wait for a signal that cannot arrive.

So user data does not run the server. It writes a **systemd unit** and starts it:

```
[Service]
ExecStart=/usr/bin/python3 /opt/app/server.py
Restart=always
RestartSec=2
```

`Restart=always` is what makes this more than a formality. It supervises the process across a
crash, and it removes the failure where a process started from a login shell dies on `SIGHUP`
when the session ends — leaving an instance that looks alive and serves nothing.

### It only runs once, and that is easy to forget

cloud-init runs `scripts-user` on **first boot only**. A reboot re-runs nothing. An instance whose
user data changed is an instance still running what it booted with.

There is an escape hatch — `cloud_final_modules: [[scripts-user, always]]` — and it is almost
always the wrong fix, because it makes every reboot re-run an install. The right fix is replacing
the instance, which is layer 5's instance refresh.

### The warning layer 5 inherits, designed for here

Changing user data produces a **new launch template version** and does not touch running
instances. Without an instance refresh or a rolling update policy, the sequence is: edit the boot
script, deploy, watch everything go green, and have every instance keep running the old code.

It is among the most disorienting failures in this area, and it is a layer 4 concern because it
constrains how this layer writes user data: **small and idempotent**, so that replacing an
instance is cheap enough that nobody avoids doing it. §5's zero-dependency rule is half of that
answer already.

### Where the failures show up

If the boot script fails, the instance still boots. SSH works. Only the service is missing, the
target never turns healthy, and no error anywhere names the cause. The log is
`/var/log/cloud-init-output.log`, and `cloud-init analyze blame` breaks the boot down by module.
Both go in the README, because this is the layer where someone will need them.

---

## 8. Identity, metadata, and the administrative path

### The instance role holds one policy

`AmazonSSMManagedInstanceCore`, and nothing else. It is what Session Manager needs. The
application reads no AWS API, so it gets no permission to.

### IMDSv2 is required, and it is not the default

`LaunchTemplateProps.requireImdsv2` defaults to **`false`** — verified in the CDK types. Left
alone, the instance answers IMDSv1: a plain `GET` to `169.254.169.254` with no token, which is the
classic path from a server-side request forgery bug in the application to the instance role's
temporary credentials.

`httpPutResponseHopLimit` already defaults to `1`, which is the correct value and worth not
breaking: it stops the metadata response from crossing a network hop, which is what contains the
same attack from inside a container.

### The Instance Connect Endpoint, and a CDK gap

Layer 2 wrote two SSH rules naming `eiceSg` as their source, and carried forward a warning:
**if `PreserveClientIp` is ever `true`, both rules stop matching**, because targets would then see
the client's address instead of the endpoint's interface.

There is no L2 construct. Confirmed against `aws-cdk-lib` 2.269.0 — `aws-ec2/lib/` has
`client-vpn-*` and no instance-connect module, so this is `ec2.CfnInstanceConnectEndpoint`, an L1
resource, with `preserveClientIp` written out explicitly as the L1 property it is.

Writing out a default that already matches is exactly the narrow exception from
[ADR-0009](../adr/0009-declare-dns-support-explicitly.md): the value is load-bearing for two rules
in a different file.

---

## 9. Configuration the frontend cannot know at build time

The frontend must reach the internal balancer, and the internal balancer's DNS name does not
exist until deploy.

It travels as a CDK token interpolated into the frontend's user data, which CloudFormation
resolves at deploy time:

```ts
`BACKEND_URL=http://${loadBalancers.internal.loadBalancerDnsName}:${PORTS.internal}`
```

Two consequences worth stating rather than discovering.

It creates a deploy-time dependency from the frontend's launch template to the internal balancer.
There is no cycle — the internal balancer depends on the backend target group, which depends on
nothing in this layer — but the ordering is now real and CloudFormation enforces it.

And it is baked at first boot. Per §7, changing it means replacing the instance. The alternative
— reading it from SSM Parameter Store at start-up — buys the ability to change it without a
replacement, at the cost of an IAM permission, a network call in the boot path, and a second place
where configuration lives. Not worth it for a value that changes only when the balancer is
recreated, and recorded here so the trade is visible.

---

## 10. The assertions, and what each one catches

| # | Assertion | The silent failure it catches |
|---|---|---|
| 1 | Two launch templates, one per tier, each wearing its tier's security group | A tier launched into the wrong group is unreachable, or reachable by the wrong thing |
| 2 | Both launch templates set `MetadataOptions.HttpTokens: required` | The IMDSv1 default. Nothing fails, and the credential path stays open |
| 3 | The instance role holds `AmazonSSMManagedInstanceCore` and no other managed policy | Permission creep. A role that grows is a role nobody audits |
| 4 | The Instance Connect Endpoint sets `PreserveClientIp: false` and wears `eiceSg` | Layer 2's carried warning. Set to `true`, both SSH rules match nothing and the only administrative path closes |
| 5 | User data contains the systemd unit, and its **last command is not the server** | §7. A foreground server means cloud-init never returns, which layer 5's signals depend on |
| 6 | User data binds `0.0.0.0`, and `127.0.0.1` appears nowhere in either application file | The widest cause-to-symptom gap in the layer |
| 7 | Both applications listen on `PORTS.frontend` / `PORTS.backend` — read from the constants, not retyped | A port that drifts from the target group is a tier that is never healthy |
| 8 | One instance per tier, registered in the matching target group | Registered in the wrong one and the internet reaches the application tier |
| 9 | With `runtime: 'node'`, user data installs Node; with `'python'`, it installs nothing | The experiment. A Python deployment that quietly installs a runtime is not the measurement it claims |
| 10 | The frontend's user data references the internal balancer's DNS name; the backend's does not | The dependency direction. A backend reaching the frontend is the chain running backwards |
| 11 | **Still zero warning annotations**, in both runtimes | Inherited from ADR-0016, and now it runs across two deployment shapes |

Assertion 6 is the one that looks silly and is not. It asserts on the *contents of a source file*
rather than on the template, which is unusual, and it is the only mechanical way to catch a
one-word change whose symptom appears three resources away.

**Every assertion gets mutation-tested before the work is called done**, as with every layer
before it.

---

## 11. How the measurement is actually taken

The number this layer produces is not a test. It needs a procedure, and it goes in the README so
it can be repeated rather than trusted.

For each runtime, deploy, then:

| Number | How |
|---|---|
| **Launch to in-service** | Poll `aws elbv2 describe-target-health` until the target reports `healthy`, timing from the instance's launch. This is the number that becomes layer 5's `estimatedInstanceWarmup` |
| **Where the time went** | `cloud-init analyze blame` on the instance over Session Manager. It attributes boot time per module, which separates "the AMI booted" from "we downloaded a runtime" |
| **Bytes through the NAT** | The NAT Gateway's `BytesOutToDestination` metric across the boot window, which converts the Node column into the $0.045/GB from ADR-0008 |

Three numbers, two runtimes, one table. That table is the layer's output, and it is worth more
than either deployment on its own — which is the whole reason both runtimes ship.

---

## 12. The records this layer produced

| ADR | Decision |
|---|---|
| [0025](../adr/0025-the-runtime-is-a-deployment-property.md) | The runtime is a deployment property, and the boot path is the measurement |
| [0026](../adr/0026-the-application-contract.md) | The application carries no dependencies, binds `0.0.0.0`, and obeys the target group's port |
| [0027](../adr/0027-user-data-terminates-systemd-owns-the-process.md) | User data terminates; systemd owns the process |
| [0028](../adr/0028-require-imdsv2.md) | Require IMDSv2, and nothing but Session Manager in the instance role |
| [0029](../adr/0029-the-deep-check-is-a-reachability-probe.md) | The deep check is a reachability probe, not a health check — amends [0019](../adr/0019-shallow-health-check-at-the-balancer.md) |
| [0030](../adr/0030-instance-connect-endpoint-keeps-the-client-ip-off.md) | The Instance Connect Endpoint keeps the client IP off, through an L1 resource because no L2 exists |

[ADR-0019](../adr/0019-shallow-health-check-at-the-balancer.md) is amended by 0029, not
superseded. Its argument against chaining health checks stands and gains a second, stronger leg;
what changes is what `/health/deep` is understood to be measuring.

---

## 13. Open questions, carried not buried

| Question | Why it is not answered here |
|---|---|
| Should the instances be in the target groups at all before layer 5? | Decided yes in §1, and it is the one boundary this plan moves. If the churn of layer 5 replacing them turns out to cost more than the measurement is worth, this is the decision to revisit first |
| Does `/health/deep` need a timeout? | Almost certainly, and the value is a guess until §11 produces real numbers. A probe that hangs is worse than one that fails |
| What happens when the backend instance is replaced? | The frontend holds a balancer DNS name, not an instance address, so nothing should change. That is an assertion this layer cannot make and layer 5 can |
| Is one instance per tier enough to show anything? | For reachability, yes. For anything about availability, no — a single instance in a single availability zone is exactly what layer 1's one-NAT decision already said is not two-AZ. Layer 5 is where that becomes real |
| Should the runtime comparison include a third option? | A container image would be the honest third column and it needs ECR, a build step and a different launch path. Out of scope, and worth naming so the two-column table is read as a deliberate scope rather than the whole space |
