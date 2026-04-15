#!/usr/bin/env node

/**
 * Validate all registry/plugins/*.json files against the schema.
 * Also checks for duplicate IDs and duplicate repo URLs.
 * Exit code 1 on any validation error.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateRegistryEntry } from "./lib/schema.js";

const REGISTRY_DIR = process.env.REGISTRY_DIR || join(process.cwd(), "..", "pockgin", "registry", "plugins");

async function main() {
  console.log(`Validating registry at: ${REGISTRY_DIR}\n`);

  let files;
  try {
    files = (await readdir(REGISTRY_DIR)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    console.error(`Cannot read registry directory: ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.warn("No registry entries found.");
    process.exit(0);
  }

  const seenIds = new Map();
  const seenRepos = new Map();
  let totalErrors = 0;

  for (const file of files) {
    const filePath = join(REGISTRY_DIR, file);
    let data;

    try {
      const raw = await readFile(filePath, "utf-8");
      data = JSON.parse(raw);
    } catch (err) {
      console.error(`[FAIL] ${file}: Invalid JSON – ${err.message}`);
      totalErrors++;
      continue;
    }

    const errors = validateRegistryEntry(data, file);

    // Duplicate checks
    if (data.id) {
      if (seenIds.has(data.id)) {
        errors.push(`Duplicate id "${data.id}" (also in ${seenIds.get(data.id)})`);
      } else {
        seenIds.set(data.id, file);
      }
    }

    if (data.repo) {
      const repoNorm = data.repo.toLowerCase().replace(/\/$/, "");
      if (seenRepos.has(repoNorm)) {
        errors.push(`Duplicate repo "${data.repo}" (also in ${seenRepos.get(repoNorm)})`);
      } else {
        seenRepos.set(repoNorm, file);
      }
    }

    if (errors.length > 0) {
      console.error(`[FAIL] ${file}:`);
      errors.forEach((e) => console.error(`  - ${e}`));
      totalErrors += errors.length;
    } else {
      console.log(`[OK]   ${file}`);
    }
  }

  console.log(`\nValidated ${files.length} file(s), ${totalErrors} error(s).`);
  process.exit(totalErrors > 0 ? 1 : 0);
}

main();
