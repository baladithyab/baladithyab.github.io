import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { preview } from 'astro'
import sharp from 'sharp'

process.env.WRANGLER_SEND_METRICS = 'false'
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const address = reservation.address()
assert(address && typeof address !== 'string')
const released = once(reservation, 'close')
reservation.close()
await released
const server = await preview({ server: { host: '127.0.0.1', port: address.port } })
const imageUrl = new URL(`http://127.0.0.1:${server.port}/api/og.png`)
imageUrl.searchParams.set('debug', '1')
imageUrl.searchParams.set('title', 'Worker <&> rendering check')
imageUrl.searchParams.set('subtitle', 'Framework rendering')
imageUrl.searchParams.set('tag', 'Blog')
imageUrl.searchParams.set('accent', '#fb7185')

async function request() {
  return fetch(imageUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
}

async function decode(response: Response) {
  assert.equal(response.status, 200, `OG response: ${response.status} ${response.statusText}`)
  assert.equal(response.headers.get('content-type'), 'image/png')
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 1200)
  assert.equal(info.height, 630)
  return data
}

try {
  const first = await decode(await request())
  imageUrl.searchParams.set('title', 'A different social card title')
  const second = await decode(await request())
  assert.equal(first.equals(second), false, 'Distinct title queries must not share one rendered image')

  let unexpectedFetches = 0
  const trap = createHttpServer((_request, response) => {
    unexpectedFetches++
    response.writeHead(404).end()
  })
  trap.listen(0, '127.0.0.1')
  await once(trap, 'listening')
  try {
    const address = trap.address()
    assert(address && typeof address !== 'string')
    imageUrl.searchParams.delete('tag')
    imageUrl.searchParams.set('accent', `url(http://127.0.0.1:${address.port}/private.png)`)
    const blocked = await request()
    assert.equal(blocked.status, 500, 'Debug rendering must report a blocked image URL')
    await blocked.arrayBuffer()
    assert.equal(unexpectedFetches, 0, 'Query-driven CSS must not make arbitrary image requests')
  } finally {
    const closed = once(trap, 'close')
    trap.close()
    await closed
  }
  console.log('Worker OG smoke passed: decodable 1200x630 PNGs, distinct title pixels, arbitrary image requests blocked')
} finally {
  const closed = server.closed()
  await server.stop()
  await closed
}
