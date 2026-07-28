import * as path from "path";

/**
 * Static import analysis for .compact files.
 *
 * Compact references other code in two ways, and BOTH can name workspace files:
 *
 *   import "./relative/Module" prefix Name_;   // quoted: a path
 *   include "./relative/File";
 *   import CustomStructs prefix CustomStructs_;  // bare: a module NAME
 *
 * The bare form is what modules typically use to reach sibling modules. It
 * does not say where the file is, so the name is resolved by searching the
 * workspace (see `resolveModuleName`) rather than by path arithmetic. Only a
 * small set of bare names are compiler built-ins with no file behind them.
 */

/** Bare import names provided by the compiler, never backed by a file. */
export const BUILTIN_MODULES = new Set(["CompactStandardLibrary"]);

/** Quoted path form. */
const FILE_IMPORT_RE = /\b(?:import|include)\s+"([^"]+)"(?:\s+prefix\s+([A-Za-z_][A-Za-z0-9_]*))?/g;
/** Bare module-name form. */
const MODULE_IMPORT_RE =
  /\b(?:import|include)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+prefix\s+([A-Za-z_][A-Za-z0-9_]*))?/g;

export interface ImportRef {
  /** Path as written (file form) or module name (bare form). */
  spec: string;
  /** How it was written — determines how it is resolved. */
  kind: "file" | "module";
  /** Import prefix, when one was given. */
  prefix: string | null;
  /** True for compiler built-ins such as CompactStandardLibrary. */
  builtin: boolean;
  /** 0-based line of the statement. */
  line: number;
  /** 0-based column of the first character of the specifier. */
  startChar: number;
  /** 0-based column just past the last character of the specifier. */
  endChar: number;
}

/**
 * Locate every import/include with its position, so specifiers can be turned
 * into links and followed for symbol resolution. Covers both the quoted-path
 * and bare-module-name forms.
 */
export function scanImportRefs(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const source = lines[line].replace(/\/\/.*$/, "");

    FILE_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const claimed: Array<[number, number]> = [];
    while ((m = FILE_IMPORT_RE.exec(source)) !== null) {
      const startChar = m.index + m[0].indexOf(`"${m[1]}"`) + 1;
      claimed.push([m.index, m.index + m[0].length]);
      refs.push({
        spec: m[1],
        kind: "file",
        prefix: m[2] ?? null,
        builtin: false,
        line,
        startChar,
        endChar: startChar + m[1].length,
      });
    }

    MODULE_IMPORT_RE.lastIndex = 0;
    while ((m = MODULE_IMPORT_RE.exec(source)) !== null) {
      // Skip anything already consumed as a quoted import on this line.
      if (claimed.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
      // Match the name as a whole word: `import Helpers prefix Helpers_;` must
      // select the module name, not the `Helpers` inside the prefix token.
      const startChar = m.index + m[0].search(new RegExp(`\\b${m[1]}\\b`));
      refs.push({
        spec: m[1],
        kind: "module",
        prefix: m[2] ?? null,
        builtin: BUILTIN_MODULES.has(m[1]),
        line,
        startChar,
        endChar: startChar + m[1].length,
      });
    }
  }
  return refs;
}

/** Extract every specifier that may name a workspace file. */
export function scanImportSpecifiers(text: string): string[] {
  return scanImportRefs(text)
    .filter((r) => !r.builtin)
    .map((r) => r.spec);
}

/** Resolve a quoted import specifier to an absolute .compact path. */
export function resolveImport(fromFile: string, spec: string): string {
  const withExt = spec.endsWith(".compact") ? spec : `${spec}.compact`;
  return path.resolve(path.dirname(fromFile), withExt);
}

/**
 * Resolve a bare module name (`import CustomStructs prefix C_;`) to a file.
 *
 * The name carries no location, so candidates are tried in order of decreasing
 * confidence: a sibling file, a `modules/` subdirectory (the recommended
 * layout), a sibling `modules/` directory, then any known workspace file with
 * a matching basename, and finally any file that actually declares
 * `module <name>`. Returns null when nothing matches.
 */
export function resolveModuleName(
  fromFile: string,
  name: string,
  knownFiles: Iterable<string>,
  readFile?: (file: string) => string | null,
): string | null {
  if (BUILTIN_MODULES.has(name)) return null;
  const dir = path.dirname(fromFile);
  const files = [...knownFiles];
  const byPath = new Set(files);

  const candidates = [
    path.join(dir, `${name}.compact`),
    path.join(dir, "modules", `${name}.compact`),
    path.join(path.dirname(dir), `${name}.compact`),
    path.join(path.dirname(dir), "modules", `${name}.compact`),
  ];
  for (const candidate of candidates) {
    if (byPath.has(candidate)) return candidate;
  }

  const basenameMatches = files.filter((f) => path.basename(f) === `${name}.compact`);
  if (basenameMatches.length > 0) return basenameMatches[0];

  if (readFile) {
    const declares = new RegExp(`^\\s*(?:export\\s+)?module\\s+${name}\\b`, "m");
    for (const file of files) {
      const text = readFile(file);
      if (text !== null && declares.test(text)) return file;
    }
  }
  return null;
}

/** True when `file` sits inside a directory named `modules`. */
export function isInModulesDir(file: string): boolean {
  return path
    .dirname(file)
    .split(path.sep)
    .some((segment) => segment.toLowerCase() === "modules");
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

  const known = [...files.keys()];
  const readFile = (f: string): string | null => files.get(f) ?? null;

  for (const [file, text] of files) {
    const targets = new Set<string>();
    for (const ref of scanImportRefs(text)) {
      if (ref.builtin) continue;
      if (ref.kind === "file") {
        targets.add(resolveImport(file, ref.spec));
        continue;
      }
      // Bare module name: search the workspace. Unresolvable names are simply
      // skipped, so a built-in we do not know about cannot invent an edge.
      const resolved = resolveModuleName(file, ref.spec, known, readFile);
      if (resolved) targets.add(resolved);
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
