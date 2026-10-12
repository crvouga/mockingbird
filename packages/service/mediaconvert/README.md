# @crvouga/mockingbird-service-mediaconvert

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful AWS Elemental MediaConvert emulator for the official SDK v3 client. It supports endpoint discovery, asynchronous jobs, deterministic controls, EventBridge-compatible events, and output writes to a configured emulator S3 service.

## Install

```bash
npm install -D @crvouga/mockingbird-service-mediaconvert
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import {
  CreateJobCommand,
  DescribeEndpointsCommand,
  MediaConvertClient,
} from "@aws-sdk/client-mediaconvert"
import { createServer } from "@crvouga/mockingbird-service-mediaconvert/server"

// Test setup: start the emulator and point the discovery client at it.
const server = await createServer()
const aws = {
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
}
const discovery = new MediaConvertClient({ ...aws, endpoint: server.url })

// Application code, unchanged. DescribeEndpoints returns the emulator URL, which the
// second client uses to submit jobs.
const { Endpoints } = await discovery.send(new DescribeEndpointsCommand({}))
const mediaConvert = new MediaConvertClient({ ...aws, endpoint: Endpoints?.[0]?.Url })
const { Job } = await mediaConvert.send(
  new CreateJobCommand({
    Role: "arn:aws:iam::000000000000:role/MediaConvert",
    Settings: {
      Inputs: [{ FileInput: "s3://inputs/source.mp4" }],
      OutputGroups: [
        {
          OutputGroupSettings: {
            Type: "FILE_GROUP_SETTINGS",
            FileGroupSettings: { Destination: "s3://outputs/video/" },
          },
        },
      ],
    },
  }),
)
// Job.Status === "SUBMITTED"

await server.close()
```

Supported operations are DescribeEndpoints, CreateJob, GetJob, and CancelJob. CreateJob retains Role, Queue, UserMetadata, and the complete nested Settings structure. A repeated ClientRequestToken returns the original job.

## Controls

- `GET /__admin/jobs` and `GET /__admin/jobs/:id` inspect submitted jobs and exact settings.
- `POST /__admin/jobs/:id/transition` accepts `status` (`PROGRESSING`, `COMPLETE`, `ERROR`, or `CANCELED`) plus optional `progress`, `durationInMs`, `size`, `names`, `errorCode`, and `errorMessage`.
- Completing a job writes deterministic output bytes to each HLS or file-group S3 destination when `s3.endpoint` is configured.
- Every state change emits an EventBridge-compatible `MediaConvert Job State Change` event through the shared webhook hub.
- Fault presets are `too_many_requests`, `internal_error`, and `unavailable`.

The shared runtime provides reset, clock, journal, metrics, faults, and namespace isolation.

## API

- `MediaConvertAPI`, `MediaConvertAPIOptions`, `MediaConvertEvent`, `TransitionOptions`: handler, events, and deterministic controls.
- `MediaConvertJob`, `MediaConvertJobStatus`, `OutputGroupDetail`: durable job state.
- `createRuntime`, `MediaConvertRuntime`, `MediaConvertRuntimeOptions`: full Mockingbird runtime and webhook hub.
- `MEDIACONVERT_NAMESPACE`, `MEDIACONVERT_PRESETS`, `accessKeyCredential`: constants and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `MediaConvertServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

## Deliberately not modelled

Real transcoding, IAM evaluation, arbitrary operations, production limits, billing, dashboards, and codecs outside the submitted HLS/MP4 structure are not modelled.

Official oracle: [AWS Elemental MediaConvert API Reference](https://docs.aws.amazon.com/mediaconvert/latest/apireference/what-is.html).
