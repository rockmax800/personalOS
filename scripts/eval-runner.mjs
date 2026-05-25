#!/usr/bin/env node

/**
 * Eval Runner — автотестирование качества агентов.
 *
 * Прогоняет eval-suites по последним N закрытым issues,
 * сравнивает с baseline и создаёт issue при регрессии.
 *
 * Usage:
 *   node scripts/eval-runner.mjs [--suites-dir <path>] [--baseline <path>] [--dry-run]
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "suites-dir": { type: "string", default: "eval-suites" },
    baseline: { type: "string", default: "eval-suites/baseline.json" },
    "dry-run": { type: "boolean", default: false },
    role: { type: "string", default: "" },
    verbose: { type: "boolean", default: false },
  },
});

const ROOT = resolve(import.meta.dirname, "..");
const SUITES_DIR = resolve(ROOT, args["suites-dir"]);
const BASELINE_PATH = resolve(ROOT, args.baseline);

function loadYaml(filePath) {
  const content = readFileSync(filePath, "utf8");
  const suite = { checks: [] };
  let currentCheck = null;
  let inChecks = false;

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = rawLine.search(/\S/);

    if (trimmed === "checks:") {
      inChecks = true;
      continue;
    }

    if (indent === 0 && trimmed !== "checks:") {
      if (currentCheck) {
        suite.checks.push(currentCheck);
        currentCheck = null;
      }
      inChecks = false;
      const topMatch = trimmed.match(/^(\w[\w_]*):\s*(.+)?$/);
      if (topMatch) {
        const [, key, value] = topMatch;
        if (key === "tags") {
          suite.tags = (value || "")
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((t) => t.trim());
        } else if (value) {
          suite[key] = value.replace(/^["']|["']$/g, "");
        }
      }
      continue;
    }

    if (inChecks && trimmed.startsWith("- id:")) {
      if (currentCheck) suite.checks.push(currentCheck);
      currentCheck = { id: trimmed.slice(5).trim() };
      continue;
    }

    if (currentCheck && indent >= 4) {
      const propMatch = trimmed.match(/^(\w[\w_]*):\s*(.+)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        let parsed = value.replace(/^["']|["']$/g, "");
        if (value.startsWith('"')) {
          parsed = parsed.replace(/\\\\/g, "\x00").replace(/\\n/g, "\n").replace(/\x00/g, "\\");
        }
        currentCheck[key] = parsed;
      }
    }
  }

  if (currentCheck) suite.checks.push(currentCheck);
  return suite;
}

function loadSuites(dir) {
  const suites = [];
  for (const subdir of ["roles", "protected"]) {
    const fullPath = join(dir, subdir);
    if (!existsSync(fullPath)) continue;
    for (const file of readdirSync(fullPath)) {
      if (!file.endsWith(".eval.yaml")) continue;
      const suite = loadYaml(join(fullPath, file));
      suite._source = join(subdir, file);
      suites.push(suite);
    }
  }
  return suites;
}

function runCheck(check) {
  const result = { id: check.id, passed: false, detail: "" };

  try {
    switch (check.type) {
      case "command": {
        execSync(check.command, {
          cwd: ROOT,
          stdio: "pipe",
          timeout: 30_000,
        });
        result.passed = true;
        break;
      }

      case "grep": {
        const target = getTarget(check.target || "diff");
        const pattern = new RegExp(check.pattern, "i");
        result.passed = pattern.test(target);
        if (!result.passed) result.detail = `pattern not found: ${check.pattern}`;
        break;
      }

      case "regex": {
        const target = getTarget(check.target || "diff");
        const pattern = new RegExp(check.pattern, "m");
        result.passed = pattern.test(target);
        if (!result.passed) result.detail = `regex not matched: ${check.pattern}`;
        break;
      }

      case "no-match": {
        const target = getTarget(check.target || "diff");
        const pattern = new RegExp(check.pattern, "im");
        result.passed = !pattern.test(target);
        if (!result.passed) result.detail = `forbidden pattern found: ${check.pattern}`;
        break;
      }

      case "file-exists": {
        result.passed = existsSync(resolve(ROOT, check.path));
        if (!result.passed) result.detail = `file not found: ${check.path}`;
        break;
      }

      default:
        result.detail = `unknown check type: ${check.type}`;
    }
  } catch (error) {
    result.detail = error.message?.split("\n")[0] || "check failed";
  }

  return result;
}

const targetCache = {};
function getTarget(target) {
  if (targetCache[target]) return targetCache[target];

  try {
    switch (target) {
      case "diff":
        targetCache[target] = execSync("git diff HEAD~1", {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 10_000,
        });
        break;
      case "files":
        targetCache[target] = execSync("git diff --name-only HEAD~1", {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 10_000,
        });
        break;
      case "commit-message":
        targetCache[target] = execSync("git log -1 --pretty=%B", {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 10_000,
        });
        break;
      case "output":
        targetCache[target] = "";
        break;
      default:
        targetCache[target] = "";
    }
  } catch {
    targetCache[target] = "";
  }

  return targetCache[target];
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function saveBaseline(baseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
}

function runEval() {
  const suites = loadSuites(SUITES_DIR);
  const baseline = loadBaseline();
  const roleFilter = args.role?.toUpperCase();

  const results = [];
  const regressions = [];

  for (const suite of suites) {
    if (roleFilter && suite.role !== roleFilter && suite.role !== "_protected") {
      continue;
    }

    const suiteResult = {
      id: suite.id,
      role: suite.role,
      source: suite._source,
      checks: [],
      passed: 0,
      failed: 0,
      warnings: 0,
    };

    for (const check of suite.checks) {
      const checkResult = runCheck(check);
      checkResult.severity = check.severity || "error";
      suiteResult.checks.push(checkResult);

      if (checkResult.passed) {
        suiteResult.passed++;
      } else if (checkResult.severity === "warning") {
        suiteResult.warnings++;
      } else {
        suiteResult.failed++;
      }
    }

    const total = suiteResult.passed + suiteResult.failed;
    suiteResult.pass_rate = total > 0 ? (suiteResult.passed / total) * 100 : 0;

    if (baseline?.suites?.[suite.id]?.pass_rate != null) {
      const prev = baseline.suites[suite.id].pass_rate;
      const drop = prev - suiteResult.pass_rate;
      if (drop > (baseline.regression_threshold_pct || 10)) {
        regressions.push({
          suite_id: suite.id,
          previous: prev,
          current: suiteResult.pass_rate,
          drop,
        });
      }
    }

    if (baseline?.suites?.[suite.id]) {
      baseline.suites[suite.id].pass_rate = suiteResult.pass_rate;
      baseline.suites[suite.id].total_runs =
        (baseline.suites[suite.id].total_runs || 0) + 1;
      baseline.suites[suite.id].last_updated = new Date().toISOString();
    }

    results.push(suiteResult);
  }

  if (args.verbose) {
    console.log("\n=== Eval Results ===\n");
    for (const r of results) {
      const status =
        r.failed > 0 ? "FAIL" : r.warnings > 0 ? "WARN" : "PASS";
      console.log(
        `[${status}] ${r.id} (${r.role}): ${r.passed}/${r.passed + r.failed} passed, ${r.warnings} warnings`,
      );
      for (const c of r.checks) {
        const mark = c.passed ? "  ✓" : c.severity === "warning" ? "  ⚠" : "  ✗";
        console.log(`${mark} ${c.id}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
  }

  if (regressions.length > 0) {
    console.log("\n=== REGRESSIONS DETECTED ===\n");
    for (const reg of regressions) {
      console.log(
        `${reg.suite_id}: ${reg.previous.toFixed(1)}% → ${reg.current.toFixed(1)}% (drop: ${reg.drop.toFixed(1)}%)`,
      );
    }

    if (!args["dry-run"]) {
      const regSummary = regressions
        .map(
          (r) =>
            `- ${r.suite_id}: ${r.previous.toFixed(1)}% → ${r.current.toFixed(1)}%`,
        )
        .join("\n");
      console.log(
        `\nRegression report:\n${regSummary}\n\nCreate an eval-regression issue to track this.`,
      );
    }
  }

  if (baseline && !args["dry-run"]) {
    saveBaseline(baseline);
  }

  const summary = {
    total_suites: results.length,
    total_checks: results.reduce(
      (sum, r) => sum + r.passed + r.failed + r.warnings,
      0,
    ),
    total_passed: results.reduce((sum, r) => sum + r.passed, 0),
    total_failed: results.reduce((sum, r) => sum + r.failed, 0),
    total_warnings: results.reduce((sum, r) => sum + r.warnings, 0),
    regressions: regressions.length,
  };

  console.log("\n" + JSON.stringify(summary, null, 2));

  return summary.total_failed > 0 || regressions.length > 0 ? 1 : 0;
}

process.exit(runEval());
