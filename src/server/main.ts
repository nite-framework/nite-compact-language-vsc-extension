import * as fs from "fs";
import * as path from "path";
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  DidChangeConfigurationNotification,
  DocumentSymbol,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  Range,
  CompletionItem,
  CompletionItemKind,
  CompletionItemTag,
  DocumentLink,
  Hover,
  Location,
  MarkupKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { CompileHandle, probeCompactCli } from "./compiler";
import { explainDiagnostic, isToolchainFailure, parseCompilerOutput, underlineEnd } from "./diagnostics";
import {
  buildImportGraph,
  findCompileRoots,
  reachableFiles,
  resolveImport,
  resolveModuleName,
  isInModulesDir,
  scanImportRefs,
  ImportRef,
} from "./imports";
import { ShadowWorkspace } from "./shadow";
import {
  extractPrefixedImports,
  extractSymbols,
  resolveSymbolAt,
  CompactSymbol,
  ResolvedSymbol,
} from "./symbols";
import { KEYWORDS, LEDGER_ADTS, PRIMITIVE_TYPES, STDLIB } from "./stdlib";
import { AdtMethod, findLedgerType, methodsForType, resolveAdt, specialize } from "./ledger-adts";
import { hasLanguagePragma, hasStandardLibraryImport, isModuleFile } from "./pragma";
import { spawnSync } from "child_process";
import * as os from "os";
import * as crypto from "crypto";

interface Settings {
  compactPath: string;
  toolchainVersion: string;
  compileMode: "onType" | "onSave";
  debounceMs: number;
  maxRootsPerCheck: number;
  warnMissingPragma: boolean;
  suggestModulesDir: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  compactPath: "compact",
  toolchainVersion: "",
  compileMode: "onType",
  debounceMs: 400,
  maxRootsPerCheck: 4,
  warnMissingPragma: true,
  suggestModulesDir: true,
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: Settings = { ...DEFAULT_SETTINGS };
let workspaceRoot: string | null = null;
let shadow: ShadowWorkspace | null = null;
let cliAvailable: boolean | null = null;
let hasConfigurationCapability = false;

const debounceTimers = new Map<string, NodeJS.Timeout>();
let activeCompile: CompileHandle | null = null;
let compileGeneration = 0;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
  const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  if (folder) {
    workspaceRoot = URI.parse(folder).fsPath;
    shadow = new ShadowWorkspace(workspaceRoot);
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // `{` opens a struct literal, where the fields are what you want next.
      completionProvider: { triggerCharacters: ["_", ".", "{"] },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      hoverProvider: true,
      definitionProvider: true,
      documentLinkProvider: { resolveProvider: false },
    },
  };
});

connection.onInitialized(async () => {
  if (hasConfigurationCapability) {
    await connection.client.register(DidChangeConfigurationNotification.type, undefined);
    await refreshSettings();
  }
  const version = await probeCompactCli(settings.compactPath);
  cliAvailable = version !== null;
  if (!cliAvailable) {
    connection.window.showWarningMessage(
      "Nite Compact: the `compact` CLI was not found. Live diagnostics are disabled. " +
        "Install it (see docs.midnight.network) or set `niteCompact.compactPath`.",
    );
  } else {
    connection.console.log(`Nite Compact: using ${version}`);
  }
});

async function refreshSettings(): Promise<void> {
  if (!hasConfigurationCapability) return;
  try {
    const cfg = (await connection.workspace.getConfiguration("niteCompact")) as Partial<Settings> | null;
    settings = { ...DEFAULT_SETTINGS, ...(cfg ?? {}) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

connection.onDidChangeConfiguration(async () => {
  await refreshSettings();
  const version = await probeCompactCli(settings.compactPath);
  cliAvailable = version !== null;
  for (const doc of documents.all()) scheduleCheck(doc, 0);
});

// ---------------------------------------------------------------------------
// Diagnostics pipeline
// ---------------------------------------------------------------------------

function realPathOf(doc: TextDocument): string {
  return URI.parse(doc.uri).fsPath;
}

function scheduleCheck(doc: TextDocument, delayMs: number): void {
  const key = doc.uri;
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      void runCheck(doc);
    }, delayMs),
  );
}

async function runCheck(doc: TextDocument): Promise<void> {
  if (!shadow || cliAvailable === false) return;

  const generation = ++compileGeneration;
  if (activeCompile) activeCompile.cancel();

  const changedReal = realPathOf(doc);

  // Overlay all open documents so unsaved edits across files are seen.
  const overlays = new Map<string, string>();
  for (const open of documents.all()) {
    if (open.uri.endsWith(".compact")) overlays.set(realPathOf(open), open.getText());
  }

  const mirrored = shadow.sync(overlays);

  // Build the import graph from mirrored content (overlay-aware).
  const fileTexts = new Map<string, string>();
  for (const file of mirrored) {
    const overlay = overlays.get(file);
    if (overlay !== undefined) {
      fileTexts.set(file, overlay);
    } else {
      try {
        fileTexts.set(file, fs.readFileSync(file, "utf8"));
      } catch {
        /* removed since listing */
      }
    }
  }
  const graph = buildImportGraph(fileTexts);
  const roots = findCompileRoots(graph, changedReal, settings.maxRootsPerCheck);

  // Files whose diagnostics this run owns (cleared unless re-reported).
  const owned = new Set<string>([changedReal]);
  for (const root of roots) {
    for (const file of reachableFiles(graph, root)) owned.add(file);
  }

  const collected = new Map<string, Diagnostic[]>();
  for (const file of owned) collected.set(file, []);

  // Every Compact source file, including a module, must explicitly import the
  // standard library. The compiler does not currently report its absence.
  for (const file of owned) {
    const source = fileTexts.get(file);
    if (source === undefined || hasStandardLibraryImport(source)) continue;
    const bucket = collected.get(file) ?? [];
    bucket.push({
      severity: DiagnosticSeverity.Error,
      range: Range.create(0, 0, 0, Math.max(1, (source.split(/\r?\n/)[0] ?? "").length)),
      message: "Missing required import: `import CompactStandardLibrary;`",
      source: "nite-compact",
    });
    collected.set(file, bucket);
  }

  for (const root of roots) {
    if (generation !== compileGeneration) return; // superseded
    const handle = new CompileHandle();
    activeCompile = handle;
    const result = await handle.run(shadow.toShadowPath(root), shadow.outputDirFor(root), {
      compactPath: settings.compactPath,
      toolchainVersion: settings.toolchainVersion,
      cwd: shadow.root,
    });
    if (handle.cancelled || generation !== compileGeneration) return;

    if (isToolchainFailure(result.output)) {
      connection.console.error(`Nite Compact toolchain failure:\n${result.output}`);
      connection.window.showWarningMessage(
        "Nite Compact: `compact compile` failed to run. Check `niteCompact.compactPath`/`toolchainVersion`.",
      );
      return;
    }

    const reachable = reachableFiles(graph, root);
    for (const raw of parseCompilerOutput(result.output)) {
      const realFile = raw.file
        ? mapCompilerPathToReal(raw.file, root, fileTexts.keys(), reachable)
        : root;
      const explained = explainDiagnostic(raw);
      const diagnostic = toDiagnostic(raw.line, raw.char, explained.message, realFile, fileTexts.get(realFile));
      if (explained.related.length > 0) {
        diagnostic.relatedInformation = explained.related.map((rel) => ({
          location: {
            uri: URI.file(realFile).toString(),
            range: rangeAt(rel.line, rel.char, fileTexts.get(realFile)),
          },
          message: rel.message,
        }));
      }
      const bucket = collected.get(realFile) ?? [];
      bucket.push(diagnostic);
      collected.set(realFile, bucket);
      owned.add(realFile);
    }
  }

  if (generation !== compileGeneration) return;
  activeCompile = null;

  // Lint (not a compiler error): an entry contract with no `pragma
  // language_version` compiles fine today, but silently accepts whatever
  // compiler is installed. Modules are exempt — they legitimately omit it.
  if (settings.warnMissingPragma) {
    for (const root of roots) {
      const source = fileTexts.get(root);
      if (source === undefined || hasLanguagePragma(source)) continue;
      // Module files legitimately have no pragma. This is decided by content,
      // so a module is exempt wherever it lives — and even when nothing has
      // been found importing it yet.
      if (isModuleFile(source)) continue;
      const bucket = collected.get(root) ?? [];
      bucket.push({
        severity: DiagnosticSeverity.Warning,
        range: Range.create(0, 0, 0, Math.max(1, (source.split(/\r?\n/)[0] ?? "").length)),
        message:
          "This contract has no `pragma language_version`, so it compiles against whatever " +
          "compiler version happens to be installed — a different toolchain may interpret it " +
          "differently.\nHow to fix: add a version pragma as the first line, e.g. " +
          "`pragma language_version 0.23;`.\n(Reported by Nite Compact, not the compiler. " +
          "Disable with `niteCompact.warnMissingPragma`.)",
        source: "nite-compact",
      });
      collected.set(root, bucket);
    }
  }

  // Convention hint: modules resolve from anywhere, but a `modules/` directory
  // keeps a project predictable. Informational only — never an error, and it
  // never affects resolution.
  if (settings.suggestModulesDir) {
    for (const file of owned) {
      const source = fileTexts.get(file);
      if (source === undefined || !isModuleFile(source) || isInModulesDir(file)) continue;
      const bucket = collected.get(file) ?? [];
      bucket.push({
        severity: DiagnosticSeverity.Hint,
        range: Range.create(0, 0, 0, Math.max(1, (source.split(/\r?\n/)[0] ?? "").length)),
        message:
          `This file defines a module but is not inside a \`modules\` directory. ` +
          `It resolves correctly either way — moving module files under \`modules/\` ` +
          `just keeps the layout predictable across a project.\n` +
          `(Convention hint from Nite Compact. Disable with \`niteCompact.suggestModulesDir\`.)`,
        source: "nite-compact",
        tags: [DiagnosticTag.Unnecessary],
      });
      collected.set(file, bucket);
    }
  }

  for (const [file, diags] of collected) {
    connection.sendDiagnostics({ uri: URI.file(file).toString(), diagnostics: diags });
  }
}

/**
 * Map a path as printed by the compiler back to a real workspace file.
 *
 * The compiler prints either a path relative to its cwd (the shadow root) or —
 * crucially, for an error inside an imported module — just the basename, with
 * no directory at all. So `modules/Store.compact` is reported as
 * `Store.compact`, and guessing "next to the root" mis-attributes the error to
 * the root file. `knownFiles` (every mirrored workspace file) is searched by
 * basename, preferring files actually reachable from the root being compiled so
 * that same-named files in unrelated directories do not win.
 */
function mapCompilerPathToReal(
  printed: string,
  fallbackRoot: string,
  knownFiles: Iterable<string>,
  reachable?: ReadonlySet<string>,
): string {
  if (!shadow) return fallbackRoot;
  const candidates: string[] = [];
  if (path.isAbsolute(printed)) {
    candidates.push(printed);
  } else {
    candidates.push(path.join(shadow.root, printed));
    candidates.push(path.join(path.dirname(shadow.toShadowPath(fallbackRoot)), printed));
  }
  for (const candidate of candidates) {
    const real = shadow.toRealPath(candidate);
    if (real && fs.existsSync(candidate)) return real;
  }

  const base = path.basename(printed);
  if (path.basename(fallbackRoot) === base) return fallbackRoot;

  // Bare basename: resolve against the files this check already knows about.
  const matches = [...knownFiles].filter((f) => path.basename(f) === base);
  if (matches.length > 0) {
    const preferred = reachable ? matches.find((f) => reachable.has(f)) : undefined;
    return preferred ?? matches[0];
  }

  const nearRoot = path.join(path.dirname(fallbackRoot), base);
  if (fs.existsSync(nearRoot)) return nearRoot;
  return fallbackRoot;
}

function rangeAt(line: number, char: number, text?: string): Range {
  const zeroLine = Math.max(0, line - 1);
  let endChar = char + 1;
  if (text) {
    const lineText = text.split(/\r?\n/)[zeroLine] ?? "";
    endChar = underlineEnd(lineText, char);
  }
  return Range.create(zeroLine, Math.max(0, char - 1), zeroLine, Math.max(0, endChar - 1));
}

function toDiagnostic(line: number, char: number, message: string, file: string, text?: string): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    range: rangeAt(line, char, text),
    message,
    source: "compact",
  };
}

documents.onDidChangeContent((event) => {
  if (settings.compileMode === "onType") {
    scheduleCheck(event.document, settings.debounceMs);
  }
});

documents.onDidSave((event) => {
  scheduleCheck(event.document, 0);
});

documents.onDidOpen((event) => {
  scheduleCheck(event.document, 0);
});

connection.onNotification("niteCompact/checkFile", (uri: string) => {
  const doc = documents.get(uri);
  if (doc) scheduleCheck(doc, 0);
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Read the source of a file referenced by an import, preferring an open
 * buffer (so unsaved edits are honoured) over the copy on disk.
 */
function readImported(fromReal: string, spec: string): string | null {
  const target = resolveImportTarget(fromReal, spec);
  if (!target) return null;
  return readFilePreferBuffer(target);
}

/**
 * Resolve an import specifier to a file, handling both forms: a quoted
 * relative path, and a bare module name that must be searched for because it
 * carries no location. Returns null when nothing matches.
 */
function resolveImportTarget(fromReal: string, spec: string): string | null {
  // A quoted path always contains a separator or a leading dot in practice;
  // a bare module name is a plain identifier.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec)) {
    const target = resolveImport(fromReal, spec);
    return fs.existsSync(target) ? target : null;
  }
  return resolveModuleName(fromReal, spec, workspaceCompactFiles(), (f) => readFilePreferBuffer(f));
}

/** Every .compact file the server knows about, for bare-name resolution. */
function workspaceCompactFiles(): string[] {
  const files = new Set<string>(shadow ? shadow.listWorkspaceFiles() : []);
  for (const doc of documents.all()) {
    if (doc.uri.endsWith(".compact")) files.add(realPathOf(doc));
  }
  return [...files];
}

/**
 * Find the declared type of a ledger field named `receiver`, which may be a
 * local declaration or an imported one referenced through an import prefix
 * (e.g. `import "./LedgerStates" prefix LedgerStates_;` makes the field
 * `admins` visible as `LedgerStates_admins`).
 */
function ledgerTypeOf(doc: TextDocument, text: string, receiver: string): string | null {
  const thisReal = realPathOf(doc);
  return findLedgerType(text, receiver, (spec) => readImported(thisReal, spec));
}

/** Build completion items for the operations available on a ledger field. */
function adtCompletionItems(typeText: string): CompletionItem[] {
  const { methods, resolved } = methodsForType(typeText);
  return methods.map((m) => {
    const signature = resolved ? specialize(m.signature, resolved) : m.signature;
    const docs = [
      "```compact",
      signature,
      "```",
      "",
      m.documentation,
      m.runtimeOnly ? "\n\n**Not callable inside a circuit.**" : "",
    ].join("\n");
    return {
      label: m.name,
      kind: CompletionItemKind.Method,
      detail: signature,
      documentation: { kind: MarkupKind.Markdown, value: docs },
      // Sort real in-circuit operations above the ones that cannot be used.
      sortText: `${m.runtimeOnly || m.deprecated ? "9" : "0"}_${m.name}`,
      ...(m.deprecated || m.runtimeOnly ? { tags: [CompletionItemTag.Deprecated] } : {}),
    } satisfies CompletionItem;
  });
}

/**
 * The struct declaration named by `typeText`, when it names one. Generic
 * arguments are stripped first, so `Maybe<Account>` is looked up as `Maybe`.
 * Resolution goes through `resolveDeclaration`, so imported structs work too.
 */
function structNamed(
  doc: TextDocument,
  text: string,
  typeText: string,
  nearLine: number,
): CompactSymbol | null {
  const bare = typeText.replace(/<[\s\S]*$/, "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) return null;
  const resolved = resolveDeclaration(doc, text, bare, nearLine);
  return resolved && resolved.symbol.kind === "struct" ? resolved.symbol : null;
}

/** Completion items for a struct's fields, skipping any already supplied. */
function structFieldItems(sym: CompactSymbol, exclude?: Set<string>): CompletionItem[] {
  return (sym.fields ?? [])
    .filter((f) => !exclude?.has(f.name))
    .map((f, index) => ({
      label: f.name,
      kind: CompletionItemKind.Field,
      detail: `${f.name}: ${f.type}`,
      documentation: { kind: MarkupKind.Markdown, value: `Field of \`${sym.name}\`.` },
      // Declaration order beats the client's alphabetical default: a struct's
      // fields read as a shape, and shuffling them obscures it.
      sortText: `0_${String(index).padStart(3, "0")}`,
    }));
}

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  // Member access: `someLedgerField.` offers only that ADT's operations.
  const upToCursor = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position,
  });
  const memberAccess = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*[A-Za-z0-9_]*$/.exec(upToCursor);
  if (memberAccess) {
    const declaredType = ledgerTypeOf(doc, doc.getText(), memberAccess[1]);
    if (declaredType) return adtCompletionItems(declaredType);

    // Not a ledger field. A local, parameter, or imported value whose declared
    // type names a struct offers that struct's fields instead.
    const source = doc.getText();
    const receiver = resolveDeclaration(doc, source, memberAccess[1], params.position.line);
    if (receiver?.symbol.type) {
      const struct = structNamed(doc, source, receiver.symbol.type, params.position.line);
      if (struct) return structFieldItems(struct);
    }
    // Unknown receiver: offer nothing rather than a misleading global list.
    return [];
  }

  // Inside a struct literal `Account { … }`, offer the fields not yet set.
  // Matched against everything up to the cursor, not just this line, so a
  // literal spread over several lines still resolves; `[^{}]*` stops the
  // match at the nearest unclosed brace. A `struct` keyword before the name
  // means this is the declaration itself, where its own fields are not wanted.
  const beforeCursor = doc.getText({ start: { line: 0, character: 0 }, end: params.position });
  const literal = /(?:^|[^A-Za-z0-9_])(struct\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\{([^{}]*)$/.exec(beforeCursor);
  if (literal && !literal[1]) {
    const struct = structNamed(doc, doc.getText(), literal[2], params.position.line);
    if (struct) {
      const supplied = new Set([...literal[3].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]));
      const remaining = structFieldItems(struct, supplied);
      if (remaining.length > 0) return remaining;
    }
  }

  const items: CompletionItem[] = [];

  for (const kw of KEYWORDS) {
    items.push({ label: kw, kind: CompletionItemKind.Keyword });
  }
  for (const t of PRIMITIVE_TYPES) {
    items.push({ label: t, kind: CompletionItemKind.Class, detail: "built-in type" });
  }
  for (const t of LEDGER_ADTS) {
    items.push({ label: t, kind: CompletionItemKind.Class, detail: "ledger ADT" });
  }
  for (const entry of STDLIB) {
    items.push({
      label: entry.name,
      kind: entry.kind === "type" ? CompletionItemKind.Struct : CompletionItemKind.Function,
      detail: entry.detail,
      documentation: { kind: MarkupKind.Markdown, value: entry.documentation },
      ...(entry.deprecated ? { tags: [CompletionItemTag.Deprecated] } : {}),
    });
  }

  // Symbols from this file.
  const text = doc.getText();
  for (const sym of extractSymbols(text)) {
    items.push({
      label: sym.name,
      kind: symbolCompletionKind(sym),
      detail: sym.detail,
      ...(sym.doc ? { documentation: { kind: MarkupKind.Markdown, value: sym.doc } } : {}),
    });
  }

  // Exported symbols from imported files, honoring `prefix Foo_`.
  const thisReal = realPathOf(doc);
  for (const imp of extractPrefixedImports(text)) {
    const target = resolveImport(thisReal, imp.spec);
    let importedText: string | null = null;
    const openDoc = documents.all().find((d) => realPathOf(d) === target);
    if (openDoc) importedText = openDoc.getText();
    else {
      try {
        importedText = fs.readFileSync(target, "utf8");
      } catch {
        continue;
      }
    }
    for (const sym of extractSymbols(importedText)) {
      if (!sym.exported || sym.kind === "module") continue;
      const label = imp.prefix ? `${imp.prefix}${sym.name}` : sym.name;
      // Carry the module author's doc comment across the import boundary,
      // noting where the declaration actually lives.
      const origin = `*Declared in \`${path.basename(target)}\`*`;
      items.push({
        label,
        kind: symbolCompletionKind(sym),
        detail: `${sym.detail}  (${path.basename(target)})`,
        documentation: {
          kind: MarkupKind.Markdown,
          value: sym.doc ? `${sym.doc}\n\n${origin}` : origin,
        },
      });
    }
  }

  // De-duplicate by label, first wins.
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.label)) return false;
    seen.add(item.label);
    return true;
  });
});

function symbolCompletionKind(sym: CompactSymbol): CompletionItemKind {
  switch (sym.kind) {
    case "circuit":
    case "pure-circuit":
    case "constructor":
      return CompletionItemKind.Function;
    case "witness":
      return CompletionItemKind.Interface;
    case "ledger":
      return CompletionItemKind.Variable;
    case "struct":
    case "enum":
      return CompletionItemKind.Struct;
    case "module":
      return CompletionItemKind.Module;
    case "const":
      return CompletionItemKind.Constant;
    case "parameter":
      return CompletionItemKind.Variable;
  }
}

// ---------------------------------------------------------------------------
// Document symbols (outline)
// ---------------------------------------------------------------------------

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const lines = text.split(/\r?\n/);
  // Locals and parameters are useful for completion and hover, but they would
  // swamp the outline, so the document tree keeps only top-level declarations.
  const flat = extractSymbols(text).filter((s) => s.kind !== "const" && s.kind !== "parameter");

  const toDocumentSymbol = (sym: CompactSymbol): DocumentSymbol => {
    const lineText = lines[sym.line] ?? "";
    const range = Range.create(sym.line, 0, sym.line, lineText.length);
    return {
      name: sym.name,
      detail: sym.detail,
      kind: symbolDocumentKind(sym),
      range,
      selectionRange: range,
      children: [],
    };
  };

  const modules = new Map<string, DocumentSymbol>();
  const result: DocumentSymbol[] = [];
  for (const sym of flat) {
    const ds = toDocumentSymbol(sym);
    if (sym.kind === "module") {
      modules.set(sym.name, ds);
      result.push(ds);
    } else if (sym.container && modules.has(sym.container)) {
      modules.get(sym.container)!.children!.push(ds);
    } else {
      result.push(ds);
    }
  }
  return result;
});

function symbolDocumentKind(sym: CompactSymbol): SymbolKind {
  switch (sym.kind) {
    case "circuit":
    case "pure-circuit":
      return SymbolKind.Function;
    case "witness":
      return SymbolKind.Interface;
    case "ledger":
      return SymbolKind.Field;
    case "struct":
      return SymbolKind.Struct;
    case "enum":
      return SymbolKind.Enum;
    case "module":
      return SymbolKind.Module;
    case "constructor":
      return SymbolKind.Constructor;
    case "const":
      return SymbolKind.Constant;
    case "parameter":
      return SymbolKind.Variable;
  }
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<CompactSymbol["kind"], string> = {
  circuit: "circuit",
  "pure-circuit": "pure circuit",
  witness: "witness",
  ledger: "ledger field",
  struct: "struct",
  enum: "enum",
  module: "module",
  constructor: "constructor",
  const: "constant",
  parameter: "parameter",
};

/**
 * Render hover markdown for a declaration.
 *
 * The type line is only emitted when the source actually declares one. Most
 * constants in real contracts are unannotated (`const x = f(y);`), and the
 * extension does not do type inference — so it shows the initializer verbatim
 * rather than guessing a type it cannot know.
 */
function describeSymbol(sym: CompactSymbol, prefixedAs?: string): string {
  const parts: string[] = ["```compact", sym.detail, "```", ""];
  // The author's own doc comment leads, above the mechanical details.
  if (sym.doc) parts.push(sym.doc, "");
  if (prefixedAs) {
    // Show the name as it is used here, since the declaration spells it bare.
    parts.push(`Referenced here as \`${prefixedAs}\`.`, "");
  }
  const where = [
    sym.scope ? `in \`${sym.scope}\`` : "",
    sym.container ? `module \`${sym.container}\`` : "",
  ].filter(Boolean).join(", ");
  parts.push(`*${KIND_LABEL[sym.kind]}${where ? ` — ${where}` : ""}*`);

  // A struct is defined by its fields, so show the whole shape rather than
  // just the `struct Name` line the declaration site gives.
  if (sym.kind === "struct" && sym.fields) {
    if (sym.fields.length === 0) {
      parts.push("", "*No fields.*");
    } else {
      const body = sym.fields.map((f) => `  ${f.name}: ${f.type};`).join("\n");
      parts.push("", "```compact", `struct ${sym.name} {`, body, "}", "```");
    }
  }

  if (sym.type) {
    parts.push("", `**Type:** \`${sym.type}\``);
    // A ledger field's type determines which operations it offers.
    if (sym.kind === "ledger") {
      const resolved = resolveAdt(sym.type);
      if (resolved) {
        const ops = resolved.adt.methods
          .filter((m) => !m.deprecated && !m.runtimeOnly)
          .map((m) => `\`${m.name}\``)
          .join(", ");
        parts.push("", resolved.adt.documentation, "", `**Operations:** ${ops}`);
      }
    }
  } else if (sym.kind === "const" && sym.init) {
    // No declared type: show what it is bound to, never an inferred type.
    parts.push("", `**Value:** \`${sym.init}\``);
  }
  return parts.join("\n");
}

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();

  // Hovering the import path itself: say where it resolves and what it offers.
  const importRef = importRefAt(text, params.position.line, params.position.character);
  if (importRef && !importRef.builtin) {
    const target = resolveImportTarget(realPathOf(doc), importRef.spec);
    if (!target) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `Cannot resolve \`${importRef.spec}\`.\n\nExpected file: \`${target}\``,
        },
      };
    }
    const importedText = readFilePreferBuffer(target) ?? "";
    const exported = extractSymbols(importedText).filter((s) => s.exported && s.kind !== "module");
    const prefix = extractPrefixedImports(text).find((i) => i.spec === importRef.spec)?.prefix;
    const lines = [
      `**${path.basename(target)}**`,
      "",
      `[${target}](${URI.file(target).toString()})`,
    ];
    if (exported.length > 0) {
      lines.push("", `Exports ${exported.length} declaration${exported.length === 1 ? "" : "s"}:`, "");
      for (const s of exported.slice(0, 12)) {
        lines.push(`- \`${prefix ? prefix + s.name : s.name}\` — ${s.kind}`);
      }
      if (exported.length > 12) lines.push(`- …and ${exported.length - 12} more`);
    }
    if (prefix) {
      lines.push("", `Imported under the prefix \`${prefix}\`.`);
    }
    return { contents: { kind: MarkupKind.Markdown, value: lines.join("\n") } };
  }

  const found = wordAt(text, doc.offsetAt(params.position));
  if (!found) return null;
  const word = found.word;

  // `field.method` — describe the ADT operation under the cursor. The slice
  // must end at the START of the word, since the cursor sits inside it.
  const lineStart = doc.offsetAt({ line: params.position.line, character: 0 });
  const receiverMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(text.slice(lineStart, found.start));
  if (receiverMatch) {
    const declaredType = ledgerTypeOf(doc, text, receiverMatch[1]);
    if (declaredType) {
      const { methods, resolved } = methodsForType(declaredType);
      const method = methods.find((m: AdtMethod) => m.name === word);
      if (method) {
        const signature = resolved ? specialize(method.signature, resolved) : method.signature;
        const notes = method.runtimeOnly ? "\n\n**Not callable inside a circuit.**" : "";
        const legacy = method.deprecated ? `\n\n**Deprecated** — use \`${method.deprecated}\`.` : "";
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `\`\`\`compact\n${signature}\n\`\`\`\nOperation on \`${declaredType}\`\n\n${method.documentation}${notes}${legacy}`,
          },
        };
      }
    }
  }

  const std = STDLIB.find((e) => e.name === word);
  if (std) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`\`\`compact\n${std.detail}\n\`\`\`\n${std.documentation}`,
      },
    };
  }

  // Local declaration, or one reached through an import prefix.
  const resolved = resolveDeclaration(doc, text, word, params.position.line);
  if (resolved) {
    let value = describeSymbol(resolved.symbol, resolved.prefix ? word : undefined);
    if (resolved.spec) {
      const target = declarationPath(doc, resolved);
      const link = `${URI.file(target).toString()}#L${resolved.symbol.line + 1}`;
      value +=
        `\n\n---\n\nImported from [\`${path.basename(target)}\`](${link}) ` +
        `via \`import "${resolved.spec}"${resolved.prefix ? ` prefix ${resolved.prefix}` : ""};\``;
    }
    return { contents: { kind: MarkupKind.Markdown, value } };
  }
  return null;
});

/**
 * The identifier surrounding `offset`, with its bounds. The bounds matter:
 * hovering lands anywhere inside a word, so callers that need the text before
 * the word (to spot a `receiver.` prefix) must use `start`, not the cursor.
 */
function wordAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  let start = offset;
  let end = offset;
  const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end);
  return /^[A-Za-z_]/.test(word) ? { word, start, end } : null;
}

/** Read a file, preferring an open buffer so unsaved edits are honoured. */
function readFilePreferBuffer(absPath: string): string | null {
  const open = documents.all().find((d) => realPathOf(d) === absPath);
  if (open) return open.getText();
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/** Resolve an identifier to its declaration, following prefixed imports. */
function resolveDeclaration(doc: TextDocument, text: string, word: string, nearLine: number): ResolvedSymbol | null {
  const thisReal = realPathOf(doc);
  return resolveSymbolAt(text, word, (spec) => readImported(thisReal, spec), nearLine);
}

/** Absolute path of a resolved declaration: the import target, or this file. */
function declarationPath(doc: TextDocument, resolved: ResolvedSymbol): string {
  const thisReal = realPathOf(doc);
  if (!resolved.spec) return thisReal;
  return resolveImportTarget(thisReal, resolved.spec) ?? thisReal;
}

/**
 * Locate a declaration precisely: the symbol carries its line, so find the
 * name within that line to produce a range the editor can highlight.
 */
function locationOf(absPath: string, sym: CompactSymbol): Location {
  const source = readFilePreferBuffer(absPath) ?? "";
  const lineText = source.split(/\r?\n/)[sym.line] ?? "";
  const col = Math.max(0, lineText.indexOf(sym.name));
  return {
    uri: URI.file(absPath).toString(),
    range: Range.create(sym.line, col, sym.line, col + sym.name.length),
  };
}

/** The import specifier the position sits inside, if any. */
function importRefAt(text: string, line: number, character: number): ImportRef | undefined {
  return scanImportRefs(text).find(
    (ref) => ref.line === line && character >= ref.startChar && character <= ref.endChar,
  );
}

/**
 * Make `import "./modules/Store"` specifiers clickable, pointing at the file
 * they resolve to. Links are only offered for files that exist, so a typo does
 * not produce a link that goes nowhere.
 */
connection.onDocumentLinks((params): DocumentLink[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const thisReal = realPathOf(doc);
  const links: DocumentLink[] = [];
  for (const ref of scanImportRefs(doc.getText())) {
    if (ref.builtin) continue;
    const target = resolveImportTarget(thisReal, ref.spec);
    if (!target) continue;
    links.push({
      range: Range.create(ref.line, ref.startChar, ref.line, ref.endChar),
      target: URI.file(target).toString(),
      tooltip: `Open ${path.basename(target)}`,
    });
  }
  return links;
});

connection.onDefinition((params): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();

  // On an import specifier, jump to the top of the imported file.
  const ref = importRefAt(text, params.position.line, params.position.character);
  if (ref) {
    if (ref.builtin) return null;
    const target = resolveImportTarget(realPathOf(doc), ref.spec);
    if (!target) return null;
    return { uri: URI.file(target).toString(), range: Range.create(0, 0, 0, 0) };
  }

  const found = wordAt(text, doc.offsetAt(params.position));
  if (!found) return null;

  const resolved = resolveDeclaration(doc, text, found.word, params.position.line);
  if (!resolved) return null;
  return locationOf(declarationPath(doc, resolved), resolved.symbol);
});

// ---------------------------------------------------------------------------
// Formatting (via `compact format`)
// ---------------------------------------------------------------------------

connection.onDocumentFormatting((params): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || cliAvailable === false) return [];

  const original = doc.getText();
  const tmpDir = path.join(os.tmpdir(), "nite-compact-fmt");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${crypto.randomUUID()}.compact`);
  try {
    fs.writeFileSync(tmpFile, original, "utf8");
    const result = spawnSync(settings.compactPath, ["format", tmpFile], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.status !== 0) {
      connection.console.log(`compact format failed: ${result.stderr ?? result.error?.message ?? "unknown"}`);
      return [];
    }
    const formatted = fs.readFileSync(tmpFile, "utf8");
    if (formatted === original) return [];
    const lastLine = doc.lineCount - 1;
    const lastLineText = original.split(/\r?\n/)[lastLine] ?? "";
    return [TextEdit.replace(Range.create(0, 0, lastLine, lastLineText.length), formatted)];
  } catch (err) {
    connection.console.log(`compact format error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
});

documents.listen(connection);
connection.listen();
