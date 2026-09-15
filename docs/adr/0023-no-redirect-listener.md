# 0023 — Port 80 stays shut when there is a certificate

**Status:** Accepted
**Date:** 2026-09-14

## Context

[ADR-0018](0018-the-certificate-is-optional.md) made the public port a single derived value:

```ts
export function publicPort(certificateArn?: string): number {
  return certificateArn === undefined ? PORTS.http : PORTS.https;
}
```

One number, two consumers — the listener binds it, the external security group opens it — so
they cannot disagree. That was the whole point, and it removed a failure with no error message.

It also produced a consequence nobody decided. With a certificate supplied, **port 80 does not
exist**: no listener, no rule. Someone typing `http://<the balancer>` does not get a redirect.
They get a timeout, with nothing anywhere explaining why.

A timeout with no explanation is the exact failure shape this repository exists to refuse, so
leaving it as a side effect of an abstraction is not acceptable whichever way it is resolved.

### The tension, which is the interesting part

The conventional answer is a second listener on 80 whose default action is a 301 to 443. It does
not fit, and the reason it does not fit is the abstraction that made layer 2 safe.

A redirect needs **two** ports open on the external security group — 80 and 443 — so
`publicPort()` stops returning a port and starts returning a list. The guarantee it provides
degrades with it. "The listener binds the port the group opens" is checkable by comparing two
numbers. "The listeners bind the ports the group opens" is a set comparison, and a set
comparison that is wrong in one element still looks broadly right in a review.

So the abstraction that removed one silent failure makes the standard fix for a second one more
expensive. That is a real cost of the ADR-0018 design, and it belongs on the record rather than
being discovered by whoever wants the redirect.

## Decision

**Port 80 stays shut when a certificate is present.** One listener on the external balancer,
one port, one rule. No redirect.

Three things make this the right side of the trade here, and none of them is "it was simpler":

The default mode of this repository is HTTP on 80. Someone who clones it and deploys gets a
balancer that answers `http://` perfectly well. The timeout only exists in the opt-in mode,
which is entered by someone who supplied a certificate ARN and therefore knows the scheme
changed.

A redirect is one item from a bundle. Anyone deploying the HTTPS mode for real wants the
redirect **and** a Route 53 record, HSTS, and a domain that is not an ELB hostname. Shipping the
redirect alone is the least useful third of that, at the cost of the guarantee above.

Closed is the stricter reading. A port that is not open cannot be misconfigured, cannot be
reached, and does not have to appear in the trust chain.

## Consequences

**Easier.** `publicPort()` stays a number, and the assertion that the listener and the security
group agree stays a comparison of two values rather than of two sets. The external group keeps
exactly one CIDR rule, which is what
[ADR-0015](0015-reference-security-groups-by-identity.md)'s premise assertion checks.

**Harder.** Nothing in the code. The cost is entirely on the user.

**What it costs, plainly.** In HTTPS mode, `http://` times out. No 301, no connection refused,
no error page — a hang, which is the least informative failure a network can produce. This
record and the comment on the listener are the only things that explain it, and neither is
visible to whoever is typing the URL.

That is a genuinely worse user experience than a redirect, and calling it "stricter" does not
make it pleasant. It is accepted because the audience for the HTTPS mode is the person who
configured it, not the public.

**The guard.** One assertion, in both halves. Exactly one listener exists on the external
balancer, and its port is 443. And across every security group, the complete set of CIDR rule
ports is `[443]` — not "contains 443", which would pass with 80 open alongside it.

The second half is what makes this a decision rather than a comment. Adding a redirect listener
turns the suite red, so the person adding it has to come here, read the tension, and change this
record on purpose.

**When this is revisited.** When a domain enters the repository — the same trigger as
[ADR-0018](0018-the-certificate-is-optional.md)'s. At that point the redirect, the Route 53
record and HSTS arrive together, `publicPort()` becomes `publicPorts()`, and the assertion
becomes a set comparison with this record explaining what was given up to get there.
