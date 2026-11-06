/**
 * Preload for rendering docs/images/demo.svg: stdout passes for a 100-column 24-bit terminal at a fixed time on the
 * demo's Tuesday, so the grid shows today's column and the entry running now. See AGENTS.md "Common Commands".
 */

import { writeSync } from 'node:fs';

const FIXED = new Date('2026-11-03T13:40:00').getTime();

for (const name of Object.keys(process.env)) if (/^(AI_AGENT|OPENCODE|CLAUDECODE|CODEX_.*)$/.test(name)) delete process.env[name];
Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 60, getColorDepth: () => 24, hasColors: () => true });

const RealDate = Date;
globalThis.Date = class extends RealDate {
    constructor (...args: Array<string | number | Date>) {
        super(...(args.length ? args as [string] : [FIXED]));
    }

    static now (): number {
        return FIXED;
    }
} as DateConstructor;

const chunks: Array<string> = [];
process.stdout.write = ((chunk: string | Uint8Array) => chunks.push(String(chunk)) > 0) as typeof process.stdout.write;
process.on('exit', () => writeSync(1, `${chunks.join('').trim()}\n`));
