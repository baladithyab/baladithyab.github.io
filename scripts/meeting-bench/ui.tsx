import { createRoot } from 'react-dom/client'
import '../../src/styles/globals.css'
import MeetingPoint from '../../src/components/MeetingPoint'
import {
  distanceBetween,
  type MeetingNetwork,
  type MeetingResult,
} from '../../src/lib/meeting-point'
import type {
  MeetingSessionReply,
  MeetingSessionRequest,
} from '../../src/lib/meeting-session'

// Benchmark entry for the real MeetingPoint island and its production worker.
// Instrumentation wraps only browser globals (Worker, requestAnimationFrame) and
// reads the DOM; it never reads or writes React state.

type Category = 'searching' | 'preparing' | 'results' | 'notice' | 'other'
type Trigger = 'click' | 'keydown' | 'pointerdown' | 'pointerup'
type SearchRequest = Extract<MeetingSessionRequest, { kind: 'search' }>
type ObservedRequest =
  | { kind: 'load' | 'attach' }
  | Pick<SearchRequest, 'kind' | 'id' | 'origins' | 'objective'>
type ResultSummary = Pick<MeetingResult, 'node' | 'name' | 'longest' | 'total'>
type WorkerEvent =
  | { kind: 'created'; worker: number; at: number; script: string }
  | {
      kind: 'post'
      worker: number
      at: number
      returnedAt: number
      message: ObservedRequest['kind']
      id: number | null
      origins: number[] | null
      objective: SearchRequest['objective'] | null
    }
  | {
      kind: 'reply'
      worker: number
      at: number
      message: MeetingSessionReply['kind']
      id: number | null
      error: string | null
      results: ResultSummary[] | null
    }
  | { kind: 'error'; worker: number; at: number; message: string }
  | { kind: 'terminate'; worker: number; at: number }
// Result arrays are summarized when read, outside the timed reply handler.
type Recorded = { event: WorkerEvent; results: MeetingResult[] | null }

// MeetingMap's private world width; map clicks aim at its fit view.
const WORLD = 1024

const log: Recorded[] = []
const liveWorkers = new Set<number>()
let createdWorkers = 0
let terminatedWorkers = 0
let network: MeetingNetwork | null = null

function record(event: WorkerEvent) {
  log.push({ event, results: null })
}

function observedRequest(value: unknown): ObservedRequest | null {
  if (typeof value !== 'object' || value === null || !('kind' in value))
    return null
  if (value.kind === 'load' || value.kind === 'attach')
    return { kind: value.kind }
  if (
    value.kind !== 'search' ||
    !('id' in value) ||
    typeof value.id !== 'number' ||
    !('origins' in value) ||
    !Array.isArray(value.origins) ||
    !('objective' in value) ||
    (value.objective !== 'fair' && value.objective !== 'total')
  )
    return null
  const origins: number[] = []
  for (const node of value.origins) {
    if (typeof node !== 'number') return null
    origins.push(node)
  }
  return { kind: 'search', id: value.id, origins, objective: value.objective }
}

const NativeWorker = window.Worker
class InstrumentedWorker extends NativeWorker {
  readonly benchId: number

  constructor(script: string | URL, options?: WorkerOptions) {
    super(script, options)
    const worker = ++createdWorkers
    this.benchId = worker
    liveWorkers.add(worker)
    record({
      kind: 'created',
      worker,
      at: performance.now(),
      script: String(script),
    })
    // Registered before MeetingPoint assigns onmessage, so arrival is stamped first.
    this.addEventListener(
      'message',
      (event: MessageEvent<MeetingSessionReply>) => {
        const at = performance.now()
        const reply = event.data
        if (reply.kind === 'ready') network = reply.network
        log.push({
          event: {
            kind: 'reply',
            worker,
            at,
            message: reply.kind,
            id:
              reply.kind === 'result' || reply.kind === 'error'
                ? reply.id
                : null,
            error: reply.kind === 'error' ? reply.message : null,
            results: null,
          },
          results: reply.kind === 'result' ? reply.output.results : null,
        })
      },
    )
    this.addEventListener('error', (event) =>
      record({
        kind: 'error',
        worker,
        at: performance.now(),
        message: event.message || 'Worker error event without a message',
      }),
    )
    this.addEventListener('messageerror', () =>
      record({
        kind: 'error',
        worker,
        at: performance.now(),
        message: 'Worker reply could not be deserialized',
      }),
    )
  }

  override postMessage(
    message: unknown,
    options?: Transferable[] | StructuredSerializeOptions,
  ): void {
    const at = performance.now()
    const request = observedRequest(message)
    if (Array.isArray(options)) super.postMessage(message, options)
    else super.postMessage(message, options)
    const returnedAt = performance.now()
    if (!request) {
      record({
        kind: 'error',
        worker: this.benchId,
        at,
        message: 'MeetingPoint posted an unrecognized worker request',
      })
      return
    }
    const search = request.kind === 'search' ? request : null
    record({
      kind: 'post',
      worker: this.benchId,
      at,
      returnedAt,
      message: request.kind,
      id: search?.id ?? null,
      origins: search?.origins ?? null,
      objective: search?.objective ?? null,
    })
  }

  override terminate(): void {
    record({ kind: 'terminate', worker: this.benchId, at: performance.now() })
    if (liveWorkers.delete(this.benchId)) terminatedWorkers++
    super.terminate()
  }
}
window.Worker = InstrumentedWorker

// Production frame callbacks: pending ids for settle detection and their summed
// main-thread CPU time (Canvas2D command submission, not GPU completion).
const nativeFrame = window.requestAnimationFrame.bind(window)
const nativeCancelFrame = window.cancelAnimationFrame.bind(window)
const pendingFrames = new Set<number>()
let frameCallbackCpu = 0
let frameCallbacks = 0
window.requestAnimationFrame = (callback) => {
  const id = nativeFrame((time) => {
    pendingFrames.delete(id)
    const start = performance.now()
    try {
      callback(time)
    } finally {
      frameCallbackCpu += performance.now() - start
      frameCallbacks++
    }
  })
  pendingFrames.add(id)
  return id
}
window.cancelAnimationFrame = (id) => {
  pendingFrames.delete(id)
  nativeCancelFrame(id)
}

const longTaskSupported =
  typeof PerformanceObserver !== 'undefined' &&
  PerformanceObserver.supportedEntryTypes.includes('longtask')
const longTaskEntries: { start: number; duration: number }[] = []
if (longTaskSupported)
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTaskEntries.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ type: 'longtask', buffered: true })

const container = document.getElementById('meeting-ui-bench-root')
if (!container) throw new Error('Missing #meeting-ui-bench-root.')
const app = container

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined)
    throw new Error(`Missing ${label}.`)
  return value
}

const playbackSection = () =>
  required(
    app.querySelector('section[aria-label="Animated road search"]'),
    'map playback section',
  )
const statusSelector = ':scope > p[role="status"]'
function slider(): HTMLInputElement {
  const element = playbackSection().querySelector('input[type="range"]')
  if (!(element instanceof HTMLInputElement))
    throw new Error('Missing playback slider.')
  return element
}
function canvas(): HTMLCanvasElement {
  const element = playbackSection().querySelector('canvas')
  if (!(element instanceof HTMLCanvasElement))
    throw new Error('Missing map canvas.')
  return element
}
const resultItems = () =>
  app.querySelectorAll('section[aria-labelledby="meeting-results"] ol > li')
const alertText = () =>
  [...app.querySelectorAll('[role="alert"]')]
    .map((element) => element.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' | ')
function category(text: string): Category {
  if (text.startsWith('Preparing the animated road layer')) return 'preparing'
  if (text.startsWith('Running ')) return 'searching'
  if (/^\d+ alternatives found\./.test(text)) return 'results'
  if (text.startsWith('Location ')) return 'notice'
  return 'other'
}

function deadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const expired = Promise.withResolvers<never>()
  const timer = window.setTimeout(
    () =>
      expired.reject(new Error(`${label}: timed out after ${timeoutMs} ms`)),
    timeoutMs,
  )
  return Promise.race([promise, expired.promise]).finally(() =>
    clearTimeout(timer),
  )
}

// Resolves with check()'s first non-null value after any DOM change.
function untilDom<T>(
  label: string,
  timeoutMs: number,
  check: () => T | null,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const test = () => {
    try {
      const value = check()
      if (value !== null) resolve(value)
    } catch (error) {
      reject(error)
    }
  }
  const observer = new MutationObserver(test)
  test()
  observer.observe(app, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
  return deadline(promise, timeoutMs, label).finally(() =>
    observer.disconnect(),
  )
}

// Calls step() once per native animation frame until it returns a value.
function eachFrame<T>(
  label: string,
  timeoutMs: number,
  step: (time: number) => T | null,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  let active = true
  const frame = (time: number) => {
    if (!active) return
    try {
      const value = step(time)
      if (value === null) nativeFrame(frame)
      else resolve(value)
    } catch (error) {
      reject(error)
    }
  }
  nativeFrame(frame)
  return deadline(promise, timeoutMs, label).finally(() => {
    active = false
  })
}

function events(from: number) {
  return {
    next: log.length,
    events: log.slice(from).map(({ event, results }): WorkerEvent =>
      event.kind === 'reply' && results
        ? {
            ...event,
            results: results.map(({ node, name, longest, total }) => ({
              node,
              name,
              longest,
              total,
            })),
          }
        : event,
    ),
  }
}

function ready(timeoutMs: number) {
  return untilDom('Walking network ready', timeoutMs, () => {
    const alert = alertText()
    if (alert) throw new Error(`UI error before ready: ${alert}`)
    const button = [...app.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Find meeting spots',
    )
    return button && !button.disabled ? performance.now() : null
  })
}

type Measurement = {
  cursor: number
  armedAt: number
  clickAt: number | null
  clickTimeStamp: number | null
  commitAt: number | null
  frameAt: number | null
  frameTime: number | null
  trace: { at: number; category: Category }[]
  done: Promise<void>
  stop: () => void
}
let measurement: Measurement | null = null

// Arms one Find measurement: the real click, committed nonempty ranked list and
// the next animation frame. Must precede the harness's click on Find.
function arm() {
  if (measurement) throw new Error('A Find measurement is already armed.')
  const alert = alertText()
  if (alert) throw new Error(`UI error before Find: ${alert}`)
  if (resultItems().length)
    throw new Error('Ranked results are visible before the Find click.')
  const status = required(
    playbackSection().querySelector(statusSelector),
    'map playback status',
  )
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const armedAt = performance.now()
  const state: Measurement = {
    cursor: log.length,
    armedAt,
    clickAt: null,
    clickTimeStamp: null,
    commitAt: null,
    frameAt: null,
    frameTime: null,
    trace: [{ at: armedAt, category: category(status.textContent ?? '') }],
    done: promise,
    stop: () => {},
  }
  const onClick = (event: MouseEvent) => {
    if (state.clickAt !== null || !(event.target instanceof Element)) return
    if (
      event.target
        .closest('button')
        ?.textContent?.includes('Find meeting spots')
    ) {
      state.clickAt = performance.now()
      state.clickTimeStamp = event.timeStamp
    }
  }
  const results = new MutationObserver(() => {
    if (state.commitAt !== null) return
    const failure = alertText()
    if (failure) {
      stop()
      reject(new Error(`UI error after Find: ${failure}`))
      return
    }
    if (!resultItems().length) return
    if (state.clickAt === null) {
      stop()
      reject(new Error('Ranked results appeared before the Find click.'))
      return
    }
    state.commitAt = performance.now()
    results.disconnect()
    document.removeEventListener('click', onClick, true)
    nativeFrame((time) => {
      state.frameAt = performance.now()
      state.frameTime = time
      resolve()
    })
  })
  const statusTrace = new MutationObserver(() => {
    const next = category(status.textContent ?? '')
    if (state.trace.at(-1)?.category !== next)
      state.trace.push({ at: performance.now(), category: next })
  })
  function stop() {
    results.disconnect()
    statusTrace.disconnect()
    document.removeEventListener('click', onClick, true)
  }
  state.stop = stop
  document.addEventListener('click', onClick, true)
  results.observe(app, { subtree: true, childList: true })
  statusTrace.observe(status, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  measurement = state
}

async function settle(timeoutMs: number) {
  const state = required(measurement, 'armed Find measurement')
  try {
    await deadline(state.done, timeoutMs, 'Find to committed results')
  } catch (error) {
    state.stop()
    measurement = null
    throw error
  }
  return {
    armedAt: state.armedAt,
    clickAt: required(state.clickAt, 'Find click'),
    clickTimeStamp: required(state.clickTimeStamp, 'Find click timestamp'),
    commitAt: required(state.commitAt, 'committed results'),
    frameAt: required(state.frameAt, 'post-commit frame'),
    frameTime: required(state.frameTime, 'post-commit frame timestamp'),
    events: events(state.cursor).events,
  }
}

// After settle(): waits until production playback advances, which requires the
// map's traversal preparation to be ready, and reports the status transitions.
async function readiness(timeoutMs: number) {
  const state = required(measurement, 'settled Find measurement')
  const commitAt = required(state.commitAt, 'committed results')
  try {
    const playbackAdvanceAt = await eachFrame(
      'Playback start after results',
      timeoutMs,
      () => {
        const failure = alertText()
        if (failure) throw new Error(`UI error during preparation: ${failure}`)
        return slider().value === '0' ? null : performance.now()
      },
    )
    const trace = state.trace.filter((entry) => entry.at >= commitAt)
    const preparingAt =
      trace.find((entry) => entry.category === 'preparing')?.at ?? null
    const preparedAt =
      preparingAt === null
        ? null
        : (trace.find(
            (entry) => entry.at > preparingAt && entry.category !== 'preparing',
          )?.at ?? null)
    return { commitAt, preparingAt, preparedAt, playbackAdvanceAt, trace }
  } finally {
    state.stop()
    measurement = null
  }
}

type MapVisibility = {
  rect: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  visibleFraction: number
  devicePixelRatio: number
  visibilityState: DocumentVisibilityState
  hasFocus: boolean
}

// Map canvas geometry and page focus state; trails/pans are only meaningful
// when the canvas is actually on screen.
function mapVisibility(): MapVisibility {
  const rect = canvas().getBoundingClientRect()
  const width = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
  )
  const height = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
  )
  return {
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    visibleFraction:
      rect.width && rect.height
        ? (width * height) / (rect.width * rect.height)
        : 0,
    devicePixelRatio: window.devicePixelRatio,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  }
}

type InteractionWindow = {
  trigger: Trigger
  release: Trigger
  triggerAt: number | null
  releaseAt: number | null
  cpuAtTrigger: number
  callbacksAtTrigger: number
  frames: number[]
  active: boolean
  remove: () => void
  visibilityAtStart: MapVisibility
}
let interaction: InteractionWindow | null = null

// Starts frame/CPU collection; timing begins at the next real `trigger` event
// and settling waits for `release` (pan: pointerdown ... pointerup).
function startWindow(trigger: Trigger, release: Trigger = trigger) {
  if (interaction) throw new Error('An interaction window is already open.')
  const state: InteractionWindow = {
    trigger,
    release,
    triggerAt: null,
    releaseAt: null,
    cpuAtTrigger: 0,
    callbacksAtTrigger: 0,
    frames: [],
    active: true,
    remove: () => {},
    visibilityAtStart: mapVisibility(),
  }
  const onTrigger = () => {
    if (state.triggerAt !== null) return
    state.triggerAt = performance.now()
    state.cpuAtTrigger = frameCallbackCpu
    state.callbacksAtTrigger = frameCallbacks
  }
  const onRelease = () => {
    if (state.triggerAt !== null && state.releaseAt === null)
      state.releaseAt = performance.now()
  }
  document.addEventListener(trigger, onTrigger, true)
  document.addEventListener(release, onRelease, true)
  state.remove = () => {
    document.removeEventListener(trigger, onTrigger, true)
    document.removeEventListener(release, onRelease, true)
  }
  const frame = (time: number) => {
    if (!state.active) return
    state.frames.push(time)
    nativeFrame(frame)
  }
  nativeFrame(frame)
  interaction = state
}

// Settled: the trigger was released, the slider condition holds and production
// requested no animation frame for two consecutive frames.
async function finishWindow({
  until,
  sliderValue,
  timeoutMs,
}: {
  until: 'settled' | 'playback-complete'
  sliderValue?: string
  timeoutMs: number
}) {
  const state = required(interaction, 'open interaction window')
  try {
    let quietSince: number | null = null
    let quietFrames = 0
    const settledAt = await eachFrame(
      `Interaction after ${state.trigger}`,
      timeoutMs,
      () => {
        const failure = alertText()
        if (failure) throw new Error(`UI error during interaction: ${failure}`)
        const value = slider().value
        const done =
          state.releaseAt !== null &&
          (sliderValue === undefined || value === sliderValue) &&
          (until === 'settled' || value === '100') &&
          pendingFrames.size === 0
        if (!done) {
          quietSince = null
          quietFrames = 0
          return null
        }
        quietSince ??= performance.now()
        return ++quietFrames >= 2 ? quietSince : null
      },
    )
    const triggerAt = required(state.triggerAt, `${state.trigger} event`)
    const frames = state.frames.filter(
      (time) => time >= triggerAt && time <= settledAt,
    )
    return {
      trigger: state.trigger,
      release: state.release,
      triggerAt,
      releaseAt: required(state.releaseAt, `${state.release} event`),
      settledAt,
      settleMs: settledAt - triggerAt,
      frameIntervalsMs: frames.slice(1).map((time, i) => time - frames[i]),
      productionFrameCallbacks: frameCallbacks - state.callbacksAtTrigger,
      productionFrameCallbackCpuMs: frameCallbackCpu - state.cpuAtTrigger,
      visibilityAtStart: state.visibilityAtStart,
      visibilityAtSettle: mapVisibility(),
    }
  } finally {
    state.active = false
    state.remove()
    interaction = null
  }
}

function longTasks(from: number, to: number) {
  if (!longTaskSupported)
    return {
      status: 'unavailable' as const,
      reason: 'PerformanceObserver longtask entries are unsupported',
    }
  const inside = longTaskEntries.filter(
    (entry) => entry.start + entry.duration >= from && entry.start <= to,
  )
  return {
    status: 'available' as const,
    count: inside.length,
    totalMs: inside.reduce((sum, entry) => sum + entry.duration, 0),
    maxMs: inside.reduce((max, entry) => Math.max(max, entry.duration), 0),
  }
}

// Viewport pixel of a node in MeetingMap's fit view (zoom 1, centered), from the
// current canvas rectangle; `onCanvas` means the canvas receives that point.
function targetPixel(node: number) {
  const { bounds, nodes } = required(network, 'ready network')
  const coordinate = required(nodes[node], `network node ${node}`)
  const element = canvas()
  const rect = element.getBoundingClientRect()
  const [west, south, east, north] = bounds
  const longitudeScale = Math.cos(((south + north) * Math.PI) / 360)
  const unit = WORLD / ((east - west) * longitudeScale)
  const worldHeight = (north - south) * unit
  const scale = Math.min(
    (rect.width - 48) / WORLD,
    (rect.height - 60) / worldHeight,
  )
  const localX =
    rect.width / 2 +
    ((coordinate[0] - west) * longitudeScale * unit - WORLD / 2) * scale
  const localY =
    rect.height / 2 + ((north - coordinate[1]) * unit - worldHeight / 2) * scale
  const x = Math.round(rect.left + localX)
  const y = Math.round(rect.top + localY)
  const inside =
    x >= rect.left + 4 &&
    x <= rect.right - 4 &&
    y >= rect.top + 4 &&
    y <= rect.bottom - 4 &&
    x >= 0 &&
    y >= 0 &&
    x < window.innerWidth &&
    y < window.innerHeight
  const hit = document.elementFromPoint(x, y)
  return {
    coordinate,
    x,
    y,
    local: `${Math.round(localX)},${Math.round(localY)}`,
    onCanvas: inside && hit === element,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    hitTarget: hit
      ? {
          tag: hit.tagName,
          id: hit.id,
          role: hit.getAttribute('role'),
          label: hit.getAttribute('aria-label'),
          class: hit.getAttribute('class'),
        }
      : null,
  }
}

function waitNotice(letter: string, timeoutMs: number) {
  return untilDom(`Location ${letter} map placement`, timeoutMs, () => {
    const text =
      playbackSection().querySelector(statusSelector)?.textContent ?? ''
    if (text.startsWith(`Location ${letter} moved to `)) return text
    if (text.startsWith('Click within 200 m')) throw new Error(text)
    const failure = alertText()
    if (failure) throw new Error(`UI error during placement: ${failure}`)
    return null
  })
}

function memory() {
  const value: unknown = Reflect.get(performance, 'memory')
  if (typeof value === 'object' && value !== null) {
    const used: unknown = Reflect.get(value, 'usedJSHeapSize')
    const total: unknown = Reflect.get(value, 'totalJSHeapSize')
    const limit: unknown = Reflect.get(value, 'jsHeapSizeLimit')
    if (
      typeof used === 'number' &&
      typeof total === 'number' &&
      typeof limit === 'number'
    )
      return {
        status: 'available' as const,
        scope:
          'main-thread JS heap via non-standard performance.memory; excludes workers',
        usedJSHeapSize: used,
        totalJSHeapSize: total,
        jsHeapSizeLimit: limit,
      }
  }
  return {
    status: 'unavailable' as const,
    reason: 'performance.memory is not exposed by this browser',
  }
}

function timerResolution() {
  let smallest = Infinity
  let last = performance.now()
  for (let i = 0; i < 200_000; i++) {
    const now = performance.now()
    if (now > last) {
      smallest = Math.min(smallest, now - last)
      last = now
    }
  }
  return Number.isFinite(smallest) ? smallest : null
}

const api = {
  installed: true,
  cursor: () => log.length,
  events,
  ready,
  arm,
  settle,
  readiness,
  startWindow,
  finishWindow,
  longTasks,
  targetPixel,
  waitNotice,
  memory,
  mapVisibility,
  timerResolution,
  // Starts may use every real road node, not just the (possibly much smaller)
  // named meeting-candidate set. Production still snaps each actual map click.
  placementNodes: () =>
    required(network, 'ready network').nodes.map((_, node) => node),
  offsets: (pairs: [number, number][]) => {
    const { nodes } = required(network, 'ready network')
    return pairs.map(([a, b]) =>
      distanceBetween(
        required(nodes[a], `network node ${a}`),
        required(nodes[b], `network node ${b}`),
      ),
    )
  },
  resultsVisible: () => resultItems().length > 0,
  candidates: () =>
    [...resultItems()].map((item) => {
      const [name, detail] = item.querySelectorAll('span.block')
      return {
        name: name?.textContent ?? '',
        detail: detail?.textContent ?? '',
      }
    }),
  rankingLabel: () =>
    [...app.querySelectorAll('section[aria-labelledby="meeting-results"] p')]
      .map((element) => element.textContent?.trim() ?? '')
      .find((text) => text.startsWith('Ranked by')) ?? null,
  workerCounts: () => ({
    created: createdWorkers,
    terminated: terminatedWorkers,
    live: liveWorkers.size,
  }),
}

declare global {
  interface Window {
    meetingUiBench: typeof api
  }
}
window.meetingUiBench = api

createRoot(app).render(
  <section className="container mx-auto max-w-7xl px-4 py-8 sm:py-12">
    <MeetingPoint />
  </section>,
)
