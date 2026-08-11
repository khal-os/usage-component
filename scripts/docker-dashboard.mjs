#!/usr/bin/env node
/**
 * Docker dashboard (decision 146) — builds the `<!-- docker-dashboard -->`
 * sticky comment: image sizes with delta vs the latest main build, plus
 * Trivy severity counts. Zero-dependency; degrades gracefully.
 *
 * Env: IMAGE_METRICS_DIR (default image-metrics — the per-image json
 * artifacts), METRICS_DIR (ci-metrics checkout, default .ci-metrics).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, process.env.IMAGE_METRICS_DIR ?? 'image-metrics');
const metricsDir = process.env.METRICS_DIR ?? '.ci-metrics';

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;

const baseline = (() => {
  try {
    const lines = readFileSync(join(root, metricsDir, 'images.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean);
    return lines.length ? JSON.parse(lines.at(-1)) : null;
  } catch {
    return null;
  }
})();

const images = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => readJson(join(dir, f)))
  .filter(Boolean)
  .sort((a, b) => a.image.localeCompare(b.image));

const out = [];
out.push('<!-- docker-dashboard -->');
out.push('## 🐳 Images');
out.push('');
out.push('| image | size | Δ vs main | CRITICAL* | HIGH* |');
out.push('|---|---|---|---|---|');
let anyVulns = false;
for (const m of images) {
  const base = baseline?.images?.[m.image]?.size;
  let d = '—';
  if (typeof base === 'number') {
    const diff = m.size - base;
    d =
      Math.abs(diff) < 50_000
        ? '·'
        : `${diff > 0 ? '▲ +' : '▼ −'}${mb(Math.abs(diff))}`;
  }
  if (m.critical > 0 || m.high > 0) anyVulns = true;
  out.push(
    `| **${m.image}** | ${mb(m.size)} | ${d} | ${m.critical > 0 ? `❌ ${m.critical}` : '0'} | ${m.high > 0 ? `⚠️ ${m.high}` : '0'} |`,
  );
}
out.push('');
out.push(
  '<sub>*fixable vulnerabilities (Trivy, ignore-unfixed) — CRITICAL blocks the build</sub>',
);
if (anyVulns)
  out.push(
    '\n> ⚠️ fixable HIGH vulnerabilities present — consider bumping the affected base image/deps.',
  );

console.log(out.join('\n'));
