# Implementation Plan — Module 1, Layer 1: Base Network

**Status:** proposed, not implemented
**Scope:** `lib/config.ts` + `lib/aws-network-foundations-stack.ts` (VPC only)
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
| `lib/aws-network-foundations-stack.ts` | The VPC: subnets, NAT, S3 gateway endpoint, and the property that makes the NAT count deployable-tunable |

### Out of scope for this layer

Security groups, load balancers, EC2 tiers, auto scaling groups, launch templates, TLS
certificates, flow logs, stack outputs. These are layers 2 and up.

### Adjacent items — flagged, not changed

Real work, outside this layer's two files. Listed so they are not lost, not so they get done
silently.

| Item | Why it matters | Plan |
|---|---|---|
| `bin/aws-network-foundations.ts` has no `env` | An environment-agnostic stack resolves availability zones to synth-time placeholders and cannot perform context lookups. "Exactly two AZs" only means two *concrete* zones once `env` is set. | Set it from `CDK_DEFAULT_*` in the next work unit |
| `test/` still holds the generated placeholder | Nothing currently guards the NAT count, the subnet mask, or the intentional address collision | Add synthesis assertions next — see §5 |
| Stack file is the generated name, not `lib/moduleN-*/` | Renaming the *file* is free. Renaming the **stack id in `bin/`** creates a different CloudFormation stack and orphans the old one. | Keep the current name through layer 1; restructure once, deliberately, when module 2 arrives |

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

## 4. `lib/aws-network-foundations-stack.ts`

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

## 5. Verification — next work unit, not this one

1. `npx tsc --noEmit` — types compile.
2. `npx cdk synth` — template renders.
3. Assertions against the synthesized template:
   - exactly one `AWS::EC2::NatGateway` by default; exactly two when the property is set to 2
   - exactly four `AWS::EC2::Subnet`, every one a `/24`
   - `EnableDnsHostnames` and `EnableDnsSupport` both true on the VPC
   - one `Gateway`-type `AWS::EC2::VPCEndpoint` for S3
   - **the intentional module 3 / module 4 address collision still holds**

The last one is the point. It converts a comment that asks people not to break something into a
test that stops them — the measure named in
[ADR-0004](../adr/0004-intentional-cidr-overlap.md).

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
