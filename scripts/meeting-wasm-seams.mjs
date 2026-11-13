#!/usr/bin/env node
// Real production-protocol seams, not a timing benchmark or a replacement worker.
// Uses the existing UI harness's disposable Vite/local-server/Playwright pattern.
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT = 20_000
const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'"
const MEASURES = [
  'boot',
  'prepare',
  'solve',
  'take',
  'rank',
  'collisions',
  'transfer',
].map((name) => `meeting:wasm:${name}`)
const help = `Real meeting-point WASM worker browser seams (finite; local assets only)

Usage: node scripts/meeting-wasm-seams.mjs --out PATH [--browser chromium,firefox,webkit]
  --browser LIST  Unique Playwright browsers; default all three. Missing executables
                  are explicitly unavailable, including WebKit. No fake browser pass.
  --out PATH      Required JSON evidence destination (overwritten)
  --help          No build, browser launch, or generated-module import

Prerequisite: bun run build:wasm:meeting (actual generated web bindings).
Then: node scripts/meeting-wasm-seams.mjs --out meeting-wasm-seams.json

Builds scripts/meeting-bench/wasm.worker.ts in meeting-benchmark mode, with real
wasm-bindgen output and the checked-in West Oakland fixture. Serves hashed assets
with application/wasm and a local CSP permitting WASM, not unsafe-eval JavaScript.
Exercises immediate attach+search, real delayed/HTTP-failed WASM responses,
load+queued search, invalid then valid on one session, replacement, termination
while initialization/search is queued and new-worker recovery, shared output
buffers/offsets and owned exports stable after later solves and real memory.grow.
No provider requests, protocol ACKs, synthetic WASM, unsafe pointers, OOM probes,
or claim of cancellation inside the synchronous kernel. Terminal traps remain
runtime-unexercised; source snapshots are supplied for separate lifecycle review.
The full component UI/cached-rerank/cancel matrix is meeting-ui-bench.mjs.
`

function options(args) {
  if (args.includes('--help')) return null
  const values = new Map()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!['--out', '--browser'].includes(flag) || values.has(flag))
      throw new Error(`Unknown or duplicate option ${flag}; use --help`)
    const value = args[++i]
    if (!value || value.startsWith('--'))
      throw new Error(`${flag} needs a value`)
    values.set(flag, value)
  }
  if (!values.has('--out')) throw new Error('--out PATH is required')
  const browsers = (values.get('--browser') ?? 'chromium,firefox,webkit').split(
    ',',
  )
  if (
    new Set(browsers).size !== browsers.length ||
    browsers.some((name) => !['chromium', 'firefox', 'webkit'].includes(name))
  )
    throw new Error(
      '--browser must contain unique chromium,firefox,webkit choices',
    )
  return { browsers, out: resolve(values.get('--out')) }
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function bounded(promise, label, timeout = TIMEOUT) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out: ${label}`)),
        timeout,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}
async function files(directory, base = directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(path, base)))
    else {
      const bytes = await readFile(path)
      result.push({
        path: relative(base, path).split(sep).join('/'),
        bytes: bytes.length,
        sha256: sha256(bytes),
      })
    }
  }
  return result
}

// Serialized into the disposable page entry. All replies below come from the
// actual candidate; the existing JS library is only an assertion oracle.
function installHarness(
  createWorker,
  referenceFind,
  referenceCollisions,
  readOwnedExports,
) {
  const sessions = new Map()
  const violations = []
  document.addEventListener('securitypolicyviolation', (event) => {
    violations.push({
      directive: event.violatedDirective,
      blockedURI: event.blockedURI,
    })
  })
  function check(condition, message) {
    if (!condition) throw new Error(message)
  }
  function get(key) {
    const session = sessions.get(key)
    check(session, `Missing session ${key}`)
    return session
  }
  function compareArray(actual, expected, label) {
    check(actual.length === expected.length, `${label}: length`)
    for (let i = 0; i < actual.length; i++)
      check(
        Object.is(actual[i], expected[i]),
        `${label}: index ${i}, ${actual[i]} != ${expected[i]}`,
      )
  }
  function summarizeReply(reply) {
    if (reply.kind === 'result')
      return {
        kind: reply.kind,
        id: reply.id,
        rows: reply.output.trees.length,
        results: reply.output.results.length,
      }
    if (reply.kind === 'ready')
      return {
        kind: reply.kind,
        nodes: reply.network.nodes.length,
        delivery: reply.delivery,
        landmarks: reply.landmarks,
      }
    return reply
  }
  window.seams = {
    spawn(key) {
      check(!sessions.has(key), `Duplicate session ${key}`)
      const worker = createWorker()
      const session = {
        worker,
        replies: [],
        errors: [],
        saved: [],
        terminated: false,
      }
      sessions.set(key, session)
      worker.addEventListener('message', (event) =>
        session.replies.push(event.data),
      )
      worker.addEventListener('error', (event) =>
        session.errors.push(event.message),
      )
      worker.addEventListener('messageerror', () =>
        session.errors.push('messageerror'),
      )
    },
    post(key, messages) {
      for (const message of messages) get(key).worker.postMessage(message)
    },
    terminate(key) {
      get(key).worker.terminate()
      get(key).terminated = true
    },
    has(key, kind, id) {
      const session = get(key)
      check(!session.errors.length, session.errors.join('; '))
      return session.replies.some(
        (reply) => reply.kind === kind && (id === null || reply.id === id),
      )
    },
    snapshot(key) {
      const session = get(key)
      check(!session.errors.length, session.errors.join('; '))
      return {
        replies: session.replies.map(summarizeReply),
        errors: session.errors,
        terminated: session.terminated,
      }
    },
    audit(key, id, network, origins, objective) {
      const session = get(key)
      const reply = session.replies.find(
        (value) => value.kind === 'result' && value.id === id,
      )
      check(reply, `Missing result ${id}`)
      const { trees, results } = reply.output
      check(trees.length === origins.length && trees.length > 1, 'Origin rows')
      check(results.length > 0, 'Nonempty ranked results')
      const buffers = new Set(
        trees.flatMap((tree) => [tree.distances.buffer, tree.parents.buffer]),
      )
      check(
        buffers.size === 2,
        `Expected exactly two received buffers, got ${buffers.size}`,
      )
      const n = network.nodes.length
      for (let row = 0; row < trees.length; row++) {
        const { distances, parents } = trees[row]
        check(
          distances instanceof Float64Array && parents instanceof Int32Array,
          'Typed array classes',
        )
        check(
          distances.length === n && parents.length === n,
          'Nonzero full row lengths',
        )
        check(
          distances.buffer === trees[0].distances.buffer &&
            parents.buffer === trees[0].parents.buffer,
          'Row buffer sharing',
        )
        check(
          distances.byteOffset === row * n * 8 &&
            parents.byteOffset === row * n * 4,
          'Origin-major byte offsets',
        )
        check(
          distances.buffer.byteLength === origins.length * n * 8 &&
            parents.buffer.byteLength === origins.length * n * 4,
          'Exact owned flat block sizes',
        )
        check(
          distances[origins[row]] === 0 && parents[origins[row]] === -1,
          'Origin sentinel',
        )
        check(
          distances.some(
            (distance) => Number.isFinite(distance) && distance > 0,
          ),
          'Nonzero real road distances',
        )
      }
      const expected = referenceFind(network, { origins, objective })
      expected.trees.forEach((tree, row) => {
        compareArray(
          trees[row].distances,
          tree.distances,
          `distances row ${row}`,
        )
        compareArray(trees[row].parents, tree.parents, `parents row ${row}`)
      })
      check(
        JSON.stringify(results) === JSON.stringify(expected.results),
        'Ranked result parity',
      )
      check(
        JSON.stringify(reply.collisions) ===
          JSON.stringify(
            referenceCollisions({ network, trees: expected.trees, origins }),
          ),
        'Collision parity',
      )
      session.saved.push(
        ...trees.flatMap((tree) => [
          { actual: tree.distances, expected: tree.distances.slice() },
          { actual: tree.parents, expected: tree.parents.slice() },
        ]),
      )
      return {
        id,
        rows: trees.length,
        nodes: n,
        uniqueBuffers: buffers.size,
        outputBytes: [...buffers].reduce(
          (sum, buffer) => sum + buffer.byteLength,
          0,
        ),
        offsets: trees.map((tree) => [
          tree.distances.byteOffset,
          tree.parents.byteOffset,
        ]),
        results: results.length,
        exactTreesRanksCollisions: true,
      }
    },
    stable(key) {
      const saved = get(key).saved
      check(saved.length > 0, 'No owned outputs saved')
      for (const entry of saved)
        compareArray(
          entry.actual,
          entry.expected,
          'Earlier owned output changed',
        )
      return { checkedArrays: saved.length, unchanged: true }
    },
    violations: () => violations,
    ownedExports: readOwnedExports,
  }
}

// Real generated exports, small deterministic graph. This is deliberately in
// another realm from the worker and is not a JS fallback or an injected module.
async function ownedExports(bindings) {
  const check = (condition, label) => {
    if (!condition) throw new Error(label)
  }
  const wasm = await bindings.default()
  const graph = new bindings.MeetingSearch(
    3,
    new Uint32Array([0, 1, 1, 2]),
    new Float64Array([2, 3]),
  )
  let batch
  let next
  let terminal = false
  try {
    batch = graph.solve(new Uint32Array([0, 2]))
    const distances = batch.take_distances()
    const parents = batch.take_parents()
    check(
      distances instanceof Float64Array && parents instanceof Int32Array,
      'Owned export types',
    )
    check(
      distances.buffer !== parents.buffer &&
        distances.buffer !== wasm.memory.buffer &&
        parents.buffer !== wasm.memory.buffer,
      'Exports must own two non-WASM buffers',
    )
    check(JSON.stringify([...distances]) === '[0,2,5,5,3,0]', 'Owned distances')
    check(JSON.stringify([...parents]) === '[-1,0,1,1,2,-1]', 'Owned parents')
    const errors = []
    for (const method of ['take_distances', 'take_parents']) {
      try {
        batch[method]()
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) throw error
        errors.push({ method, name: error.name, message: error.message })
      }
    }
    check(
      errors.length === 2 && errors.every((error) => error.message.length > 0),
      'Repeated take must return an error',
    )
    batch.free()
    batch = null
    next = graph.solve(new Uint32Array([1, 1]))
    next.take_distances()
    next.take_parents()
    next.free()
    next = null
    const memoryBefore = wasm.memory.buffer.byteLength
    wasm.memory.grow(1)
    const memoryAfter = wasm.memory.buffer.byteLength
    check(
      memoryAfter === memoryBefore + 65536,
      'Real memory.grow did not add one page',
    )
    check(
      JSON.stringify([...distances]) === '[0,2,5,5,3,0]' &&
        JSON.stringify([...parents]) === '[-1,0,1,1,2,-1]',
      'Owned exports changed after solve/memory.grow',
    )
    // Confirm generated cached views refresh after memory.grow as well.
    next = graph.solve(new Uint32Array([0, 2]))
    check(
      JSON.stringify([...next.take_distances()]) === '[0,2,5,5,3,0]',
      'Solve after memory.grow',
    )
    next.take_parents()
    return {
      uniqueBuffers: 2,
      bytes: [distances.byteLength, parents.byteLength],
      repeatedTakeErrors: errors,
      memoryBefore,
      memoryAfter,
      stableAfterLaterSolveAndMemoryGrow: true,
    }
  } catch (error) {
    terminal = error instanceof WebAssembly.RuntimeError
    if (terminal) window.meetingSeamQuarantine = [graph, batch, next]
    throw error
  } finally {
    // An unexpected real trap also fails closed: retain wrappers so generated
    // finalizers cannot re-enter the module while the failure is reported.
    if (!terminal) {
      try {
        next?.free()
        batch?.free()
        graph.free()
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError)
          window.meetingSeamQuarantine = [graph, batch, next]
        throw error
      }
    }
  }
}

async function build(vite, temporaries) {
  const source = await mkdtemp(join(root, '.meeting-wasm-seams-'))
  const outDir = await mkdtemp(join(tmpdir(), 'meeting-wasm-seams-'))
  temporaries.push(source, outDir)
  const html = join(source, 'index.html')
  await writeFile(
    html,
    '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Real WASM worker seams</title><script type="module" src="./entry.js"></script></head><body>Local real WASM worker seams</body></html>\n',
  )
  await writeFile(
    join(source, 'entry.js'),
    `import { prepareMeetingSearch } from '../src/lib/meeting-point.ts';\nimport { findSearchCollisions } from '../src/lib/meeting-collisions.ts';\n(${installHarness.toString()})(() => new Worker(new URL('../scripts/meeting-bench/wasm.worker.ts', import.meta.url), { type: 'module' }), (network, request) => prepareMeetingSearch(network).find(request), findSearchCollisions, async () => (${ownedExports.toString()})(await import('../crates/meeting-point/pkg/meeting_point.js')));\n`,
  )
  const workerModules = new Set()
  await vite.build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    mode: 'meeting-benchmark',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { alias: { '@': join(root, 'src') } },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      assetsInlineLimit: 0,
      rolldownOptions: { input: html },
    },
    worker: {
      format: 'es',
      plugins: () => [
        {
          name: 'meeting-seams:worker-modules',
          load(id) {
            workerModules.add(vite.normalizePath(id))
            return null
          },
        },
      ],
    },
  })
  const modules = [...workerModules].sort()
  assert(
    modules.some((id) => id.endsWith('/scripts/meeting-bench/wasm.worker.ts')),
    'Actual prototype worker was not bundled',
  )
  assert(
    modules.some((id) =>
      id.endsWith('/crates/meeting-point/pkg/meeting_point.js'),
    ),
    'Real generated bindings missing from worker',
  )
  assert(
    !modules.some((id) => id.endsWith('/src/scripts/meeting-point.worker.ts')),
    'Candidate imported the original worker',
  )
  const assets = await files(outDir)
  assert(
    assets.some((asset) => /-[\w-]+\.wasm$/.test(asset.path)),
    'Missing external hashed WASM asset',
  )
  assert(
    assets.some((asset) => /wasm\.worker-[\w-]+\.js$/.test(asset.path)),
    'Missing hashed module-worker asset',
  )
  return {
    outDir,
    pagePath: `/${relative(root, html).split(sep).join('/')}`,
    workerModules: modules,
    assets,
    mode: 'meeting-benchmark',
  }
}

async function serve(directory, fixture) {
  let scenario = 'startup'
  let wasmMode = 'normal'
  let releaseHeld = null
  let sawWasm = null
  const requests = []
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.json': 'application/json; charset=utf-8',
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const entry = {
      scenario,
      path,
      method: request.method,
      at: performance.now(),
      status: null,
      mime: null,
      finished: false,
      closed: false,
      wasmMode: path.endsWith('.wasm') ? wasmMode : null,
    }
    requests.push(entry)
    response.on('finish', () => {
      entry.finished = true
      entry.finishedAt = performance.now()
    })
    response.on('close', () => {
      entry.closed = true
      entry.closedAt = performance.now()
    })
    const send = (status, bytes, type) => {
      entry.status = status
      entry.mime = type
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(bytes)
    }
    try {
      if (path === '/fixture.json') {
        send(200, fixture, mime['.json'])
        return
      }
      const file = resolve(directory, `.${decodeURIComponent(path)}`)
      if (
        !file.startsWith(`${directory}${sep}`) ||
        !(await stat(file)).isFile()
      ) {
        send(404, Buffer.from('Not found'), 'text/plain')
        return
      }
      const bytes = await readFile(file)
      if (path.endsWith('.wasm')) {
        const mode = wasmMode
        if (mode === 'delay') {
          const held = Promise.withResolvers()
          releaseHeld = held.resolve
          sawWasm?.resolve(entry)
          await bounded(held.promise, 'release actual WASM response')
          releaseHeld = null
          if (response.destroyed) return
        } else sawWasm?.resolve(entry)
        if (mode === 'fail') {
          send(
            503,
            Buffer.from('Deliberate local WASM HTTP failure'),
            'text/plain',
          )
          return
        }
      }
      send(200, bytes, mime[extname(file)] ?? 'application/octet-stream')
    } catch (error) {
      entry.error = String(error)
      if (!response.headersSent && !response.destroyed)
        send(500, Buffer.from(String(error)), 'text/plain')
      else response.destroy()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string', 'No server address')
  return {
    server,
    requests,
    url: `http://127.0.0.1:${address.port}`,
    begin(name, mode = 'normal') {
      assert(!releaseHeld, 'Previous delayed response is still held')
      scenario = name
      wasmMode = mode
      sawWasm = Promise.withResolvers()
    },
    waitWasm: () => bounded(sawWasm.promise, 'real WASM request'),
    release: () => releaseHeld?.(),
    normal: () => {
      wasmMode = 'normal'
    },
  }
}

async function profile(worker) {
  return worker.evaluate(
    (names) => ({
      url: self.location.href,
      timeOrigin: performance.timeOrigin,
      entries: performance
        .getEntriesByType('measure')
        .filter((entry) => names.includes(entry.name))
        .map((entry) => ({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          detail: entry.detail,
        })),
    }),
    MEASURES,
  )
}
function auditProfile(observation, resultCount) {
  for (const name of MEASURES)
    assert(
      observation.entries.some((entry) => entry.name === name),
      `Missing real worker measure ${name}`,
    )
  const transfers = observation.entries.filter(
    (entry) => entry.name === 'meeting:wasm:transfer',
  )
  assert(
    transfers.length === resultCount,
    `Expected ${resultCount} actual transfer measures, got ${transfers.length}`,
  )
  assert(
    observation.entries.some(
      (entry) =>
        Number.isSafeInteger(entry.detail?.memoryBytes) &&
        entry.detail.memoryBytes > 0,
    ),
    'No actual committed WASM memory observation',
  )
  for (const { detail } of transfers) {
    assert(
      detail?.buffersBefore === 2 && detail.buffersAfter === 0,
      'Post did not detach exactly two buffers',
    )
    assert(
      detail.distancesBytesBefore > 0 &&
        detail.parentsBytesBefore > 0 &&
        detail.distancesBytesAfter === 0 &&
        detail.parentsBytesAfter === 0,
      'Invalid sender transfer byte lengths',
    )
    assert(
      detail.outputBytes ===
        detail.distancesBytesBefore + detail.parentsBytesBefore,
      'Transfer output byte total',
    )
  }
  // Exact detachment scalars are retained verbatim: no invented memory or copies.
  return { ...observation, expectedSuccessfulPosts: resultCount }
}

async function runBrowser(browser, serving, buildInfo, network) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const origin = new URL(serving.url).origin
  const blocked = []
  await context.route(
    (url) => url.origin !== origin,
    (route) => {
      blocked.push(route.request().url())
      return route.abort('blockedbyclient')
    },
  )
  const page = await context.newPage()
  page.setDefaultTimeout(TIMEOUT)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const browserRequestFailures = []
  page.on('requestfailed', (request) =>
    browserRequestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText ?? null,
    }),
  )
  const scenarios = []
  const initialRequests = serving.requests.length
  try {
    await page.goto(`${serving.url}${buildInfo.pagePath}`)
    await page.waitForFunction(() => Boolean(window.seams))
    const spawn = async (key) => {
      const appeared = page.waitForEvent('worker')
      await page.evaluate((key) => window.seams.spawn(key), key)
      return appeared
    }
    const post = (key, messages) =>
      page.evaluate(({ key, messages }) => window.seams.post(key, messages), {
        key,
        messages,
      })
    const wait = (key, kind, id = null) =>
      page.waitForFunction(
        ({ key, kind, id }) => window.seams.has(key, kind, id),
        { key, kind, id },
      )
    const snapshot = (key) =>
      page.evaluate((key) => window.seams.snapshot(key), key)
    const audit = (
      key,
      id,
      graph = network,
      origins = [0, 1],
      objective = 'fair',
    ) =>
      page.evaluate(
        ({ key, id, graph, origins, objective }) =>
          window.seams.audit(key, id, graph, origins, objective),
        { key, id, graph, origins, objective },
      )
    const stable = (key) =>
      page.evaluate((key) => window.seams.stable(key), key)
    const terminate = async (key, worker) => {
      const closed = new Promise((resolve) => worker.once('close', resolve))
      await page.evaluate((key) => window.seams.terminate(key), key)
      await bounded(closed, `worker ${key} closes`)
    }
    const attach = (graph = network) => ({ kind: 'attach', network: graph })
    const search = (id, origins = [0, 1], objective = 'fair') => ({
      kind: 'search',
      id,
      origins,
      objective,
    })
    const expectKinds = (value, expected) =>
      assert(
        JSON.stringify(
          value.replies
            .filter((reply) => reply.kind !== 'progress')
            .map((reply) => [reply.kind, reply.id ?? null]),
        ) === JSON.stringify(expected),
        `Unexpected reply order or attach ACK: ${JSON.stringify(value)}`,
      )

    serving.begin('delayed-immediate-attach-search', 'delay')
    let worker = await spawn('delayed')
    await post('delayed', [attach(), search(101)])
    await serving.waitWasm()
    const held = await snapshot('delayed')
    assert(
      held.replies.length === 0,
      'Attach/search replied before real delayed WASM was available',
    )
    serving.release()
    await wait('delayed', 'result', 101)
    const first = await audit('delayed', 101)
    expectKinds(await snapshot('delayed'), [['result', 101]])

    // Original invalid IDs and real messages, followed by a valid command in the
    // same posted batch: an ordinary failure must not poison the private FIFO.
    const invalidIds = [201, 202, 203, 204, 205, 206, 207]
    // Playwright transports NaN and sparse values through evaluate; construct
    // the hole in-page so it tests actual origin validation, not JSON omission.
    await page.evaluate(
      ({ graphSize }) => {
        window.seams.post('delayed', [
          { kind: 'search', id: 201, origins: [0], objective: 'fair' },
          { kind: 'search', id: 202, origins: [-1, 1], objective: 'fair' },
          { kind: 'search', id: 203, origins: [0.5, 1], objective: 'fair' },
          { kind: 'search', id: 204, origins: [NaN, 1], objective: 'fair' },
          { kind: 'search', id: 205, origins: [2 ** 32, 1], objective: 'fair' },
          {
            kind: 'search',
            id: 206,
            origins: [graphSize, 1],
            objective: 'fair',
          },
          { kind: 'search', id: 207, origins: [0, , 1], objective: 'fair' },
          { kind: 'search', id: 208, origins: [1, 0], objective: 'total' },
        ])
      },
      { graphSize: network.nodes.length },
    )
    await wait('delayed', 'result', 208)
    const valid = await audit('delayed', 208, network, [1, 0], 'total')
    const invalidReplies = (await snapshot('delayed')).replies.filter(
      (reply) => reply.kind === 'error',
    )
    assert(
      invalidReplies.length === invalidIds.length &&
        invalidReplies.every(
          (reply, index) =>
            reply.id === invalidIds[index] &&
            typeof reply.message === 'string' &&
            reply.message.length > 0,
        ),
      'Invalid requests lost IDs/errors or stalled FIFO',
    )
    const originalStable = await stable('delayed')

    // A different real graph instance with changed road costs proves replacement
    // rather than accidentally reusing a previous prepared session.
    const replacement = {
      ...network,
      name: `${network.name} (doubled edge costs)`,
      edges: network.edges.map(([a, b, weight]) => [a, b, weight * 2]),
    }
    await post('delayed', [attach(replacement), search(301)])
    await wait('delayed', 'result', 301)
    const replaced = await audit('delayed', 301, replacement)
    const replacementStable = await stable('delayed')
    const completed = await snapshot('delayed')
    expectKinds(completed, [
      ['result', 101],
      ...invalidIds.map((id) => ['error', id]),
      ['result', 208],
      ['result', 301],
    ])
    const evidence = auditProfile(await profile(worker), 3)
    scenarios.push({
      name: 'delayed-immediate-attach-search-invalid-recovery-replacement',
      first,
      held,
      valid,
      invalidReplies,
      originalStable,
      replaced,
      replacementStable,
      replies: completed.replies,
      worker: evidence,
    })
    await terminate('delayed', worker)

    serving.begin('load-queued-search')
    worker = await spawn('load')
    await post('load', [
      {
        kind: 'load',
        request: { kind: 'preset', dataUrl: '/fixture.json' },
        landmarks: [
          { name: 'First fixture node', coordinate: network.nodes[0] },
        ],
      },
      search(401),
    ])
    await wait('load', 'result', 401)
    const loaded = await snapshot('load')
    expectKinds(loaded, [
      ['ready', null],
      ['result', 401],
    ])
    const ready = loaded.replies.find((reply) => reply.kind === 'ready')
    assert(
      ready.delivery === 'bundled' && ready.landmarks[0].node === 0,
      'Load did not preserve real loader/landmark behavior',
    )
    scenarios.push({
      name: 'load-queued-search',
      replies: loaded.replies,
      output: await audit('load', 401),
      worker: auditProfile(await profile(worker), 1),
    })
    await terminate('load', worker)

    serving.begin('failed-real-wasm-fetch', 'fail')
    worker = await spawn('failed')
    await post('failed', [attach(), search(501), attach(), search(502)])
    await serving.waitWasm()
    await wait('failed', 'error', 502)
    const failed = await snapshot('failed')
    expectKinds(failed, [
      ['error', null],
      ['error', 501],
      ['error', null],
      ['error', 502],
    ])
    const messages = failed.replies.map((reply) => reply.message)
    assert(
      messages.every(
        (message) => typeof message === 'string' && message.length > 0,
      ),
      'Failed requests lost real errors',
    )
    assert(
      messages[0] === messages[2],
      'Repeated attach lost the cached original initialization error',
    )
    assert(
      messages[1] === messages[3],
      'Queued unprepared searches reported inconsistent errors',
    )
    scenarios.push({
      name: 'failed-real-wasm-fetch',
      replies: failed.replies,
      worker: await profile(worker),
    })
    await terminate('failed', worker)

    // Deterministic pending search: hold a real module response, never a giant
    // graph or unsafe kernel interruption. A new realm must recover afterward.
    serving.begin('terminate-pending-search', 'delay')
    worker = await spawn('pending')
    await post('pending', [attach(), search(601)])
    await serving.waitWasm()
    const pending = await snapshot('pending')
    assert(pending.replies.length === 0, 'Pending search already replied')
    const pendingProfile = await profile(worker)
    await terminate('pending', worker)
    serving.release()
    serving.normal()
    const recoveredWorker = await spawn('recovered')
    await post('recovered', [attach(), search(602)])
    await wait('recovered', 'result', 602)
    expectKinds(await snapshot('recovered'), [['result', 602]])
    const terminated = await snapshot('pending')
    assert(
      terminated.replies.length === 0 && terminated.terminated,
      'Terminated session delivered a stale reply',
    )
    scenarios.push({
      name: 'terminate-pending-search-new-worker-recovery',
      pending,
      terminated,
      pendingProfile,
      recovery: await audit('recovered', 602),
      worker: auditProfile(await profile(recoveredWorker), 1),
      cancellationScope:
        'Worker terminated while real WASM fetch and search were pending; synchronous kernel cancellation NOT exercised',
    })
    await terminate('recovered', recoveredWorker)

    serving.begin('owned-exports')
    const exportsEvidence = await bounded(
      page.evaluate(() => window.seams.ownedExports()),
      'real owned exports',
    )
    scenarios.push({ name: 'owned-exports', ...exportsEvidence })
    const violations = await page.evaluate(() => window.seams.violations())
    assert(!violations.length, `CSP violations: ${JSON.stringify(violations)}`)
    assert(!blocked.length, `External requests: ${blocked.join(', ')}`)
    assert(!errors.length, `Page runtime errors: ${errors.join(', ')}`)
    assert(
      page.workers().length === 0,
      'Live worker targets remain after termination',
    )
    const requests = serving.requests.slice(initialRequests)
    const wasmRequests = requests.filter((entry) =>
      entry.path.endsWith('.wasm'),
    )
    const failedWasm = wasmRequests.filter((entry) => entry.status === 503)
    assert(
      failedWasm.length > 0 &&
        failedWasm.every(
          (entry) => entry.scenario === 'failed-real-wasm-fetch',
        ),
      'Missing or unexpected real module request failures',
    )
    assert(
      failedWasm.length === 1,
      'Failed initialization retried the module fetch instead of caching its outcome',
    )
    assert(
      wasmRequests.some(
        (entry) => entry.status === 200 && entry.mime === 'application/wasm',
      ),
      'No real application/wasm response',
    )
    assert(
      requests
        .filter((entry) => entry.path.endsWith('.js'))
        .every(
          (entry) =>
            entry.status === 200 && entry.mime.startsWith('text/javascript'),
        ),
      'Incorrect module script MIME/status',
    )
    assert(
      requests.every(
        (entry) =>
          !(entry.status >= 400) ||
          (entry.path.endsWith('.wasm') &&
            entry.scenario === 'failed-real-wasm-fetch'),
      ),
      'Unexpected local HTTP failure',
    )
    return {
      status: 'passed',
      browserVersion: browser.version(),
      scenarios,
      requests,
      browserRequestFailures,
      counts: {
        requests: requests.length,
        moduleScripts: requests.filter((entry) => entry.path.endsWith('.js'))
          .length,
        wasmRequests: wasmRequests.length,
        failedWasmResponses: failedWasm.length,
        unfinishedWasmRequests: wasmRequests.filter((entry) => !entry.finished)
          .length,
        httpFailures: requests.filter((entry) => entry.status >= 400).length,
        serverErrors: requests.filter((entry) => entry.error).length,
        browserRequestFailures: browserRequestFailures.length,
      },
      csp: { policy: CSP, violations },
      blocked,
      pageErrors: errors,
      liveWorkersAfterTermination: page.workers().length,
    }
  } finally {
    serving.release()
    await context.close()
  }
}

async function main(config) {
  const report = {
    schemaVersion: 1,
    contract: 'meeting-phase1 r4 real browser seams',
    startedAt: new Date().toISOString(),
    config,
    status: 'running',
    browsers: [],
    terminalTrap: {
      runtime: 'unexercised',
      reason:
        'No safe real trap seam; no injected RuntimeError, giant actual-OOM allocation or unsafe pointer probe. Source lifecycle review is separate from exercised browser evidence.',
    },
    limitations: [
      'Local Vite packaging/CSP evidence is not deployed Cloudflare MIME/CSP evidence.',
      'This CLI tests the real worker protocol, not React stale-session rendering; use meeting-ui-bench.mjs for the full UI reuse/cached rerank/busy-cancel matrix.',
      'Termination is during pending initialization/search, not inside the synchronous native kernel.',
      'WebKit availability is recorded explicitly; Playwright WebKit does not establish Safari GPU behavior.',
    ],
  }
  const temporaries = []
  let serving
  let activeBrowser
  const interrupt = () => {
    serving?.release()
    void activeBrowser
      ?.close()
      .catch((error) => process.stderr.write(`${error}\n`))
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const [vite, playwright] = await Promise.all([
      import('vite'),
      import('playwright'),
    ])
    const fixturePath = join(
      root,
      'scripts/meeting-bench/fixtures/west-oakland.json',
    )
    const fixture = await readFile(fixturePath)
    const network = JSON.parse(fixture)
    report.fixture = {
      path: relative(root, fixturePath),
      sha256: sha256(fixture),
      nodes: network.nodes.length,
      edges: network.edges.length,
      attribution: network.attribution,
      source: network.source,
    }
    // Snapshot real lifecycle/glue sources for the owner's independent review.
    report.sourceEvidence = []
    for (const path of [
      'src/lib/meeting-search.ts',
      'scripts/meeting-bench/wasm.worker.ts',
      'crates/meeting-point/pkg/meeting_point.js',
    ]) {
      const text = await readFile(join(root, path), 'utf8')
      const lines = text.split('\n')
      const relevant = new Set()
      lines.forEach((text, index) => {
        if (
          /RuntimeError|FinalizationRegistry|owners|release\(|terminal|queue|take_distances|take_parents|\.slice\(|__wbindgen_free/.test(
            text,
          )
        )
          for (
            let line = Math.max(0, index - 2);
            line <= Math.min(lines.length - 1, index + 5);
            line++
          )
            relevant.add(line)
      })
      report.sourceEvidence.push({
        path,
        sha256: sha256(text),
        lifecycleAndOwnedExportLines: [...relevant]
          .sort((a, b) => a - b)
          .map((index) => ({ line: index + 1, text: lines[index] })),
      })
    }
    const buildInfo = await build(vite, temporaries)
    const { outDir, ...packaging } = buildInfo
    report.packaging = packaging
    serving = await serve(outDir, fixture)
    for (const name of ['chromium', 'firefox', 'webkit']) {
      if (!config.browsers.includes(name)) {
        report.browsers.push({
          name,
          status: 'not-requested',
          reason: 'Excluded by --browser; no coverage claimed',
        })
        continue
      }
      try {
        activeBrowser = await playwright[name].launch({ headless: true })
      } catch (error) {
        if (
          /Executable doesn't exist|Host system is missing dependencies/.test(
            String(error),
          )
        ) {
          report.browsers.push({
            name,
            status: 'unavailable',
            reason: String(error),
            executablePath: playwright[name].executablePath(),
          })
          continue
        }
        throw error
      }
      try {
        report.browsers.push({
          name,
          ...(await bounded(
            runBrowser(activeBrowser, serving, buildInfo, network),
            `${name} browser seams`,
            180_000,
          )),
        })
      } catch (error) {
        report.browsers.push({
          name,
          status: 'failed',
          error: error.stack ?? String(error),
          requests: [...serving.requests],
        })
        process.exitCode = 1
      } finally {
        await activeBrowser.close()
        activeBrowser = null
      }
    }
    assert(
      report.browsers.some((entry) => entry.status === 'passed'),
      'No requested browser exercised the real seams',
    )
    report.status = report.browsers.some((entry) => entry.status === 'failed')
      ? 'failed'
      : 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.stack ?? String(error)
    process.exitCode = 1
  } finally {
    serving?.release()
    try {
      await activeBrowser?.close()
      if (serving)
        await new Promise((resolve, reject) => {
          serving.server.close((error) => (error ? reject(error) : resolve()))
          serving.server.closeAllConnections()
        })
      for (const directory of temporaries)
        await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      report.status = 'failed'
      report.cleanupError = String(error)
      process.exitCode = 1
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    report.finishedAt = new Date().toISOString()
    await mkdir(dirname(config.out), { recursive: true })
    await writeFile(config.out, `${JSON.stringify(report, null, 2)}\n`)
    process.stderr.write(`${report.status}: ${config.out}\n`)
  }
}

try {
  const config = options(process.argv.slice(2))
  if (config) await main(config)
  else process.stdout.write(help)
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
}
