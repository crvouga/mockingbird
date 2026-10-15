import { createHash } from "node:crypto"

const services = ["stripe", "postgres", "redis"]
const inventory = await Promise.all(
  services.map(async (name) => {
    const pkg = await Bun.file(`packages/service/${name}/package.json`).json()
    return { name: pkg.name, version: pkg.version }
  }),
)
console.log(
  JSON.stringify({
    bun: Bun.version,
    lockSha256: createHash("sha256")
      .update(
        await Bun.file("bun.lock")
          .arrayBuffer()
          .then((v) => Buffer.from(v)),
      )
      .digest("hex"),
    services: inventory,
  }),
)
