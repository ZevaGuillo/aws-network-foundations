#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Module1Stack } from '../lib/module1-stack';
import { Runtime } from '../lib/module1-compute';
import { resolveEnvironment } from '../lib/environment';

const app = new cdk.App();

/**
 * `npx cdk deploy -c runtime=node`, and nothing else reads context in this repository.
 *
 * The runtime is the one value that has to change between two deployments of the same stack,
 * because the difference between them is what layer 4 measures
 * (docs/adr/0025-the-runtime-is-a-deployment-property.md). Everything else that varies is a
 * stack property set in code, and this is a stack property too — context is only how the value
 * reaches it from a command line.
 *
 * Unrecognised values throw rather than falling back. A typo that silently deployed Python
 * while the operator believed they were timing Node would corrupt the only number this layer
 * produces, and nothing about the deployment would look wrong.
 */
function runtimeFromContext(): Runtime | undefined {
  const value = app.node.tryGetContext('runtime');

  if (value === undefined) return undefined;
  if (value === 'python' || value === 'node') return value;

  throw new Error(`Unknown runtime "${value}". Use -c runtime=python or -c runtime=node.`);
}

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
new Module1Stack(app, 'Net-M1', {
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

  /** Undefined means the stack's own default, which is Python. */
  runtime: runtimeFromContext(),
});
