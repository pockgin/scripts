import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";

const ICON_DIR_REL = "assets/icons";
const DEFAULT_ICON = "happy_ghast.png";

const RELEASE_ICON_NAMES = ["icon.png", "logo.png", "icon.jpg", "logo.jpg"];
const REPO_ICON_PATHS = [
  "resources/icon.png",
  "icon.png",
  "resources/logo.png",
  "logo.png",
];

/**
 * Try to resolve and mirror an icon for a plugin.
 * Priority: release asset > repo file > default
 */
export async function resolveIcon(pluginId, releases, owner, repo, token, publicDir, ref = "HEAD") {
  const iconDir = join(publicDir, ICON_DIR_REL);
  await mkdir(iconDir, { recursive: true });

  // 1) Check release assets for icon
  for (const release of releases) {
    if (!release.assets) continue;
    for (const asset of release.assets) {
      if (RELEASE_ICON_NAMES.includes(asset.name.toLowerCase())) {
        const saved = await downloadAndSave(asset.browser_download_url, pluginId, iconDir);
        if (saved) return ICON_DIR_REL + "/" + saved;
      }
    }
  }

  // 2) Check repo for icon files
  for (const repoPath of REPO_ICON_PATHS) {
    const encodedRef = encodeURIComponent(ref || "HEAD");
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedRef}/${repoPath}`;
    const saved = await downloadAndSave(url, pluginId, iconDir);
    if (saved) return ICON_DIR_REL + "/" + saved;
  }

  // 3) Fallback
  return DEFAULT_ICON;
}

async function downloadAndSave(url, pluginId, iconDir) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Pockgin-Scripts/0.1" },
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = extname(url).split("?")[0] || ".png";
    const filename = pluginId + ext;
    const dest = join(iconDir, filename);
    await writeFile(dest, buffer);
    console.log(`  [icon] Saved ${filename}`);
    return filename;
  } catch {
    return null;
  }
}
