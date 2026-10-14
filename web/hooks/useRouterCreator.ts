"use client";

import type { Address } from "viem";
import { useFeeRouter } from "@/hooks/useFeeRouter";

/**
 * Resolves whether a launch is managed by a FeeRouter (the router is its on-chain
 * `creator`) and, if so, the HUMAN behind it (`realCreator`). Creator-gated UI
 * must key on `effectiveCreator` — for a router launch the connected wallet is
 * never the on-chain creator (that's the router), so comparing against the raw
 * on-chain creator would hide every control from the real human. Writes must go
 * through the router's pass-throughs when `isRouterManaged`.
 *
 * Inert until NEXT_PUBLIC_FEE_ROUTER_FACTORY_ADDRESS is set: useFeeRouter then
 * finds no candidates and returns router=undefined, so `isRouterManaged` is false
 * and every caller falls back to the plain EOA-creator path unchanged.
 */
export function useRouterCreator(token?: Address, onChainCreator?: Address) {
  const { router, state, isLoading } = useFeeRouter(token);
  const isRouterManaged = Boolean(router);
  const realCreator = state?.realCreator;
  const effectiveCreator = isRouterManaged ? realCreator : onChainCreator;
  return { isRouterManaged, router, realCreator, effectiveCreator, isLoading };
}
