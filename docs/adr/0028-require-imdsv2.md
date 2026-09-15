# 0028 — Require IMDSv2, and nothing but Session Manager in the instance role

**Status:** Accepted
**Date:** 2026-09-14

## Context

An EC2 instance with a role gets temporary credentials, and those credentials are fetched from
the instance metadata service at `169.254.169.254`. Two decisions govern how exposed that is: how
the metadata service can be reached, and what the credentials are worth once reached.

### The metadata service

`LaunchTemplateProps.requireImdsv2` defaults to **`false`** — verified in the CDK types for
`aws-cdk-lib` 2.269.0. Left alone, the instance answers IMDSv1: an unauthenticated `GET` to a
fixed link-local address that returns the role's credentials.

That is the classic server-side request forgery escalation. An application bug that can be talked
into fetching an attacker-supplied URL — an image proxy, a webhook validator, a URL preview —
fetches `http://169.254.169.254/latest/meta-data/iam/security-credentials/` instead, and the
response is a working set of AWS credentials. No code execution required.

IMDSv2 closes it by requiring a `PUT` to obtain a token before any `GET`. An SSRF primitive that
can only issue `GET` requests cannot complete the handshake.

`httpPutResponseHopLimit` already defaults to **1**, which is the correct value and worth
knowing rather than discovering. It stops the metadata response from crossing a network hop,
which is what contains the same attack when it originates inside a container on the instance.

### The role

The second decision limits the damage if the first one is ever bypassed. This module's
application reads no AWS API — it answers HTTP and, on the frontend, calls another HTTP endpoint.
It needs no AWS permissions at all.

But the instances need to be reachable for administration, and this repository's administrative
path is Session Manager rather than a bastion host with a public address. That needs exactly one
managed policy.

## Decision

`requireImdsv2: true` on both launch templates, written out because the default is `false` and
the consequence of the default is invisible.

`AmazonSSMManagedInstanceCore` on the instance role, and **no other policy**. Not a broader SSM
policy, not S3 read access "in case the application needs it later", not CloudWatch Logs.

`httpPutResponseHopLimit` is left at its default of 1, and is *not* restated. It already holds
the right value, and [ADR-0009](0009-declare-dns-support-explicitly.md)'s narrow exception for
writing out a default does not apply: nothing outside the launch template depends on it, so
restating it would be noise. It is recorded here instead, which is the correct place for
"the default is right and here is why nobody should change it".

## Consequences

**Easier.** The most common cloud credential-theft path is closed at the instance rather than
patched in the application, and the credentials it would yield open one door that leads to
Session Manager and nowhere else.

**Harder.** Any tooling that still speaks IMDSv1 breaks. In practice that means very old SDK
versions and hand-rolled `curl` calls in boot scripts — neither of which exists here, and both of
which should be fixed rather than accommodated.

**What it costs.** The role is now something to maintain. The first time a later layer needs the
application to touch an AWS API, the policy has to be widened deliberately, which is slower than
having started broad. That slowness is the feature: a role that grows quietly is a role nobody
audits, and `AmazonSSMManagedInstanceCore` is itself already an AWS-managed policy whose contents
AWS can change without asking.

**Session Manager is not a convenience here.** [ADR-0027](0027-user-data-terminates-systemd-owns-the-process.md)
lists where boot failures surface — `/var/log/cloud-init-output.log`, `journalctl -u app`,
`cloud-init analyze blame` — and none of them is reachable from the console. Without this policy
a tier that boots and serves nothing is a tier that cannot be diagnosed at all, because the
instance is in a private subnet with no public address by
[ADR-0012](0012-never-auto-assign-public-ipv4-addresses.md).

**The guard.** Two assertions. That both launch templates set
`MetadataOptions.HttpTokens: required`, which catches a silent revert to IMDSv1 — nothing fails
when that happens, the instance simply becomes easier to rob. And that the instance role carries
`AmazonSSMManagedInstanceCore` and no other managed policy, asserted as an exact list rather than
a containment check, so a policy added "temporarily" turns the suite red.

**When this is revisited.** When an application in a later module legitimately needs an AWS API.
The role widens then, by name, with the reason attached — not before.
