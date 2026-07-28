/**
 * Ledger ADT operations.
 *
 * EVERY entry in this file was verified against the real compiler (Compact
 * toolchain 0.5.1, compiler 0.31.1, language version 0.23) by probing:
 *
 *   - existence: calling `field.name()` and checking the compiler does NOT say
 *     "operation <name> undefined for ledger field type <ADT>";
 *   - arity:     the compiler prints "<ADT> <name> requires N argument(s)";
 *   - arg types: passing a deliberately wrong-typed argument makes the compiler
 *     print "expected first argument of <name> to have type T";
 *   - returns:   binding the result to a mismatched type makes the compiler
 *     print "mismatch between actual type T and declared type ...".
 *
 * Nothing here is copied from prose documentation — the published docs were
 * found to disagree with the compiler (they list `contains` for Set/Map, but
 * the real operation is `member`, and they spell `resetToDefault` in snake
 * case). Where a return type could not be elicited directly it was confirmed
 * from real contract usage (e.g. `checkRoot` appears as an `&&` operand, so it
 * is Boolean). See test/run-pipeline.mjs for the regression tests that re-check
 * these against whatever toolchain is installed.
 *
 * NOTE: `Cell` is deliberately absent. It is not a real type name — the
 * compiler reports "unbound identifier Cell". A plain typed ledger field
 * (`ledger x: Uint<64>;`) is the cell; its operations are CELL_METHODS below.
 */

import { extractPrefixedImports, extractSymbols } from "./symbols";

export interface AdtMethod {
  name: string;
  /** Display signature, with type parameters left symbolic (T, K, V). */
  signature: string;
  /** Return type, symbolic where it depends on the field's type arguments. */
  returns: string;
  documentation: string;
  /** Exists, but the compiler rejects it inside a circuit. */
  runtimeOnly?: boolean;
  /** Legacy spelling the compiler rejects; value is the replacement name. */
  deprecated?: string;
  /** Only valid when the map's value type is a coin type. */
  requiresCoinValue?: boolean;
}

export interface LedgerAdt {
  name: string;
  /** Ordered type-parameter names as they appear in `Name<...>`. */
  typeParams: string[];
  documentation: string;
  methods: AdtMethod[];
}

const RESET: AdtMethod = {
  name: "resetToDefault",
  signature: "resetToDefault(): []",
  returns: "[]",
  documentation: "Reset this field to its default (empty/zero) value.",
};

const RESET_LEGACY: AdtMethod = {
  name: "reset_to_default",
  signature: "reset_to_default(): []",
  returns: "[]",
  deprecated: "resetToDefault",
  documentation:
    "Legacy name. The compiler rejects it: *\"apparent use of an old standard-library / ledger operator name reset_to_default: the new name is resetToDefault\"*. Use `resetToDefault()`.",
};

export const LEDGER_ADTS: Record<string, LedgerAdt> = {
  Counter: {
    name: "Counter",
    typeParams: [],
    documentation: "A monotonic counter held in public ledger state.",
    methods: [
      {
        name: "read",
        signature: "read(): Uint<64>",
        returns: "Uint<64>",
        documentation: "Current value of the counter.",
      },
      {
        name: "increment",
        signature: "increment(amount: Uint<16>): []",
        returns: "[]",
        documentation:
          "Add `amount` to the counter. The argument is a `Uint<16>`, so a single call can add at most 65535.",
      },
      {
        name: "decrement",
        signature: "decrement(amount: Uint<16>): []",
        returns: "[]",
        documentation:
          "Subtract `amount` from the counter. The argument is a `Uint<16>`. Decrementing below zero fails at run time.",
      },
      RESET,
      RESET_LEGACY,
    ],
  },

  Set: {
    name: "Set",
    typeParams: ["T"],
    documentation: "An unordered set of values held in public ledger state.",
    methods: [
      {
        name: "member",
        signature: "member(elem: T): Boolean",
        returns: "Boolean",
        documentation:
          "True when `elem` is in the set. This is the membership test — there is no `contains` operation.",
      },
      {
        name: "insert",
        signature: "insert(elem: T): []",
        returns: "[]",
        documentation: "Add `elem` to the set. Inserting an existing element is a no-op.",
      },
      {
        name: "remove",
        signature: "remove(elem: T): []",
        returns: "[]",
        documentation: "Remove `elem` from the set. Removing an absent element is a no-op.",
      },
      { name: "size", signature: "size(): Uint<64>", returns: "Uint<64>", documentation: "Number of elements in the set." },
      { name: "isEmpty", signature: "isEmpty(): Boolean", returns: "Boolean", documentation: "True when the set has no elements." },
      RESET,
      RESET_LEGACY,
      {
        name: "iter",
        signature: "iter(...)",
        returns: "",
        runtimeOnly: true,
        documentation:
          "Runtime-only. The compiler rejects it in a circuit: *\"Set iter is a runtime-only method, but was invoked in-circuit\"*.",
      },
    ],
  },

  Map: {
    name: "Map",
    typeParams: ["K", "V"],
    documentation: "A key/value map held in public ledger state.",
    methods: [
      {
        name: "member",
        signature: "member(key: K): Boolean",
        returns: "Boolean",
        documentation:
          "True when `key` has an entry. This is the membership test — there is no `contains` or `has_key` operation.",
      },
      {
        name: "insert",
        signature: "insert(key: K, value: V): []",
        returns: "[]",
        documentation: "Insert or overwrite the entry for `key`.",
      },
      {
        name: "lookup",
        signature: "lookup(key: K): V",
        returns: "V",
        documentation:
          "Value stored at `key`. Fails at run time when the key is absent — guard with `member(key)` first.",
      },
      { name: "remove", signature: "remove(key: K): []", returns: "[]", documentation: "Remove the entry for `key`, if any." },
      {
        name: "insertDefault",
        signature: "insertDefault(key: K): []",
        returns: "[]",
        documentation: "Insert `key` mapped to the default value of the value type.",
      },
      { name: "size", signature: "size(): Uint<64>", returns: "Uint<64>", documentation: "Number of entries in the map." },
      { name: "isEmpty", signature: "isEmpty(): Boolean", returns: "Boolean", documentation: "True when the map has no entries." },
      {
        name: "insertCoin",
        signature: "insertCoin(key: K, coin: QualifiedShieldedCoinInfo, recipient: Either<ZswapCoinPublicKey, ContractAddress>): []",
        returns: "[]",
        requiresCoinValue: true,
        documentation:
          "Insert a coin into a map whose value type is a coin type. Only available on such maps — on an ordinary map the compiler reports `operation insertCoin undefined`.",
      },
      RESET,
      RESET_LEGACY,
      {
        name: "iter",
        signature: "iter(...)",
        returns: "",
        runtimeOnly: true,
        documentation:
          "Runtime-only. The compiler rejects it in a circuit: *\"Map iter is a runtime-only method, but was invoked in-circuit\"*.",
      },
    ],
  },

  List: {
    name: "List",
    typeParams: ["T"],
    documentation: "A singly-linked list held in public ledger state; efficient at the front.",
    methods: [
      { name: "length", signature: "length(): Uint<64>", returns: "Uint<64>", documentation: "Number of elements. Note: `length`, not `size`." },
      { name: "isEmpty", signature: "isEmpty(): Boolean", returns: "Boolean", documentation: "True when the list has no elements." },
      {
        name: "head",
        signature: "head(): Maybe<T>",
        returns: "Maybe<T>",
        documentation:
          "First element wrapped in `Maybe<T>` — check `.is_some` before reading `.value`, so an empty list is safe.",
      },
      { name: "pushFront", signature: "pushFront(elem: T): []", returns: "[]", documentation: "Prepend `elem` to the list." },
      { name: "popFront", signature: "popFront(): []", returns: "[]", documentation: "Remove the first element. Returns nothing — read it with `head()` first." },
      RESET,
      RESET_LEGACY,
      {
        name: "iter",
        signature: "iter(...)",
        returns: "",
        runtimeOnly: true,
        documentation: "Runtime-only; the compiler rejects it in a circuit.",
      },
    ],
  },
};

/** MerkleTree and HistoricMerkleTree expose the same in-circuit operations. */
const MERKLE_METHODS = (adt: string): AdtMethod[] => [
  {
    name: "insert",
    signature: "insert(leaf: T): []",
    returns: "[]",
    documentation: "Insert a leaf value at the next free index.",
  },
  {
    name: "insertHash",
    signature: "insertHash(hash: Bytes<32>): []",
    returns: "[]",
    documentation: "Insert an already-hashed leaf at the next free index.",
  },
  {
    name: "insertIndexDefault",
    signature: "insertIndexDefault(index: Uint<64>): []",
    returns: "[]",
    documentation: "Reset the leaf at `index` to the default (empty) value.",
  },
  {
    name: "insertHashIndex",
    signature: "insertHashIndex(hash: Bytes<32>, index: Uint<64>): []",
    returns: "[]",
    documentation: "Insert an already-hashed leaf at a specific `index`.",
  },
  {
    name: "checkRoot",
    signature: "checkRoot(root: MerkleTreeDigest): Boolean",
    returns: "Boolean",
    documentation:
      `Verify that \`root\` is a valid root of this ${adt}. Build the argument with \`merkleTreePathRoot<...>(path)\` or \`merkleTreePathRootNoLeafHash<...>(path)\`, then combine with the path's \`is_some\`:\n\n\`\`\`compact\nassert(path.is_some && tree.checkRoot(merkleTreePathRoot<32, Bytes<32>>(path.value)), "bad proof");\n\`\`\``,
  },
  {
    name: "isFull",
    signature: "isFull(): Boolean",
    returns: "Boolean",
    documentation: "True when every leaf slot is occupied.",
  },
  RESET,
  RESET_LEGACY,
  {
    name: "root",
    signature: "root(...)",
    returns: "",
    runtimeOnly: true,
    documentation:
      "Runtime-only — the compiler rejects it in a circuit. In-circuit, verify a root with `checkRoot(...)` instead.",
  },
];

LEDGER_ADTS.MerkleTree = {
  name: "MerkleTree",
  typeParams: ["n", "T"],
  documentation: "A fixed-depth Merkle tree in public ledger state, for membership proofs.",
  methods: MERKLE_METHODS("MerkleTree"),
};

LEDGER_ADTS.HistoricMerkleTree = {
  name: "HistoricMerkleTree",
  typeParams: ["n", "T"],
  documentation:
    "Like `MerkleTree`, but also accepts proofs against historic roots, so a proof stays valid after later insertions.",
  methods: MERKLE_METHODS("HistoricMerkleTree"),
};

/**
 * Operations on a plain typed ledger field (`ledger x: Uint<64>;`), which acts
 * as a single cell. Verified the same way as the ADTs above.
 */
export const CELL_METHODS: AdtMethod[] = [
  {
    name: "read",
    signature: "read(): T",
    returns: "T",
    documentation: "Current value. Usually implicit — referring to the field directly reads it.",
  },
  {
    name: "write",
    signature: "write(value: T): []",
    returns: "[]",
    documentation: "Store a new value. Usually written as `field = value`.",
  },
  RESET,
  RESET_LEGACY,
];

/**
 * Resolve the declared type of the ledger field named `receiver`.
 *
 * The field may be declared in this file, or exported from a module that was
 * imported under a prefix (`import "./modules/Store" prefix Store_;` makes the
 * module's `balances` visible here as `Store_balances`) — the structure real
 * contracts use. `readImport` is given the import specifier and returns that
 * file's source, or null when it cannot be read.
 */
export function findLedgerType(
  text: string,
  receiver: string,
  readImport: (spec: string) => string | null,
): string | null {
  const local = extractSymbols(text).find((s) => s.kind === "ledger" && s.name === receiver);
  if (local?.type) return local.type;

  for (const imp of extractPrefixedImports(text)) {
    if (!imp.prefix || !receiver.startsWith(imp.prefix)) continue;
    const bare = receiver.slice(imp.prefix.length);
    const importedText = readImport(imp.spec);
    if (importedText === null) continue;
    const found = extractSymbols(importedText).find((s) => s.kind === "ledger" && s.name === bare);
    if (found?.type) return found.type;
  }
  return null;
}

/** Split `A, B<C, D>` on top-level commas only. */
function splitTypeArgs(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export interface ResolvedAdt {
  adt: LedgerAdt;
  /** Concrete type arguments, positionally matching `adt.typeParams`. */
  typeArgs: string[];
}

/**
 * Resolve a declared ledger type (e.g. `Map<Bytes<32>, Foo>`) to its ADT.
 * Returns null for plain cell types, which have no ADT operations.
 */
export function resolveAdt(typeText: string): ResolvedAdt | null {
  const text = typeText.trim();
  const head = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (!head) return null;
  const adt = LEDGER_ADTS[head[1]];
  if (!adt) return null;
  const open = text.indexOf("<");
  let typeArgs: string[] = [];
  if (open !== -1 && text.endsWith(">")) {
    typeArgs = splitTypeArgs(text.slice(open + 1, -1));
  }
  return { adt, typeArgs };
}

/** Substitute concrete type arguments into a symbolic signature. */
export function specialize(text: string, resolved: ResolvedAdt): string {
  let out = text;
  resolved.adt.typeParams.forEach((param, i) => {
    const actual = resolved.typeArgs[i];
    if (!actual) return;
    out = out.replace(new RegExp(`\\b${param}\\b`, "g"), actual);
  });
  return out;
}

/**
 * Methods offered for a declared ledger type. Plain (non-ADT) types get the
 * cell operations. Runtime-only methods are included but flagged, so the editor
 * can show them struck through rather than pretend they do not exist.
 */
export function methodsForType(typeText: string): { methods: AdtMethod[]; resolved: ResolvedAdt | null } {
  const resolved = resolveAdt(typeText);
  if (!resolved) return { methods: CELL_METHODS, resolved: null };
  const isCoinMap =
    resolved.adt.name === "Map" && /Coin(Info)?\b/.test(resolved.typeArgs[1] ?? "");
  const methods = resolved.adt.methods.filter((m) => !m.requiresCoinValue || isCoinMap);
  return { methods, resolved };
}
