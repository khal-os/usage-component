#!/usr/bin/env node
/**
 * Spec-integrity gate — the mechanical half of the spec-driven workflow
 * (the .claude/skills/ encode the authoring half; this script verifies
 * what a skill in one branch cannot see, e.g. a sibling branch claiming
 * the same decision number — the real 132/133 collision of 2026-08-08).
 *
 * Checks:
 *   1. Decision log: numbers unique and strictly ascending in file order.
 *   2. QA registry: every RESOLVIDA/RESOLVED annotation cites an existing
 *      decision number.
 *   3. Code → spec references: `decision NN` / `decisão NN` and `QAnn`
 *      markers in packages/*'s source resolve to real rows.
 *   4. SCRUB completeness: every ${VAR} a compose file interpolates is
 *      listed as `-u VAR` in the Makefile SCRUB block (a var that escapes
 *      the scrub silently overrides every client env file — shipped twice,
 *      decisions 78/133).
 *
 * Zero dependencies; run: node scripts/spec-check.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];
const fail = (message) => failures.push(message);

// ---------- locate the backlog (never hardcode the version) ----------
const backlogDir = 'docs/produto';
const backlogFile = readdirSync(backlogDir)
  .filter((name) => /^backlog-.*\.md$/.test(name))
  .sort()
  .at(-1);

if (!backlogFile) {
  console.error('spec-check: no docs/produto/backlog-*.md found');
  process.exit(1);
}

const backlogPath = join(backlogDir, backlogFile);
const backlog = readFileSync(backlogPath, 'utf-8');

// ---------- 1. decision log: unique + strictly ascending ----------
const decisionNumbers = [...backlog.matchAll(/^\| (\d+) \|/gm)].map((match) =>
  Number(match[1]),
);

if (decisionNumbers.length === 0) {
  fail(`${backlogPath}: no decision rows matched '| N |' — table moved?`);
}

const seen = new Set();
let previous = 0;

for (const number of decisionNumbers) {
  if (seen.has(number)) {
    fail(
      `decision log: number ${number} appears more than once — ` +
        'two branches claimed the same number (the 132/133 collision class); ' +
        'renumber the later one to max+1',
    );
  }
  seen.add(number);

  if (number < previous) {
    fail(
      `decision log: number ${number} appears after ${previous} — ` +
        'the log is append-only and strictly ascending',
    );
  }
  previous = number;
}

const maxDecision = Math.max(0, ...decisionNumbers);

// ---------- 2. RESOLVIDA annotations cite existing decisions ----------
for (const match of backlog.matchAll(
  /RESOLVID[AO]\s*\((?:[^,)]*,\s*)?decis(?:ão|ao|ion)\s+(\d+)\)/gi,
)) {
  const cited = Number(match[1]);

  if (!seen.has(cited)) {
    fail(
      `${backlogPath}: a RESOLVIDA annotation cites decision ${cited}, ` +
        'which does not exist in the decision log',
    );
  }
}

// ---------- 3. code references resolve ----------
const qaIds = new Set(
  [...backlog.matchAll(/\| (QA\d+) \|/g)].map((match) => match[1]),
);

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry)) return [];
    if (statSync(path).isDirectory()) return walk(path);

    return /\.(ts|mjs|yml|yaml)$/.test(entry) ? [path] : [];
  });

const sourceFiles = readdirSync('packages').flatMap((pkg) => {
  const src = join('packages', pkg, 'src');

  try {
    return statSync(src).isDirectory() ? walk(src) : [];
  } catch {
    return [];
  }
});

for (const file of sourceFiles) {
  const content = readFileSync(file, 'utf-8');

  for (const match of content.matchAll(/decis(?:ão|ao|ion)\s+(\d{2,3})\b/gi)) {
    const cited = Number(match[1]);

    if (cited > maxDecision) {
      fail(
        `${file}: references decision ${cited}, beyond the log's ` +
          `max (${maxDecision}) — a number claimed but never recorded?`,
      );
    }
  }

  for (const match of content.matchAll(/\bQA(\d{1,2})\b/g)) {
    const id = `QA${match[1]}`;

    if (!qaIds.has(id)) {
      // Retired ids may be referenced historically only in docs; code
      // must point at live registry rows.
      fail(`${file}: references ${id}, not present in the QA registry`);
    }
  }
}

// ---------- 4. SCRUB completeness ----------
const composeVars = new Set();

for (const file of readdirSync('.').filter((name) =>
  /^compose.*\.ya?ml$/.test(name),
)) {
  const content = readFileSync(file, 'utf-8');

  for (const match of content.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) {
    composeVars.add(match[1]);
  }
}

const makefile = readFileSync('Makefile', 'utf-8');
const scrubbed = new Set(
  [...makefile.matchAll(/-u\s+([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]),
);

for (const variable of [...composeVars].sort()) {
  if (!scrubbed.has(variable)) {
    fail(
      `Makefile SCRUB: compose interpolates \${${variable}} but the ` +
        'SCRUB block has no `-u ' +
        variable +
        '` — an operator-exported var would silently override every ' +
        "client's --env-file (decisions 78/133)",
    );
  }
}

// ---------- verdict ----------
if (failures.length > 0) {
  console.error(`spec-check: ${failures.length} problem(s)\n`);
  for (const message of failures) console.error(`  ✖ ${message}`);
  process.exit(1);
}

console.log(
  `spec-check ok — ${decisionNumbers.length} decisions (max ${maxDecision}), ` +
    `${qaIds.size} QA rows, ${composeVars.size} compose vars scrubbed, ` +
    `${sourceFiles.length} source files cross-checked (${backlogFile})`,
);
