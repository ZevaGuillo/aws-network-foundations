# 0024 — Drop invalid header fields at the edge

**Status:** Accepted
**Date:** 2026-09-14

## Context

`ApplicationLoadBalancerProps.dropInvalidHeaderFields` defaults to `false`, which the CDK
documents plainly: HTTP headers with invalid header fields are "routed to targets" rather than
"removed by the load balancer".

A header containing characters outside what the HTTP specification allows is not a curiosity. It
is the input to request smuggling, where the balancer and the server behind it disagree about
where one header ends and the next begins, and to header injection against whatever parses the
request downstream. The disagreement is the exploit; the balancer forwarding the raw bytes is
what makes the disagreement possible.

Unlike the health check timings and the TLS policy, this default is at least *visible* once you
know the property exists — but the property is absent from the template either way, so a reader
of `Net-M1.template.json` cannot tell whether it was considered. Same outcome, same reason.

## Decision

`dropInvalidHeaderFields: true` on the **external** balancer.

Not on the internal one. That balancer is reached by the web tier and by nothing else — the
trust chain in [ADR-0015](0015-reference-security-groups-by-identity.md) is what guarantees it —
and every request arriving there has already passed through the external balancer, which
sanitised it. Enabling it in both places would be defence in depth against a threat model where
the web tier itself is hostile, and in that scenario a header filter is not what saves the
application tier.

The asymmetry is the decision. Setting it on both would have looked more thorough and said less.

## Consequences

**Easier.** The one balancer exposed to arbitrary input on the internet rejects malformed
headers instead of passing them along, and the choice is visible in the template rather than
inferred from silence.

**Harder.** Nothing structural. One property.

**What it costs.** A client sending a header with characters outside the specification loses it
silently — the request still arrives, without that header. If a later layer's application
depends on a non-conforming header, the symptom is a missing value with no error naming the
balancer. That failure shape is this repository's whole subject, so it is stated here rather
than discovered in layer 4.

**The guard.** One assertion reading the external balancer's
`routing.http.drop_invalid_header_fields.enabled` attribute. It is scheme-specific on purpose:
it names the internet-facing balancer rather than looping over both, so the asymmetry above is
what the test describes and not an accident it tolerates.

**When this is revisited.** If a later module puts something other than the web tier in front of
the internal balancer, the argument for the asymmetry weakens and both balancers get it.
