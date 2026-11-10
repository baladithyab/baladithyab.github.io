/**
 * Client entry for /lab/energy-ring.
 *
 * JavaScript owns the frame loop, canvas sizing, and the audio graph. The
 * Rust crate (crates/energy-ring, built by `bun run build:wasm`) owns the
 * analysis and every WebGL call.
 */

import init, { EnergyRing } from '../../crates/energy-ring/pkg/energy_ring.js'

import { tapPageAudio } from '@/lib/audio-bus'
import { renderDemoLoop } from '@/lib/demo-loop'

const METERS = ['bass', 'mid', 'treble', 'beat'] as const
/** Backing-store scale cap; the ring shader runs per pixel. */
const MAX_PIXEL_RATIO = 2

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`#${id} is missing`)
  return found
}

const canvas = element('energy-ring-canvas', HTMLCanvasElement)
const status = element('energy-ring-status', HTMLElement)
const audio = element('energy-ring-audio', HTMLAudioElement)
const filePicker = element('energy-ring-file', HTMLInputElement)

function report(problem: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  status.textContent = `${problem}: ${detail}`
}

async function startRing() {
  const started = performance.now()
  await init()
  const ring = new EnergyRing(canvas)
  const loadMs = Math.round(performance.now() - started)
  status.textContent = `Rust renderer ready in ${loadMs} ms. Press play.`

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  ring.calm = reducedMotion.matches
  reducedMotion.addEventListener('change', () => {
    ring.calm = reducedMotion.matches
  })

  new ResizeObserver(() => {
    const scale = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO)
    canvas.width = Math.round(canvas.clientWidth * scale)
    canvas.height = Math.round(canvas.clientHeight * scale)
    // Resizing clears the canvas; redraw before the browser paints.
    ring.frame(performance.now())
  }).observe(canvas)

  void tapPageAudio().then((bus) => {
    ring.connect(bus.analyser)
    status.textContent = 'Reacting to page audio.'
  })

  const meters = METERS.map((name) => ({
    name,
    bar: element(`energy-ring-${name}`, HTMLElement),
  }))
  const tick = (now: number) => {
    ring.frame(now)
    for (const { name, bar } of meters) bar.style.scale = `${ring[name]} 1`
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

async function loadAudio() {
  let objectUrl = URL.createObjectURL(await renderDemoLoop())
  audio.src = objectUrl

  filePicker.addEventListener('change', () => {
    const file = filePicker.files?.[0]
    if (!file) return
    URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(file)
    audio.src = objectUrl
    audio
      .play()
      .catch((cause: unknown) => report('Could not play that file', cause))
  })
}

startRing().catch((cause: unknown) =>
  report('Energy ring failed to start', cause),
)
loadAudio().catch((cause: unknown) =>
  report('Demo audio failed to render', cause),
)
