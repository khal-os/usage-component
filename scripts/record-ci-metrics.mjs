#!/usr/bin/env node
/**
 * Emits ONE ndjson line for the ci-metrics branch (decision 146) — the
 * baseline/history store the PR dashboard reads. Zero-dependency.
 *
 *   node scripts/record-ci-metrics.mjs coverage   # from a main CI run
 *   node scripts/record-ci-metrics.mjs images     # from a main Docker run
 *
 * Env: GITHUB_SHA; JOBS_JSON (optional, coverage mode — job durations);
 * IMAGE_METRICS_DIR (images mode, default image-metrics).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const line = {
  sha: (process.env.GITHUB_SHA ?? '').slice(0, 7),
  date: new Date().toISOString(),
};

if (mode === 'coverage') {
  line.packages = {};
  for (const name of ['core', 'module', 'connector']) {
    const s = readJson(
      join(root, 'packages', name, 'coverage', 'coverage-summary.json'),
    );
    if (!s) continue;
    line.packages[name] = Object.fromEntries(
      ['lines', 'statements', 'branches', 'functions'].map((m) => [
        m,
        s.total[m]?.pct,
      ]),
    );
  }
  const jobs =
    process.env.JOBS_JSON && readJson(join(root, process.env.JOBS_JSON));
  if (jobs?.jobs) {
    line.durations = {};
    for (const j of jobs.jobs)
      if (j.completed_at && j.started_at && j.conclusion === 'success')
        line.durations[j.name] =
          (new Date(j.completed_at) - new Date(j.started_at)) / 1000;
  }
} else if (mode === 'images') {
  const dir = join(root, process.env.IMAGE_METRICS_DIR ?? 'image-metrics');
  line.images = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const m = readJson(join(dir, f));
    if (m?.image)
      line.images[m.image] = {
        size: m.size,
        critical: m.critical,
        high: m.high,
      };
  }
} else {
  console.error('usage: record-ci-metrics.mjs <coverage|images>');
  process.exit(1);
}

console.log(JSON.stringify(line));
