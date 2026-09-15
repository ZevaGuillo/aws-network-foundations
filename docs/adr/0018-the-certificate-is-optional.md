# 0018 — The certificate is optional, and the public port is one decision

**Status:** Accepted
**Date:** 2026-09-14

## Context

Layer 2 wrote `PORTS.public = 443` as a statement about the architecture: TLS terminates at the
external balancer. Layer 3 has to make that true, and the bill arrives with the listener.

An internet-facing HTTPS listener needs a certificate from AWS Certificate Manager. A
certificate needs a domain name whose DNS you control. Neither is something `cdk deploy` can
create, and this repository's entire premise is that a clean clone plus AWS credentials is
enough ([ADR-0002](0002-self-contained-repository.md)).

Four ways to obtain one, all of them priced before choosing:

| Approach | What it costs |
|---|---|
| Create the certificate in the stack, validated by DNS through a Route 53 hosted zone | A registered domain and a hosted zone become prerequisites. Both cost money, neither is creatable by the deploy, and the README's quick start stops working for anyone who clones the repository |
| Create it in the stack, publish the validation record by hand | The stack sits in `CREATE_IN_PROGRESS` until someone publishes a CNAME, or until ACM's validation window runs out. A deploy that hangs waiting for a human is unusable for infrastructure destroyed daily |
| Accept an ARN from outside — context, SSM, an environment variable | `cdk synth` on a clean clone either fails or silently produces a different template than the author's. This is the self-containment rule, broken directly |
| Generate a self-signed certificate and import it into ACM | Technically works on an ALB listener. Dies on reproducibility: either private key material is committed to the repository, or the deploy depends on a step no reader can run |

There is no option here that is free. The question is which cost this repository should pay.

### The part that is not about the listener

`externalAlbSg` accepts `0.0.0.0/0` on **443 and nothing else**. That was layer 2's decision and
it is a good one.

It also means an HTTP listener on port 80 would be created, would bind, and would receive
nothing at all. The security group drops the packet before the listener exists as far as the
traffic is concerned. Both resources deploy successfully. `cdk synth` is clean, the suite is
green, the console shows a healthy load balancer, and every request times out with no error
anywhere naming a security group or a port.

So the public port is not a listener property that happens to have a matching firewall rule. It
is one decision with two consumers, and the two consumers live in different files and different
layers.

## Decision

**The certificate is optional, and its absence is the default.** The external balancer listens
on plain HTTP unless a certificate ARN is supplied:

```ts
export interface Module1StackProps extends cdk.StackProps {
  readonly natGateways?: number;

  /** ACM certificate ARN. Absent - the default - means the external listener is HTTP on 80. */
  readonly certificateArn?: string;
}
```

This follows [ADR-0006](0006-single-nat-gateway-by-default.md) exactly. A value earns a stack
property when it changes what a given deployment *is*; everything else stays in configuration
where it is reviewed once. The NAT Gateway count qualified because it changes the bill. This
qualifies because it changes whether the repository can be deployed at all by someone who owns
no domain.

**And the public port is derived in exactly one place:**

```ts
export function publicPort(certificateArn?: string): number {
  return certificateArn === undefined ? PORTS.http : PORTS.https;
}
```

Both consumers call it. The listener asks what port to bind; the security group asks what port
to open. A repeated ternary in two files is how those two drift apart, and the drift is the
silent failure above.

`SecurityGroups` gains a required `publicPort` prop rather than reading the certificate itself,
because the trust chain should not know what a certificate is.

## Consequences

**Easier.** `git clone && npm install && npx cdk deploy` works with nothing but AWS credentials,
which is what [ADR-0002](0002-self-contained-repository.md) promised. The HTTPS path is one
property away for anyone who does own a domain, and it is the same code path rather than a
branch maintained separately.

**Harder.** There are now two shapes this stack can take, and both have to be tested. The suite
synthesizes twice — with and without a certificate — rather than once.

**What it costs, and it is a real loss.** The default deployment sends credentials and everything
else over plain HTTP across the public internet. For a demonstration destroyed the same day that
is acceptable; as an example to copy it is not, and the comment at the point of use says so
rather than leaving a reader to infer that HTTP was considered fine.

The second cost is that `PORTS.public` stops existing. Layer 2 wrote a constant that read as a
fact about the architecture, and it becomes a function of a deployment-time input. That is the
truth catching up with the code, not a regression, but the file is less declarative than it was.

**What this does to ADR-0015.** It amends it; it does not supersede it. The chain still has five
groups and six rules, `externalAlb` is still the only group that accepts a CIDR, and every other
rule still names a group by identity. Only the number on the first arrow becomes a variable. The
diagram in that record now reads `publicPort` where it read `443`.

**The guard.** Three assertions, and the third is the one that matters. The listener's port
equals `publicPort(certificateArn)`; the security group's CIDR rule port equals the same call;
and both are asserted **in both modes**, because a conditional that is only ever exercised one
way is an untested branch pretending to be a tested one. Supplying a certificate while leaving
the security group on `PORTS.http` is the mutation that has to turn the suite red, and it is the
exact mistake this record exists to make impossible.

**When this is revisited.** When a domain enters the picture — which is also when the
HTTP-to-HTTPS redirect listener that layer 2 asked about becomes worth building. Until then
there is nothing to redirect to.
