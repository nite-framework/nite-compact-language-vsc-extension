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
  | "constructor";

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
}

interface Matcher {
  re: RegExp;
  kind: (m: RegExpMatchArray) => CompactSymbolKind;
  name: (m: RegExpMatchArray) => string;
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

      symbols.push({
        name,
        kind,
        exported: /\bexport\b/.test(noComment),
        line: i,
        detail,
        container: kind === "module" ? undefined : currentModule,
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

/** Parse `import "./x" prefix Foo_;` statements: specifier + optional prefix. */
export function extractPrefixedImports(text: string): Array<{ spec: string; prefix: string | null }> {
  const results: Array<{ spec: string; prefix: string | null }> = [];
  const re = /\bimport\s+"([^"]+)"(?:\s+prefix\s+([A-Za-z_][A-Za-z0-9_]*))?/g;
  for (const m of text.matchAll(re)) {
    results.push({ spec: m[1], prefix: m[2] ?? null });
  }
  return results;
}
