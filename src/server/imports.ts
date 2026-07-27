import * as path from "path";

/**
 * Static import analysis for .compact files.
 *
 * Compact has two file-referencing forms:
 *   import "./relative/Module";          (optionally: prefix Name_)
 *   include "./relative/File";
 * Bare imports (e.g. `import CompactStandardLibrary;`) refer to the compiler's
 * built-in library and never resolve to workspace files.
 */

const IMPORT_RE = /\b(?:import|include)\s+"([^"]+)"/g;

/** Extract relative file specifiers from source text. */
export function scanImportSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    specs.push(m[1]);
  }
  return specs;
}

/** Resolve an import specifier to an absolute .compact path. */
export function resolveImport(fromFile: string, spec: string): string {
  const withExt = spec.endsWith(".compact") ? spec : `${spec}.compact`;
  return path.resolve(path.dirname(fromFile), withExt);
}

export interface ImportGraph {
  /** file -> files it imports (absolute paths, may include missing files) */
  imports: Map<string, Set<string>>;
  /** file -> files that import it */
  importers: Map<string, Set<string>>;
}

/** Build the workspace import graph from { absolutePath -> sourceText }. */
export function buildImportGraph(files: Map<string, string>): ImportGraph {
  const imports = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();

  for (const [file, text] of files) {
    const targets = new Set<string>();
    for (const spec of scanImportSpecifiers(text)) {
      targets.add(resolveImport(file, spec));
    }
    imports.set(file, targets);
    for (const target of targets) {
      let set = importers.get(target);
      if (!set) {
        set = new Set();
        importers.set(target, set);
      }
      set.add(file);
    }
  }

  return { imports, importers };
}

/**
 * Find the root entrypoints that should be compiled to check `file`.
 *
 * Roots are the files that (transitively) import `file` and are themselves
 * imported by nobody. If `file` has no importers it is its own root. Cycles
 * are tolerated: a cycle with no external importer contributes the changed
 * file itself as the compile target.
 */
export function findCompileRoots(graph: ImportGraph, file: string, maxRoots: number): string[] {
  const roots = new Set<string>();
  const visited = new Set<string>();
  const stack = [file];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const parents = graph.importers.get(current);
    if (!parents || parents.size === 0) {
      roots.add(current);
    } else {
      for (const parent of parents) {
        if (visited.has(parent)) continue;
        stack.push(parent);
      }
    }
  }

  if (roots.size === 0) roots.add(file);

  // Prefer compiling the edited file itself first when it is a root.
  const ordered = [...roots].sort((a, b) => (a === file ? -1 : b === file ? 1 : a.localeCompare(b)));
  return ordered.slice(0, maxRoots);
}

/** All files reachable (via imports) from a root, including the root. */
export function reachableFiles(graph: ImportGraph, root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of graph.imports.get(current) ?? []) {
      stack.push(target);
    }
  }
  return seen;
}
