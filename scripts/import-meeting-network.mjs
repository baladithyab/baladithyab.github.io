import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import {
  buildMeetingNetwork,
  buildOverpassQuery,
} from '../src/lib/meeting-network.ts'

// Usage: node scripts/import-meeting-network.mjs [cached-overpass.json]
// Change this region and the client preset together to import another town.
const bounds = [-122.515, 37.704, -122.355, 37.812]
const MAX_IMPORT_BYTES = 64 * 1024 * 1024
const oversized =
  'Overpass data exceeds the 64 MiB CLI input limit; import a smaller region.'
let raw
if (process.argv[2]) {
  if ((await stat(process.argv[2])).size > MAX_IMPORT_BYTES)
    throw new Error(oversized)
  raw = JSON.parse(await readFile(process.argv[2], 'utf8'))
} else {
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 90_000)
  try {
    const response = await fetch(
      process.env.PUBLIC_MEETING_OVERPASS_URL ||
        'https://overpass-api.de/api/interpreter',
      {
        method: 'POST',
        body: new URLSearchParams({ data: buildOverpassQuery(bounds) }),
        signal: abort.signal,
      },
    )
    if (!response.ok)
      throw new Error(
        `Overpass returned HTTP ${response.status}; no network was imported.`,
      )
    if (Number(response.headers.get('content-length')) > MAX_IMPORT_BYTES)
      throw new Error(oversized)
    if (!response.body) throw new Error('Overpass returned an empty response.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parts = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_IMPORT_BYTES) {
          abort.abort()
          await reader.cancel().catch(() => undefined)
          throw new Error(oversized)
        }
        parts.push(decoder.decode(chunk.value, { stream: true }))
      }
      parts.push(decoder.decode())
    } finally {
      reader.releaseLock()
    }
    raw = JSON.parse(parts.join(''))
  } finally {
    abort.abort()
    clearTimeout(timeout)
  }
}
const data = buildMeetingNetwork(raw, {
  name: 'San Francisco',
  bounds,
  fetched: new Date().toISOString().slice(0, 10),
})
const serialized = JSON.stringify(data)
await mkdir('public/lab/meeting-point', { recursive: true })
await writeFile('public/lab/meeting-point/sf.json', serialized)
console.log(
  `${data.nodes.length} nodes, ${data.edges.length} edges, ${data.places.length} named intersections; ${Buffer.byteLength(serialized)} bytes`,
)
