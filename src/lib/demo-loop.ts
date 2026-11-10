/**
 * Synthesizes a short drum-and-bass loop so the energy-ring lab has audio
 * without shipping an asset. Rendered offline (no user gesture needed) and
 * wrapped as WAV so a plain `<audio>` element can play it.
 */

const SAMPLE_RATE = 44_100
const EIGHTH_SECS = 0.25 // 120 BPM

// One bass root per bar: A1, A1, F1, G1.
const ROOTS_HZ = [55, 55, 43.65, 49]
// One bar of eighth notes as multiples of the root: octaves and fifths.
const ARPEGGIO = [4, 6, 8, 12, 8, 6, 4, 6]

export async function renderDemoLoop(): Promise<Blob> {
  const seconds = ROOTS_HZ.length * ARPEGGIO.length * EIGHTH_SECS
  const context = new OfflineAudioContext(1, SAMPLE_RATE * seconds, SAMPLE_RATE)
  const master = context.createDynamicsCompressor()
  master.connect(context.destination)

  const noise = context.createBuffer(1, SAMPLE_RATE / 4, SAMPLE_RATE)
  const grains = noise.getChannelData(0)
  for (let i = 0; i < grains.length; i++) grains[i] = Math.random() * 2 - 1

  /** Plays `source` at `at` with an exponential decay from `peak`. */
  const strike = (
    source: AudioScheduledSourceNode,
    at: number,
    peak: number,
    decaySecs: number,
    filter?: BiquadFilterNode,
  ) => {
    const gain = context.createGain()
    gain.gain.setValueAtTime(peak, at)
    gain.gain.exponentialRampToValueAtTime(0.001, at + decaySecs)
    ;(filter ? source.connect(filter) : source).connect(gain).connect(master)
    source.start(at)
    source.stop(at + decaySecs)
  }

  const oscillator = (type: OscillatorType, hz: number) =>
    new OscillatorNode(context, { type, frequency: hz })
  const filter = (type: BiquadFilterType, hz: number) =>
    new BiquadFilterNode(context, { type, frequency: hz })

  for (const [bar, root] of ROOTS_HZ.entries()) {
    // A detuned pad per bar fills the mids between the plucked notes.
    const barAt = bar * ARPEGGIO.length * EIGHTH_SECS
    for (const hz of [root * 4, root * 4.03, root * 6]) {
      strike(
        oscillator('sawtooth', hz),
        barAt,
        0.12,
        1.95,
        filter('lowpass', 1500),
      )
    }

    for (const [eighth, harmonic] of ARPEGGIO.entries()) {
      const at = barAt + eighth * EIGHTH_SECS

      if (eighth % 2 === 0) {
        const kick = oscillator('sine', 150)
        kick.frequency.setValueAtTime(150, at)
        kick.frequency.exponentialRampToValueAtTime(45, at + 0.12)
        strike(kick, at, 1, 0.3)
      } else {
        const hat = new AudioBufferSourceNode(context, { buffer: noise })
        strike(hat, at, 0.5, 0.08, filter('highpass', 6000))
      }
      // Snare on beats two and four.
      if (eighth % 4 === 2) {
        const snare = new AudioBufferSourceNode(context, { buffer: noise })
        strike(snare, at, 0.6, 0.16, filter('bandpass', 1800))
      }

      strike(
        oscillator('sawtooth', root),
        at,
        0.4,
        0.22,
        filter('lowpass', 400),
      )
      strike(
        oscillator('sawtooth', root * harmonic),
        at,
        0.2,
        0.2,
        filter('lowpass', 4000),
      )
    }
  }

  const rendered = await context.startRendering()
  return encodeWav(rendered.getChannelData(0))
}

/** Mono 16-bit PCM WAV. */
function encodeWav(samples: Float32Array): Blob {
  const dataBytes = samples.length * 2
  const header = new DataView(new ArrayBuffer(44))
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      header.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  ascii(0, 'RIFF')
  header.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVEfmt ')
  header.setUint32(16, 16, true) // fmt chunk size
  header.setUint16(20, 1, true) // PCM
  header.setUint16(22, 1, true) // channels
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, SAMPLE_RATE * 2, true) // bytes per second
  header.setUint16(32, 2, true) // bytes per frame
  header.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  header.setUint32(40, dataBytes, true)

  // WAV is little-endian, as is every platform browsers run on.
  const pcm = new Int16Array(samples.length)
  for (const [i, sample] of samples.entries()) {
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff
  }
  return new Blob([header, pcm], { type: 'audio/wav' })
}
