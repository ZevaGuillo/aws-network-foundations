/**
 * Resolution of the account and region a stack is deployed into.
 *
 * Like the address plan, this module imports no CDK runtime — only a type — so the rule it
 * enforces can be tested without synthesizing anything. See
 * docs/adr/0005-framework-free-configuration-module.md.
 */

import type { Environment } from 'aws-cdk-lib/core';

/**
 * Populated by the CDK CLI, not by the shell. `npx cdk <command>` resolves the credentials,
 * then sets these on the child process that runs the app.
 */
const ACCOUNT_VARIABLE = 'CDK_DEFAULT_ACCOUNT';
const REGION_VARIABLE = 'CDK_DEFAULT_REGION';

/**
 * The account and region for this deployment, or an error explaining why there is neither.
 *
 * The generated app template offers `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region:
 * process.env.CDK_DEFAULT_REGION }`, which is correct when the variables resolve and silently
 * wrong when they do not: `env` becomes `{ account: undefined, region: undefined }`, which the
 * CDK treats as no environment at all. Synthesis still succeeds. Deployment still succeeds.
 * What changes is that availability zones become the `Fn::GetAZs` placeholder resolved at
 * deploy time, so `maxAzs: 2` stops describing two known zones — and context lookups, which
 * need a real account to query, quietly return dummy values instead.
 *
 * Throwing converts that into a failure at the only moment it is cheap to fix.
 *
 * @param processEnv the environment variables to read — passed in rather than read from
 *   `process` so the rule is testable without mutating global state.
 */
export function resolveEnvironment(processEnv: Record<string, string | undefined>): Environment {
  const account = processEnv[ACCOUNT_VARIABLE];
  const region = processEnv[REGION_VARIABLE];

  // Truthiness, not a null check: an unset AWS region arrives as an empty string often enough
  // that treating '' as present would reintroduce the failure this function exists to remove.
  if (!account || !region) {
    const missing = [
      account ? undefined : ACCOUNT_VARIABLE,
      region ? undefined : REGION_VARIABLE,
    ].filter(Boolean);

    throw new Error(
      `Cannot resolve the deployment environment: ${missing.join(' and ')} not set.\n\n` +
        'The CDK CLI sets both from your credentials when it runs this app, so they are ' +
        'present under `npx cdk synth|diff|deploy` and absent when the entry point is run ' +
        'directly. If you are running a cdk command, the credentials are not resolving — ' +
        'check `aws sts get-caller-identity` and `aws configure get region`.\n\n' +
        'This app refuses to continue without them. Falling back to an environment-agnostic ' +
        'stack succeeds loudly enough to look correct while replacing the availability zones ' +
        'with a deploy-time placeholder.',
    );
  }

  return { account, region };
}
