import os, hashlib, json

OUT = os.path.join(os.path.dirname(__file__), "manatee-svgs-ref")
os.makedirs(OUT, exist_ok=True)

SUPPLY = 1000
S = 1000

DARK   = "#050A06"
BONE   = "#F5F3EC"
GREEN  = "#22C93A"
MID    = "#2E6B33"
DIM    = "#3C4A3E"


def rng(token_id, salt):
    h = hashlib.sha256(f"ballast-manatee-{token_id}-{salt}".encode()).hexdigest()
    return int(h[:12], 16) / float(0xFFFFFFFFFFFF)


def lerp(a, b, t):
    return a + (b - a) * t


def water_at(t):
    top = (10, 26, 14)
    bot = (3, 6, 4)
    r = int(lerp(top[0], bot[0], t))
    g = int(lerp(top[1], bot[1], t))
    b = int(lerp(top[2], bot[2], t))
    return f"#{r:02x}{g:02x}{b:02x}"


def manatee(ox, oy, scale, stroke, sw, fill_op):
    def p(x, y):
        return f"{ox + (x-600)*scale:.1f} {oy + (y-516)*scale:.1f}"
    body = (
        f"M {p(392,516)} Q {p(390,454)} {p(448,440)} Q {p(560,414)} {p(668,444)} "
        f"Q {p(724,462)} {p(752,492)} Q {p(798,454)} {p(848,474)} "
        f"Q {p(886,516)} {p(848,558)} Q {p(798,578)} {p(752,540)} "
        f"Q {p(724,570)} {p(668,588)} Q {p(560,618)} {p(448,592)} "
        f"Q {p(390,578)} {p(392,516)} Z"
    )
    g = f'<path d="{body}" fill="{GREEN}" opacity="{fill_op:.3f}"/>'
    g += (f'<path d="{body}" fill="none" stroke="{stroke}" stroke-width="{sw:.2f}" '
          f'stroke-linejoin="round"/>')
    g += (f'<path d="M {p(400,534)} Q {p(424,550)} {p(454,542)}" fill="none" '
          f'stroke="{stroke}" stroke-width="{sw*0.66:.2f}" opacity="0.8"/>')
    for dy, ln in ((-6, 15), (4, 17), (14, 13)):
        g += (f'<path d="M {p(398, 528+dy)} L {p(398-ln, 523+dy)}" fill="none" '
              f'stroke="{stroke}" stroke-width="{sw*0.5:.2f}" opacity="0.6"/>')
    g += (f'<circle cx="{ox+(448-600)*scale:.1f}" cy="{oy+(492-516)*scale:.1f}" '
          f'r="{5.0*scale:.2f}" fill="{stroke}"/>')
    g += (f'<path d="M {p(488,584)} Q {p(480,628)} {p(518,636)} Q {p(542,626)} {p(538,590)}" '
          f'fill="none" stroke="{stroke}" stroke-width="{sw*0.85:.2f}" stroke-linejoin="round"/>')
    g += (f'<path d="M {p(592,590)} Q {p(586,632)} {p(624,640)} Q {p(648,630)} {p(644,596)}" '
          f'fill="none" stroke="{stroke}" stroke-width="{sw*0.85:.2f}" stroke-linejoin="round"/>')
    return g


def build(token_id):
    t = (token_id - 1) / (SUPPLY - 1)

    ground = water_at(t)
    b = f'<rect width="{S}" height="{S}" fill="{ground}"/>'

    WL = lerp(300, -260, t)
    if WL > -60:
        amp = lerp(9, 3, t)
        pts = []
        for i in range(11):
            x = i * (S / 10)
            y = WL + (amp if i % 2 else -amp)
            pts.append(f"{x:.0f} {y:.1f}")
        b += (f'<path d="M{" L".join(pts)}" fill="none" stroke="{BONE}" '
              f'stroke-width="1.6" opacity="{max(0.06, 0.42*(1-t)):.3f}"/>')
        b += (f'<line x1="0" y1="{WL:.1f}" x2="{S}" y2="{WL:.1f}" stroke="{BONE}" '
              f'stroke-width="1.1" opacity="{max(0.04, 0.26*(1-t)):.3f}"/>')

    shafts = 0
    if t < 0.55:
        shafts = 1 + int(rng(token_id, "shafts") * 3)
        for k in range(shafts):
            sx = 90 + rng(token_id, f"shaftx{k}") * (S - 180)
            w = 26 + rng(token_id, f"shaftw{k}") * 54
            op = (0.055 * (1 - t / 0.55)) * (0.6 + rng(token_id, f"shafto{k}") * 0.8)
            b += (f'<path d="M{sx:.0f} {WL:.0f} l{w:.0f} 0 l{w*2.4:.0f} {S} '
                  f'l{-w*1.6:.0f} 0 Z" fill="{BONE}" opacity="{op:.3f}"/>')

    particles = 6 + int(t * 26)
    for k in range(particles):
        px = rng(token_id, f"px{k}") * S
        py = rng(token_id, f"py{k}") * S
        r = 0.9 + rng(token_id, f"pr{k}") * 2.1
        op = 0.10 + rng(token_id, f"po{k}") * 0.22
        b += f'<circle cx="{px:.0f}" cy="{py:.0f}" r="{r:.1f}" fill="{BONE}" opacity="{op:.3f}"/>'

    bed = t > 0.68
    if bed:
        k = (t - 0.68) / 0.32
        by = lerp(S + 60, S - 130, k)
        pts = [(0, by)]
        for i in range(1, 9):
            x = i * (S / 8)
            y = by + (rng(token_id, f"bed{i}") - 0.5) * 34
            pts.append((x, y))
        pts.append((S, by))
        d = "M" + " L".join(f"{x:.0f} {y:.0f}" for x, y in pts) + f" L{S} {S} L0 {S} Z"
        b += f'<path d="{d}" fill="{DIM}" opacity="0.30"/>'
        d2 = "M" + " L".join(f"{x:.0f} {y:.0f}" for x, y in pts)
        b += f'<path d="{d2}" fill="none" stroke="{DIM}" stroke-width="2" opacity="0.5"/>'

    stroke_op = lerp(1.0, 0.72, t)
    stroke = BONE
    fill_op = lerp(0.16, 0.09, t)
    b += f'<g opacity="{stroke_op:.3f}">{manatee(500, 500, 0.62, stroke, 3.4, fill_op)}</g>'

    b += (f'<text x="44" y="{S-40}" fill="{BONE}" opacity="0.30" '
          f'font-family="Liberation Mono, monospace" font-size="19">'
          f'{token_id:04d} / {SUPPLY}</text>')

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
           f'viewBox="0 0 {S} {S}">{b}</svg>')

    traits = {
        "depth_band": min(10, 1 + int(t * 10)),
        "light_shafts": shafts,
        "particles": particles,
        "seabed": bed,
    }
    return svg, traits


if __name__ == "__main__":
    sample = [1, 2, 60, 180, 340, 500, 680, 840, 950, 1000]
    manifest = []
    for i in sample:
        svg, tr = build(i)
        with open(f"{OUT}/{i:04d}.svg", "w", newline="") as f:
            f.write(svg)
        manifest.append({"id": i, **tr, "bytes": len(svg)})
        print(f"{i:4d}  band {tr['depth_band']:2d}  shafts {tr['light_shafts']}  "
              f"particles {tr['particles']:2d}  seabed {tr['seabed']}  {len(svg)}B")
    with open(f"{OUT}/manifest-sample.json", "w") as f:
        json.dump(manifest, f, indent=2)
    sizes = [m["bytes"] for m in manifest]
    print(f"\nSVG size: min {min(sizes)}B  max {max(sizes)}B  avg {sum(sizes)//len(sizes)}B")
