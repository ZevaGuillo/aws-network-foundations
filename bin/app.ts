#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Module1BaseNetworkStack } from '../lib/module1-base-network-stack';
import { resolveEnvironment } from '../lib/environment';

const app = new cdk.App();

/**
 * The second argument is the construct id, and for a stack directly under the app it becomes
 * the CloudFormation stack name verbatim. It is the one identifier in this file that cannot be
 * changed later: renaming a deployed stack does not rename it, it creates a second one and
 * leaves the first behind holding every resource.
 *
 * `Net-M1-Base` names the module rather than the repository, because the repository will hold
 * five of these and `AwsNetworkFoundationsStack` would not distinguish any of them.
 *
 * See docs/adr/0011-name-stacks-by-module-before-the-first-deploy.md.
 */
new Module1BaseNetworkStack(app, 'Net-M1-Base', {
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
