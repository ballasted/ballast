import { hasConfigError, missingContracts } from "@/lib/contracts";

// Startup guard. If a core contract address is missing or zero, say so plainly at
// the top of the app rather than letting a transaction fail with a confusing
// provider error deep in a flow. Renders server-side (no wallet needed) — a
// misconfigured deploy is visible before anyone connects.
export function ConfigGuard() {
  if (!hasConfigError) return null;

  return (
    <div className="border-b border-negative/40 bg-negative/10">
      <div className="mx-auto max-w-content px-5 py-3 text-sm">
        <span className="font-semibold text-negative">Configuration error.</span>{" "}
        <span className="text-text-secondary">
          These required addresses are unset, so launches and trades are disabled:{" "}
        </span>
        <span className="text-text-primary">{missingContracts.join(", ")}</span>
        <span className="text-text-secondary">
          . Set them after deploying the core contracts.
        </span>
      </div>
    </div>
  );
}
