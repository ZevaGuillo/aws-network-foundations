# Implementation Plan — Module 1, Layer 1: Base Network

**Status:** implemented
**Scope:** `lib/config.ts` + `lib/module1-base-network-stack.ts` (VPC only), with the
assertions that guard them
**Date:** 2026-09-13

The decisions behind this plan are recorded individually in [`docs/adr/`](../adr/README.md).
This document is the work plan: what gets written, in what order, and what is deliberately left
for later. Where a choice needs justifying, it links to its record rather than restating it.

---

## 1. What this layer is

A single VPC that every later module either extends or deliberately collides with.

| Module | What it adds | Dependency on this layer |
|---|---|---|
| 1 — Base network | VPC, external and internal load balancing, EC2 tiers, auto scaling | **This is its first layer** |
| 2 — Edge security | Network ACLs and flow logs over module 1 | Reuses this VPC and its subnets |
| 3 — Multi-VPC and peering | Cross-region peering, non-transitivity proof | **Fails if address ranges overlap** — [ADR-0003](../adr/0003-repo-wide-ipv4-addressing-plan.md) |
| 4 — Private service exposure | Identical-range experiment, endpoint policy | Needs DNS enabled ([ADR-0009](../adr/0009-declare-dns-support-explicitly.md)); extends the endpoint ([ADR-0008](../adr/0008-s3-gateway-endpoint.md)) |
| 5 — Observability | Flow logs and query layer | Consumes this VPC as a log source |

That table is the reason the configuration module carries a repo-wide address plan rather than
module 1's own range: two of the five modules are about connecting VPCs, and address ranges
cannot be changed after creation.

---

## 2. Scope boundary

### In scope — the two files

| File | Contents |
|---|---|
| `lib/config.ts` | Repo-wide IPv4 address plan; module 1 network parameters. No CDK imports — [ADR-0005](../adr/0005-framework-free-configuration-module.md) |
| `lib/module1-base-network-stack.ts` | The VPC: subnets, NAT, S3 gateway endpoint, and the property that makes the NAT count deployable-tunable |

### Out of scope for this layer

Security groups, load balancers, EC2 tiers, auto scaling groups, launch templates, TLS
certificates, flow logs, stack outputs. These are layers 2 and up.

### Adjacent items — flagged, not changed

Real work, outside this layer's two files. Listed so they are not lost, not so they get done
silently.

| Item | Why it matters | Plan |
|---|---|---|
| ~~`bin/app.ts` has no `env`~~ | An environment-agnostic stack resolves availability zones to synth-time placeholders and cannot perform context lookups. "Exactly two AZs" only means two *concrete* zones once `env` is set. | Done — resolved from `CDK_DEFAULT_*` through a guard that throws rather than degrading silently, [ADR-0010](../adr/0010-resolve-the-deployment-environment-from-the-cli.md). Subnets now synthesize to `us-east-1a` / `us-east-1b` instead of `Fn::GetAZs` |
| ~~`test/` still holds the generated placeholder~~ | Pulled into this layer rather than deferred: the configuration comment and [ADR-0004](../adr/0004-intentional-cidr-overlap.md) both claim a test protects the intentional collision, and shipping that claim without the test would make it false | Done — see §5 |
| ~~Stack file is the generated name, not `lib/moduleN-*/`~~ | Renaming the *file* is free. Renaming the **stack id in `bin/`** creates a different CloudFormation stack and orphans the old one. | Done, **reversing the original plan of deferring to module 2.** That deferral justified itself with a cost that only exists after the first deploy, and so scheduled the change for a point where it would no longer be free. `aws cloudformation describe-stacks` confirmed nothing was deployed, and the rename landed while it cost nothing: stack id `Net-M1-Base`, class `Module1BaseNetworkStack`, file `lib/module1-base-network-stack.ts`, entry point `bin/app.ts`. [ADR-0011](../adr/0011-name-stacks-by-module-before-the-first-deploy.md) |
| ~~Public subnets auto-assign public IPv4 addresses~~ | A CDK default, not a decision. Every compute tier here belongs in a private subnet; with auto-assign on, one placed in the wrong group comes up internet-reachable and healthy. | Done — `mapPublicIpOnLaunch: false`, [ADR-0012](../adr/0012-never-auto-assign-public-ipv4-addresses.md). Forced the public-subnet assertion in §5 to stop reading that attribute and follow route tables instead |

---

## 3. `lib/config.ts`

**One job:** be the single source of truth for network parameters that outlive a single stack.
It answers *what address space does module N own* and *what are module 1's network values*. It
does not answer *how is a VPC built*.

**Shape.** Two exports. `IPV4_ADDRESS_PLAN` holds the repo-wide table from
[ADR-0003](../adr/0003-repo-wide-ipv4-addressing-plan.md), including the intentional module 4
overlap from [ADR-0004](../adr/0004-intentional-cidr-overlap.md), written as a reference to the
module 3 value so the duplication cannot drift. `MODULE_1_NETWORK` holds this module's values
and derives its VPC range from the plan rather than repeating the string.

Both are declared `as const`. A mistyped range becomes a compile error at the call site instead
of a CloudFormation failure twenty minutes into a deployment.

### Clean-code rationale

| Principle | Applied as |
|---|---|
| **SRP** | Config holds parameters. The stack holds composition. Neither does the other's job. |
| **DRY** | Every address range is written once. Module 1's range is derived from the plan; module 4's is a reference to module 3's. |
| **KISS** | Plain exported objects. No config class, no builder, no loader, no environment indirection — the project has one shape. |
| **OCP** | Module 3 adds rows to the plan; it does not touch module 1's stack. |
| **DIP** | The stable data module depends on nothing. The volatile stack depends on it — [ADR-0005](../adr/0005-framework-free-configuration-module.md). |
| **YAGNI, recorded** | No generic overlap-detection validator. Five curated ranges and one intentional collision — the validator would be larger than what it guards and would need to special-case the exception. Revisit past ~10 entries. |

---

## 4. `lib/module1-base-network-stack.ts`

**One job:** compose CDK constructs from configuration values. No literals, no magic numbers.

**Property surface.** One optional property: the NAT Gateway count, defaulting to the
configured value. Interface segregation — the stack exposes the single knob that changes the
bill per deployment, not the whole configuration object. Rationale and the rejected
alternatives are in [ADR-0006](../adr/0006-single-nat-gateway-by-default.md).

**Subnet layout.** Public and private-with-egress, `/24` each
([ADR-0007](../adr/0007-slash-24-subnet-mask.md)), across two availability zones.

`PRIVATE_WITH_EGRESS` is requirement-driven: instances install packages during user data and
need a default route to the NAT. `PRIVATE_ISOLATED` has no egress at all, and its failure mode
is the worst kind — user data hangs, the instance never reports healthy, the auto scaling group
loops terminating newborn instances, and nothing in any error message points at the subnet
type. The comment in the code states that symptom, not just the rule.

**Comments.** Each non-obvious value carries a comment written as *why and what it costs*, never
*what the code does*. The four that matter here — the explicit NAT count and what one gives up,
the `/24` mask and the five addresses AWS reserves in every subnet, DNS as a prerequisite for a
later module, and the dollar figures the S3 gateway endpoint removes — each summarise their
record in two or three lines and leave the full argument to the ADR.

**Exposure.** The VPC is a `public readonly` field so layer 2 can consume it. No cross-stack
export machinery yet; layers 2 and up live in the same stack for now.

---

## 5. Verification — done

`npx tsc --noEmit` and `npx cdk synth` both clean. `npx jest` — 13 passed.

What the synthesized template actually contains:

| Resource | Count | Detail |
|---|---|---|
| `AWS::EC2::VPC` | 1 | `10.0.0.0/16`, DNS hostnames and support both true |
| `AWS::EC2::Subnet` | 4 | `10.0.0.0/24` and `10.0.1.0/24` public, `10.0.2.0/24` and `10.0.3.0/24` private |
| `AWS::EC2::NatGateway` | 1 | two when the property is set to 2 |
| `AWS::EC2::EIP` | 1 | one address to reclaim after teardown, not two |
| `AWS::EC2::InternetGateway` | 1 | |
| `AWS::EC2::RouteTable` | 4 | one per subnet |
| `AWS::EC2::VPCEndpoint` | 1 | `Gateway` type, S3 |

### The assertion that matters

The address-collision guard is the reason this layer carries tests at all. Everything else
here fails loudly if it drifts; that one does not. Separating module 4's range from module 3's
deletes the experiment without breaking a deployment — no stack fails, no template changes,
nothing turns red.

The guard was mutation-tested rather than assumed: replacing the reference with a different
literal was confirmed to turn the suite red, and the change was reverted. A test that cannot
fail protects nothing, and this one is written as an identity check, so verifying it was not
optional.

### The exception these tests take to ADR-0010

`synth()` builds the stack with no `env`, so `resolveEnvironment` never runs and the suite
synthesizes in exactly the environment-agnostic mode
[ADR-0010](../adr/0010-resolve-the-deployment-environment-from-the-cli.md) exists to prevent.
Zones come out as `Fn::Select[n, Fn::GetAZs '']` rather than `us-east-1a` and `us-east-1b`.

That is deliberate and worth stating, because it is the first thing that looks wrong to anyone
who has just read `environment.ts`. A suite that required credentials is a suite most readers
cannot run, and ADR-0010 argues about what gets deployed, not about what gets asserted. It is
safe only because no assertion depends on a concrete zone — they count subnets, match masks,
follow route tables and compare configuration values, all identical in both modes.

The limit is now written into the helper: the first assertion that does depend on a zone has to
pass a fixed test environment, because an `Fn::GetAZs` token cannot be asserted against.

### The assertion that was asserting almost nothing

The S3 gateway endpoint test read `VpcEndpointType: 'Gateway'` and nothing else. Gateway
endpoints exist for two services, so replacing S3 with DynamoDB left the suite green — verified
by mutation — while [ADR-0008](../adr/0008-s3-gateway-endpoint.md) argues the case entirely in
S3 traffic and S3 figures. The test now names the service.

Reading it required a helper. The service name embeds the region, so it renders as an `Fn::Join`
around `AWS::Region` under the environment-agnostic synthesis above and as a plain string once
an environment is pinned; `serviceNameOf` flattens both to the suffix that matters. The mutation
now fails with `"com.amazonaws..dynamodb"` against `/\.s3$/`.

### The assertion that had to be rewritten

The public-subnet count identified its subjects by filtering on `MapPublicIpOnLaunch`, which is
a CDK default rather than anything decided here. Setting that attribute to `false`
([ADR-0012](../adr/0012-never-auto-assign-public-ipv4-addresses.md)) dropped the count to zero
and turned the test red over a network that was entirely correct — the test was standing in the
way of the security decision it should have been indifferent to.

It now follows route tables: public subnets are the ones whose default route reaches the
internet gateway, private the ones that reach the NAT Gateway. Both directions were
mutation-tested. Removing `mapPublicIpOnLaunch: false` fails **only** the new auto-assign
assertion and leaves the topology test green, which is the decoupling being verified directly.
Switching the private subnets to `PRIVATE_ISOLATED` fails the topology test, which confirms it
still detects a real change.

---

## 6. Risks carried into this layer

| Risk | Mitigation |
|---|---|
| Unpinned AZ or NAT count → ~$96/month invisible in the source | Both pinned explicitly, with the figure in the comment — [ADR-0006](../adr/0006-single-nat-gateway-by-default.md) |
| `PRIVATE_ISOLATED` chosen by mistake → silent termination loop | Comment states the symptom, not just the rule |
| Intentional address collision "corrected" by a reader | Reference instead of literal, intent-carrying name, and a test — [ADR-0004](../adr/0004-intentional-cidr-overlap.md) |
| Subnet masks are immutable after creation | Argued up front in [ADR-0007](../adr/0007-slash-24-subnet-mask.md) |
| Elastic IPs surviving teardown | Out of scope here, but the single-NAT default leaves one address to verify instead of two |

No open questions. The two files are ready to write on approval.
