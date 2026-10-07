import * as cdk from 'aws-cdk-lib/core';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
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

    // PR1 left this empty; PR2's NetworkAcls is now wired in, so the stack composes at least
    // one real resource. test/module2-network-acls.test.ts owns the NACL's own shape — this
    // assertion only guards that Module2Stack still wires it in at all.
    template.resourceCountIs('AWS::EC2::NetworkAcl', 1);
  });

  test('accepts a publicPort override without touching module 1', () => {
    // D6: `Partial<Module2StackProps>` exists so a later mutation test (certificate set, port
    // left at 80) can be written against module 2 alone. Proven here at the prop level, one PR
    // before the NACL exists to read it.
    const { module1 } = synthModule2({ publicPort: 443 });

    expect(module1.publicPort).toBe(80); // module 1 itself saw no certificateArn
  });
});

/**
 * Phase 6 — stack completion. `NetworkAcls` and `FlowLogs` are both proven at the construct
 * level already; what is still unverified is the stack-level contract: no synthesis warning
 * reaches a reader (ADR-0016), the evidence table's seven outputs actually exist (design D7),
 * and — the one claim nothing has tested yet — that wiring `Net-M2` into the same `App` leaves
 * `Net-M1`'s own infrastructure untouched.
 */
describe('Module2Stack — completeness', () => {
  test('synthesizes without a single warning annotation (ADR-0016)', () => {
    const { stack } = synthModule2();

    const warnings = Annotations.fromStack(stack).findWarning('*', Match.anyValue());
    expect(warnings).toEqual([]);
  });

  test('declares the seven evidence outputs (design D7)', () => {
    const { template } = synthModule2({ deniedSources: ['203.0.113.0/24'] });

    const outputs = template.toJSON().Outputs ?? {};
    for (const name of [
      'NetworkAclId',
      'PublicSubnetIds',
      'FlowLogId',
      'FlowLogGroupName',
      'PublicIngressPort',
      'EphemeralEgressOpen',
      'DeniedSources',
    ]) {
      expect(outputs).toHaveProperty(name);
    }
  });

  test('DeniedSources output falls back to "none" when the default empty list is in effect', () => {
    const { template } = synthModule2();

    expect(template.toJSON().Outputs.DeniedSources.Value).toBe('none');
  });

  /**
   * The real side-by-side task 6.5 exists for — PR2's `cdk synth Net-M1 --strict` comparison
   * only proved module 1 is unaffected when `bin/app.ts` never instantiates `Net-M2` at all,
   * which never exercises the cross-stack reference. This test puts both stacks in **one**
   * `App`, under the **same** stack ids `bin/app.ts` uses, and reads module 1's template back.
   *
   * Empirical finding, not an assumption: putting `Net-M2` in the app does change `Net-M1`'s
   * template — by exactly three new `Outputs` (`vpc.vpcId` and the two public subnets'
   * `subnetId`), which is the cross-stack reference mechanism itself (ADR-0014's `weak`
   * setting — a plain `Output`, no `Export`), not a mutation of module 1's own infrastructure.
   * `Resources` is confirmed byte-for-byte identical either way; the `Outputs` diff is the price
   * of the reference, not a regression. Both apps below carry the same
   * `@aws-cdk/core:defaultCrossStackReferences: weak` context `cdk.json` sets for the real CLI
   * synth — `jest` never loads `cdk.json` on its own, and without it CDK falls back to strong
   * references (`Fn::ImportValue`/`Export`), which is not what `bin/app.ts` actually produces.
   */
  test("leaves Net-M1's own resources untouched when Net-M2 is present in the same App", () => {
    const weakReferences = { context: { '@aws-cdk/core:defaultCrossStackReferences': 'weak' } };

    const appAlone = new cdk.App(weakReferences);
    const m1Alone = new Module1Stack(appAlone, 'Net-M1', {});
    const aloneResources = Template.fromStack(m1Alone).toJSON().Resources;

    const appBoth = new cdk.App(weakReferences);
    const m1Both = new Module1Stack(appBoth, 'Net-M1', {});
    new Module2Stack(appBoth, 'Net-M2', { vpc: m1Both.vpc, publicPort: m1Both.publicPort });
    const m1BothTemplate = Template.fromStack(m1Both);
    const bothResources = m1BothTemplate.toJSON().Resources;

    // The narrow invariant: module 1's own provisioned infrastructure is unchanged. A full
    // `toJSON()` equality would also compare `Outputs`, and the three new ones there are the
    // cross-stack reference's own bookkeeping (see the comment above), not module 1 drifting.
    expect(bothResources).toEqual(aloneResources);

    // Restated narrowly because it is the one number every deploy of this module gets billed
    // for: one NAT Gateway, same as module 1 alone (docs/adr/0006).
    m1BothTemplate.resourceCountIs('AWS::EC2::NatGateway', 1);

    // The hazard this whole PR exists to retire: `vpc.addFlowLog()` would have put
    // `AWS::EC2::FlowLog` here instead of in `Net-M2`. See test/module2-flow-logs.test.ts for
    // the positive half of this guard (exactly one, on `Net-M2`).
    m1BothTemplate.resourceCountIs('AWS::EC2::FlowLog', 0);
  });
});
