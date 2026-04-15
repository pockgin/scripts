const ID_PATTERN = /^[a-z0-9-]+$/;
const GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const VALID_BUILD_PROVIDERS = ["github-releases"];
const VALID_COMMENT_PROVIDERS = ["giscus"];

export function validateRegistryEntry(data, filename) {
  const errors = [];

  if (!data.id || typeof data.id !== "string") {
    errors.push("Missing or invalid 'id'");
  } else if (!ID_PATTERN.test(data.id)) {
    errors.push(`'id' must be lowercase-kebab-case [a-z0-9-], got: "${data.id}"`);
  }

  if (filename && data.id) {
    const expected = data.id + ".json";
    if (filename !== expected) {
      errors.push(`Filename "${filename}" does not match id "${data.id}" (expected "${expected}")`);
    }
  }

  if (!data.name || typeof data.name !== "string") {
    errors.push("Missing or invalid 'name'");
  }

  if (!data.repo || typeof data.repo !== "string") {
    errors.push("Missing or invalid 'repo'");
  } else if (!GITHUB_REPO_PATTERN.test(data.repo)) {
    errors.push(`'repo' must be a valid GitHub repo URL, got: "${data.repo}"`);
  }

  if (!data.approved_release_tag || typeof data.approved_release_tag !== "string") {
    errors.push("Missing or invalid 'approved_release_tag'");
  }

  if (!data.build || typeof data.build !== "object") {
    errors.push("Missing or invalid 'build' object");
  } else if (!VALID_BUILD_PROVIDERS.includes(data.build.provider)) {
    errors.push(`'build.provider' must be one of: ${VALID_BUILD_PROVIDERS.join(", ")}`);
  }

  if (data.comments && typeof data.comments === "object") {
    if (data.comments.enabled && data.comments.provider) {
      if (!VALID_COMMENT_PROVIDERS.includes(data.comments.provider)) {
        errors.push(`'comments.provider' must be one of: ${VALID_COMMENT_PROVIDERS.join(", ")}`);
      }
    }
  }

  return errors;
}
