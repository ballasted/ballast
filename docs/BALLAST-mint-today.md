# BALLAST — manatee mint, ship today

Read `CLAUDE.md` first. This is a separate product from the launchpad.
**No BALLAST protocol contract is touched.** No redeploy, no parameter change,
no new permission on anything already live.

**Mint goes live today.** It's already been announced publicly, so if any step
below can't be done properly, tell me immediately rather than at the end. A
late mint is better than a broken one.

---

## Scope, and nothing beyond it

A 1,000-piece ERC-721 on Robinhood Chain.

- Free mint, gas only
- One per wallet
- No allowlist, no phases, no reveal, no snapshot, no holder round
- Art generated on-chain from the token id
- Confers nothing, and the page says so

Anything about fee distribution, holder allocations, or treasury mechanics is
**not in this build**. Don't add it, don't leave hooks for it.

---

## Step 1 — Port the art, and verify it. Report before continuing.

`docs/manatee_gen.py` is the specification. Reference renders for ten ids are
in `docs/manatee-samples/`.

The generator takes a token id and returns an SVG. Depth comes from the id
directly; light shafts, particles, and seabed come from a seeded hash of the
id. Same id, same image, every time.

**The contract stores the generator, not the images.** `tokenURI()` computes
the SVG on read. No IPFS, no 1,000 stored files.

### Requirements

- **Output must match the Python byte for byte** for the same id. Verify ids
  1, 2, 60, 180, 340, 500, 680, 840, 950, 1000 against the reference files.
- The Python uses `sha256("ballast-manatee-{id}-{salt}")` and takes the first
  12 hex chars over `0xFFFFFFFFFFFF`. Reproduce exactly. **Do not substitute
  keccak256** even though it's cheaper — the images would differ from what's
  already been published.
- The depth gradient interpolates colours with floating point in Python.
  Solidity has no floats, so replicate with integer arithmetic that produces
  identical values. This is the most likely place to diverge.
- SVGs run 2.4–4.1 KB. Confirm concatenation at that size is viable.
- `tokenURI()` returns base64 JSON with an embedded base64 SVG.

### Report before writing the collection contract

- Byte-for-byte match: yes or no. If no, which ids and where it diverges.
- Deploy gas for the generator
- Gas for one `tokenURI()` call — OpenSea and indexers must be able to call it,
  so it can't be prohibitively expensive as a view

**If it can't match, stop and tell me.** I published a grid of what these look
like. Shipping different art would be a correction, not a detail.

---

## Step 2 — The contract

ERC-721, Ownable2Step, owner is the deployer EOA — the same key as everything
else, disclosed as such.

```
mint()          one per wallet, cap 1000, no payment
tokenURI(id)    on-chain generated, base64 JSON + SVG
totalSupply()
```

Deliberately absent:

- No `setBaseURI`, no reveal, no upgrade path, no proxy
- No mint price, no allowlist, no merkle root
- No pause, no blocklist
- Nothing the owner can call that changes what a minted token looks like

What's minted is final.

Set EIP-2981 royalty at 7.5% to the deployer address. Note in your report
whether anything on this chain actually enforces it — if not, it costs nothing
to set and I want to know before describing it anywhere.

### Tests, adversarial first, before deploy

- Minting twice from one wallet
- Minting past the 1,000 cap
- Minting from a contract
- `tokenURI()` for a nonexistent id
- `tokenURI()` for ids 1 and 1000, compared to the reference
- Whether anything in the SVG path can render something unintended

---

## Step 3 — Deploy

- Dry run first, show me the constructor args and the address it would deploy
  to before broadcasting
- Broadcast, then verify on Blockscout
- Report the address

---

## Step 4 — The mint page

Route `/mint` or wherever fits the existing app structure.

- Connect, mint. One button.
- Live counter: minted of 1,000
- After minting, show what they got — rendered from the contract's own
  `tokenURI()`, not a local copy. The page should prove the on-chain art works.
- Designed state when a wallet has already minted
- Designed state when supply is exhausted
- Designed state when the wallet is on the wrong network

Visual language identical to the rest of the app. No countdown, no urgency
copy, no supply-remaining pressure beyond the plain counter.

### Copy, exactly this tone

> Free to mint, one per wallet. The art is generated on-chain from the token
> id — there is no IPFS and no metadata server. Every manatee is the same
> drawing; only the depth changes. Nothing is rarer than anything else.
>
> This confers nothing. No revenue share, no governance, no airdrop, no
> allocation. If that changes, we'll announce it after it's true.

---

## Step 5 — Before I announce it live

Tell me:

- Contract address, verified
- That you minted one yourself from a test wallet and the art rendered
- That a second mint from the same wallet reverts
- The mint page URL

**Do not tell me it's ready until you've minted one and looked at it.**

---

## Report

- Byte-for-byte match result
- Deploy gas, `tokenURI()` gas
- Whether royalties are enforced on this chain
- The contract address
- Anything you couldn't do, and why
