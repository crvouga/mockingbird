#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@crvouga/mockingbird-adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "mockingbird-slack",
    description: "stateful Slack incoming-webhook and Web API mock with an outbox",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
