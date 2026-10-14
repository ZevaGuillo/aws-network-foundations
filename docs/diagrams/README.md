# Diagrams

Four figures, each drawn because it shows a mechanism the prose has to assemble from sentences.

| File | What it shows | Referenced from |
|---|---|---|
| [`module1-topology.svg`](module1-topology.svg) | Where every module 1 resource sits: two zones, four `/24` subnets, the single NAT gateway, both balancers, both tiers | [layer 1 plan](../plans/module1-layer1-base-network.md) |
| [`module1-security-group-chain.svg`](module1-security-group-chain.svg) | The four allow hops, and what each rule names as its **source** — never a CIDR | [layer 2 plan](../plans/module1-layer2-security-groups.md) |
| [`module2-nacl-boundary.svg`](module2-nacl-boundary.svg) | Before and after `cdk deploy Net-M2`: which two of the four subnets changed owner | [module 2 plan](../plans/module2-network-acls-flow-logs.md) |
| [`module2-direction-flip.svg`](module2-direction-flip.svg) | E1 drops the SYN on ingress; E2 drops the SYN-ACK on egress. Same endpoints, opposite directions | [module 2 plan](../plans/module2-network-acls-flow-logs.md) |

## These can drift, and nothing stops them

Every other claim in this repository is held by something: a value by a test, a number in
[`module2/evidence.md`](../../module2/evidence.md) by the command that printed it, a decision by an
ADR. **These four files are held by nobody.** They are hand-authored SVG, not generated from
`cdk.out`, so a change to the topology leaves them silently wrong — a clean `cdk synth`, a green
suite, and a diagram that describes a network that no longer exists.

That was a deliberate trade. A generated diagram cannot drift, but it draws all 51 resources
including `CDKMetadata` and teaches nothing about which control governs what; these four were
drawn to answer one question each. The alternative stays open: Graphviz plus
`cdk-graph-plugin-diagram` over `cdk.out` would produce inventory diagrams with the official AWS
icon set, regenerable in CI.

So when any of the following changes, open these files:

| Change | Figures to re-check |
|---|---|
| `MODULE_1_NETWORK` — `azCount`, `subnetCidrMask`, `natGateways`, `vpcCidr` | topology |
| A subnet group gained, lost or renamed | topology, NACL boundary |
| `PORTS` or `publicPort()` | security-group chain, direction flip |
| A security group rule added, removed or re-sourced | security-group chain |
| `MODULE_2_NACL` bands or slots | NACL boundary, direction flip |
| Flow-log destination or retention | NACL boundary |

## What the icons are, and are not

The glyphs are inline SVG drawn against AWS's visual language — the architecture category hues
(networking `#8C4FFF`, compute `#ED7100`, storage `#7AA116`, management `#E7157B`, network ACL
`#DD344C`) and the green/teal AWS uses for public and private subnets.

**They are not the official AWS Architecture Icons.** Nothing here is copied from that asset
package, and no file in this directory loads anything external — each SVG is self-contained, which
is what lets GitHub render it.

## Why the colors are written twice

Each file carries its light palette as presentation attributes and overrides it for dark through a
`@media (prefers-color-scheme: dark)` block in an internal `<style>`.

Both halves are load-bearing. Rendered as an image — which is how a markdown `![]()` reference
renders them — an SVG inherits nothing from the page: no `currentColor`, no CSS variables. And if a
sanitizer drops the `<style>`, the attributes still render the full light diagram rather than
collapsing to black-on-black. Verified in both schemes before committing.
