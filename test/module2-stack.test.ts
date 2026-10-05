import { Module1Stack } from '../lib/module1-stack';
import { Module2Stack } from '../lib/module2-stack';
import { synthModule2 } from './support/synth';

/**
 * Module 2 cannot be synthesized alone — its only required props are `vpc` and `publicPort`,
 * both object references into a real `Module1Stack`. This is the first test exercising that
 * wiring, and therefore the first confirmation (or refutation) of design's open question:
 * whether CDK permits a cross-stack reference between two environment-agnostic stacks in the
 * same `App`. See the design's "Open Questions" and the pinned-environment fallback it
 * documents for the day an assertion needs a concrete zone.
 */
describe('synthModule2', () => {
  test('wires Module2Stack into the same App as a real Module1Stack', () => {
    const { module1, stack, template } = synthModule2();

    expect(module1).toBeInstanceOf(Module1Stack);
    expect(stack).toBeInstanceOf(Module2Stack);
    expect(stack.node.root).toBe(module1.node.root);

    // The skeleton this PR builds composes nothing yet — PR2 adds the NACL, PR3 the flow log.
    // An empty Resources section is the deliberate, temporary shape here, not an accident.
    expect(template.toJSON().Resources ?? {}).toEqual({});
  });

  test('accepts a publicPort override without touching module 1', () => {
    // D6: `Partial<Module2StackProps>` exists so a later mutation test (certificate set, port
    // left at 80) can be written against module 2 alone. Proven here at the prop level, one PR
    // before the NACL exists to read it.
    const { module1 } = synthModule2({ publicPort: 443 });

    expect(module1.publicPort).toBe(80); // module 1 itself saw no certificateArn
  });
});
