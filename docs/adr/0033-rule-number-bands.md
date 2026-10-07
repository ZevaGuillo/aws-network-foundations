# 0033 — Rule numbers come from bands and declaration slots, never from a counter

**Status:** Accepted
**Date:** 2026-10-07

## Context

A Network ACL evaluates its entries in ascending `RuleNumber` order, per direction, and stops at
the first match. A `DENY` numbered above an `ALLOW` that would also have matched is never
evaluated — it is dead letter. Nothing reports this. `cdk synth` is clean, `cdk deploy`
succeeds, and the only symptom is a request that should have been rejected succeeding instead,
discovered against a green test suite that never generated the one entry order that exposes it.

A second, independent hazard sits next to the first. `RuleNumber` is not a free-form label; in
CloudFormation it participates in the entry's identity, and changing it is a replacement — the
old entry and the new one coexist for part of the update. A numbering scheme that reassigns an
existing rule's number on an unrelated change reintroduces the exact ordering hazard above,
mid-deploy, for a rule nobody touched.

ADR-0036 (the `openEphemeralEgress` scripted-breakage toggle, recorded separately) is built to
make that second hazard exercisable on purpose — disabling one egress slot is routine,
scripted, and has to leave every other rule's number untouched to do its job.

## Decision

Rule numbers are issued from two disjoint bands, and the action a given code path can emit is
bound to its band — not chosen per entry, not left to whoever writes the next rule.

```ts
const DENY_BAND = { first: 10, step: 1, limit: 99 } as const;
const ALLOW_BAND = { first: 100, step: 10 } as const;
```

The only path in `lib/module2-network-acls.ts` that can emit a `DENY` is the private
`denyIngress()` method, and it is the only reader or writer of `nextDenyRuleNumber`. The only
path that can emit an `ALLOW` is the private `allow()` method, and it is the only place
`ALLOW_BAND` is read. Because each band has exactly one code path that can emit its action,
`max(DENY_BAND) = 99 < 100 = min(ALLOW_BAND)` holds by arithmetic — there is no entry point
left over through which a deny could be numbered above an allow. The uniqueness and ordering
tests in `test/module2-network-acls.test.ts` remain as a second line of defence; the structure
is what makes them pass, not the other way around.

**The deny band throws when exhausted:**

```ts
private denyIngress(id: string, cidr: string): void {
  if (this.nextDenyRuleNumber > DENY_BAND.limit) {
    throw new Error(
      `NetworkAcls: deny band exhausted (rule numbers ${DENY_BAND.first}-${DENY_BAND.limit}). ` +
        'Adding another denied source here would be numbered inside the allow band, ' +
        'silently placing a DENY above an ALLOW (G2-03) with no error at deploy.',
    );
  }
  // ...
}
```

Without the throw, a 91st denied CIDR would silently receive rule number 100 and sit above
every `ALLOW` — the exact hazard the band split exists to prevent, reintroduced by the one
mechanism that fills the band. The throw is what turns "hard to get wrong" into "cannot get
wrong": it fails at synth, loudly, naming the construct and the limit, instead of failing at
deploy with nothing naming anything.

**Allow numbers come from each slot's position in a declaration array, never from a running
counter advanced per emitted entry:**

```ts
const egress: AllowSlot[] = [
  { id: 'AllowEphemeralOut', traffic: ec2.AclTraffic.tcpPortRange(1024, 65535), enabled: openEphemeralEgress },
  { id: 'AllowHttpsOut',     traffic: ec2.AclTraffic.tcpPort(443), enabled: true },
  { id: 'AllowPublicPortOut', traffic: ec2.AclTraffic.tcpPort(publicPort), enabled: true },
  { id: 'AllowIcmpOut',      traffic: allIcmp, enabled: true },
];

private allow(direction: ec2.TrafficDirection, slots: readonly AllowSlot[]): void {
  slots.forEach((slot, index) => {
    if (!slot.enabled) {
      return; // the slot's number stays unused; nothing after it renumbers
    }
    this.acl.addEntry(slot.id, {
      cidr: ec2.AclCidr.anyIpv4(),
      traffic: slot.traffic,
      direction,
      ruleAction: ec2.Action.ALLOW,
      ruleNumber: ALLOW_BAND.first + index * ALLOW_BAND.step,
    });
  });
}
```

This is not cosmetic. A counter advanced only for *enabled* slots would renumber a surviving
rule the moment an earlier slot is disabled: with `AllowEphemeralOut` at index 0 removed by
`openEphemeralEgress: false`, a counter-based scheme would renumber `AllowHttpsOut` from 110
down to 100. `RuleNumber` is replace-on-update, so the old entry at 110 and the new one at 100
coexist mid-update and collide with whatever already holds 100 — disabling the egress ephemeral
slot for ADR-0036's experiment E2 would have broken the very deploy the toggle exists to
demonstrate. Numbering by declaration-slot index and filtering
*after* numbering — skip the disabled slot, don't shift the ones after it — keeps every
surviving rule's number fixed across the toggle, so disabling a slot is a clean single
create/delete of that one entry and nothing else moves.

The implementation exists and passes `test/module2-network-acls.test.ts`'s
`openEphemeralEgress` toggle cases (`AllowHttpsOut` stays `RuleNumber: 110` whether the toggle
is `true` or `false`), so this record cites `lib/module2-network-acls.ts` rather than arguing
the case hypothetically.

## Consequences

**Easier.** Adding, removing, or reordering `deniedSources` entries, or flipping
`openEphemeralEgress`, is a change to data, not a change to a numbering algorithm someone has
to re-verify by hand. The guarantee — deny below allow, no renumbering across a toggle — is
load-bearing in the type of the array and the shape of the two emitting methods, not in a
comment asking the next author to be careful.

**Harder.** `deniedSources` is still data, and inserting a CIDR at the front of that list still
renumbers every entry after it, because `denyIngress()` numbers by call order within that list
rather than by a second declaration-slot scheme. The mitigations: the list is sorted before
numbering (`[...deniedSources].sort().forEach(...)`), so re-running the same set in a different
order is a no-op, and the convention is append-only — insert at the front and the tail
renumbers. Because `Net-M2` holds no stateful resource, the complete escape from any
renumbering hazard here is `cdk destroy Net-M2 && cdk deploy Net-M2`, a real dividend of
[ADR-0032](0032-module-2-own-stack.md)'s separate stack.

**What this does not guarantee.** The structural proof is scoped to "every entry on this NACL
is issued by this construct." A direct `acl.addEntry()` call from outside `NetworkAcls`, or a
second `NetworkAcls` instance built over the same `NetworkAcl`, is outside that scope and voids
the arithmetic this record relies on.
