/**
 * Mermaid diagram zoom/pan UX.
 *
 * Wraps every `.mermaid-frame` rendered by `rehype-mermaid` (see astro.config.ts)
 * with a hover affordance + click-to-expand fullscreen modal that supports:
 *   - wheel zoom
 *   - drag pan
 *   - pinch zoom on touch devices
 *   - double-click / button reset
 *   - ESC or backdrop click to close
 *
 * The original inline diagram still renders normally; this only enhances on
 * client hydration. No server-side dependency, so SSR cost is zero.
 */

import Panzoom from '@panzoom/panzoom'

let modalEl: HTMLDivElement | null = null
let panzoomInstance: ReturnType<typeof Panzoom> | null = null
let lastFocused: HTMLElement | null = null

function ensureModal(): HTMLDivElement {
  if (modalEl) return modalEl
  const m = document.createElement('div')
  m.className = 'mermaid-modal'
  m.setAttribute('role', 'dialog')
  m.setAttribute('aria-modal', 'true')
  m.setAttribute('aria-label', 'Diagram viewer')
  m.setAttribute('hidden', '')
  m.innerHTML = `
    <div class="mermaid-modal__backdrop" data-mermaid-close></div>
    <div class="mermaid-modal__panel">
      <div class="mermaid-modal__toolbar">
        <button type="button" class="mermaid-modal__btn" data-mermaid-zoom-in aria-label="Zoom in">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>
        </button>
        <button type="button" class="mermaid-modal__btn" data-mermaid-zoom-out aria-label="Zoom out">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/></svg>
        </button>
        <button type="button" class="mermaid-modal__btn" data-mermaid-reset aria-label="Reset view">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <span class="mermaid-modal__sep" aria-hidden="true"></span>
        <button type="button" class="mermaid-modal__btn" data-mermaid-close aria-label="Close diagram">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div class="mermaid-modal__stage" data-mermaid-stage></div>
      <div class="mermaid-modal__hint" aria-hidden="true">
        Scroll to zoom · Drag to pan · Double-click to reset · ESC to close
      </div>
    </div>
  `
  document.body.appendChild(m)

  m.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null
    if (!t) return
    if (t.closest('[data-mermaid-close]')) {
      e.preventDefault()
      closeModal()
      return
    }
    if (t.closest('[data-mermaid-zoom-in]')) {
      panzoomInstance?.zoomIn({ animate: true })
      return
    }
    if (t.closest('[data-mermaid-zoom-out]')) {
      panzoomInstance?.zoomOut({ animate: true })
      return
    }
    if (t.closest('[data-mermaid-reset]')) {
      panzoomInstance?.reset({ animate: true })
      return
    }
  })

  modalEl = m
  return m
}

function closeModal() {
  if (!modalEl) return
  panzoomInstance?.destroy()
  panzoomInstance = null
  const stage = modalEl.querySelector<HTMLElement>('[data-mermaid-stage]')
  if (stage) stage.replaceChildren()
  modalEl.setAttribute('hidden', '')
  document.documentElement.classList.remove('mermaid-modal-open')
  document.removeEventListener('keydown', onKeyDown)
  if (lastFocused && typeof lastFocused.focus === 'function') {
    lastFocused.focus()
  }
  lastFocused = null
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeModal()
  }
}

function openModal(frame: HTMLElement, trigger?: HTMLElement) {
  const svg = frame.querySelector<SVGElement>('svg')
  if (!svg) return
  const m = ensureModal()
  const stage = m.querySelector<HTMLElement>('[data-mermaid-stage]')
  if (!stage) return

  // Clone the SVG so we don't disturb the inline render.
  const clone = svg.cloneNode(true) as SVGSVGElement
  // Strip width/height that mermaid-zoom enforces inline so the SVG can fill the stage.
  clone.removeAttribute('width')
  clone.removeAttribute('height')
  clone.style.width = '100%'
  clone.style.height = '100%'
  clone.style.maxWidth = 'none'
  clone.style.maxHeight = 'none'
  clone.style.display = 'block'

  // Mermaid bakes a <style> element INSIDE the SVG with hardcoded fills
  // (`fill: #333`, `fill: #eee`, `stroke: #333`) that win specificity over
  // outer document CSS. Strip it so our modal overrides have free rein.
  // The inline render still uses its own untouched copy.
  clone.querySelectorAll('style').forEach((s) => s.remove())

  // Wrap clone in an inner container — Panzoom transforms its target element,
  // and SVG roots can be flaky as Panzoom targets across browsers.
  // We also tag this wrapper with `mermaid-frame` so the same theme CSS
  // that styles inline diagrams (in `[slug].astro`) applies here too —
  // otherwise the modal-cloned SVG falls back to browser defaults
  // (black fills, white labelBkg backgrounds) since we strip mermaid's
  // embedded <style> above.
  const wrap = document.createElement('div')
  wrap.className = 'mermaid-modal__svg mermaid-frame'
  wrap.appendChild(clone)

  stage.replaceChildren(wrap)
  m.removeAttribute('hidden')
  document.documentElement.classList.add('mermaid-modal-open')
  lastFocused = trigger ?? (document.activeElement as HTMLElement | null)

  panzoomInstance = Panzoom(wrap, {
    maxScale: 6,
    minScale: 0.4,
    step: 0.4,
    canvas: true,
    cursor: 'grab',
  })
  // Wheel zoom on the stage
  stage.addEventListener('wheel', panzoomInstance.zoomWithWheel, { passive: false })
  // Double-click resets
  stage.addEventListener('dblclick', () => panzoomInstance?.reset({ animate: true }))

  document.addEventListener('keydown', onKeyDown)

  // Move focus to the close button for keyboard users.
  const closeBtn = m.querySelector<HTMLButtonElement>('[data-mermaid-close]')
  closeBtn?.focus()
}

function decorate(frame: HTMLElement) {
  if (frame.dataset.mermaidZoomReady === '1') return
  frame.dataset.mermaidZoomReady = '1'

  // Wrap the frame in an outer container with a toolbar row above it.
  // Layout becomes:
  //   <div class="mermaid-wrapper">
  //     <div class="mermaid-wrapper__toolbar">
  //       <button class="mermaid-frame__expand">…</button>
  //     </div>
  //     <div class="mermaid-frame">…inline SVG…</div>
  //   </div>
  // This keeps the button OUT of the scrolling frame entirely, so it
  // never overlaps actor boxes or arrowheads, and it remains visible
  // regardless of how far the user has scrolled the diagram horizontally.
  const wrapper = document.createElement('div')
  wrapper.className = 'mermaid-wrapper'
  frame.parentNode?.insertBefore(wrapper, frame)

  const toolbar = document.createElement('div')
  toolbar.className = 'mermaid-wrapper__toolbar'
  wrapper.appendChild(toolbar)
  wrapper.appendChild(frame)

  // Expand button — always visible in the toolbar row above the diagram.
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mermaid-frame__expand'
  btn.setAttribute('aria-label', 'Expand diagram')
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M15 3h6v6"/>
      <path d="M9 21H3v-6"/>
      <path d="M21 3l-7 7"/>
      <path d="M3 21l7-7"/>
    </svg>
    <span>Expand</span>
  `
  toolbar.appendChild(btn)

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    openModal(frame, btn)
  })

  // Whole-frame click also opens, but ignore drags / text selections inside the SVG.
  let downX = 0
  let downY = 0
  frame.addEventListener('mousedown', (e) => {
    downX = e.clientX
    downY = e.clientY
  })
  frame.addEventListener('click', (e) => {
    const dx = Math.abs(e.clientX - downX)
    const dy = Math.abs(e.clientY - downY)
    if (dx > 4 || dy > 4) return
    if ((e.target as HTMLElement).closest('a')) return
    openModal(frame, btn)
  })

  // Keyboard activation
  frame.tabIndex = 0
  frame.setAttribute('role', 'button')
  frame.setAttribute('aria-label', 'Open diagram in zoomable viewer')
  frame.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openModal(frame, btn)
    }
  })
}

function init() {
  const frames = document.querySelectorAll<HTMLElement>('.mermaid-frame')
  frames.forEach(decorate)
}

init()
document.addEventListener('astro:page-load', () => {
  // Re-init on view transitions; close any modal left dangling.
  closeModal()
  init()
})
