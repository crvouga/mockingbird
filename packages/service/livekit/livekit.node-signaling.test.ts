import { expect, test } from "bun:test"
import { fork } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { type Browser, chromium } from "@playwright/test"
import { build } from "esbuild"
import { RoomServiceClient } from "livekit-server-sdk"
import WebSocket from "ws"
import { jwt } from "./src/crypto.js"

test("Node opt-in websocket signaling connects the real browser SDK using an injected WebRTC provider", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "node_modules/.signal-fixture-"))
  const fixture = join(directory, "server.mjs")
  await build({
    entryPoints: [join(import.meta.dir, "test/node-signal-fixture.ts")],
    bundle: true,
    platform: "node",
    packages: "external",
    format: "esm",
    outfile: fixture,
    logLevel: "silent",
  })
  const child = fork(fixture, { execPath: "node", stdio: ["ignore", "pipe", "pipe", "ipc"] })
  let errors = ""
  child.stderr?.on("data", (chunk) => {
    errors += String(chunk)
  })
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  const server = {
    url: await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Node server startup timed out: ${errors}`)),
        8000,
      )
      child.once("message", (message: unknown) => {
        clearTimeout(timer)
        if (
          message &&
          typeof message === "object" &&
          "url" in message &&
          typeof message.url === "string"
        )
          resolve(message.url)
        else reject(new Error("Invalid Node server readiness message"))
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", () => {
        clearTimeout(timer)
        reject(new Error(`Node server exited: ${errors}`))
      })
    }).catch(async (error) => {
      child.kill()
      await rm(directory, { recursive: true, force: true })
      throw error
    }),
  }
  const sdk = new RoomServiceClient(
    server.url,
    "fixture",
    "fixture-secret-that-is-at-least-32-chars",
  )
  const inspect = async (path: string) => {
    const response = await fetch(`${server.url}/__admin/rooms/node-room/participants/${path}`)
    expect(response.status).toBe(200)
    return response.json()
  }
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    })
    const token = await jwt("fixture-secret-that-is-at-least-32-chars", {
      iss: "fixture",
      sub: "visitor",
      exp: Math.floor(Date.now() / 1000) + 60,
      video: { roomJoin: true, room: "node-room" },
    })
    const bundle = await build({
      stdin: {
        resolveDir: import.meta.dir,
        contents: `
      import {Room,RoomEvent} from "livekit-client";
      const room=new Room();globalThis.room=room;
      globalThis.audio=new Promise((resolve,reject)=>room.once(RoomEvent.TrackSubscribed,track=>{(async()=>{track.attach();for(let i=0;i<150;i++){const stats=await track.getReceiverStats();if(stats?.bytesReceived>0)return {kind:track.kind,bytes:true};await new Promise(resolve=>setTimeout(resolve,10))}throw new Error("No remote audio bytes")})().then(resolve,reject)}));
      globalThis.transcription=new Promise(resolve=>room.once(RoomEvent.TranscriptionReceived,segments=>resolve(segments[0].text)));
      globalThis.result=(async()=>{
        globalThis.stage="connect";
        await room.connect(${JSON.stringify(server.url.replace("http:", "ws:"))},${JSON.stringify(token)});
        globalThis.stage="microphone";
        await room.localParticipant.setMicrophoneEnabled(true);
        const data=new Promise(resolve=>room.once(RoomEvent.DataReceived,bytes=>resolve(new TextDecoder().decode(bytes))));
        globalThis.connected=true;
        const payload=await data;
        await room.localParticipant.publishData(new TextEncoder().encode("node inbox"),{reliable:true,destinationIdentities:["scripted"]});
        return {payload,identity:room.localParticipant.identity};
      })();
    `,
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent",
    })
    const page = await browser.newPage()
    const browserErrors: string[] = []
    page.on("pageerror", (error) => browserErrors.push(error.message))
    const result = (name: string) =>
      page.evaluate(async (name) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            Reflect.get(globalThis, name),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 8000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }, name)
    await page.goto(server.url)
    await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? "" })
    try {
      await page.waitForFunction("globalThis.connected", undefined, { timeout: 12000 })
    } catch (cause) {
      throw new Error(
        JSON.stringify({
          stage: await page.evaluate("globalThis.stage"),
          browserErrors,
          serverErrors: errors,
        }),
        { cause },
      )
    }
    expect(
      (
        await fetch(`${server.url}/__admin/rooms/node-room/participants`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity: "scripted" }),
        })
      ).status,
    ).toBe(201)
    const response = await fetch(
      new Request(`${server.url}/__admin/rooms/node-room/participants/scripted/data`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: btoa("node data") }),
      }),
    )
    expect(response.status).toBe(200)
    expect(await result("result")).toEqual({
      payload: "node data",
      identity: "visitor",
    })
    for (
      let attempt = 0;
      attempt < 100 &&
      !(await inspect("scripted/inbox")).messages.some(
        (row: { senderIdentity: string }) => row.senderIdentity === "visitor",
      );
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      (await inspect("scripted/inbox")).messages.some(
        (row: { senderIdentity: string }) => row.senderIdentity === "visitor",
      ),
    ).toBe(true)
    expect((await sdk.getParticipant("node-room", "visitor")).tracks).toHaveLength(1)
    for (
      let attempt = 0;
      attempt < 200 &&
      !(await inspect("visitor/media")).tracks.some(
        (row: { bytesReceived: number }) => row.bytesReceived > 0,
      );
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10))

    expect(
      (await inspect("visitor/media")).tracks.some(
        (row: { bytesReceived: number; packetsReceived: number }) =>
          row.bytesReceived > 0 && row.packetsReceived > 0,
      ),
    ).toBe(true)
    const audio = await fetch(
      new Request(`${server.url}/__admin/rooms/node-room/participants/scripted/audio`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tone: { hz: 440, ms: 1000 } }),
      }),
    )
    expect(audio.status).toBe(200)
    expect(await result("audio")).toEqual({ kind: "audio", bytes: true })
    const transcription = await fetch(
      new Request(`${server.url}/__admin/rooms/node-room/participants/scripted/transcription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "node words" }),
      }),
    )
    expect(transcription.status).toBe(200)
    expect(await result("transcription")).toBe("node words")
    const handshakeStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${server.url.replace("http:", "ws:")}/rtc?access_token=invalid`)
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error("Refused handshake deadline"))
      }, 2000)
      socket.on("error", () => {})
      socket.on("unexpected-response", (_request, response) => {
        clearTimeout(timer)
        resolve(response.statusCode ?? 0)
        response.resume()
        socket.terminate()
      })
      socket.on("open", () => {
        clearTimeout(timer)
        socket.close()
        reject(new Error("Invalid token connected"))
      })
    })
    expect(handshakeStatus).toBe(401)
    const denied = await fetch(`${server.url}/rtc/validate?access_token=invalid`)
    expect(denied.status).toBe(401)
    await page.evaluate("room.disconnect()")
  } finally {
    await browser?.close()
    try {
      child.send({ type: "close" })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Node close timed out: ${errors}`)), 5000)
          }),
        ])
        expect({ code, errors }).toEqual({ code: 0, errors: "" })
      } finally {
        clearTimeout(timer)
      }
    } finally {
      child.kill()
      await rm(directory, { recursive: true, force: true })
    }
  }
}, 30000)
