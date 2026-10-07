#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Module1Stack } from '../lib/module1-stack';
import { Module2Stack } from '../lib/module2-stack';
import { MODULE_2_NACL } from '../lib/config';
import { resolveEnvironment } from '../lib/environment';

const app = new cdk.App();

/**
 * The second argument is the construct id, and for a stack directly under the app it becomes
 * the CloudFormation stack name verbatim. It is the one identifier in this file that cannot be
 * changed later: renaming a deployed stack does not rename it, it creates a second one and
 * leaves the first behind holding every resource.
 *
 * `Net-M1` names the module rather than the repository, because the repository will hold five
 * of these and `AwsNetworkFoundationsStack` would not distinguish any of them.
 *
 * The name stops at the module and does not continue into the layer. All five of module 1's
 * layers deploy into this one stack, so a `-Base` suffix would have been false from the moment
 * layer 2 landed — and by then it would have been permanent.
 *
 * See docs/adr/0014-one-stack-per-module.md, and
 * docs/adr/0011-name-stacks-by-module-before-the-first-deploy.md for the deadline itself.
 */
const m1 = new Module1Stack(app, 'Net-M1', {
  /**
   * The account and region this stack is specialized for, read from the credentials the CDK
   * CLI resolved rather than written here.
   *
   * An account id is not a secret, but it is reconnaissance material — enough to enumerate
   * role and bucket names — and this repository is meant to be read publicly. Resolving it
   * keeps it out of the history, and lets the same source deploy from any profile.
   *
   * Specifying `env` at all is what makes `maxAzs: 2` mean two concrete availability zones.
   * Without it the stack is environment-agnostic: zones become an `Fn::GetAZs` placeholder
   * chosen at deploy time and context lookups return dummy values.
   *
   * See docs/adr/0010-resolve-the-deployment-environment-from-the-cli.md.
   */
  env: resolveEnvironment(process.env),
});

/**
 * `Net-M2` — a from-scratch NACL over module 1's public subnets, plus the evidence flow log
 * that makes its ACCEPT/REJECT decisions measurable. Built from `m1`'s VPC and resolved public
 * port **by object reference**, not by a second `certificateArn` or a repeated `publicPort()`
 * call: see `Module2StackProps.publicPort` for what a second, independently-derived answer
 * would cost the moment the two drift. See docs/adr/0014-one-stack-per-module.md and
 * docs/adr/0032-module-2-own-stack.md.
 *
 * `deniedSources` and `openEphemeralEgress` thread `MODULE_2_NACL`'s own defaults through
 * explicitly rather than leaving them to `NetworkAcls`' internal fallback. Both already resolve
 * to the same value either way; writing them here is what makes E1 (editing `deniedSources`)
 * and E2 (`openEphemeralEgress: false`) one-line config edits in `lib/config.ts` instead of a
 * second place to remember this call exists.
 */
new Module2Stack(app, 'Net-M2', {
  vpc: m1.vpc,
  publicPort: m1.publicPort,
  deniedSources: MODULE_2_NACL.deniedSources,
  openEphemeralEgress: MODULE_2_NACL.openEphemeralEgress,
  env: resolveEnvironment(process.env),
});
