/**
 * Parser for `compactc` error output.
 *
 * Observed formats (compact toolchain 0.5.x, compilers 0.31.x):
 *
 *   Exception: bad.compact line 8 char 5:
 *     unbound identifier undefinedFunction
 *
 *   Exception: syntax.compact line 3 char 20:
 *     parse error: found ":" looking for a typed pattern or ")"
 *
 * Older compilers used `line N, char M:` (with a comma); both are accepted.
 * Internal errors and toolchain failures carry no location and are attached
 * to the entry file at 0:0.
 */

export interface RawDiagnostic {
  /** File path exactly as printed by the compiler (may be relative to cwd). */
  file: string | null;
  /** 1-based line, as printed. */
  line: number;
  /** 1-based column, as printed. */
  char: number;
  message: string;
}

const LOCATED_RE =
  /^Exception(?:\s+in\s+[^\n:]*)?:\s+(.+?)\s+line\s+(\d+),?\s+char\s+(\d+):[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/gm;

const BARE_EXCEPTION_RE = /^Exception(?:\s+in\s+[^\n:]*)?:?\s*(.*)$/m;

export function parseCompilerOutput(output: string): RawDiagnostic[] {
  const diagnostics: RawDiagnostic[] = [];

  for (const m of output.matchAll(LOCATED_RE)) {
    // Preserve the compiler's line structure (dedented to the outermost
    // level) — the hierarchy carries meaning in multi-line explanations.
    const rawLines = m[4].split(/\r?\n/).filter((l) => l.trim().length > 0);
    const indent = Math.min(...rawLines.map((l) => /^[ \t]*/.exec(l)![0].length));
    const message = rawLines.map((l) => l.slice(indent).trimEnd()).join("\n");
    diagnostics.push({
      file: m[1],
      line: Number(m[2]),
      char: Number(m[3]),
      message,
    });
  }

  if (diagnostics.length === 0) {
    const bare = BARE_EXCEPTION_RE.exec(output);
    if (bare) {
      // No location: attach to entry file start. Include following indented
      // lines if present for context.
      const start = bare.index + bare[0].length;
      const continuation = output
        .slice(start)
        .split(/\r?\n/)
        .filter((l) => /^[ \t]+\S/.test(l))
        .map((l) => l.trim())
        .join(" ");
      const message = [bare[1].trim(), continuation].filter(Boolean).join(" ") || "compilation failed";
      diagnostics.push({ file: null, line: 1, char: 1, message });
    }
  }

  return diagnostics;
}

/** True when output indicates the compact CLI/toolchain itself is unusable. */
export function isToolchainFailure(output: string): boolean {
  return (
    /command not found|No such file or directory|No default compiler|not installed|error: unrecognized/i.test(output) &&
    !LOCATED_RE.test(output)
  );
}

// ---------------------------------------------------------------------------
// Humanizing: rewrite known compiler messages into plain, actionable English.
// ---------------------------------------------------------------------------

/** A secondary location referenced by a diagnostic (same file). */
export interface RelatedLocation {
  /** 1-based line, as printed by the compiler. */
  line: number;
  /** 1-based column, as printed by the compiler. */
  char: number;
  message: string;
}

export interface ExplainedDiagnostic {
  message: string;
  related: RelatedLocation[];
}

/** Count top-level entries in a printed argument tuple like `(Uint<64>, Boolean)`. */
function tupleArity(tuple: string): number {
  const inner = tuple.trim().replace(/^\(/, "").replace(/\)$/, "").trim();
  if (inner.length === 0) return 0;
  let depth = 0;
  let count = 1;
  for (const ch of inner) {
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "]") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

function describeArity(tuple: string): string {
  const n = tupleArity(tuple);
  if (n === 0) return "no arguments";
  return n === 1 ? "1 argument" : `${n} arguments`;
}

/** Explain compiler-inferred ranges like `Uint<0..257>`. */
function rangeNote(type: string): string | null {
  const r = /^Uint<(\d+)\.\.(\d+)>$/.exec(type.trim());
  if (!r) return null;
  return (
    `Note: '${type.trim()}' is the compiler-inferred range — a whole number the compiler ` +
    `knows is between ${r[1]} and ${r[2]}. Arithmetic widens this range (e.g. adding 1 raises the maximum).`
  );
}

/** Replace trailing " at line L char C" with a compact "(line L)". */
function inlineLocation(text: string): string {
  return text.replace(/\s+at line (\d+) char \d+/g, " (line $1)");
}

/** Collect every "at line L char C" reference in a block of lines. */
function locationRefs(lines: string[]): RelatedLocation[] {
  const refs: RelatedLocation[] = [];
  for (const line of lines) {
    for (const m of line.matchAll(/at line (\d+) char (\d+)/g)) {
      refs.push({ line: Number(m[1]), char: Number(m[2]), message: inlineLocation(line) });
    }
  }
  return refs;
}

/**
 * Rewrite a raw compiler diagnostic into an explicit, plain-English message
 * with a "How to fix" hint and clickable related locations. Messages the
 * rewriter does not recognize keep the compiler's (structured) wording.
 */
export function explainDiagnostic(raw: RawDiagnostic): ExplainedDiagnostic {
  const lines = raw.message.split("\n").map((l) => l.trim());
  const first = lines[0] ?? "";

  // --- unbound identifier X -------------------------------------------------
  let m = /^unbound identifier\s+(.+)$/.exec(first);
  if (m) {
    const name = m[1];
    return {
      message:
        `'${name}' is not defined — nothing with this name exists in scope here.\n` +
        `How to fix:\n` +
        `  • Check the spelling (names are case-sensitive).\n` +
        `  • If it is declared in another file, import that file (e.g. import "./MyModule";).\n` +
        `  • If it is a standard-library function, make sure the file has: import CompactStandardLibrary;`,
      related: [],
    };
  }

  // --- no compatible function named X --------------------------------------
  m = /^no compatible function named\s+(\S+)\s+is in scope at this call$/.exec(first);
  if (m) {
    const name = m[1];
    let supplied: string | null = null;
    const declared: { line: number; char: number; sig: string }[] = [];
    for (let i = 1; i < lines.length - 1; i++) {
      if (/^supplied argument types:$/.test(lines[i])) {
        supplied = lines[i + 1];
      }
      const d = /^declared argument types for function at line (\d+) char (\d+):$/.exec(lines[i]);
      if (d) {
        declared.push({ line: Number(d[1]), char: Number(d[2]), sig: lines[i + 1] });
      }
    }

    const parts = [`Cannot call '${name}' with these arguments — no matching declaration accepts them.`];
    if (supplied) parts.push(`  This call passes: ${supplied} — ${describeArity(supplied)}.`);
    const related: RelatedLocation[] = [];
    for (const d of declared) {
      parts.push(`  '${name}' (declared on line ${d.line}) expects: ${d.sig} — ${describeArity(d.sig)}.`);
      related.push({ line: d.line, char: d.char, message: `'${name}' is declared here and expects ${d.sig}` });
    }
    if (supplied && declared.length === 1) {
      const got = tupleArity(supplied);
      const want = tupleArity(declared[0].sig);
      if (got !== want) {
        parts.push(
          `How to fix: this call passes ${describeArity(supplied)}, but the declaration takes ` +
            `${describeArity(declared[0].sig)}. Adjust the call to match, or change the declaration on line ${declared[0].line}.`,
        );
      } else {
        parts.push(
          `How to fix: the argument count matches, but the types do not. Convert the arguments ` +
            `to the expected types (e.g. with 'as'), or change the declaration on line ${declared[0].line}.`,
        );
      }
    } else {
      parts.push(`How to fix: adjust the call so the argument types match one of the declarations of '${name}'.`);
    }
    return { message: parts.join("\n"), related };
  }

  // --- potential witness-value disclosure ----------------------------------
  if (/^potential witness-value disclosure must be declared/.test(first)) {
    const sections: Record<string, string[]> = {};
    let current: string | null = null;
    for (const line of lines.slice(1)) {
      if (/^witness value potentially disclosed:$/.test(line)) current = "what";
      else if (/^nature of the disclosure:$/.test(line)) current = "how";
      else if (/^via this path through the program:$/.test(line)) current = "where";
      else if (current) (sections[current] ??= []).push(line);
    }
    const parts = [`Private data would become publicly visible here without an explicit disclose(...).`];
    for (const what of sections.what ?? []) parts.push(`  What leaks: ${inlineLocation(what)}.`);
    for (const how of sections.how ?? []) parts.push(`  How it leaks: ${how}.`);
    for (const where of sections.where ?? []) parts.push(`  Where: ${inlineLocation(where)}.`);
    parts.push(
      `How to fix: if making this value public is intended, wrap it in disclose(...) — e.g. disclose(value). ` +
        `Otherwise, avoid writing it (or anything computed from it) to ledger/public state.`,
    );
    return {
      message: parts.join("\n"),
      related: locationRefs([...(sections.what ?? []), ...(sections.where ?? [])]),
    };
  }

  // --- expected <ctx> to have type T but received U -------------------------
  m = /^expected (.+) to have type (.+) but received (.+)$/.exec(first);
  if (m) {
    const [, context, want, got] = m;
    const parts = [`Type mismatch: ${context} must be '${want}', but this expression has type '${got}'.`];
    const note = rangeNote(got) ?? rangeNote(want);
    if (note) parts.push(note);
    let fix = `How to fix: change the expression to produce '${want}', or change the declared type to '${got}'.`;
    if (/^Uint</.test(want.trim()) && /^Uint</.test(got.trim())) {
      fix += ` If truncation/wraparound is acceptable, cast it: (expression) as ${want.trim()}.`;
    }
    parts.push(fix);
    return { message: parts.join("\n"), related: [] };
  }

  // --- mismatch between actual type T and declared type U of <binding> -----
  m = /^mismatch between actual type (.+?) and declared type (.+?) of (.+)$/.exec(first);
  if (m) {
    const [, actual, declaredType, binding] = m;
    const parts = [
      `Type mismatch: this ${binding} is declared as '${declaredType}', but its value has type '${actual}'.`,
    ];
    const note = rangeNote(actual) ?? rangeNote(declaredType);
    if (note) parts.push(note);
    let fix = `How to fix: widen the declared type to fit the value, or make the value fit '${declaredType}'.`;
    if (/^Uint</.test(actual.trim()) && /^Uint</.test(declaredType.trim())) {
      fix += ` If truncation/wraparound is acceptable, cast it: (value) as ${declaredType.trim()}.`;
    }
    parts.push(fix);
    return { message: parts.join("\n"), related: [] };
  }

  // --- parse error ----------------------------------------------------------
  m = /^parse error:\s*(.+)$/.exec(lines.join(" "));
  if (m) {
    const detail = m[1];
    const f = /^found\s+(.+?)\s+looking for\s+(.+)$/.exec(detail);
    const message = f
      ? `Syntax error: found ${f[1]} where ${f[2]} was expected.\n` +
        `How to fix: look at (or just before) this position for a missing or extra token — ` +
        `often a ')', ';', ',' or a mistyped keyword.`
      : `Syntax error: ${detail}`;
    return { message, related: [] };
  }

  // Unrecognized: keep the compiler's structured wording.
  return { message: raw.message, related: [] };
}

/**
 * Compute the end column (1-based, exclusive) for a squiggle starting at
 * `char` on `lineText`, extending over an identifier when one is present.
 */
export function underlineEnd(lineText: string, char: number): number {
  const startIdx = char - 1;
  if (startIdx >= lineText.length) return char + 1;
  const rest = lineText.slice(startIdx);
  const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  if (ident) return char + ident[0].length;
  const token = /^[^\s]+/.exec(rest);
  if (token) return char + Math.min(token[0].length, 20);
  return char + 1;
}
