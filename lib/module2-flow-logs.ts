import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  FlowLogAggregationSeconds,
  FlowLogRetentionDays,
  MODULE_2_FLOW_LOGS,
} from './config';

/**
 * `RetentionInDays` and `RetentionDays` happen to share the same numbers (1, 3, 7...), so a cast
 * from `MODULE_2_FLOW_LOGS.retentionDays` to `logs.RetentionDays` would compile and only fail
 * once a bad value reaches a real deploy. The `Record` is exhaustive over
 * `FlowLogRetentionDays` in both directions: adding `365` to that union without a matching case
 * here is a type error naming ADR-0035's "disposable instrument", not a surprise bill. See D5.
 */
const RETENTION: Record<FlowLogRetentionDays, logs.RetentionDays> = {
  1: logs.RetentionDays.ONE_DAY,
  3: logs.RetentionDays.THREE_DAYS,
  7: logs.RetentionDays.ONE_WEEK,
};

/** Same reasoning as RETENTION, for `ec2.FlowLogMaxAggregationInterval` — see D5. */
const AGGREGATION: Record<FlowLogAggregationSeconds, ec2.FlowLogMaxAggregationInterval> = {
  60: ec2.FlowLogMaxAggregationInterval.ONE_MINUTE,
  600: ec2.FlowLogMaxAggregationInterval.TEN_MINUTES,
};

export interface FlowLogsProps {
  /** The VPC the flow log is attached to, via `FlowLogResourceType.fromVpc`. */
  readonly vpc: ec2.IVpc;
}

/**
 * The evidence flow log: minimal, disposable, and scoped to module 2's own measurements.
 * Module 5 owns durable observability separately — see docs/adr/0035.
 */
export class FlowLogs extends Construct {
  /**
   * Ours, not CDK's. `FlowLogDestination.toCloudWatchLogs()` with no log group creates one with
   * `RemovalPolicy.RETAIN` and two-year retention: it survives `cdk destroy` and bills storage
   * for two years from a property nobody wrote (G2-05).
   */
  public readonly logGroup: logs.LogGroup;

  /**
   * Built with `new ec2.FlowLog(this, ...)`, never `vpc.addFlowLog(...)`. The latter scopes the
   * resource to the VPC construct, which lives in `Net-M1` — calling it from here would put
   * `AWS::EC2::FlowLog` in module 1's template and invert the reference direction. Only
   * `vpc.vpcId` crosses the stack seam; the resource itself stays in `Net-M2`.
   */
  public readonly flowLog: ec2.FlowLog;

  constructor(scope: Construct, id: string, props: FlowLogsProps) {
    super(scope, id);

    const { vpc } = props;

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: RETENTION[MODULE_2_FLOW_LOGS.retentionDays],

      // Disposable evidence, not a durable record. Without this, the default log group
      // survives `cdk destroy Net-M2` and keeps billing storage — see this field's own comment
      // above for the exact cost.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.flowLog = new ec2.FlowLog(this, 'All', {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(this.logGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
      maxAggregationInterval: AGGREGATION[MODULE_2_FLOW_LOGS.aggregationIntervalSeconds],

      // The default log format carries neither `pkt-dstaddr` nor `flow-direction`, and both are
      // what make a NACL REJECT direction-attributable rather than just a count. Built from the
      // default fields plus the two this module actually needs, not a from-scratch list — a
      // from-scratch list silently drops whatever the CDK's default picks up next release.
      logFormat: [
        ec2.LogFormat.VERSION,
        ec2.LogFormat.ACCOUNT_ID,
        ec2.LogFormat.INTERFACE_ID,
        ec2.LogFormat.SRC_ADDR,
        ec2.LogFormat.DST_ADDR,
        ec2.LogFormat.SRC_PORT,
        ec2.LogFormat.DST_PORT,
        ec2.LogFormat.PROTOCOL,
        ec2.LogFormat.PACKETS,
        ec2.LogFormat.BYTES,
        ec2.LogFormat.START_TIMESTAMP,
        ec2.LogFormat.END_TIMESTAMP,
        ec2.LogFormat.ACTION,
        ec2.LogFormat.LOG_STATUS,
        ec2.LogFormat.PKT_SRC_ADDR,
        ec2.LogFormat.PKT_DST_ADDR,
        ec2.LogFormat.FLOW_DIRECTION,
      ],
    });
  }
}
