import { readFile, writeFile, mkdir } from 'node:fs/promises'

// Usage: node scripts/import-meeting-network.mjs [cached-overpass.json]
// Change this region and the client preset together to import another town.
const bounds = [-122.515, 37.704, -122.355, 37.812]
const [west, south, east, north] = bounds
const query = `[out:json][timeout:120];way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|proposed|construction|raceway)$"]["access"!~"^(private|no)$"]["foot"!="no"](${south},${west},${north},${east});out body;>;out skel qt;`
const response = process.argv[2]
  ? await readFile(process.argv[2], 'utf8')
  : await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`Overpass returned ${res.status}`)
      return res.text()
    })
const raw = JSON.parse(response)
if (!Array.isArray(raw.elements) || raw.remark)
  throw new Error(raw.remark || 'Invalid Overpass data')
const points = new Map(
  raw.elements
    .filter(
      (el) =>
        el.type === 'node' &&
        el.lon >= west &&
        el.lon <= east &&
        el.lat >= south &&
        el.lat <= north,
    )
    .map((el) => [el.id, el]),
)
const ways = raw.elements.filter((el) => el.type === 'way')
const degree = new Map()
const labels = new Map()
for (const way of ways) {
  for (let i = 0; i < way.nodes.length; i++) {
    const id = way.nodes[i]
    if (!points.has(id)) continue
    degree.set(
      id,
      (degree.get(id) || 0) +
        (i > 0 ? 1 : 0) +
        (i < way.nodes.length - 1 ? 1 : 0),
    )
    if (way.tags.name) {
      if (!labels.has(id)) labels.set(id, new Set())
      labels.get(id).add(way.tags.name)
    }
  }
}
const metres = (a, b) =>
  Math.hypot(
    (a.lon - b.lon) * Math.cos(((a.lat + b.lat) * Math.PI) / 360),
    a.lat - b.lat,
  ) * 111195
const nodes = []
const ids = new Map()
const index = (id) => {
  if (!ids.has(id)) {
    ids.set(id, nodes.length)
    const p = points.get(id)
    nodes.push([Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))])
  }
  return ids.get(id)
}
const edges = []
for (const way of ways) {
  let start = null
  let previous = null
  let distance = 0
  for (let i = 0; i < way.nodes.length; i++) {
    const id = way.nodes[i]
    const p = points.get(id)
    if (!p) {
      start = previous = null
      distance = 0
      continue
    }
    if (start === null) {
      start = previous = id
      continue
    }
    distance += metres(points.get(previous), p)
    previous = id
    if (degree.get(id) !== 2 || distance >= 45 || i === way.nodes.length - 1) {
      if (start !== id && distance > 0)
        edges.push([index(start), index(id), Math.max(1, Math.round(distance))])
      start = id
      distance = 0
    }
  }
}
// Keep the largest walk-connected component; islands cannot be meeting points.
const adjacency = Array.from({ length: nodes.length }, () => [])
for (const [a, b] of edges) {
  adjacency[a].push(b)
  adjacency[b].push(a)
}
const seen = new Uint8Array(nodes.length)
let largest = []
for (let i = 0; i < nodes.length; i++) {
  if (seen[i]) continue
  const component = [i]
  seen[i] = 1
  for (let j = 0; j < component.length; j++) {
    for (const next of adjacency[component[j]]) {
      if (!seen[next]) {
        seen[next] = 1
        component.push(next)
      }
    }
  }
  if (component.length > largest.length) largest = component
}
const remap = new Map(largest.map((old, i) => [old, i]))
const places = []
for (const [id, names] of labels) {
  const node = remap.get(ids.get(id))
  if (node !== undefined && names.size >= 2)
    places.push({ node, name: [...names].sort().slice(0, 2).join(' & ') })
}
const data = {
  version: 1,
  name: 'San Francisco',
  bounds,
  attribution: '© OpenStreetMap contributors',
  source: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL-1.0',
  fetched: new Date().toISOString().slice(0, 10),
  nodes: largest.map((old) => nodes[old]),
  edges: edges
    .filter(([a, b]) => remap.has(a) && remap.has(b))
    .map(([a, b, d]) => [remap.get(a), remap.get(b), d]),
  places,
}
await mkdir('public/lab/meeting-point', { recursive: true })
await writeFile('public/lab/meeting-point/sf.json', JSON.stringify(data))
console.log(
  `${data.nodes.length} nodes, ${data.edges.length} edges, ${places.length} named intersections; ${Buffer.byteLength(JSON.stringify(data))} bytes`,
)
