// audit20.mjs — self-audit: re-verify 20 distinct link rows against their external_id.
//
// Fix vs revision 1: the audit now fetches each link's OWN external_id
// (the agent's page / MCP server URL / repo URL), not the registry host root,
// and prints one line per row: basedagents_id | URL | result. Precision is
// computed from those 20 lines only.
//
// Reproduce: node audit20.mjs        (writes linkage_out/audit20.json)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const OUT = "linkage_out";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; research-linker/2.0 audit)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const links = JSON.parse(readFileSync(`${OUT}/links_filtered.json`, "utf8"));
const agents = JSON.parse(readFileSync(`${OUT}/agents.json`, "utf8"));
const byId = new Map(agents.map((a) => [a.agent_id, a]));

// 20 distinct links, one per distinct agent where possible: verified first,
// then strong, then weak — so the sample spans the tiers the rows claim.
const order = { verified: 0, strong: 1, weak: 2 };
const sorted = [...links].sort((a, b) => (order[a.confidence] - order[b.confidence]));
const picked = [];
const usedAgents = new Set();
for (const tier of ["verified", "strong", "weak"]) {
  for (const l of sorted) {
    if (l.confidence !== tier) continue;
    if (usedAgents.has(l.basedagents_id)) continue;   // one row per agent
    if (picked.length >= 20) break;
    picked.push(l);
    usedAgents.add(l.basedagents_id);
    if (picked.length >= 20) break;
  }
  if (picked.length >= 20) break;
}

async function fetchOne(url) {
  const t0 = new Date().toISOString();
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const text = r.ok ? (await r.text()).slice(0, 200000) : "";
    return { http: r.status, ok: r.ok, text, finalUrl: r.url, fetched_at: t0 };
  } catch (e) {
    return { http: "err", text: "", finalUrl: url, fetched_at: t0, err: String(e).slice(0, 80) };
  }
}

const results = [];
for (const l of picked) {
  const a = byId.get(l.basedagents_id) || {};
  const wallet = (a.wallet_address || "").toLowerCase();
  const target = l.external_id.startsWith("http") ? l.external_id : null;

  if (!target) {
    // non-HTTP entity (MCP registry name row): the evidence is the registry match,
    // re-checked by querying the registry again for that exact server name.
    const name = l.external_id.replace(/^mcp-registry:/, "");
    const r = await fetch(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(name)}&limit=10`);
    let ok = false, detail = "";
    if (r.ok) {
      const j = await r.json();
      const names = (j.servers || []).map((s) => (s.server || {}).name || "");
      ok = names.some((n) => (n || "").toLowerCase() === name.toLowerCase());
      detail = `registry search returned ${names.length} entries; exact server-name match: ${ok}`;
    } else detail = `registry HTTP ${r.status}`;
    const line = { basedagents_id: l.basedagents_id, url: `registry:${name}`, result: ok ? "MATCH" : "MISS", detail, tier: l.confidence, fetched_at: new Date().toISOString() };
    results.push(line);
    console.log(`${line.basedagents_id} | ${line.url} | ${line.result} | ${line.detail.slice(0, 90)}`);
    await sleep(600);
    continue;
  }

  const r = await fetchOne(target);
  const low = (r.text || "").toLowerCase();
  let result, detail;
  if (r.http === 429) { result = "BLOCKED"; detail = `HTTP 429 (host anti-bot challenge / rate limit) — not judged`; }
  else if (!r.ok && r.http !== "err") { result = "UNREACHABLE"; detail = `HTTP ${r.http} on the external_id URL`; }
  else if (r.http === "err") { result = "UNREACHABLE"; detail = `fetch error: ${r.err}`; }
  else if (low.includes(l.basedagents_id.toLowerCase())) { result = "MATCH"; detail = "external_id page contains the exact BasedAgents agent id"; }
  else if (wallet && low.includes(wallet)) { result = "MATCH"; detail = "external_id page contains the profile wallet address"; }
  else if (r.text && r.text.length < 1200) { result = "WEAK-ONLY"; detail = `page reachable but only ${r.text.length} bytes and no id/wallet (one-way profile link)`; }
  else { result = "MISS"; detail = "page reachable, no agent id or wallet found in the fetched body"; }

  const line = { basedagents_id: l.basedagents_id, url: target, result, detail, tier: l.confidence, http: r.http, bytes: (r.text || "").length, fetched_at: r.fetched_at };
  results.push(line);
  console.log(`${line.basedagents_id} | ${line.url.slice(0, 72)} | ${line.result} | HTTP ${r.http} ${r.bytes}B | ${detail.slice(0, 70)}`);
  await sleep(700);
}

const judged = results.filter((r) => r.result === "MATCH" || r.result === "MISS" || r.result === "WEAK-ONLY");
const hard = judged.filter((r) => r.tier === "verified" || r.tier === "strong");
const hardOk = hard.filter((r) => r.result === "MATCH").length;
const summary = {
  sampled: results.length,
  judged: judged.length,
  match: results.filter((r) => r.result === "MATCH").length,
  weak_only: results.filter((r) => r.result === "WEAK-ONLY").length,
  miss: results.filter((r) => r.result === "MISS").length,
  unreachable_or_blocked: results.filter((r) => r.result === "UNREACHABLE" || r.result === "BLOCKED").length,
  hard_tier_judged: hard.length,
  hard_tier_match: hardOk,
  precision_all_judged: judged.length ? +(100 * results.filter((r) => r.result === "MATCH").length / judged.length).toFixed(1) : null,
  precision_hard_tier: hard.length ? +(100 * hardOk / hard.length).toFixed(1) : null,
  generated_at: new Date().toISOString(),
};
writeFileSync(`${OUT}/audit20.json`, JSON.stringify({ summary, lines: results }, null, 2));
console.log("\n=== AUDIT SUMMARY ===\n" + JSON.stringify(summary, null, 2));