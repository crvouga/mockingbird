/**
 * Live parity against MinIO, the S3 oracle (oracle/README.md): every scenario played against a
 * running MinIO and a fresh emulator, transcripts diffed. Exit 2 when MinIO is unreachable.
 */
const child = Bun.spawn(["bun", "oracle/run.ts", ...process.argv.slice(2)], {
  cwd: `${import.meta.dir}/..`,
  stdio: ["inherit", "inherit", "inherit"],
})
process.exit(await child.exited)
