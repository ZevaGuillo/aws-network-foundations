import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { NetworkAcls } from './module2-network-acls';
import { FlowLogs } from './module2-flow-logs';

export interface Module2StackProps extends cdk.StackProps {
  /**
   * Module 1's VPC, by object reference from the same App. Required, which is why `props` is
   * required here and optional on Module1StackProps: this stack cannot exist without module 1,
   * and the type should say so rather than letting it synthesize into nothing.
   */
  readonly vpc: ec2.IVpc;

  /**
   * From `m1.publicPort` — the port module 1's external listener actually bound. See
   * `NetworkAclsProps.publicPort` for what a wrong value here would cost once the NACL reads it.
   */
  readonly publicPort: number;

  /** See `NetworkAclsProps.deniedSources`. Defaults to `[]` inside `NetworkAcls` itself. */
  readonly deniedSources?: readonly string[];

  /** See `NetworkAclsProps.openEphemeralEgress`. Defaults to `true` inside `NetworkAcls` itself. */
  readonly openEphemeralEgress?: boolean;
}

/**
 * Module 2 — a from-scratch NACL over module 1's public subnets, plus the evidence flow log
 * that makes its ACCEPT/REJECT decisions measurable. A second stack in the same `App`
 * (docs/adr/0014-one-stack-per-module.md), built from module 1's VPC by reference rather than
 * recreating any part of layer 1.
 */
export class Module2Stack extends cdk.Stack {
  public readonly networkAcls: NetworkAcls;
  public readonly flowLogs: FlowLogs;

  constructor(scope: Construct, id: string, props: Module2StackProps) {
    super(scope, id, props);

    this.networkAcls = new NetworkAcls(this, 'NetworkAcls', {
      vpc: props.vpc,

      // By subnetType, never by subnetGroupName — see NetworkAclsProps.subnets for what that
      // string coupling would cost on a rename.
      subnets: { subnetType: ec2.SubnetType.PUBLIC },

      publicPort: props.publicPort,
      deniedSources: props.deniedSources,
      openEphemeralEgress: props.openEphemeralEgress,
    });

    this.flowLogs = new FlowLogs(this, 'FlowLogs', { vpc: props.vpc });

    this.declareOutputs(props);
  }

  /**
   * What a reader needs in their hand the moment `Net-M2` finishes deploying — the same
   * reasoning `Module1Stack.declareOutputs` gives for its own table, applied to this stack's
   * evidence. Plain `CfnOutput`s, never exported (ADR-0014's `weak` setting already covers the
   * two values this stack reads *from* module 1; nothing here is meant to be read by a third
   * stack, so none of these need an export either).
   *
   * Each row mirrors one line of `evidencia-modulo2.md`'s infrastructure table (design D7).
   */
  private declareOutputs(props: Module2StackProps): void {
    const openEphemeralEgress = props.openEphemeralEgress ?? true;
    const deniedSources = props.deniedSources ?? [];

    const outputs: Record<string, { value: string; description: string }> = {
      NetworkAclId: {
        value: this.networkAcls.acl.networkAclId,
        description: 'E1 edits this NACL; also the id describe-network-acls needs',
      },
      PublicSubnetIds: {
        value: cdk.Fn.join(',', [...this.networkAcls.associatedSubnetIds]),
        description: 'The subnets that stopped using the default NACL (G2-07 evidence)',
      },
      FlowLogId: {
        value: this.flowLogs.flowLog.flowLogId,
        description: "The flow log this NACL's ACCEPT/REJECT decisions are measured through",
      },
      FlowLogGroupName: {
        value: this.flowLogs.logGroup.logGroupName,
        description: 'For aws logs filter-log-events when reading the evidence back',
      },
      PublicIngressPort: {
        value: String(props.publicPort),
        description: 'Makes a desynchronised deploy readable in one line instead of a template',
      },
      EphemeralEgressOpen: {
        value: String(openEphemeralEgress),
        description: 'Which E2 branch is live — the fact that prevents measuring the wrong deploy',
      },
      DeniedSources: {
        // The default is empty, and an output rendering as an empty string is not worth the
        // risk of looking broken — 'none' says in one word what a blank value would make
        // someone go check the template to confirm.
        value: deniedSources.length > 0 ? deniedSources.join(', ') : 'none',
        description: "E1's input CIDRs, or 'none' while the default empty list is in effect",
      },
    };

    for (const [name, { value, description }] of Object.entries(outputs)) {
      new cdk.CfnOutput(this, name, { value, description });
    }
  }
}
