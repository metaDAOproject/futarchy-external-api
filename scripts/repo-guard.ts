import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

type CheckStatus = "pass" | "fail" | "skip" | "warn";

type PackageViolation = {
  file: string;
  section: string;
  dependency: string;
  version: string;
};

type PackageAgeViolation = {
  dependency: string;
  version: string;
  publishedAt: string;
  ageDays: number;
  usedIn: string[];
};

type PackageAgeResult =
  | { status: "pass"; violations: PackageAgeViolation[] }
  | { status: "fail"; violations: PackageAgeViolation[] }
  | { status: "skip"; violations: PackageAgeViolation[]; reason: string };

type SensitiveFinding = {
  file: string;
  line: number;
  kind: string;
  text: string;
};

const ROOT = process.cwd();
const SUMMARY_PATH =
  process.env.REPO_GUARD_SUMMARY_PATH ??
  join(process.env.TMPDIR ?? "/tmp", "repo-guard-summary.md");
const BASE_REF = process.env.GITHUB_BASE_REF ?? "";
const IS_CI = process.env.CI === "true";
const PACKAGE_MIN_AGE_DAYS = Number.parseInt(
  process.env.PACKAGE_MIN_AGE_DAYS ?? "14",
  10
);

const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
] as const;

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "coverage",
]);

const exactVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const sensitiveFiles = [
  "src/config.ts",
  "src/main.ts",
  "src/app.ts",
  "src/services/solanaService.ts",
  "src/services/futarchyService.ts",
  "src/services/launchpadService.ts",
  "src/services/meteoraService.ts",
  "src/services/databaseService.ts",
  "src/services/externalDatabaseService.ts",
  "scripts/safe-update.ts",
];

// Files whose purpose is to define the guard rules themselves, or to document
// them. Their diffs trivially match the heuristics and create noise without
// signal.
const excludedFromSensitiveDiff = new Set([
  "scripts/repo-guard.ts",
  ".github/CODEOWNERS",
  ".github/CODEOWNERS.example",
  ".github/branch-protection.md",
  ".github/workflows/package-protection.yml",
]);

const suspiciousContentRules: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: "Hardcoded Solana address or program literal",
    pattern: /["'`](?:[1-9A-HJ-NP-Za-km-z]{32,44})["'`]/,
  },
  {
    kind: "Program ID constant or variable change",
    pattern: /\b[A-Z0-9_]*PROGRAM_ID\b|\bprogramId\b/,
  },
  {
    kind: "Wallet or destination routing change",
    pattern:
      /\b(?:PAYMENT_DESTINATION_ADDRESS|WALLET|TREASURY|RECIPIENT|DESTINATION|AUTHORITY)\b/i,
  },
  {
    kind: "Signing or transaction submission path change",
    pattern:
      /\b(?:signTransaction|signAllTransactions|sendTransaction|verifyPaymentTransaction)\b/,
  },
  {
    kind: "Public key construction change",
    pattern: /\bnew PublicKey\s*\(/,
  },
];

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, acc);
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      acc.push(relative(ROOT, fullPath));
    }
  }

  return acc;
}

function readJsonAtRef(
  ref: string,
  filePath: string
): Record<string, unknown> | null {
  try {
    const content = execFileSync("git", ["show", `${ref}:${filePath}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Scopes the exact-dependency map down to entries whose version differs from
// the PR base. Prevents every PR from tripping the age gate for ~14 days after
// an unrelated dep bump lands on the base branch.
function filterExactDependenciesToChanges(
  all: Map<string, Set<string>>,
  diffBase: string
): Map<string, Set<string>> {
  const locationPattern = /^(.+) \((\w+)\)$/;
  const changed = new Map<string, Set<string>>();

  for (const [key, locations] of all.entries()) {
    const atIndex = key.lastIndexOf("@");
    const dependency = key.slice(0, atIndex);
    const headVersion = key.slice(atIndex + 1);

    for (const location of locations) {
      const match = locationPattern.exec(location);
      if (!match) {
        continue;
      }
      const file = match[1]!;
      const section = match[2]!;

      const basePkg = readJsonAtRef(diffBase, file);
      const baseSection =
        basePkg && typeof basePkg[section] === "object" && basePkg[section] !== null
          ? (basePkg[section] as Record<string, unknown>)
          : null;
      const baseVersion = baseSection?.[dependency];

      if (baseVersion === headVersion) {
        continue;
      }

      const set = changed.get(key) ?? new Set<string>();
      set.add(location);
      changed.set(key, set);
    }
  }

  return changed;
}

function isAllowedDependencyVersion(version: string): boolean {
  if (exactVersionPattern.test(version)) {
    return true;
  }

  if (version === "workspace:*") {
    return true;
  }

  return false;
}

function collectPackageDependencyData(): {
  violations: PackageViolation[];
  exactDependencies: Map<string, Set<string>>;
} {
  const packageFiles = walk(ROOT, []).sort();
  const violations: PackageViolation[] = [];
  const exactDependencies = new Map<string, Set<string>>();

  for (const packageFile of packageFiles) {
    const packageJson = JSON.parse(readFileSync(join(ROOT, packageFile), "utf8"));

    for (const section of dependencySections) {
      const dependencies = packageJson[section];
      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }

      for (const [dependency, version] of Object.entries(dependencies)) {
        if (typeof version !== "string") {
          continue;
        }

        if (isAllowedDependencyVersion(version)) {
          if (version !== "workspace:*") {
            const key = `${dependency}@${version}`;
            const locations = exactDependencies.get(key) ?? new Set<string>();
            locations.add(`${packageFile} (${section})`);
            exactDependencies.set(key, locations);
          }
          continue;
        }

        violations.push({
          file: packageFile,
          section,
          dependency,
          version,
        });
      }
    }
  }

  return { violations, exactDependencies };
}

async function fetchPackagePublishTime(
  dependency: string,
  version: string
): Promise<string> {
  // npm accepts fully encoded scoped names, but keep the canonical scoped
  // package shape (`@scope%2fname`) to avoid registry/proxy compatibility
  // issues with `%40scope%2Fname`.
  const registryName = dependency.startsWith("@")
    ? dependency.replace("/", "%2F")
    : encodeURIComponent(dependency);

  const response = await fetch(
    `https://registry.npmjs.org/${registryName}`,
    {
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${dependency}`);
  }

  const packageMeta = (await response.json()) as {
    time?: Record<string, string>;
  };

  const publishedAt = packageMeta.time?.[version];
  if (!publishedAt) {
    throw new Error(`publish time not found for ${dependency}@${version}`);
  }

  return publishedAt;
}

async function checkPackageMinimumAge(
  exactDependencies: Map<string, Set<string>>
): Promise<PackageAgeViolation[]> {
  const violations: PackageAgeViolation[] = [];
  const now = Date.now();

  for (const [key, usedIn] of [...exactDependencies.entries()].sort()) {
    const atIndex = key.lastIndexOf("@");
    const dependency = key.slice(0, atIndex);
    const version = key.slice(atIndex + 1);
    const publishedAt = await fetchPackagePublishTime(dependency, version);
    const ageDays = Math.floor(
      (now - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (ageDays >= PACKAGE_MIN_AGE_DAYS) {
      continue;
    }

    violations.push({
      dependency,
      version,
      publishedAt,
      ageDays,
      usedIn: [...usedIn].sort(),
    });
  }

  return violations;
}


function getDiffBase(): string | null {
  if (!BASE_REF) {
    return null;
  }

  return run("git", ["merge-base", "HEAD", `origin/${BASE_REF}`]);
}

function collectChangedFiles(diffBase: string): Set<string> {
  const output = run("git", ["diff", "--name-only", `${diffBase}...HEAD`]);
  return new Set(output.split("\n").filter(Boolean));
}

function checkSensitiveDiff():
  | { status: "skip"; findings: SensitiveFinding[]; touchedSensitiveFiles: string[] }
  | { status: "pass" | "fail" | "warn"; findings: SensitiveFinding[]; touchedSensitiveFiles: string[] } {
  const diffBase = getDiffBase();
  if (!diffBase) {
    return {
      status: "skip",
      findings: [],
      touchedSensitiveFiles: [],
    };
  }

  const changedFiles = collectChangedFiles(diffBase);
  const touchedSensitiveFiles = sensitiveFiles.filter((file) => changedFiles.has(file));

  const diff = run("git", [
    "diff",
    "--unified=0",
    "--no-color",
    `${diffBase}...HEAD`,
  ]);

  const findings: SensitiveFinding[] = [];
  let currentFile = "";
  let nextLineNumber = 0;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice(6);
      continue;
    }

    if (rawLine.startsWith("--- ")) {
      continue;
    }

    if (rawLine.startsWith("@@")) {
      const match = rawLine.match(/\+(\d+)(?:,(\d+))?/);
      nextLineNumber = match ? Number.parseInt(match[1]!, 10) : 0;
      continue;
    }

    if (excludedFromSensitiveDiff.has(currentFile)) {
      continue;
    }

    // Documentation (Markdown, plain text, READMEs) naturally contains words
    // like "wallet", "authority", or example Solana addresses; the heuristics
    // are intended to catch changes to *code*, not docs. Skip prose files.
    if (/\.(md|mdx|txt|rst)$/i.test(currentFile)) {
      continue;
    }

    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) {
      if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
        continue;
      }

      if (!rawLine.startsWith("-")) {
        continue;
      }
    }

    const sign = rawLine[0];
    const lineText = rawLine.slice(1);
    if (!currentFile || !lineText.trim()) {
      if (sign === "+") {
        nextLineNumber += 1;
      }
      continue;
    }

    const matchedKinds = suspiciousContentRules
      .filter((rule) => rule.pattern.test(lineText))
      .map((rule) => rule.kind);

    if (matchedKinds.length > 0) {
      findings.push({
        file: currentFile,
        line: nextLineNumber,
        kind: matchedKinds.join("; "),
        text: `${sign}${lineText}`.trim(),
      });
    }

    if (sign === "+") {
      nextLineNumber += 1;
    }
  }

  if (findings.length === 0 && touchedSensitiveFiles.length === 0) {
    return {
      status: "pass",
      findings,
      touchedSensitiveFiles,
    };
  }

  // Sensitive-diff is a review-assist, not a merge gate. Merge-blocking for
  // sensitive paths is handled by CODEOWNERS + branch protection (the review
  // required by @metanallok on files listed in .github/CODEOWNERS). This
  // check surfaces the findings for reviewer visibility — in the PR comment
  // and as GitHub annotations — without failing CI.
  return {
    status: "warn",
    findings,
    touchedSensitiveFiles,
  };
}

function renderPackageSection(violations: PackageViolation[]): string[] {
  if (violations.length === 0) {
    return [
      "### Exact dependency versions",
      "",
      "- Status: pass",
      "- All `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` use exact versions or `workspace:*`.",
    ];
  }

  return [
    "### Exact dependency versions",
    "",
    "- Status: fail",
    "- The following dependency specs are not exact:",
    ...violations.map(
      (violation) =>
        `- \`${violation.file}\` -> \`${violation.section}.${violation.dependency}\` uses \`${violation.version}\``
    ),
  ];
}

function renderPackageAgeSection(violations: PackageAgeViolation[]): string[] {
  if (violations.length === 0) {
    return [
      "### Package minimum age",
      "",
      `- Status: pass`,
      `- All pinned external packages are at least ${PACKAGE_MIN_AGE_DAYS} days old.`,
    ];
  }

  return [
    "### Package minimum age",
    "",
    "- Status: fail",
    `- The following packages are newer than ${PACKAGE_MIN_AGE_DAYS} days:`,
    ...violations.map(
      (violation) =>
        `- \`${violation.dependency}@${violation.version}\` is ${violation.ageDays} days old (published ${violation.publishedAt}) and is used in ${violation.usedIn
          .map((item) => `\`${item}\``)
          .join(", ")}`
    ),
  ];
}

function renderPackageAgeResult(result: PackageAgeResult): string[] {
  if (result.status === "skip") {
    return [
      "### Package minimum age",
      "",
      "- Status: skipped",
      `- The npm registry age check could not run in this environment: ${result.reason}`,
    ];
  }

  return renderPackageAgeSection(result.violations);
}


function renderSensitiveSection(
  result: ReturnType<typeof checkSensitiveDiff>
): string[] {
  if (result.status === "skip") {
    return [
      "### Sensitive wallet / program changes",
      "",
      "- Status: skipped",
      "- No PR base ref was available, so diff-based security checks did not run.",
    ];
  }

  const heading = [
    "### Sensitive wallet / program changes",
    "",
    `- Status: ${result.status}`,
  ];

  if (result.status === "pass") {
    return [
      ...heading,
      "- No suspicious wallet routing, signing-path, or program-ID changes were detected in this PR diff.",
    ];
  }

  const lines = [...heading];

  lines.push(
    "- Suspicious wallet routing, signing-path, or program-ID changes detected. This is a review hint, not a merge gate — CODEOWNERS + branch protection enforce the actual review requirement. Please take a closer look at the lines below."
  );

  if (result.touchedSensitiveFiles.length > 0) {
    lines.push(
      `- High-sensitivity files touched: ${result.touchedSensitiveFiles
        .map((file) => `\`${file}\``)
        .join(", ")}`
    );
  }

  if (result.findings.length > 0) {
    lines.push("- Matching diff lines:");
    lines.push(
      ...result.findings.slice(0, 20).map(
        (finding) =>
          `- \`${finding.file}:${finding.line}\` ${finding.kind} -> \`${finding.text}\``
      )
    );
  } else if (result.touchedSensitiveFiles.length > 0) {
    lines.push("- No single diff line matched the heuristics, but a known high-sensitivity file was modified.");
  }

  return lines;
}

async function main() {
  const { violations: packageViolations, exactDependencies } =
    collectPackageDependencyData();
  let packageAgeResult: PackageAgeResult;

  const diffBase = getDiffBase();

  if (!diffBase) {
    packageAgeResult = {
      status: "skip",
      violations: [],
      reason:
        "no PR base ref (GITHUB_BASE_REF) was available, so the age check could not be scoped to PR-introduced changes.",
    };
  } else {
    try {
      const changedExactDependencies = filterExactDependenciesToChanges(
        exactDependencies,
        diffBase
      );
      const packageAgeViolations = await checkPackageMinimumAge(
        changedExactDependencies
      );
      packageAgeResult = {
        status: packageAgeViolations.length === 0 ? "pass" : "fail",
        violations: packageAgeViolations,
      };
    } catch (error) {
      if (IS_CI) {
        throw error;
      }

      packageAgeResult = {
        status: "skip",
        violations: [],
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const sensitiveDiff = checkSensitiveDiff();

  const packageStatus: CheckStatus =
    packageViolations.length === 0 ? "pass" : "fail";
  const packageAgeStatus: CheckStatus = packageAgeResult.status;

  // sensitive-diff is intentionally NOT part of overallFailed. It's a review
  // hint surfaced via PR comment + GitHub annotations. Merge-blocking for
  // sensitive paths is CODEOWNERS + branch protection's job.
  const overallFailed =
    packageStatus === "fail" || packageAgeStatus === "fail";

  const lines = [
    "## Repository Guard",
    "",
    ...renderPackageSection(packageViolations),
    "",
    ...renderPackageAgeResult(packageAgeResult),
    "",
    ...renderSensitiveSection(sensitiveDiff),
    "",
    `Overall status: ${overallFailed ? "fail" : "pass"}`,
    "",
    "_Transitive supply-chain threats are covered by the Socket scanner (via \`@socketsecurity/bun-security-scanner\` in \`bunfig.toml\`), which runs on every \`bun install\`. This guard blocks merge on direct-dep pinning and age policy; the sensitive-diff section is a review hint, not a merge gate (CODEOWNERS handles the actual review requirement)._",
  ];

  const summary = `${lines.join("\n")}\n`;
  writeFileSync(SUMMARY_PATH, summary);

  // Sensitive-diff annotations are emitted as `::warning::` so they show up
  // in the Files Changed view for reviewers but don't fail the job. This
  // runs regardless of overallFailed — a clean lockfile/age check shouldn't
  // silence a review hint.
  if (sensitiveDiff.status === "warn") {
    for (const finding of sensitiveDiff.findings.slice(0, 20)) {
      console.log(
        `::warning file=${finding.file},line=${finding.line}::${finding.kind}: ${finding.text}`
      );
    }
    for (const file of sensitiveDiff.touchedSensitiveFiles) {
      console.log(
        `::warning file=${file}::High-sensitivity file modified — please review carefully.`
      );
    }
  }

  if (overallFailed) {
    console.error("");
    console.error("Repository Guard failed. Details:");
    console.error("");
    console.error(summary);

    for (const violation of packageViolations) {
      console.error(
        `::error file=${violation.file}::${violation.section}.${violation.dependency} uses \`${violation.version}\` — pin to an exact version.`
      );
    }

    if (packageAgeResult.status === "fail") {
      for (const violation of packageAgeResult.violations) {
        const usedIn = violation.usedIn.join(", ");
        console.error(
          `::error file=${violation.usedIn[0] ?? "package.json"}::${violation.dependency}@${violation.version} is only ${violation.ageDays} days old (published ${violation.publishedAt}, min age ${PACKAGE_MIN_AGE_DAYS}d). Used in: ${usedIn}`
        );
      }
    }

    process.exit(1);
  }

  console.log(summary);
}

await main();
