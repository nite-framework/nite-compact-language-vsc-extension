/**
 * Keyword and standard-library completion data.
 *
 * Keyword groups mirror the compiler's own parser keyword list. The stdlib
 * entries were verified against `compact compile` 0.31.1 (toolchain probing:
 * every name, signature, and return type below was confirmed by the compiler's
 * own error output). The compiler remains the authority — anything wrong here
 * shows up as a squiggle from the real compile, never a false "OK".
 */

export const KEYWORDS: string[] = [
  "as", "assert", "circuit", "const", "constructor", "contract", "default",
  "disclose", "do", "else", "enum", "export", "false", "fold", "for", "if",
  "import", "in", "include", "ledger", "map", "module", "new", "null", "over",
  "pad", "pragma", "prefix", "pure", "return", "sealed", "struct", "to",
  "true", "witness",
];

export const PRIMITIVE_TYPES: string[] = [
  "Boolean", "Field", "Bytes", "Uint", "Integer", "Unsigned", "Opaque",
  "Vector", "Void",
];

export const LEDGER_ADTS: string[] = [
  "Counter", "Cell", "Set", "List", "Map", "MerkleTree", "HistoricMerkleTree",
  "Kernel",
];

export interface StdlibEntry {
  name: string;
  detail: string;
  documentation: string;
  /** "type" entries complete as structs; everything else as functions. */
  kind?: "circuit" | "type";
  /** Present on legacy names the compiler rejects — value is the new name. */
  deprecated?: string;
}

export const STDLIB: StdlibEntry[] = [
  // -- Hashing and commitments ----------------------------------------------
  {
    name: "persistentHash",
    detail: "persistentHash<T>(value: T): Bytes<32>",
    documentation: "Persistent (cross-transaction) hash of a value. Commonly used with Vector<n, Bytes<32>> for commitments.",
  },
  {
    name: "transientHash",
    detail: "transientHash<T>(value: T): Field",
    documentation: "Transient hash usable within a single transaction context.",
  },
  {
    name: "persistentCommit",
    detail: "persistentCommit<T>(value: T, rand: Bytes<32>): Bytes<32>",
    documentation: "Hiding commitment to a value with explicit randomness.",
  },
  {
    name: "transientCommit",
    detail: "transientCommit<T>(value: T, rand: Field): Field",
    documentation: "Transient hiding commitment to a value.",
  },
  {
    name: "degradeToTransient",
    detail: "degradeToTransient(x: Bytes<32>): Field",
    documentation: "Converts a persistent hash value into a transient Field value.",
  },
  {
    name: "upgradeFromTransient",
    detail: "upgradeFromTransient(x: Field): Bytes<32>",
    documentation: "Converts a transient Field value into a persistent Bytes<32> value.",
  },

  // -- Elliptic-curve operations --------------------------------------------
  {
    name: "hashToCurve",
    detail: "hashToCurve<T>(value: T): JubjubPoint",
    documentation: "Hashes a value to a point on the embedded (Jubjub) curve.",
  },
  {
    name: "ecAdd",
    detail: "ecAdd(a: JubjubPoint, b: JubjubPoint): JubjubPoint",
    documentation: "Adds two points on the embedded curve.",
  },
  {
    name: "ecMul",
    detail: "ecMul(a: JubjubPoint, b: Field): JubjubPoint",
    documentation: "Multiplies a curve point by a scalar.",
  },
  {
    name: "ecMulGenerator",
    detail: "ecMulGenerator(b: Field): JubjubPoint",
    documentation: "Multiplies the curve generator by a scalar.",
  },

  // -- Merkle trees ----------------------------------------------------------
  {
    name: "merkleTreePathRoot",
    detail: "merkleTreePathRoot<#n, T>(path: MerkleTreePath<n, T>): MerkleTreeDigest",
    documentation: "Computes the root digest implied by a Merkle tree membership path (hashing the leaf).",
  },
  {
    name: "merkleTreePathRootNoLeafHash",
    detail: "merkleTreePathRootNoLeafHash<#n>(path: MerkleTreePath<n, Bytes<32>>): MerkleTreeDigest",
    documentation: "Computes the root digest from a path whose leaf is already a hash (no extra leaf hashing).",
  },

  // -- Maybe / Either constructors ------------------------------------------
  {
    name: "left",
    detail: "left<A, B>(value: A): Either<A, B>",
    documentation: "Constructs the left variant of an Either.",
  },
  {
    name: "right",
    detail: "right<A, B>(value: B): Either<A, B>",
    documentation: "Constructs the right variant of an Either.",
  },
  {
    name: "some",
    detail: "some<T>(value: T): Maybe<T>",
    documentation: "Constructs a present Maybe value.",
  },
  {
    name: "none",
    detail: "none<T>(): Maybe<T>",
    documentation: "Constructs an absent Maybe value.",
  },

  // -- Identity and token types ---------------------------------------------
  {
    name: "ownPublicKey",
    detail: "ownPublicKey(): ZswapCoinPublicKey",
    documentation: "The caller's Zswap coin public key (shielded identity).",
  },
  {
    name: "nativeToken",
    detail: "nativeToken(): Bytes<32>",
    documentation: "The token type (color) of the native token.",
  },
  {
    name: "tokenType",
    detail: "tokenType(domainSep: Bytes<32>, contract: ContractAddress): Bytes<32>",
    documentation: "Derives a shielded token type (color) from a domain separator and contract address.",
  },
  {
    name: "evolveNonce",
    detail: "evolveNonce(index: Uint<128>, nonce: Bytes<32>): Bytes<32>",
    documentation: "Derives a fresh coin nonce from an index and prior nonce.",
  },
  {
    name: "shieldedBurnAddress",
    detail: "shieldedBurnAddress(): Either<ZswapCoinPublicKey, ContractAddress>",
    documentation: "A recipient address from which shielded tokens can never be spent (for burning).",
  },

  // -- Shielded coins ---------------------------------------------------------
  {
    name: "receiveShielded",
    detail: "receiveShielded(coin: ShieldedCoinInfo): []",
    documentation: "Receives a shielded coin sent to the contract in this call.",
  },
  {
    name: "sendShielded",
    detail: "sendShielded(input: QualifiedShieldedCoinInfo, recipient: Either<ZswapCoinPublicKey, ContractAddress>, value: Uint<128>): ShieldedSendResult",
    documentation: "Sends value from a held coin to a recipient, returning sent/change coin information.",
  },
  {
    name: "sendImmediateShielded",
    detail: "sendImmediateShielded(input: ShieldedCoinInfo, recipient: Either<ZswapCoinPublicKey, ContractAddress>, value: Uint<128>): ShieldedSendResult",
    documentation: "Sends from a coin received in the same call, without it entering contract custody.",
  },
  {
    name: "mergeCoin",
    detail: "mergeCoin(a: QualifiedShieldedCoinInfo, b: QualifiedShieldedCoinInfo): ShieldedCoinInfo",
    documentation: "Merges two coins held by the contract into one.",
  },
  {
    name: "mergeCoinImmediate",
    detail: "mergeCoinImmediate(a: QualifiedShieldedCoinInfo, b: ShieldedCoinInfo): ShieldedCoinInfo",
    documentation: "Merges a held coin with one received in the same call.",
  },
  {
    name: "mintShieldedToken",
    detail: "mintShieldedToken(domainSep: Bytes<32>, value: Uint<64>, nonce: Bytes<32>, recipient: Either<ZswapCoinPublicKey, ContractAddress>): ShieldedCoinInfo",
    documentation: "Mints shielded tokens of the contract-derived token type to a recipient, returning the minted coin.",
  },

  // -- Unshielded tokens ------------------------------------------------------
  {
    name: "sendUnshielded",
    detail: "sendUnshielded(tokenType: Bytes<32>, value: Uint<128>, recipient: Either<ContractAddress, UserAddress>): []",
    documentation: "Sends unshielded tokens held by the contract to a recipient.",
  },
  {
    name: "receiveUnshielded",
    detail: "receiveUnshielded(tokenType: Bytes<32>, value: Uint<128>): []",
    documentation: "Receives unshielded tokens supplied to the current call.",
  },
  {
    name: "mintUnshieldedToken",
    detail: "mintUnshieldedToken(domainSep: Bytes<32>, value: Uint<64>, recipient: Either<ContractAddress, UserAddress>): Bytes<32>",
    documentation: "Mints unshielded tokens of the contract-derived token type to a recipient, returning the token type.",
  },

  // -- Standard-library types -------------------------------------------------
  {
    name: "Maybe",
    kind: "type",
    detail: "struct Maybe<T> { is_some: Boolean, value: T }",
    documentation: "An optional value. Construct with some(...) / none().",
  },
  {
    name: "Either",
    kind: "type",
    detail: "struct Either<A, B> { is_left: Boolean, left: A, right: B }",
    documentation: "A value of one of two types. Construct with left(...) / right(...).",
  },
  {
    name: "JubjubPoint",
    kind: "type",
    detail: "JubjubPoint",
    documentation: "A point on the embedded (Jubjub) elliptic curve, produced by hashToCurve / ecAdd / ecMul / ecMulGenerator.",
  },
  {
    name: "MerkleTreeDigest",
    kind: "type",
    detail: "struct MerkleTreeDigest { field: Field }",
    documentation: "The root digest of a Merkle tree.",
  },
  {
    name: "MerkleTreePathEntry",
    kind: "type",
    detail: "struct MerkleTreePathEntry { sibling: MerkleTreeDigest, goes_left: Boolean }",
    documentation: "One step of a Merkle tree membership path.",
  },
  {
    name: "MerkleTreePath",
    kind: "type",
    detail: "struct MerkleTreePath<#n, T> { leaf: T, path: Vector<n, MerkleTreePathEntry> }",
    documentation: "A Merkle tree membership path for a depth-n tree, typically obtained from a witness.",
  },
  {
    name: "ContractAddress",
    kind: "type",
    detail: "struct ContractAddress { bytes: Bytes<32> }",
    documentation: "The address of a contract.",
  },
  {
    name: "UserAddress",
    kind: "type",
    detail: "struct UserAddress { bytes: Bytes<32> }",
    documentation: "The unshielded address of a user.",
  },
  {
    name: "ZswapCoinPublicKey",
    kind: "type",
    detail: "struct ZswapCoinPublicKey { bytes: Bytes<32> }",
    documentation: "A user's shielded (Zswap) coin public key.",
  },
  {
    name: "ShieldedCoinInfo",
    kind: "type",
    detail: "struct ShieldedCoinInfo { nonce: Bytes<32>, color: Bytes<32>, value: Uint<128> }",
    documentation: "A shielded coin: nonce, token type (color), and value.",
  },
  {
    name: "QualifiedShieldedCoinInfo",
    kind: "type",
    detail: "struct QualifiedShieldedCoinInfo { nonce: Bytes<32>, color: Bytes<32>, value: Uint<128>, mt_index: Uint<64> }",
    documentation: "A shielded coin that exists on-chain, qualified by its commitment Merkle tree index.",
  },
  {
    name: "ShieldedSendResult",
    kind: "type",
    detail: "struct ShieldedSendResult { change: Maybe<ShieldedCoinInfo>, sent: ShieldedCoinInfo }",
    documentation: "Result of sendShielded / sendImmediateShielded: the sent coin and any change returned to the contract.",
  },

  // -- Language builtins (not stdlib exports, but useful on hover) -----------
  {
    name: "pad",
    detail: "pad(n, literal): Bytes<n>",
    documentation: "Pads a string literal to a fixed-width byte string, e.g. pad(32, \"my:domain:tag\").",
  },
  {
    name: "disclose",
    detail: "disclose<T>(value: T): T",
    documentation: "Marks witness-derived data as intentionally public. Required before storing private-derived values in ledger state.",
  },
  {
    name: "kernel",
    detail: "kernel: Kernel",
    documentation: "Ledger kernel operations (e.g. kernel.self() for the contract's own address, block-time bounds).",
  },

  // -- Legacy names (compiler 0.31+ rejects these with a rename hint) --------
  {
    name: "send",
    deprecated: "sendShielded",
    detail: "send(...) — renamed to sendShielded",
    documentation: "**Deprecated.** The compiler now calls this `sendShielded`; using `send` is an error.",
  },
  {
    name: "sendImmediate",
    deprecated: "sendImmediateShielded",
    detail: "sendImmediate(...) — renamed to sendImmediateShielded",
    documentation: "**Deprecated.** The compiler now calls this `sendImmediateShielded`; using `sendImmediate` is an error.",
  },
  {
    name: "receive",
    deprecated: "receiveShielded",
    detail: "receive(...) — renamed to receiveShielded",
    documentation: "**Deprecated.** The compiler now calls this `receiveShielded`; using `receive` is an error.",
  },
  {
    name: "mintToken",
    deprecated: "mintShieldedToken",
    detail: "mintToken(...) — renamed to mintShieldedToken",
    documentation: "**Deprecated.** The compiler now calls this `mintShieldedToken`; using `mintToken` is an error.",
  },
  {
    name: "burnAddress",
    deprecated: "shieldedBurnAddress",
    detail: "burnAddress(...) — renamed to shieldedBurnAddress",
    documentation: "**Deprecated.** The compiler now calls this `shieldedBurnAddress`; using `burnAddress` is an error.",
  },
  {
    name: "CurvePoint",
    kind: "type",
    deprecated: "JubjubPoint",
    detail: "CurvePoint — renamed to JubjubPoint",
    documentation: "**Deprecated.** The compiler now calls this type `JubjubPoint`; using `CurvePoint` is an error.",
  },
];
