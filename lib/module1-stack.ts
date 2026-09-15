import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { MODULE_1_NETWORK } from './config';
import { SecurityGroups, publicPort } from './module1-security-groups';
import { LoadBalancers } from './module1-load-balancers';

export interface Module1StackProps extends cdk.StackProps {
  /**
   * Number of NAT Gateways. Defaults to MODULE_1_NETWORK.natGateways.
   *
   * This is the only network value exposed as a property, because it is the only one that
   * changes the bill from one deployment to the next. Everything else stays in config, where
   * it is reviewed once. See docs/adr/0006-single-nat-gateway-by-default.md.
   */
  readonly natGateways?: number;

  /**
   * ACM certificate ARN for the external listener. Absent - the default - means the external
   * balancer listens on plain HTTP.
   *
   * The second property on this stack, and it earns the place on the same rule as the first: a
   * value becomes a property when it changes what a given deployment *is*. This one decides
   * whether the repository can be deployed at all by someone who owns no domain, which is what
   * docs/adr/0002-self-contained-repository.md promised.
   *
   * See docs/adr/0018-the-certificate-is-optional.md.
   */
  readonly certificateArn?: string;
}

/**
 * Module 1 — the whole module, in one stack.
 *
 * Layer 1 is the base network: a VPC across two availability zones with public and private
 * subnets, the private ones carrying egress so instances can install packages at boot.
 * Layer 2 is the trust chain: five security groups naming each other by identity.
 * Layer 3 is the balancers: two Application Load Balancers and the target groups layer 5 fills.
 *
 * Layers 4 and 5 — the application, the compute tiers, auto scaling — land here too. One stack
 * per module, decided in docs/adr/0014-one-stack-per-module.md, which is also why the class is
 * named for the module rather than for any one layer inside it.
 *
 * The decisions behind every value here are recorded in docs/adr/. Comments below state the
 * why and the cost at the point of use; the records hold the alternatives and the full
 * argument.
 */
export class Module1Stack extends cdk.Stack {
  /** Consumed by module 1's later layers, and by modules 2 and 5. */
  public readonly vpc: ec2.Vpc;

  /** Consumed by layers 3 through 5, which attach balancers and instances to these groups. */
  public readonly securityGroups: SecurityGroups;

  /** Consumed by layer 5, which registers its auto scaling groups into the target groups. */
  public readonly loadBalancers: LoadBalancers;

  constructor(scope: Construct, id: string, props?: Module1StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(MODULE_1_NETWORK.vpcCidr),

      // Pinned, never inferred. The CDK defaults to three availability zones, and it creates
      // one NAT Gateway per zone — see the next property for what that costs.
      maxAzs: MODULE_1_NETWORK.azCount,

      /**
       * The most expensive line in this module, stated as a number rather than inherited.
       *
       * A NAT Gateway costs $0.045/hour just to exist — about $32/month — plus $0.045/GB
       * processed. The default is one per availability zone, so `new ec2.Vpc(this, 'Vpc')`
       * with no arguments provisions three: roughly $96/month, from a line of code containing
       * no numbers at all. Writing less code is what makes it expensive.
       *
       * What one NAT Gateway gives up, and both are real:
       *
       *   - Availability-zone fault isolation for egress. The NAT sits in one zone. If that
       *     zone fails, the private subnet in the healthy zone also loses outbound internet,
       *     because its route still points at a gateway that is gone. Two AZs with one NAT is
       *     not two-AZ for egress.
       *   - Free intra-AZ egress. Traffic from the zone without the NAT crosses zones to reach
       *     it, adding $0.01/GB in each direction on top of the NAT's own processing charge.
       *     Past enough volume the cheap NAT is the expensive one.
       *
       * One is right for infrastructure that is deployed, measured and destroyed the same day.
       * Production traffic gets one per zone. See
       * docs/adr/0006-single-nat-gateway-by-default.md.
       */
      natGateways: props?.natGateways ?? MODULE_1_NETWORK.natGateways,

      /**
       * Both already default to true, so these two lines change nothing that CloudFormation
       * will see. They are here because a default cannot defend itself.
       *
       * Private DNS on VPC interface endpoints requires both enabled — that mechanism is what
       * lets an endpoint take over a service's normal DNS name inside the VPC, which is the
       * whole premise of module 4. Nothing in this layer depends on them, so they look inert
       * and get switched off by someone tightening configuration. The cost of that is a
       * silent one: the endpoint still creates successfully, resolution simply does not
       * happen, and the symptom shows up modules away from the cause.
       *
       * See docs/adr/0009-declare-dns-support-explicitly.md.
       */
      enableDnsHostnames: true,
      enableDnsSupport: true,

      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,

          /**
           * The CDK defaults this to `true` on public subnets, which means anything launched
           * here receives a public IPv4 address without anyone asking for one.
           *
           * Nothing in this layer changes: every instance in this architecture goes in a
           * private subnet, and neither of the two things that do live out here needs it — a
           * NAT Gateway carries its own Elastic IP, and a load balancer is addressed through
           * its own DNS name. So the value costs nothing today and removes a silent failure
           * later: a compute tier placed in the wrong subnet group reaches the internet by
           * default instead of failing to.
           *
           * What this does not do is close the hole. The subnet still routes to the internet
           * gateway, and a launch template with `associatePublicIpAddress` or an explicitly
           * attached Elastic IP still gets an address. It removes the default, not the
           * capability — the security group is what closes it.
           *
           * Legal only on PUBLIC subnets: the CDK throws `MapPublicIpNotAllowed` if the
           * property appears on any other subnet type.
           *
           * See docs/adr/0012-never-auto-assign-public-ipv4-addresses.md.
           */
          mapPublicIpOnLaunch: false,

          /**
           * A /24 yields 251 usable addresses, not 256. AWS reserves five in every subnet
           * regardless of size: the network address, the VPC router, DNS, one held for future
           * use, and broadcast — reserved even though AWS does not support broadcast. The same
           * five are why a /28 gives 11 usable and not 16.
           *
           * The console wizard defaults to /20, which is 4091 usable addresses for a network
           * running a handful of instances. The waste is not the problem; the problem is that
           * a subnet's CIDR is immutable once created, so the cost of being wrong is
           * recreating the subnet and everything running in it. A /16 cut into /24s leaves 252
           * slots free, which keeps that possibility remote.
           *
           * See docs/adr/0007-slash-24-subnet-mask.md.
           */
          cidrMask: MODULE_1_NETWORK.subnetCidrMask,
        },
        {
          name: 'Private',

          /**
           * WITH_EGRESS, not ISOLATED: instances install packages during user data and need a
           * default route to the NAT.
           *
           * The cost of getting this wrong is paid in diagnosis time. PRIVATE_ISOLATED has no
           * egress at all, so user data hangs, the instance never reports healthy, the auto
           * scaling group loops terminating newborn instances — and nothing in any error
           * message mentions the subnet.
           */
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: MODULE_1_NETWORK.subnetCidrMask,
        },
      ],

      /**
       * Free, and the difference between zero and a real number.
       *
       * Without it, S3 traffic from a private subnet leaves through the NAT Gateway and is
       * billed at $0.045/GB of data processing, in both directions. The endpoint adds a route
       * that reaches S3 over the AWS network instead, with no hourly charge and no per-GB
       * charge:
       *
       *     100 GB to S3    $4.50 through the NAT     $0.00 through the endpoint
       *       1 TB to S3     ~$46 through the NAT     $0.00 through the endpoint
       *
       * The caveat belongs next to the numbers: this removes the data charge, not the NAT's
       * ~$32/month existence charge. The NAT is still required for everything that is not S3
       * or DynamoDB — the package installs above, OS updates, third-party APIs. The endpoint
       * narrows what flows through the NAT; it does not remove it.
       *
       * See docs/adr/0008-s3-gateway-endpoint.md.
       */
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    /**
     * Layer 2 — the trust chain.
     *
     * Five security groups and nothing attached to them yet. That is deliberate rather than
     * incomplete: a rule names another *group*, never the balancer or instance that will wear
     * it, so the entire chain can be stated now and layers 3 through 5 only have to attach.
     * Defining each rule when its resource appears would make the chain a residue of creation
     * order instead of a policy decided once.
     *
     * See docs/plans/module1-layer2-security-groups.md.
     */
    this.securityGroups = new SecurityGroups(this, 'SecurityGroups', {
      vpc: this.vpc,
      publicPort: publicPort(props?.certificateArn),
    });

    /**
     * Layer 3 - the balancers.
     *
     * Two Application Load Balancers, and they are the most expensive thing in this module
     * after the NAT Gateway. Roughly $0.0225/hour each, so about $33/month for the pair before
     * a single request is served, on top of the NAT's ~$32. Module 1 sitting idle goes from
     * roughly $32/month to roughly $65/month, and this layer is where that happens.
     *
     * The internal balancer is half of that and is not removable. A tier reachable only from
     * inside the VPC is the thing module 1 exists to demonstrate, and one balancer cannot
     * demonstrate it. The conclusion is the one the README already draws: deploy, measure,
     * destroy - which this layer makes materially more expensive to ignore.
     *
     * The target groups it creates are empty. Layer 5 registers the auto scaling groups.
     */
    this.loadBalancers = new LoadBalancers(this, 'LoadBalancers', {
      vpc: this.vpc,
      securityGroups: this.securityGroups,
      certificateArn: props?.certificateArn,
    });
  }
}
