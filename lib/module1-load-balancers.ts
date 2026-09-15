import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { PORTS, SecurityGroups, publicPort } from './module1-security-groups';

/**
 * What the balancer asks a target, and how patiently.
 *
 * All five values are overrides. Elastic Load Balancing supplies every one of them if you do
 * not, and the defaults are expensive in a way nothing in the repository would show:
 *
 *     interval 30s, healthyThresholdCount 5   ->  150s before a new instance serves a request
 *     interval 30s, unhealthyThresholdCount 2 ->   60s of traffic sent to a dead one
 *
 * They are invisible because the CDK derives every health check property from this block and
 * emits *nothing* when the block is absent. A target group written the short way produces
 * CloudFormation containing no timing at all, so the 150 seconds are in neither the TypeScript
 * nor the template. The same shape as three NAT Gateways from a line of code with no numbers.
 *
 * These numbers are right for infrastructure deployed, measured and destroyed the same day, and
 * they are not production numbers. A 10 second interval with a threshold of 2 will flap under
 * load: a target that is briefly slow fails two probes, leaves service, and moves its share of
 * traffic onto targets that are already struggling.
 *
 * `interval` must be greater than or equal to `timeout`; the CDK validates it and fails synth.
 *
 * See docs/adr/0017-write-health-check-timings-out.md.
 */
export const HEALTH_CHECK = {
  /**
   * Shallow on purpose. The default is `/`, which returns 200 from a web tier whose backend is
   * unreachable, so the check reports on the web server and never on the application.
   *
   * What it deliberately does not do is call the backend. That instinct builds a cascade: the
   * backend degrades, every frontend target fails, the target group reaches zero healthy
   * targets, and the balancer then *fails open* and routes to all of them anyway. Traffic
   * flows exactly as before, and the one signal worth having - which tier actually broke - is
   * gone. The dependency check is a separate path nothing here calls.
   *
   * Layer 4 is not finished until something serves this. The infrastructure states the
   * contract; the application obeys it.
   *
   * See docs/adr/0019-shallow-health-check-at-the-balancer.md.
   */
  path: '/health',

  interval: cdk.Duration.seconds(10),
  timeout: cdk.Duration.seconds(5),
  healthyThresholdCount: 2,
  unhealthyThresholdCount: 2,
} as const;

/**
 * How long a target keeps receiving in-flight requests after it leaves the group.
 *
 * The default is 300 seconds: five minutes of waiting per batch, on every deployment and every
 * `cdk destroy`, which is the loop this repository is built around.
 *
 * Thirty seconds buys that back and cuts anything still in flight past it - a long poll, a
 * large upload, a slow report. Production accepts the five minutes deliberately.
 */
export const DEREGISTRATION_DELAY = cdk.Duration.seconds(30);

export interface LoadBalancersProps {
  readonly vpc: ec2.IVpc;

  /** The chain from layer 2. The balancers wear two of these groups and talk to two more. */
  readonly securityGroups: SecurityGroups;

  /**
   * ACM certificate ARN for the external listener. Absent means HTTP on 80.
   *
   * See docs/adr/0018-the-certificate-is-optional.md.
   */
  readonly certificateArn?: string;
}

/**
 * Module 1, layer 3 - the balancers.
 *
 * Two Application Load Balancers, two listeners, two target groups, and the target groups are
 * empty because the instances that fill them arrive in layer 5. Same discipline as layer 2:
 * define the structure once, attach later. A target group with no targets is valid, deploys
 * cleanly, and reports zero healthy targets, which is the correct state for a tier that does
 * not exist yet rather than a failure.
 *
 *     the internet
 *          |
 *     external ALB    public subnets, listener on publicPort()
 *          |  forward
 *     frontend TG     :8080, GET /health        <- layer 5 registers the web tier here
 *
 *     internal ALB    private subnets, listener on PORTS.internal
 *          |  forward
 *     backend TG      :8080, GET /health        <- layer 5 registers the app tier here
 *
 * The listener port and the target port differ on both balancers, and the pairs are easy to
 * swap by accident. Each listener port must be what its balancer's security group accepts; each
 * target port must be what the tier's group accepts from that balancer. Getting either backwards
 * produces a deploy that succeeds and a request that times out.
 *
 * See docs/plans/module1-layer3-load-balancers.md.
 */
export class LoadBalancers extends Construct {
  /** Faces the internet. Wears `securityGroups.externalAlb`. */
  public readonly external: elbv2.ApplicationLoadBalancer;

  /** Reachable only from inside the VPC, and only by the web tier. */
  public readonly internal: elbv2.ApplicationLoadBalancer;

  /** Empty until layer 5 registers the web tier's auto scaling group. */
  public readonly frontendTargets: elbv2.ApplicationTargetGroup;

  /** Empty until layer 5 registers the application tier's auto scaling group. */
  public readonly backendTargets: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: LoadBalancersProps) {
    super(scope, id);

    const { vpc, securityGroups, certificateArn } = props;

    /**
     * `targetType` is explicit on both groups, and it has to be.
     *
     * Normally the CDK infers it from the first target registered. These have no targets until
     * layer 5, so there is nothing to infer from, and `validateTargetGroup` raises a warning
     * saying so - which the deliberately broad annotation assertion from
     * docs/adr/0016-ingress-only-while-egress-stays-open.md fails the whole suite over.
     *
     * It is also the right annotation on its own merits: these will hold EC2 instances, not IP
     * addresses and not a Lambda function, and the CDK's own warning says the condition may
     * become an error in a future version.
     *
     * See docs/adr/0020-empty-target-groups-declare-their-target-type.md.
     */
    const targetGroupDefaults = {
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      deregistrationDelay: DEREGISTRATION_DELAY,
      healthCheck: {
        path: HEALTH_CHECK.path,
        interval: HEALTH_CHECK.interval,
        timeout: HEALTH_CHECK.timeout,
        healthyThresholdCount: HEALTH_CHECK.healthyThresholdCount,
        unhealthyThresholdCount: HEALTH_CHECK.unhealthyThresholdCount,
      },
    };

    // No `targetGroupName` on either group. A generated name cannot collide, and an explicit
    // one is capped at 32 characters - a limit that is discovered at deploy time.
    this.frontendTargets = new elbv2.ApplicationTargetGroup(this, 'FrontendTargets', {
      ...targetGroupDefaults,
      port: PORTS.frontend,
    });

    this.backendTargets = new elbv2.ApplicationTargetGroup(this, 'BackendTargets', {
      ...targetGroupDefaults,
      port: PORTS.backend,
    });

    /**
     * Access logs are deliberately absent from both balancers.
     *
     * They are how you prove what actually reached what, which is squarely this repository's
     * subject - and they need an S3 bucket with a policy granting the regional ELB account
     * write access, which is a layer of its own rather than a property. Deferred, and recorded
     * as deferred in docs/plans/module1-layer3-load-balancers.md section 11 so it is not
     * mistaken for something nobody thought about.
     */
    this.external = new elbv2.ApplicationLoadBalancer(this, 'External', {
      vpc,
      internetFacing: true,
      securityGroup: securityGroups.externalAlb,

      // Follows from `internetFacing` today. Stated because a balancer's subnets decide who can
      // reach it, and an inference is a poor place for that to live.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },

      /**
       * Default `false`, which forwards headers containing characters outside the HTTP
       * specification to the targets rather than removing them. That is the raw material for
       * request smuggling and header injection: the balancer and whatever parses the request
       * downstream disagree about where a header ends, and the disagreement is the exploit.
       *
       * On the external balancer only. The internal one is reached by the web tier and by
       * nothing else, and anything arriving there has already passed through this.
       *
       * See docs/adr/0024-drop-invalid-header-fields.md.
       */
      dropInvalidHeaderFields: true,
    });

    this.internal = new elbv2.ApplicationLoadBalancer(this, 'Internal', {
      vpc,
      internetFacing: false,
      securityGroup: securityGroups.internalAlb,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    /**
     * The certificate decides three things at once, so they are built as one value.
     *
     * The CDK rejects an HTTPS listener with no certificate and an HTTP listener carrying one,
     * so protocol, certificates and TLS policy cannot be chosen independently. Writing them as
     * three separate ternaries is how one of them ends up on the wrong side.
     *
     * The port is not here: `publicPort()` is the single place that decision lives, because the
     * external security group has to agree with it from another file entirely. See
     * docs/adr/0018-the-certificate-is-optional.md.
     *
     * `sslPolicy` is the same disappearing act as the health check timings above. Omit it and
     * the CDK emits no `SslPolicy` property at all, so ELB applies `ELBSecurityPolicy-2016-08`
     * — which still negotiates TLS 1.0 and TLS 1.1, on the one surface in this architecture
     * that faces the internet. The value would be in neither the TypeScript nor the template.
     *
     * `RECOMMENDED_TLS`, not `RECOMMENDED`. The enum member named for the right answer is
     * literally `ELBSecurityPolicy-2016-08`: reaching for the obvious name returns the default
     * you were trying to escape, and the diff looks like a fix.
     *
     * See docs/adr/0022-pin-the-tls-policy.md.
     */
    const tls =
      certificateArn === undefined
        ? {
            protocol: elbv2.ApplicationProtocol.HTTP,
            certificates: undefined,
            sslPolicy: undefined,
          }
        : {
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
            sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          };

    /**
     * One listener on the external balancer, and with a certificate that means **port 80 does
     * not exist**. Someone typing `http://` gets a timeout rather than a 301.
     *
     * That is a decision, not an oversight, and it has a price worth naming: the usual pattern
     * is a second listener on 80 redirecting to 443, and it does not fit here. `publicPort()`
     * returns *the* port precisely because one number is what makes the listener and the
     * security group rule impossible to desynchronise. A redirect needs two ports open, which
     * turns that single value into a list and weakens the guarantee that made layer 2 safe.
     *
     * So the abstraction that removed one silent failure makes a second one more expensive to
     * remove. Closed is the stricter reading and the honest one while the default mode is HTTP
     * on 80 anyway. See docs/adr/0023-no-redirect-listener.md.
     */
    this.external.addListener('Listener', {
      port: publicPort(certificateArn),
      ...tls,
      defaultTargetGroups: [this.frontendTargets],

      /**
       * The trap in this layer, and it is not a tidiness setting.
       *
       * `open` defaults to true, which calls `allowDefaultPortFrom(Peer.anyIpv4())` on the
       * balancer's own security group. The listener writes a firewall rule. On the internal
       * balancer below that means `CidrIp: 0.0.0.0/0` landing in `internalAlbSg` - the group
       * whose entire purpose is to accept the web tier and nothing else - and the trust chain
       * from docs/adr/0015 is gone with no diff in that file to show it.
       *
       * Layer 2 already stated the internet rule, by identity, once, in one block. This layer
       * does not get to add a second one as a side effect of creating a listener.
       *
       * See docs/adr/0021-listeners-never-open-their-own-security-group.md.
       */
      open: false,
    });

    this.internal.addListener('Listener', {
      port: PORTS.internal,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.backendTargets],
      open: false,
    });
  }
}
