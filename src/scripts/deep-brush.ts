/** Browser input and file decoding. Rust owns depth inference and painting. */
import init, { DeepBrush } from '../../crates/deep-brush/pkg/deep_brush.js'

const MODEL_URL =
  'https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf/resolve/5426e4f0f36572d16453bbda7a8389317b1bef99/model.safetensors'
const MODEL_CACHE = 'deep-brush-model-v1'
const SAMPLE_URL = '/lab/deep-brush/sample.jpg'
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
const dropZone = element('deep-brush-drop-zone', HTMLElement)
const cursor = element('deep-brush-cursor', HTMLElement)
const status = element('deep-brush-status', HTMLElement)
const progress = element('deep-brush-progress', HTMLProgressElement)
const form = element('deep-brush-controls', HTMLFormElement)
const filePicker = element('deep-brush-file', HTMLInputElement)
const decalPicker = element('deep-brush-decal-file', HTMLInputElement)
const openButton = element('deep-brush-open', HTMLButtonElement)
const sampleButton = element('deep-brush-sample', HTMLButtonElement)
const modelButton = element('deep-brush-model', HTMLButtonElement)
const textButton = element('deep-brush-text', HTMLButtonElement)
const applyButton = element('deep-brush-apply', HTMLButtonElement)
const cancelButton = element('deep-brush-cancel', HTMLButtonElement)
const undoButton = element('deep-brush-undo', HTMLButtonElement)
const clearButton = element('deep-brush-clear', HTMLButtonElement)
const clearLightButton = element('deep-brush-clear-light', HTMLButtonElement)
const exportButton = element('deep-brush-export', HTMLButtonElement)
const depthState = element('deep-brush-depth-state', HTMLElement)
const depthPrompt = element('deep-brush-depth-prompt', HTMLElement)
const modelNote = element('deep-brush-model-note', HTMLElement)
const imageInfo = element('deep-brush-image-info', HTMLElement)
const activeTool = element('deep-brush-active-tool', HTMLElement)
const modeHint = element('deep-brush-mode-hint', HTMLElement)
const hint = element('deep-brush-hint', HTMLElement)

function report(message: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  status.textContent = `${message}: ${detail}`
  status.dataset.tone = 'error'
}

function input(name: string): HTMLInputElement {
  const found = form.elements.namedItem(name)
  if (!(found instanceof HTMLInputElement))
    throw new Error(`Missing input ${name}`)
  return found
}
function value(name: string): string {
  const found = form.elements.namedItem(name)
  if (found instanceof HTMLInputElement || found instanceof RadioNodeList)
    return found.value
  throw new Error(`Missing field ${name}`)
}
const number = (name: string) => Number(value(name))

function selectRadio(name: string, selected: string) {
  for (const radio of form.querySelectorAll<HTMLInputElement>(
    `input[name="${name}"]`,
  )) {
    radio.checked = radio.value === selected
  }
}

function hexToRgb(hex: string): Float32Array {
  const v = Number.parseInt(hex.slice(1), 16)
  return new Float32Array([
    ((v >> 16) & 255) / 255,
    ((v >> 8) & 255) / 255,
    (v & 255) / 255,
  ])
}

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
  return context.getImageData(0, 0, width, height)
}

async function fetchModel(): Promise<Uint8Array> {
  const cache = 'caches' in window ? await caches.open(MODEL_CACHE) : null
  const cached = await cache?.match(MODEL_URL)
  if (cached) {
    status.textContent = 'Reading the cached depth model...'
    return new Uint8Array(await cached.arrayBuffer())
  }
  // Hugging Face rejects requests carrying a *.workers.dev Referer.
  const response = await fetch(MODEL_URL, { referrerPolicy: 'no-referrer' })
  if (!response.ok || !response.body)
    throw new Error(`download failed (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || 99_173_660
  const bytes = new Uint8Array(total)
  const reader = response.body.getReader()
  let received = 0
  progress.hidden = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (received + value.length > bytes.length)
      throw new Error('download is larger than announced')
    bytes.set(value, received)
    received += value.length
    progress.value = received / total
    status.textContent = `Downloading depth model: ${Math.round(received / 1e6)} / ${Math.round(total / 1e6)} MB`
  }
  progress.hidden = true
  const body = bytes.subarray(0, received)
  await cache?.put(MODEL_URL, new Response(body.slice())).catch(() => undefined)
  return body
}

type Interaction = { kind: 'stroke' | 'decal'; pointerId: number } | null
type Phase =
  'starting' | 'idle' | 'opening' | 'downloading' | 'uploading' | 'estimating'

async function start() {
  await init()
  const brush = await DeepBrush.create(canvas)
  let image: { width: number; height: number } | null = null
  let depthReady = false
  let phase: Phase = 'starting'
  let decalReady = false
  let decalPose: { x: number; y: number } | null = null
  let interaction: Interaction = null
  let framePending = false
  let exporting = false

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
      undoButton.disabled = phase !== 'idle' || !brush.canUndo
    })
  }

  function refresh() {
    const tool = value('tool')
    const mode = value('mode')
    const busy = phase !== 'idle'
    form.setAttribute('aria-busy', String(busy))
    canvas.dataset.blocked = String(busy || (!depthReady && mode !== '0'))
    openButton.disabled = busy
    sampleButton.disabled = busy
    filePicker.disabled = busy
    decalPicker.disabled = busy
    textButton.disabled = busy
    exportButton.disabled = busy || !image || exporting
    undoButton.disabled = busy || !brush.canUndo
    clearButton.disabled = busy || !image
    clearLightButton.disabled = busy || !image
    modelButton.disabled = busy || !image || (brush.hasModel && depthReady)
    modelButton.hidden = depthReady
    exportButton.classList.toggle('db-primary', depthReady)
    modelButton.setAttribute(
      'aria-busy',
      String(['downloading', 'uploading', 'estimating'].includes(phase)),
    )
    modelButton.textContent =
      phase === 'downloading'
        ? 'Loading model...'
        : phase === 'uploading'
          ? 'Preparing model...'
          : phase === 'estimating'
            ? 'Analyzing depth...'
            : brush.hasModel
              ? 'Analyze depth'
              : 'Analyze depth (99 MB)'
    depthState.textContent = depthReady
      ? 'Surface lock ready'
      : phase === 'estimating'
        ? 'Analyzing depth...'
        : 'Depth not analyzed'
    depthPrompt.hidden = depthReady || mode === '0'
    modelNote.textContent = depthReady
      ? 'New images are analyzed automatically.'
      : brush.hasModel
        ? 'Model loaded. Analyze this image to use Surface or Wrap.'
        : 'Downloads a 99 MB model once. Runs locally.'
    for (const panel of form.querySelectorAll<HTMLElement>(
      '[data-tool-panel]',
    )) {
      panel.hidden = !panel.dataset.toolPanel?.split(' ').includes(tool)
    }
    for (const fieldset of form.querySelectorAll('fieldset'))
      fieldset.disabled = busy
    for (const radio of form.querySelectorAll<HTMLInputElement>(
      '[data-requires-depth]',
    ))
      radio.disabled = !depthReady
    const toolNames: Record<string, string> = {
      paint: 'Paint',
      light: 'Light',
      erase: 'Erase',
      decal: 'Decal',
    }
    const modeNames: Record<string, string> = {
      '0': 'Flat',
      '1': 'Surface',
      '2': 'Wrap',
    }
    activeTool.textContent = `${toolNames[tool]} / ${modeNames[mode]}`
    modeHint.textContent =
      mode === '0'
        ? 'Flat mode paints over everything, including foreground objects.'
        : 'Start on the surface you want. The stroke stays locked to it.'
    hint.textContent =
      tool === 'decal'
        ? 'Use text or open artwork, then drag it onto the scene. Enter applies; Escape cancels.'
        : !depthReady && mode !== '0'
          ? 'Choose Analyze depth first, or explicitly choose Flat to paint without depth.'
          : 'Start on the surface you want to paint. Lift and start a new stroke to choose a different surface.'
    for (const output of form.querySelectorAll<HTMLOutputElement>(
      'output[data-value]',
    )) {
      const name = output.dataset.value
      if (!name) continue
      const n = number(name)
      output.value =
        name === 'size'
          ? `${n} px`
          : name === 'decalAngle' || name === 'azimuth' || name === 'elevation'
            ? `${n}°`
            : name === 'intensity'
              ? `${n.toFixed(1)}×`
              : `${Math.round(n * (name === 'decalSize' ? 200 : 100))}%`
    }
    for (const swatch of form.querySelectorAll<HTMLButtonElement>(
      '[data-color]',
    )) {
      swatch.setAttribute(
        'aria-pressed',
        String(swatch.dataset.color === value('color')),
      )
    }
    if (image) {
      const diameter = (2 * number('size') * canvas.clientWidth) / image.width
      cursor.style.width = `${diameter}px`
      cursor.style.height = `${diameter}px`
    }
  }

  function syncBrush() {
    const tool = value('tool')
    brush.setBrush(
      number('size'),
      number('hardness'),
      number('opacity'),
      hexToRgb(value('color')),
      number('mode'),
      tool === 'light' || (tool === 'erase' && value('eraseLayer') === 'light'),
      tool === 'erase',
      input('mask').checked,
      number('tolerance'),
    )
    brush.setLighting(
      number('azimuth'),
      number('elevation'),
      number('intensity'),
      number('ambient'),
      input('geometry').checked,
    )
    brush.setView(number('view'))
  }

  function placeDecal() {
    if (!image || !decalPose) return
    brush.placeDecal(
      decalPose.x,
      decalPose.y,
      number('decalSize') * image.width,
      (number('decalAngle') * Math.PI) / 180,
    )
    applyButton.disabled = false
    cancelButton.disabled = false
    draw()
  }
  function endDecal(apply: boolean) {
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
    phase = 'estimating'
    depthReady = false
    status.textContent = 'Estimating depth and finding connected surfaces...'
    refresh()
    const started = performance.now()
    try {
      const size: unknown = await brush.estimateDepth()
      if (
        !Array.isArray(size) ||
        size.length !== 2 ||
        size.some((n) => typeof n !== 'number')
      )
        throw new Error('Unexpected depth result')
      depthReady = true
      status.textContent = `Surface lock ready. Depth ${size[0]} × ${size[1]} in ${Math.round(performance.now() - started)} ms on ${brush.adapter}.`
    } catch (cause) {
      report('Depth analysis failed. Try Analyze depth again', cause)
    } finally {
      phase = 'idle'
      refresh()
      draw()
    }
  }

  async function openImage(source: Blob, label: string) {
    if (phase !== 'idle' && phase !== 'starting') return
    phase = 'opening'
    depthReady = false
    endDecal(false)
    interaction = null
    status.dataset.tone = ''
    status.textContent = `Opening ${label}...`
    refresh()
    try {
      const pixels = await decode(source, MAX_EDIT_SIDE)
      brush.setImage(
        new Uint8Array(pixels.data.buffer),
        pixels.width,
        pixels.height,
      )
      image = { width: pixels.width, height: pixels.height }
      stage.style.setProperty(
        '--image-aspect',
        String(pixels.width / pixels.height),
      )
      imageInfo.textContent = `${label} / ${pixels.width} × ${pixels.height}`
      selectRadio('view', '0')
      syncBrush()
      draw()
      status.textContent =
        'Image ready. Analyze depth to lock strokes to a surface.'
      if (brush.hasModel) await estimate()
    } finally {
      phase = 'idle'
      refresh()
    }
  }

  async function loadModel() {
    if (phase !== 'idle' || !image) return
    endDecal(false)
    status.dataset.tone = ''
    try {
      if (!brush.hasModel) {
        phase = 'downloading'
        refresh()
        status.textContent = 'Loading the depth model...'
        const bytes = await fetchModel()
        phase = 'uploading'
        refresh()
        status.textContent = 'Preparing the depth model on your GPU...'
        brush.loadModel(bytes)
      }
      await estimate()
    } catch (cause) {
      report('Could not load depth. Check your connection and try again', cause)
    } finally {
      phase = 'idle'
      progress.hidden = true
      refresh()
    }
  }

  function readyDecal() {
    decalReady = true
    selectRadio('tool', 'decal')
    syncBrush()
    refresh()
    if (decalPose) placeDecal()
    status.textContent =
      'Artwork ready. Drag to position it, then Apply decal or press Enter.'
  }

  function makeTextDecal() {
    const text = value('text').trim()
    if (!text) {
      input('text').setAttribute('aria-invalid', 'true')
      status.textContent = 'Enter text to create a decal.'
      return
    }
    input('text').removeAttribute('aria-invalid')
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
    context.fillStyle = value('color')
    context.fillText(text, 20, 110, width - 40)
    brush.setDecal(
      new Uint8Array(context.getImageData(0, 0, width, 220).data.buffer),
      width,
      220,
    )
    readyDecal()
  }

  function imagePoint(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * (image?.width ?? 0),
      y: ((event.clientY - rect.top) / rect.height) * (image?.height ?? 0),
    }
  }

  function extend(event: PointerEvent) {
    const events = event.getCoalescedEvents?.() ?? []
    for (const e of events) {
      const p = imagePoint(e)
      brush.extendStroke(p.x, p.y)
    }
    // Include the dispatched endpoint too: a coalesced list need not end there.
    const p = imagePoint(event)
    brush.extendStroke(p.x, p.y)
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!image || phase !== 'idle' || event.button !== 0 || interaction) return
    if (!depthReady && value('mode') !== '0') {
      status.textContent =
        'Analyze depth first, or choose Flat to paint without it.'
      modelButton.focus()
      return
    }
    if (value('tool') === 'decal' && !decalReady) {
      status.textContent = 'Use text or open a logo in Artwork first.'
      textButton.focus()
      return
    }
    canvas.setPointerCapture(event.pointerId)
    canvas.focus({ preventScroll: true })
    selectRadio('view', '0')
    syncBrush()
    const p = imagePoint(event)
    if (value('tool') === 'decal') {
      interaction = { kind: 'decal', pointerId: event.pointerId }
      decalPose = p
      placeDecal()
    } else {
      endDecal(false)
      interaction = { kind: 'stroke', pointerId: event.pointerId }
      brush.beginStroke(p.x, p.y)
      draw()
    }
  })
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect()
    cursor.hidden =
      phase !== 'idle' ||
      !image ||
      value('tool') === 'decal' ||
      (!depthReady && value('mode') !== '0')
    cursor.style.left = `${event.clientX - rect.left}px`
    cursor.style.top = `${event.clientY - rect.top}px`
    if (!interaction || interaction.pointerId !== event.pointerId) return
    if (interaction.kind === 'decal') {
      decalPose = imagePoint(event)
      placeDecal()
    } else {
      extend(event)
      draw()
    }
  })
  canvas.addEventListener('pointerleave', () => {
    cursor.hidden = true
  })
  const finish = (event: PointerEvent) => {
    if (!interaction || interaction.pointerId !== event.pointerId) return
    if (interaction.kind === 'stroke') {
      // A fast release can be the only event carrying the final position.
      if (event.type === 'pointerup') extend(event)
      brush.endStroke()
      draw()
    }
    interaction = null
  }
  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', finish)
  canvas.addEventListener('lostpointercapture', finish)

  form.addEventListener('input', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    if (target.name === 'tool') endDecal(false)
    syncBrush()
    if (
      decalPose &&
      [
        'decalSize',
        'decalAngle',
        'mode',
        'opacity',
        'mask',
        'tolerance',
      ].includes(target.name)
    )
      placeDecal()
    status.dataset.tone = ''
    refresh()
    draw()
  })
  form.addEventListener('submit', (event) => event.preventDefault())
  for (const swatch of form.querySelectorAll<HTMLButtonElement>(
    '[data-color]',
  )) {
    swatch.addEventListener('click', () => {
      if (!swatch.dataset.color) return
      input('color').value = swatch.dataset.color
      syncBrush()
      refresh()
    })
  }

  window.addEventListener('keydown', (event) => {
    const target = event.target
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return
    if (phase !== 'idle' || interaction) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      endDecal(false)
      brush.undo()
      draw()
    } else if (event.key === 'Enter' && decalPose) {
      event.preventDefault()
      endDecal(true)
    } else if (event.key === 'Escape') {
      endDecal(false)
    } else if (event.key === '[' || event.key === ']') {
      event.preventDefault()
      input('size').value = String(
        Math.round(
          Math.min(
            200,
            Math.max(2, number('size') * (event.key === ']' ? 1.2 : 1 / 1.2)),
          ),
        ),
      )
      syncBrush()
      refresh()
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const shortcuts: Record<string, string> = {
        b: 'paint',
        l: 'light',
        e: 'erase',
        d: 'decal',
      }
      const tool = shortcuts[event.key.toLowerCase()]
      if (tool) {
        endDecal(false)
        selectRadio('tool', tool)
        syncBrush()
        refresh()
      }
    }
  })

  openButton.addEventListener('click', () => filePicker.click())
  filePicker.addEventListener('change', () => {
    const file = filePicker.files?.[0]
    if (file)
      void openImage(file, file.name).catch((cause) =>
        report('Could not open that image', cause),
      )
    filePicker.value = ''
  })
  decalPicker.addEventListener('change', () => {
    const file = decalPicker.files?.[0]
    if (!file || phase !== 'idle') return
    void decode(file, MAX_DECAL_SIDE)
      .then((pixels) => {
        brush.setDecal(
          new Uint8Array(pixels.data.buffer),
          pixels.width,
          pixels.height,
        )
        readyDecal()
      })
      .catch((cause) => report('Could not open artwork', cause))
  })
  sampleButton.addEventListener('click', () => {
    void fetch(SAMPLE_URL)
      .then((r) => r.blob())
      .then((blob) => openImage(blob, 'Sample scene'))
      .catch((cause) => report('Could not open the sample', cause))
  })
  modelButton.addEventListener('click', () => void loadModel())
  textButton.addEventListener('click', makeTextDecal)
  applyButton.addEventListener('click', () => endDecal(true))
  cancelButton.addEventListener('click', () => endDecal(false))
  undoButton.addEventListener('click', () => {
    endDecal(false)
    brush.undo()
    draw()
  })
  clearButton.addEventListener('click', () => {
    endDecal(false)
    brush.clearLayer(false)
    draw()
  })
  clearLightButton.addEventListener('click', () => {
    endDecal(false)
    brush.clearLayer(true)
    draw()
  })
  exportButton.addEventListener('click', async () => {
    if (!image || exporting) return
    exporting = true
    exportButton.textContent = 'Saving...'
    exportButton.setAttribute('aria-busy', 'true')
    refresh()
    try {
      const pixels: unknown = await brush.export()
      if (!(pixels instanceof Uint8Array))
        throw new Error('Unexpected pixel data')
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
    } catch (cause) {
      report('Could not save the image', cause)
    } finally {
      exporting = false
      exportButton.textContent = 'Save PNG'
      exportButton.removeAttribute('aria-busy')
      refresh()
    }
  })

  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault()
    dropZone.dataset.dragging = 'true'
  })
  dropZone.addEventListener('dragleave', () => {
    delete dropZone.dataset.dragging
  })
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault()
    delete dropZone.dataset.dragging
    const file = event.dataTransfer?.files[0]
    if (file?.type.startsWith('image/'))
      void openImage(file, file.name).catch((cause) =>
        report('Could not open that image', cause),
      )
  })
  window.addEventListener('paste', (event) => {
    if (event.target instanceof HTMLInputElement) return
    const file = [...(event.clipboardData?.items ?? [])]
      .find((i) => i.type.startsWith('image/'))
      ?.getAsFile()
    if (file)
      void openImage(file, 'Pasted image').catch((cause) =>
        report('Could not open pasted image', cause),
      )
  })

  new ResizeObserver(() => {
    const scale = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO)
    const width = Math.max(1, Math.round(canvas.clientWidth * scale))
    const height = Math.max(1, Math.round(canvas.clientHeight * scale))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      brush.resize(width, height)
    }
    refresh()
    draw()
  }).observe(canvas)

  refresh()
  const response = await fetch(SAMPLE_URL)
  await openImage(await response.blob(), 'Sample scene')
}

start().catch((cause) => {
  report(
    'Deep Brush could not start. This lab requires a browser with WebGPU',
    cause,
  )
  for (const control of form.querySelectorAll('button, input')) {
    if (
      control instanceof HTMLButtonElement ||
      control instanceof HTMLInputElement
    )
      control.disabled = true
  }
})
