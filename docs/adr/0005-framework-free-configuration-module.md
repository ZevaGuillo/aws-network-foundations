# 0005 — Keep the configuration module free of CDK types

**Status:** Accepted
**Date:** 2026-09-13

## Context

The address plan from [0003](0003-repo-wide-ipv4-addressing-plan.md) needs somewhere to live.
The obvious move is to put it next to the constructs that consume it, typed with CDK enums so
a stack can spread it straight into a `Vpc` and be done.

That couples the most stable thing in the repository to the least stable. The address plan is
a fact about this project that will outlive the constructs, the CDK major version, and the
stack layout — it is still true when everything around it has been rewritten. A CDK enum is a
library detail that moves on someone else's schedule.

Dependencies should point from volatile toward stable, not the reverse.

There is a second reason. A configuration module with no framework dependency can be imported
by anything — a unit test, a script that renders a diagram, a tool that checks ranges for
overlap — without pulling in the CDK and its synthesis machinery.

## Decision

`lib/config.ts` imports nothing from `aws-cdk-lib`. It exports plain data: strings, numbers,
and objects of those.

The boundary is drawn at the type, not the topic:

- A subnet mask lives in config as the number `24`. It is a fact about the network.
- `SubnetType.PRIVATE_WITH_EGRESS` does **not** live in config. It is a CDK concept, and the
  stack is where CDK concepts belong.

Values are declared `as const`, so each one carries its literal type. A mistyped CIDR becomes a
compile error at the call site rather than a CloudFormation failure twenty minutes into a
deployment.

Related values are grouped into named objects rather than scattered as loose exports. The
grouping is itself documentation: the name says which module owns the values under it.

## Consequences

**Easier.** The stable module depends on nothing. Tests and tooling can read the address plan
directly. Changing CDK versions cannot invalidate the plan.

**Harder.** The stack has to map plain data onto CDK types by hand. This is a few lines and is
the correct place for that translation to happen.

**The cost.** Read in isolation, a bare `24` is less self-describing than a typed constant
would be. Mitigated by grouping, by naming, and by the comment at the point of use that
explains what the mask actually buys.

**Rejected.** Loading configuration from environment variables or a JSON file. This project has
one shape and one environment; an indirection layer would add a failure mode and hide the
values from review for no gain.
