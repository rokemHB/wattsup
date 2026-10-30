#!/usr/bin/env python3
"""Compare two gpu-bench.sh result files as a markdown table: gpu-bench-table.py before.jsonl after.jsonl [render scale, default 1.5]"""
import json
import sys

def load(p):
    return {json.loads(l)["spot"]: json.loads(l) for l in open(p) if l.strip()}

a = load(sys.argv[1])
b = load(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
px = sys.argv[3] if len(sys.argv) > 3 else "1.5"
keys = ["total", "photo bandwidth", "tile ground", "route ground", "far+mid ground", "corridor", "sea", "vegetation", "roads", "parapets", "signs", "tunnels", "clouds", "sky background", "shadow pass", "rider", "empty frame"]
spots = [s for s in ["soller", "tunnel", "hairpins", "palma", "malaga"] if s in a]
print(f"render scale {px}, GPU ms per frame (before -> after)")
print("| part | " + " | ".join(spots) + " |")
print("|---|" + "---|" * len(spots))
for k in keys:
    cells = []
    for s in spots:
        va = a[s]["px"][px].get(k)
        vb = b.get(s, {}).get("px", {}).get(px, {}).get(k) if b else None
        cells.append(f"{va:.1f}" if vb is None else f"{va:.1f} → {vb:.1f}")
    print(f"| {k} | " + " | ".join(cells) + " |")
print("| draw calls | " + " | ".join(str(a[s]["calls"]) + (f" → {b[s]['calls']}" if s in b else "") for s in spots) + " |")
print("| triangles k | " + " | ".join(f"{a[s]['tris'] / 1000:.0f}" + (f" → {b[s]['tris'] / 1000:.0f}" if s in b else "") for s in spots) + " |")
print("| spread of 3 runs | " + " | ".join(f"{a[s]['px'][px]['spread']:.1f}" + (f" / {b[s]['px'][px]['spread']:.1f}" if s in b else "") for s in spots) + " |")
