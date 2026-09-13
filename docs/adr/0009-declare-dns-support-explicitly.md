# 0009 — Declare DNS support explicitly

**Status:** Accepted
**Date:** 2026-09-13

## Context

A VPC has two DNS attributes: `enableDnsSupport`, which provides the VPC-resolver, and
`enableDnsHostnames`, which assigns DNS names to instances. The CDK sets both to `true` by
default, so a VPC created with no mention of either already has what it needs.

Nothing in the base network visibly depends on them. No construct here fails without them.
That is precisely what makes them dangerous: they look like inert defaults, and inert defaults
get switched off by someone tightening configuration who has no way to know what depends on
them.

Something does. **Private DNS on VPC interface endpoints requires both attributes enabled.**
That mechanism is what allows an endpoint to take over a service's normal DNS name inside the
VPC, so existing clients reach it privately without being reconfigured. It is the entire
premise of the private-connectivity module. With either attribute off, the endpoint is created
successfully and the name resolution silently does not happen — the failure appears as traffic
still going out over the public path, several modules away from the cause.

They also make instance hostnames resolve inside the VPC, which matters as soon as anything
addresses another instance by name.

## Decision

Set `enableDnsSupport` and `enableDnsHostnames` to `true` explicitly, even though both already
default to `true`.

## Consequences

**No behavioural change whatsoever.** The synthesized template is identical either way. This is
documentation-as-code: the two lines record that these values are a requirement the project
depends on, not an accident of a framework default that happens to be convenient.

**Easier.** Anyone reviewing the network for tightening sees them stated, finds the comment at
the point of use, and learns what breaks before they change it. A default cannot defend
itself; a declared value with a reason can.

**The cost.** Two lines a reader may mistake for redundancy. The comment beside them answers
that directly, and this record holds the longer version.

**Tension with a general rule.** "Do not restate defaults" is usually good advice — it keeps
configuration honest about what was actually chosen. The exception applies when a default is
load-bearing for something outside the file that sets it. That is the case here, and it is the
only justification accepted for restating a default in this repository.
