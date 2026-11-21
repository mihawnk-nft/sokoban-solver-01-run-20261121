// Sokoban solver — push-optimal A* per room (make.fun sokoban-solver-01).
//
// One program answers all 5 instances of a set in one run (node /bot/main.ts,
// Node 22, JS/TS source only). The generator's levels are a hallway with one
// to four rooms off it; a box pushed out of its room can never come back, so
// each room is an independent sub-problem and the level optimum is the sum of
// the rooms' optima. We therefore split the level into rooms and solve each
// room with A* over pushes:
//
//   * state = sorted box squares + the player's reachable region (named by
//     its lowest square), so walks between pushes cost nothing in the search;
//   * heuristic = cheapest assignment of boxes to goals under shortest-path
//     (wall-only) distances — admissible, so the first goal state popped is
//     push-optimal for that room;
//   * pruning = dead squares (a box there can never reach a goal, ignoring
//     other boxes) and frozen 2x2 blocks of walls/boxes with a box off goal;
//   * a goal state only counts when the player can still reach the room's
//     door afterwards, so the player can walk on to the next room;
//   * budgets are counted in expanded states, never in wall-clock time, so
//     two runs write the same bytes.
//
// If a room's A* exhausts its budget, a greedy best-first search (same code,
// ordered by heuristic only) tries for any valid solution instead — a
// slightly long solution still scores, an unsolved level scores 0.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (expanded states), never the clock: deterministic by design.
const ROOM_EXPANSIONS = 250_000;
const GREEDY_EXPANSIONS = 600_000;
const WHOLE_EXPANSIONS = 400_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Squares from which a box alone can be pushed onto some goal: pull back
 * from the goals over open floor. A square is live when some direction leads
 * to a live square while the square behind it is open for the player.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y >= 0 && y < wall.length && !wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Squares the player reaches from `from` with `occupied` in the way; returns the lowest, stamping `seen`. */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // up, down, left, right
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block (walls and boxes, a box among them off its goal). */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD letters (u first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player's square after `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; doors: number[] };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor; each remaining part holding
 * a box is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], doors: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  // A room's doors: its squares next to a floor square of the player's row.
  for (const r of rooms) {
    for (const s of r.squares) {
      for (const [dx, dy] of DIRS) {
        const q = s + dy * w + dx;
        if (Math.floor(q / w) === row && !wall[q]) { r.doors.push(s); break; }
      }
    }
  }
  return rooms.filter((r) => r.boxes.length > 0);
}

// A state's key: the region's lowest square and the boxes' squares, digits in
// base `size` (exact while size ** (boxes + 1) stays under 2 ** 53).
function keyOf(boxes: number[], low: number, size: number): number {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

/**
 * Push-optimal (A*) solution of `level` within `maxExpansions` expanded
 * states: {pushes, moves}, or null when the budget runs out or no solution
 * exists. `exitCells` (a room's doors): a solved state only counts when the
 * player's region reaches one, so the player can walk on to the next room.
 * `greedy` orders the open list by heuristic only, as a fallback that takes
 * any valid solution instead of the optimal one.
 */
function solvePushes(
  level: Level,
  maxExpansions: number,
  exitCells: number[],
  greedy: boolean,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  if (level.boxes.some((b) => !live[b])) return null;

  // Shortest-path distances from each goal over open floor (walls only),
  // for the assignment heuristic.
  const n = level.boxes.length;
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    const q = [g];
    d[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi]!;
      for (const [dx, dy] of DIRS) {
        const r = p + dy * w + dx;
        if (!wall[r] && d[r] < 0) { d[r] = d[p]! + 1; q.push(r); }
      }
    }
    return d;
  });
  // Permutations of goal indexes, for the assignment (n <= 4 here).
  const perms: number[][] = [];
  const genPerm = (used: boolean[], cur: number[]): void => {
    if (cur.length === n) { perms.push([...cur]); return; }
    for (let i = 0; i < n; i++) if (!used[i]) { used[i] = true; cur.push(i); genPerm(used, cur); cur.pop(); used[i] = false; }
  };
  genPerm(new Array<boolean>(n).fill(false), []);
  const heurCache = new Map<number, number>();
  const heuristic = (boxes: number[]): number => {
    let hk = 0;
    for (const b of boxes) hk = hk * size + b;
    const cached = heurCache.get(hk);
    if (cached !== undefined) return cached;
    let best = Infinity;
    for (const perm of perms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[perm[i]!]![boxes[i]!]!;
        if (d < 0) { sum = Infinity; break; }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    heurCache.set(hk, best);
    return best;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const statesG: number[] = [0];
  const parent: number[] = [-1];
  const pushDir: number[] = [-1];
  const best = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const startKey = keyOf(level.boxes, startLow, size);
  best.set(startKey, 0);

  // Open list: binary heap on [f, h, insertion order, state], deterministic.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;
  heapPush([greedy ? h0 : h0, h0, seq++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && expanded < maxExpansions) {
    const [, , , s] = heapPop();
    const boxes = statesBoxes[s]!;
    const g = statesG[s]!;
    // Stale entry (a better path to this state was found since)?
    for (const b of boxes) occupied[b] = 1;
    const low = reach(level, occupied, statesPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    if (best.get(keyOf(boxes, low, size)) !== s) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    if (solved(boxes)) {
      const canExit = exitCells.length === 0 || exitCells.some((e) => seen[e] === here);
      if (canExit) { found = s; break; }
    }
    expanded++;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let nextLow = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          nextLow = reach(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, nextLow, size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const prev = best.get(key);
        if (prev !== undefined && statesG[prev]! <= g + 1) continue;
        const h = heuristic(next);
        if (h === Infinity) continue;
        const tIdx = statesBoxes.length;
        best.set(key, tIdx);
        statesBoxes.push(next);
        statesPlayer.push(b);
        statesG.push(g + 1);
        parent.push(s);
        pushDir.push(di);
        heapPush([greedy ? h : g + 1 + h, h, seq++, tIdx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  // (Clear `occupied`: the search loop breaks out with the found state's
  // boxes still marked, and reconstruction rebuilds it per push.)
  occupied.fill(0);
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const di = pushDir[s]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di]![3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** Solve one level: room by room when it splits into rooms, else whole. */
function solve(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushes(level, WHOLE_EXPANSIONS, [], false)
      ?? solvePushes(level, WHOLE_EXPANSIONS, [], true);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, ROOM_EXPANSIONS, room.doors, false)
      ?? solvePushes(sub, GREEDY_EXPANSIONS, room.doors, true);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    // Solved room's boxes now rest on its goals: they stay walls for the rest.
    for (let i = 0; i < room.boxes.length; i++) room.boxes[i] = room.goals[i]!;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
