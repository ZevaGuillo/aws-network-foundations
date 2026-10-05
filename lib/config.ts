/**
 * Network parameters that outlive a single stack.
 *
 * This module imports nothing from aws-cdk-lib, on purpose. The address plan is the most
 * stable fact in this repository — it stays true when the constructs, the CDK version and the
 * stack layout have all been rewritten — and a stable module must not depend on a volatile
 * one. It also means a test, a script or a diagram tool can read the plan without pulling in
 * the CDK. See docs/adr/0005-framework-free-configuration-module.md.
 *
 * The boundary is drawn at the type, not the topic: a subnet mask lives here as the number 24,
 * because it is a fact about the network. SubnetType.PRIVATE_WITH_EGRESS does not, because it
 * is a CDK concept and belongs in the stack.
 */

/**
 * Module 3 peers these three VPCs to show that peering is not transitive: A reaches B and B
 * reaches C, but A never reaches C.
 *
 * They are declared here, before the first VPC in the repository exists, because peering
 * requires non-overlapping ranges and a VPC's primary range cannot be changed after creation.
 * Deciding per module would leave every module on 10.0.0.0/16 — the range everyone reaches for
 * — and module 3 would have nothing it could peer. The only remedy at that point is destroying
 * a VPC and everything inside it.
 *
 * See docs/adr/0003-repo-wide-ipv4-addressing-plan.md.
 */
const MODULE_3_VPCS = {
  a: '10.1.0.0/16',
  b: '10.2.0.0/16',
  c: '10.3.0.0/16',
} as const;

/**
 * The IPv4 plan for the whole repository. Second octet matches the owning module, so an
 * address identifies where it belongs at a glance.
 *
 *   10.0.0.0/16   module 1   base network
 *   10.1.0.0/16   module 3   VPC A
 *   10.2.0.0/16   module 3   VPC B
 *   10.3.0.0/16   module 3   VPC C
 *   10.1.0.0/16   module 4   consumer — the same range as VPC A, deliberately
 */
export const IPV4_ADDRESS_PLAN = {
  module1: {
    baseNetwork: '10.0.0.0/16',
  },

  module3: MODULE_3_VPCS,

  module4: {
    /**
     * ┌───────────────────────────────────────────────────────────────────────────┐
     * │  THIS COLLISION IS INTENTIONAL. DO NOT "FIX" IT.                          │
     * └───────────────────────────────────────────────────────────────────────────┘
     *
     * Module 4's consumer VPC reuses module 3's VPC A range byte for byte. The overlap is the
     * experiment, not an oversight: two VPCs on the same range can never be peered — no route
     * table entry can disambiguate an address that exists on both sides — while PrivateLink is
     * indifferent to it, because the consumer reaches the service through an endpoint network
     * interface inside its own subnet and no route between the two ranges is ever needed.
     *
     * The cost of losing this: changing the value to something non-overlapping deletes the
     * entire point of module 4 while leaving every stack green. Nothing fails. There is a test
     * asserting this collision still holds, because a comment cannot stop anyone and a failing
     * test can.
     *
     * It is written as a reference to MODULE_3_VPCS.a rather than a second literal so the two
     * cannot drift apart, and so that changing it means visibly unlinking something.
     *
     * See docs/adr/0004-intentional-cidr-overlap.md.
     */
    deliberatelyOverlappingConsumer: MODULE_3_VPCS.a,
  },
} as const;

/**
 * Module 1 network values. Each one is a number the AWS console would otherwise have chosen
 * for you; the reasoning for every override sits next to its use in the stack.
 */
/**
 * Prefix for the `Name` tags module 1 puts on resources the console renders without one.
 *
 * It matches the stack name from bin/app.ts in spirit but is not derived from it: a stack name
 * is a construct id resolved at synthesis, and this is a plain string a `dnf`-less shell script
 * or a `describe-instances --filter` can also use. Keeping them in step is a one-line job; a
 * token here would make this module import the CDK, which
 * docs/adr/0005-framework-free-configuration-module.md forbids.
 */
export const NAME_PREFIX = 'net-m1';

export const MODULE_1_NETWORK = {
  /** Derived from the plan above, never retyped. One place to change, one place to be wrong. */
  vpcCidr: IPV4_ADDRESS_PLAN.module1.baseNetwork,

  azCount: 2,
  subnetCidrMask: 24,
  natGateways: 1,
} as const;

/**
 * Module 2 network values: a from-scratch NACL over module 1's public subnets, plus the flow
 * log that makes its ACCEPT/REJECT decisions measurable.
 */

/** Prefix for module 2's `Name` tags, on the same reasoning as module 1's NAME_PREFIX above. */
export const MODULE_2_NAME_PREFIX = 'net-m2';

/**
 * `RetentionInDays` is a CDK enum whose values happen to be the day counts themselves, so a
 * plain number compiles against it and only fails once a bad value reaches a real deploy.
 * The union is the decision made compile-checkable: adding `365` here without a matching case
 * in `logs.RetentionDays` map at the construct boundary is a type error, not a surprise bill.
 */
export type FlowLogRetentionDays = 1 | 3 | 7;

/** Same reasoning as FlowLogRetentionDays, for `ec2.FlowLogMaxAggregationInterval`. */
export type FlowLogAggregationSeconds = 60 | 600;

export const MODULE_2_NACL = {
  /**
   * Ingress DENY by source CIDR. Empty by default, so a plain `cdk deploy` denies nobody — E1
   * editing this array is a deliberate, reviewed change, not shipped policy. Append-only:
   * inserting at the front renumbers every entry after it, and a rule number is
   * replace-on-update in CloudFormation, so old and new briefly coexist mid-update.
   */
  deniedSources: [] as readonly string[],

  /**
   * The NAT gateway's and the ALB's own ephemeral source ports — AWS fixes this range for NAT,
   * independent of any client's operating system. Two plain numbers; `AclTraffic.tcpPortRange`
   * is built from them at the construct boundary, where CDK concepts belong.
   */
  ephemeralPorts: { from: 1024, to: 65535 },

  /**
   * `false` scripts experiment E2's stateless-egress failure. It also drops every ALB health
   * check, because `PORTS.frontend = 8080` sits inside the same range — collateral the plan doc
   * states explicitly, not a surprise.
   */
  openEphemeralEgress: true,
} as const;

export const MODULE_2_FLOW_LOGS = {
  /** Disposable evidence for this module's own experiments; module 5 owns durable retention. */
  retentionDays: 7,
  aggregationIntervalSeconds: 60,
} as const satisfies {
  retentionDays: FlowLogRetentionDays;
  aggregationIntervalSeconds: FlowLogAggregationSeconds;
};
