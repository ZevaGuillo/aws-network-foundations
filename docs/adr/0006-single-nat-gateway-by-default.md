# 0006 — One NAT Gateway by default, parameterizable per deployment

**Status:** Accepted
**Date:** 2026-09-13
**Prices:** US East (N. Virginia), list, as of this date.

## Context

Private subnets need outbound internet access: instances install packages at boot. That
egress goes through a NAT Gateway, and the NAT Gateway is the most expensive thing in this
module by a wide margin.

A NAT Gateway costs **$0.045/hour just to exist** — about **$32/month** — before a single byte
moves, plus **$0.045/GB** of data processed.

The CDK's default is one NAT Gateway per availability zone, and its default AZ count is three.
So `new ec2.Vpc(this, 'Vpc')` — a construct call with no arguments and nothing to review —
provisions three NAT Gateways at roughly **$96/month**. There is no number anywhere in that
line of code. This is the single easiest way to run up an unexpected bill in CDK, and it
happens by writing less code, not more.

The operating model here matters: this infrastructure is deployed to be measured and destroyed
the same day. It is not left running.

## Decision

Pin the NAT Gateway count explicitly. Default to **one**. Expose it as a typed stack property
so a deployment can raise it without editing configuration.

The default lives in `lib/config.ts`; the property overrides it. One default, one place.

## Consequences

**What one NAT Gateway gives up — both of these are real:**

- **Availability-zone fault isolation for egress.** The NAT sits in one AZ. If that AZ fails,
  the private subnet in the *healthy* AZ also loses outbound internet, because its route still
  points at a gateway that is gone. A two-AZ deployment with one NAT is not two-AZ for egress.
- **Free intra-AZ egress.** Traffic originating in the AZ without the NAT crosses zones to
  reach it, adding **$0.01/GB in each direction** on top of the NAT's own $0.045/GB processing
  charge. Past a certain volume the single "cheap" NAT is the more expensive arrangement. The
  crossover depends entirely on traffic, which is why the count is a property and not a
  constant.

**What it keeps.** About $32/month instead of $64, and one Elastic IP to verify after teardown
instead of two.

**The rule this does not change.** Production traffic gets one NAT Gateway per AZ. The default
here is tuned to a stack that lives for hours, and the code says so at the point of use.

**Rejected — two by default.** Correct for production, wrong as the default for infrastructure
whose normal lifetime is a single afternoon. The property makes it one argument away.

**Rejected — CDK context (`cdk deploy -c natGateways=2`).** Avoids a code edit, but gives up
type checking and moves a value that costs money outside of code review. A typed property is
simpler and safer.
