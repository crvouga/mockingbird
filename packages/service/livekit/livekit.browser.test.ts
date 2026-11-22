import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { build } from "esbuild"

test("real LiveKit browser client joins, publishes microphone, receives data and disconnects with emulator state", async () => {
  const result = await build({
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
    import { Room, RoomEvent } from "livekit-client";
    import { LiveKitAPI } from "./src/index.ts";
    import { createBrowserSignalServer, createSignalWebSocket } from "./src/browser.ts";
    import { jwt } from "./src/crypto.ts";
    globalThis.result = (async()=>{
      const events=[];
      const api=new LiveKitAPI({onEvent:event=>events.push(event.event)});
      let receivedTrack;
      const microphone=new Promise(resolve=>{receivedTrack=resolve});
      let receivedData;
      const clientData=new Promise(resolve=>{receivedData=resolve});
      const server=createBrowserSignalServer({api,onTrack:track=>receivedTrack(track.kind),onData:(packet,participant)=>receivedData({identity:participant.identity,room:participant.room,text:new TextDecoder().decode(packet.value.value.payload)})});
      const nativeSocket=globalThis.WebSocket;
      globalThis.WebSocket=createSignalWebSocket(server);
      const nativeFetch=globalThis.fetch;
      globalThis.fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));return url.pathname==="/rtc/validate"?server.validate(url):nativeFetch(input,init)};
      const room=new Room({adaptiveStream:false,dynacast:false});
      const token=await jwt("fixture-secret-that-is-at-least-32-chars",{iss:"fixture",sub:"visitor",exp:Math.floor(Date.now()/1000)+60,video:{roomJoin:true,room:"fixture-room"}});
      try {
        globalThis.phase="connect";
        await room.connect("ws://local.livekit.test",token,{autoSubscribe:true});
        globalThis.phase="microphone";
        await room.localParticipant.setMicrophoneEnabled(true);
        const kind=await microphone;
        globalThis.phase="data";
        const joined=new Promise(resolve=>room.once(RoomEvent.ParticipantConnected,p=>resolve(p.identity)));
        api.join("fixture-room",{identity:"scripted"});
        const remote=await joined;
        const data=new Promise(resolve=>room.once(RoomEvent.DataReceived,bytes=>resolve(new TextDecoder().decode(bytes))));
        await server.sendData("fixture-room","scripted",new TextEncoder().encode("hello"),"fixture");
        const payload=await data;
        globalThis.phase="client-data";
        await room.localParticipant.publishData(new TextEncoder().encode("from visitor"),{reliable:true,topic:"fixture"});
        const sent=await clientData;
        globalThis.phase="remote-audio";
        const context=new AudioContext();await context.resume();
        const oscillator=context.createOscillator();const destination=context.createMediaStreamDestination();oscillator.connect(destination);oscillator.start();
        const subscribed=new Promise(resolve=>room.once(RoomEvent.TrackSubscribed,track=>resolve(track.kind)));
        const speaking=new Promise(resolve=>room.once(RoomEvent.ActiveSpeakersChanged,participants=>resolve(participants.map(p=>p.identity))));
        const published=await server.publishAudio("fixture-room","scripted",destination.stream.getAudioTracks()[0]);
        const audio=await subscribed;
        const speakers=await speaking;
        globalThis.phase="transcription";
        const transcribed=new Promise(resolve=>room.once(RoomEvent.TranscriptionReceived,segments=>resolve(segments[0].text)));
        await server.sendTranscription("fixture-room","scripted","fixture words",published.sid);
        const text=await transcribed;
        oscillator.stop();await context.close();
        const participant=api.state.participants.get(api.state.participantId("fixture-room","visitor"));
        globalThis.phase="remove";
        const disconnected=new Promise(resolve=>room.once(RoomEvent.Disconnected,()=>resolve(true)));
        api.remove("fixture-room","visitor");
        await disconnected;
        return {kind,remote,payload,sent,audio,speakers,text,tracks:participant.tracks.length,joined:events.includes("participant_joined"),published:events.includes("track_published"),connections:server.connections};
      } finally {await room.disconnect();await server.close();globalThis.WebSocket=nativeSocket;globalThis.fetch=nativeFetch;}
    })();
  `,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    logLevel: "silent",
  })
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
    await page.route("https://livekit.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    )
    await page.goto("https://livekit.test/")
    await page.addScriptTag({ content: result.outputFiles[0]?.text ?? "" })
    expect(errors).toEqual([])
    expect(
      await page.evaluate<unknown>(
        "Promise.race([globalThis.result,new Promise((_,reject)=>setTimeout(()=>reject(new Error(globalThis.phase)),45000))])",
      ),
    ).toEqual({
      kind: "audio",
      remote: "scripted",
      payload: "hello",
      sent: { identity: "visitor", room: "fixture-room", text: "from visitor" },
      audio: "audio",
      speakers: ["scripted"],
      text: "fixture words",
      tracks: 1,
      joined: true,
      published: true,
      connections: 0,
    })
  } finally {
    await browser.close()
  }
}, 60000)
