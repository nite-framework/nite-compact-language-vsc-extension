/**
 * Integration test for the server pipeline, run against the REAL compact CLI.
 * No VSCode needed: exercises shadow sync, import graph, compile, and the
 * diagnostics parser end-to-end.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import * as url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const out = (p) => path.join(here, "..", "out", "server", p);

const { ShadowWorkspace } = await import(url.pathToFileURL(out("shadow.js")));
const { buildImportGraph, findCompileRoots, reachableFiles } = await import(url.pathToFileURL(out("imports.js")));
const { CompileHandle, probeCompactCli } = await import(url.pathToFileURL(out("compiler.js")));
const { parseCompilerOutput, underlineEnd, explainDiagnostic } = await import(url.pathToFileURL(out("diagnostics.js")));
const { extractSymbols, extractPrefixedImports } = await import(url.pathToFileURL(out("symbols.js")));

import * as fs from "node:fs";

const fixtures = path.join(here, "fixtures");
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
};

console.log("1. diagnostics parser (canned output)");
{
  const canned = 'Exception: bad.compact line 8 char 5:\n  unbound identifier undefinedFunction\n';
  const parsed = parseCompilerOutput(canned);
  check("parses located exception", () => {
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].file, "bad.compact");
    assert.equal(parsed[0].line, 8);
    assert.equal(parsed[0].char, 5);
    assert.match(parsed[0].message, /unbound identifier/);
  });
  const legacy = 'Exception: a.compact line 3, char 20:\n  parse error: found ":"\n';
  check("parses legacy comma format", () => {
    const p = parseCompilerOutput(legacy);
    assert.equal(p[0].line, 3);
    assert.equal(p[0].char, 20);
  });
  check("underline extends over identifier", () => {
    const end = underlineEnd("    undefinedFunction(amount);", 5);
    assert.equal(end, 5 + "undefinedFunction".length);
  });

  // Multi-line messages keep their structure instead of being flattened.
  const argMismatch =
    "Exception: argmis.compact line 8 char 5:\n" +
    "  no compatible function named undefinedFunction is in scope at this call\n" +
    "    one function is incompatible with the supplied argument types\n" +
    "      supplied argument types:\n" +
    "        (Uint<64>)\n" +
    "      declared argument types for function at line 11 char 1:\n" +
    "        ()\n";
  check("multi-line message preserves line structure", () => {
    const [raw] = parseCompilerOutput(argMismatch);
    assert.ok(raw.message.includes("\n"), "expected newlines to be preserved");
    assert.match(raw.message, /^no compatible function/);
  });
}

console.log("1b. explainDiagnostic (humanized messages)");
{
  const explain = (canned) => explainDiagnostic(parseCompilerOutput(canned)[0]);

  check("unbound identifier is humanized", () => {
    const ex = explain("Exception: bad.compact line 8 char 5:\n  unbound identifier undefinedFunction\n");
    assert.match(ex.message, /'undefinedFunction' is not defined/);
    assert.match(ex.message, /How to fix/);
  });

  check("argument mismatch is humanized with related location", () => {
    const ex = explain(
      "Exception: argmis.compact line 8 char 5:\n" +
        "  no compatible function named undefinedFunction is in scope at this call\n" +
        "    one function is incompatible with the supplied argument types\n" +
        "      supplied argument types:\n" +
        "        (Uint<64>)\n" +
        "      declared argument types for function at line 11 char 1:\n" +
        "        ()\n",
    );
    assert.match(ex.message, /Cannot call 'undefinedFunction'/);
    assert.match(ex.message, /This call passes: \(Uint<64>\) — 1 argument/);
    assert.match(ex.message, /declared on line 11.*expects: \(\) — no arguments/);
    assert.match(ex.message, /How to fix: this call passes 1 argument, but the declaration takes no arguments/);
    assert.equal(ex.related.length, 1);
    assert.equal(ex.related[0].line, 11);
    assert.equal(ex.related[0].char, 1);
  });

  check("witness disclosure is humanized with related locations", () => {
    const ex = explain(
      "Exception: t1.compact line 5 char 11:\n" +
        "  potential witness-value disclosure must be declared but is not:\n" +
        "    witness value potentially disclosed:\n" +
        "      the value of parameter amount of exported circuit inc at line 4 char 20\n" +
        "    nature of the disclosure:\n" +
        "      ledger operation might disclose the witness value\n" +
        "    via this path through the program:\n" +
        "      the right-hand side of = at line 5 char 11\n",
    );
    assert.match(ex.message, /Private data would become publicly visible/);
    assert.match(ex.message, /What leaks: the value of parameter amount .* \(line 4\)/);
    assert.match(ex.message, /disclose\(/);
    assert.equal(ex.related.length, 2);
    assert.equal(ex.related[0].line, 4);
  });

  check("assignment type mismatch is humanized", () => {
    const ex = explain(
      "Exception: t2.compact line 5 char 10:\n" +
        "  expected right-hand side of = to have type Boolean but received Uint<0..6>\n",
    );
    assert.match(ex.message, /Type mismatch: right-hand side of = must be 'Boolean'/);
    assert.match(ex.message, /compiler-inferred range/);
  });

  check("declared-type mismatch is humanized with cast hint", () => {
    const ex = explain(
      "Exception: t3.compact line 4 char 11:\n" +
        "  mismatch between actual type Uint<0..257> and declared type Uint<8> of const binding\n",
    );
    assert.match(ex.message, /declared as 'Uint<8>', but its value has type 'Uint<0\.\.257>'/);
    assert.match(ex.message, /as Uint<8>/);
  });

  check("parse error is humanized", () => {
    const ex = explain(
      'Exception: syntax.compact line 3 char 20:\n  parse error: found ":" looking for a typed pattern or ")"\n',
    );
    assert.match(ex.message, /Syntax error: found ":" where a typed pattern or "\)" was expected/);
  });

  check("unknown message falls back to structured compiler wording", () => {
    const ex = explain("Exception: x.compact line 1 char 1:\n  something entirely novel\n    with detail\n");
    assert.equal(ex.message, "something entirely novel\n  with detail");
    assert.equal(ex.related.length, 0);
  });
}

console.log("2. symbols + imports");
{
  const goodText = fs.readFileSync(path.join(fixtures, "good.compact"), "utf8");
  const mathText = fs.readFileSync(path.join(fixtures, "modules", "Math.compact"), "utf8");
  check("extracts ledger + circuit", () => {
    const syms = extractSymbols(goodText);
    assert.ok(syms.some((s) => s.name === "count" && s.kind === "ledger"));
    assert.ok(syms.some((s) => s.name === "increment" && s.kind === "circuit"));
  });
  check("extracts module + pure circuit with container", () => {
    const syms = extractSymbols(mathText);
    assert.ok(syms.some((s) => s.name === "Math" && s.kind === "module"));
    const add = syms.find((s) => s.name === "addCapped");
    assert.equal(add?.kind, "pure-circuit");
    assert.equal(add?.container, "Math");
  });
  check("prefixed import parsed", () => {
    const imps = extractPrefixedImports(goodText);
    assert.deepEqual(imps, [{ spec: "./modules/Math", prefix: "Math_" }]);
  });
}

console.log("3. import graph roots");
{
  const good = path.join(fixtures, "good.compact");
  const math = path.join(fixtures, "modules", "Math.compact");
  const files = new Map([
    [good, fs.readFileSync(good, "utf8")],
    [math, fs.readFileSync(math, "utf8")],
    [path.join(fixtures, "bad.compact"), fs.readFileSync(path.join(fixtures, "bad.compact"), "utf8")],
  ]);
  const graph = buildImportGraph(files);
  check("editing a module compiles its root", () => {
    assert.deepEqual(findCompileRoots(graph, math, 4), [good]);
  });
  check("editing a root compiles itself", () => {
    assert.deepEqual(findCompileRoots(graph, good, 4), [good]);
  });
  check("reachable set includes module", () => {
    assert.ok(reachableFiles(graph, good).has(math));
  });
}

console.log("4. end-to-end with real compiler");
{
  const version = await probeCompactCli("compact");
  if (!version) {
    console.log("  skip: compact CLI not found on PATH");
  } else {
    console.log(`  using ${version}`);
    const shadow = new ShadowWorkspace(fixtures);
    const overlays = new Map();
    shadow.sync(overlays);

    // good.compact (with module import) must compile cleanly
    {
      const handle = new CompileHandle();
      const entry = path.join(fixtures, "good.compact");
      const result = await handle.run(shadow.toShadowPath(entry), shadow.outputDirFor(entry), {
        compactPath: "compact",
        toolchainVersion: "",
        cwd: shadow.root,
      });
      check("clean multi-file contract produces no diagnostics", () => {
        const diags = parseCompilerOutput(result.output);
        assert.equal(diags.length, 0, `unexpected: ${result.output}`);
      });
    }

    // bad.compact must yield a located diagnostic at line 8 char 5
    {
      const handle = new CompileHandle();
      const entry = path.join(fixtures, "bad.compact");
      const result = await handle.run(shadow.toShadowPath(entry), shadow.outputDirFor(entry), {
        compactPath: "compact",
        toolchainVersion: "",
        cwd: shadow.root,
      });
      check("broken contract produces located diagnostic", () => {
        const diags = parseCompilerOutput(result.output);
        assert.equal(diags.length, 1, `raw output: ${result.output}`);
        assert.equal(diags[0].line, 8);
        assert.equal(diags[0].char, 5);
        assert.match(diags[0].message, /unbound identifier undefinedFunction/);
      });
    }

    // overlay: fix bad.compact in-memory only; diagnostics must clear
    {
      const fixed = fs
        .readFileSync(path.join(fixtures, "bad.compact"), "utf8")
        .replace("undefinedFunction(amount);", "");
      overlays.set(path.join(fixtures, "bad.compact"), fixed);
      shadow.sync(overlays);
      const handle = new CompileHandle();
      const entry = path.join(fixtures, "bad.compact");
      const result = await handle.run(shadow.toShadowPath(entry), shadow.outputDirFor(entry), {
        compactPath: "compact",
        toolchainVersion: "",
        cwd: shadow.root,
      });
      check("unsaved in-memory fix clears diagnostics (overlay works)", () => {
        const diags = parseCompilerOutput(result.output);
        assert.equal(diags.length, 0, `raw output: ${result.output}`);
      });
      // restore shadow state for future runs
      overlays.delete(path.join(fixtures, "bad.compact"));
      shadow.sync(overlays);
    }

    // cancellation: killing mid-compile resolves without hanging
    {
      const handle = new CompileHandle();
      const entry = path.join(fixtures, "good.compact");
      const promise = handle.run(shadow.toShadowPath(entry), shadow.outputDirFor(entry), {
        compactPath: "compact",
        toolchainVersion: "",
        cwd: shadow.root,
      });
      setTimeout(() => handle.cancel(), 30);
      const result = await promise;
      check("cancellation resolves promptly", () => {
        assert.equal(result.cancelled, true);
      });
    }
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
