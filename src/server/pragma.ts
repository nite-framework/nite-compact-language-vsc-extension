/**
 * Language-version pragma detection.
 *
 * The compiler ACCEPTS a contract with no `pragma language_version` — verified
 * by compiling one: it exits 0 and reports nothing. So a missing pragma cannot
 * be surfaced as a compiler error; the extension raises it as its own warning
 * instead, because without a pragma the file is built against whatever
 * toolchain happens to be installed.
 *
 * Only entry contracts are linted. Imported modules legitimately omit the
 * pragma — every module in real projects does.
 */

/** True when the source declares a language version. */
export function hasLanguagePragma(source: string): boolean {
  return /^[ \t]*pragma\s+language_version\b/m.test(source);
}

/**
 * True when the file is a module definition rather than an entry contract.
 *
 * Decided by CONTENT, not by directory: a file whose only top-level
 * declarations are `module` blocks defines modules, and module files
 * legitimately carry no pragma. Location is irrelevant — modules may live
 * anywhere, and relying on being imported is fragile (a module reached only by
 * a bare `import Utils prefix Utils_;` may not yet be linked to its importer).
 */
export function isModuleFile(source: string): boolean {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^[ \t]*\/\/.*$/gm, "");   // line comments

  let sawModule = false;
  let depth = 0;
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (depth === 0) {
      if (/^(?:export\s+)?module\s+[A-Za-z_]/.test(line)) {
        sawModule = true;
      } else if (!/^(?:pragma|import|include)\b/.test(line)) {
        // A top-level declaration that is not a module: this is a contract.
        return false;
      }
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return sawModule;
}
