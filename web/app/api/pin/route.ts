import { NextRequest, NextResponse } from "next/server";

// Server-side Pinata pinning. The JWT lives ONLY here (process.env.PINATA_JWT,
// no NEXT_PUBLIC_ prefix), so it never reaches the browser. Accepts either a
// multipart file (the resized logo) or a JSON body (the metadata blob), and
// returns the resulting CID. Node runtime so FormData/streams behave.
export const runtime = "nodejs";

const MAX_BYTES = 1_200_000; // small margin over the 512x512 PNG the client sends

// Sniff a raster-image magic number. This is the REAL upload gate: the client's
// content-type check is trivially bypassed by POSTing here directly, so we verify
// the actual bytes and refuse anything that isn't PNG/JPEG/WebP. SVG (an XML/text
// document that can carry scripts) has no raster signature and is rejected here.
function sniffImage(b: Uint8Array): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  // WebP: "RIFF"...."WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

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
      // Validate by magic bytes, not the client-supplied content-type. Reject
      // anything that isn't a real PNG/JPEG/WebP (SVG, HTML, scripts, …).
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = sniffImage(bytes);
      if (!mime) {
        return NextResponse.json(
          { error: "Only PNG, JPEG, or WebP images can be pinned." },
          { status: 415 },
        );
      }
      const out = new FormData();
      // Forward the validated bytes with the sniffed type and a fixed, safe
      // filename — never echo the client's original name/extension.
      out.append("file", new Blob([bytes], { type: mime }), "logo");
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
