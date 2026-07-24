"use client";

import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";

// First-connect terms gate (spec 1.2). Blocks wallet use until the address accepts
// Terms + Privacy and confirms it isn't in a restricted jurisdiction. Acceptance is
// stored per address, so it's asked once per wallet. Given the product's legal
// position (disclosure, no claim on treasury), this is a hard gate — decline
// disconnects. The jurisdiction line is where the legal-review answer slots in.
const key = (a: string) => `ballast:terms:${a.toLowerCase()}`;

export function TermsGate() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [needsAccept, setNeedsAccept] = useState(false);
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) {
      setNeedsAccept(false);
      return;
    }
    try {
      setNeedsAccept(localStorage.getItem(key(address)) !== "1");
    } catch {
      setNeedsAccept(false);
    }
    setTerms(false);
    setPrivacy(false);
  }, [isConnected, address]);

  if (!needsAccept || !address) return null;

  const accept = () => {
    try {
      localStorage.setItem(key(address), "1");
    } catch {
      /* private mode — accept for this session only */
    }
    setNeedsAccept(false);
  };
  const decline = () => {
    setNeedsAccept(false);
    disconnect();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="card w-full max-w-md p-5">
        <h2 className="font-serif text-lg font-semibold text-bone">Before you continue</h2>
        <p className="mt-1 text-sm text-text-muted">Accept the terms to use BALLAST with this wallet.</p>

        <div className="mt-4 space-y-3 text-sm">
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 accent-green" />
            <span className="text-text-secondary">
              I have read and accept the{" "}
              <a href="/terms" target="_blank" rel="noreferrer" className="text-green underline underline-offset-2">Terms of Use</a>.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} className="mt-0.5 accent-green" />
            <span className="text-text-secondary">
              I have read and accept the{" "}
              <a href="/privacy" target="_blank" rel="noreferrer" className="text-green underline underline-offset-2">Privacy Policy</a>.
            </span>
          </label>
          <p className="text-xs text-text-faint">
            I confirm I am not a resident of, or accessing from, a restricted jurisdiction, and I understand that holding
            a token gives no claim, redemption right, or entitlement to any project treasury.
          </p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button className="btn-secondary" onClick={decline}>Disconnect wallet</button>
          <button className="btn-primary disabled:opacity-40" disabled={!terms || !privacy} onClick={accept}>
            Accept and continue
          </button>
        </div>
      </div>
    </div>
  );
}
