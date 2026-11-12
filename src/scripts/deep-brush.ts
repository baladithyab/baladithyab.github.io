/**
 * Client entry for /lab/deep-brush.
 *
 * JavaScript owns input events, image decoding, the model download and the
 * frame scheduling. The Rust crate (crates/deep-brush, built by
 * `bun run build:wasm`) owns the WebGPU device, the depth network, and every
 * pixel drawn.
 */

import init, { DeepBrush } from '../../crates/deep-brush/pkg/deep_brush.js'

/** Hugging Face revision of depth-anything/Depth-Anything-V2-Small-hf (Apache-2.0). */
const MODEL_URL =
  'https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf/resolve/5426e4f0f36572d16453bbda7a8389317b1bef99/model.safetensors'
const MODEL_CACHE = 'deep-brush-model-v1'
const SAMPLE_URL = '/lab/deep-brush/sample.jpg'
/** Longest edit side; layers and undo snapshots scale with its square. */
const MAX_EDIT_SIDE = 2048
const MAX_DECAL_SIDE = 1024
const MAX_PIXEL_RATIO = 2

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`#${id} is missing`)
  return found
}

const canvas = element('deep-brush-canvas', HTMLCanvasElement)
const stage = element('deep-brush-stage', HTMLElement)
const status = element('deep-brush-status', HTMLElement)
const progress = element('deep-brush-progress', HTMLProgressElement)
const form = element('deep-brush-controls', HTMLFormElement)
const filePicker = element('deep-brush-file', HTMLInputElement)
const decalPicker = element('deep-brush-decal-file', HTMLInputElement)
const sampleButton = element('deep-brush-sample', HTMLButtonElement)
const modelButton = element('deep-brush-model', HTMLButtonElement)
const textButton = element('deep-brush-text', HTMLButtonElement)
const applyButton = element('deep-brush-apply', HTMLButtonElement)
const cancelButton = element('deep-brush-cancel', HTMLButtonElement)
const undoButton = element('deep-brush-undo', HTMLButtonElement)
const clearButton = element('deep-brush-clear', HTMLButtonElement)
const clearLightButton = element('deep-brush-clear-light', HTMLButtonElement)
const exportButton = element('deep-brush-export', HTMLButtonElement)

function report(problem: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  status.textContent = `${problem}: ${detail}`
}

function field(name: string): HTMLInputElement | HTMLSelectElement {
  const found = form.elements.namedItem(name)
  if (found instanceof HTMLInputElement || found instanceof HTMLSelectElement)
    return found
  throw new Error(`form field ${name} is missing`)
}
const number = (name: string) => Number(field(name).value)
const choice = (name: string) => {
  const value = new FormData(form).get(name)
  return typeof value === 'string' ? value : ''
}

function hexToRgb(hex: string): number[] {
  const v = Number.parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255)
}

/** Decodes any browser-supported image, scaled to fit `maxSide`. */
async function decode(source: Blob, maxSide: number) {
  const bitmap = await createImageBitmap(source, {
    imageOrientation: 'from-image',
  })
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const scratch = new OffscreenCanvas(width, height)
  const context = scratch.getContext('2d')
  if (!context) throw new Error('2D canvas is unavailable')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return { pixels: context.getImageData(0, 0, width, height), scale }
}

/** Streams the weights with progress; the Cache API keeps them for later visits. */
async function fetchModel(): Promise<Uint8Array> {
  const cache = 'caches' in window ? await caches.open(MODEL_CACHE) : null
  const cached = await cache?.match(MODEL_URL)
  if (cached) return new Uint8Array(await cached.arrayBuffer())

  // Hugging Face's CDN answers 404 without CORS headers when the Referer is
  // a *.workers.dev page (every PR preview); Origin alone is accepted.
  const response = await fetch(MODEL_URL, { referrerPolicy: 'no-referrer' })
  if (!response.ok || !response.body)
    throw new Error(`download failed (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || 99_173_660
  const bytes = new Uint8Array(total)
  const reader = response.body.getReader()
  let received = 0
  progress.classList.remove('hidden')
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (received + value.length > bytes.length)
      throw new Error('download is larger than announced')
    bytes.set(value, received)
    received += value.length
    progress.value = received / total
    status.textContent = `Downloading depth model… ${Math.round(received / 1e6)} of ${Math.round(total / 1e6)} MB`
  }
  progress.classList.add('hidden')
  const body = bytes.subarray(0, received)
  await cache?.put(MODEL_URL, new Response(body.slice())).catch(() => undefined)
  return body
}

async function start() {
  await init()
  let brush: DeepBrush
  try {
    brush = await DeepBrush.create(canvas)
  } catch (cause) {
    report(
      'WebGPU is not available in this browser, so the lab cannot run',
      cause,
    )
    form.querySelectorAll('button, input, select').forEach((c) => {
      ;(c as HTMLInputElement).disabled = true
    })
    return
  }
  const adapter = brush.adapter
  let image: { width: number; height: number } | null = null
  let busy = false
  let decalReady = false
  let decalPose: { x: number; y: number } | null = null

  let framePending = false
  const draw = () => {
    if (framePending) return
    framePending = true
    requestAnimationFrame(() => {
      framePending = false
      try {
        brush.frame()
      } catch (cause) {
        report('Drawing failed', cause)
      }
      undoButton.disabled = !brush.canUndo
    })
  }

  const syncBrush = () => {
    const tool = choice('tool')
    brush.setBrush(
      number('size'),
      number('hardness'),
      number('opacity'),
      new Float32Array(hexToRgb(field('color').value)),
      Number(choice('mode')),
      tool === 'light',
      tool === 'erase',
      (field('mask') as HTMLInputElement).checked,
      number('tolerance'),
    )
    brush.setLighting(
      number('azimuth'),
      number('elevation'),
      number('intensity'),
      number('ambient'),
      (field('geometry') as HTMLInputElement).checked,
    )
    brush.setView(number('view'))
  }

  const placeDecal = () => {
    if (!image || !decalPose) return
    const half = number('decalSize') * image.width
    brush.placeDecal(
      decalPose.x,
      decalPose.y,
      half,
      (number('decalAngle') * Math.PI) / 180,
    )
    applyButton.disabled = false
    cancelButton.disabled = false
    draw()
  }
  const endDecal = (apply: boolean) => {
    if (!decalPose) return
    if (apply) brush.endStroke()
    else brush.cancelDecal()
    decalPose = null
    applyButton.disabled = true
    cancelButton.disabled = true
    draw()
  }

  async function estimate() {
    if (!image || !brush.hasModel) return
    busy = true
    const started = performance.now()
    status.textContent = 'Estimating depth…'
    try {
      const [w, h] = (await brush.estimateDepth()) as number[]
      const ms = Math.round(performance.now() - started)
      status.textContent = `Depth estimated at ${w}×${h} in ${ms} ms on ${adapter}. Paint away.`
    } catch (cause) {
      report('Depth estimation failed', cause)
    } finally {
      busy = false
      draw()
    }
  }

  async function openImage(source: Blob, label: string) {
    endDecal(false)
    const { pixels, scale } = await decode(source, MAX_EDIT_SIDE)
    brush.setImage(
      new Uint8Array(pixels.data.buffer),
      pixels.width,
      pixels.height,
    )
    image = { width: pixels.width, height: pixels.height }
    stage.style.aspectRatio = `${pixels.width} / ${pixels.height}`
    syncBrush()
    draw()
    const note =
      scale < 1 ? ` (scaled to ${pixels.width}×${pixels.height})` : ''
    status.textContent = brush.hasModel
      ? `Opened ${label}${note}.`
      : `Opened ${label}${note}. Load the depth model to paint on surfaces; until then every mode paints flat.`
    await estimate()
  }

  async function loadModel() {
    modelButton.disabled = true
    try {
      const bytes = await fetchModel()
      status.textContent = 'Uploading weights to the GPU…'
      brush.loadModel(bytes)
      modelButton.textContent = 'Depth model loaded'
      await estimate()
    } catch (cause) {
      modelButton.disabled = false
      progress.classList.add('hidden')
      report('Could not load the depth model', cause)
    }
  }

  async function makeTextDecal() {
    const text = (field('text').value || 'Deep Brush').slice(0, 40)
    const font = '700 160px system-ui, sans-serif'
    const measure = new OffscreenCanvas(1, 1).getContext('2d')
    if (!measure) throw new Error('2D canvas is unavailable')
    measure.font = font
    const width = Math.min(
      MAX_DECAL_SIDE * 2,
      Math.ceil(measure.measureText(text).width) + 40,
    )
    const scratch = new OffscreenCanvas(width, 220)
    const context = scratch.getContext('2d')
    if (!context) throw new Error('2D canvas is unavailable')
    context.font = font
    context.textBaseline = 'middle'
    context.fillStyle = field('color').value
    context.fillText(text, 20, 110, width - 40)
    const pixels = context.getImageData(0, 0, width, 220)
    brush.setDecal(new Uint8Array(pixels.data.buffer), width, 220)
    readyDecal()
  }

  async function makeImageDecal(file: Blob) {
    const { pixels } = await decode(file, MAX_DECAL_SIDE)
    brush.setDecal(
      new Uint8Array(pixels.data.buffer),
      pixels.width,
      pixels.height,
    )
    readyDecal()
  }

  function readyDecal() {
    decalReady = true
    const tool = form.querySelector<HTMLInputElement>(
      'input[name="tool"][value="decal"]',
    )
    if (tool) tool.checked = true
    if (decalPose) placeDecal()
    status.textContent =
      'Decal ready. Drag on the photo to place it, then press Enter or Apply.'
  }

  const imagePoint = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * (image?.width ?? 0),
      y: ((event.clientY - rect.top) / rect.height) * (image?.height ?? 0),
    }
  }

  let stroking = false
  canvas.addEventListener('pointerdown', (event) => {
    if (!image || busy || event.button !== 0) return
    canvas.setPointerCapture(event.pointerId)
    canvas.focus()
    syncBrush()
    const p = imagePoint(event)
    if (choice('tool') === 'decal') {
      if (!decalReady) {
        status.textContent =
          'Make a decal first: use text, or open an image in the Decal panel.'
        return
      }
      decalPose = p
      placeDecal()
      stroking = true
      return
    }
    endDecal(false)
    brush.beginStroke(p.x, p.y)
    stroking = true
    draw()
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!stroking) return
    if (decalPose) {
      decalPose = imagePoint(event)
      placeDecal()
      return
    }
    const events = event.getCoalescedEvents?.() ?? [event]
    for (const e of events.length ? events : [event]) {
      const p = imagePoint(e)
      brush.extendStroke(p.x, p.y)
    }
    draw()
  })
  const finish = () => {
    if (!stroking) return
    stroking = false
    if (!decalPose) {
      brush.endStroke()
      draw()
    }
  }
  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', finish)

  form.addEventListener('input', (event) => {
    syncBrush()
    const name = (event.target as HTMLInputElement).name
    if (
      (name === 'decalSize' || name === 'decalAngle' || name === 'mode') &&
      decalPose
    )
      placeDecal()
    if (name === 'tool' && choice('tool') !== 'decal') endDecal(false)
    draw()
  })
  form.addEventListener('submit', (event) => event.preventDefault())

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    if (target instanceof HTMLInputElement && target.type === 'text') return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      brush.undo()
      draw()
    } else if (event.key === 'Enter' && decalPose) {
      event.preventDefault()
      endDecal(true)
    } else if (event.key === 'Escape' && decalPose) {
      endDecal(false)
    } else if (event.key === '[' || event.key === ']') {
      const size = field('size') as HTMLInputElement
      const factor = event.key === ']' ? 1.2 : 1 / 1.2
      size.value = String(
        Math.round(Math.min(200, Math.max(2, Number(size.value) * factor))),
      )
      syncBrush()
    }
  })

  const guard = (task: () => Promise<void>, problem: string) => () => {
    task().catch((cause: unknown) => report(problem, cause))
  }
  filePicker.addEventListener(
    'change',
    guard(async () => {
      const file = filePicker.files?.[0]
      if (file) await openImage(file, file.name)
    }, 'Could not open that image'),
  )
  decalPicker.addEventListener(
    'change',
    guard(async () => {
      const file = decalPicker.files?.[0]
      if (file) await makeImageDecal(file)
    }, 'Could not use that decal'),
  )
  sampleButton.addEventListener(
    'click',
    guard(async () => {
      const response = await fetch(SAMPLE_URL)
      await openImage(await response.blob(), 'the sample')
    }, 'Could not open the sample'),
  )
  modelButton.addEventListener('click', () => void loadModel())
  textButton.addEventListener(
    'click',
    guard(makeTextDecal, 'Could not make the text decal'),
  )
  applyButton.addEventListener('click', () => endDecal(true))
  cancelButton.addEventListener('click', () => endDecal(false))
  undoButton.addEventListener('click', () => {
    brush.undo()
    draw()
  })
  clearButton.addEventListener('click', () => {
    brush.clearLayer(false)
    draw()
  })
  clearLightButton.addEventListener('click', () => {
    brush.clearLayer(true)
    draw()
  })
  exportButton.addEventListener(
    'click',
    guard(async () => {
      if (!image) return
      const pixels = (await brush.export()) as Uint8Array
      const out = new OffscreenCanvas(image.width, image.height)
      const context = out.getContext('2d')
      if (!context) throw new Error('2D canvas is unavailable')
      context.putImageData(
        new ImageData(new Uint8ClampedArray(pixels), image.width, image.height),
        0,
        0,
      )
      const blob = await out.convertToBlob({ type: 'image/png' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'deep-brush.png'
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
    }, 'Could not save the image'),
  )

  stage.addEventListener('dragover', (event) => event.preventDefault())
  stage.addEventListener('drop', (event) => {
    event.preventDefault()
    const file = event.dataTransfer?.files[0]
    if (file?.type.startsWith('image/'))
      openImage(file, file.name).catch((cause: unknown) =>
        report('Could not open that image', cause),
      )
  })
  window.addEventListener('paste', (event) => {
    const item = [...(event.clipboardData?.items ?? [])].find((i) =>
      i.type.startsWith('image/'),
    )
    const file = item?.getAsFile()
    if (file)
      openImage(file, 'the pasted image').catch((cause: unknown) =>
        report('Could not open the pasted image', cause),
      )
  })

  new ResizeObserver(() => {
    const scale = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO)
    const width = Math.max(1, Math.round(canvas.clientWidth * scale))
    const height = Math.max(1, Math.round(canvas.clientHeight * scale))
    canvas.width = width
    canvas.height = height
    brush.resize(width, height)
    draw()
  }).observe(canvas)

  status.textContent = `WebGPU ready on ${adapter}. Opening the sample…`
  const response = await fetch(SAMPLE_URL)
  await openImage(await response.blob(), 'the sample')
}

start().catch((cause: unknown) => report('Deep Brush failed to start', cause))
