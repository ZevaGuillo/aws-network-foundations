# 0015 — Reference security groups by identity, never by address

**Status:** Accepted (the external port is parameterized by [0018](0018-the-certificate-is-optional.md))
**Date:** 2026-09-13

## Context

A security group rule names a source. That source can be a CIDR block or another security
group, and the two look interchangeable in the console.

They are not. A CIDR rule is a statement about addressing: `10.0.2.0/24 may reach port 8080`.
It breaks when an instance moves to the other availability zone, it grants more than intended
the moment a second tier shares that subnet, and it has to be rewritten every time the network
is resized. A group rule is a statement about architecture: *whatever wears this badge* may
reach port 8080. It is true at two instances and at two hundred, it survives every reshuffle of
the address plan, and it cannot accidentally include a neighbour.

Module 1 runs four tiers behind two load balancers, plus an EC2 Instance Connect Endpoint for
administrative access. That is five groups, and the question is what each one trusts.

### The edge that is counter-intuitive

The obvious chain has each tier trusting the tier in front of it: the backend trusts the
frontend. It is wrong, and it fails in a way that takes a long afternoon to diagnose.

The frontend never opens a connection to the backend. It opens one to the internal load
balancer, and the balancer opens its own connection onward. A packet arriving at a backend
instance therefore comes from a load balancer node, so a rule naming the frontend's group
matches nothing that will ever arrive.

Health checks make this expensive rather than merely ineffective. A load balancer polls every
registered target every few seconds to decide whether it is alive, and those probes leave from
the balancer's own network interfaces, carrying the balancer's security group. A backend that
trusted only the frontend would fail every probe. Every target would be marked unhealthy, the
balancer would have nothing to route to, and the application would be down — with no error
message anywhere naming a security group, a rule, or a port.

## Decision

Five groups, each naming the previous **by identity**:

```
internet --publicPort--> externalAlb
                              | 8080
                         frontend <--22-- eice
                              | 80
                         internalAlb
                              | 8080
                          backend <--22-- eice
```

Exactly one group accepts a CIDR: `externalAlb`, on `0.0.0.0/0`, because the internet has no
security group to name. Every other rule names a group.

> **Amended by [ADR-0018](0018-the-certificate-is-optional.md), 2026-09-14.** The first arrow
> read `443` when this record was written, and layer 3 made the certificate optional — so the
> port is now 443 with a certificate and 80 without, derived by a single `publicPort()` helper
> that both the listener and this rule call. The chain is unchanged: five groups, six rules,
> one CIDR, every other source named by identity. Only the number on the first arrow moved.

Each tier trusts **its balancer**, not the tier before it.

All six rules are declared at once, in one block, in
[`lib/module1-security-groups.ts`](../../lib/module1-security-groups.ts) — before the balancers
and instances that will wear the groups exist. A rule names a *group*, never the resource
attached to it, so nothing in the chain depends on a later layer. Adding each rule when its
resource appears would make the chain a residue of creation order rather than a policy decided
once and readable in one place.

## Consequences

**Easier.** The rules describe the architecture, so they can be read as the architecture. Layers
3 through 5 attach resources to groups that already say what they are allowed to do, and adding
a hundred instances changes nothing.

**Harder.** The chain must be read as a whole to be understood. `backend` trusting
`internalAlb` looks wrong in isolation, which is why the reasoning sits on that rule in the
code rather than only here.

**What it costs.** Five groups exist before anything wears them. An empty security group is
free and deploys cleanly, but it is five resources in the template that do nothing yet, and a
reader arriving at layer 2 alone sees a policy with no subjects.

**The guard.** Four assertions in `test/module1-security-groups.test.ts` hold this shape: that
exactly one group accepts an address, that the wiring runs balancer-to-tier in the order above,
that there are six rules, and that the endpoint is a source and never a destination. All four
were mutation-tested — pointing the backend at the frontend, dropping a rule, and letting the
internal balancer accept a CIDR each turn the suite red.

**What this does not decide.** Egress. Every rule here is an ingress rule, for reasons that are
their own record — see [ADR-0016](0016-ingress-only-while-egress-stays-open.md).
