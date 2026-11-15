import OpusScript from "opusscript"
import {
  RTCPeerConnection as NodePeer,
  MediaStream as NodeStream,
  MediaStreamTrack as NodeTrack,
  RtpHeader,
  RtpPacket,
} from "werift"
import { createServer } from "../src/server.js"

const peers: NodePeer[] = []
const server = await createServer({
  signaling: {
    createMediaStream: (tracks) =>
      new NodeStream(tracks as unknown as NodeTrack[]) as unknown as MediaStream,
    createAudio: (input) => {
      if (!input.tone) throw new Error("This test provider accepts tones")
      const tone = input.tone
      const track = new NodeTrack({ kind: "audio", id: crypto.randomUUID() })
      const encoder = new OpusScript(48000, 1, OpusScript.Application.AUDIO)
      let sequence = 0
      const timer = setInterval(() => {
        const samples = Buffer.alloc(960 * 2)
        for (let i = 0; i < 960; i++)
          samples.writeInt16LE(
            Math.round(8000 * Math.sin((2 * Math.PI * tone.hz * (sequence * 960 + i)) / 48000)),
            i * 2,
          )
        track.writeRtp(
          new RtpPacket(
            new RtpHeader({
              payloadType: 111,
              sequenceNumber: sequence,
              timestamp: sequence * 960,
              ssrc: 1337,
            }),
            encoder.encode(samples, 960),
          ),
        )
        sequence++
      }, 20)
      return {
        track: track as unknown as MediaStreamTrack,
        durationMs: input.tone.ms,
        close() {
          clearInterval(timer)
          encoder.delete()
          track.stop()
        },
      }
    },
    createPeerConnection: () => {
      const peer = new NodePeer({
        iceServers: [],
        iceUseIpv6: false,
        iceAdditionalHostAddresses: ["127.0.0.1"],
      })
      const createChannel = peer.createDataChannel.bind(peer)
      peer.createDataChannel = (label, options) => {
        const channel = createChannel(label, options)
        const send = channel.send.bind(channel)
        channel.send = (data) => send(typeof data === "string" ? data : Buffer.from(data))
        return channel
      }
      peers.push(peer)
      return peer as unknown as RTCPeerConnection
    },
  },
})

process.send?.({ url: server.url })
process.once("message", async () => {
  try {
    await server.close()
    if (!peers.every((peer) => peer.connectionState === "closed"))
      throw new Error("Peer leaked after close")
  } catch (error) {
    process.stderr.write(String(error))
    process.exitCode = 1
  } finally {
    process.disconnect?.()
  }
})
