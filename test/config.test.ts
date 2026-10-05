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
});
