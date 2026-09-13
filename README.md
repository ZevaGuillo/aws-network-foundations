# AWS Network Foundations

AWS networking built with the CDK, one module at a time, where every non-default value carries
the reason it was chosen and the cost of getting it wrong.

The code is the smaller half of this repository. Five modules grow into each other, and the
decisions connecting them are recorded in [`docs/adr/`](docs/adr/README.md) — including the
ones that must be made before the first VPC exists, because they cannot be changed afterwards.

## Status

| Module | Scope | State |
|---|---|---|
| 1 | Base network — VPC, subnets, NAT, S3 gateway endpoint | **Layer 1 built** |
| 2 | — | Not started |
| 3 | VPC peering across three VPCs, proving it is not transitive | Address range reserved |
| 4 | PrivateLink between VPCs that cannot be peered | Address range reserved |
| 5 | — | Not started |

Modules 2 and 5 are counted in [ADR-0003](docs/adr/0003-repo-wide-ipv4-addressing-plan.md) but
not yet specified.

## Prerequisites

- **Node.js 22** or later
- **An AWS account with working credentials.** `aws sts get-caller-identity` must return an
  identity and `aws configure get region` must return a region.

Both are enforced rather than assumed. `npm install` refuses on anything below Node 22 —
`engines` plus `engine-strict` in `.npmrc`, [ADR-0013](docs/adr/0013-refuse-to-install-on-an-unsupported-node-version.md)
— because types describing a newer runtime than the one you are running let `tsc` accept code
that fails at execution.

There is no `.env` file to create, and adding one would be a mistake. The CDK is a build-time
synthesizer, not a running application: credentials come from the AWS credential chain
(`~/.aws/credentials`, `~/.aws/config`, environment variables, SSO), which is machine-level and
shared across projects. `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` are injected by the CDK
CLI from those credentials — they are not variables you export.

> **This app refuses to synthesize without credentials**, by design. An environment-agnostic
> stack resolves availability zones to an `Fn::GetAZs` placeholder, which would make
> `maxAzs: 2` a count rather than two known zones. The error names the missing variable. See
> [ADR-0010](docs/adr/0010-resolve-the-deployment-environment-from-the-cli.md).

## Quick start

```bash
npm install
npm test                 # 13 assertions, no AWS account touched
npx cdk synth            # renders the CloudFormation template into cdk.out/
```

Reading `cdk.out/Net-M1.template.json` after a synth is the fastest way to
understand what the CDK actually does: roughly 140 lines of TypeScript become roughly 400 lines
of CloudFormation.

To deploy, first bootstrap the account and region once — this creates the S3 bucket and IAM
roles the CDK needs to stage assets:

```bash
npx cdk bootstrap
npx cdk deploy
```

## Cost

> **A deployed NAT Gateway costs about $32/month whether or not any traffic passes through it**
> — $0.045/hour to exist, plus $0.045/GB processed. It is billed by the hour from creation.

```bash
npx cdk destroy
```

After destroying, check **EC2 → Elastic IPs** in the console. An unassociated Elastic IP is
also billed, and orphaned addresses are the most common surprise on a teardown.

The default here is one NAT Gateway rather than the CDK's one-per-availability-zone, which
turns `new ec2.Vpc(this, 'Vpc')` into roughly $96/month from a line containing no numbers at
all. What that default gives up is in
[ADR-0006](docs/adr/0006-single-nat-gateway-by-default.md); it is a real trade, not a free
saving.

Everything else in module 1 is free: the VPC, subnets, route tables, internet gateway and the
S3 gateway endpoint carry no hourly charge.

## What gets deployed

| Resource | Count | Detail |
|---|---|---|
| `AWS::EC2::VPC` | 1 | `10.0.0.0/16`, DNS hostnames and support both enabled |
| `AWS::EC2::Subnet` | 4 | `10.0.0.0/24` and `10.0.1.0/24` public, `10.0.2.0/24` and `10.0.3.0/24` private with egress — none auto-assign a public IPv4 address |
| `AWS::EC2::NatGateway` | 1 | configurable; two when the stack property is set to 2 |
| `AWS::EC2::EIP` | 1 | one address to reclaim after teardown |
| `AWS::EC2::InternetGateway` | 1 | |
| `AWS::EC2::RouteTable` | 4 | one per subnet |
| `AWS::EC2::VPCEndpoint` | 1 | `Gateway` type, S3 — free, and keeps S3 traffic off the NAT |

## Address plan

Fixed for the whole repository before the first VPC was created. A VPC's primary range cannot
be changed after creation, so a peering module that discovers the problem later has no remedy
except destroying a VPC and everything inside it. The second octet identifies the owning
module.

| Module | VPC | CIDR |
|---|---|---|
| 1 | base network | `10.0.0.0/16` |
| 3 | VPC A | `10.1.0.0/16` |
| 3 | VPC B | `10.2.0.0/16` |
| 3 | VPC C — proves peering is not transitive | `10.3.0.0/16` |
| 4 | consumer — **intentionally overlapping** | `10.1.0.0/16` |

That last row is not a mistake. Module 4's consumer reuses module 3's VPC A range byte for byte
so the repository holds one pair of VPCs where peering is structurally impossible and
PrivateLink is indifferent — the endpoint lives inside the consumer's own subnet and needs no
route between the ranges. Separating them would delete the experiment without breaking a single
deployment, so a test asserts the collision still holds.
[ADR-0004](docs/adr/0004-intentional-cidr-overlap.md).

## Layout

```
bin/app.ts    app entry point — resolves the account and region, names the stack
lib/
  config.ts       the address plan, importing nothing from the CDK
  environment.ts  account and region resolution, with a guard
  module1-base-network-stack.ts  the VPC: subnets, NAT, S3 gateway endpoint
test/         assertions against the synthesized template
docs/
  adr/        one record per decision, Nygard format
  plans/      implementation plans, kept current as work lands
```

`lib/config.ts` imports no CDK code on purpose. The address plan is the most stable fact here —
it outlives the constructs and the framework version — and a stable module must not depend on a
volatile one. [ADR-0005](docs/adr/0005-framework-free-configuration-module.md).

## Tests

```bash
npm test
```

These assertions do not test the CDK. They guard the decisions that **fail silently**: a NAT
Gateway count that drifts costs money without erroring, a subnet mask cannot be changed after
deployment, and the intentional address overlap can be "corrected" without any stack failing.

The overlap guard was mutation-tested rather than assumed — replacing the reference with a
different literal was confirmed to turn the suite red. A test that cannot fail protects nothing.

They also avoid asserting on framework defaults, which is a subtler failure than not failing.
The public-subnet count once filtered on `MapPublicIpOnLaunch`; turning that attribute off — the
correct setting, [ADR-0012](docs/adr/0012-never-auto-assign-public-ipv4-addresses.md) — dropped
the count to zero and failed a test about a network that had not changed. It follows route
tables to the internet gateway now. A test that blocks a correct change is reporting on itself.

## Commands

| Command | |
|---|---|
| `npm run build` | type-check only — `tsconfig.json` sets `noEmit` |
| `npm run watch` | type-check on change |
| `npm test` | jest assertions against the synthesized template |
| `npx cdk synth` | render the CloudFormation template into `cdk.out/` |
| `npx cdk diff` | compare the deployed stack against local state |
| `npx cdk deploy` | deploy — **starts the NAT Gateway charge** |
| `npx cdk destroy` | tear down |

`cdk.context.json` is generated by context lookups and **is not committed** here, against the
usual advice, because its keys embed the account id and this repository is public. A team
repository should commit it — the reasoning and its cost are in
[ADR-0010](docs/adr/0010-resolve-the-deployment-environment-from-the-cli.md).
