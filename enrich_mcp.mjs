// enrich_mcp.mjs — extra recall pass: match MCP Registry entries by HOST, not by name.
//
// A registry entry whose url / repository host equals the agent's own homepage host is a
// unique hard identifier (same deployment), so it is a legitimate "strong" link even when
// the server name differs from the profile name. Runs only for agents that have no
// verified/strong row yet, one registry query per agent, results cached.
//
// Usage: node enrich_mcp.mjs     (writes linkage_out/links_enriched.json)

import { readFileSync, writeFileSync } from "node:fs";

const API = "https://api.basedagents.ai/v1";
const MCP = "https://registry.modelcontextprotocol.io/v0/servers";
const OUT = "linkage_out";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; research-linker/2.0 enrich)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agents = JSON.parse(readFileSync(`${OUT}/agents.json`, "utf8"));
const existing = JSON.parse(readFileSync(`${OUT}/links.json`, "utf8"));
const enriched = JSON.parse(readFileSync(`${OUT}/links_enriched.json`, "utf8"));

const hasHard = new Set(existing.filter((l) => l.confidence !== "weak").map((l) => l.basedagents_id));
const seen = new Set([...existing, ...enriched].map((l) => l.basedagents_id + "|" + l.external_registry + "|" + l.external_id));

const hostOf = (u) => { try { return new URL(u).host.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const tokenOf = (u) => {
  // distinctive token to search the registry with: repo/org segment or the host label
  try {
    const path = new URL(u).pathname.split("/").filter(Boolean);
    if (path.length) return path[0];
    const h = new URL(u).host.replace(/^www\./, "");
    return h.split(".")[0];
  } catch { return null; }
};

// how many profiles share each homepage host (shared host = not a unique identifier)
const hostUse = new Map();
for (const a of agents) {
  for (const k of ["homepage", "organization_url", "contact_endpoint"]) {
    const h = a[k] ? hostOf(a[k]) : null;
    if (h) hostUse.set(h, (hostUse.get(h) || 0) + 1);
  }
}

const targets = agents.filter((a) => !hasHard.has(a.agent_id));
console.error(`enrich targets: ${targets.length}`);

let idx = 0;
const CONC = 6;
async function worker() {
  while (idx < targets.length) {
    const a = targets[idx++];
    const urls = [a.homepage, a.organization_url, a.contact_endpoint].filter((u) => u && /^https?:\/\//.test(u));
    const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
    const tokens = [...new Set(urls.map(tokenOf).filter((t) => t && t.length >= 4))];
    for (const tok of tokens.slice(0, 2)) {
      let d;
      try {
        const r = await fetch(`${MCP}?search=${encodeURIComponent(tok)}&limit=20`, { headers: UA, signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        d = await r.json();
      } catch { continue; }
      for (const s of d.servers || []) {
        const srv = s.server || s;
        const repoMeta = (srv._meta || {})["io.modelcontextprotocol.registry/official"] || {};
        const cand = [srv.url, repoMeta.repository && repoMeta.repository.url, repoMeta.source, srv.websiteUrl].filter(Boolean);
        const candHosts = cand.map((c) => {
          const h = hostOf(c);
          return h ? h.replace(/^www\./, "") : (c || "").toLowerCase();
        });
        const hit = candHosts.find((h) => hosts.includes(h));
        if (!hit) continue;
        const shared = hostUse.get(hit) || 1;
        const idKey = a.agent_id + "|mcp-registry|" + hit;
        if (seen.has(idKey)) continue;
        seen.add(idKey);
        // shared host across many profiles = not unique -> name/host rule only
        const tier = shared === 1 ? "strong" : "weak";
        enriched.push({
          basedagents_id: a.agent_id, agent_name: a.name,
          external_registry: "mcp-registry",
          external_id: `https://${hit}`,
          evidence: [{
            type: tier === "strong" ? "unique-hard-identifier" : "name-similarity",
            detail: tier === "strong"
              ? `MCP Registry entry (${srv.name}) is served from the same host as the profile homepage (${hit}); the host serves exactly one profile`
              : `MCP Registry entry (${srv.name}) shares host ${hit} with ${shared} profiles — not a unique identifier, name/host rule only`,
          }],
          confidence: tier,
        });
      }
      await sleep(350);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
writeFileSync(`${OUT}/links_enriched.json`, JSON.stringify(enriched, null, 1));
const byTier = enriched.reduce((m, l) => (m[l.confidence] = (m[l.confidence] || 0) + 1, m), {});
console.error(`enriched rows: ${enriched.length} | by tier: ${JSON.stringify(byTier)}`);