/**
 * Lightweight regex-based symbol extraction. This is intentionally not a full
 * parser — the compiler remains the source of truth for correctness — but it
 * is enough for outline, completion, and cross-module suggestions.
 */

export type CompactSymbolKind =
  | "circuit"
  | "pure-circuit"
  | "witness"
  | "ledger"
  | "struct"
  | "enum"
  | "module"
  | "constructor"
  | "const"
  | "parameter";

export interface CompactSymbol {
  name: string;
  kind: CompactSymbolKind;
  exported: boolean;
  /** 0-based line of the declaration. */
  line: number;
  /** Signature-ish detail for completion/hover, single line. */
  detail: string;
  /** Name of the enclosing module, if any. */
  container?: string;
  /**
   * Declared type, when the source states one. Present for `ledger` fields and
   * for parameters; present for `const` only when explicitly annotated. Never
   * inferred — an unannotated `const` has no type here.
   */
  type?: string;
  /** Right-hand side of a `const`, verbatim and truncated. */
  init?: string;
  /** Name of the enclosing circuit, for parameters and locals. */
  scope?: string;
  /**
   * Documentation comment written immediately above the declaration, with the
   * comment markers stripped. Undefined when there is none.
   */
  doc?: string;
}

/**
 * Collect the documentation comment directly above line `declLine`.
 *
 * Recognises a `/** ... *\/` block (single or multi-line) and runs of `//`
 * lines. The comment must be adjacent — a blank line between it and the
 * declaration means it belongs to something else, not to this symbol.
 */
export function docCommentAbove(lines: string[], declLine: number): string | undefined {
  let i = declLine - 1;
  if (i < 0) return undefined;
  const trimmed = (n: number): string => (lines[n] ?? "").trim();

  // Block comment ending just above the declaration.
  if (trimmed(i).endsWith("*/")) {
    const collected: string[] = [];
    while (i >= 0) {
      const line = trimmed(i);
      collected.unshift(line);
      if (line.startsWith("/*")) break;
      i--;
    }
    if (i < 0) return undefined;
    const body = collected
      .join("\n")
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((l) => l.trim().replace(/^\*\s?/, ""))
      .join("\n")
      .trim();
    return body.length > 0 ? body : undefined;
  }

  // A run of `//` lines.
  if (trimmed(i).startsWith("//")) {
    const collected: string[] = [];
    while (i >= 0 && trimmed(i).startsWith("//")) {
      collected.unshift(trimmed(i).replace(/^\/\/+\s?/, ""));
      i--;
    }
    const body = collected.join("\n").trim();
    return body.length > 0 ? body : undefined;
  }

  return undefined;
}

interface Matcher {
  re: RegExp;
  kind: (m: RegExpMatchArray) => CompactSymbolKind;
  name: (m: RegExpMatchArray) => string;
  /** Declared type, when the grammar exposes one. */
  type?: (m: RegExpMatchArray) => string | undefined;
}

const MATCHERS: Matcher[] = [
  {
    re: /^(\s*)(export\s+)?(pure\s+)?circuit\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?(\s*:\s*[^\{;]+)?/,
    kind: (m) => (m[3] ? "pure-circuit" : "circuit"),
    name: (m) => m[4],
  },
  {
    re: /^(\s*)(export\s+)?witness\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?(\s*:\s*[^;]+)?/,
    kind: () => "witness",
    name: (m) => m[3],
  },
  {
    re: /^(\s*)(export\s+)?(sealed\s+)?ledger\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+)/,
    kind: () => "ledger",
    name: (m) => m[4],
    type: (m) => m[5]?.trim(),
  },
  {
    // `const NAME[: TYPE] = INIT;` — the type group is optional because the
    // overwhelming majority of real constants are unannotated.
    re: /^(\s*)const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?)\s*)?=\s*(.+?)\s*;?\s*$/,
    kind: () => "const",
    name: (m) => m[2],
    type: (m) => m[3]?.trim(),
  },
  {
    re: /^(\s*)(export\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
    kind: () => "struct",
    name: (m) => m[3],
  },
  {
    re: /^(\s*)(export\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
    kind: () => "enum",
    name: (m) => m[3],
  },
  {
    re: /^(\s*)(export\s+)?module\s+([A-Za-z_][A-Za-z0-9_]*)/,
    kind: () => "module",
    name: (m) => m[3],
  },
  {
    re: /^(\s*)constructor\s*\(/,
    kind: () => "constructor",
    name: () => "constructor",
  },
];

export function extractSymbols(text: string): CompactSymbol[] {
  const symbols: CompactSymbol[] = [];
  const lines = text.split(/\r?\n/);
  let currentModule: string | undefined;
  let currentCircuit: string | undefined;
  let moduleBraceDepth = 0;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const noComment = line.replace(/\/\/.*$/, "");

    for (const matcher of MATCHERS) {
      const m = noComment.match(matcher.re);
      if (!m) continue;
      const kind = matcher.kind(m);
      const name = matcher.name(m);
      const detail = noComment.trim().replace(/\s*\{\s*$/, "").slice(0, 120);

      if (kind === "module") {
        currentModule = name;
        moduleBraceDepth = depth;
      }
      if (kind === "circuit" || kind === "pure-circuit" || kind === "witness") {
        currentCircuit = name;
        // Parameters are scoped to this circuit; record them too.
        for (const param of extractParameters(noComment)) {
          symbols.push({ ...param, line: i, container: currentModule, scope: name });
        }
      }

      const doc = docCommentAbove(lines, i);
      symbols.push({
        name,
        kind,
        exported: /\bexport\b/.test(noComment),
        line: i,
        detail,
        container: kind === "module" ? undefined : currentModule,
        ...(matcher.type ? { type: matcher.type(m) } : {}),
        ...(kind === "const" ? { init: m[4]?.trim().slice(0, 120), scope: currentCircuit } : {}),
        ...(doc ? { doc } : {}),
      });
      break;
    }

    for (const ch of noComment) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (currentModule !== undefined && depth <= moduleBraceDepth) {
          currentModule = undefined;
        }
      }
    }
  }

  return symbols;
}

import { scanImportRefs } from "./imports";

export interface ResolvedSymbol {
  symbol: CompactSymbol;
  /** Import specifier the declaration came from; null when declared locally. */
  spec: string | null;
  /** Import prefix it was reached through, when any. */
  prefix: string | null;
}

/**
 * Resolve an identifier to its declaration, following imports.
 *
 * Looks locally first, then through each `import "./x" [prefix P_]`. A prefixed
 * import makes the module's exported `foo` visible as `P_foo`; an unprefixed
 * import makes it visible under its own name. `readImport` maps a specifier to
 * that file's source, or null when it cannot be read.
 */
export function resolveSymbolAt(
  text: string,
  word: string,
  readImport: (spec: string) => string | null,
  /** Prefer the declaration at or above this 0-based line, for shadowing. */
  nearLine?: number,
): ResolvedSymbol | null {
  const local = extractSymbols(text).filter((s) => s.name === word);
  if (local.length > 0) {
    const chosen =
      (nearLine === undefined
        ? undefined
        : [...local].reverse().find((s) => s.line <= nearLine)) ?? local[0];
    return { symbol: chosen, spec: null, prefix: null };
  }

  for (const imp of extractPrefixedImports(text)) {
    let bare: string;
    if (imp.prefix) {
      if (!word.startsWith(imp.prefix)) continue;
      bare = word.slice(imp.prefix.length);
    } else {
      bare = word;
    }
    const importedText = readImport(imp.spec);
    if (importedText === null) continue;
    const found = extractSymbols(importedText).find((s) => s.name === bare && s.exported);
    if (found) return { symbol: found, spec: imp.spec, prefix: imp.prefix };
  }
  return null;
}

/**
 * Parse the parameter list out of a circuit/witness declaration line.
 * Splits on top-level commas so generic types like `Map<A, B>` survive.
 */
export function extractParameters(declLine: string): CompactSymbol[] {
  const open = declLine.indexOf("(");
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < declLine.length; i++) {
    const ch = declLine[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];

  const inner = declLine.slice(open + 1, close);
  const params: CompactSymbol[] = [];
  let angle = 0;
  let paren = 0;
  let current = "";
  const flush = (): void => {
    const part = current.trim();
    current = "";
    if (!part) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(part);
    if (!m) return;
    params.push({
      name: m[1],
      kind: "parameter",
      exported: false,
      line: 0,
      detail: `${m[1]}: ${m[2].trim()}`,
      type: m[2].trim(),
    });
  };
  for (const ch of inner) {
    if (ch === "<") angle++;
    else if (ch === ">") angle--;
    else if (ch === "(" || ch === "[") paren++;
    else if (ch === ")" || ch === "]") paren--;
    if (ch === "," && angle === 0 && paren === 0) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return params;
}

/**
 * Parse import statements: specifier plus optional prefix.
 *
 * Covers BOTH forms, because both can name workspace files:
 *   import "./modules/Utils" prefix Utils_;   -> kind "file"
 *   import CustomStructs prefix CustomStructs_;  -> kind "module"
 * Compiler built-ins (CompactStandardLibrary) are excluded — they have no file.
 */
export function extractPrefixedImports(
  text: string,
): Array<{ spec: string; prefix: string | null; kind: "file" | "module" }> {
  return scanImportRefs(text)
    .filter((ref) => !ref.builtin)
    .map((ref) => ({ spec: ref.spec, prefix: ref.prefix, kind: ref.kind }));
}
