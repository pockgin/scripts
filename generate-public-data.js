#!/usr/bin/env node

/**
 * Generate public/data/* from synced plugin data.
 * Reads .sync-cache/*.json and produces:
 *   public/data/plugins.json       – summary list for homepage
 *   public/data/plugins/{id}.json  – full detail per plugin
 *   public/data/stats.json         – aggregate stats
 *
 * Fail-safe: never overwrites existing public data with empty output.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const SYNC_CACHE_DIR = join(process.cwd(), ".sync-cache");
const PUBLIC_DATA_DIR = process.env.PUBLIC_DATA_DIR || join(process.cwd(), "..", "pockgin", "public", "data");
const PLUGINS_DIR = join(PUBLIC_DATA_DIR, "plugins");

async function main() {
  console.log("=== Generate Public Data ===\n");

  await mkdir(PLUGINS_DIR, { recursive: true });

  let files;
  try {
    files = (await readdir(SYNC_CACHE_DIR)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    console.error(`Cannot read sync cache: ${err.message}`);
    console.warn("Keeping existing public data intact.");
    process.exit(1);
  }

  if (files.length === 0) {
    console.warn("No synced data found. Keeping existing public data intact.");
    process.exit(0);
  }

  const plugins = [];

  for (const file of files) {
    const raw = await readFile(join(SYNC_CACHE_DIR, file), "utf-8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn(`[skip] ${file}: invalid JSON in sync cache`);
      continue;
    }

    // Write full detail file
    await writeFile(join(PLUGINS_DIR, file), JSON.stringify(data, null, 2));
    console.log(`[detail] ${data.id}`);

    // Build summary item for homepage
    plugins.push({
      id: data.id,
      name: data.name,
      author: data.author || "Unknown",
      description: data.description || "",
      icon_url: data.icon_url || "happy_ghast.png",
      featured: data.featured || false,
      verified: data.verified || false,
      stable_version: data.versions?.stable?.version || null,
      total_downloads: data.total_downloads || 0,
      stars: data.stars || 0,
      download_url: data.versions?.stable?.download_url || null,
    });
  }

  // Fail-safe: do not write empty plugins list if we had files
  if (plugins.length === 0 && files.length > 0) {
    console.warn("All plugins failed to parse. Keeping existing public data.");
    process.exit(1);
  }

  // Sort by name
  plugins.sort((a, b) => a.name.localeCompare(b.name));

  // Write plugins.json
  await writeFile(join(PUBLIC_DATA_DIR, "plugins.json"), JSON.stringify(plugins, null, 2));
  console.log(`\n[list] plugins.json (${plugins.length} plugins)`);

  // Write stats.json
  const stats = {
    total_plugins: plugins.length,
    total_downloads: plugins.reduce((sum, p) => sum + (p.total_downloads || 0), 0),
    total_verified: plugins.filter((p) => p.verified).length,
    last_sync_at: new Date().toISOString(),
  };
  await writeFile(join(PUBLIC_DATA_DIR, "stats.json"), JSON.stringify(stats, null, 2));
  console.log(`[stats] stats.json`);

  console.log("\n=== Done ===");
}

main();
