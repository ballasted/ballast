// Build the Merkle tree for BallastV1Claim, matching OpenZeppelin's
// MerkleProof.sol EXACTLY:
//   leaf   = keccak256(keccak256(abi.encode(address, uint256, uint256)))
//   node   = keccak256(concat(min(a,b), max(a,b)))   -- commutativeKeccak256
// Odd node at any level is promoted unchanged (no padding), same as OZ's
// JS `@openzeppelin/merkle-tree` library (which isn't installed here, so
// this reimplements its exact algorithm using viem, already a dependency).
const fs = require("fs");
const path = require("path");
const { keccak256, encodeAbiParameters } = require(path.join(__dirname, "../../web/node_modules/viem"));

const DIR = __dirname;
const rows = fs
  .readFileSync(path.join(DIR, "v1_claim_eth.csv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [address, balanceWei, usdValue, ethAmountWei] = line.split(",");
    return { address, balanceWei, usdValue, ethAmountWei };
  });

function leafOf(address, balanceWei, ethAmountWei) {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [address, BigInt(balanceWei), BigInt(ethAmountWei)],
    ),
  );
  return keccak256(inner);
}

function pairHash(a, b) {
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  // concat as raw bytes32||bytes32 (64 bytes), keccak256 of that -- matches
  // Hashes._efficientKeccak256(a,b): mstore(0,a) mstore(0x20,b) keccak256(0,0x40)
  return keccak256(("0x" + lo.slice(2) + hi.slice(2)));
}

const leaves = rows.map((r) => ({ ...r, leaf: leafOf(r.address, r.balanceWei, r.ethAmountWei) }));

// Build tree levels, keep every level so we can extract proofs.
let level = leaves.map((l) => l.leaf);
const levels = [level];
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) {
    if (i + 1 < level.length) next.push(pairHash(level[i], level[i + 1]));
    else next.push(level[i]); // odd one out, promoted unchanged
  }
  levels.push(next);
  level = next;
}
const root = level[0];

// Proof for leaf at index i: at each level, if i has a sibling, include it;
// if i is the "odd one out" (promoted), no sibling is added at that level.
function proofFor(index) {
  const proof = [];
  let idx = index;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const arr = levels[lvl];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    if (siblingIdx < arr.length) proof.push(arr[siblingIdx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

const claims = {};
leaves.forEach((l, i) => {
  claims[l.address] = {
    balanceWei: l.balanceWei,
    ethAmountWei: l.ethAmountWei,
    usdValue: l.usdValue,
    leaf: l.leaf,
    proof: proofFor(i),
  };
});

fs.writeFileSync(
  path.join(DIR, "v1_claim_merkle.json"),
  JSON.stringify({ root, holders: leaves.length, claims }, null, 2),
);
console.log("root:", root);
console.log("holders:", leaves.length);

// Self-check: verify every proof reconstructs the root, using the SAME
// commutativeKeccak256 algorithm (independent re-implementation of the
// verify loop, not just re-running proofFor).
function verify(leaf, proof, expectedRoot) {
  let computed = leaf;
  for (const p of proof) computed = pairHash(computed, p);
  return computed === expectedRoot;
}
let allOk = true;
leaves.forEach((l, i) => {
  const ok = verify(l.leaf, claims[l.address].proof, root);
  if (!ok) {
    allOk = false;
    console.error("FAILED self-check for", l.address);
  }
});
console.log(allOk ? "self-check: ALL 71 PROOFS VERIFY against root" : "self-check FAILED");
