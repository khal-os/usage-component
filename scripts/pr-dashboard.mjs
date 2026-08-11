#!/usr/bin/env node
/**
 * PR dashboard (decision 146) — builds the `<!-- ci-dashboard -->` sticky
 * comment for a pull request. Zero-dependency, like spec-check.mjs; every
 * section degrades gracefully when its input is missing (this script must
 * NEVER be the reason a PR can't merge — it is not a required check).
 *
 * Inputs (env):
 *   BASE_SHA     merge-base side of the diff (the PR's base tip)
 *   HEAD_SHA     PR head sha (display only)
 *   METRICS_DIR  checkout of the ci-metrics branch   (default .ci-metrics)
 *   JOBS_JSON    `gh api .../runs/<id>/jobs` output  (optional, timing)
 * Data on disk: packages/<p>/coverage/{coverage-summary.json,lcov.info},
 * packages/<p>/jest-results.json, git history (fetch-depth 0).
 *
 * Output: the full comment markdown on stdout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['core', 'module', 'connector'];
const metrics = ['lines', 'statements', 'branches', 'functions'];
const BASE = process.env.BASE_SHA ?? '';
const HEAD = process.env.HEAD_SHA ?? '';
const metricsDir = process.env.METRICS_DIR ?? '.ci-metrics';

const git = (...args) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return '';
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const bar = (pct) =>
  '▓'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
const delta = (now, before) => {
  if (typeof before !== 'number') return '';
  const d = now - before;
  if (Math.abs(d) < 0.005) return ' ·';
  return d > 0 ? ` ▲ +${d.toFixed(2)}` : ` ▼ ${d.toFixed(2)}`;
};

// ---------- ci-metrics history (main builds) ----------
const history = (() => {
  try {
    return readFileSync(join(root, metricsDir, 'coverage.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
})();
const baseline = history.at(-1) ?? null;

const out = [];
out.push('<!-- ci-dashboard -->');
out.push(`## 📊 CI dashboard`);
if (HEAD)
  out.push(
    `_for ${HEAD.slice(0, 7)} · updated ${new Date().toISOString().slice(0, 16)}Z_`,
  );
out.push('');

// ---------- 1 · coverage per package, delta vs main ----------
const covRows = [];
for (const name of packages) {
  const summary = readJson(
    join(root, 'packages', name, 'coverage', 'coverage-summary.json'),
  );
  if (!summary) continue;
  const cells = await Promise.all(
    metrics.map(async (m) => {
      const pct = summary.total[m]?.pct;
      if (typeof pct !== 'number') return '—';
      const base = baseline?.packages?.[name]?.[m];
      return `\`${bar(pct)}\` ${pct.toFixed(1)}%${delta(pct, base)}`;
    }),
  );
  covRows.push(`| **${name}** | ${cells.join(' | ')} |`);
}
if (covRows.length) {
  out.push('### Coverage <sub>Δ vs latest `main` build</sub>');
  out.push('');
  out.push(`| package | ${metrics.join(' | ')} |`);
  out.push(`|---|${metrics.map(() => '---|').join('')}`);
  out.push(...covRows);
  const floors = [];
  for (const name of packages) {
    const cfgPath = join(root, 'packages', name, 'jest.config.mjs');
    if (!existsSync(cfgPath)) continue;
    const { default: cfg } = await import(pathToFileURL(cfgPath));
    const g = cfg.coverageThreshold?.global;
    if (g)
      floors.push(`${name} ${g.lines}/${g.statements}/${g.branches ?? '—'}`);
  }
  if (floors.length)
    out.push(
      `\n<sub>ratchet floors (lines/stmts/branches): ${floors.join(' · ')}</sub>`,
    );
  out.push('');
}

// ---------- 2 · coverage trend (mermaid) ----------
const trend = history.slice(-30);
if (trend.length >= 2) {
  const lo = Math.max(
    0,
    Math.floor(
      Math.min(
        ...trend.flatMap((e) =>
          packages.map((p) => e.packages?.[p]?.lines ?? 100),
        ),
      ),
    ) - 5,
  );
  out.push(
    '<details><summary><b>Coverage trend</b> (lines %, last main builds)</summary>\n',
  );
  out.push('```mermaid');
  out.push('xychart-beta');
  out.push(`    title "lines %, last ${trend.length} main builds"`);
  out.push(`    x-axis 1 --> ${trend.length}`);
  out.push(`    y-axis "lines %" ${lo} --> 100`);
  for (const p of packages) {
    const series = trend.map((e) => (e.packages?.[p]?.lines ?? 0).toFixed(1));
    out.push(`    line "${p}" [${series.join(', ')}]`);
  }
  out.push('```');
  out.push('</details>\n');
}

// ---------- diff plumbing (shared by 3, 5, 6, 7) ----------
const numstat = BASE
  ? git('diff', '--numstat', BASE, 'HEAD')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, d, ...p] = l.split('\t');
        return {
          add: a === '-' ? 0 : +a,
          del: d === '-' ? 0 : +d,
          path: p.join('\t'),
        };
      })
      .filter((f) => !f.path.endsWith('package-lock.json'))
  : [];

// ---------- 3 · diff coverage ----------
if (BASE) {
  // changed (added) line numbers per production source file
  const changed = new Map(); // path -> Set(lines)
  let file = null;
  for (const line of git(
    'diff',
    '--unified=0',
    '--no-color',
    BASE,
    'HEAD',
  ).split('\n')) {
    if (line.startsWith('+++ b/')) {
      const p = line.slice(6);
      file =
        p.startsWith('packages/') &&
        p.includes('/src/') &&
        p.endsWith('.ts') &&
        !p.endsWith('.spec.ts') &&
        !p.endsWith('.test.ts')
          ? p
          : null;
      continue;
    }
    const h = file && line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      const start = +h[1];
      const count = h[2] === undefined ? 1 : +h[2];
      if (!changed.has(file)) changed.set(file, new Set());
      for (let i = 0; i < count; i++) changed.get(file).add(start + i);
    }
  }
  // lcov DA lines per file (normalized to repo-relative paths)
  const lcov = new Map(); // path -> Map(line -> hits)
  for (const name of packages) {
    const p = join(root, 'packages', name, 'coverage', 'lcov.info');
    if (!existsSync(p)) continue;
    let rel = null;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.startsWith('SF:')) {
        const sf = line.slice(3).replace(/\\/g, '/');
        const i = sf.lastIndexOf('packages/');
        rel =
          i >= 0 ? sf.slice(i) : `packages/${name}/${sf.replace(/^\.\//, '')}`;
        if (!lcov.has(rel)) lcov.set(rel, new Map());
      } else if (rel && line.startsWith('DA:')) {
        const [ln, hits] = line.slice(3).split(',').map(Number);
        lcov.get(rel).set(ln, hits);
      } else if (line === 'end_of_record') rel = null;
    }
  }
  let covered = 0;
  let instrumented = 0;
  const perFile = [];
  const uninstrumented = [];
  for (const [p, lines] of changed) {
    const da = lcov.get(p);
    if (!da) {
      uninstrumented.push(p);
      continue;
    }
    let c = 0;
    let n = 0;
    for (const ln of lines)
      if (da.has(ln)) {
        n++;
        if (da.get(ln) > 0) c++;
      }
    if (n > 0) {
      covered += c;
      instrumented += n;
      if (c < n) perFile.push({ p, c, n });
    }
  }
  if (instrumented > 0) {
    const pct = (100 * covered) / instrumented;
    out.push(
      `### Diff coverage: \`${bar(pct)}\` **${pct.toFixed(1)}%** <sub>${covered}/${instrumented} changed lines covered</sub>`,
    );
    if (perFile.length || uninstrumented.length) {
      out.push('\n<details><summary>files below 100%</summary>\n');
      for (const f of perFile.sort((a, b) => a.c / a.n - b.c / b.n))
        out.push(`- \`${f.p}\` — ${f.c}/${f.n}`);
      for (const p of uninstrumented)
        out.push(`- \`${p}\` — not instrumented (never imported?)`);
      out.push('\n</details>');
    }
    out.push('');
  }
}

// ---------- 4 · tests ----------
const testRows = [];
const suites = [];
for (const name of packages) {
  const r = readJson(join(root, 'packages', name, 'jest-results.json'));
  if (!r) continue;
  const ok = r.numFailedTests === 0 && r.numFailedTestSuites === 0;
  testRows.push(
    `| ${name} | ${r.numPassedTestSuites}/${r.numTotalTestSuites} | ${r.numPassedTests}/${r.numTotalTests} | ${ok ? '✅' : '❌'} |`,
  );
  for (const s of r.testResults ?? []) {
    const ms =
      (s.endTime ?? s.perfStats?.end ?? 0) -
      (s.startTime ?? s.perfStats?.start ?? 0);
    const path = (s.name ?? s.testFilePath ?? '').replace(/\\/g, '/');
    const i = path.lastIndexOf('packages/');
    suites.push({ path: i >= 0 ? path.slice(i) : path, ms });
  }
}
if (testRows.length) {
  out.push('### Tests');
  out.push('');
  out.push('| package | suites | tests | |');
  out.push('|---|---|---|---|');
  out.push(...testRows);
  const slow = suites.sort((a, b) => b.ms - a.ms).slice(0, 5);
  if (slow.length) {
    out.push('\n<details><summary>slowest suites</summary>\n');
    for (const s of slow)
      out.push(`- ${(s.ms / 1000).toFixed(1)}s \`${s.path}\``);
    out.push('\n</details>');
  }
  out.push('');
}

// ---------- 5+6 · changed-code map & PR size ----------
if (numstat.length) {
  const areaOf = (p) => {
    const m = p.match(/^packages\/([^/]+)\//);
    if (m) return m[1];
    return p.split('/')[0].replace(/^\./, '') || 'root';
  };
  const byArea = new Map();
  const byLayer = new Map();
  let total = 0;
  for (const f of numstat) {
    const n = f.add + f.del;
    total += n;
    byArea.set(areaOf(f.path), (byArea.get(areaOf(f.path)) ?? 0) + n);
    const layer = f.path.match(/^packages\/[^/]+\/src\/([^/]+)\//);
    if (layer) byLayer.set(layer[1], (byLayer.get(layer[1]) ?? 0) + n);
  }
  const size = total < 50 ? 'S' : total < 250 ? 'M' : total < 1000 ? 'L' : 'XL';
  const adds = numstat.reduce((s, f) => s + f.add, 0);
  const dels = numstat.reduce((s, f) => s + f.del, 0);
  out.push(
    `### Change map <sub>size **${size}** · ${numstat.length} files · +${adds} −${dels}</sub>`,
  );
  out.push('');
  out.push('```mermaid');
  out.push('pie showData title changed lines by area');
  for (const [k, v] of [...byArea].sort((a, b) => b[1] - a[1]).slice(0, 8))
    out.push(`    "${k}" : ${v}`);
  out.push('```');
  if (byLayer.size) {
    out.push(
      `<sub>by layer: ${[...byLayer]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')}</sub>`,
    );
  }
  out.push('');
}

// ---------- 7 · decisions touched ----------
if (BASE) {
  const added = git('diff', '--no-color', BASE, 'HEAD')
    .split('\n')
    .filter((l) => l.startsWith('+'));
  const found = new Set();
  for (const l of added)
    for (const m of l.matchAll(/decis(?:ion|ão)\s+(\d{2,3})/gi))
      found.add(+m[1]);
  if (found.size)
    out.push(
      `**Decisions touched:** ${[...found]
        .sort((a, b) => a - b)
        .map((n) => `\`${n}\``)
        .join(
          ' ',
        )} — [decision log](../blob/main/docs/produto/backlog-v2.3.md)\n`,
    );
}

// ---------- 8 · CI timing vs main average ----------
const jobsJson =
  process.env.JOBS_JSON && readJson(join(root, process.env.JOBS_JSON));
if (jobsJson?.jobs?.length) {
  const dur = (j) =>
    j.completed_at && j.started_at
      ? (new Date(j.completed_at) - new Date(j.started_at)) / 1000
      : null;
  const avg = new Map();
  for (const e of history.slice(-10))
    for (const [name, s] of Object.entries(e.durations ?? {})) {
      if (!avg.has(name)) avg.set(name, []);
      avg.get(name).push(s);
    }
  const rows = jobsJson.jobs
    .filter((j) => dur(j) !== null && j.conclusion === 'success')
    .map((j) => {
      const d = dur(j);
      const hist = avg.get(j.name);
      const a = hist?.length
        ? hist.reduce((x, y) => x + y, 0) / hist.length
        : null;
      return `| ${j.name} | ${d.toFixed(0)}s | ${a ? `${a.toFixed(0)}s${delta(d, a).replace(/[+−-]?(\d+)\.\d+/, '$1s')}` : '—'} |`;
    });
  if (rows.length) {
    out.push('<details><summary><b>CI timing</b> vs main average</summary>\n');
    out.push('| job | this run | main avg (last 10) |');
    out.push('|---|---|---|');
    out.push(...rows);
    out.push('\n</details>');
  }
}

console.log(out.join('\n'));
