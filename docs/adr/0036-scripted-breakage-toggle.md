# 0036 — `openEphemeralEgress` is a scripted-breakage toggle, not a hand edit

**Status:** Accepted
**Date:** 2026-10-07

## Context

Experiment E2 needs a stateless-egress failure on demand: a Network ACL is stateless, so a
reply to an accepted inbound request needs its own egress rule, unlike a security group, which
tracks the connection and lets the reply back in automatically. Removing the matching egress
rule breaks exactly that class of reply. That single fact — a stateful filter forgives a missing
return rule and a stateless one does not — is the entire thing E2 has to demonstrate.

The question this record answers is not whether to break egress on purpose; it is how. A hand
edit to `lib/module2-network-acls.ts` at experiment time — comment out `AllowEphemeralOut`,
redeploy, observe, revert — is unreviewed, is not reproducible from the repository's own state,
and exercises a code path no test in this repository ever runs: nothing in
`test/module2-network-acls.test.ts` would catch a hand edit that broke the rule a different way
than intended, because the hand edit never existed as code the suite could see.

`MODULE_2_NACL.openEphemeralEgress` (`lib/config.ts`) is the alternative: a plain boolean,
defaulting to `true`, that `NetworkAcls` reads to decide whether the `AllowEphemeralOut` slot
(`lib/module2-network-acls.ts`, egress declaration array, index 0) is enabled at all.

```ts
{
  id: 'AllowEphemeralOut',
  traffic: ec2.AclTraffic.tcpPortRange(1024, 65535),
  enabled: openEphemeralEgress,
}
```

## Decision

Script the breakage through the same config value and the same construct code path that
produces the healthy deploy; never hand-edit the construct to produce it.

`test/module2-network-acls.test.ts` runs the rule-numbering assertions under
`test.each([[true], [false]])`:

```ts
test.each([[true], [false]])(
  'egress tcp 1024-65535 is present only when openEphemeralEgress is %s, and the other egress rules keep their numbers either way',
  (openEphemeralEgress) => {
    const { template } = synthModule2({ openEphemeralEgress });
    // ...
    expect(tcpEntry(template, true, 443).RuleNumber).toBe(110);
    expect(tcpEntry(template, true, 80).RuleNumber).toBe(120);
  },
);
```

Both `openEphemeralEgress: true` and `openEphemeralEgress: false` run through this same test,
against the same construct, with one data value different. The broken deploy (E2's) and the
healthy deploy are not two different code paths that happen to agree — they are the same code
path, test-guarded in both positions, which a hand edit could never be.

[ADR-0033](0033-rule-number-bands.md) is why this is safe to flip rather than merely convenient.
Disabling slot index 0 (`AllowEphemeralOut`) is exactly the case a running counter would have
mishandled: it would renumber the next slot, `AllowHttpsOut`, from rule number 110 down to 100.
`RuleNumber` is replace-on-update in CloudFormation, so the old entry at 110 and the new one at
100 coexist for part of the update and collide with whatever already holds 100. A counter-based
numbering scheme would have broken the very deploy this toggle exists to demonstrate, for a
reason that has nothing to do with E2's lesson. ADR-0033 records the mechanism that prevents
that — declaration-slot numbering, filtered after numbering — so this record cites it rather
than re-deriving the same argument: the toggle above is only a clean single-entry create/delete
because that mechanism already holds.

## Consequences

**Easier.** Running E2 and reverting it is `openEphemeralEgress: false`, `cdk deploy`, observe,
`openEphemeralEgress: true`, `cdk deploy` — two config edits and two deploys, both exercising
code the test suite already runs in both positions. There is no "did the hand edit actually
match what the lab script says" question, because there is no hand edit.

**Harder.** The toggle is coarser than the experiment strictly asks for — see below.

**What it costs — the collateral is explicit, not discovered mid-experiment.**
`PORTS.frontend = 8080` sits inside the same 1024-65535 range `openEphemeralEgress` controls, so
setting it to `false` does not only remove the reply path for the experiment's own probe; it
also removes `AllowEphemeralOut` for the external ALB's forwarding and health-check traffic
toward the frontend tier. Every health check against `PORTS.frontend` starts failing the same
way E2's probe does. Two distinct REJECT patterns appear in the flow log while the toggle is
`false`, separable by destination address and by cadence: E2's own probe is one REJECT per
manual request, egress, toward the measuring client's ephemeral port; the health-check
collateral is a REJECT roughly every ten seconds, egress, toward a private in-VPC address, for
as long as the toggle stays `false`. [ADR-0034](0034-ephemeral-range-rationale.md) already
records why the ephemeral range covers this traffic at all; this record owns the consequence of
removing egress's half of that range — the collateral is the direct, already-documented result
of the same range, not a new failure mode this toggle introduces on its own.

**What this does not decide.** Whether a permanent, narrower `AllowTargetsOut tcp/8080` rule
below the ephemeral slot would isolate E2 from the health-check collateral. Design D4 considered
and rejected that for this change: it would survive the toggle and conceal that a public-subnet
ephemeral egress rule legitimately carries in-VPC traffic, which is part of what E2 is meant to
teach. If the collateral proves unreadable in practice against real flow-log evidence, that
option stays available, not foreclosed by this record.
