# 0035 — The flow log is disposable evidence, not durable observability

**Status:** Accepted
**Date:** 2026-10-07

## Context

Module 2's flow log exists to make its own NACL's ACCEPT/REJECT decisions measurable during
module 2's own experiments (E0-E2). It is not module 2's job to be the repository's durable
observability layer — that destination and the query surface over it belong to module 5. This
record is the module-2 half of drawing that line. The other half is stated in
`docs/plans/module1-layer1-base-network.md` §1, where the module table a reader actually meets
would otherwise show rows 2 and 5 both writing flow logs with nothing saying why that is not
duplication. Neither this record nor that section restates something already written down
elsewhere — together they are what establish the split.

Building `FlowLogs` (`lib/module2-flow-logs.ts`) against that scope surfaced two costs that a
flow log built for "just get it running" would have paid silently, and one further note on why
the construct's output is trustworthy for the one thing it needs to measure.

### The cost G2-05 prices: a default nobody wrote down

`ec2.FlowLogDestination.toCloudWatchLogs()` called with no log group does not fail — it creates
one, with `RemovalPolicy.RETAIN` and two-year retention. That log group survives
`cdk destroy Net-M2`: the stack that created it is gone, and CloudWatch Logs keeps billing
storage against a retention period nobody in this repository chose. `cdk synth` is clean, `cdk
deploy` succeeds, and the only place this surfaces is a bill two years from now for a resource
no `cdk destroy` output ever mentioned.

The construct owns its log group explicitly instead of taking the default:

```ts
this.logGroup = new logs.LogGroup(this, 'LogGroup', {
  retention: RETENTION[MODULE_2_FLOW_LOGS.retentionDays],
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

`MODULE_2_FLOW_LOGS.retentionDays` is `7` — one week, long enough to span a session of
experiments and short enough that an abandoned stack does not quietly accumulate storage charges
for a year nobody is looking at it. Both properties are asserted directly in
`test/module2-flow-logs.test.ts`: `RetentionInDays` matches `MODULE_2_FLOW_LOGS.retentionDays`,
and the log group's `DeletionPolicy` is `Delete`. The retention value and the deletion behavior
are both load-bearing for "disposable," and both are now a template assertion rather than a
property this record merely recommends.

### A cast here is a deploy-time failure, not a compile-time one

`logs.RetentionDays` and `ec2.FlowLogMaxAggregationInterval` are numeric enums whose members
happen to equal the plain numbers (`RetentionDays.ONE_WEEK === 7`,
`FlowLogMaxAggregationInterval.ONE_MINUTE === 60`). That equality is exactly what makes
`MODULE_2_FLOW_LOGS.retentionDays as logs.RetentionDays` compile — TypeScript accepts the cast
because the runtime value already matches the enum's shape — and exactly what makes a bad value
fail only once it reaches CloudFormation at deploy time, with the cast having told the compiler
nothing was wrong.

`lib/module2-flow-logs.ts` converts through exhaustive maps instead:

```ts
const RETENTION: Record<FlowLogRetentionDays, logs.RetentionDays> = {
  1: logs.RetentionDays.ONE_DAY,
  3: logs.RetentionDays.THREE_DAYS,
  7: logs.RetentionDays.ONE_WEEK,
};
const AGGREGATION: Record<FlowLogAggregationSeconds, ec2.FlowLogMaxAggregationInterval> = {
  60: ec2.FlowLogMaxAggregationInterval.ONE_MINUTE,
  600: ec2.FlowLogMaxAggregationInterval.TEN_MINUTES,
};
```

`Record<union, Enum>` is exhaustive by construction: adding a value to `FlowLogRetentionDays` or
`FlowLogAggregationSeconds` without adding the matching case here is a compiler error at the
`RETENTION`/`AGGREGATION` declaration, not a runtime surprise at the call site. This is also
why the conversion lives at the construct boundary and not inside `lib/config.ts`.
[ADR-0005](0005-framework-free-configuration-module.md) keeps `lib/config.ts` free of
`aws-cdk-lib` imports; if the enum conversion lived there instead, config would need to import
`logs.RetentionDays` and `ec2.FlowLogMaxAggregationInterval` to build the map, which is the
exact CDK-leak ADR-0005 forbids. The plain-number union stays the config-side contract, and the
construct is where a plain number becomes a CDK type.

### The log format is the default list plus the two fields this measurement needs

`FlowLogs` builds its `logFormat` from CDK's default field list plus `PKT_DST_ADDR` and
`FLOW_DIRECTION`. Those two fields are what turn a REJECT into a direction-attributable fact:
without `flow-direction`, a REJECT record says a packet was rejected but not whether it was the
original request arriving or a reply leaving, which is precisely the ambiguity E2's
stateless-egress lesson needs resolved. `pkt-dstaddr` is what separates E2's own REJECT (toward
the measuring client's ephemeral port) from the health-check collateral
([ADR-0034](0034-ephemeral-range-rationale.md)) by destination address.

The list is built as "CDK's default fields, plus these two," not as a from-scratch field list,
because a from-scratch list silently drops whatever field a later CDK release adds to its own
default — this module would keep working, just with one fewer field than everyone who left the
default untouched, and nothing would say so.

## Decision

Module 2's flow log is an instrument scoped to module 2's own experiments, not a durable
observability record. It owns its log group (`ONE_WEEK` retention, `RemovalPolicy.DESTROY`),
converts config's plain-number retention and aggregation values through exhaustive `Record`
maps rather than a cast, and builds its log format as CDK's default fields plus `pkt-dstaddr`
and `flow-direction`. Module 5 owns the durable destination and the query layer separately; that
half of the split is recorded where module 5's design lands, not here.

## Consequences

**Easier.** The flow log's cost and lifetime are both explicit and both match what the
experiments actually need: one week is enough to run E0-E2 in a session, and `cdk destroy Net-M2`
genuinely removes the log group along with everything else, with no orphaned billing. Adding a
third retention or aggregation value is a one-line addition to a union type and a compiler error
everywhere the matching `Record` case is missing, not a hunt through the construct for every
place a number needed to become an enum.

**Harder.** `MODULE_2_FLOW_LOGS.retentionDays` and `aggregationIntervalSeconds` are restricted to
the exact values `RETENTION`/`AGGREGATION` map — `1 | 3 | 7` and `60 | 600` respectively.
Widening either union means adding the enum case at the same time; the type and the map must
move together, which is the point, but it is still two edits instead of one.

**What it costs.** One week of CloudWatch Logs storage for whatever volume of traffic this
NACL's flow log records, every time `Net-M2` is deployed — the smallest value `FlowLogRetentionDays`
permits, chosen because it still has to survive a multi-day run of experiments without the log
group aging out mid-session.

**What this does not decide.** Where module 5's durable destination lives, what its retention or
query layer looks like, or how (if at all) it might later subscribe to or replace this log
group. This record only draws the boundary from module 2's side: this flow log's job ends at
making module 2's own experiments measurable, and nothing here reaches forward into module 5's
design.
