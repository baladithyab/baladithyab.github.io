import {
  rankMeetingResults,
  type MeetingNetwork,
  type MeetingSearch,
} from '../../src/lib/meeting-point'

// Keep the production heap's comparisons: equal priorities are not node-ordered.
class ScalarMinHeap {
  private nodes: number[] = []
  private values: number[] = []

  get length() {
    return this.nodes.length
  }

  // Read before pop(), while the priority still belongs to the root node.
  get value() {
    return this.values[0]
  }

  push(node: number, value: number) {
    let i = this.nodes.length
    this.nodes.push(node)
    this.values.push(value)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.values[parent] <= value) break
      this.nodes[i] = this.nodes[parent]
      this.values[i] = this.values[parent]
      i = parent
    }
    this.nodes[i] = node
    this.values[i] = value
  }

  pop(): number {
    const node = this.nodes[0]
    const lastNode = this.nodes.pop()!
    const lastValue = this.values.pop()!
    if (this.nodes.length) {
      let i = 0
      while (2 * i + 1 < this.nodes.length) {
        let child = 2 * i + 1
        if (
          child + 1 < this.nodes.length &&
          this.values[child + 1] < this.values[child]
        )
          child++
        if (this.values[child] >= lastValue) break
        this.nodes[i] = this.nodes[child]
        this.values[i] = this.values[child]
        i = child
      }
      this.nodes[i] = lastNode
      this.values[i] = lastValue
    }
    return node
  }
}

/**
 * Benchmark-only counterpart of prepareMeetingSearch in src/lib/meeting-point.ts.
 * CSR is prepared once in original edge order; only heap pop allocation differs.
 * Every solve owns its complete distance/parent arrays, including duplicate starts.
 */
export function prepareScalarSearch(network: MeetingNetwork): MeetingSearch {
  const count = network.nodes.length
  const offsets = new Int32Array(count + 1)
  for (const [a, b] of network.edges) {
    offsets[a + 1]++
    offsets[b + 1]++
  }
  for (let i = 0; i < count; i++) offsets[i + 1] += offsets[i]
  const targets = new Int32Array(offsets[count])
  const weights = new Float64Array(offsets[count])
  const cursor = offsets.slice(0, count)
  for (const [a, b, metres] of network.edges) {
    let slot = cursor[a]++
    targets[slot] = b
    weights[slot] = metres
    slot = cursor[b]++
    targets[slot] = a
    weights[slot] = metres
  }
  return {
    find({ origins, objective }) {
      if (origins.length < 2)
        throw new Error('Choose at least two starting locations.')
      if (
        origins.some(
          (node) => !Number.isInteger(node) || node < 0 || node >= count,
        )
      )
        throw new Error('A starting location is outside the network.')
      const trees = origins.map((origin) => {
        const distances = new Float64Array(count).fill(Infinity)
        const parents = new Int32Array(count).fill(-1)
        const queue = new ScalarMinHeap()
        distances[origin] = 0
        queue.push(origin, 0)
        while (queue.length) {
          const distance = queue.value
          const node = queue.pop()
          if (distance !== distances[node]) continue
          for (let slot = offsets[node]; slot < offsets[node + 1]; slot++) {
            const target = targets[slot]
            const next = distance + weights[slot]
            if (next < distances[target]) {
              distances[target] = next
              parents[target] = node
              queue.push(target, next)
            }
          }
        }
        return { distances, parents }
      })
      return {
        trees,
        results: rankMeetingResults({ network, trees, objective }),
      }
    },
  }
}
