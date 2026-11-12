import {
  loadMeetingNetwork,
  type NetworkRequest,
  type NetworkReply,
} from '@/lib/meeting-network-loader'

self.onmessage = async (event: MessageEvent<NetworkRequest>) => {
  const post = (reply: NetworkReply) => self.postMessage(reply)
  try {
    const result = await loadMeetingNetwork(event.data, (message) =>
      post({ kind: 'progress', message }),
    )
    post({ kind: 'ready', ...result })
  } catch (error) {
    post({
      kind: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'The walking network could not be loaded.',
    })
  }
}
