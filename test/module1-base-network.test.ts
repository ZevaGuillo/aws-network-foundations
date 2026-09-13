import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { Module1BaseNetworkStack } from '../lib/module1-base-network-stack';
import { IPV4_ADDRESS_PLAN, MODULE_1_NETWORK } from '../lib/config';

/**
 * These assertions guard the decisions in docs/adr/, not the CDK.
 *
 * Each one exists because the thing it checks fails silently: a NAT Gateway count that drifts
 * costs money without erroring, a subnet mask cannot be changed after deployment, and the
 * intentional address collision can be "corrected" without anything turning red.
 */

function synth(props?: ConstructorParameters<typeof Module1BaseNetworkStack>[2]): Template {
  const app = new cdk.App();
  return Template.fromStack(new Module1BaseNetworkStack(app, 'TestStack', props));
}

describe('base network', () => {
  test('spans the planned address range with DNS enabled', () => {
    // DNS is asserted because module 4's private endpoint DNS depends on it, and nothing in
    // this stack would fail if it were switched off.
    // docs/adr/0009-declare-dns-support-explicitly.md
    synth().hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: IPV4_ADDRESS_PLAN.module1.baseNetwork,
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  test('provisions four /24 subnets, two public and two private', () => {
    // The mask is immutable after creation, so a drift here is only fixable by replacing the
    // subnet and everything in it. docs/adr/0007-slash-24-subnet-mask.md
    const subnets = Object.values(synth().findResources('AWS::EC2::Subnet'));

    expect(subnets).toHaveLength(4);

    for (const subnet of subnets) {
      expect(subnet.Properties.CidrBlock).toMatch(
        new RegExp(`/${MODULE_1_NETWORK.subnetCidrMask}$`),
      );
    }

    const publicSubnets = subnets.filter((s) => s.Properties.MapPublicIpOnLaunch);
    expect(publicSubnets).toHaveLength(2);
  });

  test('reaches S3 through a free gateway endpoint rather than the NAT Gateway', () => {
    // Without this the same traffic is billed at $0.045/GB of NAT data processing.
    // docs/adr/0008-s3-gateway-endpoint.md
    synth().hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });
});

describe('NAT Gateway count', () => {
  // The CDK default is one per availability zone, which is ~$96/month from a construct call
  // with no numbers in it. docs/adr/0006-single-nat-gateway-by-default.md

  test('defaults to one, with one Elastic IP to reclaim after teardown', () => {
    const template = synth();

    template.resourceCountIs('AWS::EC2::NatGateway', MODULE_1_NETWORK.natGateways);
    template.resourceCountIs('AWS::EC2::EIP', MODULE_1_NETWORK.natGateways);
  });

  test('honours an explicit override for deployments that need per-AZ egress', () => {
    synth({ natGateways: 2 }).resourceCountIs('AWS::EC2::NatGateway', 2);
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
