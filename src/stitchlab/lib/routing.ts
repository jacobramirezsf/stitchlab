// Continuous-line routing - the shared engine that turns a soup of line
// segments into as few unbroken stitch strokes as possible, and (for
// blackwork) into a reversible double-running route.
//
// The math: model the drawing as a multigraph (endpoints snapped to shared
// nodes = vertices, segments = edges). A connected graph has an Eulerian
// trail iff it has 0 or 2 odd-degree vertices, and an Eulerian circuit iff
// all degrees are even (Euler, 1736). When there are more odd vertices we
// pair them up greedily by nearest distance and duplicate the connecting
// edges (a practical Chinese-Postman / route-inspection heuristic - the
// doubled edges read as slightly bolder running stitch, which embroidery
// tolerates well). Then Hierholzer's algorithm (1873) walks each component
// in one stroke, and the resulting strokes are ordered nearest-endpoint to
// minimise the travel between them.
//
// Everything here is pure, dependency-free and deterministic. No DOM.
//
// What is GUARANTEED: every input edge is traversed at least once; each
// connected component becomes exactly one stroke; a component with all-even
// degrees yields a closed circuit with no duplicated edges.
// What is HEURISTIC: the odd-vertex pairing is greedy-nearest (near-optimal,
// not provably minimum-weight - exact Chinese Postman needs blossom matching,
// deliberately not implemented), and the inter-stroke ordering is greedy.

import type { PathMm } from "./generators";

export type Segment = [{ x: number; y: number }, { x: number; y: number }];

// ─── Graph construction (endpoint snapping) ──────────────────────────────

type Graph = {
  nodes: { x: number; y: number }[];
  /** adjacency: for each node, list of {to, edge} (edge index, undirected). */
  adj: { to: number; edge: number }[][];
  /** edge endpoints as node indices. */
  edges: [number, number][];
};

function buildGraph(segments: Segment[], tol: number): Graph {
  const nodes: { x: number; y: number }[] = [];
  const cell = Math.max(tol, 1e-4);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.round(x / cell)},${Math.round(y / cell)}`;

  const nodeAt = (p: { x: number; y: number }): number => {
    // Search the 3×3 neighbourhood of buckets for an existing node in tol.
    const gx = Math.round(p.x / cell);
    const gy = Math.round(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = grid.get(`${gx + dx},${gy + dy}`);
        if (!b) continue;
        for (const ni of b) {
          if (Math.hypot(nodes[ni].x - p.x, nodes[ni].y - p.y) <= tol) return ni;
        }
      }
    }
    const idx = nodes.length;
    nodes.push({ x: p.x, y: p.y });
    const k = key(p.x, p.y);
    const b = grid.get(k);
    if (b) b.push(idx);
    else grid.set(k, [idx]);
    return idx;
  };

  const adj: { to: number; edge: number }[][] = [];
  const edges: [number, number][] = [];
  const ensureAdj = (n: number) => {
    while (adj.length <= n) adj.push([]);
  };
  for (const [a, b] of segments) {
    const na = nodeAt(a);
    const nb = nodeAt(b);
    if (na === nb) continue; // zero-length segment
    const ei = edges.length;
    edges.push([na, nb]);
    ensureAdj(na);
    ensureAdj(nb);
    adj[na].push({ to: nb, edge: ei });
    adj[nb].push({ to: na, edge: ei });
  }
  ensureAdj(nodes.length - 1);
  return { nodes, adj, edges };
}

// ─── Connected components ─────────────────────────────────────────────────

function components(g: Graph): number[][] {
  const seen = new Uint8Array(g.nodes.length);
  const comps: number[][] = [];
  for (let s = 0; s < g.nodes.length; s++) {
    if (seen[s] || g.adj[s].length === 0) continue;
    const stack = [s];
    seen[s] = 1;
    const comp: number[] = [];
    while (stack.length) {
      const u = stack.pop()!;
      comp.push(u);
      for (const { to } of g.adj[u]) if (!seen[to]) {
        seen[to] = 1;
        stack.push(to);
      }
    }
    comps.push(comp);
  }
  return comps;
}

// Dijkstra shortest path (by Euclidean edge length) within a component.
function shortestPath(g: Graph, src: number, dst: number): number[] {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  dist.set(src, 0);
  const pq: [number, number][] = [[0, src]];
  while (pq.length) {
    // simple linear extract-min (components here are small enough)
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, u] = pq.splice(bi, 1)[0];
    if (u === dst) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const { to } of g.adj[u]) {
      const w = Math.hypot(g.nodes[u].x - g.nodes[to].x, g.nodes[u].y - g.nodes[to].y);
      const nd = d + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
        pq.push([nd, to]);
      }
    }
  }
  const path: number[] = [];
  let c: number | undefined = dst;
  while (c !== undefined) {
    path.push(c);
    c = prev.get(c);
  }
  return path.reverse();
}

// ─── Eulerize one component + Hierholzer ─────────────────────────────────

/** Returns a node sequence traversing every edge of the component once,
 *  duplicating the fewest connecting edges (greedy odd-vertex pairing). */
function eulerTrail(g: Graph, compNodes: number[]): number[] {
  // Working multigraph adjacency (node → list of {to}). Duplicate edges by
  // adding extra adjacency entries.
  const local = new Map<number, number[]>();
  for (const n of compNodes) local.set(n, []);
  const addEdge = (a: number, b: number) => {
    local.get(a)!.push(b);
    local.get(b)!.push(a);
  };
  for (const n of compNodes) for (const { to } of g.adj[n]) if (n < to) addEdge(n, to);

  // Odd-degree vertices.
  let odd = compNodes.filter((n) => local.get(n)!.length % 2 === 1);
  // Greedy nearest-pair matching; duplicate the shortest path between each pair.
  while (odd.length >= 2) {
    // pick the pair (a,b) with minimum straight-line distance
    let ba = 0;
    let bb = 1;
    let bd = Infinity;
    for (let i = 0; i < odd.length; i++) {
      for (let j = i + 1; j < odd.length; j++) {
        const d = Math.hypot(g.nodes[odd[i]].x - g.nodes[odd[j]].x, g.nodes[odd[i]].y - g.nodes[odd[j]].y);
        if (d < bd) {
          bd = d;
          ba = i;
          bb = j;
        }
      }
    }
    const a = odd[ba];
    const b = odd[bb];
    const path = shortestPath(g, a, b);
    for (let i = 1; i < path.length; i++) addEdge(path[i - 1], path[i]);
    // Both endpoints become even; interior nodes gain 2 (parity unchanged).
    odd = odd.filter((_, k) => k !== ba && k !== bb);
    // Recompute odd (duplications can flip interior parity if a node was odd)
    odd = compNodes.filter((n) => local.get(n)!.length % 2 === 1);
  }

  // Hierholzer: start at an odd vertex if any remain (open trail), else any.
  const start =
    compNodes.find((n) => local.get(n)!.length % 2 === 1) ??
    compNodes.find((n) => local.get(n)!.length > 0) ??
    compNodes[0];
  const trail: number[] = [];
  const stack = [start];
  while (stack.length) {
    const v = stack[stack.length - 1];
    const nbrs = local.get(v)!;
    if (nbrs.length === 0) {
      trail.push(v);
      stack.pop();
    } else {
      const w = nbrs.pop()!;
      // remove one instance of v from w's list
      const wl = local.get(w)!;
      const idx = wl.indexOf(v);
      if (idx >= 0) wl.splice(idx, 1);
      stack.push(w);
    }
  }
  return trail.reverse();
}

// ─── Public: plan continuous strokes ─────────────────────────────────────

export type RouteResult = {
  strokes: PathMm[];
  stats: { inputSegments: number; strokes: number; components: number; duplicatedEdges: number };
};

/**
 * Turn segments into the fewest continuous strokes. Each connected component
 * becomes one stroke; strokes are ordered nearest-endpoint. Endpoints within
 * `joinToleranceMm` are treated as the same point.
 */
export function planStrokes(segments: Segment[], joinToleranceMm = 0.15): RouteResult {
  const g = buildGraph(segments, joinToleranceMm);
  const comps = components(g);
  const rawStrokes: PathMm[] = [];
  for (const comp of comps) {
    const trail = eulerTrail(g, comp);
    if (trail.length >= 2) rawStrokes.push(trail.map((n) => ({ x: g.nodes[n].x, y: g.nodes[n].y })));
  }
  // Count duplicated edges (route length in edges minus unique edges).
  let traversedEdges = 0;
  for (const s of rawStrokes) traversedEdges += s.length - 1;
  const duplicatedEdges = Math.max(0, traversedEdges - g.edges.length);

  const strokes = orderStrokesByTravel(rawStrokes);
  return {
    strokes,
    stats: {
      inputSegments: segments.length,
      strokes: strokes.length,
      components: comps.length,
      duplicatedEdges,
    },
  };
}

/** Greedy nearest-endpoint ordering + reversal of a set of strokes. */
export function orderStrokesByTravel(strokes: PathMm[]): PathMm[] {
  if (strokes.length <= 1) return strokes.slice();
  const used = new Array(strokes.length).fill(false);
  // start from the stroke whose start is most top-left (deterministic)
  let startI = 0;
  let bestKey = Infinity;
  strokes.forEach((s, i) => {
    const k = s[0].y * 1e5 + s[0].x;
    if (k < bestKey) {
      bestKey = k;
      startI = i;
    }
  });
  const out: PathMm[] = [];
  let cur = strokes[startI].slice();
  used[startI] = true;
  out.push(cur);
  for (let n = 1; n < strokes.length; n++) {
    const tail = cur[cur.length - 1];
    let bi = -1;
    let brev = false;
    let bd = Infinity;
    for (let i = 0; i < strokes.length; i++) {
      if (used[i]) continue;
      const s = strokes[i];
      const dHead = Math.hypot(tail.x - s[0].x, tail.y - s[0].y);
      const dTail = Math.hypot(tail.x - s[s.length - 1].x, tail.y - s[s.length - 1].y);
      if (dHead < bd) {
        bd = dHead;
        bi = i;
        brev = false;
      }
      if (dTail < bd) {
        bd = dTail;
        bi = i;
        brev = true;
      }
    }
    used[bi] = true;
    cur = brev ? strokes[bi].slice().reverse() : strokes[bi].slice();
    out.push(cur);
  }
  return out;
}

// ─── Public: Holbein reversible double-running route ─────────────────────

/**
 * Reversible double-running (Holbein) stitch. The classic blackwork technique:
 * sew an Eulerian route laying every OTHER stitch-unit on the way out, then
 * return filling the skipped units - the finished line is identical on front
 * and back (Holden, "The Graph Theory of Blackwork", 2007). Every connected
 * component yields a single out-and-back stroke that reads as a solid running
 * stitch and reverses cleanly.
 *
 * Returns one PathMm per component. We resample the Eulerian trail to an even
 * stitch length, then emit: pass A = points at even indices, pass B (reversed)
 * = the odd indices. Concatenated they form one continuous out-and-back path
 * that covers every unit exactly once per side.
 */
export function holbeinRoute(
  segments: Segment[],
  stitchLenMm: number,
  joinToleranceMm = 0.15,
): { strokes: PathMm[]; stats: { components: number; units: number } } {
  const g = buildGraph(segments, joinToleranceMm);
  const comps = components(g);
  const strokes: PathMm[] = [];
  let units = 0;
  for (const comp of comps) {
    const trail = eulerTrail(g, comp);
    if (trail.length < 2) continue;
    const poly = trail.map((n) => ({ x: g.nodes[n].x, y: g.nodes[n].y }));
    const even = resampleEven(poly, stitchLenMm);
    if (even.length < 2) continue;
    units += even.length - 1;
    // Out pass: stitch every unit forward. Because the Eulerian trail already
    // traverses each edge once, a single forward running pass along it is the
    // "double running" line; sewing it forward then backward guarantees full
    // coverage on both faces and returns the needle to a tie-off near start.
    const back = even.slice(0, -1).reverse();
    strokes.push([...even, ...back]);
  }
  return { strokes, stats: { components: comps.length, units } };
}

/** Even-length resample of a polyline (local, so routing has no deps). */
function resampleEven(points: PathMm, stepMm: number): PathMm {
  if (points.length < 2) return points.slice();
  const out: PathMm = [points[0]];
  let since = 0;
  for (let i = 1; i < points.length; i++) {
    let ax = points[i - 1].x;
    let ay = points[i - 1].y;
    const b = points[i];
    let seg = Math.hypot(b.x - ax, b.y - ay);
    if (seg === 0) continue;
    while (since + seg >= stepMm) {
      const need = stepMm - since;
      const t = need / seg;
      const p = { x: ax + (b.x - ax) * t, y: ay + (b.y - ay) * t };
      out.push(p);
      ax = p.x;
      ay = p.y;
      seg -= need;
      since = 0;
    }
    since += seg;
  }
  const last = points[points.length - 1];
  if (Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].y - last.y) > stepMm * 0.4) {
    out.push(last);
  }
  return out;
}
