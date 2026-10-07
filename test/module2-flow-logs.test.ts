import { Template } from 'aws-cdk-lib/assertions';
import { MODULE_2_FLOW_LOGS } from '../lib/config';
import { synthModule2 } from './support/synth';

/**
 * Guards the flow log's shape and the one hazard that has no `cdk synth` error of its own:
 * `vpc.addFlowLog()` scopes the resource to the VPC construct, which lives in `Net-M1`. Calling
 * it from `Module2Stack` would put `AWS::EC2::FlowLog` in module 1's template and invert the
 * reference direction module 2 depends on (`Net-M1` consuming `Net-M2`'s log group and IAM
 * role) — see design D (addFlowLog scoping finding) and
 * docs/adr/0032-module-2-own-stack.md.
 */
describe('FlowLogs', () => {
  test('exactly one AWS::EC2::FlowLog exists on Net-M2, and none on Net-M1', () => {
    // `new ec2.FlowLog(this, ..., { resourceType: FlowLogResourceType.fromVpc(vpc) })` keeps the
    // resource scoped to Net-M2 even though it reads `vpc.vpcId` across the stack seam.
    // `vpc.addFlowLog()` would pass that same test wrong — the resource would land on
    // `Template.fromStack(module1)` instead, and this is the only assertion that would catch it.
    const { module1, template } = synthModule2();

    template.resourceCountIs('AWS::EC2::FlowLog', 1);
    Template.fromStack(module1).resourceCountIs('AWS::EC2::FlowLog', 0);
  });

  test('the log group is disposable: explicit retention and DeletionPolicy: Delete (G2-05)', () => {
    // `FlowLogDestination.toCloudWatchLogs()` with no log group creates one with the CDK's
    // default — RemovalPolicy.RETAIN and RetentionDays.TWO_YEARS — which survives `cdk destroy`
    // and bills storage for two years from a property nobody wrote. This module's own log group
    // must override both explicitly.
    const { template } = synthModule2();

    const logGroups = template.findResources('AWS::Logs::LogGroup');
    const resources = Object.values(logGroups);
    expect(resources).toHaveLength(1);

    const [logGroup] = resources;
    expect(logGroup.Properties.RetentionInDays).toBe(MODULE_2_FLOW_LOGS.retentionDays);
    expect(logGroup.DeletionPolicy).toBe('Delete');
  });

  test('traffic type is ALL, aggregation matches config, and the log format names the two evidence fields', () => {
    // `pkt-dstaddr` and `flow-direction` are what make a NACL REJECT direction-attributable in
    // the flow log — the default log format carries neither.
    const { template } = synthModule2();

    template.hasResourceProperties('AWS::EC2::FlowLog', {
      TrafficType: 'ALL',
      MaxAggregationInterval: MODULE_2_FLOW_LOGS.aggregationIntervalSeconds,
    });

    const [flowLog] = Object.values(template.findResources('AWS::EC2::FlowLog'));
    const logFormat = flowLog.Properties.LogFormat as string;
    expect(logFormat).toContain('pkt-dstaddr');
    expect(logFormat).toContain('flow-direction');
  });
});
