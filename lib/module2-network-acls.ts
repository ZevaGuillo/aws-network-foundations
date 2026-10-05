import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Denies occupy 10-99, allows 100 upward in steps of 10. `max(DENY_BAND) = 99 < 100 =
 * min(ALLOW_BAND)` holds by arithmetic, so G2-03 — a deny numbered above an allow, which is
 * dead letter with no error anywhere — cannot be expressed as long as the only paths that emit
 * entries are bound to one band each (see `denyIngress` and `allow` below). See
 * docs/adr/0033-rule-number-bands.md.
 */
const DENY_BAND = { first: 10, step: 1, limit: 99 } as const;
const ALLOW_BAND = { first: 100, step: 10 } as const;

export interface NetworkAclsProps {
  /** Module 1's VPC. A NACL cannot leave or outlive it. */
  readonly vpc: ec2.IVpc;

  /**
   * The subnets that stop using the default NACL. Associating is *replacing*: the default
   * NACL's allow-all stops applying the moment the association exists, and removing the
   * association restores it. Selected by `subnetType`, never by `subnetGroupName` — the
   * association's logical id already embeds module 1's subnet construct path, and a second
   * copy of the string `'Public'` would be a rename away from a silent gap (G2-07).
   */
  readonly subnets: ec2.SubnetSelection;

  /**
   * The port this NACL accepts from the internet, from `publicPort()` via `m1.publicPort`.
   *
   * Required rather than defaulted, and this layer does not read the certificate: the subnet
   * edge describes who may cross it and has no business knowing what a certificate is — the
   * same rule ADR-0018 applied to `SecurityGroupsProps.publicPort`.
   *
   * Hardcoding 80 here is the failure this prop exists to remove. With a certificate the
   * external listener binds 443, a tcp/80 ingress rule matches nothing, and every request is
   * blackholed by a stateless filter that logs a REJECT naming no resource. The listener, the
   * security group and this rule are one decision with three consumers.
   */
  readonly publicPort: number;

  /**
   * Ingress DENY by source CIDR — E1's input, and empty by default so a plain deploy denies
   * nobody. Sorted before numbering so re-running the same set in a different order is a
   * no-op; **append, never insert**, because changing an entry's rule number is a
   * CloudFormation replacement and old and new coexist mid-update (G2-02).
   */
  readonly deniedSources?: readonly string[];

  /**
   * `false` omits the egress ephemeral slot and scripts experiment E2 — the stateless
   * failure lives in code and in a test, not in anyone's memory.
   *
   * It does more than E2 asks for: `PORTS.frontend = 8080` sits inside 1024-65535, so this
   * also drops ALB-to-target forwards and every health check. That collateral is expected and
   * documented, not a surprise.
   */
  readonly openEphemeralEgress?: boolean;
}

/**
 * One declaration-array entry. Its position in the array, not its creation order or how many
 * entries preceded it, decides its ALLOW rule number — see `allow()` for why that distinction
 * is load-bearing.
 */
interface AllowSlot {
  readonly id: string;
  readonly traffic: ec2.AclTraffic;
  readonly enabled: boolean;
}

/**
 * A from-scratch, stateless NACL over module 1's public subnets: ordered deny/allow numbering
 * plus a scripted-breakage toggle for the stateless-egress gotcha (E2). See
 * docs/adr/0032-module-2-own-stack.md, docs/adr/0033-rule-number-bands.md and
 * docs/adr/0034-ephemeral-range-rationale.md.
 */
export class NetworkAcls extends Construct {
  /** Its id is an output: E1 edits this NACL, and `describe-network-acls` needs the id. */
  public readonly acl: ec2.NetworkAcl;

  /** The subnets that stopped using the default NACL. Output, and G2-07's evidence. */
  public readonly associatedSubnetIds: readonly string[];

  /**
   * The only counter in this construct, and the only value `denyIngress` ever reads or writes.
   * Binding the sole DENY-emitting path to this one counter — never a shared counter also used
   * for allows — is what makes `max(deny) < min(allow)` structural rather than merely tested.
   */
  private nextDenyRuleNumber: number = DENY_BAND.first;

  constructor(scope: Construct, id: string, props: NetworkAclsProps) {
    super(scope, id);

    const { vpc, subnets, publicPort, deniedSources = [], openEphemeralEgress = true } = props;

    // Passing `subnetSelection` here is what produces the `AWS::EC2::SubnetNetworkAclAssociation`
    // resources: the NetworkAcl constructor associates every subnet the selection resolves to
    // in one pass (`associateWithSubnet('DefaultAssociation', ...)` internally). No further call
    // is needed, and none should be added — a second association call would duplicate G2-07's
    // resources rather than add coverage.
    this.acl = new ec2.NetworkAcl(this, 'Acl', { vpc, subnetSelection: subnets });
    this.associatedSubnetIds = vpc.selectSubnets(subnets).subnetIds;

    // There is no `AclTraffic.allIcmp()` (G2-06) — `{ type: -1, code: -1 }` is the literal shape
    // for "all ICMP", built once here so ingress and egress cannot drift into two different
    // literals that both happen to compile.
    const allIcmp = ec2.AclTraffic.icmp({ type: -1, code: -1 });

    this.allow(ec2.TrafficDirection.INGRESS, [
      { id: 'AllowPublicPortIn', traffic: ec2.AclTraffic.tcpPort(publicPort), enabled: true },
      { id: 'AllowIcmpIn', traffic: allIcmp, enabled: true },
      {
        /**
         * The instance behind this NACL sits in a private subnet (module1-compute.ts) — its
         * own replies never reach this public boundary. What does arrive here, on this exact
         * range, is the NAT gateway's and the external ALB's own ephemeral source ports: the
         * NAT's reply to an instance's outbound HTTPS, and the ALB's own forwarding and
         * health-check connections landing back on the node that opened them. AWS fixes a NAT
         * gateway's source-port range at 1024-65535 independent of any client's operating
         * system — a second, client-independent argument for the full range (G2-04,
         * docs/adr/0034-ephemeral-range-rationale.md), not the Linux/Windows client-port
         * observation the lab leans on.
         */
        id: 'AllowEphemeralIn',
        traffic: ec2.AclTraffic.tcpPortRange(1024, 65535),
        enabled: true,
      },
    ]);

    this.allow(ec2.TrafficDirection.EGRESS, [
      {
        /**
         * The slot `openEphemeralEgress: false` empties — on purpose, to script experiment E2
         * (docs/adr/0036-scripted-breakage-toggle.md). Omitting it must leave rule number 100
         * unused rather than shifting every slot after it down: a running counter would
         * renumber `AllowHttpsOut` from 110 to 100, and `RuleNumber` is replace-on-update in
         * CloudFormation, so the old 110 and the new 100 coexist mid-update and collide with
         * whichever rule already holds 100 (G2-02's worst case). Numbering by declaration-slot
         * index, filtered after numbering in `allow()`, is what keeps every surviving rule's
         * number fixed across this toggle.
         */
        id: 'AllowEphemeralOut',
        traffic: ec2.AclTraffic.tcpPortRange(1024, 65535),
        enabled: openEphemeralEgress,
      },
      { id: 'AllowHttpsOut', traffic: ec2.AclTraffic.tcpPort(443), enabled: true },
      { id: 'AllowPublicPortOut', traffic: ec2.AclTraffic.tcpPort(publicPort), enabled: true },
      { id: 'AllowIcmpOut', traffic: allIcmp, enabled: true },
    ]);

    // Sorted before numbering: re-running the same set in a different order is then a no-op.
    // The convention is append-only — inserting at the front renumbers every entry after it.
    [...deniedSources].sort().forEach((cidr, index) => this.denyIngress(`Deny${index}`, cidr));
  }

  /**
   * The only path in this construct that can emit a DENY, and the only reader or writer of
   * `nextDenyRuleNumber`. Binding the action to the band this strictly is what makes
   * `max(deny) < min(allow)` arithmetic rather than a convention someone has to remember.
   *
   * The throw is what turns "hard to get wrong" into "cannot get wrong": without it, a 91st
   * denied CIDR would silently receive rule number 100 and sit above every ALLOW — G2-03
   * reintroduced by the very mechanism meant to prevent it.
   */
  private denyIngress(id: string, cidr: string): void {
    if (this.nextDenyRuleNumber > DENY_BAND.limit) {
      throw new Error(
        `NetworkAcls: deny band exhausted (rule numbers ${DENY_BAND.first}-${DENY_BAND.limit}). ` +
          'Adding another denied source here would be numbered inside the allow band, ' +
          'silently placing a DENY above an ALLOW (G2-03) with no error at deploy.',
      );
    }

    this.acl.addEntry(id, {
      cidr: ec2.AclCidr.ipv4(cidr),
      traffic: ec2.AclTraffic.allTraffic(),
      direction: ec2.TrafficDirection.INGRESS,
      ruleAction: ec2.Action.DENY,
      ruleNumber: this.nextDenyRuleNumber,
    });

    this.nextDenyRuleNumber += DENY_BAND.step;
  }

  /**
   * The only path in this construct that can emit an ALLOW, and the only place `ALLOW_BAND` is
   * read. Rule numbers come from each slot's position in `slots`, never from a counter: a
   * counter advanced only for enabled slots would renumber a surviving rule the moment an
   * earlier slot is disabled (see `AllowEphemeralOut`'s comment for the exact collision that
   * causes). Filtering after numbering — skip, don't shift — is what keeps a toggle a clean
   * single create/delete instead of a renumbering hazard.
   */
  private allow(direction: ec2.TrafficDirection, slots: readonly AllowSlot[]): void {
    slots.forEach((slot, index) => {
      if (!slot.enabled) {
        return; // the slot's number stays unused; nothing after it renumbers
      }

      this.acl.addEntry(slot.id, {
        cidr: ec2.AclCidr.anyIpv4(),
        traffic: slot.traffic,
        direction,
        ruleAction: ec2.Action.ALLOW,
        ruleNumber: ALLOW_BAND.first + index * ALLOW_BAND.step,
      });
    });
  }
}
