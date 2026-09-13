import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * The ports the trust chain uses.
 *
 * These live here rather than in `lib/config.ts` on purpose. That module holds what outlives a
 * single stack — the address plan stays true when every construct here has been rewritten
 * (docs/adr/0005-framework-free-configuration-module.md). A port does not: it is a fact about
 * this module's application, and layer 3 may change one when the listeners become real. Values
 * with different lifetimes should not share a home.
 *
 * `internal` is the one a later layer can invalidate. If layer 3 decides on TLS between the
 * frontend and the internal balancer this becomes 443 and nothing else changes, which is the
 * whole reason it is a name and not an `80` typed into a rule.
 */
export const PORTS = {
  /** TLS terminates at the external balancer. */
  public: 443,
  frontend: 8080,
  /** Plaintext inside the VPC, for now. See docs/plans/module1-layer2-security-groups.md §7. */
  internal: 80,
  backend: 8080,
  ssh: 22,
} as const;

export interface SecurityGroupsProps {
  /** The VPC these groups belong to. A security group cannot outlive or leave its VPC. */
  readonly vpc: ec2.IVpc;
}

/**
 * Module 1, layer 2 — the trust chain.
 *
 * Five security groups where each one names the previous **by identity** rather than by
 * address. A rule can name a CIDR block or another security group; naming a CIDR breaks when an
 * instance moves and means nothing when two tiers share a subnet, while naming a group
 * describes the architecture instead of the addressing and stays true from two instances to
 * two hundred.
 *
 *       internet --443--> externalAlb      the only group that accepts a CIDR
 *                              |
 *                            8080
 *                              v
 *                          frontend <--22-- eice
 *                              |
 *                             80
 *                              v
 *                         internalAlb
 *                              |
 *                            8080
 *                              v
 *                           backend <--22-- eice
 *
 * See docs/adr/0015-reference-security-groups-by-identity.md and
 * docs/adr/0016-ingress-only-while-egress-stays-open.md.
 */
export class SecurityGroups extends Construct {
  /** Faces the internet. Layer 3 attaches the external load balancer to it. */
  public readonly externalAlb: ec2.SecurityGroup;

  /** The web tier. Reached by the external balancer, reaches the internal one. */
  public readonly frontend: ec2.SecurityGroup;

  /** Faces the frontend only. Never reachable from outside the VPC. */
  public readonly internalAlb: ec2.SecurityGroup;

  /** The application tier. Reached only through the internal balancer. */
  public readonly backend: ec2.SecurityGroup;

  /**
   * The EC2 Instance Connect Endpoint. It accepts nothing — it exists to be a *source* on the
   * two SSH rules below, so administrative access is a named identity rather than a bastion
   * host with a public address.
   */
  public readonly eice: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
    super(scope, id);

    const { vpc } = props;

    /**
     * `allowAllOutbound: true` is the CDK default, restated on every group below under the same
     * narrow rule as docs/adr/0009-declare-dns-support-explicitly.md: a default may be written
     * out when it is load-bearing for something outside the file that sets it.
     *
     * Setting it to `false` breaks two things without an error message. Instances reach Systems
     * Manager over HTTPS, so a session simply never establishes. And package installs during
     * user data hang, which is the same failure layer 1 documented for `PRIVATE_ISOLATED`.
     *
     * Narrowing egress is a real goal and it waits for module 4, where the interface endpoints
     * exist to make a narrow rule survivable. Until then this value is a decision, not an
     * oversight — see docs/adr/0016-ingress-only-while-egress-stays-open.md.
     */
    const allowAllOutbound = true;

    // Phase 1 — five empty groups.
    //
    // This is not a workaround for a dependency cycle, which is what the shape suggests.
    // `SecurityGroupProps` carries no ingress or egress properties at all, so rules can only be
    // added after construction, and the CDK emits every group-to-group rule as a standalone
    // `AWS::EC2::SecurityGroupIngress` resource rather than inlining it — precisely so two
    // groups can name each other without depending on each other.

    this.externalAlb = new ec2.SecurityGroup(this, 'ExternalAlb', {
      vpc,
      allowAllOutbound,
      description: 'External load balancer: the only group reachable from the internet',
    });

    this.frontend = new ec2.SecurityGroup(this, 'Frontend', {
      vpc,
      allowAllOutbound,
      description: 'Web tier: reached by the external load balancer',
    });

    this.internalAlb = new ec2.SecurityGroup(this, 'InternalAlb', {
      vpc,
      allowAllOutbound,
      description: 'Internal load balancer: reached by the web tier',
    });

    this.backend = new ec2.SecurityGroup(this, 'Backend', {
      vpc,
      allowAllOutbound,
      description: 'Application tier: reached by the internal load balancer',
    });

    this.eice = new ec2.SecurityGroup(this, 'Eice', {
      vpc,
      allowAllOutbound,
      description: 'EC2 Instance Connect Endpoint: a source for SSH, accepts nothing itself',
    });

    // Phase 2 — the chain, in one block.
    //
    // The six rules stay together because the chain is a single decision. Spread across the
    // file next to the group each one touches, it becomes six local facts and stops being
    // readable as a policy.
    //
    // Every rule is an *ingress* rule, and that is forced rather than chosen. With
    // `allowAllOutbound` true, `addEgressRule` is silently discarded: zero resources are
    // emitted, synthesis succeeds, and the rule sits in the source looking effective. A test
    // asserts the stack synthesizes with no warning annotations, which is the only way that
    // trap can be caught.

    this.externalAlb.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(PORTS.public),
      'The internet, on HTTPS only',
    );

    this.frontend.addIngressRule(
      this.externalAlb,
      ec2.Port.tcp(PORTS.frontend),
      'The external load balancer',
    );

    this.frontend.addIngressRule(this.eice, ec2.Port.tcp(PORTS.ssh), 'Instance Connect');

    this.internalAlb.addIngressRule(this.frontend, ec2.Port.tcp(PORTS.internal), 'The web tier');

    /**
     * The rule that looks wrong and is not: the backend trusts the **balancer**, not the tier
     * in front of it.
     *
     * The frontend never opens a connection to the backend. It opens one to the internal load
     * balancer, which opens its own, so a packet arriving here comes from a balancer node and a
     * rule naming `frontend` would match nothing.
     *
     * Health checks make that expensive rather than merely wrong. A balancer polls every target
     * every few seconds, and those probes leave from its own network interfaces carrying this
     * group. A backend trusting only the frontend fails every probe, every target is marked
     * unhealthy, the balancer has nothing to route to — and no error anywhere names a security
     * group.
     */
    this.backend.addIngressRule(
      this.internalAlb,
      ec2.Port.tcp(PORTS.backend),
      'The internal load balancer, including its health checks',
    );

    this.backend.addIngressRule(this.eice, ec2.Port.tcp(PORTS.ssh), 'Instance Connect');
  }
}
