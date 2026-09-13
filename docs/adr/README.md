# Architecture Decision Records

Every non-obvious decision in this repository is recorded here, in order, with the reasoning
and the cost that were visible at the time. The code shows what was built. These show what was
considered, what was rejected, and what each choice gives up.

Records are never deleted. When a decision changes, the old record stays and is marked
`Superseded`, with a pointer forward. The sequence is the history of the project.

## Format

Each record follows the Nygard structure: **Context** (the forces in play), **Decision** (what
was chosen, in the active voice), **Consequences** (what becomes easier, what becomes harder,
and what it costs). Prices are US East (N. Virginia) list prices at the date of the record.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions in ADRs | Accepted | 2026-09-13 |
| [0002](0002-self-contained-repository.md) | The repository is self-contained | Accepted | 2026-09-13 |
| [0003](0003-repo-wide-ipv4-addressing-plan.md) | Fix the IPv4 addressing plan before the first VPC | Accepted | 2026-09-13 |
| [0004](0004-intentional-cidr-overlap.md) | Reserve an intentional CIDR overlap for the PrivateLink experiment | Accepted | 2026-09-13 |
| [0005](0005-framework-free-configuration-module.md) | Keep the configuration module free of CDK types | Accepted | 2026-09-13 |
| [0006](0006-single-nat-gateway-by-default.md) | One NAT Gateway by default, parameterizable per deployment | Accepted | 2026-09-13 |
| [0007](0007-slash-24-subnet-mask.md) | Split the VPC into /24 subnets | Accepted | 2026-09-13 |
| [0008](0008-s3-gateway-endpoint.md) | Put the S3 gateway endpoint in the base network | Accepted | 2026-09-13 |
| [0009](0009-declare-dns-support-explicitly.md) | Declare DNS support explicitly | Accepted | 2026-09-13 |
| [0010](0010-resolve-the-deployment-environment-from-the-cli.md) | Resolve the deployment environment from the CLI, and fail without it | Accepted | 2026-09-13 |
| [0011](0011-name-stacks-by-module-before-the-first-deploy.md) | Name stacks by module, before the first deploy | Accepted (naming scheme superseded by 0014) | 2026-09-13 |
| [0012](0012-never-auto-assign-public-ipv4-addresses.md) | Never auto-assign public IPv4 addresses | Accepted | 2026-09-13 |
| [0013](0013-refuse-to-install-on-an-unsupported-node-version.md) | Refuse to install on an unsupported Node version | Accepted | 2026-09-13 |
| [0014](0014-one-stack-per-module.md) | One stack per module | Accepted | 2026-09-13 |
