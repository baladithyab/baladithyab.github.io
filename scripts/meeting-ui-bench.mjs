#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { summarize } from './meeting-bench/statistics.mjs'
import { assessCoverage } from './meeting-bench/gates.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WARMUPS = 2
const OBJECTIVES = ['fair', 'total']
const TIMEOUT = 120_000
const VIEWPORT = { width: 1280, height: 1100 }
// Production sfRegion.dataUrl: the default preset fetches the fixture here.
const FIXTURE_URL = '/lab/meeting-point/sf.json'
const MAX_TARGET_OFFSET_METRES = 50
const GATE = {
  warmImprovementPct: 20,
  warmImprovementMs: 10,
  groups: [4, 16],
  objectives: OBJECTIVES,
  p95: 'candidate p95 <= baseline p95',
  coldRegressionPct: 5,
  cachedRegressionPct: 5,
  promotionWarmSamples: 100,
  promotionLaunches: 3,
  warmMetric: 'clickToFrameMs',
  coldMetric: 'navigationToFirstResultsFrameMs',
  coldFindEnabledMetric: 'navigationToFindEnabledMs',
  coldFirstSearchMetric: 'firstSearch.clickToFrameMs',
  workerMetric: 'dispatchToReplyMs',
  cachedMetric: 'clickToFrameMs',
}
const help = `Meeting-point production-UI benchmark: the real MeetingPoint island and production worker

Usage: node scripts/meeting-ui-bench.mjs --out PATH [options]

  --engine current,scalar,worker    Builds measured interleaved; the first is the comparison baseline
                                    (default: current)
  --worker PATH                     Module replacing src/scripts/meeting-point.worker.ts at compile time;
                                    it must speak the meeting-session protocol (requires --engine worker)
  --fixture PATH                    Normalized local MeetingNetwork JSON served at the SF preset URL
                                    (default: bundled SF)
  --groups 4,16                     Starting-point counts for warm/cached samples, 2-26 (default: 4,16)
  --samples N                       Measured warm samples per group/objective per launch after 2 warmups
                                    (default: 20; minimum: 20)
  --cold-samples N                  Cold samples per engine, each in a fresh browser process
                                    (default: 20; minimum: 20)
  --runs N                          Fresh warm launches per engine (default: 1)
  --browser chromium,firefox,webkit Browsers (default: all three; missing executables are reported)
  --chromium-channel chromium       Optional full Chromium; requires --browser chromium only.
                                    Supplemental renderer/control evidence, NEVER promotion evidence.
  --canvas-profile                  Opt-in Canvas2D native-call counters/timers + Chromium CDP trace.
                                    Requires --browser chromium --chromium-channel chromium --artifacts DIR.
                                    Diagnostic only; NEVER promotion or GPU-completion evidence.
  --profile baseline,cpu4           Profiles (default: both; cpu4 is Chromium-only)
  --seed N                          Nonnegative 32-bit origin-placement seed (default: 2119)
  --artifacts DIR                   UI screenshots and diagnostic trace files (never production assets)
  --smoke                           Default 3 warm and 2 cold samples; permits fewer; NEVER gate evidence
  --out PATH                        Required machine-readable JSON destination (overwritten)
  --help                            Print this help without loading Vite/Playwright

Examples:
  node scripts/meeting-ui-bench.mjs --smoke --browser chromium --profile baseline --out meeting-ui-smoke.json
  node scripts/meeting-ui-bench.mjs --engine current,scalar --browser chromium --profile baseline --out meeting-ui-phase0.json
  node scripts/meeting-ui-bench.mjs --engine scalar,worker --worker scripts/meeting-bench/wasm.worker.ts --runs 3 --samples 34 --out meeting-ui-candidate.json
  node scripts/meeting-ui-bench.mjs --engine current --smoke --browser chromium --chromium-channel chromium --profile baseline --canvas-profile --artifacts canvas-traces --out canvas-profile.json

Builds the real component, CSS and production worker with installed Vite/Tailwind into
disposable directories; serves the fixture locally; blocks every non-local request.
Cold: fresh browser process per sample, navigation to the first ranked-results frame
with the production default starting points. Warm: retained production worker; both
objectives get independent origin cohorts for every group, and every sample moves
every start by real map clicks and must post one new worker search.
Cached: change to the opposite objective through the real radio, then Find; must post nothing.
CPU4 is page-only CDP throttling: worker throttling is UNVERIFIED.
Worker performance entries are collected directly before unload; no protocol messages are added.
Build mode is meeting-benchmark with production React. WASM requires build:wasm:meeting first.
Promotion evidence needs >=3 runs and >=100 pooled warm samples per group/objective, no --smoke.
Canvas profiling perturbs timing: per-context stroke/drawImage synchronous durations,
path-call counters and lineTo-per-stroke bins are diagnostic only. Interaction-window
deltas include the two-frame settle confirmation; residual RAF CPU includes profiler
overhead and other native work, not just JS loops. CDP traces cover individual warm
playback/seek/pan/fit windows only, with finite time/buffer/file limits and loss flags.
No readbacks, forced GPU synchronization, disabled draws or GPU-performance inference
from default headless-shell/SwiftShader. Recompare candidates WITHOUT this flag.
`

class BrowserUnavailable extends Error {}

function options(args) {
  if (args.includes('--help')) return null
  const flags = new Map()
  let smoke = false
  let canvasProfile = false
  const accepted = new Set([
    '--engine',
    '--worker',
    '--fixture',
    '--groups',
    '--samples',
    '--cold-samples',
    '--runs',
    '--browser',
    '--chromium-channel',
    '--profile',
    '--seed',
    '--artifacts',
    '--out',
  ])
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--smoke') {
      if (smoke) throw new Error('Duplicate --smoke')
      smoke = true
    } else if (flag === '--canvas-profile') {
      if (canvasProfile) throw new Error('Duplicate --canvas-profile')
      canvasProfile = true
    } else {
      if (!accepted.has(flag))
        throw new Error(`Unknown option ${flag}; use --help`)
      if (flags.has(flag)) throw new Error(`Duplicate ${flag}`)
      const value = args[++i]
      if (!value || value.startsWith('--'))
        throw new Error(`${flag} requires a value`)
      flags.set(flag, value)
    }
  }
  function list(flag, fallback, allowed) {
    const values = (flags.get(flag) ?? fallback).split(',')
    if (
      values.some((value) => !allowed.includes(value)) ||
      new Set(values).size !== values.length
    )
      throw new Error(
        `${flag} must contain unique choices from ${allowed.join(',')}`,
      )
    return values
  }
  function integer(flag, fallback, minimum, maximum) {
    const value = Number(flags.get(flag) ?? fallback)
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(
        `${flag} must be an integer from ${minimum} to ${maximum}`,
      )
    return value
  }
  if (!flags.has('--out')) throw new Error('--out PATH is required; use --help')
  const engines = list('--engine', 'current', ['current', 'scalar', 'worker'])
  const worker = flags.has('--worker') ? resolve(flags.get('--worker')) : null
  if (engines.includes('worker') !== (worker !== null))
    throw new Error('--engine worker and --worker PATH must be used together')
  const groups = (flags.get('--groups') ?? '4,16').split(',').map(Number)
  if (
    groups.some(
      (size) => !Number.isSafeInteger(size) || size < 2 || size > 26,
    ) ||
    new Set(groups).size !== groups.length
  )
    throw new Error('--groups must contain unique integers from 2 to 26')
  const fixture = resolve(
    flags.get('--fixture') ?? join(root, 'public/lab/meeting-point/sf.json'),
  )
  const out = resolve(flags.get('--out'))
  if (fixture === out) throw new Error('--out must not overwrite the fixture')
  const browsers = list('--browser', 'chromium,firefox,webkit', [
    'chromium',
    'firefox',
    'webkit',
  ])
  const chromiumChannel = flags.get('--chromium-channel') ?? null
  if (
    chromiumChannel !== null &&
    (chromiumChannel !== 'chromium' ||
      browsers.length !== 1 ||
      browsers[0] !== 'chromium')
  )
    throw new Error(
      '--chromium-channel chromium requires --browser chromium only',
    )
  if (
    canvasProfile &&
    (chromiumChannel !== 'chromium' ||
      browsers.length !== 1 ||
      browsers[0] !== 'chromium' ||
      !flags.has('--artifacts'))
  )
    throw new Error(
      '--canvas-profile requires --browser chromium --chromium-channel chromium --artifacts DIR',
    )
  return {
    engines,
    worker,
    fixture,
    groups,
    out,
    smoke,
    canvasProfile,
    samples: integer('--samples', smoke ? 3 : 20, smoke ? 1 : 20, 10000),
    coldSamples: integer(
      '--cold-samples',
      smoke ? 2 : 20,
      smoke ? 1 : 20,
      1000,
    ),
    runs: integer('--runs', 1, 1, 100),
    browsers,
    chromiumChannel,
    profiles: list('--profile', 'baseline,cpu4', ['baseline', 'cpu4']),
    seed: integer('--seed', 2119, 0, 0xffffffff),
    artifacts: flags.has('--artifacts')
      ? resolve(flags.get('--artifacts'))
      : null,
  }
}

async function phase(name, context, task) {
  try {
    return await task()
  } catch (error) {
    if (error instanceof BrowserUnavailable) throw error
    throw new Error(
      `${name} failed ${JSON.stringify(context)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

async function until(label, check, timeout = TIMEOUT) {
  const end = performance.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (performance.now() > end)
      throw new Error(`${label}: timed out after ${timeout} ms`)
    await new Promise((done) => setTimeout(done, 25))
  }
}

const letter = (index) =>
  String.fromCharCode(65 + (index % 26)) +
  (index >= 26 ? String(Math.floor(index / 26)) : '')
const digest = (value) => createHash('sha256').update(value).digest('hex')

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function assetSizes(directory, base = directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await assetSizes(path, base)))
    else {
      const bytes = await readFile(path)
      files.push({
        path: relative(base, path).split(sep).join('/'),
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes).length,
        brotliBytes: brotliCompressSync(bytes).length,
      })
    }
  }
  return files
}

async function serve(directory, fixture) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
  }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? '/', 'http://localhost').pathname,
      )
      if (pathname === FIXTURE_URL) {
        response.writeHead(200, {
          'Content-Type': mime['.json'],
          'Content-Length': fixture.length,
          'Cache-Control': 'no-store',
        })
        response.end(fixture)
        return
      }
      const path = resolve(directory, `.${pathname}`)
      if (!path.startsWith(`${directory}${sep}`)) {
        response.writeHead(403).end('Forbidden')
        return
      }
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Not a file')
      response.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
      })
      const stream = createReadStream(path)
      stream.on('error', (error) => response.destroy(error))
      response.on('close', () => stream.destroy())
      stream.pipe(response)
    } catch {
      if (!response.headersSent) response.writeHead(404).end('Not found')
      else response.destroy()
    }
  })
  const { promise, resolve: listening, reject } = Promise.withResolvers()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', listening)
  await promise
  server.removeListener('error', reject)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing benchmark server address')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

// One production-equivalent client build. `scalar` aliases '@/lib/meeting-point'
// to scalar-core.ts everywhere (including the production worker bundle);
// `worker` replaces the production worker module itself. The worker bundle's
// module list is checked so a missed alias/replacement fails instead of
// silently measuring the current engine.
async function buildEngine({
  vite,
  tailwindcss,
  engine,
  worker,
  html,
  temporaries,
  canvasProfile,
}) {
  const outDir = await mkdtemp(join(tmpdir(), `meeting-ui-bench-${engine}-`))
  temporaries.push(outDir)
  const key = (id) => {
    const path = vite.normalizePath(id.split('?')[0])
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  const paths = {
    productionWorker: key(join(root, 'src/scripts/meeting-point.worker.ts')),
    meetingPoint: key(join(root, 'src/lib/meeting-point.ts')),
    scalarCore: key(join(root, 'scripts/meeting-bench/scalar-core.ts')),
    scalarSearch: key(join(root, 'scripts/meeting-bench/scalar-search.ts')),
    override: worker ? key(worker) : null,
  }
  const workerModules = new Set()
  const workerPlugins = [
    {
      name: 'meeting-ui-bench:observe-worker-modules',
      enforce: 'pre',
      load(id) {
        workerModules.add(key(id))
        return null
      },
    },
  ]
  if (worker)
    workerPlugins.push({
      name: 'meeting-ui-bench:replace-production-worker',
      enforce: 'pre',
      load(id) {
        return key(id) === paths.productionWorker
          ? `import ${JSON.stringify(vite.normalizePath(worker))}\n`
          : null
      },
    })
  const alias = [{ find: '@', replacement: join(root, 'src') }]
  if (engine === 'scalar')
    alias.unshift({
      find: '@/lib/meeting-point',
      replacement: join(root, 'scripts/meeting-bench/scalar-core.ts'),
    })
  const started = performance.now()
  // Root is the repository so Tailwind scans the same sources as the Astro build.
  await vite.build({
    configFile: false,
    root,
    mode: 'meeting-benchmark',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      // Constant-fold the diagnostic away from default benchmark builds.
      'import.meta.env.VITE_MEETING_CANVAS_PROFILE': JSON.stringify(
        canvasProfile ? 'true' : 'false',
      ),
    },
    publicDir: false,
    logLevel: 'warn',
    plugins: [tailwindcss()],
    resolve: { alias },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      cssMinify: true,
      sourcemap: false,
      rolldownOptions: { input: html },
    },
    worker: { plugins: () => workerPlugins },
  })
  const buildMs = performance.now() - started
  const has = (path) => workerModules.has(path)
  const failures = []
  if (!has(paths.productionWorker))
    failures.push(
      "the production worker module was not bundled through MeetingPoint's new URL worker",
    )
  if (
    engine === 'scalar' &&
    !(has(paths.scalarCore) && has(paths.scalarSearch))
  )
    failures.push('the scalar alias did not reach the production worker bundle')
  if (engine !== 'scalar' && (has(paths.scalarCore) || has(paths.scalarSearch)))
    failures.push('scalar modules entered a non-scalar worker bundle')
  if (engine === 'worker' && !has(paths.override))
    failures.push('the --worker module was not bundled')
  if (engine !== 'worker' && !has(paths.meetingPoint))
    failures.push(
      'the original meeting-point module is missing from the worker bundle',
    )
  const modules = [...workerModules].filter((id) => !id.startsWith('\0')).sort()
  if (failures.length)
    throw new Error(
      `${engine} build: ${failures.join('; ')}. Worker bundle modules: ${modules.join(', ')}`,
    )
  return {
    engine,
    outDir,
    buildMs,
    worker,
    mode: 'meeting-benchmark',
    reactMode: 'production',
    wasmProfiling: modules.some((id) =>
      id.endsWith('/src/lib/meeting-search.ts'),
    ),
    pagePath: `/${relative(root, html).split(sep).join('/')}`,
    assets: await assetSizes(outDir),
    workerModules: modules,
  }
}

// Limit capture to rendering/frame events; task/scheduler/benchmark streams
// exhausted the bounded buffer before an eight-second playback completed.
const CANVAS_TRACE_CATEGORIES = [
  'blink.user_timing',
  'gpu',
  'viz',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
]
const CANVAS_TRACE_WINDOW_MS = 30_000
const CANVAS_TRACE_BUFFER_KIB = 16 * 1024
const CANVAS_TRACE_MAX_BYTES = 64 * 1024 * 1024

// CDP sessions belong to these launched browsers, never the user's browser.
// No Playwright tracing archive is substituted for Chromium timeline events.
const canvasTraces = new Map()
async function startCanvasTrace(browser, evidence) {
  let session
  let recordingTimer
  let deadline = Date.now() + CANVAS_TRACE_WINDOW_MS
  const finite = async (operation, task) => {
    let timer
    try {
      return await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Canvas trace ${operation} timed out`)),
            Math.max(1, deadline - Date.now()),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    session = await finite('CDP session', browser.newBrowserCDPSession())
    evidence.status = 'starting'
    evidence.categories = CANVAS_TRACE_CATEGORIES
    evidence.scope =
      'Owned browser process during one warm map interaction, after source placement and scroll, from immediately before startWindow/action through its two-frame settle confirmation; includes harness work in that interval. GPU events are not synchronous Canvas2D GPU completion timings.'
    evidence.limits = {
      recordingMs: CANVAS_TRACE_WINDOW_MS,
      bufferKiB: CANVAS_TRACE_BUFFER_KIB,
      fileBytes: CANVAS_TRACE_MAX_BYTES,
      drainMs: CANVAS_TRACE_WINDOW_MS,
      cleanupMs: 10_000,
    }
    evidence.recordMode = 'recordUntilFull'
    evidence.bytes = 0
    evidence.dataLossOccurred = null
    evidence.recordingLimitReached = false
    evidence.fileLimitReached = false
    evidence.cleanupErrors = []
    evidence.bufferHighWaterFraction = 0
    session.on('Tracing.bufferUsage', (event) => {
      evidence.bufferHighWaterFraction = Math.max(
        evidence.bufferHighWaterFraction,
        event.percentFull ?? event.value ?? 0,
      )
    })
    await finite(
      'start',
      session.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        streamCompression: 'none',
        bufferUsageReportingInterval: 1000,
        traceConfig: {
          recordMode: 'recordUntilFull',
          traceBufferSizeInKb: CANVAS_TRACE_BUFFER_KIB,
          includedCategories: CANVAS_TRACE_CATEGORIES,
        },
      }),
    )
    evidence.status = 'recording'
    evidence.startedAt = new Date().toISOString()
    let stopPromise
    const stop = () => {
      stopPromise ??= finish()
      return stopPromise
    }
    const finish = async () => {
      clearTimeout(recordingTimer)
      deadline = Date.now() + CANVAS_TRACE_WINDOW_MS
      let file
      let stream
      let onComplete
      try {
        const completed = new Promise((resolve) => {
          onComplete = resolve
          session.once('Tracing.tracingComplete', onComplete)
        })
        await finite('stop', session.send('Tracing.end'))
        const result = await finite('completion event', completed)
        evidence.recordingEndedAt = new Date().toISOString()
        stream = result.stream
        evidence.dataLossOccurred = result.dataLossOccurred ?? null
        if (!stream)
          throw new Error('Tracing.tracingComplete supplied no stream')
        file = await finite('file open', open(evidence.path, 'w'))
        while (true) {
          const chunk = await finite(
            'stream read',
            session.send('IO.read', {
              handle: stream,
              size: 1024 * 1024,
            }),
          )
          const data = Buffer.from(
            chunk.data,
            chunk.base64Encoded ? 'base64' : 'utf8',
          )
          if (evidence.bytes + data.length > CANVAS_TRACE_MAX_BYTES) {
            evidence.fileLimitReached = true
            throw new Error('Canvas trace exceeded the bounded file size')
          }
          let offset = 0
          while (offset < data.length) {
            const { bytesWritten } = await finite(
              'file write',
              file.write(data, offset, data.length - offset),
            )
            if (!bytesWritten)
              throw new Error('Canvas trace file write made no progress')
            offset += bytesWritten
            evidence.bytes += bytesWritten
          }
          if (chunk.eof) break
        }
        if (!evidence.bytes)
          throw new Error('Chromium tracing returned an empty stream')
        if (evidence.recordingLimitReached)
          throw new Error(
            'Canvas trace exceeded the interaction recording deadline',
          )
        evidence.status = 'captured'
      } catch (error) {
        evidence.status = 'failed'
        evidence.error = error instanceof Error ? error.stack : String(error)
        throw error
      } finally {
        evidence.finishedAt = new Date().toISOString()
        if (onComplete) session.off('Tracing.tracingComplete', onComplete)
        const cleanupErrors = evidence.cleanupErrors
        deadline = Date.now() + 10_000
        for (const [label, close] of [
          ['file close', () => file?.close()],
          [
            'stream close',
            () =>
              stream ? session.send('IO.close', { handle: stream }) : undefined,
          ],
          ['CDP detach', () => session.detach()],
        ]) {
          try {
            await finite(label, close())
          } catch (error) {
            cleanupErrors.push(`${label}: ${String(error)}`)
          }
        }
        canvasTraces.delete(browser)
        if (cleanupErrors.length) {
          evidence.status = 'failed'
          evidence.cleanupErrors = cleanupErrors
          throw new Error(
            `Canvas trace cleanup failed: ${cleanupErrors.join('; ')}`,
          )
        }
      }
    }
    canvasTraces.set(browser, stop)
    recordingTimer = setTimeout(() => {
      evidence.recordingLimitReached = true
      // Stop even if a UI action hangs. The caller/teardown awaits this same
      // promise and reports the failure; the timer never leaves a rejection loose.
      void stop().catch(() => {})
    }, CANVAS_TRACE_WINDOW_MS)
    return stop
  } catch (error) {
    evidence.status = 'unavailable'
    evidence.error = error instanceof Error ? error.stack : String(error)
    if (session) {
      clearTimeout(recordingTimer)
      deadline = Date.now() + 10_000
      evidence.cleanupErrors ??= []
      try {
        await finite('failed-start detach', session.detach())
      } catch (cleanupError) {
        evidence.cleanupErrors.push(
          `failed-start detach: ${String(cleanupError)}`,
        )
      }
    }
    throw new Error(
      `Canvas diagnostic requires actual Chromium tracing: ${String(error)}`,
      { cause: error },
    )
  }
}

async function openPage({
  playwright,
  browserName,
  chromiumChannel,
  profile,
  serving,
  browsers,
}) {
  let browser
  try {
    browser = await playwright[browserName].launch({
      headless: true,
      ...(browserName === 'chromium' && chromiumChannel
        ? { channel: chromiumChannel }
        : {}),
    })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Executable doesn't exist at")
    )
      throw new BrowserUnavailable(error.message)
    throw error
  }
  browsers.add(browser)
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
      colorScheme: 'light',
    })
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
    const pageErrors = []
    page.on('pageerror', (error) =>
      pageErrors.push(error.stack ?? error.message),
    )
    let throttle = {
      requestedRate: 1,
      scope: 'none',
      workerThrottleVerified: false,
    }
    if (profile === 'cpu4') {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      throttle = {
        requestedRate: 4,
        scope:
          'page CDP Emulation only; worker execution NOT verified as throttled',
        workerThrottleVerified: false,
      }
    }
    return {
      browser,
      page,
      blocked,
      pageErrors,
      throttle,
      browserVersion: browser.version(),
      browserChannel: browserName === 'chromium' ? chromiumChannel : null,
    }
  } catch (error) {
    await closePage({ browser }, browsers)
    throw error
  }
}

async function closePage({ browser }, browsers) {
  try {
    const stopTrace = canvasTraces.get(browser)
    if (stopTrace) await stopTrace()
  } finally {
    browsers.delete(browser)
    await browser.close()
  }
}

function assertClean({ blocked, pageErrors }) {
  if (pageErrors.length)
    throw new Error(`Page runtime errors: ${pageErrors.join(' | ')}`)
  if (blocked.length)
    throw new Error(
      `Blocked non-local requests (no external queries allowed): ${blocked.join(', ')}`,
    )
}

// Snapshot only while the benchmark facade exists; missing diagnostics are an
// explicit failure, not an empty observation after about:blank.
async function pageEvidence(page, canvasProfile, scope) {
  return page.evaluate(
    ({ canvasProfile, scope }) => {
      const bench = window.meetingUiBench
      if (typeof bench?.preparationEvidence !== 'function')
        throw new Error(`Missing meetingUiBench.preparationEvidence: ${scope}`)
      const preparation = bench.preparationEvidence()
      if (!Array.isArray(preparation?.measures))
        throw new Error(`Invalid preparation evidence: ${scope}`)
      const result = { preparationEvidence: { ...preparation, scope } }
      if (canvasProfile) {
        if (typeof bench.finishCanvasProfile !== 'function')
          throw new Error(
            `Missing meetingUiBench.finishCanvasProfile: ${scope}`,
          )
        const canvas = bench.finishCanvasProfile()
        if (!canvas) throw new Error(`Missing canvas profile: ${scope}`)
        result.canvasProfile = { ...canvas, scope }
      }
      return result
    },
    { canvasProfile, scope },
  )
}
// Read the real worker realm outside every timed search. Details contain only
// scalars, never exported buffers. A missing API/entry is not a memory estimate.
const WASM_MEASURES = [
  'meeting:wasm:boot',
  'meeting:wasm:prepare',
  'meeting:wasm:solve',
  'meeting:wasm:take',
  'meeting:wasm:rank',
  'meeting:wasm:collisions',
  'meeting:wasm:transfer',
]
async function workerEvidence(page, requireWasm = false) {
  const workers = []
  for (const worker of page.workers()) {
    const observation = await worker.evaluate((names) => {
      const entries = performance
        .getEntriesByType('measure')
        .filter((entry) => names.includes(entry.name))
        .map((entry) => ({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          detail: entry.detail,
        }))
      const memoryBytes = entries
        .map((entry) => entry.detail?.memoryBytes)
        .filter((value) => typeof value === 'number' && Number.isFinite(value))
      return {
        timeOrigin: performance.timeOrigin,
        entries,
        missingNames: names.filter(
          (name) => !entries.some((entry) => entry.name === name),
        ),
        committedMemory: memoryBytes.length
          ? {
              status: 'observed',
              source: 'actual worker measure detail.memoryBytes',
              lastBytes: memoryBytes.at(-1),
              maximumBytes: memoryBytes.reduce(
                (maximum, bytes) => Math.max(maximum, bytes),
                0,
              ),
            }
          : {
              status: 'unavailable',
              reason: 'No committed WASM memory observation in this worker',
            },
      }
    }, WASM_MEASURES)
    if (requireWasm || observation.entries.length) {
      if (
        observation.missingNames.length ||
        observation.committedMemory.status !== 'observed'
      )
        throw new Error(
          `Incomplete real WASM worker profile: ${JSON.stringify(observation.missingNames)}`,
        )
      for (const entry of observation.entries.filter(
        (entry) => entry.name === 'meeting:wasm:transfer',
      )) {
        const detail = entry.detail
        if (
          detail?.buffersBefore !== 2 ||
          detail.buffersAfter !== 0 ||
          detail.distancesBytesBefore <= 0 ||
          detail.parentsBytesBefore <= 0 ||
          detail.distancesBytesAfter !== 0 ||
          detail.parentsBytesAfter !== 0
        )
          throw new Error(
            `Invalid two-buffer transfer evidence: ${JSON.stringify(detail)}`,
          )
      }
    }
    workers.push({ url: worker.url(), ...observation })
  }
  if (requireWasm && !workers.length)
    throw new Error('No live WASM worker available for pre-unload profiling')
  return { source: 'Playwright Worker.evaluate before unload', workers }
}

async function navigate(page, serving, build) {
  await page.goto(`${serving.url}${build.pagePath}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.meetingUiBench?.installed === true)
  const enabledAt = await page.evaluate(
    (timeout) => window.meetingUiBench.ready(timeout),
    TIMEOUT,
  )
  const { events } = await page.evaluate(() => window.meetingUiBench.events(0))
  const created = events.filter((event) => event.kind === 'created')
  const load = events.find(
    (event) => event.kind === 'post' && event.message === 'load',
  )
  const ready = events.find(
    (event) => event.kind === 'reply' && event.message === 'ready',
  )
  if (
    created.length !== 1 ||
    !load ||
    !ready ||
    load.worker !== created[0].worker ||
    ready.worker !== load.worker
  )
    throw new Error(
      `Unexpected production startup messages: ${JSON.stringify(events)}`,
    )
  return {
    worker: created[0].worker,
    workerScript: created[0].script,
    raw: {
      workerCreatedAt: created[0].at,
      loadPostAt: load.at,
      readyReplyAt: ready.at,
      findEnabledAt: enabledAt,
      progress: events
        .filter(
          (event) => event.kind === 'reply' && event.message === 'progress',
        )
        .map((event) => event.at),
    },
    metrics: {
      navigationToLoadPostMs: load.at,
      loadPostToReadyReplyMs: ready.at - load.at,
      readyReplyToFindEnabledMs: enabledAt - ready.at,
      navigationToFindEnabledMs: enabledAt,
    },
  }
}

const findButton = (page) =>
  page.getByRole('button', { name: 'Find meeting spots' })
const objectiveRadio = (page, objective) =>
  page.getByRole('radio', {
    name:
      objective === 'fair'
        ? /^Shortest longest journey/
        : /^Least distance together/,
  })
const rankingLabels = {
  fair: 'Ranked by longest journey, then total distance',
  total: 'Ranked by total distance, then longest journey',
}

// One real Find click: the click handler, worker dispatch/reply, the committed
// nonempty ranked list and the next frame; then preparation/playback readiness.
// Every protocol/DOM assertion runs after the timed interval.
async function measureFind(page, expectation) {
  await page.evaluate(() => window.meetingUiBench.arm())
  await findButton(page).click()
  const timing = await page.evaluate(
    (timeout) => window.meetingUiBench.settle(timeout),
    TIMEOUT,
  )
  const readiness = await page.evaluate(
    (timeout) => window.meetingUiBench.readiness(timeout),
    TIMEOUT,
  )
  const { candidates, ranking, longTasks, visibility } = await page.evaluate(
    ([from, to]) => ({
      candidates: window.meetingUiBench.candidates(),
      ranking: window.meetingUiBench.rankingLabel(),
      longTasks: window.meetingUiBench.longTasks(from, to),
      // Recorded, not enforced: Find may scroll a tall start list over the map.
      visibility: window.meetingUiBench.mapVisibility(),
    }),
    [timing.clickAt, timing.frameAt],
  )
  const failures = timing.events.filter(
    (event) =>
      event.kind === 'error' ||
      (event.kind === 'reply' && event.message === 'error'),
  )
  if (failures.length)
    throw new Error(`Worker errors: ${JSON.stringify(failures)}`)
  if (!candidates.length) throw new Error('No ranked candidates were committed')
  if (ranking !== rankingLabels[expectation.objective])
    throw new Error(
      `Expected "${rankingLabels[expectation.objective]}", saw "${ranking}"`,
    )
  const posts = timing.events.filter((event) => event.kind === 'post')
  // preparationReadyMs is null when the "Preparing" status never rendered
  // (readiness.preparingAt === null); see report limitations.
  const shared = {
    clickToCommitMs: timing.commitAt - timing.clickAt,
    clickToFrameMs: timing.frameAt - timing.clickAt,
    preparationReadyMs:
      readiness.preparedAt === null
        ? null
        : readiness.preparedAt - timing.commitAt,
    playbackAdvanceMs: readiness.playbackAdvanceAt - timing.commitAt,
  }
  if (expectation.kind === 'cached') {
    if (posts.length || timing.events.some((event) => event.kind === 'created'))
      throw new Error(
        `Cached rerank used the worker: ${JSON.stringify(timing.events)}`,
      )
    return {
      timing,
      readiness,
      longTasks,
      visibility,
      candidates,
      origins: null,
      worker: null,
      results: null,
      metrics: shared,
    }
  }
  const searches = posts.filter((event) => event.message === 'search')
  const attaches = posts.filter((event) => event.message === 'attach')
  if (
    searches.length !== 1 ||
    posts.length !== searches.length + attaches.length
  )
    throw new Error(
      `Expected one new worker search, saw ${JSON.stringify(posts)}`,
    )
  const [search] = searches
  if (expectation.attach) {
    if (
      attaches.length !== 1 ||
      attaches[0].worker !== search.worker ||
      attaches[0].at > search.at
    )
      throw new Error(
        `Expected attach then search on a new worker: ${JSON.stringify(posts)}`,
      )
  } else if (attaches.length)
    throw new Error(`Unexpected attach: ${JSON.stringify(posts)}`)
  if (expectation.worker !== undefined && search.worker !== expectation.worker)
    throw new Error(
      `Search used worker ${search.worker}, not the retained worker ${expectation.worker}`,
    )
  if (search.at < timing.clickAt)
    throw new Error('Search was posted before the Find click')
  if (search.objective !== expectation.objective)
    throw new Error(`Search objective ${search.objective}`)
  if (expectation.size !== null && search.origins.length !== expectation.size)
    throw new Error(
      `Posted ${search.origins.length} origins, expected ${expectation.size}`,
    )
  const reply = timing.events.find(
    (event) =>
      event.kind === 'reply' &&
      event.message === 'result' &&
      event.id === search.id &&
      event.worker === search.worker,
  )
  if (!reply) throw new Error(`No result reply for search ${search.id}`)
  if (reply.at > timing.commitAt)
    throw new Error('Results committed before the worker reply arrived')
  if (
    JSON.stringify(reply.results.map(({ name }) => name)) !==
    JSON.stringify(candidates.map(({ name }) => name))
  )
    throw new Error('Committed candidates differ from the worker reply')
  return {
    timing,
    readiness,
    longTasks,
    visibility,
    candidates,
    origins: search.origins,
    worker: search.worker,
    results: reply.results,
    metrics: {
      clickToDispatchMs: search.at - timing.clickAt,
      dispatchToReplyMs: reply.at - search.at,
      replyToCommitMs: timing.commitAt - reply.at,
      ...shared,
    },
  }
}

async function resultsGone(page) {
  await until('Results cleared', () =>
    page.evaluate(() => !window.meetingUiBench.resultsVisible()),
  )
}

// Leaves the requested objective with no ranked output (map clicks then pick
// starts instead of selecting candidate markers).
async function clearResults(page, objective) {
  const selected = objectiveRadio(page, objective)
  if (!(await selected.isChecked())) await selected.click()
  if (await page.evaluate(() => window.meetingUiBench.resultsVisible())) {
    await objectiveRadio(page, objective === 'fair' ? 'total' : 'fair').click()
    await selected.click()
  }
  await resultsGone(page)
}

async function setOriginCount(page, size) {
  const letters = page.getByRole('button', {
    name: /^Place location [A-Z]\d* on the map$/,
  })
  let count = await letters.count()
  while (count < size) {
    await page.getByRole('button', { name: 'Add starting point' }).click()
    count++
    await until(
      `Start ${letter(count - 1)} added`,
      async () => (await letters.count()) === count,
    )
    // The new blank input autofocuses with local suggestions open; close them.
    await page.keyboard.press('Escape')
  }
  while (count > size) {
    await page
      .getByRole('button', {
        name: `Remove location ${letter(count - 1)}`,
        exact: true,
      })
      .click()
    count--
    await until(
      `Start ${letter(count)} removed`,
      async () => (await letters.count()) === count,
    )
  }
}

// Moves starts by real map clicks at deterministic, distinct real-node pixels
// in the fit view. Named meeting candidates need not outnumber requested starts.
// Production nearestNode decides the posted node; no origins are injected.
async function placeOrigins(page, nodes, indexes, seed) {
  const random = mulberry32(Number.parseInt(digest(seed).slice(0, 8), 16))
  // Visit each node at most once: no replacement/retry lottery when named
  // places or unobstructed pixels are scarce. The seed is shared across engines.
  const candidates = [...nodes]
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  let cursor = 0
  const canvas = page.getByRole('img', {
    name: /^Interactive walking network of /,
  })
  const used = new Set()
  const targets = []
  for (const index of indexes) {
    const name = letter(index)
    await page
      .getByRole('button', {
        name: `Place location ${name} on the map`,
        exact: true,
      })
      .click()
    // Selecting a late sidebar letter can scroll the map away. Restore the
    // actual canvas AFTER selection, then use its live rect and DOM hit test.
    await canvas.evaluate((element) =>
      element.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'instant',
      }),
    )
    const visibility = await page.evaluate(() =>
      window.meetingUiBench.mapVisibility(),
    )
    if (visibility.visibleFraction < 1)
      throw new Error(
        `Map canvas not fully visible for location ${name}: ${JSON.stringify({ seed, visibility })}`,
      )
    let target = null
    let lastCandidate = null
    while (cursor < candidates.length && !target) {
      const node = candidates[cursor++]
      const pixel = await page.evaluate(
        (node) => window.meetingUiBench.targetPixel(node),
        node,
      )
      lastCandidate = { placeNode: node, ...pixel }
      if (pixel.onCanvas && !used.has(pixel.local)) {
        used.add(pixel.local)
        target = { letter: name, ...lastCandidate }
      }
    }
    if (!target)
      throw new Error(
        `No clickable map pixel for location ${name}: ${JSON.stringify({ seed, requested: indexes.length, placed: targets.length, considered: cursor, availableNodes: candidates.length, visibility, lastCandidate })}`,
      )
    try {
      await page.mouse.click(target.x, target.y)
      await page.evaluate(
        ([name, timeout]) => window.meetingUiBench.waitNotice(name, timeout),
        [name, TIMEOUT],
      )
    } catch (error) {
      throw new Error(
        `Map placement failed for location ${name}: ${String(error)}; ${JSON.stringify({ seed, target })}`,
        { cause: error },
      )
    }
    targets.push(target)
  }
  return targets
}

async function checkTargets(page, targets, origins, indexes) {
  const offsets = await page.evaluate(
    (pairs) => window.meetingUiBench.offsets(pairs),
    targets.map((target, i) => [target.placeNode, origins[indexes[i]]]),
  )
  const worst = Math.max(...offsets)
  if (worst > MAX_TARGET_OFFSET_METRES)
    throw new Error(
      `Posted start ${worst.toFixed(1)} m from its click target; MeetingMap's fit projection no longer matches the harness: ${JSON.stringify({ targets, origins: indexes.map((index) => origins[index]), offsets })}`,
    )
  return worst
}

async function screenshot(page, artifacts, name) {
  if (!artifacts) return null
  const path = join(artifacts, `${name}.png`)
  await page.screenshot({ path })
  return path
}

async function runSample(page, nodes, size, objective, key, retainedWorker) {
  await clearResults(page, objective)
  const indexes = Array.from({ length: size }, (_, i) => i)
  const targets = await placeOrigins(page, nodes, indexes, key)
  const warm = await measureFind(page, {
    kind: 'search',
    objective,
    size,
    worker: retainedWorker,
  })
  const maxTargetOffsetMetres = await checkTargets(
    page,
    targets,
    warm.origins,
    indexes,
  )
  const rerankObjective = objective === 'fair' ? 'total' : 'fair'
  await objectiveRadio(page, rerankObjective).click()
  await resultsGone(page)
  const rerank = await measureFind(page, {
    kind: 'cached',
    objective: rerankObjective,
  })
  return {
    key,
    objective,
    rerankObjective,
    origins: warm.origins,
    originKey: digest(JSON.stringify(warm.origins)).slice(0, 16),
    targets,
    maxTargetOffsetMetres,
    warm,
    rerank,
  }
}

// Playback, seek, pan and fit traces require the whole map canvas on screen;
// a tall 16-start list otherwise leaves it partly outside the viewport.
async function interactionProfile(page, tracing = null) {
  const section = page.locator('section[aria-label="Animated road search"]')
  const run = async (name, trigger, action, options, release = trigger) => {
    await section.evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    )
    const evidence = tracing
      ? {
          ...tracing.identity,
          interaction: name,
          status: 'pending',
          path: join(
            tracing.directory,
            `${tracing.prefix}-${name}-canvas-trace.json`,
          ),
        }
      : null
    let stopTrace
    if (evidence) {
      tracing.traces.push(evidence)
      stopTrace = await startCanvasTrace(tracing.browser, evidence)
    }
    try {
      await page.evaluate(
        ([trigger, release]) =>
          window.meetingUiBench.startWindow(trigger, release),
        [trigger, release],
      )
      await action()
      const result = await page.evaluate(
        (options) => window.meetingUiBench.finishWindow(options),
        { timeoutMs: TIMEOUT, ...options },
      )
      if (evidence)
        evidence.pageWindow = {
          triggerAt: result.triggerAt,
          settledAt: result.settledAt,
          timeOrigin: await page.evaluate(() => performance.timeOrigin),
        }
      if (
        result.visibilityAtStart.visibleFraction < 1 ||
        result.visibilityAtSettle.visibleFraction < 1
      )
        throw new Error(
          `Map canvas not fully on screen during ${result.trigger} trace: ${JSON.stringify([result.visibilityAtStart, result.visibilityAtSettle])}`,
        )
      return result
    } catch (error) {
      if (evidence) evidence.interactionError = String(error)
      throw error
    } finally {
      if (stopTrace) await stopTrace()
    }
  }
  const playback = await run(
    'playback',
    'click',
    () => page.getByRole('button', { name: 'Replay search animation' }).click(),
    { until: 'playback-complete' },
  )
  const slider = page.getByRole('slider', { name: 'Search animation progress' })
  const seekBackward = await run(
    'seek-backward',
    'keydown',
    async () => {
      await slider.focus()
      await page.keyboard.press('Home')
    },
    { until: 'settled', sliderValue: '0' },
  )
  const seekForward = await run(
    'seek-forward',
    'keydown',
    () => page.keyboard.press('End'),
    { until: 'settled', sliderValue: '100' },
  )
  const pan = await run(
    'pan',
    'pointerdown',
    async () => {
      const canvas = page.getByRole('img', {
        name: /^Interactive walking network of /,
      })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('Map canvas has no box')
      const x = Math.round(box.x + box.width / 2)
      const y = Math.round(box.y + box.height / 2)
      await page.mouse.move(x, y)
      await page.mouse.down()
      for (let step = 1; step <= 10; step++)
        await page.mouse.move(x - 12 * step, y - 8 * step)
      await page.mouse.up()
    },
    { until: 'settled' },
    'pointerup',
  )
  // Restores the fit view that map-click targeting assumes.
  const fit = await run(
    'fit',
    'click',
    () => page.getByRole('button', { name: 'Fit region' }).click(),
    { until: 'settled' },
  )
  const windows = { playback, seekBackward, seekForward, pan, fit }
  for (const result of Object.values(windows))
    result.longTasks = await page.evaluate(
      ([from, to]) => window.meetingUiBench.longTasks(from, to),
      [result.triggerAt, result.settledAt],
    )
  return windows
}

// Busy edit through the real UI: Find, then an objective change while the
// production worker is solving terminates it; the next Find attaches a new one.
async function cancellationCheck(page, nodes, size, key, retainedWorker) {
  const counts = async () => ({
    wrapper: await page.evaluate(() => window.meetingUiBench.workerCounts()),
    playwright: page.workers().length,
  })
  await clearResults(page, 'fair')
  const before = await counts()
  const targets = await placeOrigins(page, nodes, [0], key)
  const find = findButton(page)
  await find.scrollIntoViewIfNeeded()
  const [findBox, radioBox] = await Promise.all([
    find.boundingBox(),
    objectiveRadio(page, 'total').boundingBox(),
  ])
  for (const box of [findBox, radioBox])
    if (!box || box.y < 0 || box.y + box.height > VIEWPORT.height)
      throw new Error('Find and objective controls are not both visible')
  const cursor = await page.evaluate(() => window.meetingUiBench.cursor())
  await page.mouse.click(
    Math.round(findBox.x + findBox.width / 2),
    Math.round(findBox.y + findBox.height / 2),
  )
  await page.mouse.click(
    Math.round(radioBox.x + radioBox.width / 2),
    Math.round(radioBox.y + radioBox.height / 2),
  )
  await resultsGone(page)
  const { events } = await page.evaluate(
    (cursor) => window.meetingUiBench.events(cursor),
    cursor,
  )
  const search = events.find(
    (event) => event.kind === 'post' && event.message === 'search',
  )
  if (!search || search.worker !== retainedWorker)
    throw new Error(
      `Find did not post a search to the retained worker: ${JSON.stringify(events)}`,
    )
  const terminated = events.find(
    (event) => event.kind === 'terminate' && event.worker === search.worker,
  )
  const reply = events.find(
    (event) =>
      event.kind === 'reply' &&
      event.id === search.id &&
      event.worker === search.worker,
  )
  const exercised = Boolean(terminated) && (!reply || reply.at > terminated.at)
  const recovery = exercised
    ? await measureFind(page, {
        kind: 'search',
        objective: 'total',
        size,
        attach: true,
      })
    : await measureFind(page, { kind: 'cached', objective: 'total' })
  if (exercised && recovery.worker === retainedWorker)
    throw new Error('Recovery search reused the terminated worker')
  const settled = await until(
    'Live worker count after cancellation',
    async () => {
      const value = await counts()
      return value.wrapper.live === 1 && value.playwright === before.playwright
        ? value
        : null
    },
    10_000,
  ).catch(() => counts())
  const recoveryWorkerEvidence = await workerEvidence(page)
  const recoveryPageEvidence = await pageEvidence(
    page,
    false,
    'Warm navigation through cancellation/recovery, immediately before about:blank; cumulative preparation measures',
  )
  await page.goto('about:blank')
  const unloaded = await until(
    'Live workers after unload',
    () => (page.workers().length === 0 ? { playwright: 0 } : null),
    10_000,
  ).catch(() => ({ playwright: page.workers().length }))
  const tracked = before.playwright === before.wrapper.live
  const returned =
    settled.wrapper.live === 1 &&
    settled.playwright === before.playwright &&
    unloaded.playwright === 0
  if (tracked && !returned)
    throw new Error(
      `Live worker targets did not return to baseline: ${JSON.stringify({ before, settled, unloaded })}`,
    )
  return {
    size,
    status: exercised ? 'exercised' : 'not-exercised',
    reason: exercised
      ? null
      : 'The worker reply arrived before the objective click; no busy worker was terminated',
    liveWorkerEvidence: tracked
      ? {
          status: returned ? 'returned-to-baseline' : 'failed',
          source:
            'Playwright page.workers() (Chromium: CDP Target auto-attach)',
        }
      : {
          status: 'unverified',
          reason:
            'The browser protocol reported a different live worker count than the page',
        },
    before,
    settled,
    unloaded,
    recoveryWorkerEvidence,
    ...recoveryPageEvidence,
    cancelledWorker: search.worker,
    recoveryWorker: recovery.worker,
    targets,
    recovery: {
      kind: exercised ? 'attach+search' : 'cached',
      metrics: recovery.metrics,
      events: recovery.timing.events,
    },
  }
}

const summarizeValues = (values) => {
  const present = values.filter((value) => value !== null)
  return present.length
    ? {
        samples: present.length,
        missing: values.length - present.length,
        ...summarize(present),
      }
    : { samples: 0, missing: values.length, status: 'unavailable' }
}
function metricSummary(rows) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return Object.fromEntries(
    keys.map((key) => [
      key,
      summarizeValues(rows.map((row) => row[key] ?? null)),
    ]),
  )
}
function longTaskSummary(entries) {
  if (entries.some((entry) => entry.status !== 'available'))
    return {
      status: 'unavailable',
      reason: entries.find((entry) => entry.status !== 'available').reason,
    }
  return {
    status: 'available',
    countPerWindow: summarizeValues(entries.map((entry) => entry.count)),
    totalMsPerWindow: summarizeValues(entries.map((entry) => entry.totalMs)),
  }
}

function summarizeEngine(config, cold, warm) {
  const groups = {}
  for (const size of config.groups) {
    groups[size] = {}
    for (const objective of OBJECTIVES) {
      const runs = warm.flatMap((run) =>
        run.groups.filter(
          (group) => group.size === size && group.objective === objective,
        ),
      )
      const samples = runs.flatMap((group) =>
        group.samples.filter((sample) => !sample.warmup),
      )
      const interactions = {}
      for (const kind of [
        'playback',
        'seekBackward',
        'seekForward',
        'pan',
        'fit',
      ]) {
        const windows = runs.map((group) => group.interactions[kind])
        interactions[kind] = {
          settleMs: summarizeValues(windows.map((window) => window.settleMs)),
          frameIntervalsMs: summarizeValues(
            windows.flatMap((window) => window.frameIntervalsMs),
          ),
          productionFrameCallbackCpuMs: summarizeValues(
            windows.map((window) => window.productionFrameCallbackCpuMs),
          ),
          longTasks: longTaskSummary(windows.map((window) => window.longTasks)),
        }
      }
      groups[size][objective] = {
        objective,
        rerankObjective: objective === 'fair' ? 'total' : 'fair',
        launches: runs.length,
        warm: metricSummary(samples.map((sample) => sample.warm.metrics)),
        rerank: metricSummary(samples.map((sample) => sample.rerank.metrics)),
        warmLongTasks: longTaskSummary(
          samples.map((sample) => sample.warm.longTasks),
        ),
        rerankLongTasks: longTaskSummary(
          samples.map((sample) => sample.rerank.longTasks),
        ),
        interactions,
      }
    }
  }
  return {
    cold: metricSummary(cold.map((sample) => sample.metrics)),
    coldLongTasks: longTaskSummary(cold.map((sample) => sample.find.longTasks)),
    groups,
  }
}

// Derive coverage from completed rows separately for every browser/profile and
// engine. A missing required cross-product case contributes zero, even when the
// union of observed group sizes and objectives looks complete.
function completedCoverage(config, entries) {
  const groups = new Set()
  const objectives = new Set()
  const warmSamples = []
  const warmLaunches = []
  const coldSamples = []
  for (const entry of entries) {
    for (const engine of config.engines) {
      coldSamples.push(
        entry.cold.filter((sample) => sample.engine === engine).length,
      )
      const cases = new Map()
      for (const run of entry.warm.filter((run) => run.engine === engine)) {
        for (const group of run.groups) {
          for (const sample of group.samples) {
            if (sample.warmup) continue
            groups.add(group.size)
            objectives.add(sample.objective)
            const key = `${group.size}/${sample.objective}`
            if (!cases.has(key))
              cases.set(key, { samples: 0, launches: new Set() })
            const completed = cases.get(key)
            completed.samples++
            completed.launches.add(run.run)
          }
        }
      }
      for (const size of GATE.groups) {
        for (const objective of OBJECTIVES) {
          const completed = cases.get(`${size}/${objective}`)
          warmSamples.push(completed?.samples ?? 0)
          warmLaunches.push(completed?.launches.size ?? 0)
        }
      }
    }
  }
  const minimum = (counts) => (counts.length ? Math.min(...counts) : 0)
  return {
    smoke: config.smoke,
    groups: [...groups],
    objectives: [...objectives],
    warmSamples: minimum(warmSamples),
    warmLaunches: minimum(warmLaunches),
    coldSamples: minimum(coldSamples),
  }
}

function regression(baseline, candidate) {
  if (!baseline.samples || !candidate.samples) return { status: 'unavailable' }
  return {
    baselineMedian: baseline.median,
    candidateMedian: candidate.median,
    regressionPct:
      ((candidate.median - baseline.median) / baseline.median) * 100,
  }
}

// Supplemental full-Chromium runs never satisfy the frozen headless-shell gate,
// regardless of coverage. Keep this independent of smoke and shared gates.mjs.
function promotionCoverage(config, counts) {
  const coverage = assessCoverage(counts)
  const reasons = [
    ...coverage.reasons,
    ...(config.chromiumChannel ? ['supplemental-browser-channel'] : []),
    ...(config.canvasProfile ? ['diagnostic-canvas-profile'] : []),
  ]
  return {
    ...coverage,
    eligible:
      coverage.eligible && !config.chromiumChannel && !config.canvasProfile,
    reasons,
  }
}

// First engine is the baseline. Gate status is only computed for eligible data.
function compare(config, summaries, counts) {
  const [baseline, ...candidates] = config.engines
  const coverage = promotionCoverage(config, counts)
  return candidates.map((candidate) => {
    const base = summaries[baseline]
    const next = summaries[candidate]
    const groups = config.groups.flatMap((size) =>
      OBJECTIVES.map((objective) => {
        const b = base.groups[size][objective].warm[GATE.warmMetric]
        const c = next.groups[size][objective].warm[GATE.warmMetric]
        const improvementMs = b.median - c.median
        return {
          size,
          objective,
          rerankObjective: objective === 'fair' ? 'total' : 'fair',
          warm: {
            baselineMedian: b.median,
            candidateMedian: c.median,
            baselineP95: b.p95,
            candidateP95: c.p95,
            improvementMs,
            improvementPct: (improvementMs / b.median) * 100,
            p95NoWorse: c.p95 <= b.p95,
          },
          cached: regression(
            base.groups[size][objective].rerank[GATE.cachedMetric],
            next.groups[size][objective].rerank[GATE.cachedMetric],
          ),
          workerArrival: regression(
            base.groups[size][objective].warm[GATE.workerMetric],
            next.groups[size][objective].warm[GATE.workerMetric],
          ),
        }
      }),
    )
    const cold = regression(
      base.cold[GATE.coldMetric],
      next.cold[GATE.coldMetric],
    )
    const coldFindEnabled = regression(
      base.cold[GATE.coldFindEnabledMetric],
      next.cold[GATE.coldFindEnabledMetric],
    )
    const coldFirstSearch = regression(
      base.cold[GATE.coldFirstSearchMetric],
      next.cold[GATE.coldFirstSearchMetric],
    )
    let gate = { status: 'not-eligible', reasons: coverage.reasons }
    if (coverage.eligible) {
      const gated = groups.filter((group) => GATE.groups.includes(group.size))
      const passed =
        cold.regressionPct <= GATE.coldRegressionPct &&
        coldFindEnabled.regressionPct <= GATE.coldRegressionPct &&
        coldFirstSearch.regressionPct <= GATE.coldRegressionPct &&
        gated.every(
          (group) =>
            group.warm.improvementPct >= GATE.warmImprovementPct &&
            group.warm.improvementMs >= GATE.warmImprovementMs &&
            group.warm.p95NoWorse &&
            group.workerArrival.regressionPct <= 0 &&
            group.cached.regressionPct <= GATE.cachedRegressionPct,
        )
      gate = { status: passed ? 'passed' : 'failed' }
    }
    return {
      baseline,
      candidate,
      groups,
      cold,
      coldFindEnabled,
      coldFirstSearch,
      gate,
    }
  })
}

// Same run/group/objective/sample must post the same starts and identical ranked
// output for every engine; cold samples must all match each other.
function checkConsistency(cold, warm) {
  const seen = new Map()
  const check = (key, engine, value) => {
    const previous = seen.get(key)
    if (!previous) seen.set(key, { engine, value })
    else if (previous.value !== value)
      throw new Error(
        `Nondeterministic ${key}: ${previous.engine} vs ${engine}`,
      )
  }
  for (const sample of cold) {
    check('cold origins', sample.engine, JSON.stringify(sample.find.origins))
    check(
      'cold ranked results',
      sample.engine,
      JSON.stringify(sample.find.results),
    )
  }
  for (const run of warm)
    for (const group of run.groups)
      for (const sample of group.samples) {
        const key = `${sample.key}`
        check(`${key} origins`, run.engine, JSON.stringify(sample.origins))
        check(
          `${key} warm results`,
          run.engine,
          JSON.stringify(sample.warm.results),
        )
        check(
          `${key} cached candidates`,
          run.engine,
          JSON.stringify(sample.rerank.candidates),
        )
      }
  return { status: 'passed', comparedKeys: seen.size }
}

async function main(config) {
  const report = {
    schemaVersion: 3,
    contract: 'meeting-ui-bench r4',
    startedAt: new Date().toISOString(),
    config,
    status: 'running',
    host: {
      runtime: process.version,
      bun: process.versions.bun ?? null,
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
      logicalCpus: cpus().length,
      physicalMemoryBytes: totalmem(),
    },
    viewport: { ...VIEWPORT, deviceScaleFactor: 1 },
    gate: GATE,
    builds: {},
    runs: [],
    availability: [],
    limitations: [
      'Standalone Vite page: production MeetingPoint, CSS and worker, client-rendered with createRoot; Astro SSR/hydration, site header/footer and the Google-hosted Inter font are excluded (no external requests), so layout and cold timings differ from the deployed page.',
      'Bundles come from the installed Vite/Tailwind with production target/cssMinify settings, not the Astro pipeline; asset bytes approximate the deployed bundle.',
      'Timings wrap browser globals (Worker, requestAnimationFrame) and DOM observers; the small constant overhead applies to every engine.',
      'Frame times are requestAnimationFrame callback timestamps, not presentation. Production frame-callback CPU is main-thread Canvas2D command submission; GPU completion is not measured.',
      "Cold samples use the production default preset starting points (the SF reel landmarks snapped by production code; arbitrary for non-SF fixtures); --groups apply to warm/cached samples only. Cold navigation-to-results includes the harness's Find-enabled-to-click gap, reported separately.",
      "Map clicks visit a seeded permutation of all real network nodes without replacement, skipping duplicate pixels and DOM overlays after bringing the canvas into view for each selected location. Named meeting candidates do not limit starting-point counts. Clicks mirror MeetingMap's private fit projection (declared network bounds, world width 1024, 48/60 px margins); production nearestNode snapping decides posted starts, which are recorded and checked within 50 m of their targets.",
      'preparationReadyMs is only available when the "Preparing the animated road layer" status rendered; playbackAdvanceMs (first nonzero slider value, at least 40 ms of 1x animation clock) is always measured.',
      'CPU4 is page-only CDP throttling; worker CPU throttling is unverified. No weak-GPU or mobile emulation claim.',
      'Headless Playwright: the page is the only, programmatically foreground tab of its own browser; visibilityState/hasFocus are recorded per window, but this is not a visible, focused desktop Chrome window with real compositor/vsync pacing. Automated WebKit is not evidence for Safari GPU behavior.',
      `Viewport ${VIEWPORT.width}x${VIEWPORT.height} at DPR 1 keeps the whole map on screen for traces; canvas backing size (min(DPR, 2)) therefore differs from DPR-2 desktop captures such as 1280x800 DPR 2.`,
      'Playback/seek/pan/fit traces scroll the map section to the top of the viewport and fail unless the canvas is fully visible at start and settle; Find samples record (do not enforce) map visibility, since Find can scroll a tall start list over the map.',
      config.engines.includes('worker')
        ? 'Main-thread performance.memory excludes workers. Actual worker performance entries supply WASM committed memory and transfer details only when the candidate emits the frozen meeting-benchmark measures; missing observations are unavailable, never estimates. Worker snapshots precede busy cancellation and unload, not an in-kernel cancellation probe.'
        : 'Memory is main-thread performance.memory where exposed; worker JS heap is unavailable. No worker candidate is selected, so WASM committed memory is not applicable.',
    ],
  }
  if (config.canvasProfile) {
    report.canvasProfile = {
      diagnostic: 'diagnostic-canvas-profile',
      promotionEligible: false,
      reasons: ['diagnostic-canvas-profile'],
      traces: [],
    }
    report.limitations.push(
      'Canvas profiling wraps actual main-realm Canvas2D prototype entrypoints. Native stroke/drawImage synchronous durations exclude most bookkeeping; RAF CPU includes wrapper overhead. Path segments are successful lineTo calls since beginPath, not GPU primitives. Canvas dimension/connectivity classes are observed at timed call return; detached is not proof of a specific renderer layer.',
      'Canvas timers perturb every sample, including cold starts; CDP traces cover only individual warm playback/seek/pan/fit windows, excluding source placement, searches and cancellation. Traces use a 30 s recording deadline, a 16 MiB record-until-full buffer and a 64 MiB file cap; flags report loss or truncation rather than imply complete coverage. Never promote or compare performance candidates from this report regardless of sample counts. Hardware acceleration must be independently established; a Chromium channel request is not GPU identity evidence, and default-shell SwiftShader is not hardware GPU performance evidence.',
    )
  }
  const temporaries = []
  const servers = []
  const browsers = new Set()
  let interrupted = false
  let cleanupPromise
  function cleanup() {
    cleanupPromise ??= (async () => {
      const failures = []
      for (const browser of browsers) {
        try {
          await closePage({ browser }, browsers)
        } catch (error) {
          failures.push(String(error))
        }
      }
      browsers.clear()
      for (const server of servers) {
        const { promise, resolve: closed, reject } = Promise.withResolvers()
        server.close((error) => (error ? reject(error) : closed()))
        server.closeAllConnections()
        try {
          await promise
        } catch (error) {
          failures.push(String(error))
        }
      }
      for (const directory of temporaries) {
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 3 })
        } catch (error) {
          failures.push(String(error))
        }
      }
      if (failures.length)
        throw new Error(`Cleanup failed: ${failures.join('; ')}`)
    })()
    return cleanupPromise
  }
  const interrupt = () => {
    interrupted = true
    // Abort in-flight page work; resource cleanup stays in finally.
    for (const browser of browsers)
      void browser.close().catch((error) => process.stderr.write(`${error}\n`))
  }
  const checkInterrupted = () => {
    if (interrupted) throw new Error('Benchmark interrupted')
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const [vite, { default: tailwindcss }, playwright] = await Promise.all([
      import('vite'),
      import('@tailwindcss/vite'),
      import('playwright'),
    ])
    const require = createRequire(import.meta.url)
    const tailwindPackage = JSON.parse(
      await readFile(
        join(root, 'node_modules/@tailwindcss/vite/package.json'),
        'utf8',
      ),
    )
    report.versions = {
      vite: vite.version,
      tailwindcss: tailwindPackage.version,
      playwright: require('playwright/package.json').version,
      react: require('react/package.json').version,
    }
    const fixture = await readFile(config.fixture)
    report.fixture = {
      path: config.fixture,
      servedAt: FIXTURE_URL,
      sha256: digest(fixture),
      jsonBytes: fixture.length,
    }
    if (config.worker && !(await stat(config.worker)).isFile())
      throw new Error(`--worker ${config.worker} is not a file`)
    if (config.artifacts) await mkdir(config.artifacts, { recursive: true })
    checkInterrupted()
    const htmlDirectory = await mkdtemp(join(root, '.meeting-ui-bench-'))
    temporaries.push(htmlDirectory)
    const html = join(htmlDirectory, 'index.html')
    await writeFile(
      html,
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>Meeting point UI benchmark</title><script type="module" src="/scripts/meeting-bench/ui.tsx"></script></head><body class="bg-background min-h-screen font-sans antialiased"><main id="main-content"><div id="meeting-ui-bench-root"></div></main></body></html>\n',
    )
    const builds = {}
    const servings = {}
    for (const engine of config.engines) {
      builds[engine] = await phase('build', { engine }, () =>
        buildEngine({
          vite,
          tailwindcss,
          engine,
          worker: engine === 'worker' ? config.worker : null,
          html,
          temporaries,
          canvasProfile: config.canvasProfile,
        }),
      )
      const { outDir, ...identity } = builds[engine]
      report.builds[engine] = identity
      const serving = await serve(outDir, fixture)
      servers.push(serving.server)
      servings[engine] = serving
      checkInterrupted()
    }
    const rotate = (offset) =>
      config.engines.map(
        (_, i) => config.engines[(i + offset) % config.engines.length],
      )
    const unavailable = new Set()
    for (const browserName of config.browsers) {
      for (const profile of config.profiles) {
        checkInterrupted()
        const identity = {
          browser: browserName,
          profile,
          browserChannel:
            browserName === 'chromium' ? config.chromiumChannel : null,
        }
        if (profile === 'cpu4' && browserName !== 'chromium') {
          report.availability.push({
            ...identity,
            status: 'unavailable',
            reason: 'CDP CPU throttling is Chromium-only',
          })
          continue
        }
        if (unavailable.has(browserName)) {
          report.availability.push({
            ...identity,
            status: 'unavailable',
            reason: 'Playwright browser executable is not installed',
          })
          continue
        }
        const entry = { ...identity, status: 'running', cold: [], warm: [] }
        report.runs.push(entry)
        try {
          const launch = (engine) =>
            openPage({
              playwright,
              browserName,
              chromiumChannel: config.chromiumChannel,
              profile,
              serving: servings[engine],
              browsers,
            })
          for (let index = 0; index < config.coldSamples; index++) {
            for (const engine of rotate(index)) {
              checkInterrupted()
              const context = { ...identity, engine, cold: index }
              const launched = await phase('cold launch', context, () =>
                launch(engine),
              )
              try {
                entry.throttle = launched.throttle
                entry.browserVersion = launched.browserVersion
                const startup = await phase('cold startup', context, () =>
                  navigate(launched.page, servings[engine], builds[engine]),
                )
                const find = await phase('cold first search', context, () =>
                  measureFind(launched.page, {
                    kind: 'search',
                    objective: 'fair',
                    size: null,
                    worker: startup.worker,
                  }),
                )
                const artifact =
                  index === 0
                    ? await screenshot(
                        launched.page,
                        config.artifacts,
                        `${browserName}-${profile}-${engine}-cold-results`,
                      )
                    : null
                assertClean(launched)
                entry.cold.push({
                  engine,
                  index,
                  startup,
                  find,
                  artifact,
                  ...(await pageEvidence(
                    launched.page,
                    config.canvasProfile,
                    'Cold navigation through first search/playback readiness and optional screenshot; before browser close',
                  )),
                  workerEvidence: await workerEvidence(
                    launched.page,
                    builds[engine].wasmProfiling,
                  ),
                  metrics: {
                    ...startup.metrics,
                    findEnabledToClickMs:
                      find.timing.clickAt - startup.raw.findEnabledAt,
                    ...Object.fromEntries(
                      Object.entries(find.metrics).map(([key, value]) => [
                        `firstSearch.${key}`,
                        value,
                      ]),
                    ),
                    navigationToFirstResultsFrameMs: find.timing.frameAt,
                  },
                })
              } finally {
                await closePage(launched, browsers)
              }
            }
          }
          for (let run = 0; run < config.runs; run++) {
            for (const engine of rotate(run)) {
              checkInterrupted()
              const context = { ...identity, engine, run }
              const launched = await phase('warm launch', context, () =>
                launch(engine),
              )
              try {
                const { page } = launched
                const startup = await phase('warm startup', context, () =>
                  navigate(page, servings[engine], builds[engine]),
                )
                const nodes = await page.evaluate(() =>
                  window.meetingUiBench.placementNodes(),
                )
                if (!nodes.length)
                  throw new Error('The fixture has no road nodes to target')
                const timerResolutionMs = await page.evaluate(() =>
                  window.meetingUiBench.timerResolution(),
                )
                const groups = []
                const originKeys = new Set()
                for (const size of config.groups) {
                  await phase('origin count', { ...context, size }, () =>
                    setOriginCount(page, size),
                  )
                  for (const objective of OBJECTIVES) {
                    const samples = []
                    for (
                      let index = 0;
                      index < WARMUPS + config.samples;
                      index++
                    ) {
                      checkInterrupted()
                      const warmup = index < WARMUPS
                      const key = `run ${run}/group ${size}/objective ${objective}/${warmup ? `warmup ${index}` : `sample ${index - WARMUPS}`}`
                      const sample = await phase(
                        'sample',
                        { ...context, key },
                        () =>
                          runSample(
                            page,
                            nodes,
                            size,
                            objective,
                            `${config.seed}/${key}`,
                            startup.worker,
                          ),
                      )
                      if (originKeys.has(sample.originKey))
                        throw new Error(`Repeated origin cohort for ${key}`)
                      originKeys.add(sample.originKey)
                      samples.push({ ...sample, key, warmup })
                    }
                    const artifact =
                      run === 0
                        ? await screenshot(
                            page,
                            config.artifacts,
                            `${browserName}-${profile}-${engine}-g${size}-${objective}-results`,
                          )
                        : null
                    const interactions = await phase(
                      'interactions',
                      { ...context, size, objective },
                      () =>
                        interactionProfile(
                          page,
                          config.canvasProfile
                            ? {
                                browser: launched.browser,
                                identity: {
                                  ...identity,
                                  engine,
                                  kind: 'warm',
                                  index: run,
                                  size,
                                  objective,
                                },
                                traces: report.canvasProfile.traces,
                                directory: config.artifacts,
                                prefix: `${browserName}-${profile}-${engine}-warm-${run}-g${size}-${objective}`,
                              }
                            : null,
                        ),
                    )
                    groups.push({
                      size,
                      objective,
                      samples,
                      interactions,
                      artifact,
                    })
                  }
                }
                const memory = await page.evaluate(() =>
                  window.meetingUiBench.memory(),
                )
                // Cancellation can terminate the retained worker; collect first.
                const retainedWorkerEvidence = await workerEvidence(
                  page,
                  builds[engine].wasmProfiling,
                )
                const warmPageEvidence = await pageEvidence(
                  page,
                  config.canvasProfile,
                  'Warm navigation, source placement, warmups, samples and playback/seek/pan/fit interactions; ends before cancellationCheck and excludes cancellation/recovery/unload',
                )
                const finalSize = groups.at(-1).size
                const cancellation = await phase('cancellation', context, () =>
                  cancellationCheck(
                    page,
                    nodes,
                    finalSize,
                    `${config.seed}/run ${run}/cancel`,
                    startup.worker,
                  ),
                )
                assertClean(launched)
                entry.warm.push({
                  engine,
                  run,
                  browserVersion: launched.browserVersion,
                  browserChannel: launched.browserChannel,
                  throttle: launched.throttle,
                  timerResolutionMs,
                  startup,
                  groups,
                  memory,
                  workerEvidence: retainedWorkerEvidence,
                  cancellation,
                  ...warmPageEvidence,
                })
              } finally {
                await closePage(launched, browsers)
              }
            }
          }
          entry.consistency = checkConsistency(entry.cold, entry.warm)
          entry.summaries = Object.fromEntries(
            config.engines.map((engine) => [
              engine,
              summarizeEngine(
                config,
                entry.cold.filter((sample) => sample.engine === engine),
                entry.warm.filter((run) => run.engine === engine),
              ),
            ]),
          )
          entry.coverage = completedCoverage(config, [entry])
          entry.comparisons = compare(config, entry.summaries, entry.coverage)
          entry.cancellationNotExercised = entry.warm
            .filter((run) => run.cancellation.status !== 'exercised')
            .map(({ engine, run }) => ({ engine, run }))
          entry.status = 'passed'
          report.availability.push({
            ...identity,
            status: 'available',
            executablePath: playwright[browserName].executablePath(),
          })
        } catch (error) {
          if (
            error instanceof BrowserUnavailable &&
            !entry.cold.length &&
            !entry.warm.length
          ) {
            report.runs.pop()
            unavailable.add(browserName)
            report.availability.push({
              ...identity,
              status: 'unavailable',
              reason: 'Playwright browser executable is not installed',
              defaultExecutablePath: playwright[browserName].executablePath(),
              detail: error.message,
            })
            continue
          }
          entry.status = 'failed'
          entry.error = error instanceof Error ? error.stack : String(error)
          throw new Error(
            `${browserName}/${profile}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
      }
    }
    if (!report.runs.some((run) => run.status === 'passed'))
      throw new Error('No requested browser/profile was available')
    const counts = completedCoverage(config, report.runs)
    const coverage = promotionCoverage(config, counts)
    report.evidence = {
      phase0Eligible:
        coverage.reasons.every(
          (reason) => reason === 'warm-samples' || reason === 'warm-launches',
        ) &&
        counts.warmSamples >= 20 &&
        counts.warmLaunches >= 1 &&
        counts.coldSamples >= 20,
      promotionEligible: coverage.eligible,
      coverage: { ...counts, ...coverage },
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    try {
      await cleanup()
    } catch (error) {
      report.status = 'failed'
      report.cleanupError = String(error)
      process.exitCode = 1
    }
    process.removeListener('SIGINT', interrupt)
    // Include explicit diagnostic ineligibility even on failed/partial runs.
    if (config.canvasProfile && !report.evidence)
      report.evidence = {
        phase0Eligible: false,
        promotionEligible: false,
        coverage: { eligible: false, reasons: ['diagnostic-canvas-profile'] },
      }
    process.removeListener('SIGTERM', interrupt)
    report.finishedAt = new Date().toISOString()
    if (interrupted) {
      report.status = 'failed'
      report.error = 'Benchmark interrupted'
      process.exitCode = 1
    }
    await mkdir(dirname(config.out), { recursive: true })
    await writeFile(config.out, `${JSON.stringify(report, null, 2)}\n`)
    process.stderr.write(`${report.status}: ${config.out}\n`)
    if (report.error) process.stderr.write(`${report.error}\n`)
  }
}

try {
  const config = options(process.argv.slice(2))
  if (config) await main(config)
  else process.stdout.write(help)
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  )
  process.exitCode = 1
}
