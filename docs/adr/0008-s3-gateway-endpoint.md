# 0008 — Put the S3 gateway endpoint in the base network

**Status:** Accepted
**Date:** 2026-09-13
**Prices:** US East (N. Virginia), list, as of this date.

## Context

An instance in a private subnet that talks to S3 sends that traffic out through the NAT
Gateway, because S3 is reached over a public endpoint and the private subnet's default route
points at the NAT. Every byte is billed at **$0.045/GB** of NAT data processing — outbound and
inbound alike.

This is invisible in the architecture. Nothing in a diagram shows that an object upload is
paying a NAT toll, and S3 traffic is exactly the kind that arrives in bulk: backups, logs,
artifacts, datasets.

A gateway endpoint removes it. It adds a route to the subnet's route table that sends S3 and
DynamoDB traffic to the AWS network directly, bypassing the NAT entirely. It costs nothing —
**no hourly charge and no per-GB charge.** It is one of very few AWS features that is free in
the literal sense.

Leaving it out is a default, not a decision. Putting it in is the decision.

## Decision

Create an S3 gateway endpoint as part of the base network, from the first deployment.

## Consequences

**What it saves, concretely:**

| Traffic to S3 | Through the NAT Gateway | Through the gateway endpoint |
|---|---|---|
| 100 GB | $4.50 | $0.00 |
| 1 TB | ~$46 | $0.00 |

**The caveat that belongs next to those numbers.** The endpoint removes the *data processing*
charge, not the NAT Gateway's ~$32/month *existence* charge from
[0006](0006-single-nat-gateway-by-default.md). The NAT is still required for everything that
is not S3 or DynamoDB: package installs at boot, OS updates, third-party API calls. The
endpoint narrows what flows through the NAT; it does not remove the NAT.

**Easier.** S3 traffic stops leaving the VPC's network path, which is better for cost and for
the security posture both — it never traverses a public route.

**Harder.** A gateway endpoint attaches to route tables, so it applies per-subnet rather than
per-VPC. New subnets need to be associated with it. The CDK handles this for subnets it
creates; anything added by hand does not get it automatically.

**Opens.** An endpoint accepts a policy, which is the basis for a later demonstration:
restricting the endpoint to a single bucket and observing the resulting `AccessDenied`. That
work belongs to module 4; the endpoint being here is what makes it reachable.
