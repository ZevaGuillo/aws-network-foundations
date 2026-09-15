# 0026 — The application contract: no dependencies, bind `0.0.0.0`, obey the target group's port

**Status:** Accepted — amended by [0031](0031-one-runtime-node.md)
**Date:** 2026-09-14

## Context

[ADR-0019](0019-shallow-health-check-at-the-balancer.md) established an inversion: the target
group states the contract and the application obeys it, rather than the application having a
health endpoint that something is later pointed at. Layer 3 wrote the target groups. This record
is the rest of that contract, and each clause exists because breaking it fails silently.

### The port

Both target groups poll 8080 — `PORTS.frontend` and `PORTS.backend` — and both security groups
permit 8080 and nothing else. An application listening on 3000 or 80 is unreachable by the
balancer and unreachable by the tier in front of it, and no message from either names a port.

### The bind address

This is the one with the widest gap between cause and symptom in the whole module.

The health check does not originate on the instance. It arrives from the load balancer's network
interface, across the subnet. An application bound to `127.0.0.1` answers `curl localhost:8080`
from an SSH session perfectly, every time, while every probe from the balancer fails and every
target is marked unhealthy.

The cause is one string in one source file. The symptom is a load balancer with no healthy
targets, three resources away, and nothing in the console, the target group's health description
or any log names the bind address. Someone debugging it sees a working application and a balancer
that refuses to admit it.

### The dependencies

Neither application imports anything outside its language's standard library. Python uses
`http.server`; Node uses `http`. That looks like minimalism and it is four decisions:

**It kept [ADR-0025](0025-the-runtime-is-a-deployment-property.md) honest.** With dependencies,
the Node column would have measured `dnf install nodejs` *plus* `npm install`, and a comparison
claiming to be about runtimes would actually have been about package managers.

> **Amended by [ADR-0031](0031-one-runtime-node.md), 2026-09-14.** This reason no longer applies
> — there is no comparison left to keep honest. The other three below do, and the last one
> applies harder than it did: a boot that already pays for one unavoidable download should not
> also pay for a package install.
>
> **The three clauses of this contract are unchanged.** What is stale is the arithmetic around
> them: this record was written about two applications and there is now one, `lib/app/server.js`.
> Read every "both files" and every `.py` below as that one file. The bind-address assertion, the
> port assertion and the standard library assertion all still exist and still guard the same
> three things.

**It fits in user data.** The limit is **16 KB in raw form, before base64 encoding** — verified
against the AWS documentation rather than assumed, because the figure is commonly quoted as the
encoded size, which would be roughly a quarter smaller. Sixty lines of dependency-free HTTP
server is nowhere near it. The same application with a framework is not, and would force
delivery from S3 or a baked AMI onto a layer that has no other reason to want either.

**The CDK will not warn about it.** Verified by reading `aws-cdk-lib/aws-ec2`: there is no length
check anywhere. An oversized script synthesizes cleanly, passes review, and fails at deploy —
which is the same shape of trap as every other one in this repository, so the size limit is a
constraint to design against rather than a limit to discover.

**It keeps instance refresh cheap**, which is a layer 5 concern settled here. A four-minute boot
makes rolling replacement expensive enough that people avoid it, and avoiding it is how a fleet
ends up running old code with every dashboard green. And it removes a boot-time dependency on a
package registry answering.

## Decision

Three clauses, all of them the infrastructure's requirements on the application:

| Clause | Value |
|---|---|
| Listen on | `PORTS.frontend` / `PORTS.backend` — read from the constants, never retyped |
| Bind to | `0.0.0.0`. `127.0.0.1` appears in neither file |
| Import | Standard library only |

And a consequence of the third that is worth stating as a decision in its own right: **S3 is not
used to deliver the application.** An application that did not fit in user data would need it,
and the S3 gateway endpoint from [ADR-0008](0008-s3-gateway-endpoint.md) is sitting there ready
to make the download free. This one fits. Reaching for S3 anyway would be infrastructure added
for a hypothetical, which is the thing this repository's records exist to prevent.

## Consequences

**Easier.** Both applications can be run locally — `python3 lib/app/server.py` — before anything
is deployed. A syntax error is found in a terminal rather than in a private subnet through an
instance that boots fine and serves nothing.

**Harder.** The applications stay trivial by construction. Anything that would make them
interesting — a framework, a database client, templating — breaks the first clause and forces the
delivery question open again. That is a real ceiling on what module 1 can demonstrate.

**What it costs.** `http.server` is explicitly not a production HTTP server; the Python docs say
so. Single-threaded by default, no hardening, not something to put behind a public balancer for
real. In a module whose subject is networking rather than serving, that is acceptable, and saying
it here stops the choice from being read as a recommendation.

**The guard.** Two assertions, and the second is unusual.

The first reads the user data and the application files for the port, asserted against the
`PORTS` constants rather than against a literal, so a drift between the target group and the
application turns the suite red.

The second asserts on the **contents of a source file**: `0.0.0.0` present, `127.0.0.1` absent,
in both applications. Asserting on a source file rather than on a synthesized template is not
this suite's normal shape, and it is the only mechanical way to catch a one-word edit whose
symptom appears three resources away. A test that reads a string out of a `.py` file looks
unserious right up until the afternoon it saves.

**When this is revisited.** When module 1 needs the application to do something. At that point
the dependency clause is what gives, the 16 KB limit becomes binding, and the S3 delivery path —
with the gateway endpoint already in place and an IAM permission to add — is the first thing to
reach for.
