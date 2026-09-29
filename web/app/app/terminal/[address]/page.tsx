import { redirect } from "next/navigation";

// The per-token terminal was removed alongside the Terminal nav entry (its
// dedicated panel components were dead code once unreachable from nav). The
// token page (/app/token/[address]) is the surviving equivalent — redirect
// old deep links there instead of 404ing.
export default async function TerminalTokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  redirect(`/app/token/${address}`);
}
