#!/usr/bin/env node
/// <reference types="node" />
import { runCli, serveCommand } from "@crvouga/mockingbird-adapter-node"
import { serveTarget } from "./server.js"

const code = await runCli(
  {
    bin: "mockingbird-hermes",
    description: "Hermes peer-run API mock (WIP: synthetic run lifecycle)",
    commands: { serve: serveCommand(serveTarget) },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
