import { NextResponse } from "next/server";
import { AI_HELPER_ENABLED, MIN_AVAILABLE_USD } from "@/lib/ai/config";
import { getRaetoAccount } from "@/lib/ai/raeto";

// Lightweight availability probe for the client: should the AI entry points render?
// The NEXT_PUBLIC flag already gates base enablement in the browser; this adds the
// server-only balance check (GET /v1/me) so we hide the button when the key is out
// of funds. Never returns the key, the balance, or any account identity — only a
// boolean. Short edge cache so we don't hit /v1/me on every page load.
export const runtime = "nodejs";
export const revalidate = 60;

export async function GET() {
  if (!AI_HELPER_ENABLED) {
    return NextResponse.json(
      { enabled: false, available: false },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  }
  try {
    const { availableUsd } = await getRaetoAccount();
    const available = availableUsd >= MIN_AVAILABLE_USD;
    return NextResponse.json(
      { enabled: true, available },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch {
    // Any failure → hide the button. The Create flow is unaffected either way.
    return NextResponse.json(
      { enabled: true, available: false },
      { headers: { "cache-control": "public, max-age=30" } },
    );
  }
}
