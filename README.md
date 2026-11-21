# Sokoban Solver — Push-Optimal A* per Room

[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/mihawnk-nft/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/mihawnk-nft/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

An entry for the [make.fun](https://make.fun/c/sokoban-solver-01-run-20261121)
bounty "Build the best Sokoban solver, 21 November 2026".

## The program

`main.ts` (Node 22, no dependencies, JavaScript/TypeScript source only) reads
5 Sokoban levels from `/input/<id>/level.txt` and writes each answer to
`/output/<id>/solution.txt`, in one run of well under the 60-second wall
budget. The whole set answers in ~0.3 s on a single CPU.

## How it works

The generated levels are a one-square-wide hallway with one to four rooms off
it, and a box pushed out of its room can never be pushed back — so every room
is an independent sub-problem and a level's push-optimal count is the sum of
its rooms' optima. The solver therefore splits each level into rooms (cut the
dead squares of the hallway row out of the floor; each remaining part holding
boxes is a room) and solves each room with A* over pushes:

- **State** — the sorted box squares plus the player's reachable region
  (named by its lowest square), so walks between pushes cost nothing in the
  search.
- **Heuristic** — the cheapest assignment of boxes to goals under
  shortest-path (wall-only) distances. Admissible, so the first goal state
  popped is push-optimal for that room.
- **Pruning** — dead squares (a box there can never reach a goal, ignoring
  other boxes) and frozen 2×2 blocks of walls/boxes with a box off its goal.
- **Exit check** — a solved state only counts when the player can still reach
  the room's door, so the player can walk on to the next room.
- **Budgets in work, never in wall-clock time** — a fixed number of expanded
  states per room, so two runs write the same bytes. If A* exhausts its
  budget on a room, a greedy best-first search tries for any valid solution
  instead (a slightly long solution still scores; an unsolved level scores 0).

## Practice-set results

| instance | rooms | pushes | P\* | points |
|----------|-------|--------|----|--------|
| i001 | 1 × 3 boxes | 13 | 13 | 1,000 |
| i002 | 1 × 4 boxes | 16 | 16 | 1,000 |
| i003 | 2 × 4 boxes | 29 | 29 | 1,000 |
| i004 | 3 × 4 boxes | 47 | 47 | 1,000 |
| i005 | 4 × 4 boxes | 60 | 60 | 1,000 |

**Practice score: 1,000,000 / 1,000,000** — every instance solved in exactly
its push-optimal count. The house baseline (`plain-astar` 1.0.0) scores
200,000 on the same set (it only solves i001; the other four come back empty).

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` needs no install step: `node main.ts` runs it as it is on Node 22.
