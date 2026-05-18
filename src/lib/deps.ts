/**
 * Dependency wave builder for the Execute phase.
 *
 * Given a list of file paths and an import-graph function, groups the files
 * into ordered "waves" where files in the same wave have no dependency on
 * each other.  Waves must be run sequentially; files within a wave can run
 * concurrently.
 *
 * The algorithm is Kahn's topological sort.  If a cycle is detected the
 * remaining files are collected into a final catch-all wave so execution
 * always completes.
 */

/**
 * Build dependency waves from a list of files and an import map.
 *
 * @param files    Ordered list of file paths (manifest order)
 * @param depMap   Map from file path → Set of file paths it imports from
 *                 (only entries whose values are also in `files` matter)
 * @returns        Array of waves; each wave is an array of file paths
 */
export function buildWaves(
  files: string[],
  depMap: Map<string, Set<string>>,
): string[][] {
  if (files.length === 0) return [];
  if (files.length === 1) return [[files[0]]];

  const waves: string[][] = [];
  const remaining = new Set(files);

  while (remaining.size > 0) {
    const scheduled = new Set(waves.flat());
    const wave = [...remaining].filter((fp) => {
      const deps = depMap.get(fp) ?? new Set();
      for (const dep of deps) {
        // Only block on deps that are (a) in the manifest and (b) not yet scheduled
        if (remaining.has(dep) && !scheduled.has(dep)) return false;
      }
      return true;
    });
    if (wave.length === 0) {
      // Cycle — dump all remaining into one final wave
      waves.push([...remaining]);
      break;
    }
    waves.push(wave);
    for (const fp of wave) remaining.delete(fp);
  }

  return waves;
}

/**
 * Parse relative import paths from source text and resolve them against a
 * list of known manifest files.
 *
 * Returns a Set of manifest file paths that `source` depends on.
 *
 * @param source    File content (or description text)
 * @param ownPath   The file's own path (self-imports are excluded)
 * @param manifest  All manifest file paths
 */
export function parseImportDeps(
  source: string,
  ownPath: string,
  manifest: string[],
): Set<string> {
  const deps = new Set<string>();
  const importRegex = /from\s+['"]([^'"]+)['"]/g;

  for (const m of source.matchAll(importRegex)) {
    const importPath = m[1];
    if (!importPath.startsWith(".")) continue; // external package

    const base = importPath.replace(/^\.\.?\//, "").replace(/\\/g, "/");
    // Try exact match first
    const exact = manifest.find((f) => f === base);
    if (exact && exact !== ownPath) {
      deps.add(exact);
      continue;
    }
    // Try basename match (handles extension-less imports)
    const baseName = base.replace(/\.\w+$/, "").toLowerCase();
    const byBase = manifest.find(
      (f) => f.replace(/\.\w+$/, "").toLowerCase() === baseName,
    );
    if (byBase && byBase !== ownPath) deps.add(byBase);
  }

  return deps;
}
