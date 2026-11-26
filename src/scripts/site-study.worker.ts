import {
  prepareDriveStudy,
  combineDriveAreas,
  maxStudyPoints,
  type CensusData,
  type CensusGrid,
  type RoadData,
  type SiteResult,
  type StudyResult,
  type MatchMode,
} from '../lib/site-study'
import type { Coordinate } from '../lib/meeting-point'
import type { MapRoads } from '../lib/site-study-map'

export type StudyRequest = {
  id: number
  coordinates: Coordinate[]
  mode: MatchMode
}
export type StudyResponse =
  | { kind: 'map'; roads: MapRoads; census: CensusGrid }
  | { kind: 'result'; id: number; result: StudyResult }
  | { kind: 'error'; id: number; message: string }

async function readSnapshot<T>(file: string): Promise<T> {
  const response = await fetch(`/lab/real-estate-due-diligence/${file}.data`)
  if (!response.ok || !response.body)
    throw new Error('The study data could not be loaded. Reload to try again.')
  return new Response(
    response.body.pipeThrough(new DecompressionStream('gzip')),
  ).json() as Promise<T>
}

let loading: ReturnType<typeof load> | undefined
async function load() {
  const [roads, census] = await Promise.all([
    readSnapshot<RoadData>('roads'),
    readSnapshot<CensusData>('census'),
  ])
  const analyze = prepareDriveStudy(roads, census, true)
  const coordinates = new Int32Array(roads.nodes.length * 2)
  roads.nodes.forEach(([x, y], id) => {
    coordinates[id * 2] = x
    coordinates[id * 2 + 1] = y
  })
  const segments = new Uint32Array(roads.edges.length * 3)
  roads.edges.forEach(([a, b, , , rank], id) => {
    segments[id * 3] = a
    segments[id * 3 + 1] = b
    segments[id * 3 + 2] = rank
  })
  const { cellSize, columns, rows, outline } = census
  self.postMessage(
    {
      kind: 'map',
      roads: { date: roads.date, coordinates, segments },
      census: { cellSize, columns, rows, outline },
    } satisfies StudyResponse,
    { transfer: [coordinates.buffer, segments.buffer] },
  )
  const cache = new Map<string, SiteResult>()
  return (coordinates: Coordinate[], mode: MatchMode) => {
    if (!coordinates.length || coordinates.length > maxStudyPoints)
      throw new Error(`Choose 1–${maxStudyPoints} points.`)
    const results = coordinates.map((coordinate, index) => {
      const key = coordinate.join(',')
      const existing = cache.get(key)
      if (existing) return existing
      try {
        const result = analyze(coordinate)
        cache.set(key, result)
        if (cache.size > 12) cache.delete(cache.keys().next().value!)
        return result
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : 'Unable to calculate drive time.'
        throw new Error(`Point ${index + 1}: ${detail}`)
      }
    })
    return combineDriveAreas(census, results, mode)
  }
}

self.onmessage = async ({
  data: { id, coordinates, mode },
}: MessageEvent<StudyRequest>) => {
  loading ??= load()
  let analyze: Awaited<ReturnType<typeof load>>
  try {
    analyze = await loading
  } catch {
    self.postMessage({
      kind: 'error',
      id,
      message: 'The study data could not be loaded. Reload to try again.',
    } satisfies StudyResponse)
    return
  }
  try {
    const result = analyze(coordinates, mode)
    self.postMessage({ kind: 'result', id, result } satisfies StudyResponse, {
      transfer: [result.times.buffer],
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The site could not be analyzed.'
    self.postMessage({ kind: 'error', id, message } satisfies StudyResponse)
  }
}
