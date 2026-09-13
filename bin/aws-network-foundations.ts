#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsNetworkFoundationsStack } from '../lib/aws-network-foundations-stack';
import { resolveEnvironment } from '../lib/environment';

const app = new cdk.App();

new AwsNetworkFoundationsStack(app, 'AwsNetworkFoundationsStack', {
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
