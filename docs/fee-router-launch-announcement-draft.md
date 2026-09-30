# Announcement draft — Fee Router live

Post once `FeeRouterFactory` is deployed, verified, and a real launch has
gone through the Fees section at least once (don't announce before it's been
used for real). Fill in the real contract address before posting.

---

> Every Ballast launch now lets the creator choose where trading fees go.
>
> Split it across four places: your own wallet, the project treasury
> (locked forever, never withdrawable), buyback and burn, or paid out to
> anyone staking the token. Change the split anytime — it takes effect
> 7 days later, always, no exceptions.
>
> No new token, no admin key. The only thing anyone can do is what the
> creator already set, on a public timer.
>
> Launch: https://ballasted.fun/app/create
> Contract: [FEE_ROUTER_FACTORY_ADDRESS] (verified, no owner)

---

Notes for whoever posts this:
- Don't say "yield," "APR," "dividend," or "passive income" — staking
  rewards here are just "rewards paid to stakers," sized by whatever the
  creator actually routes, never promised (CLAUDE.md copy rules).
- Don't imply the treasury bucket is live yet if it's still shipped
  disabled in the UI (check `docs/FEE_ROUTER_DESIGN.md` §3 / the create
  flow before posting — v1 may ship with buyback + rewards only).
- Confirm the FeeRouterFactory address matches what's actually deployed
  and verified — don't post the provisional nonce-0 prediction from before
  the broadcast.
