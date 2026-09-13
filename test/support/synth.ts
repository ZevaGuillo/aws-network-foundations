import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { Module1Stack, Module1StackProps } from '../../lib/module1-stack';

export interface Synthesized {
  /** Needed for annotation assertions, which read the construct tree rather than the template. */
  readonly stack: Module1Stack;
  readonly template: Template;
}

/**
 * Synthesizes the stack **environment-agnostic**, which is the mode
 * docs/adr/0010-resolve-the-deployment-environment-from-the-cli.md exists to prevent. The
 * deliberate exception is worth stating, because it is the first thing to look wrong here.
 *
 * No `env` is passed, so `resolveEnvironment` is never called and availability zones render as
 * `Fn::Select[n, Fn::GetAZs '']` rather than `us-east-1a` and `us-east-1b`. That is on purpose:
 * a test suite that required credentials would be a test suite most readers cannot run, and
 * ADR-0010's argument is about what gets *deployed*, not about what gets asserted.
 *
 * It is safe only because no assertion depends on a concrete zone. They count subnets, match
 * CIDR masks, follow route tables, walk the security group chain and compare configuration
 * values — all of which are identical in both modes.
 *
 * **The day one does depend on a zone, this helper has to take a fixed test environment**
 * (`env: { account: '123456789012', region: 'us-east-1' }`), because an `Fn::GetAZs` token
 * cannot be asserted against. The same applies to anything region-dependent: see the service
 * name in the S3 endpoint test, which is an `Fn::Join` here and a plain string once an
 * environment is pinned.
 *
 * Returns the stack alongside the template because `Annotations.fromStack` needs the construct
 * tree — the security group suite asserts on warnings, which never reach the template.
 */
export function synth(props?: Module1StackProps): Synthesized {
  const app = new cdk.App();
  const stack = new Module1Stack(app, 'TestStack', props);

  return { stack, template: Template.fromStack(stack) };
}
