import { RaetoError } from "@/lib/ai/raeto";

// Shared mapping of an AI failure to an HTTP status + a single, user-neutral body.
// The UI shows the SAME "AI helper is unavailable right now" state for all of these
// — the Create flow keeps working exactly as before regardless.

export function unavailableBody() {
  return { error: "AI helper is unavailable right now.", code: "unavailable" as const };
}

export function errorStatus(err: unknown): number {
  if (err instanceof RaetoError) {
    switch (err.kind) {
      case "not_configured":
        return 503;
      case "models_misconfigured":
        return 503;
      case "payment":
        return 402;
      case "rate_limited":
        return 429;
      case "auth":
        return 503; // our key problem, not the caller's
      case "timeout":
      case "upstream":
      default:
        return 502;
    }
  }
  return 502;
}
