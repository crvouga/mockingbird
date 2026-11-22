import { buildPreview } from "@crvouga/mockingbird-preview/build"
import { previewOptions, previewOutdir } from "./preview-options.ts"

/**
 * The lab's static PR preview, which the boot loader keeps live and updates in place. Deploys
 * stamp `version.json` (`mockingbird-preview stamp`). While you work, `dev-preview.ts` serves the
 * same preview and rebuilds on save.
 */
const { entry } = await buildPreview({ ...previewOptions, outdir: previewOutdir })
console.log(`Static system preview: ${previewOutdir} (app entry ${entry})`)
