#!/usr/bin/env node

/**
 * Sync Hall of Fame data.
 *
 * Produces public/data/hall-of-fame.json containing:
 *   - top_authors_by_plugins   – authors with most plugins in registry
 *   - top_authors_by_downloads – authors with most total downloads
 *   - moderators               – from registry/mods.json
 *   - top_contributors         – GitHub contributors across all pockgin org repos
 *
 * Intended to run on a monthly schedule (1st of every month).
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getRateLimitInfo } from "./lib/github-api.js";

const SYNC_CACHE_DIR   = join(process.cwd(), ".sync-cache");
const PUBLIC_DATA_DIR  = process.env.PUBLIC_DATA_DIR  || join(process.cwd(), "..", "pockgin", "public", "data");
const REGISTRY_DIR     = process.env.REGISTRY_DIR     || join(process.cwd(), "..", "pockgin", "registry");
const ORG              = process.env.POCKGIN_ORG       || "pockgin";
const TOKEN            = process.env.GITHUB_TOKEN      || null;
const TOP_LIMIT        = 10;

async function main() {
  console.log("=== Pockgin Hall of Fame Sync ===\n");

  await mkdir(PUBLIC_DATA_DIR, { recursive: true });

  // 1. Load moderators list
  const modsPath = join(REGISTRY_DIR, "mods.json");
  let moderators = [];
  try {
    const raw = await readFile(modsPath, "utf-8");
    const list = JSON.parse(raw);
    moderators = await Promise.all(
      list.map(async (m) => {
        const avatar = await fetchAvatar(m.username);
        return { ...m, avatar_url: avatar };
      })
    );
    console.log(`[mods] Loaded ${moderators.length} moderators`);
  } catch (err) {
    console.warn(`[warn] Could not load mods.json: ${err.message}`);
  }

  // 2. Compute author stats from sync cache
  let pluginFiles = [];
  try {
    pluginFiles = (await readdir(SYNC_CACHE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    console.warn("[warn] No sync cache found – author stats will be empty.");
  }

  const authorMap = new Map(); // github username -> { plugins: [], downloads: 0 }

  for (const file of pluginFiles) {
    try {
      const data = JSON.parse(await readFile(join(SYNC_CACHE_DIR, file), "utf-8"));
      const githubUsername = parseGitHubUsernameFromRepo(data.repo)
        || (Array.isArray(data.producers) && data.producers.length ? String(data.producers[0]) : null)
        || data.author
        || "Unknown";

      if (!authorMap.has(githubUsername)) {
        authorMap.set(githubUsername, {
          username: githubUsername,
          display_name: data.author || githubUsername,
          plugins: [],
          total_downloads: 0,
        });
      }
      const entry = authorMap.get(githubUsername);
      entry.plugins.push({ id: data.id, name: data.name });
      entry.total_downloads += data.total_downloads || 0;
    } catch { /* skip bad cache */ }
  }

  // Attach avatar URLs for top authors
  const allAuthors = Array.from(authorMap.values());
  for (const a of allAuthors) {
    a.avatar_url = await fetchAvatar(a.username);
  }

  const topByPlugins = allAuthors
    .sort((a, b) => b.plugins.length - a.plugins.length || a.username.localeCompare(b.username))
    .slice(0, TOP_LIMIT)
    .map(({ username, display_name, avatar_url, plugins }) => ({
      username,
      display_name,
      avatar_url,
      plugin_count: plugins.length,
      plugins
    }));

  const topByDownloads = allAuthors
    .sort((a, b) => b.total_downloads - a.total_downloads || a.username.localeCompare(b.username))
    .slice(0, TOP_LIMIT)
    .map(({ username, display_name, avatar_url, total_downloads, plugins }) => ({
      username,
      display_name,
      avatar_url,
      total_downloads,
      plugin_count: plugins.length
    }));

  console.log(`[authors] ${allAuthors.length} unique authors computed`);

  // 3. Fetch org contributors from GitHub API
  const topContributors = await fetchOrgContributors(ORG);
  console.log(`[contributors] ${topContributors.length} contributors fetched`);

  // 4. Write output
  const output = {
    last_updated_at: new Date().toISOString(),
    moderators,
    top_authors_by_plugins: topByPlugins,
    top_authors_by_downloads: topByDownloads,
    top_contributors: topContributors,
  };

  const outPath = join(PUBLIC_DATA_DIR, "hall-of-fame.json");
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[done] Written to ${outPath}`);
  console.log("=== Hall of Fame Sync Complete ===");
}

async function fetchOrgContributors(org) {
  // Fetch all repos in org, then aggregate contributor counts.
  const repos = await fetchJson(`https://api.github.com/orgs/${org}/repos?per_page=100&type=public`);
  if (!repos || !Array.isArray(repos)) return [];

  const contribMap = new Map(); // login -> { login, avatar_url, contributions, repos[] }

  for (const repo of repos) {
    if (repo.fork) continue;
    const contributors = await fetchJson(
      `https://api.github.com/repos/${org}/${repo.name}/contributors?per_page=100&anon=0`
    );
    if (!Array.isArray(contributors)) continue;

    for (const c of contributors) {
      if (!c.login || c.type === "Bot") continue;
      if (!contribMap.has(c.login)) {
        contribMap.set(c.login, {
          username: c.login,
          avatar_url: c.avatar_url || null,
          contributions: 0,
          repos: [],
        });
      }
      const entry = contribMap.get(c.login);
      entry.contributions += c.contributions || 0;
      entry.repos.push({ repo: repo.name, contributions: c.contributions || 0 });
    }

    const { remaining } = getRateLimitInfo();
    if (remaining !== null && remaining < 20) {
      console.warn(`[warn] Rate limit very low (${remaining}). Stopping contributor fetch early.`);
      break;
    }
  }

  return Array.from(contribMap.values())
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, TOP_LIMIT);
}

async function fetchAvatar(username) {
  if (!username || username === "Unknown") return null;
  return `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?s=64`;
}

function parseGitHubUsernameFromRepo(repoUrl) {
  const match = String(repoUrl || "").match(/^https:\/\/github\.com\/([^/]+)\/[^/]+/i);
  return match ? match[1] : null;
}

async function fetchJson(url) {
  try {
    const headers = { "User-Agent": "pockgin-bot/1.0", Accept: "application/vnd.github+json" };
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[warn] ${url} -> HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[warn] fetch ${url}: ${err.message}`);
    return null;
  }
}

main();
