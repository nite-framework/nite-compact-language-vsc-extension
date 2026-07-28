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
const { buildImportGraph, findCompileRoots, reachableFiles, resolveImport, scanImportRefs } = await import(url.pathToFileURL(out("imports.js")));
const { CompileHandle, probeCompactCli } = await import(url.pathToFileURL(out("compiler.js")));
const { parseCompilerOutput, underlineEnd, explainDiagnostic } = await import(url.pathToFileURL(out("diagnostics.js")));
const { extractSymbols, extractPrefixedImports, resolveSymbolAt, docCommentAbove } = await import(url.pathToFileURL(out("symbols.js")));
const { hasLanguagePragma } = await import(url.pathToFileURL(out("pragma.js")));
const {
  LEDGER_ADTS: LEDGER_ADT_TABLE,
  findLedgerType,
  methodsForType,
  resolveAdt,
  specialize,
} = await import(url.pathToFileURL(out("ledger-adts.js")));

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
  check("prefixed imports parsed", () => {
    const imps = extractPrefixedImports(goodText);
    assert.deepEqual(imps, [
      { spec: "./modules/Math", prefix: "Math_" },
      { spec: "./modules/Store", prefix: "Store_" },
    ]);
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

    // bad.compact must yield a located diagnostic on the undefinedFunction call
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
        // position of the `undefinedFunction(amount);` call in fixtures/bad.compact
        assert.equal(diags[0].line, 9);
        assert.equal(diags[0].char, 3);
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

console.log("5. symbols: constants, parameters, ledger types");
{
  const src = [
    "export ledger balances: Map<Bytes<32>, Uint<64>>;",
    "export ledger tree: HistoricMerkleTree<32, Bytes<32>>;",
    "export circuit pay(to: Bytes<32>, amount: Uint<64>): [] {",
    "  const fee = amount / 100;",
    "  const RATE: Field = 5;",
    "}",
  ].join("\n");
  const syms = extractSymbols(src);
  const find = (n) => syms.find((s) => s.name === n);

  check("ledger field records its declared type", () => {
    assert.equal(find("balances")?.type, "Map<Bytes<32>, Uint<64>>");
    assert.equal(find("tree")?.type, "HistoricMerkleTree<32, Bytes<32>>");
  });
  check("circuit parameters are captured with types and scope", () => {
    const to = find("to");
    assert.equal(to?.kind, "parameter");
    assert.equal(to?.type, "Bytes<32>");
    assert.equal(to?.scope, "pay");
    assert.equal(find("amount")?.type, "Uint<64>");
  });
  check("unannotated const keeps its initializer and has NO invented type", () => {
    const fee = find("fee");
    assert.equal(fee?.kind, "const");
    assert.equal(fee?.init, "amount / 100");
    assert.equal(fee?.type, undefined, "must not infer a type");
  });
  check("annotated const records its declared type", () => {
    assert.equal(find("RATE")?.type, "Field");
  });
}

console.log("6. ledger ADT table");
{
  check("Map resolves with its type arguments", () => {
    const r = resolveAdt("Map<Bytes<32>, Uint<64>>");
    assert.equal(r.adt.name, "Map");
    assert.deepEqual(r.typeArgs, ["Bytes<32>", "Uint<64>"]);
  });
  check("signatures specialize to the declared type arguments", () => {
    const r = resolveAdt("Map<Bytes<32>, Uint<64>>");
    assert.equal(specialize("insert(key: K, value: V): []", r), "insert(key: Bytes<32>, value: Uint<64>): []");
  });
  check("Set exposes member, not contains", () => {
    const { methods } = methodsForType("Set<Bytes<32>>");
    assert.ok(methods.some((m) => m.name === "member"));
    assert.ok(!methods.some((m) => m.name === "contains"), "`contains` is not a real operation");
  });
  check("Cell is not a ledger ADT", () => {
    assert.equal(resolveAdt("Cell<Uint<64>>"), null);
  });
  check("plain typed field falls back to cell operations", () => {
    const { methods, resolved } = methodsForType("Uint<64>");
    assert.equal(resolved, null);
    assert.deepEqual(methods.map((m) => m.name).sort(), ["read", "reset_to_default", "resetToDefault", "write"].sort());
  });
  check("insertCoin only offered on coin-valued maps", () => {
    const plain = methodsForType("Map<Bytes<32>, Uint<64>>").methods;
    const coins = methodsForType("Map<Bytes<32>, QualifiedShieldedCoinInfo>").methods;
    assert.ok(!plain.some((m) => m.name === "insertCoin"));
    assert.ok(coins.some((m) => m.name === "insertCoin"));
  });
}

console.log("6b. ADT resolution against the fixtures");
{
  const goodSrc = fs.readFileSync(path.join(fixtures, "good.compact"), "utf8");
  const storeSrc = fs.readFileSync(path.join(fixtures, "modules", "Store.compact"), "utf8");
  // Mimics the server's reader: maps an import specifier to that file's source.
  const readImport = (spec) =>
    spec.endsWith("Store") ? storeSrc
      : spec.endsWith("Math") ? fs.readFileSync(path.join(fixtures, "modules", "Math.compact"), "utf8")
      : null;

  check("resolves a locally declared ADT field", () => {
    assert.equal(findLedgerType(goodSrc, "accounts", readImport), "Map<Bytes<32>, Account>");
    assert.equal(findLedgerType(goodSrc, "seen", readImport), "Set<Bytes<32>>");
  });
  check("resolves a plain cell field", () => {
    assert.equal(findLedgerType(goodSrc, "count", readImport), "Uint<64>");
  });
  check("resolves prefixed fields from an imported module", () => {
    assert.equal(findLedgerType(goodSrc, "Store_balances", readImport), "Map<Bytes<32>, Uint<64>>");
    assert.equal(findLedgerType(goodSrc, "Store_mintCounter", readImport), "Counter");
    assert.equal(findLedgerType(goodSrc, "Store_history", readImport), "HistoricMerkleTree<10, Bytes<32>>");
    assert.equal(findLedgerType(goodSrc, "Store_recentAmounts", readImport), "List<Uint<64>>");
  });
  check("unknown receiver resolves to null (no misleading suggestions)", () => {
    assert.equal(findLedgerType(goodSrc, "notAField", readImport), null);
    assert.equal(findLedgerType(goodSrc, "Store_nope", readImport), null);
  });
  check("imported Map field offers struct-free specialized signatures", () => {
    const type = findLedgerType(goodSrc, "Store_balances", readImport);
    const { methods, resolved } = methodsForType(type);
    const insert = methods.find((m) => m.name === "insert");
    assert.equal(specialize(insert.signature, resolved), "insert(key: Bytes<32>, value: Uint<64>): []");
  });
  check("local Map with struct value specializes lookup to the struct", () => {
    const type = findLedgerType(goodSrc, "accounts", readImport);
    const { methods, resolved } = methodsForType(type);
    const lookup = methods.find((m) => m.name === "lookup");
    assert.equal(specialize(lookup.signature, resolved), "lookup(key: Bytes<32>): Account");
  });
  check("fixture constants cover both annotated and unannotated forms", () => {
    const syms = extractSymbols(goodSrc);
    const key = syms.find((s) => s.name === "key" && s.kind === "const");
    const bal = syms.find((s) => s.name === "startingBalance" && s.kind === "const");
    assert.equal(key.type, undefined, "unannotated const must not gain a type");
    assert.equal(key.init, "disclose(owner)");
    assert.equal(bal.type, "Uint<64>");
    assert.equal(key.scope, "register");
  });
  check("fixture parameters are typed and scoped", () => {
    const syms = extractSymbols(goodSrc);
    const owner = syms.filter((s) => s.name === "owner" && s.kind === "parameter");
    assert.ok(owner.length >= 1);
    assert.equal(owner[0].type, "Bytes<32>");
  });
}

console.log("6c. resolving declarations across prefixed imports");
{
  const goodSrc = fs.readFileSync(path.join(fixtures, "good.compact"), "utf8");
  const mathSrc = fs.readFileSync(path.join(fixtures, "modules", "Math.compact"), "utf8");
  const storeSrc = fs.readFileSync(path.join(fixtures, "modules", "Store.compact"), "utf8");
  const readImport = (spec) =>
    spec.endsWith("Store") ? storeSrc : spec.endsWith("Math") ? mathSrc : null;

  check("prefixed circuit resolves to its declaration in the module file", () => {
    const r = resolveSymbolAt(goodSrc, "Math_addCapped", readImport);
    assert.ok(r, "Math_addCapped should resolve");
    assert.equal(r.symbol.name, "addCapped");
    assert.equal(r.symbol.kind, "pure-circuit");
    assert.equal(r.spec, "./modules/Math");
    assert.equal(r.prefix, "Math_");
    assert.equal(r.symbol.container, "Math");
    assert.match(r.symbol.detail, /addCapped\(a: Uint<64>, b: Uint<64>\)/);
  });
  check("prefixed ledger field resolves with its declared type", () => {
    const r = resolveSymbolAt(goodSrc, "Store_balances", readImport);
    assert.equal(r.symbol.kind, "ledger");
    assert.equal(r.symbol.type, "Map<Bytes<32>, Uint<64>>");
    assert.equal(r.spec, "./modules/Store");
  });
  check("local declarations resolve without an import", () => {
    const r = resolveSymbolAt(goodSrc, "Account", readImport);
    assert.equal(r.spec, null);
    assert.equal(r.symbol.kind, "struct");
  });
  check("unknown identifiers resolve to null", () => {
    assert.equal(resolveSymbolAt(goodSrc, "Math_nope", readImport), null);
    assert.equal(resolveSymbolAt(goodSrc, "totallyUnknown", readImport), null);
  });
  check("non-exported module members are not resolved", () => {
    const src = 'import "./m" prefix M_;';
    const hidden = "module M {\n  circuit secret(): [] { }\n}\n";
    assert.equal(resolveSymbolAt(src, "M_secret", () => hidden), null);
  });
}

console.log("6d. compiler path reporting for errors inside modules");
{
  const version = await probeCompactCli("compact");
  if (!version) {
    console.log("  skip: compact CLI not found on PATH");
  } else {
    const os = await import("node:os");
    const scratch = path.join(os.tmpdir(), `nite-modpath-${process.pid}`);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(path.join(scratch, "modules"), { recursive: true });
    fs.mkdirSync(path.join(scratch, "out"), { recursive: true });
    for (const rel of ["good.compact", "modules/Math.compact", "modules/Store.compact"]) {
      fs.copyFileSync(path.join(fixtures, rel), path.join(scratch, rel));
    }
    // Break the module: drop a trailing semicolon.
    const storePath = path.join(scratch, "modules", "Store.compact");
    fs.writeFileSync(
      storePath,
      fs.readFileSync(storePath, "utf8").replace(
        "export ledger admins: Set<Bytes<32>>;",
        "export ledger admins: Set<Bytes<32>>",
      ),
    );

    const handle = new CompileHandle();
    const result = await handle.run(path.join(scratch, "good.compact"), path.join(scratch, "out"), {
      compactPath: "compact",
      toolchainVersion: "",
      cwd: scratch,
    });
    const diags = parseCompilerOutput(result.output);

    check("a syntax error inside an imported module is reported", () => {
      assert.equal(diags.length, 1, `raw output: ${result.output}`);
      assert.match(diags[0].message, /parse error/);
    });
    // This is the assumption mapCompilerPathToReal has to cope with: the
    // compiler names the module by BASENAME only, with no directory. If a
    // future toolchain starts printing "modules/Store.compact", this test
    // fails and the basename fallback can be revisited.
    check("compiler names the module by bare basename (no directory)", () => {
      assert.equal(diags[0].file, "Store.compact");
      assert.ok(!diags[0].file.includes("/"), "expected no directory component");
    });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log("6f. doc comments attached to declarations");
{
  const src = [
    "/** A single-line block doc. */",
    "export ledger count: Uint<64>;",
    "",
    "/**",
    " * Multi-line doc.",
    " * Second line.",
    " */",
    "export struct Account {",
    "    owner: Bytes<32>;",
    "}",
    "",
    "// line doc part one",
    "// line doc part two",
    "export circuit pay(to: Bytes<32>): [] {",
    "    /** documents the constant */",
    "    const fee = 1;",
    "}",
    "",
    "/** Detached: separated by a blank line, so it is NOT this symbol's doc. */",
    "",
    "export ledger orphan: Uint<64>;",
  ].join("\n");
  const syms = extractSymbols(src);
  const find = (n) => syms.find((s) => s.name === n);

  check("single-line block doc is attached", () => {
    assert.equal(find("count").doc, "A single-line block doc.");
  });
  check("multi-line block doc strips leading asterisks", () => {
    assert.equal(find("Account").doc, "Multi-line doc.\nSecond line.");
  });
  check("consecutive line comments are joined", () => {
    assert.equal(find("pay").doc, "line doc part one\nline doc part two");
  });
  check("constants pick up their doc comment", () => {
    assert.equal(find("fee").doc, "documents the constant");
  });
  check("a blank line detaches the comment from the declaration", () => {
    assert.equal(find("orphan").doc, undefined);
  });
  check("declarations without a comment have no doc", () => {
    assert.equal(docCommentAbove(["export ledger x: Uint<64>;"], 0), undefined);
  });

  check("fixture doc comments are picked up across files", () => {
    const goodSrc = fs.readFileSync(path.join(fixtures, "good.compact"), "utf8");
    const storeSrc = fs.readFileSync(path.join(fixtures, "modules", "Store.compact"), "utf8");
    assert.match(extractSymbols(goodSrc).find((s) => s.name === "Account").doc, /Struct used as a Map value/);
    assert.match(extractSymbols(storeSrc).find((s) => s.name === "balances").doc, /Map ADT/);
  });
  check("imported symbol carries its doc through resolution", () => {
    const goodSrc = fs.readFileSync(path.join(fixtures, "good.compact"), "utf8");
    const storeSrc = fs.readFileSync(path.join(fixtures, "modules", "Store.compact"), "utf8");
    const r = resolveSymbolAt(goodSrc, "Store_mintCounter", (spec) =>
      spec.endsWith("Store") ? storeSrc : null,
    );
    assert.match(r.symbol.doc, /Counter ADT/);
  });
}

console.log("6g. import statements locate their target files");
{
  const goodSrc = fs.readFileSync(path.join(fixtures, "good.compact"), "utf8");
  const refs = scanImportRefs(goodSrc);

  check("finds every file-referencing import", () => {
    assert.deepEqual(refs.map((r) => r.spec), ["./modules/Math", "./modules/Store"]);
  });
  check("range covers exactly the path, excluding the quotes", () => {
    const lines = goodSrc.split(/\r?\n/);
    for (const ref of refs) {
      const slice = lines[ref.line].slice(ref.startChar, ref.endChar);
      assert.equal(slice, ref.spec, "range must select the specifier text");
      assert.equal(lines[ref.line][ref.startChar - 1], '"', "char before range is the opening quote");
      assert.equal(lines[ref.line][ref.endChar], '"', "char after range is the closing quote");
    }
  });
  check("specifiers resolve to files that exist", () => {
    for (const ref of refs) {
      const target = resolveImport(path.join(fixtures, "good.compact"), ref.spec);
      assert.ok(fs.existsSync(target), `${ref.spec} -> ${target} should exist`);
    }
  });
  check("bare library imports are not treated as file links", () => {
    assert.deepEqual(scanImportRefs("import CompactStandardLibrary;\n"), []);
  });
  check("include statements are linked too", () => {
    const r = scanImportRefs('include "./other";');
    assert.equal(r.length, 1);
    assert.equal(r[0].spec, "./other");
  });
}

console.log("6e. missing language pragma");
{
  check("detects a declared pragma", () => {
    assert.equal(hasLanguagePragma("pragma language_version 0.23.0;\nimport X;"), true);
    assert.equal(hasLanguagePragma("  pragma language_version 0.23;"), true);
  });
  check("detects an absent pragma", () => {
    assert.equal(hasLanguagePragma("import CompactStandardLibrary;\n"), false);
    assert.equal(hasLanguagePragma("// pragma language_version is mentioned in a comment"), false);
  });
  check("fixture modules legitimately omit the pragma", () => {
    const store = fs.readFileSync(path.join(fixtures, "modules", "Store.compact"), "utf8");
    const good = fs.readFileSync(path.join(fixtures, "good.compact"), "utf8");
    assert.equal(hasLanguagePragma(store), false, "modules do not carry a pragma");
    assert.equal(hasLanguagePragma(good), true, "entry contracts do");
  });

  const version = await probeCompactCli("compact");
  if (version) {
    const os = await import("node:os");
    const dir = path.join(os.tmpdir(), `nite-pragma-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "out"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "p.compact"),
      "import CompactStandardLibrary;\n\nexport ledger count: Uint<64>;\n\nexport circuit bump(n: Uint<64>): [] {\n  count = (count + disclose(n)) as Uint<64>;\n}\n",
    );
    const handle = new CompileHandle();
    const result = await handle.run(path.join(dir, "p.compact"), path.join(dir, "out"), {
      compactPath: "compact",
      toolchainVersion: "",
      cwd: dir,
    });
    // Documents WHY this is a warning and not an error: the compiler is happy.
    check("compiler itself accepts a missing pragma (so this is a lint, not an error)", () => {
      assert.deepEqual(parseCompilerOutput(result.output), [], `raw output: ${result.output}`);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("7. ADT table vs the real compiler (anti-hallucination guard)");
{
  const version = await probeCompactCli("compact");
  if (!version) {
    console.log("  skip: compact CLI not found on PATH");
  } else {
    const { execFile } = await import("node:child_process");
    const os = await import("node:os");
    const DECLS = {
      Counter: "Counter",
      Set: "Set<Bytes<32>>",
      Map: "Map<Bytes<32>, Uint<64>>",
      List: "List<Uint<64>>",
      MerkleTree: "MerkleTree<10, Bytes<32>>",
      HistoricMerkleTree: "HistoricMerkleTree<10, Bytes<32>>",
    };
    const root = path.join(os.tmpdir(), `nite-adt-verify-${process.pid}`);
    fs.rmSync(root, { recursive: true, force: true });

    const compileCall = (adtType, method, tag) =>
      new Promise((resolve) => {
        const dir = path.join(root, tag);
        fs.mkdirSync(path.join(dir, "out"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, "p.compact"),
          `pragma language_version 0.23;\nimport CompactStandardLibrary;\n\nexport ledger f: ${adtType};\n\nexport circuit t(): [] {\n  f.${method}();\n}\n`,
        );
        execFile("compact", ["compile", "--skip-zk", "p.compact", "out"],
          { cwd: dir, timeout: 120_000, maxBuffer: 8 << 20 },
          (e, so, se) => resolve(`${so || ""}${se || ""}`));
      });

    // Every documented operation must exist on its ADT. Deprecated aliases are
    // expected to be rejected by name, so they are checked in the opposite
    // direction. Arguments are omitted deliberately: an arity complaint still
    // proves the operation exists.
    const jobs = [];
    for (const [adtName, adtType] of Object.entries(DECLS)) {
      for (const m of LEDGER_ADT_TABLE[adtName].methods) {
        // Coin-only operations exist only when the value type is a coin type,
        // so they must be probed against a coin-valued map.
        const decl = m.requiresCoinValue ? "Map<Bytes<32>, QualifiedShieldedCoinInfo>" : adtType;
        jobs.push({ adtName, adtType: decl, method: m });
      }
    }

    const undefinedOp = (out, name) =>
      new RegExp(`operation ${name} undefined for ledger field type`).test(out);

    let i = 0;
    const outcomes = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (i < jobs.length) {
          const k = i++;
          const j = jobs[k];
          const out = await compileCall(j.adtType, j.method.name, `${j.adtName}__${j.method.name}`);
          outcomes[k] = { ...j, out };
        }
      }),
    );

    for (const o of outcomes) {
      const missing = undefinedOp(o.out, o.method.name);
      if (o.method.deprecated) {
        check(`${o.adtName}.${o.method.name} is rejected as a legacy name`, () => {
          assert.match(o.out, /old standard-library|undefined for ledger field type/,
            `expected the compiler to reject '${o.method.name}'`);
        });
      } else {
        check(`${o.adtName}.${o.method.name} exists`, () => {
          assert.ok(!missing, `compiler says it does not exist:\n${o.out}`);
        });
      }
      if (o.method.runtimeOnly) {
        check(`${o.adtName}.${o.method.name} is runtime-only`, () => {
          assert.match(o.out, /runtime-only method/);
        });
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
