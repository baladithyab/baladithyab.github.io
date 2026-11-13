#!/usr/bin/env node
// Memory-only companion to meeting-ui-bench.mjs. Usage: node scripts/meeting-ui-memory.mjs --out report.json
// Protocol reference: installed playwright-core/types/protocol.d.ts (Playwright 1.65.0),
// SystemInfo.getInfo/getProcessInfo, Target.attachToTarget/sendMessageToTarget/receivedMessageFromTarget,
// Runtime.getHeapUsage and HeapProfiler.collectGarbage. No private Playwright connection APIs.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const timeoutMs = 5_000
const now = () => new Date().toISOString()
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function bounded(operation, task) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${operation}: timeout after ${timeoutMs} ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function observe(operation, task) {
  const startedAt = now()
  try {
    const value = await bounded(operation, task)
    return {
      status: 'observed',
      operation,
      startedAt,
      finishedAt: now(),
      value,
    }
  } catch (error) {
    return {
      status: 'unavailable',
      operation,
      startedAt,
      finishedAt: now(),
      error: String(error),
    }
  }
}

// Non-flattened Target messaging is public CDP, but deprecated. If Chromium removes
// it, the recorded error is the coverage result; do not use private session internals.
function workerSession(browserSession, sessionId) {
  let nextId = 0
  return {
    send(method) {
      const id = ++nextId
      return new Promise((resolveMessage, reject) => {
        const finish = (error, result) => {
          clearTimeout(timer)
          browserSession.off('Target.receivedMessageFromTarget', received)
          if (error) reject(error)
          else resolveMessage(result)
        }
        const received = (event) => {
          if (event.sessionId !== sessionId) return
          try {
            const message = JSON.parse(event.message)
            if (message.id !== id) return
            finish(
              message.error ? new Error(JSON.stringify(message.error)) : null,
              message.result,
            )
          } catch (error) {
            finish(error)
          }
        }
        const timer = setTimeout(
          () => finish(new Error(`${method}: worker response timeout`)),
          timeoutMs,
        )
        browserSession.on('Target.receivedMessageFromTarget', received)
        browserSession
          .send('Target.sendMessageToTarget', {
            sessionId,
            message: JSON.stringify({ id, method, params: {} }),
          })
          .catch((error) => finish(error))
      })
    },
    detach: () => browserSession.send('Target.detachFromTarget', { sessionId }),
  }
}

async function processMemory(browserSession) {
  const inventory = await observe('SystemInfo.getProcessInfo', () =>
    browserSession.send('SystemInfo.getProcessInfo'),
  )
  if (inventory.status !== 'observed')
    return { status: 'unavailable', inventory }
  const processes = inventory.value.processInfo
  if (
    !Array.isArray(processes) ||
    !processes.length ||
    processes.some(
      ({ id }) => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647,
    )
  ) {
    return {
      status: 'unavailable',
      inventory,
      error: 'CDP returned no usable owned process IDs',
    }
  }
  if (process.platform !== 'win32') {
    return {
      status: 'unavailable',
      inventory,
      error: 'OS memory collection requires Windows PowerShell Get-Process',
    }
  }
  // All input travels over stdin. No process-name search, shell, user-provided
  // command fragments, or enumeration of other browsers/process trees.
  const command = `
$ErrorActionPreference = 'Stop'
$ids = [int[]]([Console]::In.ReadToEnd() | ConvertFrom-Json)
$rows = @(foreach ($processId in $ids) {
  try {
    $p = Get-Process -Id $processId -ErrorAction Stop
    $p.Refresh()
    [pscustomobject]@{ status = 'observed'; id = $p.Id; startTimeUtc = $p.StartTime.ToUniversalTime().ToString('o'); WorkingSet64 = $p.WorkingSet64; PrivateMemorySize64 = $p.PrivateMemorySize64; PeakWorkingSet64 = $p.PeakWorkingSet64 }
  } catch {
    [pscustomobject]@{ status = 'unavailable'; id = $processId; error = $_.Exception.Message }
  }
})
ConvertTo-Json -InputObject $rows -Compress
`
  const readings = await observe(
    'Get-Process numeric CDP IDs',
    () =>
      new Promise((resolveReadings, reject) => {
        const child = execFile(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          {
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
          },
          (error, stdout, stderr) => {
            if (error) return reject(new Error(`${error}; ${stderr}`))
            try {
              const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''))
              if (!Array.isArray(rows) || rows.length !== processes.length)
                throw new Error('Unexpected process reading count')
              for (const row of rows) {
                if (!processes.some(({ id }) => id === row.id))
                  throw new Error('Unexpected process ID')
                if (row.status === 'observed') {
                  if (
                    Date.parse(row.startTimeUtc) >
                    Date.parse(inventory.finishedAt)
                  ) {
                    throw new Error(
                      `PID ${row.id} started after the CDP inventory; possible PID reuse`,
                    )
                  }
                  for (const field of [
                    'WorkingSet64',
                    'PrivateMemorySize64',
                    'PeakWorkingSet64',
                  ]) {
                    if (!Number.isSafeInteger(row[field]) || row[field] < 0)
                      throw new Error(`Unavailable ${field} for PID ${row.id}`)
                  }
                }
              }
              resolveReadings(rows)
            } catch (parseError) {
              reject(parseError)
            }
          },
        )
        child.stdin.on('error', reject)
        child.stdin.end(JSON.stringify(processes.map(({ id }) => id)))
      }),
  )
  return { inventory, readings }
}

async function heap(session) {
  const observation = await observe('Runtime.getHeapUsage', () =>
    session.send('Runtime.getHeapUsage'),
  )
  if (observation.status === 'observed') {
    observation.unavailableFields = [
      'usedSize',
      'totalSize',
      'embedderHeapUsedSize',
      'backingStorageSize',
    ].filter((field) => typeof observation.value[field] !== 'number')
  }
  return observation
}

function instrumentBrowser(browser, record) {
  const captured = new WeakMap()
  const seenWorkers = new Set()
  let queue = Promise.resolve()
  let browserSessionPromise
  const browserSession = () =>
    (browserSessionPromise ??= observe('Browser.newBrowserCDPSession', () =>
      browser.newBrowserCDPSession(),
    ))

  async function capture(page, reason) {
    const snapshot = {
      reason,
      pageUrl: page.url(),
      startedAt: now(),
      targets: [],
      errors: [],
    }
    record.snapshots.push(snapshot)
    const sessions = []
    const rootSession = await browserSession()
    // Never serialize the Playwright session object into the report.
    if (rootSession.status !== 'observed') snapshot.browserSession = rootSession
    const cdp = rootSession.status === 'observed' ? rootSession.value : null
    try {
      snapshot.workload = await observe(
        'Benchmark completed reply and rendered origins',
        () =>
          page.evaluate(() => {
            const api = window.meetingUiBench
            const completed = api?.lastCompletedSearch?.()
            if (!completed)
              throw new Error('No matched completed search observation')
            const inputs = [
              ...document.querySelectorAll('input[id^="meeting-origin-"]'),
            ]
            const validInputs = inputs.filter(
              (input) =>
                input.value.trim() &&
                input.getAttribute('aria-invalid') !== 'true',
            ).length
            if (
              !Number.isSafeInteger(completed.originCount) ||
              completed.originCount < 2 ||
              completed.treeCount !== completed.originCount ||
              inputs.length !== completed.originCount ||
              validInputs !== inputs.length ||
              !api.resultsVisible()
            )
              throw new Error(
                'Completed reply does not match valid rendered starts/results',
              )
            return {
              lastCompletedSearch: completed,
              renderedOriginInputs: inputs.length,
              validOriginInputs: validInputs,
              resultsVisible: true,
            }
          }),
      )
      const pageSession = await observe(
        'BrowserContext.newCDPSession(page)',
        () => page.context().newCDPSession(page),
      )
      if (pageSession.status === 'observed') {
        const identity = await observe('Target.getTargetInfo', () =>
          pageSession.value.send('Target.getTargetInfo'),
        )
        const target = {
          scope: 'main page V8 isolate (not exclusively this Runtime)',
          identity,
          type: identity.value?.targetInfo.type ?? 'page',
          url: page.url(),
        }
        snapshot.targets.push(target)
        sessions.push({ target, session: pageSession.value })
      } else snapshot.errors.push(pageSession)

      if (cdp) {
        if (!record.gpuInfo)
          record.gpuInfo = await observe('SystemInfo.getInfo', async () => {
            const { gpu } = await cdp.send('SystemInfo.getInfo')
            // Select GPU metadata only; never retain the browser commandLine.
            return {
              devices: gpu.devices,
              featureStatus: gpu.featureStatus,
              auxAttributes: gpu.auxAttributes
                ? Object.fromEntries(
                    [
                      'glVendor',
                      'glRenderer',
                      'glVersion',
                      'glImplementationParts',
                      'displayType',
                      'passthroughCmdDecoder',
                      'sandboxed',
                      'inProcessGpu',
                    ]
                      .filter((key) => Object.hasOwn(gpu.auxAttributes, key))
                      .map((key) => [key, gpu.auxAttributes[key]]),
                  )
                : undefined,
            }
          })
        snapshot.inventory = await observe('Target.getTargets', () =>
          cdp.send('Target.getTargets'),
        )
        if (snapshot.inventory.status === 'observed') {
          const workers = snapshot.inventory.value.targetInfos.filter(
            ({ type }) =>
              ['worker', 'shared_worker', 'service_worker'].includes(type),
          )
          snapshot.workerCoverage = workers.length
            ? 'Enumerated live workers only'
            : 'No live worker targets enumerated; worker heap coverage unavailable'
          for (const info of workers) {
            if (seenWorkers.has(info.targetId)) continue
            seenWorkers.add(info.targetId)
            const target = {
              ...info,
              scope:
                'worker V8 isolate in this owned browser; not a proven page-to-worker mapping',
            }
            snapshot.targets.push(target)
            const attached = await observe('Target.attachToTarget', () =>
              cdp.send('Target.attachToTarget', {
                targetId: info.targetId,
                flatten: false,
              }),
            )
            if (attached.status === 'observed')
              sessions.push({
                target,
                session: workerSession(cdp, attached.value.sessionId),
              })
            else target.attach = attached
          }
        } else snapshot.workerCoverage = 'Unavailable: Target.getTargets failed'
        snapshot.processBeforeGc = await processMemory(cdp)
      } else {
        record.gpuInfo ??= {
          status: 'unavailable',
          operation: 'SystemInfo.getInfo',
          error: 'Browser CDP session unavailable; GPU metadata not queried',
        }
        snapshot.workerCoverage = 'Unavailable: browser CDP session failed'
        snapshot.processBeforeGc = {
          status: 'unavailable',
          error: 'Browser CDP session unavailable; no OS processes queried',
        }
      }
      for (const { target, session } of sessions)
        target.beforeGc = await heap(session)
      for (const { target, session } of sessions)
        target.gc = await observe('HeapProfiler.collectGarbage', () =>
          session.send('HeapProfiler.collectGarbage'),
        )
      for (const { target, session } of sessions) {
        target.afterGcAttempt = await heap(session)
        target.postGcHeapObserved =
          target.gc.status === 'observed' &&
          target.afterGcAttempt.status === 'observed'
      }
      if (cdp) snapshot.processAfterGcAttempts = await processMemory(cdp)
      else
        snapshot.processAfterGcAttempts = {
          status: 'unavailable',
          error: 'Browser CDP session unavailable; no OS processes queried',
        }
      snapshot.allAttachedTargetsGcSucceeded =
        sessions.length > 0 &&
        sessions.every(({ target }) => target.gc.status === 'observed')
    } catch (error) {
      snapshot.errors.push({
        status: 'unavailable',
        operation: 'capture',
        error: String(error),
      })
    } finally {
      for (const { target, session } of sessions)
        target.detach = await observe('CDP target detach', () =>
          session.detach(),
        )
      snapshot.finishedAt = now()
    }
  }

  function captureOnce(page, reason) {
    if (!captured.has(page)) {
      // Serializes racing unload/close calls. A subsequent context/browser close
      // waits for the existing capture instead of terminating its worker early.
      const pending = queue
        .then(() => capture(page, reason))
        .catch((error) =>
          record.errors.push(`Memory capture unavailable: ${error}`),
        )
      captured.set(page, pending)
      queue = pending
    }
    return captured.get(page)
  }
  function instrumentPage(page) {
    if (record.pages.has(page)) return
    record.pages.add(page)
    const goto = page.goto.bind(page)
    page.goto = async (...args) => {
      // The runner unloads its local warm page before asserting worker teardown.
      // Capture first, but still perform the original navigation and assertion.
      if (
        args[0] === 'about:blank' &&
        page.url().startsWith('http://127.0.0.1:')
      )
        await captureOnce(page, 'pre-unload')
      return goto(...args)
    }
    const close = page.close.bind(page)
    page.close = async (...args) => {
      await captureOnce(page, 'page.close')
      return close(...args)
    }
  }
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async (...args) => {
    const context = await newContext(...args)
    context.on('page', instrumentPage)
    const newPage = context.newPage.bind(context)
    context.newPage = async (...pageArgs) => {
      const page = await newPage(...pageArgs)
      instrumentPage(page)
      return page
    }
    const close = context.close.bind(context)
    context.close = async (...closeArgs) => {
      await Promise.all(
        context.pages().map((page) => captureOnce(page, 'context.close')),
      )
      return close(...closeArgs)
    }
    return context
  }
  const close = browser.close.bind(browser)
  let closing
  browser.close = (...args) =>
    (closing ??= (async () => {
      await Promise.all(
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .map((page) => captureOnce(page, 'browser.close')),
      )
      if (!record.snapshots.length)
        record.errors.push(
          'Browser closed without a live page; no unload/close-boundary memory observation',
        )
      if (browserSessionPromise) {
        const session = await browserSessionPromise
        if (session.status === 'observed')
          record.detach = await observe('Browser CDP detach', () =>
            session.value.detach(),
          )
      }
      return close(...args)
    })())
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node scripts/meeting-ui-memory.mjs --out report.json\nMemory only: current+scalar, local SF, Chromium baseline, smoke, samples=1, cold=1, runs=1, groups=4,16. No timing gate evidence.\n',
    )
    return
  }
  if (
    args.length !== 2 ||
    args[0] !== '--out' ||
    !args[1] ||
    args[1].startsWith('--')
  )
    throw new Error('Expected --out report.json; use --help')
  const out = resolve(args[1])
  const fixture = join(root, 'public/lab/meeting-point/sf.json')
  const runner = new URL('./meeting-ui-bench.mjs', import.meta.url)
  if (
    [fixture, fileURLToPath(runner), fileURLToPath(import.meta.url)].some(
      (path) => path.toLowerCase() === out.toLowerCase(),
    )
  )
    throw new Error('--out must not overwrite the fixture or profiling scripts')
  const report = {
    schemaVersion: 2,
    kind: 'meeting-ui-memory-only',
    startedAt: now(),
    status: 'running',
    timingGateEligible: false,
    config: {
      engines: ['current', 'scalar'],
      browser: 'chromium',
      profile: 'baseline',
      smoke: true,
      samples: 1,
      coldSamples: 1,
      runs: 1,
      groups: [4, 16],
      fixture,
      commandTimeoutMs: timeoutMs,
    },
    provenance: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    browsers: [],
    errors: [],
    limitations: [
      'Instrumentation and explicit GC invalidate performance-gating claims. Native runner timings are deliberately excluded from this memory report.',
      'Once per page, before the runner navigates its local benchmark page to about:blank (pre-unload), otherwise before its first intercepted page/context/browser close. Initial blank-to-benchmark navigation is not captured; later closes reuse the capture. The original unload navigation and worker-teardown assertion still run.',
      'Cold captures are end-first-result; warm captures are end-cancel/recovery, before unload. Each snapshot.workload records the last matched completed worker reply and the actual valid rendered-start count; the retained group is not inferred from configuration. Missing/mismatched observations are explicitly unavailable. Captures are not per group/objective, the process includes earlier workloads, and workers terminated earlier are not measured.',
      'Runtime.getHeapUsage measures an entire V8 isolate: usedSize is used JS heap, totalSize allocated JS heap, embedderHeapUsedSize embedder GC heap, backingStorageSize ArrayBuffer/external-string backing storage. Missing fields are unavailable, never zero-filled. Isolates are not summed.',
      'Successful explicit GC plus a heap reading observes GC-retained JS at that instant, not proof of a leak. Application activity can continue between sequential samples.',
      'Process WorkingSet64 is observed residency; PrivateMemorySize64 is private process memory, not JS heap. Post-GC process residency can remain high despite reclaimed JS. No GPU-memory or WASM-committed-memory measurement is made.',
      'PeakWorkingSet64 is each live process lifetime peak, including startup and instrumentation. Peaks are never added or presented as a simultaneous aggregate. Exited processes and processes absent from SystemInfo.getProcessInfo are not covered.',
      'SystemInfo.getInfo GPU devices, featureStatus and selected graphics/process auxAttributes are read-only metadata per owned browser, not GPU-time, utilization or GPU-memory evidence. The browser commandLine is omitted; missing optional metadata is not inferred.',
      'Only numeric PIDs from this launched browser CDP session are queried. CDP inventory and OS samples are non-atomic; process exit/PID reuse is possible. Start times are retained and processes starting after inventory are rejected.',
      'Worker transport uses public non-flattened Target messaging, which is deprecated. Unsupported attachment, commands, timeouts, target loss and non-Windows process readings are explicit unavailable records. Other target types are inventoried but not heap-profiled.',
      'No external fixture/provider queries: the unmodified runner serves bundled SF locally and blocks non-local browser requests. No existing user browser is connected to.',
    ],
  }
  let temporary
  let chromium
  let originalLaunch
  const argv = process.argv
  try {
    temporary = await mkdtemp(join(tmpdir(), 'meeting-ui-memory-'))
    const nativeOut = join(temporary, 'runner.json')
    const require = createRequire(import.meta.url)
    report.provenance.playwright = require('playwright/package.json').version
    report.provenance.runnerSha256 = digest(await readFile(runner))
    report.provenance.wrapperSha256 = digest(
      await readFile(new URL(import.meta.url)),
    )
    report.provenance.fixtureSha256 = digest(await readFile(fixture))
    ;({ chromium } = await import('playwright'))
    originalLaunch = chromium.launch
    chromium.launch = async (...launchArgs) => {
      const browser = await originalLaunch.apply(chromium, launchArgs)
      const record = {
        launch: report.browsers.length + 1,
        version: browser.version(),
        launchOptions: launchArgs[0],
        snapshots: [],
        errors: [],
      }
      // Private JS bookkeeping is non-enumerable; reports contain only observations.
      Object.defineProperty(record, 'pages', { value: new WeakSet() })
      report.browsers.push(record)
      instrumentBrowser(browser, record)
      return browser
    }
    process.argv = [
      argv[0],
      fileURLToPath(runner),
      '--out',
      nativeOut,
      '--engine',
      'current,scalar',
      '--browser',
      'chromium',
      '--profile',
      'baseline',
      '--smoke',
      '--samples',
      '1',
      '--cold-samples',
      '1',
      '--runs',
      '1',
      '--groups',
      '4,16',
      '--fixture',
      fixture,
    ]
    report.provenance.runnerArguments = process.argv.slice(2)
    // The existing module explicitly top-level-awaits main(config), including its
    // cleanup and native JSON write. Import completion is therefore main completion,
    // not just launch completion; never finalize from the launch/close hook itself.
    await import(runner.href)
    const native = JSON.parse(await readFile(nativeOut, 'utf8'))
    report.runner = {
      status: native.status,
      config: native.config,
      startedAt: native.startedAt,
      finishedAt: native.finishedAt,
      fixture: native.fixture,
      versions: native.versions,
      availability: native.availability,
      error: native.error,
      cleanupError: native.cleanupError,
      builds: Object.fromEntries(
        Object.entries(native.builds ?? {}).map(
          ([engine, { buildMs, ...identity }]) => [engine, identity],
        ),
      ),
    }
    for (const browser of report.browsers) {
      for (const snapshot of browser.snapshots) {
        // Match actual worker asset URLs, not an assumed launch order. Ambiguous
        // or missing identity remains an empty/multiple-candidate list.
        const workerPaths = snapshot.targets
          .filter(({ type }) => type === 'worker')
          .map(({ url }) => {
            try {
              return new URL(url).pathname.slice(1)
            } catch {
              return null
            }
          })
        snapshot.engineCandidatesByWorkerAsset = Object.entries(
          native.builds ?? {},
        )
          .filter(([, build]) =>
            build.assets.some(({ path }) => workerPaths.includes(path)),
          )
          .map(([engine]) => engine)
      }
    }
    report.status =
      native.status === 'passed' && !process.exitCode
        ? 'completed'
        : 'runner-failed'
    if (!report.browsers.length)
      report.errors.push(
        'No owned Chromium browser launched; memory coverage unavailable',
      )
  } catch (error) {
    report.status = 'failed'
    report.errors.push(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  } finally {
    process.argv = argv
    if (chromium && originalLaunch) chromium.launch = originalLaunch
    if (temporary) {
      try {
        await rm(temporary, { recursive: true, force: true })
      } catch (error) {
        report.errors.push(`Temporary report cleanup: ${error}`)
        process.exitCode = 1
      }
    }
    report.finishedAt = now()
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
    process.stderr.write(
      `${report.status} (memory only; inspect unavailable coverage): ${out}\n`,
    )
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  )
  process.exitCode = 1
}
