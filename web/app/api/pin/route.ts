import { NextRequest, NextResponse } from "next/server";

// Server-side Pinata pinning. The JWT lives ONLY here (process.env.PINATA_JWT,
// no NEXT_PUBLIC_ prefix), so it never reaches the browser. Accepts either a
// multipart file (the resized logo) or a JSON body (the metadata blob), and
// returns the resulting CID. Node runtime so FormData/streams behave.
export const runtime = "nodejs";

const MAX_BYTES = 1_200_000; // small margin over the 512x512 PNG the client sends

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json(
      { error: "Pinning isn't configured. Set PINATA_JWT on the server." },
      { status: 503 },
    );
  }

  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ pinataContent: body }),
      });
      return relay(res);
    }

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      if (file.size > MAX_BYTES) {
        return NextResponse.json({ error: "File too large" }, { status: 413 });
      }
      const out = new FormData();
      out.append("file", file, (file as File).name || "logo.png");
      const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
        body: out,
      });
      return relay(res);
    }

    return NextResponse.json({ error: "Unsupported content type" }, { status: 415 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Pin failed" },
      { status: 502 },
    );
  }
}

async function relay(res: Response): Promise<NextResponse> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json({ error: `Pinata error: ${res.status} ${detail.slice(0, 200)}` }, { status: 502 });
  }
  const data = (await res.json()) as { IpfsHash?: string };
  if (!data.IpfsHash) return NextResponse.json({ error: "No CID returned" }, { status: 502 });
  return NextResponse.json({ cid: data.IpfsHash });
}
