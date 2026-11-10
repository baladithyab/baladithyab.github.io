/**
 * Page-wide audio tap.
 *
 * Browsers expose no "everything this page plays" stream. The bus instead
 * routes each media element through one shared AudioContext as it starts
 * playing:
 *
 *   <audio> / <video>  →  input  →  analyser  →  speakers
 *
 * Out of reach: cross-origin iframes (YouTube, Spotify embeds), media
 * elements that never join the document, and Web Audio graphs built on
 * their own AudioContext. Code that owns such a graph can connect it to
 * `input` instead.
 */

export interface AudioBus {
  context: AudioContext
  /** Connect extra Web Audio sources here to have them analysed and played. */
  input: GainNode
  analyser: AnalyserNode
}

let bus: AudioBus | undefined
let tap: Promise<AudioBus> | undefined
const tapped = new WeakSet<HTMLMediaElement>()

function getBus(): AudioBus {
  if (bus) return bus
  const context = new AudioContext()
  const input = context.createGain()
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  // Defaults (-100..-30 dB, smoothing 0.8) clip loud bins at 255 and smear
  // kick drums across several frames; consumers smooth releases themselves.
  analyser.minDecibels = -85
  analyser.maxDecibels = -10
  analyser.smoothingTimeConstant = 0.5
  input.connect(analyser).connect(context.destination)
  bus = { context, input, analyser }
  return bus
}

/**
 * A media element source replaces the element's own output. For
 * cross-origin media without CORS approval that output is silence, so
 * tapping such an element would mute it.
 */
function isTappable(media: HTMLMediaElement): boolean {
  if (media.crossOrigin !== null || !media.currentSrc) return true
  const source = new URL(media.currentSrc)
  return source.protocol === 'data:' || source.origin === location.origin
}

/** Routes `media` through the bus. Permanent for that element. */
function route(media: HTMLMediaElement): AudioBus | undefined {
  if (!isTappable(media)) return undefined
  const { context, input } = getBus()
  if (!tapped.has(media)) {
    context.createMediaElementSource(media).connect(input)
    tapped.add(media)
  }
  // A context created before the first user gesture starts suspended, and a
  // suspended context would silence the element it now carries.
  void context.resume()
  return getBus()
}

/**
 * Routes every in-document media element through the bus when it plays.
 * Resolves once the first element is tapped; later elements keep joining.
 */
export function tapPageAudio(): Promise<AudioBus> {
  if (tap) return tap
  const { promise, resolve } = Promise.withResolvers<AudioBus>()
  tap = promise

  const onPlay = (media: EventTarget | null) => {
    if (!(media instanceof HTMLMediaElement)) return
    const routed = route(media)
    if (routed) resolve(routed)
  }
  // `play` does not bubble; capturing at the document sees every element.
  document.addEventListener('play', (event) => onPlay(event.target), true)
  for (const media of document.querySelectorAll('audio, video')) {
    if (media instanceof HTMLMediaElement && !media.paused) onPlay(media)
  }
  return promise
}
