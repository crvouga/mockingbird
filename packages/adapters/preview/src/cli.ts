#!/usr/bin/env node
/// <reference types="node" />
import { runPreviewCli } from "./cli-main.js"

const code = await runPreviewCli(process.argv.slice(2))
if (code !== 0) process.exitCode = code
