import { resolveEnvironment } from '../lib/environment';

/**
 * These assertions guard against a silent fallback, not a wrong value.
 *
 * The generated `env: { account: process.env.CDK_DEFAULT_ACCOUNT, ... }` degrades to an
 * environment-agnostic stack when either variable is missing, and an environment-agnostic
 * synthesis still succeeds. The failure is invisible until someone reads the template.
 * docs/adr/0010-resolve-the-deployment-environment-from-the-cli.md
 */

const RESOLVED = { CDK_DEFAULT_ACCOUNT: '111122223333', CDK_DEFAULT_REGION: 'us-east-1' };

describe('resolveEnvironment', () => {
  test('returns the account and region the CDK CLI resolved from the credentials', () => {
    expect(resolveEnvironment(RESOLVED)).toEqual({
      account: '111122223333',
      region: 'us-east-1',
    });
  });

  test.each([
    ['account', 'CDK_DEFAULT_ACCOUNT'],
    ['region', 'CDK_DEFAULT_REGION'],
  ])('refuses to resolve when the %s is missing', (_label, variable) => {
    const incomplete = { ...RESOLVED, [variable]: undefined };

    // Not `toBeUndefined` on a partial result: a half-populated environment is the failure
    // mode, because the CDK treats it the same as no environment at all.
    expect(() => resolveEnvironment(incomplete)).toThrow(variable);
  });

  test('rejects an empty string, which is absent wearing a disguise', () => {
    // An unset AWS region surfaces as '' rather than undefined often enough that a truthiness
    // check is the only one worth making here.
    expect(() => resolveEnvironment({ ...RESOLVED, CDK_DEFAULT_REGION: '' })).toThrow();
  });

  test('explains that the CDK CLI is what populates these, not the shell', () => {
    // The actionable part of the message. Anyone hitting this assumed they had to export the
    // variables by hand, or export them and then run the app outside `npx cdk`.
    expect(() => resolveEnvironment({})).toThrow(/cdk/i);
  });
});
