# 0012 — Never auto-assign public IPv4 addresses

**Status:** Accepted
**Date:** 2026-09-13

## Context

A subnet carries an attribute, `mapPublicIpOnLaunch`, that decides whether a network interface
created in it receives a public IPv4 address automatically. The CDK sets it to `true` on every
`PUBLIC` subnet and `false` everywhere else, so the base network as first written would hand a
public address to anything launched in a public subnet without any code requesting one.

Nothing in this architecture wants that. Every compute tier planned for this repository lives
in a private subnet and reaches the internet through the NAT Gateway. The two things that do
belong in a public subnet do not need the attribute either: a NAT Gateway carries its own
Elastic IP, and an application load balancer is reached through its own DNS name, with public
addresses managed by the service.

So today the value changes nothing at all — which is exactly the condition under which it is
worth setting, because the failure it prevents is one that produces no error. A compute tier
placed in the wrong subnet group is an ordinary mistake: a `subnetType` left at its default, a
`vpcSubnets` selection copied from an example. With auto-assign on, that instance comes up
reachable from the internet and everything reports healthy. With it off, the instance comes up
with no public address and the mistake surfaces as something not working, which is the failure
mode worth having.

There is a cost to state honestly, because the setting is easy to over-read. **This is not
isolation.** The subnet still has a route to the internet gateway. An instance launched there
with `associatePublicIpAddress: true` in its launch template, or with an Elastic IP attached
explicitly, is still directly addressable. The attribute removes the default, not the
capability. What closes the path is the security group, and that belongs to a later layer.

## Decision

Set `mapPublicIpOnLaunch: false` on the public subnet configuration.

Assert in the test suite that **no** subnet in the template auto-assigns, rather than that the
public ones do not — the property is `false` on all four, and the assertion should hold for the
whole network rather than for a group whose membership the test would then have to determine.

## Consequences

**Easier.** A whole class of silent exposure stops being reachable by accident. Getting a
public address now requires asking for one, which puts it in a diff.

**Harder.** Anything genuinely needing a public address in a public subnet — a bastion host
built the old way, a one-off debugging instance — must attach an Elastic IP or set
`associatePublicIpAddress` on its launch template. Deliberate, and visible in code.

**What it costs.** One line and the misreading it invites. A reader may take it for isolation
and skip the security group that actually provides it. The comment at the point of use and the
paragraph above both say so directly.

**A test had to change first.** The existing assertion identified public subnets by filtering
on `MapPublicIpOnLaunch`, so this setting turned the count of public subnets to zero and failed
a test whose subject — four /24 subnets, two of each kind — was still perfectly true. That test
was reading a CDK default instead of a decision, and was rewritten to follow route tables to
the internet gateway and the NAT Gateway instead. A test that blocks a correct change is
reporting on itself, not on the code.
