# 0025 — The runtime is a deployment property, and the boot path is the measurement

**Status:** Accepted
**Date:** 2026-09-14

## Context

Layer 4 needs something that answers on port 8080. Two candidates, and the choice between them
looked like a preference until it was priced.

Amazon Linux 2023 ships Python 3. It does not ship Node. So a Node tier's boot script begins with
`dnf install -y nodejs`, and that single line carries three costs the Python path does not have:

- **Time.** Minutes rather than seconds, and it is the number that becomes layer 5's
  `estimatedInstanceWarmup`. An auto scaling policy whose warm-up estimate is wrong either
  responds to a traffic spike after it ended, or launches a second wave of instances because the
  first has not reported yet.
- **Money.** `dnf install` leaves through the NAT Gateway at $0.045/GB.
  [ADR-0008](0008-s3-gateway-endpoint.md) wrote that number down and then said the NAT remains
  required for "package installs during user data, OS updates, third-party APIs". This is the
  first layer where that sentence has something measurable attached to it, on a line that reads
  as a runtime preference.
- **Availability.** A boot path that requires a package repository to answer is a boot path that
  fails when it does not.

Picking one and moving on would have buried all three. Picking one and *estimating* the other
would have been worse: a number nobody measured, quoted in a repository whose argument is that
defaults cost something specific.

## Decision

**Both ship.** The runtime is a stack property, the same stack is deployed twice, and the
difference is the layer's output.

```ts
export type Runtime = 'python' | 'node';

export interface Module1StackProps extends cdk.StackProps {
  readonly natGateways?: number;
  readonly certificateArn?: string;
  readonly runtime?: Runtime;
}
```

Third property on this stack, on the same rule as the first two: a value becomes a property when
it changes what a given deployment *is*, and everything else stays in configuration where it is
reviewed once ([ADR-0006](0006-single-nat-gateway-by-default.md),
[ADR-0018](0018-the-certificate-is-optional.md)).

**The default is Python**, which continues the pattern rather than starting a new one. Every
default in this repository is the cheap, fast, self-contained one — one NAT Gateway, no
certificate. Python downloads nothing and has no external dependency at boot. Node is the opt-in
that costs something, which is exactly what makes it worth measuring.

The comparison is one variable only because of
[ADR-0026](0026-the-application-contract.md): neither application has dependencies, so the Node
column measures a runtime install and not `npm install` as well.

## Consequences

**Easier.** The layer produces a number instead of an opinion. Layer 5's warm-up estimate stops
being a guess, and the thrashing experiment has a slow boot and a fast boot to run against rather
than one arbitrary boot.

**Harder.** Two applications to keep in step. They must expose the same routes with the same
semantics or the comparison is measuring two different programs, and there is no compiler
enforcing that — only the assertions in `test/module1-compute.test.ts` and the fact that both
files are short enough to read side by side.

**What it costs.** Every later experiment inherits an extra dimension. A layer 5 result is now
"under Python" or "under Node", and a reader who only cares about auto scaling has to hold a
variable that is not theirs. That is the price of the table, and the table is worth it.

**The guard.** One assertion, in both modes: with `runtime: 'node'` the user data installs a
runtime, and with `'python'` it installs nothing. A Python deployment that quietly installs
something is not the measurement it claims to be, and the whole comparison would be off by
whatever it downloaded.

**What this does not decide.** A third column. A container image would be the honest next
comparison and it needs ECR, a build step and a different launch path — out of scope, and named
in the plan so the two-column table is read as a deliberate scope rather than the whole space.

**When this is revisited.** When the numbers exist. If the difference turns out to be small
enough not to change any layer 5 decision, the right move is to keep the measurement in the
README and drop one runtime from the code — the table is the deliverable, the second code path
is only the means.
