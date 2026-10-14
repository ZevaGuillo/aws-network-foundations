import * as fs from 'fs';
import * as path from 'path';
import { MODULE_2_NACL } from '../lib/config';

/**
 * Guards docs/adr/0005-framework-free-configuration-module.md for the module 2 additions.
 *
 * A `tsc --noEmit` pass cannot catch a dependency drifting back in here — an unused
 * `import * as ec2 from 'aws-cdk-lib/aws-ec2'` compiles cleanly and only costs something the
 * day a script or a test tries to import this module without the CDK installed. Reading the
 * source as text is what actually proves the constraint instead of assuming it.
 */
describe('module 2 config', () => {
  test('lib/config.ts imports nothing from aws-cdk-lib', () => {
    // Scoped to actual `import` statements, not prose: the file's own header comment says
    // "imports nothing from aws-cdk-lib" in plain English, and a substring match over the
    // whole file would fail on that sentence rather than on a real dependency.
    const source = fs.readFileSync(path.join(__dirname, '../lib/config.ts'), 'utf8');
    const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));

    expect(importLines.some((line) => line.includes('aws-cdk-lib'))).toBe(false);
  });

  test('deniedSources defaults to empty — a plain deploy denies nobody', () => {
    // Zero DENY entries on a fresh deploy (spec: "Denied sources default empty"). E1 editing
    // this array is a deliberate, reviewed change, not shipped policy.
    expect(MODULE_2_NACL.deniedSources).toEqual([]);
  });

  test('openEphemeralEgress defaults to open — a plain deploy is not E2 mid-experiment', () => {
    // The symmetric guard to the one above, and it exists because its absence was measured.
    //
    // E2 sets this to `false` on purpose to script the stateless-egress failure
    // (docs/adr/0036-scripted-breakage-toggle.md). The construct is already proven correct in
    // both branches by `test.each([[true], [false]])` in module2-network-acls.test.ts — but
    // those cases pass explicit values and never read this one, so before this assertion
    // existed nothing in the suite looked at *which* branch was committed.
    //
    // That is not a cosmetic gap. A committed `false` removes `AllowEphemeralOut`, which drops
    // every ALB health check toward the frontend tier because PORTS.frontend = 8080 sits inside
    // the ephemeral range: targets go unhealthy, the balancer serves nothing, and the clone that
    // deployed it sees a timeout naming no resource. A green suite, a clean synth, a successful
    // deploy, and an application that never answers.
    //
    // During the 2026-10-14 run the E2 branch passed all 82 tests, which is what moved this from
    // a checklist line to an assertion — module2/evidence.md §5 E2.0 carries the finding.
    expect(MODULE_2_NACL.openEphemeralEgress).toBe(true);
  });
});
