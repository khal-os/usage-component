#!/usr/bin/env node
/**
 * Coverage table for the CI run summary (zero-dependency, like spec-check).
 *
 * Reads each package's coverage/coverage-summary.json (jest 'json-summary'
 * reporter) plus its ratchet thresholds from jest.config.mjs, and writes a
 * markdown table — measured % and the headroom above the ratchet — to
 * $GITHUB_STEP_SUMMARY when present, stdout otherwise. Packages without a
 * coverage file (e.g. the run failed before coverage) are listed as such;
 * this script never fails the build — the ratchet itself lives in jest.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['core', 'module', 'connector'];
const metrics = ['lines', 'statements', 'branches', 'functions'];

const fmt = (pct) => (typeof pct === 'number' ? `${pct.toFixed(2)}%` : '—');

const rows = [];
for (const name of packages) {
  const dir = join(root, 'packages', name);
  const summaryPath = join(dir, 'coverage', 'coverage-summary.json');
  if (!existsSync(summaryPath)) {
    rows.push(`| ${name} | _no coverage file_ | | | | |`);
    continue;
  }
  const total = JSON.parse(readFileSync(summaryPath, 'utf8')).total;
  const { default: jestConfig } = await import(
    pathToFileURL(join(dir, 'jest.config.mjs'))
  );
  const ratchet = jestConfig.coverageThreshold?.global ?? {};
  const cells = metrics.map((m) => {
    const measured = total[m]?.pct;
    const floor = ratchet[m];
    if (typeof measured !== 'number') return '—';
    return typeof floor === 'number'
      ? `${fmt(measured)} (ratchet ${floor})`
      : fmt(measured);
  });
  rows.push(`| ${name} | ${cells.join(' | ')} |`);
}

const out = [
  '### Coverage (ratchet: a drop below the floor fails the run)',
  '',
  `| package | ${metrics.join(' | ')} |`,
  `|---|${metrics.map(() => '---|').join('')}`,
  ...rows,
  '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
} else {
  console.log(out);
}
