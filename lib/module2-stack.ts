import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface Module2StackProps extends cdk.StackProps {
  /**
   * Module 1's VPC, by object reference from the same App. Required, which is why `props` is
   * required here and optional on Module1StackProps: this stack cannot exist without module 1,
   * and the type should say so rather than letting it synthesize into nothing.
   */
  readonly vpc: ec2.IVpc;

  /**
   * From `m1.publicPort` — the port module 1's external listener actually bound. See
   * `Module1Stack.publicPort` for what a wrong value here would cost once a NACL reads it.
   */
  readonly publicPort: number;
}

/**
 * Module 2 — a from-scratch NACL over module 1's public subnets, plus the evidence flow log
 * that makes its ACCEPT/REJECT decisions measurable. A second stack in the same `App`
 * (docs/adr/0014-one-stack-per-module.md), built from module 1's VPC by reference rather than
 * recreating any part of layer 1.
 *
 * This skeleton carries only the props module 2's later layers need. The NACL and the flow log
 * are later PRs' work.
 */
export class Module2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Module2StackProps) {
    super(scope, id, props);
  }
}
