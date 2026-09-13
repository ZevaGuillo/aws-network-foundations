# 0011 — Name stacks by module, before the first deploy

**Status:** Accepted — naming scheme superseded in part by [ADR-0014](0014-one-stack-per-module.md)
**Date:** 2026-09-13

> The deadline this record establishes stands: a stack name is decided before the first deploy,
> never after. What changed is the shape of the name. This record prescribed
> `Net-M<module>-<layer>` on the assumption that layers might become separate stacks;
> [ADR-0014](0014-one-stack-per-module.md) decided they do not, so the name stops at the module
> and this stack is `Net-M1` rather than `Net-M1-Base`. The scheme below is left as written
> because the sequence is the history of the project.

## Context

`cdk init` names the first stack after the directory. This repository inherited
`AwsNetworkFoundationsStack` from that, and it is wrong in two different ways at two different
scales.

The small problem is that it does not identify anything. The repository holds five modules by
design, all of them network foundations. A name that describes the repository cannot
distinguish the modules inside it, so the day module 3 peers three VPCs there is nothing in
`AwsNetworkFoundationsStack` to say which of the several stacks it is. It is also the string
typed into every `cdk deploy`, `cdk diff` and `cdk destroy`.

The large problem is the deadline. The second argument to a stack constructor is its construct
id, and for a stack directly under the app that id becomes the CloudFormation stack name
verbatim. CloudFormation has no rename. Changing the id after a deployment does not rename the
stack — the next `cdk deploy` creates a **second** stack under the new name and the first one
stays, still holding the VPC, the NAT Gateway and its hourly charge, and now invisible to the
CDK app that created it. Recovering from that means a manual `cdk destroy` against the old name
plus a full redeploy, and the NAT Gateway bills through all of it.

So the cost of this decision is near zero before the first deploy and real after it. The
implementation plan for layer 1 originally deferred the rename to "when module 2 arrives".
That reasoning was inverted: it deferred the change past the exact moment that made it cheap.
`aws cloudformation describe-stacks` confirmed no stack of this name exists, which is what made
the correction free.

## Decision

Name stacks `Net-M<module>-<layer>` — this one is `Net-M1-Base` — and fix the name before any
stack is deployed for the first time.

The TypeScript identifiers follow the same shape (`Module1BaseNetworkStack` in
`lib/module1-base-network-stack.ts`), but for a different reason and under a different rule:
those are ordinary refactors with no CloudFormation consequence whatever, deployed or not.
Only the construct id in `bin/app.ts` is irreversible. The two are renamed together here
because leaving them disagreeing is worse than either name, not because they carry the same
risk.

## Consequences

**Easier.** The stack name says which module it belongs to, in the console, in the CLI, and in
a bill grouped by stack. Modules 2 through 5 have a pattern to follow instead of a precedent to
argue with.

**Harder.** Nothing, today. This is the entire argument for doing it today.

**What it costs.** A rename touching `bin/`, `lib/`, `test/`, `cdk.json` and the README, for no
behavioural change — the synthesized template is identical apart from the stack name and the
`Name` tags that embed the stack path. Reviewing a diff that large for zero functional
difference is the price of the deadline.

**The rule this establishes.** Anything that becomes a CloudFormation *name* is decided before
the first deploy, not after. It joins the CIDR ranges of
[ADR-0003](0003-repo-wide-ipv4-addressing-plan.md) and the subnet mask of
[ADR-0007](0007-slash-24-subnet-mask.md) on the short list of values this repository treats as
immutable once real.

**What this does not fix.** Logical ids of resources *inside* the stack are equally immutable
once deployed, and they are derived from construct paths — `new ec2.Vpc(this, 'Vpc')`. Renaming
that construct later replaces the VPC. This record covers the stack name; the same caution
applies one level down.
