import {
  parseNetwork,
  rankMeetingResults,
  type MeetingNetwork,
  type Objective,
  type SearchOutput,
} from '../../src/lib/meeting-point'
import type { Engine, Reply, Request, Result } from './search.worker'
import { summarize, summarizeDrift } from './statistics.mjs'

// Numerical harness, not the production UI: no map, playback or provider requests.
type Config = {
  engines: Engine[]
  groups: Array<'2' | '4' | '8' | '16' | 'duplicates'>
  objectives: Objective[]
  warmups: number
  samples: number
  seed: number
  smoke: boolean
  runId: string
}
type Sample = {
  runId: string
  phase: 'warmup' | 'measured'
  iteration: number
  block: number
  order: number
  sequence: number
  timings: Record<string, number>
}
type Command =
  | Omit<Extract<Request, { kind: 'init' }>, 'id'>
  | Omit<Extract<Request, { kind: 'search' }>, 'id'>
  | { kind: 'fail-init' }
type Success = Extract<Reply, { kind: 'ready' | 'result' }>
type Delivery = Extract<Reply, { kind: 'delivery' }>
type Response = {
  reply: Success
  roundTripMs: number
  receivedAt: number
  requestPostMs: number
  delivery: Delivery | null
}
type Pending = {
  resolve: (value: Response) => void
  reject: (reason: Error) => void
  start: number
  requestPostMs: number
  response: Success | null
  roundTripMs: number
  receivedAt: number
  timer: number
}
const live = new Set<Client>()
let created = 0
let terminated = 0

class Client {
  readonly started = performance.now()
  readonly worker = new Worker(new URL('./search.worker.ts', import.meta.url), {
    type: 'module',
  })
  readonly boot: Promise<number>
  private bootResolve: (value: number) => void
  private bootReject: (reason: Error) => void
  private bootTimer: number
  private pending = new Map<number, Pending>()
  private sequence = 0
  private closed = false
  private failure: Error | null = null

  constructor(readonly engine: Engine) {
    created++
    live.add(this)
    const { promise, resolve, reject } = Promise.withResolvers<number>()
    this.boot = promise
    this.bootResolve = resolve
    this.bootReject = reject
    this.bootTimer = window.setTimeout(
      () => this.fail(new Error(`${engine}: worker boot timed out`)),
      120_000,
    )
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data
      if (reply.kind === 'boot') {
        clearTimeout(this.bootTimer)
        this.bootResolve(performance.now() - this.started)
        return
      }
      const pending = this.pending.get(reply.id)
      if (!pending) {
        this.fail(new Error(`${engine}: unexpected/stale reply ${reply.id}`))
        return
      }
      if (reply.kind === 'error') {
        clearTimeout(pending.timer)
        this.pending.delete(reply.id)
        pending.reject(
          new Error(`${engine} request ${reply.id}: ${reply.message}`),
        )
      } else if (reply.kind === 'delivery') {
        if (!pending.response) {
          this.fail(new Error('Delivery arrived without its response'))
          return
        }
        this.finish(reply.id, pending, pending.response, reply)
      } else {
        pending.response = reply
        pending.receivedAt = performance.now()
        pending.roundTripMs = pending.receivedAt - pending.start
      }
    }
    this.worker.onerror = (event) =>
      this.fail(new Error(`${engine} worker: ${event.message}`))
    this.worker.onmessageerror = () =>
      this.fail(new Error(`${engine}: message deserialization failed`))
  }

  private finish(
    id: number,
    pending: Pending,
    reply: Success,
    delivery: Delivery | null,
  ) {
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve({
      reply,
      delivery,
      roundTripMs: pending.roundTripMs,
      receivedAt: pending.receivedAt,
      requestPostMs: pending.requestPostMs,
    })
  }

  private fail(error: Error) {
    this.failure = error
    clearTimeout(this.bootTimer)
    this.bootReject(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  call(command: Command): Promise<Response> {
    if (this.closed || this.failure)
      return Promise.reject(this.failure ?? new Error('Worker terminated'))
    const id = ++this.sequence
    const { promise, resolve, reject } = Promise.withResolvers<Response>()
    const pending: Pending = {
      resolve,
      reject,
      start: performance.now(),
      requestPostMs: 0,
      response: null,
      roundTripMs: 0,
      receivedAt: 0,
      timer: window.setTimeout(
        () =>
          this.fail(
            new Error(`${this.engine} ${command.kind} ${id}: timed out`),
          ),
        120_000,
      ),
    }
    this.pending.set(id, pending)
    try {
      this.worker.postMessage({ ...command, id } satisfies Request)
      pending.requestPostMs = performance.now() - pending.start
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    this.worker.terminate()
    this.fail(new Error(`${this.engine}: worker terminated`))
    live.delete(this)
    terminated++
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equalValue(actual: unknown, expected: unknown, path: string): void {
  if (Object.is(actual, expected)) return
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    assert(
      actual.constructor === expected.constructor,
      `${path}: view type differs`,
    )
    assert(
      actual instanceof Float64Array || actual instanceof Int32Array,
      `${path}: unsupported view`,
    )
    assert(
      expected instanceof Float64Array || expected instanceof Int32Array,
      `${path}: unsupported reference view`,
    )
    assert(actual.length === expected.length, `${path}: view length differs`)
    for (let i = 0; i < actual.length; i++) {
      if (!Object.is(actual[i], expected[i]))
        throw new Error(`${path}[${i}]: ${actual[i]} != ${expected[i]}`)
    }
    return
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert(actual.length === expected.length, `${path}: array length differs`)
    for (let i = 0; i < actual.length; i++)
      equalValue(actual[i], expected[i], `${path}[${i}]`)
    return
  }
  if (
    actual &&
    expected &&
    typeof actual === 'object' &&
    typeof expected === 'object'
  ) {
    const a = Object.entries(actual)
    const b = Object.entries(expected)
    equalValue(
      a.map(([key]) => key).sort(),
      b.map(([key]) => key).sort(),
      `${path}.keys`,
    )
    const reference = new Map(b)
    for (const [key, value] of a)
      equalValue(value, reference.get(key), `${path}.${key}`)
    return
  }
  throw new Error(`${path}: ${String(actual)} != ${String(expected)}`)
}

function compare(actual: Result, reference: Result) {
  equalValue(actual.output, reference.output, 'output')
  equalValue(actual.collisions, reference.collisions, 'collisions')
}

function result(
  response: Response,
  network: MeetingNetwork,
  origins: number[],
): Result {
  assert(response.reply.kind === 'result', 'Expected search result')
  assert(response.delivery?.detached, 'Sender buffers did not detach')
  const reply = response.reply
  assert(reply.output.trees.length === origins.length, 'Incorrect tree count')
  const buffers = new Set<ArrayBufferLike>()
  for (const tree of reply.output.trees) {
    assert(
      tree.distances instanceof Float64Array &&
        tree.parents instanceof Int32Array,
      'Incorrect tree precision',
    )
    assert(
      tree.distances.length === network.nodes.length &&
        tree.parents.length === network.nodes.length,
      'Incomplete or detached tree',
    )
    buffers.add(tree.distances.buffer)
    buffers.add(tree.parents.buffer)
  }
  assert(
    [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) ===
      reply.uniqueOutputBytes,
    'Output byte count mismatch',
  )
  assert(
    buffers.size === reply.uniqueOutputBuffers,
    'Output buffer count mismatch',
  )
  return reply
}

const tiny: MeetingNetwork = {
  version: 1,
  name: 'Hand-computed diamond with disconnected node',
  bounds: [-0.01, -0.01, 0.06, 0.01],
  attribution: 'Synthetic benchmark control',
  source: 'meeting-accel-execution r1',
  fetched: 'not applicable',
  nodes: [
    [0, 0],
    [0.01, 0],
    [0.02, 0],
    [0.03, 0],
    [0.04, 0],
    [0.05, 0],
  ],
  edges: [
    [0, 1, 1],
    [0, 2, 1],
    [1, 3, 1],
    [2, 3, 1],
    [3, 4, 0.25],
  ],
  places: Array.from({ length: 6 }, (_, node) => ({
    node,
    name: `Node ${node}`,
  })),
}

async function controls(engines: Engine[]) {
  const evidence = []
  for (const engine of engines) {
    const client = new Client(engine)
    try {
      await client.boot
      await client.call({ kind: 'init', engine, network: tiny })
      for (const objective of ['fair', 'total'] satisfies Objective[]) {
        const reply = result(
          await client.call({ kind: 'search', origins: [0, 4], objective }),
          tiny,
          [0, 4],
        )
        equalValue(
          reply.output.trees[0].distances,
          new Float64Array([0, 1, 1, 2, 2.25, Infinity]),
          'hand distances',
        )
        equalValue(
          reply.output.trees[0].parents,
          new Int32Array([-1, 0, 0, 1, 3, -1]),
          'hand parents',
        )
        equalValue(
          reply.output.results.map((item) => item.node),
          [1, 2, 3, 0, 4],
          'hand ranking',
        )
        assert(
          reply.collisions.length === 1 && reply.collisions[0].metres === 1.125,
          'Hand collision distance failed',
        )
        assert(
          Math.abs(reply.collisions[0].coordinate[0] - 0.0125) < 1e-14,
          'Hand collision interpolation failed',
        )
        const corrupted = structuredClone(reply)
        corrupted.output.trees[0].distances[3] += 0.5
        let rejected = false
        try {
          compare(corrupted, reply)
        } catch {
          rejected = true
        }
        assert(rejected, 'Deliberately corrupted distance was accepted')
        const snapshot = structuredClone(reply.output)
        result(
          await client.call({ kind: 'search', origins: [4, 4], objective }),
          tiny,
          [4, 4],
        )
        equalValue(reply.output, snapshot, 'retained output after later solve')
        evidence.push({
          engine,
          objective,
          handComputed: 'passed',
          corruptedDistance: 'rejected',
          retainedOutput: 'passed',
        })
      }
    } finally {
      client.dispose()
    }
  }
  return evidence
}

async function lifecycle(network: MeetingNetwork, engines: Engine[]) {
  const cycles = []
  for (const engine of engines) {
    for (let cycle = 0; cycle < 3; cycle++) {
      const failing = new Client(engine)
      try {
        await failing.boot
        let rejected = false
        try {
          await failing.call({ kind: 'fail-init' })
        } catch (error) {
          assert(
            error instanceof Error &&
              error.message.includes(
                'Deliberate benchmark initialization failure',
              ),
            'Unexpected init failure',
          )
          rejected = true
        }
        assert(rejected, 'Injected init failure accepted')
      } finally {
        failing.dispose()
      }
      const loading = new Client(engine)
      await loading.boot
      const load = loading.call({ kind: 'init', engine, network }).then(
        () => false,
        () => true,
      )
      loading.dispose()
      assert(await load, 'Cancelled load unexpectedly completed')
      const busy = new Client(engine)
      try {
        await busy.boot
        await busy.call({ kind: 'init', engine, network })
        const search = busy
          .call({
            kind: 'search',
            origins: Array(16).fill(0),
            objective: 'fair',
          })
          .then(
            () => false,
            () => true,
          )
        busy.dispose()
        assert(await search, 'Cancelled search unexpectedly completed')
      } finally {
        busy.dispose()
      }
      const restart = new Client(engine)
      try {
        await restart.boot
        await restart.call({ kind: 'init', engine, network: tiny })
        const reply = result(
          await restart.call({
            kind: 'search',
            origins: [0, 4],
            objective: 'fair',
          }),
          tiny,
          [0, 4],
        )
        equalValue(
          reply.output.trees[0].distances,
          new Float64Array([0, 1, 1, 2, 2.25, Infinity]),
          'restart result',
        )
        const edited = result(
          await restart.call({
            kind: 'search',
            origins: [4, 0],
            objective: 'total',
          }),
          tiny,
          [4, 0],
        )
        equalValue(
          edited.output.trees[0].distances,
          new Float64Array([2.25, 1.25, 1.25, 0.25, 0, Infinity]),
          'edited origin result',
        )
        equalValue(
          reply.output.trees[0].distances,
          new Float64Array([0, 1, 1, 2, 2.25, Infinity]),
          'previous output after origin edit',
        )
      } finally {
        restart.dispose()
      }
      assert(live.size === 0, 'Live worker after lifecycle cycle')
      cycles.push({
        engine,
        cycle,
        failedInit: 'rejected',
        cancelledLoad: 'terminated',
        cancelledSearch: 'terminated',
        restart: 'passed',
        retainedWorkerOriginEdit: 'passed',
        liveWorkers: live.size,
      })
    }
  }
  return cycles
}

// Deterministic farthest-point sampling in geographic coordinates, not index spacing.
function spread(network: MeetingNetwork, seed: number): number[] {
  const count = Math.min(16, network.nodes.length)
  const selected: number[] = []
  const nearest = new Float64Array(network.nodes.length).fill(Infinity)
  let next = seed % network.nodes.length
  const latitudeScale = Math.cos(
    ((network.bounds[1] + network.bounds[3]) * Math.PI) / 360,
  )
  for (let slot = 0; slot < count; slot++) {
    selected.push(next)
    const origin = network.nodes[next]
    let farthest = -1
    for (let node = 0; node < network.nodes.length; node++) {
      const point = network.nodes[node]
      const dx = (point[0] - origin[0]) * latitudeScale
      const dy = point[1] - origin[1]
      nearest[node] = Math.min(nearest[node], dx * dx + dy * dy)
      if (nearest[node] > farthest && !selected.includes(node)) {
        farthest = nearest[node]
        next = node
      }
    }
  }
  // Tiny supplied fixtures may necessarily repeat nodes; report the actual starts.
  return Array.from({ length: 16 }, (_, i) => selected[i % selected.length])
}

function heapSnapshot() {
  if (
    'memory' in performance &&
    performance.memory &&
    typeof performance.memory === 'object'
  ) {
    const memory = performance.memory
    if ('usedJSHeapSize' in memory && typeof memory.usedJSHeapSize === 'number')
      return {
        status: 'available',
        usedJSHeapSize: memory.usedJSHeapSize,
        scope:
          'performance.memory; implementation-defined page heap, not worker/process peak',
      }
  }
  return {
    status: 'unavailable',
    reason: 'performance.memory is not supported',
  }
}

function summarizeRows(rows: Record<string, number>[]) {
  const first = rows[0]
  assert(first, 'No measured rows')
  return Object.fromEntries(
    Object.keys(first).map((key) => [
      key,
      summarize(rows.map((row) => row[key])),
    ]),
  )
}

function driftRows(rows: Record<string, number>[]) {
  const first = rows[0]
  assert(first, 'No measured rows')
  return Object.fromEntries(
    Object.keys(first).map((key) => [
      key,
      summarizeDrift(rows.map((row) => row[key])),
    ]),
  )
}

async function runNumerical(config: Config) {
  const engines: Engine[] = [...new Set<Engine>(['current', ...config.engines])]
  const fetchStart = performance.now()
  const response = await fetch('/fixture.json', { cache: 'no-store' })
  assert(response.ok, `Fixture HTTP ${response.status}`)
  const text = await response.text()
  const fixtureFetchTextMs = performance.now() - fetchStart
  const parseStart = performance.now()
  const network = parseNetwork(JSON.parse(text))
  const fixtureParseValidateMs = performance.now() - parseStart
  const jsonBytes = new TextEncoder().encode(text).byteLength
  const memoryBefore = heapSnapshot()
  const cases: Array<Record<string, unknown>> = []
  const report = {
    config,
    effectiveEngines: engines,
    referenceEngine: 'current',
    schedule: {
      kind: engines.length === 1 ? 'single-engine' : 'seeded ABBA/BAAB',
      seed: config.seed,
      engineLabels: engines,
      partialBlocks: 'Odd phase counts end after one round.',
      correctness:
        'Complete-output parity, ownership and metadata inspection run after each block, outside all timed regions.',
      repeats:
        'Each fresh browser run is independent; no cross-run aggregation.',
    },
    bestJsBaseline: {
      status: 'not-selected',
      requirement:
        'Numerical results do not select a baseline or satisfy UI/cold promotion gates.',
    },
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated,
      devicePixelRatio,
    },
    fixture: {
      name: network.name,
      source: network.source,
      attribution: network.attribution,
      fetched: network.fetched,
      nodes: network.nodes.length,
      edges: network.edges.length,
      places: network.places.length,
      jsonBytes,
    },
    fixtureFetchTextMs,
    fixtureParseValidateMs,
    controlResults: await controls(engines),
    lifecycle: await lifecycle(network, engines),
    cases,
    limitations: [
      'Numerical worker harness only: UI commit, map preparation, playback, pan/seek, rendering/GPU and genuine mobile hardware are not covered.',
      'Graph is fetched/validated on the page and cloned into each worker, then echoed back. Production load fetches in its worker; production attach has no acknowledgement or graph echo.',
      'workerToMainSearchMs starts before request postMessage and ends on result receipt, before parity validation and cached rerank. It is not worker-to-UI latency.',
      'searchIncludingRankMs includes complete trees plus ranking; the public engine API does not expose a separate Dijkstra timer.',
      'postMessage timings are synchronous serialization/enqueue costs, not isolated transfer delivery duration. No independent timings are summed into a total.',
      'Graph and metadata JSON bytes are serialization proxies, not structured-clone wire bytes; actual structured-clone overhead is unavailable.',
      'Cold first-result is one fresh-worker observation per case/engine inside an already warmed browser, not a cold-browser or promotion-quality cold distribution; it excludes shared page navigation and initial fixture fetch. Use the separate real-UI harness for UI/cold gates.',
      'Lifecycle cancellation terminates immediately after dispatch; it does not prove the worker entered Dijkstra before termination or test production session guards.',
      'Live-worker counts track harness ownership/terminate calls, not OS worker memory reclamation. Peak/retained worker and browser-process memory are unavailable.',
      'JS engines share one benchmark worker asset. Compressed sizes describe the harness, not standalone production engine download costs.',
    ],
  }
  const starts = spread(network, config.seed)
  const groups = config.groups.map((group) =>
    group === 'duplicates'
      ? { name: 'coincident-4', origins: Array<number>(4).fill(starts[0]) }
      : { name: `spread-${group}`, origins: starts.slice(0, Number(group)) },
  )
  let orderState = config.seed
  try {
    for (const group of groups) {
      for (const objective of config.objectives) {
        const context = `${network.name}/${group.name}/${objective}`
        const clients = new Map<Engine, Client>()
        const cold = new Map<Engine, Record<string, number>>()
        const coldOutputs = new Map<Engine, Result>()
        const rows = new Map<Engine, Sample[]>()
        try {
          for (const engine of engines) {
            const client = new Client(engine)
            clients.set(engine, client)
            rows.set(engine, [])
            const bootMs = await client.boot
            const init = await client.call({ kind: 'init', engine, network })
            assert(init.reply.kind === 'ready', `${context}: missing ready`)
            assert(init.delivery, 'Missing graph clone acknowledgement')
            const first = await client.call({
              kind: 'search',
              origins: group.origins,
              objective,
            })
            coldOutputs.set(engine, result(first, network, group.origins))
            equalValue(
              init.reply.network,
              network,
              `${context}: graph round trip`,
            )
            cold.set(engine, {
              workerBootMs: bootMs,
              preparationMs: init.reply.preparationMs,
              graphRoundTripMs: init.roundTripMs,
              graphRequestPostMs: init.requestPostMs,
              graphEchoPostMs: init.delivery.postMessageMs,
              firstSearchMs: first.roundTripMs,
              workerCreateToFirstResultMs: first.receivedAt - client.started,
            })
          }
          const coldReference = coldOutputs.get('current')
          assert(coldReference, `${context}: missing cold reference`)
          for (const output of coldOutputs.values())
            compare(output, coldReference)
          coldOutputs.clear()
          let block = 0
          let sequence = 0
          for (const phase of ['warmup', 'measured'] as const) {
            const count = phase === 'warmup' ? config.warmups : config.samples
            for (let start = 0; start < count; start += 2) {
              // One seeded orientation per block: AB then BA, or BA then AB.
              // Reset phase boundaries so warmups cannot consume half a measured block.
              orderState = (Math.imul(orderState, 1664525) + 1013904223) >>> 0
              const firstOrder =
                orderState < 0x80000000 ? engines : [...engines].reverse()
              const measurements: Array<{
                engine: Engine
                response: Response
                reranked: SearchOutput['results']
                row: Sample
              }> = []
              const rerankObjective = objective === 'fair' ? 'total' : 'fair'
              for (let round = 0; round < Math.min(2, count - start); round++) {
                const order =
                  round === 0 ? firstOrder : [...firstOrder].reverse()
                for (const [position, engine] of order.entries()) {
                  const client = clients.get(engine)
                  assert(client, 'Missing prepared worker')
                  const response = await client.call({
                    kind: 'search',
                    origins: group.origins,
                    objective,
                  })
                  assert(
                    response.reply.kind === 'result',
                    'Expected search result',
                  )
                  const reply = response.reply
                  const rerankStart = performance.now()
                  const reranked = rankMeetingResults({
                    network,
                    trees: reply.output.trees,
                    objective: rerankObjective,
                  })
                  const cachedMainRerankMs = performance.now() - rerankStart
                  assert(response.delivery, 'Missing transfer acknowledgement')
                  measurements.push({
                    engine,
                    response,
                    reranked,
                    row: {
                      runId: config.runId,
                      phase,
                      iteration: start + round,
                      block,
                      order: round * engines.length + position,
                      sequence: sequence++,
                      timings: {
                        workerToMainSearchMs: response.roundTripMs,
                        requestPostMs: response.requestPostMs,
                        searchIncludingRankMs: reply.searchIncludingRankMs,
                        collisionsMs: reply.collisionsMs,
                        exportTransferListMs: reply.exportTransferListMs,
                        workerResultPostMs: response.delivery.postMessageMs,
                        cachedMainRerankMs,
                        uniqueOutputBytes: reply.uniqueOutputBytes,
                        uniqueOutputBuffers: reply.uniqueOutputBuffers,
                      },
                    },
                  })
                }
              }
              // Do not put full-array checks or JSON serialization between timed ABBA searches.
              const reference = measurements.find(
                (measurement) => measurement.engine === 'current',
              )
              assert(reference, `${context}: missing reference`)
              const referenceReply = result(
                reference.response,
                network,
                group.origins,
              )
              for (const measurement of measurements) {
                const { engine, response, reranked, row } = measurement
                try {
                  const reply = result(response, network, group.origins)
                  compare(reply, referenceReply)
                  equalValue(reranked, reference.reranked, 'cached rerank')
                  row.timings.metadataJsonBytes = new TextEncoder().encode(
                    JSON.stringify({
                      results: reply.output.results,
                      collisions: reply.collisions,
                    }),
                  ).byteLength
                  const samples = rows.get(engine)
                  assert(samples, 'Missing engine sample storage')
                  samples.push(row)
                } catch (error) {
                  throw new Error(
                    `${context}/${engine}/${phase}/iteration-${row.iteration}: ${String(error)}`,
                  )
                }
              }
              block++
            }
          }
          for (const engine of engines) {
            const raw = rows.get(engine)
            assert(raw, 'Missing samples')
            const measured = raw
              .filter((row) => row.phase === 'measured')
              .map((row) => row.timings)
            report.cases.push({
              runId: config.runId,
              name: group.name,
              engine,
              role: config.engines.includes(engine)
                ? 'selected'
                : 'reference-only',
              objective,
              origins: group.origins,
              warmupCount: config.warmups,
              sampleCount: config.samples,
              coldSampleCount: 1,
              cold: cold.get(engine),
              raw,
              summary: summarizeRows(measured),
              drift: driftRows(measured),
              parity:
                'exact complete trees, ranking, collisions and cached rerank passed',
            })
          }
        } catch (error) {
          throw new Error(`${context}: ${String(error)}`)
        } finally {
          for (const client of clients.values()) client.dispose()
        }
      }
    }
    assert(live.size === 0, 'Leaked harness workers')
    return {
      ...report,
      memory: { before: memoryBefore, after: heapSnapshot() },
      workerOwnership: { created, terminated, live: live.size },
      promotionEligible: false,
      promotionStatus: config.smoke
        ? 'Smoke only; promotion forbidden'
        : 'Numerical baseline only; full plan UI/cold/memory/device gates still required',
      structuredCloneWireBytes: {
        status: 'unavailable',
        reason: 'Browser does not expose serialized wire size',
      },
    }
  } finally {
    for (const client of live) client.dispose()
  }
}

async function run(config: Config) {
  try {
    return await runNumerical(config)
  } finally {
    // Includes failures during controls, boot, initialization and cancellation.
    for (const client of live) client.dispose()
  }
}

declare global {
  interface Window {
    meetingBench: { run: typeof run }
  }
}
window.meetingBench = { run }
