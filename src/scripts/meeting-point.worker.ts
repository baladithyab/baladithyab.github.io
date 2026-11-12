import {
  findMeetings,
  type SearchRequest,
  type SearchReply,
} from '@/lib/meeting-point'

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  try {
    const output = findMeetings(event.data)
    const reply: SearchReply = { kind: 'result', output }
    self.postMessage(reply, {
      transfer: output.trees.flatMap((tree) => [
        tree.distances.buffer,
        tree.parents.buffer,
      ]),
    })
  } catch (error) {
    const reply: SearchReply = {
      kind: 'error',
      message:
        error instanceof Error ? error.message : 'The road search failed.',
    }
    self.postMessage(reply)
  }
}
