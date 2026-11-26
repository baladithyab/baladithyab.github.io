import {
  prepareDriveStudy,
  type CensusData,
  type CensusGrid,
  type RoadData,
  type SiteResult,
} from '../lib/site-study'
import type { Coordinate } from '../lib/meeting-point'
import type { MapRoads } from '../lib/site-study-map'

export type StudyRequest = { id: number; coordinate: Coordinate }
export type StudyResponse =
  | { kind: 'map'; roads: MapRoads; census: CensusGrid }
  | { kind: 'result'; id: number; result: SiteResult }
  | { kind: 'error'; id: number; message: string }

async function readSnapshot<T>(file: string): Promise<T> {
  const response = await fetch(`/lab/real-estate-due-diligence/${file}.data`)
  if (!response.ok || !response.body)
    throw new Error('The study data could not be loaded. Reload to try again.')
  return new Response(
    response.body.pipeThrough(new DecompressionStream('gzip')),
  ).json() as Promise<T>
}

let loading: Promise<ReturnType<typeof prepareDriveStudy>> | undefined
async function load() {
  const [roads, census] = await Promise.all([
    readSnapshot<RoadData>('roads'),
    readSnapshot<CensusData>('census'),
  ])
  const analyze = prepareDriveStudy(roads, census)
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
  return analyze
}

self.onmessage = async ({
  data: { id, coordinate },
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
    const result = analyze(coordinate)
    self.postMessage({ kind: 'result', id, result } satisfies StudyResponse, {
      transfer: [result.times.buffer],
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The site could not be analyzed.'
    self.postMessage({ kind: 'error', id, message } satisfies StudyResponse)
  }
}
