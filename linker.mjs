// linker.mjs — SINGLE entry point for the published dataset (review item 2).
//
//   rm -rf linkage_out && node linker.mjs
//
// From an empty linkage_out/ this regenerates every published row:
//   stage 1  linker2.mjs   enumerate agents, probe every external surface, apply the
//                          distinctness filter, write sources.json (the fetch record)
//   stage 2  sharedid.mjs  attach the shared identifier to each row, drop the rows that
//                          have none, write links_final.json / links_rejected.json /
//                          precision.json
//
// No published row comes from a cache written by an older version of the code: stage 1
// builds links.json from scratch and stage 2 reads only that file. The original
// single-file probe is kept as linker_v1.mjs; it is superseded and is NOT part of the
// published pipeline (that is exactly why its cached rows used to survive).
//
// Runtime: stage 1 is ~2,600 network fetches and takes about 80 minutes. When
// linkage_out/links.json already exists the probe is skipped, so the identifier pass can
// be re-run alone with `node sharedid.mjs`. FORCE_PROBE=1 re-probes anyway.
//
// Evidence tiers:
//   verified — the agent's own homepage references the exact BasedAgents agent id
//   strong   — a unique hard identifier matches (wallet / agent id / x402 payTo)
//   weak     — same URL or same host only, no id or wallet
//   blocked  — the endpoint is on the profile's own host but my network could not read it;
//              the failed fetch is in sources.json and the row is never counted as verified

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const stage = (script) => {
  process.stderr.write(`\n=== ${script} ===\n`);
  const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write(`${script} exited ${r.status}\n`);
    process.exit(r.status || 1);
  }
};

if (existsSync("linkage_out/links.json") && existsSync("linkage_out/agents.json") && !process.env.FORCE_PROBE) {
  process.stderr.write("linkage_out/links.json exists — skipping the probe pass.\n");
  process.stderr.write("Set FORCE_PROBE=1 (or delete linkage_out/) to re-probe from scratch.\n");
} else {
  stage("linker2.mjs");
}
stage("sharedid.mjs");
process.stderr.write("\ndone: linkage_out/links_final.json\n");
