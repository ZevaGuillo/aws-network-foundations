# 0010 — Resolve the deployment environment from the CLI, and fail without it

**Status:** Accepted
**Date:** 2026-09-13

## Context

A CDK stack is either specialized for one account and region, or environment-agnostic. The
generated entry point ships agnostic, with two commented alternatives: read
`CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`, or write the account id and region as literals.

Agnostic is not viable here. [ADR-0006](0006-single-nat-gateway-by-default.md) pins the network
to two availability zones, and without an environment the CDK cannot know which zones exist, so
it emits `Fn::Select(0, Fn::GetAZs(""))` — a placeholder resolved at deploy time. `maxAzs: 2`
then describes a count, not two known zones, and nothing in the repository can assert otherwise.
Context lookups degrade the same way: with no account to query they return dummy values that
synthesize cleanly.

Between the two remaining options, the literal form is more explicit but writes the account id
into a repository meant to be read publicly. An account id is not a secret — it appears in
every ARN shared with a third party — but it is reconnaissance material: it lets an outsider
probe for role and bucket names without any other information. It also pins the source to one
account, so a second deployment means editing code.

The generated `CDK_DEFAULT_*` line has its own defect, and it is the one this project cares
about most. When either variable is absent, `env` becomes `{ account: undefined, region:
undefined }`, which the CDK treats as no environment at all. Synthesis succeeds. Deployment
succeeds. The stack is silently back to agnostic, and the only symptom is a placeholder in a
template nobody reads. These variables are populated by the CDK CLI from resolved credentials —
not exported by the user — so they are absent whenever the entry point runs outside `npx cdk`,
and whenever credentials stop resolving.

## Decision

Resolve the environment from `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` through
`resolveEnvironment` in `lib/environment.ts`, which throws when either is missing or empty
rather than returning a partial environment.

The function takes the variables as an argument instead of reading `process.env` directly, so
the rule is covered by assertions without mutating global state or synthesizing a stack. It
imports only a type from the CDK, on the reasoning in
[ADR-0005](0005-framework-free-configuration-module.md).

## Consequences

**Easier.** Availability zones resolve to real names at synthesis — `us-east-1a`,
`us-east-1b` — so the template shows what will be deployed, and context lookups work. The same
source deploys to any account by changing AWS profile, and the account id stays out of the
history.

**Harder.** `npx cdk synth` now requires working credentials. A reader who clones the
repository to look at the generated template cannot do so without an AWS account. That is a
real cost, accepted because an agnostic template misrepresents this stack: it would show the
placeholder and teach the wrong thing about what was built.

**The failure moves earlier and gets louder.** An unresolved environment stops the app with a
message naming the missing variable, stating that the CDK CLI is what sets it, and giving the
two commands that diagnose credentials. The alternative was a deployment that works and a
template that quietly says something else.

**Empty strings count as absent.** An unset AWS region surfaces as `''` rather than
`undefined`, so the guard tests truthiness. A null check would have let the original failure
back in through the side door.

**Context lookups now produce a file, and this repository ignores it.** Specifying `env` is
what lets the CDK ask the account which availability zones exist, and it caches the answer in
`cdk.context.json`, keyed by account and region. AWS recommends committing that file so
synthesis is reproducible and does not drift the day a region gains a zone. The key contains
the account id, which this record just decided to keep out of the history — and the benefit of
committing it, synthesizing without an account, is the one the guard above already gave up.
Paying the account id for a benefit this decision removed does not balance, so the file is
ignored. **This reasoning depends on the repository being public and single-author.** A team or
production repository should commit it, and the drift protection there is worth more than the
exposure.

**Not yet decided.** Whether later modules deploy to more than one region. Nothing here blocks
it — the resolver returns one environment per app invocation, and a multi-region topology would
pass explicit environments per stack instead. That decision belongs to the module that needs
it.
