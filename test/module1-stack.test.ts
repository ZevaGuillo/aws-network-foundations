import { Template } from 'aws-cdk-lib/assertions';
import { publicPort } from '../lib/module1-security-groups';
import { synth } from './support/synth';

const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

/**
 * Module 2's NACL is about to become the third reader of `publicPort()` (ADR-0018). These
 * guards exist because the field this suite tests is the only sanctioned way module 2 learns
 * which port the external listener bound — a second, independently-computed port anywhere else
 * would let the NACL and the listener disagree, which is a hardcoded-80-against-a-443-listener
 * blackhole with no error naming either resource.
 */
describe('Module1Stack.publicPort', () => {
  test.each([
    ['without a certificate', undefined],
    ['with a certificate', CERTIFICATE_ARN],
  ])('resolves the same port the external listener binds, %s', (_name, certificateArn) => {
    const { stack } = synth(certificateArn === undefined ? undefined : { certificateArn });

    expect(stack.publicPort).toBe(publicPort(certificateArn));
  });

  /**
   * There is deliberately no snapshot here. The "this field changes no resource and no output"
   * requirement was proved once, by approval-testing the template captured before the field
   * landed, and that proof belongs to the change that added it. Keeping the golden afterwards
   * would guard nothing: the field cannot be un-added, while modules 3 to 5 will keep extending
   * this stack legitimately, and every one of those changes would fail a 1468-line snapshot whose
   * only accepted repair is `jest -u`. A test repaired without reading its diff is not a safety
   * net. The durable invariant is the one above: the field agrees with `publicPort()`.
   */
});
