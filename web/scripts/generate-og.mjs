// One-off generator for the root /public/og.png + og@2x.png link-preview cards.
// No design asset was supplied for this (task said "attached ballast_og.png" but
// nothing came through this session) — this renders the same palette/layout
// language as the per-token opengraph-image.tsx via next/og's ImageResponse,
// then writes real PNG bytes to disk so it can be served as a static file and
// curl-verified like any other asset.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ImageResponse } = require("next/og");

const C = {
  bg: "#050A06",
  green: "#22C93A",
  greenDeep: "#0F2A14",
  bone: "#F5F3EC",
  boneMuted: "rgba(245,243,236,0.35)",
  faint: "rgba(245,243,236,0.18)",
  border: "rgba(34,201,58,0.16)",
};

function card(scale) {
  const w = 1200 * scale;
  const h = 630 * scale;
  return new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element
      {
        type: "div",
        props: {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            backgroundColor: C.bg,
            padding: 64 * scale,
            fontFamily: "sans-serif",
          },
          children: [
            {
              type: "div",
              props: {
                style: { display: "flex", alignItems: "center", gap: 16 * scale },
                children: [
                  {
                    type: "svg",
                    props: {
                      width: 44 * scale,
                      height: 44 * scale,
                      viewBox: "0 0 24 24",
                      fill: "none",
                      children: [
                        {
                          type: "path",
                          props: { d: "M3 7h18", stroke: C.green, strokeWidth: 2, strokeLinecap: "round" },
                        },
                        {
                          type: "path",
                          props: {
                            d: "M12 7v6m0 0l-4 4h8l-4-4z",
                            stroke: C.green,
                            strokeWidth: 2,
                            strokeLinejoin: "round",
                            strokeLinecap: "round",
                          },
                        },
                      ],
                    },
                  },
                  {
                    type: "span",
                    props: {
                      style: { fontSize: 34 * scale, fontWeight: 600, letterSpacing: 6, color: C.bone },
                      children: "BALLAST",
                    },
                  },
                ],
              },
            },
            {
              type: "div",
              props: {
                style: { display: "flex", flexDirection: "column" },
                children: [
                  {
                    type: "span",
                    props: {
                      style: { fontSize: 76 * scale, fontWeight: 700, letterSpacing: -2, color: C.bone, lineHeight: 1.1 },
                      children: "Launch against real stocks",
                    },
                  },
                  {
                    type: "span",
                    props: {
                      style: { fontSize: 32 * scale, color: C.boneMuted, marginTop: 20 * scale, maxWidth: 980 * scale },
                      children: "Token launchpad on Robinhood Chain. Stock pairs, stock treasury, opens at 1 ETH.",
                    },
                  },
                ],
              },
            },
            {
              type: "div",
              props: {
                style: { display: "flex", flexDirection: "column" },
                children: [
                  { type: "div", props: { style: { display: "flex", height: 2, backgroundColor: C.border, marginBottom: 28 * scale } } },
                  {
                    type: "div",
                    props: {
                      style: { display: "flex", alignItems: "center", justifyContent: "space-between" },
                      children: [
                        {
                          type: "div",
                          props: {
                            style: {
                              display: "flex",
                              fontSize: 22 * scale,
                              fontWeight: 600,
                              letterSpacing: 2,
                              padding: `${10 * scale}px ${20 * scale}px`,
                              borderRadius: 999,
                              backgroundColor: C.greenDeep,
                              color: C.green,
                            },
                            children: "BACKING PER TOKEN, LIVE",
                          },
                        },
                        {
                          type: "span",
                          props: { style: { display: "flex", fontSize: 26 * scale, color: C.faint, letterSpacing: 1 }, children: "ballasted.fun" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      }
    ),
    { width: w, height: h },
  );
}

const out1x = card(1);
const out2x = card(2);

const buf1x = Buffer.from(await out1x.arrayBuffer());
const buf2x = Buffer.from(await out2x.arrayBuffer());

const publicDir = join(__dirname, "..", "public");
await writeFile(join(publicDir, "og.png"), buf1x);
await writeFile(join(publicDir, "og@2x.png"), buf2x);
console.log("wrote", buf1x.length, "bytes to public/og.png");
console.log("wrote", buf2x.length, "bytes to public/og@2x.png");
