import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { Construct } from 'constructs';
import { PORTS, SecurityGroups } from './module1-security-groups';
import { LoadBalancers } from './module1-load-balancers';

/** The runtime the tiers run under. See docs/adr/0025-the-runtime-is-a-deployment-property.md. */
export type Runtime = 'python' | 'node';

/**
 * Python, because every default in this repository is the cheap, fast, self-contained one.
 * Amazon Linux 2023 ships it, so a default deployment downloads nothing at boot.
 */
export const DEFAULT_RUNTIME: Runtime = 'python';

/** systemd unit name, shared by the unit file and the command that starts it. */
export const SERVICE_NAME = 'module1-app';

/** Where the boot script puts the application. */
export const APP_DIR = '/opt/app';

/**
 * The smallest thing that can run an HTTP server, because nothing here is under load.
 *
 * Two of these add roughly $15/month to a module already at roughly $65. That is small next to
 * the balancers and the NAT, and it is still the third line in this module that costs money by
 * existing rather than by being used.
 */
export const INSTANCE_TYPE = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO);

/**
 * What separates the two runtimes, and it is deliberately almost nothing.
 *
 * `install` is the entire experiment. Amazon Linux 2023 ships Python and does not ship Node, so
 * the Node column pays for a `dnf install` — minutes of boot time, and bytes through the NAT
 * Gateway at the $0.045/GB docs/adr/0008-s3-gateway-endpoint.md already wrote down. Everything
 * else about the two deployments is identical, which is what makes the comparison one variable.
 */
const RUNTIMES = {
  python: {
    source: 'server.py',
    interpreter: '/usr/bin/python3',
    install: undefined,
  },
  node: {
    source: 'server.js',
    interpreter: '/usr/bin/node',
    install: 'dnf install -y nodejs',
  },
} as const;

/**
 * The application, read from disk at synth time.
 *
 * `lib/app/server.py` and `lib/app/server.js` are real, runnable programs rather than template
 * literals in this file. A literal cannot be linted, cannot be run, and hides a syntax error
 * until an instance boots cleanly in a private subnet and serves nothing. A file can be executed
 * before anything is deployed.
 *
 * This is also why the application lives here and not in lib/config.ts: that module imports
 * nothing and touches nothing, which is the point of it
 * (docs/adr/0005-framework-free-configuration-module.md), and reading from disk is a dependency.
 */
function applicationSource(runtime: Runtime): string {
  return fs.readFileSync(path.join(__dirname, 'app', RUNTIMES[runtime].source), 'utf8');
}

interface BootScriptOptions {
  readonly runtime: Runtime;
  readonly tier: string;
  readonly port: number;
  /** Frontend only. Its absence is what makes a process a backend. */
  readonly backendUrl?: string;
}

/**
 * The boot script, and the shape of it is the decision.
 *
 * It writes the application and a systemd unit, starts the unit, and **exits**. It does not run
 * the server. A foreground process means cloud-init never returns: today nothing asks, and in
 * layer 5 an auto scaling group's creation policy would wait for a signal that cannot arrive,
 * failing as a timeout that names an auto scaling group rather than a boot script.
 *
 * `Restart=always` is what makes systemd worth the indirection. It survives the session that
 * started it — a process launched from a shell can take SIGHUP with it, leaving an instance that
 * is up, answers SSH, and serves nothing — and it comes back from a crash.
 *
 * `set -x` traces every command into /var/log/cloud-init-output.log, which is the only place a
 * boot failure surfaces. The instance still boots when this script fails; only the service is
 * missing, the target never turns healthy, and nothing names the cause.
 *
 * Kept small and idempotent on purpose. Changing user data produces a new launch template
 * version and does not touch running instances, so the cure is replacement — and replacement
 * only stays affordable while booting is fast.
 *
 * See docs/adr/0027-user-data-terminates-systemd-owns-the-process.md.
 */
function bootScript(options: BootScriptOptions): string {
  const { runtime, tier, port, backendUrl } = options;
  const { interpreter, source, install } = RUNTIMES[runtime];

  const environment = [`Environment=PORT=${port}`, `Environment=TIER=${tier}`];
  if (backendUrl !== undefined) {
    environment.push(`Environment=BACKEND_URL=${backendUrl}`);
  }

  return [
    '#!/bin/bash',
    'set -euxo pipefail',
    '',
    ...(install === undefined ? [] : [install, '']),
    `mkdir -p ${APP_DIR}`,
    `cat > ${APP_DIR}/${source} <<'MODULE1_APPLICATION'`,
    applicationSource(runtime).trimEnd(),
    'MODULE1_APPLICATION',
    '',
    `cat > /etc/systemd/system/${SERVICE_NAME}.service <<'MODULE1_UNIT'`,
    '[Unit]',
    `Description=Module 1 ${tier} tier`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    ...environment,
    `ExecStart=${interpreter} ${APP_DIR}/${source}`,
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'MODULE1_UNIT',
    '',
    'systemctl daemon-reload',
    // The last line, and it returns. An assertion checks exactly this.
    `systemctl enable --now ${SERVICE_NAME}.service`,
  ].join('\n');
}

export interface ComputeProps {
  readonly vpc: ec2.IVpc;

  /** The chain from layer 2. Each tier wears its own group; the endpoint wears `eice`. */
  readonly securityGroups: SecurityGroups;

  /** Layer 3. The tiers register in its target groups and the frontend reaches its internal balancer. */
  readonly loadBalancers: LoadBalancers;

  /** Defaults to `DEFAULT_RUNTIME`. */
  readonly runtime?: Runtime;
}

/**
 * Module 1, layer 4 — the application.
 *
 * Two launch templates, one instance each, and the administrative path layer 2 wrote rules for
 * two layers ago. This is the first layer that produces something other than infrastructure: the
 * difference in boot time between the two runtimes, which is measured rather than estimated and
 * becomes layer 5's warm-up figure.
 *
 * The instances are fixed and there is no scaling here. Layer 5 replaces them with auto scaling
 * groups built from these same launch templates — the launch template is the unit of boot
 * behaviour, so what is measured here is what layer 5 inherits.
 *
 * See docs/plans/module1-layer4-application.md.
 */
export class Compute extends Construct {
  /** One policy: Session Manager. The application reads no AWS API, so it may not. */
  public readonly role: iam.Role;

  public readonly frontendLaunchTemplate: ec2.LaunchTemplate;
  public readonly backendLaunchTemplate: ec2.LaunchTemplate;

  /** Replaced by an auto scaling group in layer 5. */
  public readonly frontend: ec2.CfnInstance;
  public readonly backend: ec2.CfnInstance;

  /** The only way into a private subnet. No L2 construct exists for it. */
  public readonly instanceConnectEndpoint: ec2.CfnInstanceConnectEndpoint;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);

    const { vpc, securityGroups, loadBalancers } = props;
    const runtime = props.runtime ?? DEFAULT_RUNTIME;

    const privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;

    /**
     * One managed policy and no inline statements.
     *
     * Session Manager is not a convenience here. Every place a boot failure surfaces —
     * /var/log/cloud-init-output.log, `journalctl -u`, `cloud-init analyze blame` — is
     * unreachable from the console, and these instances have no public address by
     * docs/adr/0012-never-auto-assign-public-ipv4-addresses.md. Without this, a tier that boots
     * and serves nothing cannot be diagnosed at all.
     *
     * Nothing else is attached. The application answers HTTP and, on the frontend, calls another
     * HTTP endpoint; it touches no AWS API, so it gets no permission to. A role that grows
     * quietly is a role nobody audits, which is why the assertion compares an exact list rather
     * than checking for containment.
     *
     * See docs/adr/0028-require-imdsv2.md.
     */
    this.role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Module 1 tiers: Session Manager only',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const launchTemplateFor = (
      tier: 'frontend' | 'backend',
      securityGroup: ec2.ISecurityGroup,
      port: number,
      backendUrl?: string,
    ) =>
      new ec2.LaunchTemplate(this, `${tier === 'frontend' ? 'Frontend' : 'Backend'}Template`, {
        machineImage: ec2.MachineImage.latestAmazonLinux2023(),
        instanceType: INSTANCE_TYPE,
        securityGroup,
        role: this.role,
        userData: ec2.UserData.custom(bootScript({ runtime, tier, port, backendUrl })),

        /**
         * Not the default, and the default is the problem.
         *
         * `requireImdsv2` is false unless asked. Left alone the instance answers IMDSv1: an
         * unauthenticated GET to a fixed link-local address that returns this role's temporary
         * credentials. That is the classic escalation from a server-side request forgery bug in
         * an application — an image proxy, a webhook validator, a URL preview — to working AWS
         * credentials, with no code execution required. IMDSv2 requires a PUT for a token first,
         * which a GET-only primitive cannot perform.
         *
         * `httpPutResponseHopLimit` is deliberately left alone. It already defaults to 1, which
         * stops the metadata response crossing a network hop, and nothing outside this file
         * depends on it — so docs/adr/0009-declare-dns-support-explicitly.md's exception does not
         * apply and restating it would be noise. It is recorded in ADR-0028 instead.
         */
        requireImdsv2: true,
      });

    /**
     * The frontend learns where the backend is at deploy time, not at build time.
     *
     * `loadBalancerDnsName` is a token CloudFormation resolves during the deploy, so this creates
     * a real ordering dependency from this launch template to the internal balancer. There is no
     * cycle — the internal balancer depends on the backend target group, which depends on nothing
     * here.
     *
     * It is a balancer's name and not an instance address, which is the whole point: replacing
     * the backend instance changes nothing the frontend holds.
     *
     * It is baked at first boot, so changing it means replacing the instance. Reading it from
     * SSM Parameter Store instead would buy a change without replacement, at the cost of an IAM
     * permission, a network call in the boot path and a second home for configuration — not
     * worth it for a value that only changes when the balancer is recreated.
     */
    const backendUrl = `http://${loadBalancers.internal.loadBalancerDnsName}:${PORTS.internal}`;

    this.frontendLaunchTemplate = launchTemplateFor(
      'frontend',
      securityGroups.frontend,
      PORTS.frontend,
      backendUrl,
    );

    this.backendLaunchTemplate = launchTemplateFor(
      'backend',
      securityGroups.backend,
      PORTS.backend,
    );

    const instanceFrom = (name: string, launchTemplate: ec2.LaunchTemplate) =>
      new ec2.CfnInstance(this, `${name}Instance`, {
        launchTemplate: {
          launchTemplateId: launchTemplate.launchTemplateId,
          version: launchTemplate.latestVersionNumber,
        },

        // First private subnet, and one availability zone is all this proves. Anything about
        // availability needs layer 5, which is also where the second zone starts to matter.
        subnetId: privateSubnets[0],
      });

    this.frontend = instanceFrom('Frontend', this.frontendLaunchTemplate);
    this.backend = instanceFrom('Backend', this.backendLaunchTemplate);

    // Layer 3 built these empty and said so. This is the seam moving: a launch template nothing
    // launches from has no boot time to measure.
    loadBalancers.frontendTargets.addTarget(
      new targets.InstanceIdTarget(this.frontend.ref, PORTS.frontend),
    );
    loadBalancers.backendTargets.addTarget(
      new targets.InstanceIdTarget(this.backend.ref, PORTS.backend),
    );

    /**
     * An L1, because there is no L2. Confirmed against aws-cdk-lib 2.269.0: aws-ec2 ships
     * client-vpn constructs and nothing for instance connect.
     *
     * That has a consequence beyond ergonomics. An L1 has no `Connections` object, so nothing in
     * the type system links this endpoint to the two SSH rules in module1-security-groups.ts that
     * name its group. The link exists in ADR-0030 and in an assertion, and nowhere else.
     *
     * `preserveClientIp: false` is already the CloudFormation default and is written out anyway,
     * which is the clearest case in this repository of the narrow exception from
     * docs/adr/0009-declare-dns-support-explicitly.md: the value is load-bearing for something
     * outside the file that sets it. Set it to true and packets arrive carrying the client's
     * address rather than this endpoint's interface, both SSH rules match nothing, and the only
     * administrative path into a private subnet closes with a timeout that names nothing.
     *
     * See docs/adr/0030-instance-connect-endpoint-keeps-the-client-ip-off.md.
     */
    this.instanceConnectEndpoint = new ec2.CfnInstanceConnectEndpoint(this, 'Eice', {
      subnetId: privateSubnets[0],
      securityGroupIds: [securityGroups.eice.securityGroupId],
      preserveClientIp: false,
    });
  }
}
