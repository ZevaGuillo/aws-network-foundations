import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { PORTS, publicPort } from '../lib/module1-security-groups';
import { HEALTH_CHECK, DEREGISTRATION_DELAY } from '../lib/module1-load-balancers';
import { synth } from './support/synth';

/**
 * These assertions guard the balancers, and as in layer 2 every one of them exists because the
 * thing it checks fails without producing an error.
 *
 * A listener the security group blocks deploys cleanly and times out. A balancer pointed at the
 * wrong target group deploys cleanly and routes the internet at the application tier. A health
 * check block deleted in a refactor deploys cleanly and silently restores 150 seconds. None of
 * that turns a template red on its own.
 *
 * docs/adr/0017-write-health-check-timings-out.md
 * docs/adr/0018-the-certificate-is-optional.md
 * docs/adr/0019-shallow-health-check-at-the-balancer.md
 * docs/adr/0020-empty-target-groups-declare-their-target-type.md
 * docs/adr/0021-listeners-never-open-their-own-security-group.md
 * docs/adr/0022-pin-the-tls-policy.md
 * docs/adr/0023-no-redirect-listener.md
 * docs/adr/0024-drop-invalid-header-fields.md
 */

/**
 * Any syntactically valid ACM ARN. Nothing resolves it — the listener only needs a string, and
 * the suite synthesizes without an account. See test/support/synth.ts.
 */
const CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

/** The one logical id of `type` whose own id contains `fragment`. */
function logicalIdFor(template: Template, type: string, fragment: string): string {
  const matches = Object.keys(template.findResources(type)).filter((id) => id.includes(fragment));

  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Every load balancer, keyed by its scheme, which is the only thing distinguishing the two. */
function balancersByScheme(template: Template) {
  return Object.fromEntries(
    Object.entries(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).map(
      ([id, resource]) => [resource.Properties.Scheme as string, { id, ...resource.Properties }],
    ),
  );
}

/** The one listener attached to the balancer with this logical id. */
function listenerOn(template: Template, balancerLogicalId: string) {
  const matches = Object.values(
    template.findResources('AWS::ElasticLoadBalancingV2::Listener'),
  ).filter((listener) => listener.Properties.LoadBalancerArn?.Ref === balancerLogicalId);

  expect(matches).toHaveLength(1);
  return matches[0].Properties;
}

describe('the balancers', () => {
  test('are two: one facing the internet, one facing only the VPC', () => {
    const { template } = synth();

    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 2);

    const schemes = balancersByScheme(template);
    expect(Object.keys(schemes).sort()).toEqual(['internal', 'internet-facing']);
  });

  test('sit in the subnets their scheme requires, stated rather than inferred', () => {
    // Placement follows from the scheme today. Asserting it means a change to that inference,
    // or to the subnet layout in layer 1, shows up here instead of moving the topology in
    // silence: an internal balancer in a public subnet is one route table away from reachable.
    const { template } = synth();
    const schemes = balancersByScheme(template);

    const subnetRefs = (balancer: { Subnets: { Ref: string }[] }) =>
      balancer.Subnets.map((subnet) => subnet.Ref);

    expect(subnetRefs(schemes['internet-facing'])).toHaveLength(2);
    for (const ref of subnetRefs(schemes['internet-facing'])) {
      expect(ref).toContain('PublicSubnet');
    }

    expect(subnetRefs(schemes.internal)).toHaveLength(2);
    for (const ref of subnetRefs(schemes.internal)) {
      expect(ref).toContain('PrivateSubnet');
    }
  });

  test('each forward to the target group in front of the tier they serve', () => {
    // A deploy that succeeds while routing the internet at the application tier is the failure
    // this catches. Both target groups are port 8080 with identical health checks, so the
    // logical id is the only thing that tells them apart — as GroupDescription was in layer 2.
    const { template } = synth();

    const schemes = balancersByScheme(template);
    const frontendTargets = logicalIdFor(
      template,
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'FrontendTargets',
    );
    const backendTargets = logicalIdFor(
      template,
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'BackendTargets',
    );

    expect(listenerOn(template, schemes['internet-facing'].id).DefaultActions).toEqual([
      expect.objectContaining({ Type: 'forward', TargetGroupArn: { Ref: frontendTargets } }),
    ]);
    expect(listenerOn(template, schemes.internal.id).DefaultActions).toEqual([
      expect.objectContaining({ Type: 'forward', TargetGroupArn: { Ref: backendTargets } }),
    ]);
  });

  test('drop invalid header fields on the one that faces the internet', () => {
    /**
     * Default `false`: headers carrying characters outside the HTTP specification are passed
     * through to targets rather than removed, which is the raw material for request smuggling
     * and header injection against whatever parses them downstream.
     *
     * Applied to the external balancer only. The internal one receives connections from the web
     * tier and from nothing else, and by the time a request reaches it the external balancer has
     * already sanitised it. See docs/adr/0024-drop-invalid-header-fields.md.
     */
    const { template } = synth();
    const schemes = balancersByScheme(template);

    const attributes = (balancer: { LoadBalancerAttributes: { Key: string; Value: string }[] }) =>
      Object.fromEntries(balancer.LoadBalancerAttributes.map((a) => [a.Key, a.Value]));

    expect(attributes(schemes['internet-facing'])).toMatchObject({
      'routing.http.drop_invalid_header_fields.enabled': 'true',
    });
  });

  test('never open their own security group, which the CDK does by default', () => {
    /**
     * The trap in this layer, and the closest thing it has to layer 2's discarded egress rule.
     *
     * `addListener` defaults `open` to true, and that is not a no-op: it calls
     * `connections.allowDefaultPortFrom(Peer.anyIpv4())` on the balancer's own security group.
     * On the internal balancer that writes `CidrIp: 0.0.0.0/0` into `internalAlbSg` — the group
     * whose entire purpose is to accept the web tier and nothing else.
     *
     * Verified against 2.269.0: with `open` left alone the internal group gains an inline
     * `0.0.0.0/0` rule on the listener port; with `open: false` it gains nothing.
     *
     * Layer 2's premise assertion catches it as well, because two groups would then accept an
     * address. This one states it locally, where the cause is.
     */
    const { template } = synth();

    const withInlineCidr = Object.values(
      template.findResources('AWS::EC2::SecurityGroup'),
    ).filter((group) => group.Properties.SecurityGroupIngress !== undefined);

    expect(withInlineCidr).toHaveLength(1);
    expect(withInlineCidr[0].Properties.GroupDescription).toContain('External load balancer');
  });
});

describe('the target groups', () => {
  test('are two, empty, and say what they will hold', () => {
    /**
     * `targetType` is explicit because the groups are empty until layer 5, and an empty target
     * group without it raises a CDK warning that the ADR-0016 assertion fails the suite over.
     * Probed both directions against 2.269.0: one warning without, none with.
     */
    const { template } = synth();

    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);

    for (const group of Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
    )) {
      expect(group.Properties.TargetType).toBe('instance');
      expect(group.Properties.Targets).toBeUndefined();
      expect(group.Properties.Port).toBe(PORTS.frontend);
      expect(group.Properties.Protocol).toBe('HTTP');
    }
  });

  test('ask for /health, never for /', () => {
    // `/` returns 200 from a web tier whose backend is unreachable. The check would report on
    // the web server, which was never the question. See docs/adr/0019.
    const { template } = synth();

    for (const group of Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
    )) {
      expect(group.Properties.HealthCheckPath).toBe(HEALTH_CHECK.path);
      expect(group.Properties.HealthCheckPath).not.toBe('/');
    }
  });

  test('carry every timing explicitly, so none of them can revert to a default', () => {
    /**
     * The unusual assertion, and the most valuable one here.
     *
     * Every other test in this file reads a value that exists. This one asserts the values are
     * present *at all*, because the CDK derives each health check property from the
     * `healthCheck` prop and emits nothing when it is absent. A target group written without
     * the block deploys perfectly, with 150 seconds to enter service and 300 seconds of
     * deregistration, and neither the TypeScript nor the CloudFormation says so.
     *
     * See docs/adr/0017-write-health-check-timings-out.md.
     */
    const { template } = synth();

    for (const group of Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'),
    )) {
      expect(group.Properties).toMatchObject({
        HealthCheckIntervalSeconds: HEALTH_CHECK.interval.toSeconds(),
        HealthCheckTimeoutSeconds: HEALTH_CHECK.timeout.toSeconds(),
        HealthyThresholdCount: HEALTH_CHECK.healthyThresholdCount,
        UnhealthyThresholdCount: HEALTH_CHECK.unhealthyThresholdCount,
      });

      expect(group.Properties.TargetGroupAttributes).toEqual(
        expect.arrayContaining([
          {
            Key: 'deregistration_delay.timeout_seconds',
            Value: String(DEREGISTRATION_DELAY.toSeconds()),
          },
        ]),
      );
    }
  });
});

describe('the external listener and the rule that has to agree with it', () => {
  // The coupling from docs/adr/0018. The listener port and the security group's CIDR rule are
  // one decision seen from two resources, and they live in two files. Asserted in BOTH modes,
  // because a conditional only ever exercised one way is an untested branch.

  /** The port the external balancer's own group accepts from the internet. */
  function externalCidrRulePort(template: Template): number {
    const withInlineCidr = Object.values(template.findResources('AWS::EC2::SecurityGroup')).filter(
      (group) => group.Properties.SecurityGroupIngress !== undefined,
    );

    expect(withInlineCidr).toHaveLength(1);
    return withInlineCidr[0].Properties.SecurityGroupIngress[0].FromPort as number;
  }

  test('without a certificate: HTTP, and the group opens the same port', () => {
    const { template } = synth();
    const listener = listenerOn(template, balancersByScheme(template)['internet-facing'].id);

    expect(listener.Port).toBe(PORTS.http);
    expect(listener.Protocol).toBe('HTTP');
    expect(listener.Certificates).toBeUndefined();

    expect(externalCidrRulePort(template)).toBe(PORTS.http);
    expect(externalCidrRulePort(template)).toBe(publicPort(undefined));
  });

  test('with a certificate: HTTPS, the certificate attached, and the group follows', () => {
    const { template } = synth({ certificateArn: CERTIFICATE_ARN });
    const listener = listenerOn(template, balancersByScheme(template)['internet-facing'].id);

    expect(listener.Port).toBe(PORTS.https);
    expect(listener.Protocol).toBe('HTTPS');
    expect(listener.Certificates).toEqual([{ CertificateArn: CERTIFICATE_ARN }]);

    expect(externalCidrRulePort(template)).toBe(PORTS.https);
    expect(externalCidrRulePort(template)).toBe(publicPort(CERTIFICATE_ARN));
  });

  test('pins a TLS policy, and not the one whose name says RECOMMENDED', () => {
    /**
     * The same disappearing act as the health check timings, on the one surface facing the
     * internet: with no `sslPolicy`, the CDK emits no `SslPolicy` property and ELB applies
     * `ELBSecurityPolicy-2016-08`, which still negotiates TLS 1.0 and 1.1. The value is in
     * neither the TypeScript nor the template.
     *
     * The second half of this assertion is the trap. `SslPolicy.RECOMMENDED` *is*
     * `ELBSecurityPolicy-2016-08` — the enum member named for the right answer holds the
     * default you were trying to escape. `RECOMMENDED_TLS` is the modern one.
     *
     * See docs/adr/0022-pin-the-tls-policy.md.
     */
    const { template } = synth({ certificateArn: CERTIFICATE_ARN });
    const listener = listenerOn(template, balancersByScheme(template)['internet-facing'].id);

    expect(listener.SslPolicy).toBeDefined();
    expect(listener.SslPolicy).not.toBe('ELBSecurityPolicy-2016-08');
    expect(listener.SslPolicy).toBe(elbv2.SslPolicy.RECOMMENDED_TLS);
  });

  test('leaves port 80 shut when there is a certificate, rather than redirecting', () => {
    // A consequence turned into a decision. http:// gets a timeout, not a 301, because no
    // listener and no rule exist on 80. See docs/adr/0023-no-redirect-listener.md.
    const { template } = synth({ certificateArn: CERTIFICATE_ARN });
    const external = balancersByScheme(template)['internet-facing'].id;

    const listeners = Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::Listener'),
    ).filter((listener) => listener.Properties.LoadBalancerArn?.Ref === external);

    expect(listeners).toHaveLength(1);
    expect(listeners[0].Properties.Port).toBe(PORTS.https);

    const rules = Object.values(template.findResources('AWS::EC2::SecurityGroup'))
      .flatMap((group) => group.Properties.SecurityGroupIngress ?? [])
      .map((rule: { FromPort: number }) => rule.FromPort);

    expect(rules).toEqual([PORTS.https]);
    expect(rules).not.toContain(PORTS.http);
  });

  test('the internal listener is unaffected by the certificate either way', () => {
    // PORTS.internal is the internal balancer's listener port and has its own lifetime. If a
    // later layer puts TLS inside the VPC it changes for its own reasons, not for this one.
    for (const props of [undefined, { certificateArn: CERTIFICATE_ARN }]) {
      const { template } = synth(props);
      const listener = listenerOn(template, balancersByScheme(template).internal.id);

      expect(listener.Port).toBe(PORTS.internal);
      expect(listener.Protocol).toBe('HTTP');
    }
  });
});

describe('the stack as a whole', () => {
  test('still synthesizes without a single warning annotation, in both modes', () => {
    // Inherited from docs/adr/0016 and not free here: two empty target groups without an
    // explicit targetType are two warnings. See docs/adr/0020.
    for (const props of [undefined, { certificateArn: CERTIFICATE_ARN }]) {
      const warnings = Annotations.fromStack(synth(props).stack).findWarning('*', Match.anyValue());

      expect(warnings).toEqual([]);
    }
  });
});
