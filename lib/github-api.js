import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), ".cache");
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 60_000;

let rateLimitRemaining = null;
let rateLimitReset = null;

export function getRateLimitInfo() {
  return { remaining: rateLimitRemaining, reset: rateLimitReset };
}

async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}

function cacheFilePath(key) {
  return join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}

async function loadCachedETag(key) {
  try {
    const raw = await readFile(cacheFilePath(key), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCachedETag(key, etag, data) {
  await ensureCacheDir();
  await writeFile(cacheFilePath(key), JSON.stringify({ etag, data, cached_at: new Date().toISOString() }));
}

export async function githubFetch(endpoint, token) {
  const url = endpoint.startsWith("https://") ? endpoint : `https://api.github.com${endpoint}`;
  const cacheKey = url;

  const cached = await loadCachedETag(cacheKey);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Pockgin-Scripts/0.1",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (cached && cached.etag) {
    headers["If-None-Match"] = cached.etag;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });

      rateLimitRemaining = parseInt(res.headers.get("x-ratelimit-remaining") || "0", 10);
      rateLimitReset = parseInt(res.headers.get("x-ratelimit-reset") || "0", 10);

      if (res.status === 304 && cached) {
        console.log(`  [cache-hit] ${endpoint}`);
        return cached.data;
      }

      if (res.status === 403 || res.status === 429) {
        const resetAt = rateLimitReset ? new Date(rateLimitReset * 1000) : null;
        console.warn(`  [rate-limited] ${endpoint} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), reset: ${resetAt}`);
        if (attempt < MAX_RETRIES) {
          const wait = BACKOFF_BASE_MS * Math.pow(2, attempt);
          console.warn(`  [backoff] Waiting ${wait / 1000}s...`);
          await sleep(wait);
          continue;
        }
        throw new Error(`Rate limited after ${MAX_RETRIES + 1} attempts: ${endpoint}`);
      }

      if (!res.ok) {
        throw new Error(`GitHub API ${res.status}: ${endpoint}`);
      }

      const data = await res.json();
      const etag = res.headers.get("etag");
      if (etag) {
        await saveCachedETag(cacheKey, etag, data);
      }
      console.log(`  [fetched] ${endpoint} (remaining: ${rateLimitRemaining})`);
      return data;
    } catch (err) {
      if (attempt < MAX_RETRIES && !err.message.includes("Rate limited")) {
        console.warn(`  [retry] ${endpoint}: ${err.message}`);
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
}

export async function fetchRepoInfo(owner, repo, token) {
  return githubFetch(`/repos/${owner}/${repo}`, token);
}

export async function fetchReleases(owner, repo, token) {
  return githubFetch(`/repos/${owner}/${repo}/releases?per_page=20`, token);
}

export async function fetchFileContent(owner, repo, path, ref, token) {
  try {
    const data = await githubFetch(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, token);
    if (data.content && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
