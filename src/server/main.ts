import * as fs from "fs";
import * as path from "path";
import {
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
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
  Hover,
  MarkupKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { CompileHandle, probeCompactCli } from "./compiler";
import { explainDiagnostic, isToolchainFailure, parseCompilerOutput, underlineEnd } from "./diagnostics";
import { buildImportGraph, findCompileRoots, reachableFiles, resolveImport } from "./imports";
import { ShadowWorkspace } from "./shadow";
import { extractPrefixedImports, extractSymbols, CompactSymbol } from "./symbols";
import { KEYWORDS, LEDGER_ADTS, PRIMITIVE_TYPES, STDLIB } from "./stdlib";
import { spawnSync } from "child_process";
import * as os from "os";
import * as crypto from "crypto";

interface Settings {
  compactPath: string;
  toolchainVersion: string;
  compileMode: "onType" | "onSave";
  debounceMs: number;
  maxRootsPerCheck: number;
}

const DEFAULT_SETTINGS: Settings = {
  compactPath: "compact",
  toolchainVersion: "",
  compileMode: "onType",
  debounceMs: 400,
  maxRootsPerCheck: 4,
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
      completionProvider: { triggerCharacters: ["_", "."] },
      documentSymbolProvider: true,
      documentFormattingProvider: true,
      hoverProvider: true,
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

    for (const raw of parseCompilerOutput(result.output)) {
      const realFile = raw.file ? mapCompilerPathToReal(raw.file, root) : root;
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

  for (const [file, diags] of collected) {
    connection.sendDiagnostics({ uri: URI.file(file).toString(), diagnostics: diags });
  }
}

/** The compiler prints paths relative to its cwd (the shadow root) or bare basenames. */
function mapCompilerPathToReal(printed: string, fallbackRoot: string): string {
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
  // Bare basename: search the fallback root's directory tree.
  const base = path.basename(printed);
  if (path.basename(fallbackRoot) === base) return fallbackRoot;
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

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
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
    items.push({ label: sym.name, kind: symbolCompletionKind(sym), detail: sym.detail });
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
      items.push({
        label,
        kind: symbolCompletionKind(sym),
        detail: `${sym.detail}  (${path.basename(target)})`,
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
  const flat = extractSymbols(text);

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
  }
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const offset = doc.offsetAt(params.position);
  const word = wordAt(text, offset);
  if (!word) return null;

  const std = STDLIB.find((e) => e.name === word);
  if (std) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`\`\`compact\n${std.detail}\n\`\`\`\n${std.documentation}`,
      },
    };
  }

  const sym = extractSymbols(text).find((s) => s.name === word);
  if (sym) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`\`\`compact\n${sym.detail}\n\`\`\`\n*${sym.kind}${sym.container ? ` in module ${sym.container}` : ""}*`,
      },
    };
  }
  return null;
});

function wordAt(text: string, offset: number): string | null {
  let start = offset;
  let end = offset;
  const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  if (start === end) return null;
  const word = text.slice(start, end);
  return /^[A-Za-z_]/.test(word) ? word : null;
}

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
