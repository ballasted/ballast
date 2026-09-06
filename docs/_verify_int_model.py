"""
Feasibility test: reproduce manatee_gen.py output using ONLY exact-rational /
integer arithmetic (what Solidity would do — no IEEE-754 doubles), then diff
against the float reference for ALL 1000 ids.

If build_int(id) == build_float(id) byte-for-byte for every id, a Solidity port
using the same integer scheme is provably byte-exact.
"""
import hashlib
from fractions import Fraction as F

SUPPLY = 1000
S = 1000
BONE  = "#F5F3EC"
GREEN = "#22C93A"
DIM   = "#3C4A3E"
DEN   = 0xFFFFFFFFFFFF  # 2**48 - 1

# ----- float reference (verbatim from spec) -----------------------------------
def rng_f(tid, salt):
    h = hashlib.sha256(f"ballast-manatee-{tid}-{salt}".encode()).hexdigest()
    return int(h[:12], 16) / float(DEN)
def lerp_f(a, b, t): return a + (b - a) * t
def water_f(t):
    top=(10,26,14); bot=(3,6,4)
    r=int(lerp_f(top[0],bot[0],t)); g=int(lerp_f(top[1],bot[1],t)); b=int(lerp_f(top[2],bot[2],t))
    return f"#{r:02x}{g:02x}{b:02x}"
def manatee_f(ox,oy,scale,stroke,sw,fill_op):
    def p(x,y): return f"{ox+(x-600)*scale:.1f} {oy+(y-516)*scale:.1f}"
    body=(f"M {p(392,516)} Q {p(390,454)} {p(448,440)} Q {p(560,414)} {p(668,444)} "
          f"Q {p(724,462)} {p(752,492)} Q {p(798,454)} {p(848,474)} "
          f"Q {p(886,516)} {p(848,558)} Q {p(798,578)} {p(752,540)} "
          f"Q {p(724,570)} {p(668,588)} Q {p(560,618)} {p(448,592)} "
          f"Q {p(390,578)} {p(392,516)} Z")
    g=f'<path d="{body}" fill="{GREEN}" opacity="{fill_op:.3f}"/>'
    g+=(f'<path d="{body}" fill="none" stroke="{stroke}" stroke-width="{sw:.2f}" stroke-linejoin="round"/>')
    g+=(f'<path d="M {p(400,534)} Q {p(424,550)} {p(454,542)}" fill="none" stroke="{stroke}" stroke-width="{sw*0.66:.2f}" opacity="0.8"/>')
    for dy,ln in ((-6,15),(4,17),(14,13)):
        g+=(f'<path d="M {p(398,528+dy)} L {p(398-ln,523+dy)}" fill="none" stroke="{stroke}" stroke-width="{sw*0.5:.2f}" opacity="0.6"/>')
    g+=(f'<circle cx="{ox+(448-600)*scale:.1f}" cy="{oy+(492-516)*scale:.1f}" r="{5.0*scale:.2f}" fill="{stroke}"/>')
    g+=(f'<path d="M {p(488,584)} Q {p(480,628)} {p(518,636)} Q {p(542,626)} {p(538,590)}" fill="none" stroke="{stroke}" stroke-width="{sw*0.85:.2f}" stroke-linejoin="round"/>')
    g+=(f'<path d="M {p(592,590)} Q {p(586,632)} {p(624,640)} Q {p(648,630)} {p(644,596)}" fill="none" stroke="{stroke}" stroke-width="{sw*0.85:.2f}" stroke-linejoin="round"/>')
    return g
def build_float(tid):
    t=(tid-1)/(SUPPLY-1)
    b=f'<rect width="{S}" height="{S}" fill="{water_f(t)}"/>'
    WL=lerp_f(300,-260,t)
    if WL>-60:
        amp=lerp_f(9,3,t); pts=[]
        for i in range(11):
            x=i*(S/10); y=WL+(amp if i%2 else -amp); pts.append(f"{x:.0f} {y:.1f}")
        b+=(f'<path d="M{" L".join(pts)}" fill="none" stroke="{BONE}" stroke-width="1.6" opacity="{max(0.06,0.42*(1-t)):.3f}"/>')
        b+=(f'<line x1="0" y1="{WL:.1f}" x2="{S}" y2="{WL:.1f}" stroke="{BONE}" stroke-width="1.1" opacity="{max(0.04,0.26*(1-t)):.3f}"/>')
    shafts=0
    if t<0.55:
        shafts=1+int(rng_f(tid,"shafts")*3)
        for k in range(shafts):
            sx=90+rng_f(tid,f"shaftx{k}")*(S-180); w=26+rng_f(tid,f"shaftw{k}")*54
            op=(0.055*(1-t/0.55))*(0.6+rng_f(tid,f"shafto{k}")*0.8)
            b+=(f'<path d="M{sx:.0f} {WL:.0f} l{w:.0f} 0 l{w*2.4:.0f} {S} l{-w*1.6:.0f} 0 Z" fill="{BONE}" opacity="{op:.3f}"/>')
    particles=6+int(t*26)
    for k in range(particles):
        px=rng_f(tid,f"px{k}")*S; py=rng_f(tid,f"py{k}")*S
        r=0.9+rng_f(tid,f"pr{k}")*2.1; op=0.10+rng_f(tid,f"po{k}")*0.22
        b+=f'<circle cx="{px:.0f}" cy="{py:.0f}" r="{r:.1f}" fill="{BONE}" opacity="{op:.3f}"/>'
    bed=t>0.68
    if bed:
        k=(t-0.68)/0.32; by=lerp_f(S+60,S-130,k); pts=[(0,by)]
        for i in range(1,9):
            x=i*(S/8); y=by+(rng_f(tid,f"bed{i}")-0.5)*34; pts.append((x,y))
        pts.append((S,by))
        d="M"+" L".join(f"{x:.0f} {y:.0f}" for x,y in pts)+f" L{S} {S} L0 {S} Z"
        b+=f'<path d="{d}" fill="{DIM}" opacity="0.30"/>'
        d2="M"+" L".join(f"{x:.0f} {y:.0f}" for x,y in pts)
        b+=f'<path d="{d2}" fill="none" stroke="{DIM}" stroke-width="2" opacity="0.5"/>'
    stroke_op=lerp_f(1.0,0.72,t); fill_op=lerp_f(0.16,0.09,t)
    b+=f'<g opacity="{stroke_op:.3f}">{manatee_f(500,500,0.62,BONE,3.4,fill_op)}</g>'
    b+=(f'<text x="44" y="{S-40}" fill="{BONE}" opacity="0.30" font-family="Liberation Mono, monospace" font-size="19">{tid:04d} / {SUPPLY}</text>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">{b}</svg>'

# ----- exact-rational / integer model (Solidity-equivalent) -------------------
def rng_x(tid, salt):
    h = hashlib.sha256(f"ballast-manatee-{tid}-{salt}".encode()).hexdigest()
    return F(int(h[:12], 16), DEN)          # exact rational, no double
def fmt(v, nd):
    """format Fraction v to nd decimals, round-half-even, Python-style incl. -0."""
    v = F(v)
    neg = v < 0
    m = -v if neg else v
    scaled = m * (10**nd)
    fl = scaled.numerator // scaled.denominator
    rem = scaled - fl
    if rem < F(1,2):      r = fl
    elif rem > F(1,2):    r = fl + 1
    else:                 r = fl if fl % 2 == 0 else fl + 1
    if nd == 0:
        body = str(r)
    else:
        s = str(r).rjust(nd+1, "0")
        body = s[:-nd] + "." + s[-nd:]
    if neg and any(c in "123456789" for c in body):
        return "-" + body
    if neg:  # rounded to zero but value was negative -> Python prints -0
        return "-" + body
    return body
def itrunc(v):  # int() toward zero; our uses are all >= 0
    v = F(v); q = v.numerator // v.denominator
    return q  # v>=0 so floor == trunc
def water_x(t):
    r=itrunc(F(10)+(F(3)-F(10))*t); g=itrunc(F(26)+(F(6)-F(26))*t); b=itrunc(F(14)+(F(4)-F(14))*t)
    return f"#{r:02x}{g:02x}{b:02x}"
def px_(ox,x,scale): return F(ox)+(F(x)-600)*scale
def manatee_x(ox,oy,scale,stroke,sw,fill_op):
    def p(x,y): return f"{fmt(F(ox)+(F(x)-600)*scale,1)} {fmt(F(oy)+(F(y)-516)*scale,1)}"
    body=(f"M {p(392,516)} Q {p(390,454)} {p(448,440)} Q {p(560,414)} {p(668,444)} "
          f"Q {p(724,462)} {p(752,492)} Q {p(798,454)} {p(848,474)} "
          f"Q {p(886,516)} {p(848,558)} Q {p(798,578)} {p(752,540)} "
          f"Q {p(724,570)} {p(668,588)} Q {p(560,618)} {p(448,592)} "
          f"Q {p(390,578)} {p(392,516)} Z")
    g=f'<path d="{body}" fill="{GREEN}" opacity="{fmt(fill_op,3)}"/>'
    g+=(f'<path d="{body}" fill="none" stroke="{stroke}" stroke-width="{fmt(sw,2)}" stroke-linejoin="round"/>')
    g+=(f'<path d="M {p(400,534)} Q {p(424,550)} {p(454,542)}" fill="none" stroke="{stroke}" stroke-width="{fmt(sw*F(66,100),2)}" opacity="0.8"/>')
    for dy,ln in ((-6,15),(4,17),(14,13)):
        g+=(f'<path d="M {p(398,528+dy)} L {p(398-ln,523+dy)}" fill="none" stroke="{stroke}" stroke-width="{fmt(sw*F(5,10),2)}" opacity="0.6"/>')
    g+=(f'<circle cx="{fmt(F(ox)+(F(448)-600)*scale,1)}" cy="{fmt(F(oy)+(F(492)-516)*scale,1)}" r="{fmt(F(5)*scale,2)}" fill="{stroke}"/>')
    g+=(f'<path d="M {p(488,584)} Q {p(480,628)} {p(518,636)} Q {p(542,626)} {p(538,590)}" fill="none" stroke="{stroke}" stroke-width="{fmt(sw*F(85,100),2)}" stroke-linejoin="round"/>')
    g+=(f'<path d="M {p(592,590)} Q {p(586,632)} {p(624,640)} Q {p(648,630)} {p(644,596)}" fill="none" stroke="{stroke}" stroke-width="{fmt(sw*F(85,100),2)}" stroke-linejoin="round"/>')
    return g
def build_int(tid):
    t=F(tid-1, SUPPLY-1)
    b=f'<rect width="{S}" height="{S}" fill="{water_x(t)}"/>'
    WL=F(300)+(F(-260)-300)*t
    if WL>-60:
        amp=F(9)+(F(3)-9)*t; pts=[]
        for i in range(11):
            x=F(i)*(F(S)/10); y=WL+(amp if i%2 else -amp); pts.append(f"{fmt(x,0)} {fmt(y,1)}")
        o1=F(42,100)*(1-t);  o1=o1 if o1>F(6,100) else F(6,100)
        o2=F(26,100)*(1-t);  o2=o2 if o2>F(4,100) else F(4,100)
        b+=(f'<path d="M{" L".join(pts)}" fill="none" stroke="{BONE}" stroke-width="1.6" opacity="{fmt(o1,3)}"/>')
        b+=(f'<line x1="0" y1="{fmt(WL,1)}" x2="{S}" y2="{fmt(WL,1)}" stroke="{BONE}" stroke-width="1.1" opacity="{fmt(o2,3)}"/>')
    shafts=0
    if t<F(55,100):
        shafts=1+itrunc(rng_x(tid,"shafts")*3)
        for k in range(shafts):
            sx=F(90)+rng_x(tid,f"shaftx{k}")*(S-180); w=F(26)+rng_x(tid,f"shaftw{k}")*54
            op=(F(55,1000)*(1-t/F(55,100)))*(F(6,10)+rng_x(tid,f"shafto{k}")*F(8,10))
            b+=(f'<path d="M{fmt(sx,0)} {fmt(WL,0)} l{fmt(w,0)} 0 l{fmt(w*F(24,10),0)} {S} l{fmt(-w*F(16,10),0)} 0 Z" fill="{BONE}" opacity="{fmt(op,3)}"/>')
    particles=6+itrunc(t*26)
    for k in range(particles):
        pxv=rng_x(tid,f"px{k}")*S; pyv=rng_x(tid,f"py{k}")*S
        r=F(9,10)+rng_x(tid,f"pr{k}")*F(21,10); op=F(10,100)+rng_x(tid,f"po{k}")*F(22,100)
        b+=f'<circle cx="{fmt(pxv,0)}" cy="{fmt(pyv,0)}" r="{fmt(r,1)}" fill="{BONE}" opacity="{fmt(op,3)}"/>'
    bed=t>F(68,100)
    if bed:
        k=(t-F(68,100))/F(32,100); by=F(S+60)+(F(S-130)-(S+60))*k; pts=[(F(0),by)]
        for i in range(1,9):
            x=F(i)*(F(S)/8); y=by+(rng_x(tid,f"bed{i}")-F(1,2))*34; pts.append((x,y))
        pts.append((F(S),by))
        d="M"+" L".join(f"{fmt(x,0)} {fmt(y,0)}" for x,y in pts)+f" L{S} {S} L0 {S} Z"
        b+=f'<path d="{d}" fill="{DIM}" opacity="0.30"/>'
        d2="M"+" L".join(f"{fmt(x,0)} {fmt(y,0)}" for x,y in pts)
        b+=f'<path d="{d2}" fill="none" stroke="{DIM}" stroke-width="2" opacity="0.5"/>'
    stroke_op=F(1)+(F(72,100)-1)*t; fill_op=F(16,100)+(F(9,100)-F(16,100))*t
    b+=f'<g opacity="{fmt(stroke_op,3)}">{manatee_x(500,500,F(62,100),BONE,F(34,10),fill_op)}</g>'
    b+=(f'<text x="44" y="{S-40}" fill="{BONE}" opacity="0.30" font-family="Liberation Mono, monospace" font-size="19">{tid:04d} / {SUPPLY}</text>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">{b}</svg>'

if __name__ == "__main__":
    mismatches = []
    for tid in range(1, SUPPLY+1):
        a = build_float(tid); c = build_int(tid)
        if a != c:
            # find first differing offset
            j = next((i for i in range(min(len(a),len(c))) if a[i]!=c[i]), min(len(a),len(c)))
            mismatches.append((tid, j, a[max(0,j-30):j+30], c[max(0,j-30):j+30]))
    print(f"checked {SUPPLY} ids; mismatches: {len(mismatches)}")
    for tid,j,fa,fc in mismatches[:20]:
        print(f"\n id {tid} @ offset {j}")
        print(f"   float: ...{fa}...")
        print(f"   int  : ...{fc}...")
