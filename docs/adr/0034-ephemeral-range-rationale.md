# 0034 — The ephemeral range serves the NAT gateway and the balancer, not the client

**Status:** Accepted
**Date:** 2026-10-07

## Context

The SAA-C03 lab this repository's module 2 is modeled on opens an ingress `ALLOW tcp
1024-65535` on the premise that it is letting a client's ephemeral reply ports back in — Linux
picks from 32768-60999, Windows from 49152-65535, and the lab's range covers both. That premise
does not hold in this repository's topology, and stating the rule without correcting it would
leave a comment that is wrong about why the rule exists.

Verified against the actual construct graph:

- The compute tier sits in a **private** subnet (`module1-compute.ts`), reached by the internal
  balancer. It never originates a connection that crosses the public NACL directly, and it
  never receives one there either.
- The public NACL sits over the **public** subnets, where two things live: the NAT gateway and
  the external ALB's nodes (`module1-load-balancers.ts:172-179`, `internetFacing: true`).

So this public NACL never sees the private instance's packets. What arrives on 1024-65535 is
the NAT gateway's and the ALB's own ephemeral *source* ports — not the instance's, and not any
internet client's either:

| Path | Egress from the public subnet | Ingress back to the public subnet |
|---|---|---|
| Instance → internet, via NAT | NAT's source port 1024-65535 → destination 443 | destination port = the NAT's own ephemeral port |
| ALB → frontend tier, and health checks | ALB node's source port 1024-65535 → destination 8080 | destination port = the ALB node's own ephemeral port |

A NAT gateway's source-port range is fixed at 1024-65535 by AWS, independent of whatever
operating system the original client is running. That is a second, client-independent argument
for the full range — the Linux/Windows client-port distinction the lab relies on never enters
this path at all, because the client that matters here is AWS's own NAT infrastructure, not
the browser making the original request.

## Decision

Keep the ingress `ALLOW tcp 1024-65535` rule (`AllowEphemeralIn` in
`lib/module2-network-acls.ts`), and state the real reason at the point of use rather than the
lab's reason:

```ts
/**
 * The instance behind this NACL sits in a private subnet (module1-compute.ts) — its own
 * replies never reach this public boundary. What does arrive here, on this exact range, is
 * the NAT gateway's and the external ALB's own ephemeral source ports: the NAT's reply to an
 * instance's outbound HTTPS, and the ALB's own forwarding and health-check connections
 * landing back on the node that opened them. AWS fixes a NAT gateway's source-port range at
 * 1024-65535 independent of any client's operating system.
 */
id: 'AllowEphemeralIn',
traffic: ec2.AclTraffic.tcpPortRange(1024, 65535),
enabled: true,
```

The range is a stated fact about AWS's own NAT implementation, not a tunable derived from
guessing what clients this deployment will see — narrowing it to "what my client's OS uses"
would break in-VPC traffic that no client is involved in at all.

## Consequences

**Easier.** The comment at the rule matches what the rule actually does. A reader checking
whether this range is still correct checks it against the NAT gateway's documented behavior,
not against which operating systems might visit the site.

**Harder.** Nothing changes about the rule itself — this record corrects the stated mechanism,
not the port range.

**What it costs, and the collateral is explicit.** `MODULE_2_NACL`'s `openEphemeralEgress:
false` toggle — built to script the stateless-filter failure
([ADR-0036](0036-scripted-breakage-toggle.md)) — removes the egress
half of this same range, `AllowEphemeralOut`. `PORTS.frontend = 8080` sits inside
1024-65535, so disabling that slot does not only produce the intended REJECT on the
experiment's own probe; it also drops every ALB health check, because the ALB's forwarding
connections to the frontend tier use the same ephemeral range this record documents. The two
REJECT patterns are separable by destination address and cadence, but both are a direct
consequence of the range this ADR describes, and the plan doc names the collateral so it is
read as expected rather than discovered as a surprise mid-experiment.

**What this does not change.** The rule's scope. It still applies only to the public subnets'
own NAT and ALB traffic; it says nothing about the private subnet's security groups, which
remain the actual boundary around the compute tier.
