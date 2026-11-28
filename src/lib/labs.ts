export interface LabEntry {
  slug: string
  href: string
  title: string
  category: string
  summary: string
  tags: string[]
}

export const labs: LabEntry[] = [
  {
    slug: 'real-estate-due-diligence',
    href: '/lab/real-estate-due-diligence',
    title: 'Real Estate Due Diligence',
    category: 'Maps & Property',
    summary:
      'San José drive-time catchment workbench with live HomeHarvest listings, county parcel/zoning/hazard/crime public-record screening, and buyer underwriting.',
    tags: ['Cloudflare Workers', 'GIS', 'HomeHarvest', 'Public Records'],
  },
  {
    slug: 'meeting-point',
    href: '/lab/meeting-point',
    title: 'Meeting Point',
    category: 'Maps & Algorithms',
    summary:
      'Find fairer places for a group to meet with animated multi-source Dijkstra road search, custom influence zones, and live traffic/event layers.',
    tags: ['Web Workers', 'OpenStreetMap', 'Canvas 2D'],
  },
  {
    slug: 'tripspace',
    href: '/lab/tripspace',
    title: 'Tripspace',
    category: 'Group Trip App',
    summary:
      'Coordinate group trips from idea to booked itinerary with shared timelines, date polling, cost tracking, and live flight price monitoring.',
    tags: ['React', 'Skiplagged', 'Local-first'],
  },
  {
    slug: 'deep-brush',
    href: '/lab/deep-brush',
    title: 'Deep Brush',
    category: 'Rust + WebGPU',
    summary:
      'Paint, relight, and place decals directly onto 3D surfaces inside a photo using local Depth Anything V2 Small inference in Rust and WGSL.',
    tags: ['Rust', 'WebAssembly', 'WebGPU'],
  },
  {
    slug: 'energy-ring',
    href: '/lab/energy-ring',
    title: 'Energy Ring',
    category: 'Rust + WebGL2',
    summary:
      'Audio-reactive 3D spectrum visualizer analyzed and rendered by a Rust WebAssembly crate over WebGL2 with demo and local audio support.',
    tags: ['Rust', 'WebAssembly', 'WebGL2'],
  },
]
