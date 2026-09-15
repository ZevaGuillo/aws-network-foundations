import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { PORTS, publicPort } from '../lib/module1-security-groups';
import { synth } from './support/synth';

/** Any syntactically valid ACM ARN; nothing resolves it. See test/module1-load-balancers.test.ts. */
const CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

/**
 * These assertions guard the trust chain, and every one of them exists because the thing it
 * checks fails without producing an error.
 *
 * A rule pointed at the wrong group still deploys. A rule that quietly becomes address-based
 * still deploys. A rule dropped in a refactor still deploys, and shows up days later as a
 * health check that never passes. None of that turns a template red on its own.
 *
 * docs/adr/0015-reference-security-groups-by-identity.md
 * docs/adr/0016-ingress-only-while-egress-stays-open.md
 */

/** Logical id of the one group whose description matches, so rules can be traced to a tier. */
function groupIdFor(template: Template, descriptionFragment: string): string {
  const matches = Object.entries(template.findResources('AWS::EC2::SecurityGroup')).filter(
    ([, resource]) => String(resource.Properties.GroupDescription).includes(descriptionFragment),
  );

  expect(matches).toHaveLength(1);
  return matches[0][0];
}

/** The standalone ingress rules landing on a group, as `{ from, port }` pairs. */
function rulesInto(template: Template, groupLogicalId: string) {
  return Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
    .filter((rule) => rule.Properties.GroupId?.['Fn::GetAtt']?.[0] === groupLogicalId)
    .map((rule) => ({
      from: rule.Properties.SourceSecurityGroupId?.['Fn::GetAtt']?.[0] as string | undefined,
      port: rule.Properties.FromPort as number,
    }));
}

describe('the trust chain', () => {
  test('is five groups', () => {
    synth().template.resourceCountIs('AWS::EC2::SecurityGroup', 5);
  });

  test('is six rules, no more and no fewer', () => {
    // One of the six is the internet rule, which the CDK inlines into the external balancer's
    // own SecurityGroupIngress property because a CIDR peer can be inlined without creating a
    // dependency. The other five name groups and become standalone resources. A rule lost in a
    // refactor leaves a tier unreachable, and the symptom arrives at deploy time as a target
    // that never turns healthy.
    const { template } = synth();

    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 5);
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([Match.objectLike({ CidrIp: '0.0.0.0/0' })]),
    });
  });

  test.each([
    ['without a certificate', undefined, PORTS.http],
    ['with a certificate', CERTIFICATE_ARN, PORTS.https],
  ])(
    'lets exactly one group accept an address, %s',
    (_name, certificateArn, expectedPort) => {
      /**
       * This is the premise of the whole layer. A second group accepting a CIDR is the chain
       * quietly becoming address-based, and nothing anywhere fails.
       *
       * It runs in both certificate modes since layer 3, for two reasons. The port is no longer
       * a constant — `publicPort()` derives it, and this rule is one of its two consumers
       * (docs/adr/0018). And this is the assertion that catches a listener opening its own
       * security group: `addListener` defaults `open` to true, which would put a second
       * `0.0.0.0/0` rule on the internal balancer's group (docs/adr/0021).
       */
      const { template } = synth(certificateArn === undefined ? undefined : { certificateArn });

      const withCidr = Object.values(template.findResources('AWS::EC2::SecurityGroup')).filter(
        (group) => group.Properties.SecurityGroupIngress !== undefined,
      );

      expect(withCidr).toHaveLength(1);
      expect(withCidr[0].Properties.GroupDescription).toContain('External load balancer');
      expect(withCidr[0].Properties.SecurityGroupIngress).toEqual([
        expect.objectContaining({
          CidrIp: '0.0.0.0/0',
          IpProtocol: 'tcp',
          FromPort: expectedPort,
          ToPort: expectedPort,
        }),
      ]);
      expect(expectedPort).toBe(publicPort(certificateArn));
    },
  );

  test('wires each tier to its balancer, not to the tier before it', () => {
    // The assertion that carries the reasoning. A backend trusting the frontend would deploy
    // cleanly and fail every health check, because the packets arrive from the balancer's
    // interfaces. See the comment on the rule itself.
    const { template } = synth();

    const externalAlb = groupIdFor(template, 'External load balancer');
    const frontend = groupIdFor(template, 'Web tier');
    const internalAlb = groupIdFor(template, 'Internal load balancer');
    const backend = groupIdFor(template, 'Application tier');
    const eice = groupIdFor(template, 'Instance Connect Endpoint');

    expect(rulesInto(template, frontend)).toEqual(
      expect.arrayContaining([
        { from: externalAlb, port: PORTS.frontend },
        { from: eice, port: PORTS.ssh },
      ]),
    );
    expect(rulesInto(template, internalAlb)).toEqual([{ from: frontend, port: PORTS.internal }]);
    expect(rulesInto(template, backend)).toEqual(
      expect.arrayContaining([
        { from: internalAlb, port: PORTS.backend },
        { from: eice, port: PORTS.ssh },
      ]),
    );

    // The endpoint is a source only. Anything arriving here is a rule pointed the wrong way.
    expect(rulesInto(template, eice)).toEqual([]);
  });

  test('leaves every group with the allow-all egress it was given', () => {
    // Records docs/adr/0016 in the template. Narrowing egress is a real goal that waits for
    // module 4's interface endpoints; until then this makes tightening it a visible diff.
    const { template } = synth();

    for (const group of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) {
      expect(group.Properties.SecurityGroupEgress).toEqual([
        expect.objectContaining({ CidrIp: '0.0.0.0/0', IpProtocol: '-1' }),
      ]);
    }
  });

  test('synthesizes without a single warning annotation', () => {
    /**
     * The guard for the trap that cannot be seen in a template.
     *
     * With `allowAllOutbound` true, `addEgressRule` is silently discarded — zero resources are
     * emitted and synthesis succeeds, so the rule sits in the source looking effective while
     * the template has nothing to find. What the CDK does leave behind is an annotation:
     *
     *   Ignoring Egress rule since 'allowAllOutbound' is set to true
     *   [ack: @aws-cdk/aws-ec2:ipv4IgnoreEgressRule]
     *
     * Verified in both directions: zero as the layer is written, exactly one the moment an
     * `addEgressRule` call is added.
     *
     * Deliberately broad — any CDK warning fails this suite, not only that one. For a
     * repository this size that is a feature. If an unrelated warning ever appears and is
     * genuinely acceptable, narrow the matcher to the ack key rather than deleting the test.
     *
     * Note what this does NOT cover: CloudFormation template validation findings travel a
     * separate channel and never reach annotations. Those are caught by `cdk synth`, which
     * fails on them because cdk.json sets `@aws-cdk/core:validateAgainstDefaultRules`.
     */
    const warnings = Annotations.fromStack(synth().stack).findWarning('*', Match.anyValue());

    expect(warnings).toEqual([]);
  });
});
