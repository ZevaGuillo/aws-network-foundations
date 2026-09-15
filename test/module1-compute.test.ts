import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { PORTS } from '../lib/module1-security-groups';
import { SERVICE_NAME } from '../lib/module1-compute';
import { synth } from './support/synth';

/**
 * These assertions guard the compute tiers, and as in every layer before it each one exists
 * because the thing it checks fails without producing an error.
 *
 * An application bound to the loopback address answers an SSH session perfectly while every
 * probe fails. A launch template that answers IMDSv1 is not broken, only easier to rob. A boot
 * script whose last command is the server leaves cloud-init waiting forever, and the symptom
 * surfaces in layer 5 as an auto scaling group that times out. None of that turns a template
 * red on its own.
 *
 * docs/adr/0026-the-application-contract.md
 * docs/adr/0027-user-data-terminates-systemd-owns-the-process.md
 * docs/adr/0028-require-imdsv2.md
 * docs/adr/0029-the-deep-check-is-a-reachability-probe.md
 * docs/adr/0030-instance-connect-endpoint-keeps-the-client-ip-off.md
 * docs/adr/0031-one-runtime-node.md
 */

const APPLICATION = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'app', 'server.js'),
  'utf8',
);

/** The one logical id of `type` whose own id contains `fragment`. */
function logicalIdFor(template: Template, type: string, fragment: string): string {
  const matches = Object.keys(template.findResources(type)).filter((id) => id.includes(fragment));

  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Logical id of the security group whose description matches, as in the layer 2 suite. */
function groupIdFor(template: Template, descriptionFragment: string): string {
  const matches = Object.entries(template.findResources('AWS::EC2::SecurityGroup')).filter(
    ([, resource]) => String(resource.Properties.GroupDescription).includes(descriptionFragment),
  );

  expect(matches).toHaveLength(1);
  return matches[0][0];
}

/**
 * The boot script as written, with unresolved tokens stringified in place.
 *
 * The CDK renders user data as `Fn::Base64` over either a plain string or an `Fn::Join` when a
 * token is interpolated. Keeping the token as JSON rather than dropping it is what lets the
 * frontend's reference to the internal balancer be asserted.
 */
function userDataOf(template: Template, launchTemplateLogicalId: string): string {
  const resources = template.findResources('AWS::EC2::LaunchTemplate');
  const encoded = resources[launchTemplateLogicalId].Properties.LaunchTemplateData.UserData;
  const inner = encoded['Fn::Base64'];

  if (typeof inner === 'string') return inner;

  return (inner['Fn::Join'][1] as unknown[])
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join('');
}

function launchTemplates(template: Template) {
  return {
    frontend: logicalIdFor(template, 'AWS::EC2::LaunchTemplate', 'Frontend'),
    backend: logicalIdFor(template, 'AWS::EC2::LaunchTemplate', 'Backend'),
  };
}

describe('the launch templates', () => {
  test('are two, each wearing the security group of the tier it launches', () => {
    // A tier launched into the wrong group is unreachable, or reachable by the wrong thing, and
    // both deploy cleanly.
    const { template } = synth();
    const ids = launchTemplates(template);
    const resources = template.findResources('AWS::EC2::LaunchTemplate');

    expect(Object.keys(resources)).toHaveLength(2);

    const groupsOn = (id: string) =>
      (resources[id].Properties.LaunchTemplateData.SecurityGroupIds as { 'Fn::GetAtt': string[] }[])
        .map((ref) => ref['Fn::GetAtt'][0]);

    expect(groupsOn(ids.frontend)).toEqual([groupIdFor(template, 'Web tier')]);
    expect(groupsOn(ids.backend)).toEqual([groupIdFor(template, 'Application tier')]);
  });

  test('require IMDSv2, which is not what the CDK does by default', () => {
    /**
     * `requireImdsv2` defaults to false. Left alone the instance answers IMDSv1 — an
     * unauthenticated GET to a fixed link-local address returning the role's credentials, which
     * is the classic escalation from a server-side request forgery bug in the application.
     *
     * Nothing fails when this reverts. The instance simply becomes easier to rob.
     *
     * See docs/adr/0028-require-imdsv2.md.
     */
    const { template } = synth();
    const resources = template.findResources('AWS::EC2::LaunchTemplate');

    for (const id of Object.values(launchTemplates(template))) {
      expect(resources[id].Properties.LaunchTemplateData.MetadataOptions).toMatchObject({
        HttpTokens: 'required',
      });
    }
  });
});

describe('the instance role', () => {
  test('holds Session Manager and nothing else', () => {
    // Asserted as an exact list rather than a containment check, so a policy attached
    // "temporarily" turns this red. A role that grows quietly is a role nobody audits.
    const { template } = synth();

    const instanceRoles = Object.values(template.findResources('AWS::IAM::Role')).filter((role) =>
      JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes('ec2.amazonaws.com'),
    );

    expect(instanceRoles).toHaveLength(1);

    const policies = instanceRoles[0].Properties.ManagedPolicyArns as unknown[];
    expect(policies).toHaveLength(1);
    expect(JSON.stringify(policies[0])).toContain('AmazonSSMManagedInstanceCore');
  });
});

describe('the Instance Connect Endpoint', () => {
  test('keeps the client IP off, or layer 2 loses both its SSH rules', () => {
    /**
     * Layer 2 wrote two SSH rules naming `eiceSg` as their source and carried this forward as an
     * open question. With `PreserveClientIp` true, packets arrive carrying the client's address
     * instead of the endpoint's interface, both rules match nothing, and the only administrative
     * path into a private subnet closes — with a timeout that names no security group.
     *
     * See docs/adr/0030-instance-connect-endpoint-keeps-the-client-ip-off.md.
     */
    const { template } = synth();
    const endpoints = Object.values(template.findResources('AWS::EC2::InstanceConnectEndpoint'));

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].Properties.PreserveClientIp).toBe(false);
    expect(
      (endpoints[0].Properties.SecurityGroupIds as { 'Fn::GetAtt': string[] }[]).map(
        (ref) => ref['Fn::GetAtt'][0],
      ),
    ).toEqual([groupIdFor(template, 'Instance Connect Endpoint')]);
  });
});

describe('the boot script', () => {
  test('writes a systemd unit and ends by starting it, never by running the server', () => {
    /**
     * If the last command is the application in the foreground, cloud-init never returns. Today
     * nothing asks; in layer 5 an auto scaling group's creation policy waits for a signal that
     * cannot arrive, and the failure reads as a timeout on the auto scaling group rather than on
     * a boot script.
     *
     * See docs/adr/0027-user-data-terminates-systemd-owns-the-process.md.
     */
    const { template } = synth();

    for (const id of Object.values(launchTemplates(template))) {
      const script = userDataOf(template, id);

      expect(script).toContain('Restart=always');
      expect(script).toContain(`[Unit]`);

      const lastCommand = script.trimEnd().split('\n').pop();
      expect(lastCommand).toBe(`systemctl enable --now ${SERVICE_NAME}.service`);
    }
  });

  test('gives each tier the port its target group polls, read from the constants', () => {
    // A port that drifts from the target group is a tier that is never healthy. The value
    // travels from PORTS into the systemd unit, so there is one place it can be wrong.
    const { template } = synth();
    const ids = launchTemplates(template);

    expect(userDataOf(template, ids.frontend)).toContain(`Environment=PORT=${PORTS.frontend}`);
    expect(userDataOf(template, ids.backend)).toContain(`Environment=PORT=${PORTS.backend}`);
  });

  test('points the frontend at the internal balancer, and the backend at nothing', () => {
    // The dependency direction. A backend reaching the frontend is the chain running backwards,
    // and it would deploy perfectly.
    const { template } = synth();
    const ids = launchTemplates(template);
    const internalAlb = logicalIdFor(template, 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'Internal');

    // Asserted on the systemd `Environment=` line rather than on the bare name. The application
    // source is embedded in this script, and its own docstring shows a local run with
    // BACKEND_URL set — so a loose substring matches both tiers. This test found that itself,
    // the first time it ran.
    const frontend = userDataOf(template, ids.frontend);
    expect(frontend).toContain('Environment=BACKEND_URL=');
    expect(frontend).toContain(internalAlb);
    expect(frontend).toContain(`:${PORTS.internal}`);

    const backend = userDataOf(template, ids.backend);
    expect(backend).not.toContain('Environment=BACKEND_URL=');
    expect(backend).not.toContain(internalAlb);
  });

  test('installs the runtime, because the AMI does not ship it', () => {
    /**
     * Amazon Linux 2023 ships Python and does not ship Node, so this line is on every launch,
     * every scale-out and every instance refresh. It is the cost ADR-0031 accepted when the
     * second runtime was removed before the comparison was ever run.
     *
     * Without it, `ExecStart` points at an interpreter that is not on the instance. systemd
     * retries forever under `Restart=always`, the target never turns healthy, and nothing
     * names the missing package.
     */
    const { template } = synth();

    for (const id of Object.values(launchTemplates(template))) {
      expect(userDataOf(template, id)).toContain('dnf install -y nodejs');
    }
  });
});

describe('the applications', () => {
  test('binds every interface, never the loopback', () => {
    /**
     * The assertion that reads a source file rather than a template, and the only mechanical way
     * to catch this.
     *
     * An application bound to the loopback address answers `curl` from an SSH session every
     * time, while the health check — which arrives from the balancer's network interface, across
     * the subnet — fails on every probe. The cause is one string in one file; the symptom is a
     * balancer with no healthy targets, three resources away, with nothing in any log naming a
     * bind address.
     *
     * The forbidden literal is why the comments in those files say "loopback" in words.
     *
     * See docs/adr/0026-the-application-contract.md.
     */
    expect(APPLICATION).toContain('0.0.0.0');
    expect(APPLICATION).not.toContain('127.0.0.1');
  });

  test('never retypes the port it listens on', () => {
    // The port arrives from PORTS through the systemd unit. A literal here is a second place for
    // it to be wrong, and the two would not fail together.
    expect(APPLICATION).not.toContain(String(PORTS.frontend));
    expect(APPLICATION).toContain('PORT');
  });

  test('requires nothing outside the standard library', () => {
    // Every required name is compared against an allowlist rather than pattern-matched for
    // "looks external", because `require('http')` looks external to most such patterns — which
    // is how the first version of this test passed while being wrong.
    //
    // A dependency has to be added here deliberately, and the reasons to keep it at zero
    // outlived the runtime comparison that was the first of them: ADR-0026's 16 KB headroom,
    // the cost of a slow instance refresh, and a boot that already pays for one download it
    // cannot avoid.
    const allowed = ['http', 'os'];
    const required = [...APPLICATION.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);

    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => !allowed.includes(name))).toEqual([]);
  });
});

describe('the tiers', () => {
  test('are one instance each, registered in the target group in front of them', () => {
    // Registered in the wrong one and the internet reaches the application tier, with every
    // health check passing.
    const { template } = synth();

    const instances = template.findResources('AWS::EC2::Instance');
    expect(Object.keys(instances)).toHaveLength(2);

    const frontendInstance = logicalIdFor(template, 'AWS::EC2::Instance', 'Frontend');
    const backendInstance = logicalIdFor(template, 'AWS::EC2::Instance', 'Backend');
    const groups = template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup');

    const targetsOf = (fragment: string) => {
      const id = logicalIdFor(template, 'AWS::ElasticLoadBalancingV2::TargetGroup', fragment);
      return groups[id].Properties.Targets;
    };

    expect(targetsOf('FrontendTargets')).toEqual([
      { Id: { Ref: frontendInstance }, Port: PORTS.frontend },
    ]);
    expect(targetsOf('BackendTargets')).toEqual([
      { Id: { Ref: backendInstance }, Port: PORTS.backend },
    ]);
  });

  test('launch from the launch templates rather than carrying their own configuration', () => {
    // The seam with layer 5. The launch template is the unit of boot behaviour, so the auto
    // scaling groups that replace these instances inherit exactly what was measured here.
    const { template } = synth();
    const ids = launchTemplates(template);
    const instances = template.findResources('AWS::EC2::Instance');

    for (const [id, instance] of Object.entries(instances)) {
      const expected = id.includes('Frontend') ? ids.frontend : ids.backend;

      expect(instance.Properties.LaunchTemplate.LaunchTemplateId).toEqual({ Ref: expected });
      expect(instance.Properties.ImageId).toBeUndefined();
      expect(instance.Properties.UserData).toBeUndefined();
    }
  });
});

describe('the stack as a whole', () => {
  test('still synthesizes without a single warning annotation', () => {
    const warnings = Annotations.fromStack(synth().stack).findWarning('*', Match.anyValue());

    expect(warnings).toEqual([]);
  });
});
