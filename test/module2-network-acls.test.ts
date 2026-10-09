import { Template } from 'aws-cdk-lib/assertions';
import { synthModule2 } from './support/synth';

/** Any syntactically valid ACM ARN; nothing resolves it. See test/module1-load-balancers.test.ts. */
const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

/**
 * Every `AWS::EC2::NetworkAclEntry`'s Properties, flattened across both directions. The
 * rule-numbering guarantees (G2-02, G2-03) are about this one list, not about ingress or
 * egress read in isolation.
 */
function entries(template: Template): Record<string, unknown>[] {
  return Object.values(template.findResources('AWS::EC2::NetworkAclEntry')).map(
    (resource) => resource.Properties as Record<string, unknown>,
  );
}

/** The single entry whose Egress flag and TCP port range match, or a test failure if that isn't exactly one. */
function tcpEntry(
  template: Template,
  egress: boolean,
  fromPort: number,
  toPort: number = fromPort,
): Record<string, unknown> {
  const matches = entries(template).filter((entry) => {
    const portRange = entry.PortRange as { From?: number; To?: number } | undefined;
    return entry.Egress === egress && portRange?.From === fromPort && portRange?.To === toPort;
  });

  expect(matches).toHaveLength(1);
  return matches[0];
}

/**
 * These assertions guard the NACL's rule-numbering mechanism (design D2) and its two security
 * gaps (G2-02, G2-03, G2-04, G2-06, G2-07). Every one of them exists because the thing it
 * checks passes `cdk synth` and fails only at deploy, or not at all — the failure mode this
 * whole construct is built to retire. See docs/adr/0033 (rule numbering) and 0034 (ephemeral
 * range).
 */
describe('NetworkAcls', () => {
  test('associates exactly module 1\'s two public subnets, replacing their default NACL (G2-07)', () => {
    // This is the first assertion in this suite that forces CDK to resolve a real value off
    // module 1's `vpc` token — the NetworkAcl's `VpcId` and each association's `SubnetId` — not
    // merely carry `vpc` as an unread object reference through a constructor, which is as far
    // as PR1's skeleton exercised the cross-stack seam. If module 1's `subnetConfiguration`
    // ever grows or shrinks its public subnet count, this count breaks instead of silently
    // leaving a subnet on the permissive, allow-all default NACL.
    const { template } = synthModule2();

    template.resourceCountIs('AWS::EC2::NetworkAcl', 1);
    template.resourceCountIs('AWS::EC2::SubnetNetworkAclAssociation', 2);
  });

  test('every (direction, ruleNumber) pair is unique (G2-02)', () => {
    // A duplicate pair passes `cdk synth` — CloudFormation only rejects it at deploy, with an
    // error naming a rule number and nothing about which construct emitted it.
    const { template } = synthModule2({ deniedSources: ['203.0.113.0/24', '198.51.100.0/24'] });

    const pairs = entries(template).map((entry) => `${entry.Egress}:${entry.RuleNumber}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  test('every DENY ruleNumber is strictly below the lowest ALLOW ruleNumber in its direction (G2-03)', () => {
    // A deny numbered above an allow is dead letter with no error anywhere: CloudFormation
    // accepts it, the deploy succeeds, and the only symptom is a request from a denied source
    // that succeeds when it should not.
    const { template } = synthModule2({ deniedSources: ['203.0.113.0/24', '198.51.100.0/24'] });

    const ingress = entries(template).filter((entry) => entry.Egress === false);
    const denyNumbers = ingress
      .filter((entry) => entry.RuleAction === 'deny')
      .map((entry) => entry.RuleNumber as number);
    const allowNumbers = ingress
      .filter((entry) => entry.RuleAction === 'allow')
      .map((entry) => entry.RuleNumber as number);

    expect(denyNumbers.length).toBeGreaterThan(0);
    expect(Math.max(...denyNumbers)).toBeLessThan(Math.min(...allowNumbers));
  });

  test('the deny band throws once exhausted, rather than numbering a 91st deny inside the allow band', () => {
    // Without this throw, G2-03 is reintroduced by the very mechanism meant to prevent it: a
    // 91st denied CIDR would silently take rule number 100 and sit above every ALLOW. No error
    // anywhere — the symptom is a request from a denied source that succeeds when it should not.
    const tooManyDeniedSources = Array.from({ length: 91 }, (_, index) => `10.0.${index}.0/32`);

    expect(() => synthModule2({ deniedSources: tooManyDeniedSources })).toThrow(/deny band exhausted/i);
  });

  test('default deniedSources ([]) produces zero DENY entries', () => {
    const { template } = synthModule2();

    const denies = entries(template).filter((entry) => entry.RuleAction === 'deny');
    expect(denies).toHaveLength(0);
  });

  test.each([
    ['without a certificate', undefined, 80],
    ['with a certificate', CERTIFICATE_ARN, 443],
  ])('ingress ALLOW follows the resolved public port, %s', (_name, certificateArn, expectedPort) => {
    // The failure mode a hardcoded `tcp/80` ingress rule produces: with a certificate the
    // external listener binds 443, the rule matches nothing, and every request is blackholed by
    // a stateless filter that names neither the listener nor the security group (ADR-0018).
    const { template } = synthModule2(
      {},
      certificateArn === undefined ? undefined : { certificateArn },
    );

    tcpEntry(template, false, expectedPort);
  });

  test('ingress ALLOW tcp 1024-65535 is present (G2-04)', () => {
    // Module 1's instance is in a private subnet (module1-compute.ts) — its own replies never
    // reach this public NACL. What does arrive here, on this exact range, is the NAT gateway's
    // and the external ALB's own ephemeral source ports: the NAT's reply to an instance's
    // outbound HTTPS, and the ALB's own forwarding and health-check connections. AWS fixes a NAT
    // gateway's source-port range at 1024-65535 regardless of any client's operating system — a
    // client-independent reason for the full range, not the client ephemeral-port observation
    // the lab leans on.
    const { template } = synthModule2();

    tcpEntry(template, false, 1024, 65535);
  });

  test('the ICMP entries carry the literal { type: -1, code: -1 } (G2-06)', () => {
    // There is no `AclTraffic.allIcmp()`. `{ type: -1, code: -1 }` is the only way to express
    // "all ICMP", and nothing stops a future edit from typing a real type/code by accident.
    const { template } = synthModule2();

    const icmpEntries = entries(template).filter(
      (entry) => (entry.Icmp as { Type?: number; Code?: number } | undefined) !== undefined,
    );

    expect(icmpEntries.length).toBeGreaterThanOrEqual(2); // at least one ingress, one egress
    for (const entry of icmpEntries) {
      expect(entry.Icmp).toEqual({ Type: -1, Code: -1 });
    }
  });

  test.each([[true], [false]])(
    'egress tcp 1024-65535 is present only when openEphemeralEgress is %s, and the other egress rules keep their numbers either way',
    (openEphemeralEgress) => {
      const { template } = synthModule2({ openEphemeralEgress });

      const ephemeralEgress = entries(template).filter((entry) => {
        const portRange = entry.PortRange as { From?: number; To?: number } | undefined;
        return entry.Egress === true && portRange?.From === 1024 && portRange?.To === 65535;
      });
      expect(ephemeralEgress).toHaveLength(openEphemeralEgress ? 1 : 0);

      // The no-renumber invariant design D2 exists to guarantee: a running counter would shift
      // the surviving rules down the moment the ephemeral slot above them disappears, and
      // `RuleNumber` is replace-on-update in CloudFormation, so the old and new entries coexist
      // mid-update and collide with whichever rule already holds the lower number.
      expect(tcpEntry(template, true, 443).RuleNumber).toBe(110);
      expect(tcpEntry(template, true, 80).RuleNumber).toBe(120); // publicPort, no certificate here
    },
  );

  test('egress always allows tcp/443, the public port, and ICMP', () => {
    const { template } = synthModule2();

    tcpEntry(template, true, 443);
    tcpEntry(template, true, 80); // publicPort with no certificate
    const icmpEgress = entries(template).filter(
      (entry) =>
        entry.Egress === true &&
        (entry.Icmp as { Type?: number; Code?: number } | undefined) !== undefined,
    );
    expect(icmpEgress).toHaveLength(1);
  });
});
