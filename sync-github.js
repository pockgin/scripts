#!/usr/bin/env node

/**
 * Sync GitHub data for all registry plugins.
 * Reads registry/plugins/*.json, fetches data from GitHub API,
 * writes enriched data to .sync-cache/ for generate step.
 *
 * Respects rate-limit: uses ETag caching, exponential backoff, and
 * graceful degradation when quota is low.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchRepoInfo, fetchReleases, fetchFileContent, getRateLimitInfo } from "./lib/github-api.js";
import { resolveIcon } from "./lib/icon-resolver.js";
import yaml from "js-yaml";

const REGISTRY_DIR = process.env.REGISTRY_DIR || join(process.cwd(), "..", "pockgin", "registry", "plugins");
const SYNC_CACHE_DIR = join(process.cwd(), ".sync-cache");
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(process.cwd(), "..", "pockgin");
const TOKEN = process.env.GITHUB_TOKEN || null;

const LOW_QUOTA_THRESHOLD = 50;

async function main() {
  console.log("=== Pockgin GitHub Sync ===\n");

  if (!TOKEN) {
    console.warn("[warn] No GITHUB_TOKEN set. Unauthenticated requests have a very low rate limit (60/hr).\n");
  }

  await mkdir(SYNC_CACHE_DIR, { recursive: true });

  let files;
  try {
    files = (await readdir(REGISTRY_DIR)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    console.error(`Cannot read registry: ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.warn("No registry entries to sync.");
    process.exit(0);
  }

  const results = [];
  let failCount = 0;

  for (const file of files) {
    const raw = await readFile(join(REGISTRY_DIR, file), "utf-8");
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      console.error(`[skip] ${file}: invalid JSON`);
      failCount++;
      continue;
    }

    console.log(`\n[sync] ${entry.id} (${entry.repo})`);

    // Check remaining quota
    const { remaining } = getRateLimitInfo();
    if (remaining !== null && remaining < LOW_QUOTA_THRESHOLD) {
      console.warn(`[warn] Rate limit low (${remaining} remaining). Skipping non-essential metadata.`);
    }

    try {
      const enriched = await syncPlugin(entry);
      results.push(enriched);
      await writeFile(join(SYNC_CACHE_DIR, file), JSON.stringify(enriched, null, 2));
      console.log(`[done] ${entry.id}`);
    } catch (err) {
      console.error(`[fail] ${entry.id}: ${err.message}`);
      failCount++;

      // Try to use previous sync cache as fallback
      try {
        const prev = JSON.parse(await readFile(join(SYNC_CACHE_DIR, file), "utf-8"));
        results.push(prev);
        console.log(`[fallback] Using cached data for ${entry.id}`);
      } catch {
        console.warn(`[warn] No fallback data for ${entry.id}`);
      }
    }
  }

  const { remaining, reset } = getRateLimitInfo();
  console.log(`\n=== Sync Complete ===`);
  console.log(`Synced: ${results.length}, Failed: ${failCount}`);
  if (remaining !== null) {
    console.log(`Rate limit remaining: ${remaining}, resets at: ${new Date(reset * 1000).toISOString()}`);
  }

  if (failCount > 0) {
    console.warn("\n[warn] Some plugins failed to sync. Existing public data is preserved.");
  }
}

async function syncPlugin(entry) {
  const match = entry.repo.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!match) throw new Error(`Cannot parse repo URL: ${entry.repo}`);
  const [, owner, repo] = match;

  // Fetch repo info (stars, description, last push)
  const repoInfo = await fetchRepoInfo(owner, repo, TOKEN);

  // Fetch releases
  const allReleases = await fetchReleases(owner, repo, TOKEN);

  // Find approved release
  const approvedTag = entry.approved_release_tag;
  const approvedRelease = allReleases.find((r) => r.tag_name === approvedTag);

  // Determine stable and dev versions from approved releases
  let stableVersion = null;
  let devVersion = null;

  if (approvedRelease) {
    stableVersion = buildVersionInfo(approvedRelease);
  }

  if (entry.build && entry.build.include_prerelease) {
    const devRelease = allReleases.find((r) => r.prerelease && r.tag_name !== approvedTag);
    if (devRelease) {
      devVersion = buildVersionInfo(devRelease);
    }
  }

  // Calculate total downloads from all approved release assets
  let totalDownloads = 0;
  if (approvedRelease && approvedRelease.assets) {
    totalDownloads = approvedRelease.assets.reduce((sum, a) => sum + (a.download_count || 0), 0);
  }

  // Try to parse plugin.yml for enriched metadata
  let pluginYml = null;
  let readmeMarkdown = "";
  const { remaining } = getRateLimitInfo();
  if (remaining === null || remaining >= LOW_QUOTA_THRESHOLD) {
    const raw = await fetchFileContent(owner, repo, "plugin.yml", approvedTag || "HEAD", TOKEN);
    if (raw) {
      try {
        pluginYml = yaml.load(raw);
      } catch { /* ignore parse errors */ }
    }

    const readmeRaw = await fetchReadmeContent(owner, repo, approvedTag || "HEAD");
    if (readmeRaw) {
      readmeMarkdown = readmeRaw;
    }
  }

  // Resolve description: plugin.yml > repo description
  const description =
    (pluginYml && pluginYml.description) ||
    repoInfo.description ||
    "";

  // Resolve author: plugin.yml > repo owner
  const author =
    (pluginYml && pluginYml.author) ||
    repoInfo.owner?.login ||
    owner;

  // Resolve icon
  const iconUrl = await resolveIcon(entry.id, allReleases, owner, repo, TOKEN, PUBLIC_DIR, approvedTag || "HEAD");

  const apiSupport = normalizeStringList(pluginYml?.api);
  const requiredDeps = normalizeStringList(pluginYml?.depend);
  const optionalDeps = normalizeStringList(pluginYml?.softdepend);
  const producers = buildProducers(pluginYml, owner);
  const tags = Array.isArray(repoInfo.topics) ? repoInfo.topics.filter(Boolean) : [];
  const whatsNew = approvedRelease?.body || "";
  const lastUpdatedAt = approvedRelease?.published_at || repoInfo.pushed_at || null;

  const licenseInfo = repoInfo.license
    ? {
        spdx_id: repoInfo.license.spdx_id || null,
        name: repoInfo.license.name || null,
        url: repoInfo.license.url || null,
      }
    : null;

  // Recent builds (up to 5)
  const recentBuilds = allReleases.slice(0, 5).map((r) => ({
    tag: r.tag_name,
    published_at: r.published_at,
    download_url: pharAssetUrl(r),
  }));

  return {
    id: entry.id,
    name: entry.name,
    author,
    description,
    readme_markdown: readmeMarkdown,
    repo: entry.repo,
    archive_repo: entry.archive_repo || null,
    icon_url: iconUrl,
    featured: entry.featured || false,
    verified: entry.verified || false,
    approved_release_tag: approvedTag,
    stars: repoInfo.stargazers_count || 0,
    total_downloads: totalDownloads,
    last_commit_at: repoInfo.pushed_at || null,
    last_updated_at: lastUpdatedAt,
    license: licenseInfo,
    api_support: apiSupport,
    dependencies: {
      required: requiredDeps,
      optional: optionalDeps,
    },
    tags,
    producers,
    whats_new: whatsNew,
    versions: {
      stable: stableVersion,
      dev: devVersion,
    },
    recent_builds: recentBuilds,
    comments: entry.comments || { enabled: false },
    build: entry.build,
  };
}

async function fetchReadmeContent(owner, repo, ref) {
  const candidates = ["README.md", "README.MD", "readme.md"];
  for (const filePath of candidates) {
    const raw = await fetchFileContent(owner, repo, filePath, ref, TOKEN);
    if (raw) return raw;
  }
  return null;
}

function buildVersionInfo(release) {
  const pharUrl = pharAssetUrl(release);
  const downloads = release.assets
    ? release.assets.reduce((sum, a) => sum + (a.download_count || 0), 0)
    : 0;

  return {
    version: release.tag_name.replace(/^v/, ""),
    tag: release.tag_name,
    published_at: release.published_at,
    downloads,
    download_url: pharUrl,
  };
}

function pharAssetUrl(release) {
  if (!release.assets) return null;
  const phar = release.assets.find((a) => a.name.endsWith(".phar"));
  return phar ? phar.browser_download_url : null;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (value === undefined || value === null || value === "") return [];
  return [String(value).trim()].filter(Boolean);
}

function buildProducers(pluginYml, owner) {
  const set = new Set();
  normalizeStringList(pluginYml?.author).forEach((x) => set.add(x));
  normalizeStringList(pluginYml?.authors).forEach((x) => set.add(x));
  if (owner) set.add(owner);
  return Array.from(set);
}

main();
