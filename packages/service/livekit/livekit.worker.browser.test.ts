import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { build } from "esbuild"

test("worker runtime owns authenticated LiveKit state, inbox, attributes, text and RPC while page owns WebRTC", async () => {
  const worker = await build({
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
    import {createRuntime} from "./src/runtime.ts";
    import {hostSignalState} from "./src/signal-state.ts";
    const runtime=createRuntime();
    onmessage=async({data})=>{
      if(data.port){hostSignalState(data.port,runtime.instance("fixture"));return}
      try {
        const response=await runtime.fetch(new Request("http://mock"+data.path,{method:data.body===undefined?"GET":"POST",headers:{"content-type":"application/json","x-mockingbird-namespace":"fixture"},...(data.body===undefined?{}:{body:JSON.stringify(data.body)})}));
        postMessage({id:data.id,status:response.status,body:await response.json()});
      } catch(error){postMessage({id:data.id,error:String(error)})}
    };
  `,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    logLevel: "silent",
  })
  const pageBundle = await build({
    stdin: {
      resolveDir: import.meta.dir,
      contents: `
    import {Room,RoomEvent} from "livekit-client";
    import {createBrowserSignalServer,createSignalWebSocket} from "./src/browser.ts";
    import {connectSignalState} from "./src/signal-state.ts";
    import {jwt} from "./src/crypto.ts";
    globalThis.result=(async()=>{
      const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker.outputFiles[0]?.text)}],{type:"text/javascript"})));
      const channel=new MessageChannel();worker.postMessage({port:channel.port1},[channel.port1]);
      const api=connectSignalState(channel.port2);
      let next=0;const pending=new Map();
      worker.onmessage=({data})=>{const callback=pending.get(data.id);pending.delete(data.id);callback(data)};
      const control=async(path,body)=>{const id=++next;const response=await new Promise(resolve=>{pending.set(id,resolve);worker.postMessage({id,path,body})});if(response.error||response.status>=400)throw new Error(JSON.stringify(response));return response.body};
      const roomName="worker-room";
      const participantPath="/__admin/rooms/"+roomName+"/participants";
      let microphoneReceived;const microphone=new Promise(resolve=>microphoneReceived=resolve);
      const server=createBrowserSignalServer({api,onTrack:track=>microphoneReceived(track.kind)});
      const originalSocket=globalThis.WebSocket;globalThis.WebSocket=createSignalWebSocket(server);
      const room=new Room();
      try {
        globalThis.phase="worker-connect";
        const token=await jwt("fixture-secret-that-is-at-least-32-chars",{iss:"fixture",sub:"visitor",exp:Math.floor(Date.now()/1000)+60,video:{roomJoin:true,room:roomName}});
        await room.connect("ws://worker.livekit.test",token);
        await room.localParticipant.setMicrophoneEnabled(true);const microphoneKind=await microphone;
        const joined=new Promise(resolve=>room.once(RoomEvent.ParticipantConnected,p=>resolve(p.identity)));
        await control(participantPath,{identity:"scripted"});await joined;
        globalThis.phase="attributes";
        const attributes=new Promise(resolve=>room.once(RoomEvent.ParticipantAttributesChanged,(changed,p)=>resolve({state:changed["lk.agent.state"],identity:p.identity})));
        await control(participantPath+"/scripted/attributes",{attributes:{"lk.agent.state":"listening"}});
        const changed=await attributes;
        globalThis.phase="text";
        let textDone;const text=new Promise(resolve=>textDone=resolve);
        room.registerTextStreamHandler("fixture.text",async(reader,participant)=>textDone({text:await reader.readAll(),identity:participant.identity}));
        await control(participantPath+"/scripted/text",{topic:"fixture.text",text:"worker text"});
        const textValue=await text;
        globalThis.phase="inbox";
        await room.localParticipant.publishData(new TextEncoder().encode("client bytes"),{reliable:true,destinationIdentities:["scripted"],topic:"fixture"});
        const until=async(predicate)=>{for(let i=0;i<200;i++){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error("inbox deadline "+globalThis.phase+" "+JSON.stringify(await control(participantPath+"/scripted/inbox")))};
        const data=await until(async()=>{const {messages}=await control(participantPath+"/scripted/inbox");return messages.find(m=>m.topic==="fixture")});
        globalThis.phase="media";
        const media=await until(async()=>{const {tracks}=await control(participantPath+"/visitor/media");return tracks.find(track=>track.bytesReceived>0&&track.packetsReceived>0)});
        globalThis.phase="rpc";
        const rpc=room.localParticipant.performRpc({destinationIdentity:"scripted",method:"fixture.echo",payload:"request",responseTimeout:10000});
        const request=await until(async()=>{const {messages}=await control(participantPath+"/scripted/inbox");return messages.map(m=>JSON.parse(m.packet)).find(p=>p.rpcRequest)?.rpcRequest});
        await control(participantPath+"/scripted/rpc-response",{requestId:request.id,payload:"worker response",destinationIdentities:["visitor"]});
        const rpcValue=await rpc;
        globalThis.phase="transcription";
        const transcription=new Promise(resolve=>room.once(RoomEvent.TranscriptionReceived,segments=>resolve(segments[0].text)));
        await control(participantPath+"/scripted/transcription",{text:"worker words"});
        const transcriptionValue=await transcription;
        globalThis.phase="scripted-audio";
        const subscribed=new Promise(resolve=>room.once(RoomEvent.TrackSubscribed,track=>resolve(track.kind)));
        const started=new Promise(resolve=>room.once(RoomEvent.ActiveSpeakersChanged,participants=>resolve(participants.map(p=>p.identity))));
        await control(participantPath+"/scripted/audio",{tone:{hz:440,ms:300}});
        const audioKind=await subscribed;
        const speaking=await started;
        const stopped=new Promise(resolve=>room.once(RoomEvent.ActiveSpeakersChanged,participants=>resolve(participants.length)));
        const silent=await stopped;
        globalThis.phase="pcm";
        const samples=new Uint8Array(48000);const view=new DataView(samples.buffer);for(let i=0;i<24000;i++)view.setInt16(i*2,Math.round(8000*Math.sin(2*Math.PI*440*i/48000)),true);
        let binary="";for(const byte of samples)binary+=String.fromCharCode(byte);
        const pcmSubscribed=new Promise(resolve=>room.once(RoomEvent.TrackSubscribed,track=>resolve(track.kind)));
        await control(participantPath+"/scripted/audio",{pcm:btoa(binary),sampleRate:48000});
        const pcmKind=await pcmSubscribed;
        globalThis.phase="reconnect";
        const oldSid=room.localParticipant.sid;
        const reconnecting=new Promise(resolve=>room.once(RoomEvent.SignalReconnecting,()=>resolve(true)));
        const reconnected=new Promise(resolve=>room.once(RoomEvent.Reconnected,()=>resolve(true)));
        await control("/__admin/faults/presets/network_loss",{});
        const recovery={started:await reconnecting,completed:await reconnected,sameSid:oldSid===room.localParticipant.sid};
        const rooms=await control("/__admin/rooms");
        const connections=await control("/__admin/signal/connections");
        const participants=await api.listParticipants(roomName);
        return {pcmKind,resumes:connections.connections[0].resumes,audioKind,speaking,silent,recovery,media:media.bytesReceived>0&&media.packetsReceived>0,microphoneKind,changed,textValue,rpcValue,transcriptionValue,inbox:{text:atob(data.data),sender:data.senderIdentity},rooms:rooms.rooms.length,tracks:participants.find(p=>p.identity==="visitor").tracks.length};
      } finally {await room.disconnect();await server.close();api.close();worker.terminate();globalThis.WebSocket=originalSocket}
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
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  })
  try {
    const page = await browser.newPage()
    await page.route("https://livekit.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    )
    await page.goto("https://livekit.test")
    await page.addScriptTag({ content: pageBundle.outputFiles[0]?.text ?? "" })
    const result = await page.evaluate<unknown>(
      "Promise.race([globalThis.result,new Promise((_,reject)=>setTimeout(()=>reject(new Error(globalThis.phase)),45000))])",
    )
    expect(result).toEqual({
      pcmKind: "audio",
      resumes: 1,
      audioKind: "audio",
      speaking: ["scripted"],
      silent: 0,
      recovery: { started: true, completed: true, sameSid: true },
      media: true,
      microphoneKind: "audio",
      changed: { state: "listening", identity: "scripted" },
      textValue: { text: "worker text", identity: "scripted" },
      rpcValue: "worker response",
      transcriptionValue: "worker words",
      inbox: { text: "client bytes", sender: "visitor" },
      rooms: 1,
      tracks: 1,
    })
  } finally {
    await browser.close()
  }
}, 60000)
