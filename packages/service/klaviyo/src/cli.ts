#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@crvouga/mockingbird-adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "mockingbird-klaviyo",
    description: "stateful Klaviyo events API mock",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
