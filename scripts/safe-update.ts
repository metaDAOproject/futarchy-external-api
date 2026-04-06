#!/usr/bin/env bun
/**
 * Safe dependency updater - only updates to versions published 14+ days ago.
 * Updates both package.json and bun.lock.
 *
 * Usage: bun run scripts/safe-update.ts [--days=14] [--dry-run]
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const MIN_AGE_DAYS = parseInt(
  process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "14",
  10
);
const DRY_RUN = process.argv.includes("--dry-run");
const PKG_PATH = join(import.meta.dir, "..", "package.json");

interface NpmRegistryResponse {
  "dist-tags": Record<string, string>;
  time: Record<string, string>;
  versions: Record<string, unknown>;
}

interface UpdateResult {
  name: string;
  current: string;
  latest: string;
  latestSafe: string | null;
  publishedAt: string;
  ageDays: number;
  updated: boolean;
  reason: string;
}

async function fetchRegistryInfo(
  pkg: string
): Promise<NpmRegistryResponse | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}`);
    if (!res.ok) return null;
    return (await res.json()) as NpmRegistryResponse;
  } catch {
    return null;
  }
}

function parseVersionRange(range: string): { prefix: string; version: string } {
  const match = range.match(/^([~^]?)(.+)$/);
  return {
    prefix: match?.[1] ?? "",
    version: match?.[2] ?? range,
  };
}

function isStableVersion(version: string): boolean {
  // Allow pre-release if the current version is also pre-release
  return true;
}

function versionMatchesPrerelease(
  current: string,
  candidate: string
): boolean {
  const currentIsPrerelease = current.includes("-");
  const candidateIsPrerelease = candidate.includes("-");

  // If current is stable, only allow stable candidates
  if (!currentIsPrerelease && candidateIsPrerelease) return false;

  // If current is prerelease, allow both
  return true;
}

async function findLatestSafeVersion(
  pkg: string,
  currentRange: string,
  registryInfo: NpmRegistryResponse
): Promise<{
  latestSafe: string | null;
  latest: string;
  publishedAt: string;
  ageDays: number;
}> {
  const { prefix, version: currentVersion } = parseVersionRange(currentRange);
  const now = Date.now();
  const minAgeMs = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

  const latest = registryInfo["dist-tags"]?.latest ?? currentVersion;
  const latestTime = registryInfo.time?.[latest];
  const latestAge = latestTime
    ? Math.floor((now - new Date(latestTime).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Get all versions with their publish times, sorted newest first
  const versions = Object.keys(registryInfo.time ?? {})
    .filter((v) => v !== "created" && v !== "modified")
    .filter((v) => versionMatchesPrerelease(currentVersion, v))
    .map((v) => ({
      version: v,
      time: new Date(registryInfo.time[v]).getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  // Find the newest version that is at least MIN_AGE_DAYS old
  const safeVersion = versions.find((v) => now - v.time >= minAgeMs);

  return {
    latestSafe: safeVersion?.version ?? null,
    latest,
    publishedAt: latestTime ?? "unknown",
    ageDays: latestAge,
  };
}

function compareVersions(a: string, b: string): number {
  // Simple semver comparison (major.minor.patch)
  const parseVer = (v: string) => {
    const [main] = v.split("-");
    return main.split(".").map(Number);
  };
  const av = parseVer(a);
  const bv = parseVer(b);
  for (let i = 0; i < 3; i++) {
    if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (av[i] ?? 0) - (bv[i] ?? 0);
  }
  // If main versions equal, non-prerelease > prerelease
  const aHasPre = a.includes("-");
  const bHasPre = b.includes("-");
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return 0;
}

async function main() {
  console.log(
    `\n🔍 Safe Update - only updating to versions ${MIN_AGE_DAYS}+ days old`
  );
  if (DRY_RUN) console.log("   (dry run - no changes will be made)\n");
  else console.log();

  const pkgJson = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
  const depSections = ["dependencies", "devDependencies"] as const;
  const results: UpdateResult[] = [];
  let updatedCount = 0;

  for (const section of depSections) {
    const deps = pkgJson[section];
    if (!deps) continue;

    console.log(`\n📦 ${section}:`);

    for (const [name, range] of Object.entries(deps) as [string, string][]) {
      // Skip "latest" tag references
      if (range === "latest") {
        console.log(`  ⏭  ${name}: using "latest" tag, skipping`);
        continue;
      }

      const { prefix, version: currentVersion } = parseVersionRange(range);
      const info = await fetchRegistryInfo(name);

      if (!info) {
        console.log(`  ⚠️  ${name}: could not fetch registry info`);
        continue;
      }

      const { latestSafe, latest, publishedAt, ageDays } =
        await findLatestSafeVersion(name, range, info);

      if (!latestSafe) {
        console.log(`  ⚠️  ${name}@${range}: no version found ${MIN_AGE_DAYS}+ days old`);
        results.push({
          name,
          current: range,
          latest,
          latestSafe: null,
          publishedAt,
          ageDays,
          updated: false,
          reason: "no safe version found",
        });
        continue;
      }

      const cmp = compareVersions(latestSafe, currentVersion);
      if (cmp <= 0) {
        console.log(`  ✅ ${name}@${range}: already up to date (safe: ${latestSafe})`);
        results.push({
          name,
          current: range,
          latest,
          latestSafe,
          publishedAt,
          ageDays,
          updated: false,
          reason: "already up to date",
        });
        continue;
      }

      const newRange = `${prefix}${latestSafe}`;
      const safeTime = info.time[latestSafe];
      const safeAge = Math.floor(
        (Date.now() - new Date(safeTime).getTime()) / (1000 * 60 * 60 * 24)
      );

      console.log(
        `  ⬆️  ${name}: ${range} → ${newRange} (published ${safeAge} days ago)`
      );

      if (!DRY_RUN) {
        deps[name] = newRange;
        updatedCount++;
      }

      results.push({
        name,
        current: range,
        latest,
        latestSafe,
        publishedAt,
        ageDays: safeAge,
        updated: !DRY_RUN,
        reason: "updated",
      });
    }
  }

  // Pin all versions by stripping ^ and ~ prefixes to prevent accidental updates via `bun update`
  let pinnedCount = 0;
  for (const section of depSections) {
    const deps = pkgJson[section];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps) as [string, string][]) {
      if (range === "latest") continue;
      const { prefix, version } = parseVersionRange(range);
      if (prefix) {
        deps[name] = version;
        pinnedCount++;
        if (!DRY_RUN) {
          console.log(`  📌 ${name}: ${range} → ${version} (pinned)`);
        }
      }
    }
  }

  if (DRY_RUN && pinnedCount > 0) {
    console.log(`\n📌 Would pin ${pinnedCount} dependencies (remove ^ and ~ prefixes)`);
  }

  if (!DRY_RUN && (updatedCount > 0 || pinnedCount > 0)) {
    writeFileSync(PKG_PATH, JSON.stringify(pkgJson, null, 2) + "\n");
    console.log(`\n✏️  Updated package.json (${updatedCount} updates, ${pinnedCount} pinned)`);

    console.log("\n📥 Running bun install to update lockfile...");
    const proc = Bun.spawnSync(["bun", "install"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "inherit",
      stderr: "inherit",
    });

    if (proc.exitCode === 0) {
      console.log("✅ bun.lock updated successfully");
    } else {
      console.error("❌ bun install failed");
      process.exit(1);
    }
  } else if (!DRY_RUN && updatedCount === 0 && pinnedCount === 0) {
    console.log("\n✅ All dependencies are up to date and pinned");
  }
}

main().catch(console.error);
