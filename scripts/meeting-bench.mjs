#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
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
import { createRequire } from 'node:module'
import { cpus, platform, release, totalmem } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const help = `Meeting-point real-browser numerical benchmark

Usage: node scripts/meeting-bench.mjs --out PATH [options]

  --browser chromium,firefox,webkit  Browsers (default: all three)
  --profile baseline,cpu4           Profiles (default: both; cpu4 Chromium only)
  --engine current,scalar,wasm      Engines (default: current,scalar; current always validates)
  --groups 2,4,8,16,duplicates       Cases (default: all; duplicates means coincident-4)
  --objectives fair,total           Objectives (default: both)
  --runs N                          Fresh browser launches per browser/profile (default: 1)
  --fixture PATH                    Normalized local MeetingNetwork JSON (default: bundled SF)
  --samples N                       Measured warm samples per case (default: 20; minimum: 20)
  --warmups N                       Warmups per case (default: 2; minimum: 2)
  --seed N                          Nonnegative 32-bit origins/order seed (default: 2119)
  --smoke                           Default 3 samples; permits fewer than 20; NEVER promotion evidence
  --out PATH                        Required machine-readable JSON destination (overwritten)
  --help                            Print this help without loading Vite/Playwright

Examples:
  node scripts/meeting-bench.mjs --smoke --browser chromium --profile baseline --out meeting-smoke.json
  node scripts/meeting-bench.mjs --out meeting-sf.json
  node scripts/meeting-bench.mjs --fixture /path/to/non-sf.json --out meeting-non-sf.json
  node scripts/meeting-bench.mjs --groups 4,16 --objectives fair,total --samples 100 --runs 3 --out meeting-gates.json
  node scripts/meeting-bench.mjs --engine scalar,wasm --groups 4,16 --samples 100 --runs 3 --out meeting-wasm.json

No geocoding/Overpass traffic. Builds disposable, isolated assets with installed Vite.
Runs real module workers with installed Playwright browser binaries; never downloads them.
CPU4 uses CDP page Emulation only: worker throttle is UNVERIFIED, not mobile/GPU coverage.
JSON preserves missing-browser/profile availability and fails loudly on runtime/parity errors.
Missing browsers alone do not fail if another run succeeds; no successful runs exits nonzero.
This numerical harness cannot satisfy the plan's production UI, cold-distribution or GPU gates.
Warm engines are interleaved in seeded ABBA/BAAB blocks; odd counts end with a partial block.
Each launch retains its own run ID, raw rows, summaries and first-10/last-10 drift; no pooled runs.
The phase-1 r4 contract freezes scalar as the JS baseline before WASM; this report selects none.
UI/cold promotion gates require the separate real-UI harness, even with --samples 100 --runs N.
Build real bindings with build:wasm:meeting before using this harness.
WASM is imported only when selected; JS-only startup does not initialize it.
Disposable builds use meeting-benchmark mode for named worker performance measures.
`

function options(args) {
  if (args.includes('--help')) return null
  const flags = new Map()
  let smoke = false
  const accepted = new Set([
    '--browser',
    '--profile',
    '--engine',
    '--groups',
    '--objectives',
    '--runs',
    '--fixture',
    '--samples',
    '--warmups',
    '--seed',
    '--out',
  ])
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--smoke') {
      if (smoke) throw new Error('Duplicate --smoke')
      smoke = true
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
  const fixture = resolve(
    flags.get('--fixture') ?? join(root, 'public/lab/meeting-point/sf.json'),
  )
  const out = resolve(flags.get('--out'))
  if (fixture === out) throw new Error('--out must not overwrite the fixture')
  return {
    browsers: list('--browser', 'chromium,firefox,webkit', [
      'chromium',
      'firefox',
      'webkit',
    ]),
    profiles: list('--profile', 'baseline,cpu4', ['baseline', 'cpu4']),
    engines: list('--engine', 'current,scalar', ['current', 'scalar', 'wasm']),
    groups: list('--groups', '2,4,8,16,duplicates', [
      '2',
      '4',
      '8',
      '16',
      'duplicates',
    ]),
    objectives: list('--objectives', 'fair,total', ['fair', 'total']),
    runs: integer('--runs', 1, 1, 1000),
    samples: integer('--samples', smoke ? 3 : 20, smoke ? 1 : 20, 10000),
    warmups: integer('--warmups', 2, 2, 1000),
    seed: integer('--seed', 2119, 0, 0xffffffff),
    fixture,
    out,
    smoke,
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
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
  }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? '/', 'http://localhost').pathname,
      )
      const path =
        pathname === '/fixture.json'
          ? fixture
          : resolve(
              directory,
              `.${pathname === '/' ? '/index.html' : pathname}`,
            )
      if (path !== fixture && !path.startsWith(`${directory}${sep}`)) {
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

async function main(config) {
  const report = {
    schemaVersion: 2,
    contract: 'meeting-accel-execution r1',
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
    runs: [],
    availability: [],
    limitations: [
      'Headless Playwright is not the final production real-UI check.',
      'Automated WebKit is not evidence for actual Safari GPU behavior.',
      'CPU4 is page-only CDP throttling, with worker CPU coverage unverified; no weak-GPU or genuine mobile emulation claim.',
      'One fixture per invocation; run again with --fixture for non-SF evidence. No non-SF graph is fabricated.',
      'Node memory snapshots cover the CLI only, not browser/worker processes; peak process memory is unavailable.',
      'Fresh browser launches are reported independently, never pooled into one summary or winner.',
      'Numerical timings do not select the best JS baseline or pass production UI/cold gates; use repeated evidence and the separate real-UI harness.',
    ],
  }
  let temporary
  let server
  let browser
  let cleanupPromise
  let interrupted = false
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const failures = []
      if (browser) {
        try {
          await browser.close()
        } catch (error) {
          failures.push(String(error))
        }
      }
      if (server) {
        const { promise, resolve: closed, reject } = Promise.withResolvers()
        server.close((error) => (error ? reject(error) : closed()))
        server.closeAllConnections()
        try {
          await promise
        } catch (error) {
          failures.push(String(error))
        }
      }
      if (temporary) {
        try {
          await rm(temporary, { recursive: true, force: true, maxRetries: 3 })
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
    // Interrupt a running evaluation, but leave resource cleanup to finally:
    // an in-flight build/launch must finish assigning its resources first.
    void browser?.close().catch((error) => {
      process.stderr.write(`${error}\n`)
    })
  }
  const checkInterrupted = () => {
    if (interrupted) throw new Error('Benchmark interrupted')
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const [{ build, version: viteVersion }, playwright] = await Promise.all([
      import('vite'),
      import('playwright'),
    ])
    const require = createRequire(import.meta.url)
    report.versions = {
      vite: viteVersion,
      playwright: require('playwright/package.json').version,
    }
    const fixtureBytes = await readFile(config.fixture)
    report.fixture = {
      path: config.fixture,
      sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
      jsonBytes: fixtureBytes.length,
    }
    checkInterrupted()
    // A sibling of scripts keeps relative HTML imports portable on Windows and POSIX.
    temporary = await mkdtemp(join(root, '.meeting-bench-'))
    const frozenFixture = join(temporary, 'fixture.json')
    await writeFile(frozenFixture, fixtureBytes)
    await writeFile(
      join(temporary, 'index.html'),
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Meeting numerical benchmark</title><script type="module" src="../scripts/meeting-bench/browser.ts"></script><body>Numerical benchmark; no map UI.</body></html>',
    )
    const directory = join(temporary, 'dist')
    const buildStart = performance.now()
    await build({
      configFile: false,
      mode: 'meeting-benchmark',
      root: temporary,
      publicDir: false,
      logLevel: 'warn',
      resolve: { alias: { '@': join(root, 'src') } },
      build: {
        outDir: directory,
        emptyOutDir: true,
        target: 'es2022',
        assetsInlineLimit: 0,
        minify: true,
        sourcemap: false,
      },
      worker: { format: 'es' },
    })
    checkInterrupted()
    report.assetBuildMs = performance.now() - buildStart
    report.assets = await assetSizes(directory)
    report.wasm = config.engines.includes('wasm')
      ? {
          status: 'selected',
          bindings: 'crates/meeting-point/pkg/meeting_point.js',
          memoryScope:
            'Actual committed linear memory reported per search result',
        }
      : { status: 'not-selected', reason: 'JavaScript-only run' }
    const serving = await serve(directory, frozenFixture)
    server = serving.server
    for (const browserName of config.browsers) {
      for (const profile of config.profiles) {
        for (let runIndex = 1; runIndex <= config.runs; runIndex++) {
          checkInterrupted()
          const identity = {
            browser: browserName,
            profile,
            runIndex,
            runId: `${browserName}/${profile}/run-${runIndex}`,
          }
          if (profile === 'cpu4' && browserName !== 'chromium') {
            report.availability.push({
              ...identity,
              status: 'unavailable',
              reason: 'CDP CPU throttling is Chromium-only',
            })
            continue
          }
          const browserType = playwright[browserName]
          const executable = browserType.executablePath()
          try {
            // An existing executable that fails to launch is an error, not silently missing coverage.
            try {
              browser = await browserType.launch({ headless: true })
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.includes("Executable doesn't exist at")
              ) {
                report.availability.push({
                  ...identity,
                  status: 'unavailable',
                  reason: 'Playwright browser executable is not installed',
                  defaultExecutablePath: executable,
                  detail: error.message,
                })
                continue
              }
              throw error
            }
            checkInterrupted()
            const context = await browser.newContext({
              viewport: { width: 1280, height: 800 },
              deviceScaleFactor: 1,
            })
            await context.route('**/*', (route) => {
              const url = new URL(route.request().url())
              return url.origin === serving.url
                ? route.continue()
                : route.abort('blockedbyclient')
            })
            const page = await context.newPage()
            page.setDefaultTimeout(120_000)
            const pageErrors = []
            page.on('pageerror', (error) => pageErrors.push(error.message))
            let cdp
            let throttle = {
              requestedRate: 1,
              scope: 'none',
              workerThrottleVerified: false,
            }
            if (browserName === 'chromium') {
              cdp = await context.newCDPSession(page)
              if (profile === 'cpu4') {
                await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
                throttle = {
                  requestedRate: 4,
                  scope:
                    'page CDP Emulation only; worker execution NOT verified as throttled',
                  workerThrottleVerified: false,
                }
              }
            }
            const navigationStart = performance.now()
            await page.goto(serving.url, { waitUntil: 'load' })
            await page.waitForFunction(
              () => typeof window.meetingBench?.run === 'function',
            )
            const navigationToClientReadyMs =
              performance.now() - navigationStart
            const nodeMemoryBefore = process.memoryUsage()
            const results = await page.evaluate(
              async ({
                engines,
                groups,
                objectives,
                warmups,
                samples,
                seed,
                smoke,
                runId,
              }) =>
                window.meetingBench.run({
                  engines,
                  groups,
                  objectives,
                  warmups,
                  samples,
                  seed,
                  smoke,
                  runId,
                }),
              { ...config, runId: identity.runId },
            )
            if (pageErrors.length)
              throw new Error(`Page runtime errors: ${pageErrors.join('; ')}`)
            report.runs.push({
              ...identity,
              status: 'passed',
              browserVersion: browser.version(),
              throttle,
              navigationToClientReadyMs,
              nodeMemory: {
                scope: 'CLI process only; excludes browser and workers',
                before: nodeMemoryBefore,
                after: process.memoryUsage(),
              },
              results,
            })
            report.availability.push({
              ...identity,
              status: 'available',
              defaultExecutablePath: executable,
            })
            await context.close()
          } catch (error) {
            report.runs.push({
              ...identity,
              status: 'failed',
              error: error instanceof Error ? error.stack : String(error),
            })
            throw new Error(`${identity.runId}: ${String(error)}`)
          } finally {
            if (browser) await browser.close()
            browser = undefined
          }
        }
      }
    }
    if (!report.runs.some((run) => run.status === 'passed'))
      throw new Error('No requested browser/profile was available')
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
