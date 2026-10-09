import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { Module1Stack, Module1StackProps } from '../../lib/module1-stack';
import { Module2Stack, Module2StackProps } from '../../lib/module2-stack';

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

export interface SynthesizedModule2 {
  /** For "module 1 is untouched" assertions — compared against `synth()`'s own template. */
  readonly module1: Module1Stack;
  readonly stack: Module2Stack;
  readonly template: Template;
}

/**
 * Module 2 cannot be synthesized alone: its required props, `vpc` and `publicPort`, are object
 * references into a real `Module1Stack`. A generic `synth<T>(ctor, props)` is not a
 * generalisation of `synth()` above — it would push this two-stack wiring into every module 2
 * test file, the exact duplication this helper exists to prevent. `synth()` keeps its name,
 * signature and return type; this is an addition, not a rename.
 *
 * The default wiring — `vpc: module1.vpc`, `publicPort: module1.publicPort` — is the production
 * wiring from `bin/app.ts`, so a test exercising the real seam needs no `props` at all. `props`
 * stays a `Partial<Module2StackProps>` so a test can override `publicPort` on its own without
 * touching module 1 — the shape a future mutation test (certificate set, port left at 80) needs
 * to exist and be shown to turn a NACL suite red.
 *
 * Both stacks stay environment-agnostic, on the same exception `synth()` documents above.
 * **Open question, carried from design**: whether CDK permits a cross-stack reference between
 * two environment-agnostic stacks in one `App` is expected to work and is exercised the moment
 * a later construct reads a token off `vpc` (e.g. `vpc.vpcId`) into a resource property. If
 * that ever throws, the fix is a fixed test environment on both stacks —
 * `env: { account: '123456789012', region: 'us-east-1' }` — the same fallback `synth()` already
 * documents for a zone-dependent assertion.
 */
export function synthModule2(
  props?: Partial<Module2StackProps>,
  module1Props?: Module1StackProps,
): SynthesizedModule2 {
  const app = new cdk.App();
  const module1 = new Module1Stack(app, 'TestStackM1', module1Props);
  const stack = new Module2Stack(app, 'TestStackM2', {
    vpc: module1.vpc,
    publicPort: module1.publicPort,
    ...props,
  });

  return { module1, stack, template: Template.fromStack(stack) };
}
