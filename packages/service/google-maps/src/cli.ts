#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@crvouga/mockingbird-adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "mockingbird-google-maps",
    description: "Google Places / Geocoding / Maps JavaScript API mock over a QA address corpus",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
