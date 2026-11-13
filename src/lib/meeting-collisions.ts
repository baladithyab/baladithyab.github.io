import type { Coordinate, MeetingNetwork, SearchTree } from './meeting-point'

// The end of playback blends traversal into routes, candidate spots, and the final ping.
export const SEARCH_COMPLETE_AT = 0.86
export const COLLISION_PING_SPAN = 0.08

export type SearchCollision = {
  sources: [number, number]
  coordinate: Coordinate
  metres: number
}

export function searchProgress(progress: number): number {
  return Math.max(0, Math.min(1, progress / SEARCH_COMPLETE_AT))
}

export function resultRevealProgress(
  progress: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return Number(progress >= SEARCH_COMPLETE_AT)
  const phase = Math.max(
    0,
    Math.min(1, (progress - SEARCH_COMPLETE_AT) / (1 - SEARCH_COMPLETE_AT)),
  )
  return phase * phase * (3 - 2 * phase)
}

export function markerRevealOpacity(
  reveal: number,
  index: number,
  selected: number,
  count: number,
): number {
  const rank = index === selected ? 0 : index < selected ? index + 1 : index
  const delay = 0.2 + (0.3 * rank) / Math.max(count - 1, 1)
  const phase = Math.max(0, Math.min(1, (reveal - delay) / 0.5))
  return phase * phase * (3 - 2 * phase)
}

export function findSearchCollisions({
  network,
  trees,
  origins,
}: {
  network: MeetingNetwork
  trees: SearchTree[]
  origins: number[]
}): SearchCollision[] {
  const collisions: SearchCollision[] = []
  for (let a = 0; a < trees.length; a++) {
    const tree = trees[a]
    for (let b = a + 1; b < origins.length; b++) {
      const distance = tree.distances[origins[b]]
      if (!Number.isFinite(distance)) continue
      const halfway = distance / 2
      let node = origins[b]
      let parent = tree.parents[node]
      // Equal-speed fronts first touch halfway along a shortest ROAD path.
      // Interpolate within the crossing edge, not between the two origins.
      while (parent !== -1 && tree.distances[parent] > halfway) {
        node = parent
        parent = tree.parents[node]
      }
      let coordinate = network.nodes[node]
      if (parent !== -1) {
        const fraction =
          (tree.distances[node] - halfway) /
          (tree.distances[node] - tree.distances[parent])
        const from = network.nodes[node]
        const to = network.nodes[parent]
        coordinate = [
          from[0] + (to[0] - from[0]) * fraction,
          from[1] + (to[1] - from[1]) * fraction,
        ]
      }
      collisions.push({ sources: [a, b], coordinate, metres: halfway })
    }
  }
  return collisions.sort(
    (a, b) =>
      a.metres - b.metres ||
      a.sources[0] - b.sources[0] ||
      a.sources[1] - b.sources[1],
  )
}
