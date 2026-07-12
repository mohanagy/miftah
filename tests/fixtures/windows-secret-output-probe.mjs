import { writeFileSync } from "node:fs";

const recordPath = process.env.MIFTAH_WINDOWS_OUTPUT_PROBE_RECORD_PATH;
if (recordPath) writeFileSync(recordPath, "ran");
process.stdout.write("windows-secret-output-probe");
