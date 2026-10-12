// reprobe_blocked.mjs — re-probe the endpoints that were rate-limited or unreachable
// during the main run, and append every attempt to linkage_out/sources.json.
//
// The main run records its own attempts, but a 429 from an anti-bot challenge is often
// transient, so each blocked endpoint gets one more attempt at delivery time and that
// attempt lands in the same fetch record. Nothing here infers a link from a failure:
// this script only ever ADDS fetch lines. If an endpoint answers 200 this time, the row
// is still reported as blocked in links_final.json — that tier is decided by
// sharedid.mjs, and promoting it would mean claiming a read I did not make in the run
// the row comes from.
//
// Usage: node reprobe_blocked.mjs

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "linkage_out";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; research-linker/2.0 reprobe)" };

const TARGETS = [
  "https://nexushub.nexus/.well-known/x402",                 // NexusHubLaunchAuditor — review item 4
  "https://nexushub-web-launch-preflight.vercel.app/.well-known/x402",
  "https://gas-ventures.vercel.app/.well-known/x402",        // GAS Worker #001 — non-blocking
];

const sources = JSON.parse(readFileSync(`${OUT}/sources.json`, "utf8"));

for (const url of TARGETS) {
  const fetched_at = new Date().toISOString();
  let http;
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(30000) });
    http = String(r.status);
  } catch (e) {
    http = "err:" + e.message;
  }
  sources.push({ url, http, fetched_at, note: "delivery-time re-probe (reprobe_blocked.mjs)" });
  console.log(`${http} | ${url} | ${fetched_at}`);
}

writeFileSync(`${OUT}/sources.json`, JSON.stringify(sources, null, 1));
console.log(`sources.json now has ${sources.length} entries`);
