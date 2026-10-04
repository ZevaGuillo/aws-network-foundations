import { Template } from 'aws-cdk-lib/assertions';
import { IPV4_ADDRESS_PLAN, MODULE_1_NETWORK } from '../lib/config';
import { synth } from './support/synth';

/**
 * These assertions guard the decisions in docs/adr/, not the CDK.
 *
 * Each one exists because the thing it checks fails silently: a NAT Gateway count that drifts
 * costs money without erroring, a subnet mask cannot be changed after deployment, and the
 * intentional address collision can be "corrected" without anything turning red.
 */

/**
 * The subnets whose default route leaves through a given kind of target.
 *
 * `target` is the property a `AWS::EC2::Route` uses to name where 0.0.0.0/0 goes: `GatewayId`
 * for the internet gateway, `NatGatewayId` for the NAT. Following route table -> association
 * -> subnet is how the network itself decides what "public" means, rather than any attribute
 * hung off the subnet.
 */
function subnetsRoutedThrough(template: Template, target: 'GatewayId' | 'NatGatewayId'): string[] {
  const routeTableIds = Object.values(template.findResources('AWS::EC2::Route'))
    .filter((r) => r.Properties.DestinationCidrBlock === '0.0.0.0/0' && r.Properties[target])
    .map((r) => r.Properties.RouteTableId.Ref);

  return Object.values(template.findResources('AWS::EC2::SubnetRouteTableAssociation'))
    .filter((a) => routeTableIds.includes(a.Properties.RouteTableId.Ref))
    .map((a) => a.Properties.SubnetId.Ref);
}

/**
 * A VPC endpoint's service name in a form that can be asserted in either synthesis mode.
 *
 * The name embeds the region, so the CDK renders it as `com.amazonaws.<region>.s3` — an
 * `Fn::Join` around `AWS::Region` while the stack is environment-agnostic, a plain string once
 * an environment is pinned. Joining the literal fragments and ignoring the token leaves the
 * service suffix intact in both, which is the part ADR-0008 is about.
 */
function serviceNameOf(endpoint: { [key: string]: any }): string {
  const name: unknown = endpoint.Properties.ServiceName;
  if (typeof name === 'string') return name;

  const [, fragments] = (name as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
  return fragments.filter((fragment): fragment is string => typeof fragment === 'string').join('');
}

describe('base network', () => {
  test('spans the planned address range with DNS enabled', () => {
    // DNS is asserted because module 4's private endpoint DNS depends on it, and nothing in
    // this stack would fail if it were switched off.
    // docs/adr/0009-declare-dns-support-explicitly.md
    synth().template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: IPV4_ADDRESS_PLAN.module1.baseNetwork,
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  test('provisions four /24 subnets, two public and two private', () => {
    // The mask is immutable after creation, so a drift here is only fixable by replacing the
    // subnet and everything in it. docs/adr/0007-slash-24-subnet-mask.md
    const { template } = synth();
    const subnets = Object.values(template.findResources('AWS::EC2::Subnet'));

    expect(subnets).toHaveLength(4);

    for (const subnet of subnets) {
      expect(subnet.Properties.CidrBlock).toMatch(
        new RegExp(`/${MODULE_1_NETWORK.subnetCidrMask}$`),
      );
    }

    // A subnet is public because its route table reaches the internet gateway, and private
    // because it reaches the NAT Gateway instead. That routing *is* the topology, so it is
    // what gets asserted.
    //
    // The obvious shortcut — filtering on MapPublicIpOnLaunch — was tried and rejected. It
    // reads a CDK default rather than a decision here, and it made the correct security
    // setting in ADR-0012 look like a broken test: switch auto-assign off and the count of
    // "public" subnets drops to zero while the network is unchanged.
    expect(subnetsRoutedThrough(template, 'GatewayId')).toHaveLength(2);
    expect(subnetsRoutedThrough(template, 'NatGatewayId')).toHaveLength(2);
  });

  test('never auto-assigns a public IPv4 address, in any subnet', () => {
    // Public subnets default to true, so an instance landing in the wrong subnet group would
    // be addressable from the internet without a line of code asking for it.
    // docs/adr/0012-never-auto-assign-public-ipv4-addresses.md
    const subnets = Object.values(synth().template.findResources('AWS::EC2::Subnet'));

    for (const subnet of subnets) {
      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false);
    }
  });

  test('reaches S3 — not merely some service — through a free gateway endpoint', () => {
    // Without this the same traffic is billed at $0.045/GB of NAT data processing.
    // docs/adr/0008-s3-gateway-endpoint.md
    //
    // The service is asserted, not just the endpoint type. Gateway endpoints exist for exactly
    // two services, and an assertion that only reads `VpcEndpointType: 'Gateway'` stays green
    // if S3 is swapped for DynamoDB — verified by mutation. ADR-0008 argues about S3 traffic
    // with S3 figures, so S3 is what the test has to name.
    const endpoints = Object.values(synth().template.findResources('AWS::EC2::VPCEndpoint'));

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].Properties.VpcEndpointType).toBe('Gateway');
    expect(serviceNameOf(endpoints[0])).toMatch(/\.s3$/);
  });
});

describe('NAT Gateway count', () => {
  // The CDK default is one per availability zone, which is ~$96/month from a construct call
  // with no numbers in it. docs/adr/0006-single-nat-gateway-by-default.md

  test('defaults to one, with one Elastic IP to reclaim after teardown', () => {
    const { template } = synth();

    template.resourceCountIs('AWS::EC2::NatGateway', MODULE_1_NETWORK.natGateways);
    template.resourceCountIs('AWS::EC2::EIP', MODULE_1_NETWORK.natGateways);
  });

  test('honours an explicit override for deployments that need per-AZ egress', () => {
    synth({ natGateways: 2 }).template.resourceCountIs('AWS::EC2::NatGateway', 2);
  });
});

describe('the intentional address collision', () => {
  /**
   * This is the guard the other tests exist to make credible.
   *
   * Module 4's consumer VPC shares module 3's VPC A range on purpose: it is the case where
   * peering is structurally impossible and PrivateLink is indifferent. Separating the two
   * ranges would delete that experiment without breaking a single deployment — no stack fails,
   * no template changes, nothing turns red. This test is the only thing that notices.
   *
   * If this fails, do not change the expectation. Change whatever moved the range back.
   * docs/adr/0004-intentional-cidr-overlap.md
   */
  test('module 4 still overlaps module 3 VPC A exactly', () => {
    expect(IPV4_ADDRESS_PLAN.module4.deliberatelyOverlappingConsumer).toBe(
      IPV4_ADDRESS_PLAN.module3.a,
    );
  });

  test('no other pair of planned ranges overlaps', () => {
    // Everything except the deliberate pair must stay distinct, or module 3 cannot peer.
    // docs/adr/0003-repo-wide-ipv4-addressing-plan.md
    const peerableRanges = [
      IPV4_ADDRESS_PLAN.module1.baseNetwork,
      IPV4_ADDRESS_PLAN.module3.a,
      IPV4_ADDRESS_PLAN.module3.b,
      IPV4_ADDRESS_PLAN.module3.c,
    ];

    expect(new Set(peerableRanges).size).toBe(peerableRanges.length);
  });
});

/**
 * The outputs exist because of what the first deploy was like without them.
 *
 * `cdk deploy` printed a stack name and nothing else, so every step of the measurement in
 * docs/plans/module1-layer4-application.md section 11 began by recovering a physical id the
 * deploy already knew — `describe-stack-resource --logical-resource-id
 * LoadBalancersFrontendTargets1600C5DB`, a CDK hash typed by hand, to find a target group so
 * its health could be polled. Section 11 calls that procedure repeatable. It is not repeatable
 * while it depends on reading hashes out of a synthesized template.
 *
 * Nothing here turns a template red on its own: a stack with no outputs deploys perfectly.
 */
describe('the stack outputs', () => {
  const EXPECTED = [
    'ExternalUrl',
    'InternalAlbDnsName',
    'FrontendTargetGroupArn',
    'BackendTargetGroupArn',
    'FrontendInstanceId',
    'BackendInstanceId',
    'NatGatewayId',
  ];

  test('name every value the measurement procedure needs, and nothing else', () => {
    // An exact comparison rather than a containment check, on the same reasoning as the IAM
    // policy assertion in the compute suite: a list that grows quietly is a list nobody reads.
    const names = Object.keys(synth().template.findOutputs('*'));

    expect(names.sort()).toEqual([...EXPECTED].sort());
  });

  test('each carry a description, because an output without one is a bare string', () => {
    const outputs = synth().template.findOutputs('*');

    for (const [name, output] of Object.entries(outputs)) {
      expect(output.Description).toEqual(expect.stringMatching(/\S/));
      expect(name).not.toEqual('');
    }
  });

  test('export nothing, so nothing can import them and block a delete', () => {
    // An exported output cannot be removed or renamed while another stack imports it, and the
    // failure arrives as a refusal to delete this stack. Module 1 is one stack by
    // docs/adr/0014-one-stack-per-module.md, so there is nothing to import them and nothing to
    // gain by offering.
    for (const output of Object.values(synth().template.findOutputs('*'))) {
      expect(output.Export).toBeUndefined();
    }
  });

  test('point the external url at the balancer over plain HTTP by default', () => {
    // The scheme has to follow the certificate, because the listener does. ADR-0018 makes the
    // certificate optional and ADR-0023 adds no redirect, so an https url with no certificate
    // would be an output that names a port nothing listens on.
    const { Value } = synth().template.findOutputs('ExternalUrl').ExternalUrl;

    expect(Value['Fn::Join'][1][0]).toEqual('http://');
  });

  test('point it at HTTPS as soon as a certificate is supplied', () => {
    const { Value } = synth({
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
    }).template.findOutputs('ExternalUrl').ExternalUrl;

    expect(Value['Fn::Join'][1][0]).toEqual('https://');
  });

  test('name the NAT Gateway the boot cost is measured against', () => {
    // The one output found by walking the construct tree rather than read off a construct
    // property, because the CDK creates NAT Gateways inside the Vpc under a path that encodes
    // the subnet group name — `Vpc/PublicSubnet1/NATGateway`. Reading that path literally would
    // couple this to the string 'Public' in subnetConfiguration.
    const { template } = synth();
    const { Value } = template.findOutputs('NatGatewayId').NatGatewayId;
    const gateways = Object.keys(template.findResources('AWS::EC2::NatGateway'));

    expect(gateways).toContain(Value.Ref);
  });
});
