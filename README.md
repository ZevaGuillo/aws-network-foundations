# AWS Network Foundations

AWS networking built with the CDK, one module at a time, where every non-default value carries
the reason it was chosen and the cost of getting it wrong.

The code is the smaller half of this repository. Five modules grow into each other, and the
decisions connecting them are recorded in [`docs/adr/`](docs/adr/README.md) — including the
ones that must be made before the first VPC exists, because they cannot be changed afterwards.

## Status

| Module | Scope | State |
|---|---|---|
| 1 | Base network, the security groups, the balancers, then the application | **Layers 1–4 built** |
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
npm test                 # 48 assertions, no AWS account touched
npx cdk synth            # renders the CloudFormation template into cdk.out/
```

Reading `cdk.out/Net-M1.template.json` after a synth is the fastest way to
understand what the CDK actually does: roughly 250 lines of TypeScript become nearly 1000 lines
of CloudFormation.

To deploy, first bootstrap the account and region once — this creates the S3 bucket and IAM
roles the CDK needs to stage assets:

```bash
npx cdk bootstrap
npx cdk deploy
```

## Cost

> **Module 1 costs roughly $80/month sitting completely idle.** One NAT Gateway at about
> $32/month, two Application Load Balancers at about $33/month for the pair, and two `t3.micro`
> instances at about $15/month for the pair — all billed by the hour from creation, none of them
> needing a single packet to charge you.

```bash
npx cdk destroy
```

After destroying, check **EC2 → Elastic IPs** in the console. An unassociated Elastic IP is
also billed, and orphaned addresses are the most common surprise on a teardown.

Where the money goes, and what each number is a decision about:

| Resource | Cost | Why this many |
|---|---|---|
| NAT Gateway × 1 | ~$32/month, plus $0.045/GB | The CDK's default is one per availability zone, which turns `new ec2.Vpc(this, 'Vpc')` into roughly $96/month from a line containing no numbers at all. What one gives up is a real trade — [ADR-0006](docs/adr/0006-single-nat-gateway-by-default.md) |
| Application Load Balancer × 2 | ~$16.50/month each, plus LCUs | The internal one is half this bill and is not removable: a tier reachable only from inside the VPC is what module 1 exists to demonstrate, and one balancer cannot demonstrate it |
| `t3.micro` × 2 | ~$7.50/month each | One instance per tier. Nothing here is under load, so the smallest thing that runs an HTTP server is the right size |

Everything else in module 1 is free: the VPC, subnets, route tables, internet gateway, security
groups, target groups and the S3 gateway endpoint carry no hourly charge.

Layer 3 roughly doubled this figure and layer 4 added to it, which is the reason the advice above
is not a formality. Deploy it, look at it, destroy it.

## Boot time, and why it is worth measuring

The tiers run Node, which Amazon Linux 2023 does not ship. So every instance installs a runtime
before it can answer a request: `dnf install -y nodejs` on every launch, every scale-out and
every instance refresh, with bytes leaving through the NAT Gateway at $0.045/GB.

That is a real cost with nothing cheaper to fall back to, and it was chosen knowingly —
[ADR-0031](docs/adr/0031-one-runtime-node.md) records what was removed and what removing it cost.
Layer 5 inherits the number directly: a slower boot is a larger `estimatedInstanceWarmup`, which
is a scaling policy that responds later.

| Number | How it is taken |
|---|---|
| Launch to in-service | Poll `aws elbv2 describe-target-health` until the target reports `healthy`, timing from launch. This becomes layer 5's `estimatedInstanceWarmup` |
| Where the time went | `cloud-init analyze blame` over Session Manager, which attributes boot time per module |
| Bytes through the NAT | The NAT Gateway's `BytesOutToDestination` across the boot window |

Not taken yet. It has to be, before layer 5 can estimate anything.

## When something boots and serves nothing

The instances have no public address, so none of this is reachable from the console. Session
Manager is the way in, and the Instance Connect Endpoint is what layer 2's two SSH rules exist
for.

| Symptom | Look at |
|---|---|
| Target never turns healthy, instance is up | `/var/log/cloud-init-output.log` |
| Boot slower than expected | `cloud-init analyze blame` |
| Service not running | `systemctl status module1-app`, `journalctl -u module1-app` |

The boot script fails without the instance failing. It boots, SSH works, and only the service is
missing — which is why [ADR-0027](docs/adr/0027-user-data-terminates-systemd-owns-the-process.md)
names these three rather than leaving them to be found.

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
| `AWS::EC2::SecurityGroup` | 5 | the trust chain — only the external balancer accepts an address |
| `AWS::EC2::SecurityGroupIngress` | 5 | the group-to-group rules; the sixth is inlined on the external balancer |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` | 2 | one internet-facing in the public subnets, one internal in the private ones |
| `AWS::ElasticLoadBalancingV2::Listener` | 2 | neither opens its own security group ([ADR-0021](docs/adr/0021-listeners-never-open-their-own-security-group.md)); the public one pins TLS 1.2 as its floor ([ADR-0022](docs/adr/0022-pin-the-tls-policy.md)) |
| `AWS::ElasticLoadBalancingV2::TargetGroup` | 2 | one instance each; every health check timing written out, none inherited |
| `AWS::EC2::LaunchTemplate` | 2 | IMDSv2 required, which is not the CDK default |
| `AWS::EC2::Instance` | 2 | one per tier, launched from the templates above; layer 5 replaces them with auto scaling groups |
| `AWS::EC2::InstanceConnectEndpoint` | 1 | the only way into a private subnet, and it does not preserve the client IP |
| `AWS::IAM::Role` | 1 | Session Manager and nothing else |

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
  module1-stack.ts           the whole module: one stack, every layer
  module1-security-groups.ts the trust chain: five groups, six rules
  module1-load-balancers.ts  two balancers, two listeners, two target groups
  module1-compute.ts         launch templates, the instance role, the way in
  app/
    server.js   the application - a real file, runnable locally
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
