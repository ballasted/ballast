# Logo submissions — BALLAST v2, exact steps

Researched live 2026-09-29 (official docs + support pages). All three of these
need your browser — none are API-automatable from here (payment forms,
email-based manual review, or a challenge Cloudflare blocks for scripts).

## 1. Blockscout token icon

**Your case needs the MANUAL route** — BALLAST v2's creator is the Safe
(`0xEFC97e16a24d2434C7138a2634E554a0631aC079`), a smart-contract wallet, not
a plain EOA. Blockscout's automated path ("log in with the same address that
deployed the token") only works for EOA deployers — there's no documented
EIP-1271/Safe-signature path, and the token was actually deployed BY the
factory (`0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67`), with the Safe only as
`creator()` — so the automated path doesn't apply regardless.

**Steps:**
1. Send an email to **submissions@blockscout.com**.
2. Subject: `Token info submission — $BALLAST (0xDc605041F02e41CbD8FDC347023e93C4c3fA243C) on Robinhood Chain`
3. Body — use this draft:

   > Token: $BALLAST (BALLAST), `0xDc605041F02e41CbD8FDC347023e93C4c3fA243C`, Robinhood Chain (chain ID 4663)
   >
   > I'm submitting on behalf of the Ballast protocol team. The token was
   > launched through our factory contract
   > (`0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67`) with a Gnosis Safe
   > multisig (`0xEFC97e16a24d2434C7138a2634E554a0631aC079`) as the
   > registered creator — there's no single EOA deployer wallet to
   > automatically verify against, which is why I'm using this manual route
   > rather than the deployer-login path.
   >
   > Proof of relationship: [attach or link something that ties you personally
   > to the project — e.g. the ballasted.xyz domain's DNS/WHOIS, the project's
   > X account (x.com/ballastedapp) posting this same request, or a signed
   > message from the Safe itself via https://app.safe.global's message-signing
   > feature, which produces an EIP-1271-verifiable signature]
   >
   > Icon (48×48 PNG): attached — `docs/assets-brand/icon-dark-512.png`
   > (resize to 48×48 before attaching, or link it; the master asset is
   > 512×512).
   > Website: https://ballasted.xyz
   > X: https://x.com/ballastedapp
   > Description: A token launchpad on Robinhood Chain where projects can
   > hold a verifiable on-chain treasury of tokenized real-world assets,
   > with backing per token shown live.

4. Attach `docs/assets-brand/icon-48x48.png` (already generated this session,
   exact 48×48 PNG resize of the master 512×512 asset).
5. Optional: $99 USDC/USDT expedited review (guarantees a decision within 7
   days) — their docs don't say where to send it without opening a ticket
   first, so this is likely offered back to you in their reply, not something
   to prepay blind.

**Do this only after Section 1's manual Blockscout verification lands** —
their token-info review explicitly checks the contract is verified first for
some of these flows (confirmed on GeckoTerminal's own page, likely true here
too), and it's one less thing for them to reject you on.

## 2. GeckoTerminal

Form: **https://www.geckoterminal.com/update-token-info**

**Hard requirement confirmed from their own docs: "the token CONTRACT must
also be verified."** Wait for Section 1's Blockscout verification (manual
upload) to land before submitting this — a submission against an unverified
contract is likely to bounce.

Steps once verified:
1. Open the token's page on GeckoTerminal (search `0xDc605041F02e41CbD8FDC347023e93C4c3fA243C` under Robinhood Chain), or use the update-token-info link above directly.
2. Fill in: chain = Robinhood, contract address, name "Ballast", symbol "BALLAST", logo upload, website `https://ballasted.xyz`, X `https://x.com/ballastedapp`, description (same as above).
3. Verify by email (one-time password sent to whatever address you submit with).
4. Free tier: reviewed within a few days. Paid "Fast Pass" ($199): minutes-to-24h. Your call on which.

## 3. DexScreener

Two routes, both need your account/payment, not automatable:
- **Free-ish route**: DexScreener auto-pulls from token lists (CoinGecko etc.) once GeckoTerminal/CoinGecko have the info — so doing #2 first may populate this one for free, eventually.
- **Faster route**: `https://marketplace.dexscreener.com/product/token-info` — Enhanced Token Info product, paid, gives you a form for logo + socials + description directly. Sign in with the wallet that's relevant (their form will guide you).

## What I can't do from here

All three forms require either a payment, an email round-trip, or interactive
challenge/CAPTCHA completion — none are scriptable safely or reliably. Send
me anything they reply with (rejection reasons, additional proof requests)
and I'll adjust the submission.
