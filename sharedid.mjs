// sharedid.mjs — review item 3: every published row must state the SHARED IDENTIFIER
// that ties the BasedAgents profile to the external entity.
//
// A row is "correct" only when one of these is present:
//   wallet     — the external document/service carries the profile's wallet address
//   agent_id   — the external document/service carries the agent's ag_... id
//   same_url   — the external id is exactly one of the profile's own declared URLs
//   same_host  — the external entity is served from the profile's own host
// A row whose only support is "the server name contains the profile name" has NO shared
// identifier and is moved to links_rejected.json. Review item 3: "lines without one
// count as not correct; precision from those lines."
//
// Also applies review item 5 (drop name-only rows for private individuals with no org).
//
// Usage: node sharedid.mjs      (reads linkage_out/links_filtered.json)
// Output: linkage_out/links_final.json, links_rejected.json, precision.json,
//         and appends every fetch it makes to linkage_out/sources.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = "linkage_out";
const MCP = "https://registry.modelcontextprotocol.io/v0/servers";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; research-linker/2.0 sharedid)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const read = (f) => JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
const agents = read("agents.json");
const byId = new Map(agents.map((a) => [a.agent_id, a]));
const rows = read("links_filtered.json");
const sourceLog = read("sources.json");

// every fetch this script makes goes into the same record as the probing run
function logFetch(url, http) {
  sourceLog.push({ url, http: String(http), fetched_at: new Date().toISOString() });
}

const hostOf = (u) => {
  try { return new URL(u).host.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};
const normUrl = (u) => {
  try { const p = new URL(u); return (p.host.toLowerCase().replace(/^www\./, "") + p.pathname.replace(/\/$/, "")).toLowerCase(); } catch { return null; }
};
const profileUrls = (a) => [a.homepage, a.organization_url, a.contact_endpoint]
  .filter((u) => u && /^https?:/i.test(u));
const profileHosts = (a) => [...new Set(profileUrls(a).map(hostOf).filter(Boolean))];

const WALLET = /0x[a-fA-F0-9]{40}/;
const AGID = /ag_[A-Za-z0-9]{10,}/;

// MCP Registry server names are reverse-DNS: "io.agentlot/marketplace" is the namespace
// io.agentlot, which is the domain agentlot.io. When that domain is the profile's own
// host, the namespace IS a shared identifier — this is what rescues the AgentLot row the
// review named in item 4. Generic namespaces (io.github.*) are excluded: github.com hosts
// thousands of unrelated servers and identifies nobody.
function nsDomain(serverName) {
  const ns = String(serverName).split("/")[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(ns)) return null;
  const labels = ns.toLowerCase().split(".");
  if (labels.length < 2) return null;
  if (labels[0] === "io" && labels[1] === "github") return null;
  if (labels[0] === "com" && labels[1] === "github") return null;
  return labels.slice().reverse().join(".");
}

async function getJSON(url, ms = 25000) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
    logFetch(url, r.status);
    const t = await r.text();
    try { return { ok: r.ok, status: r.status, json: JSON.parse(t), text: t }; }
    catch { return { ok: r.ok, status: r.status, json: null, text: t }; }
  } catch (e) {
    logFetch(url, "err:" + e.message);
    return { ok: false, status: 0, json: null, text: "", err: String(e.message) };
  }
}

// Candidate URLs an MCP Registry entry publishes for its deployment.
function entryUrls(s) {
  const srv = s.server || s;
  const meta = (srv._meta || {})["io.modelcontextprotocol.registry/official"] || {};
  return [srv.url, srv.websiteUrl, meta.websiteUrl, meta.repository && meta.repository.url, meta.source]
    .filter((u) => typeof u === "string" && /^https?:/i.test(u));
}

// For a row whose only support is name similarity, try to ESTABLISH a shared identifier
// from the registry entry itself (homepage/domain) instead of asserting one.
async function registryIdentifier(serverName, agent) {
  const tail = serverName.split("/").pop();
  const queries = [...new Set([serverName, tail].filter((q) => q && q.length >= 4))];
  const hosts = profileHosts(agent);
  const urls = profileUrls(agent);
  // 60 s: the review measured this registry search at 14-46 s, so 25 s was too short
  for (const q of queries) {
    const d = await getJSON(`${MCP}?search=${encodeURIComponent(q)}&limit=20`, 60000);
    if (!d.json || !Array.isArray(d.json.servers)) continue;
    for (const s of d.json.servers) {
      const srv = s.server || s;
      if ((srv.name || "") !== serverName) continue;
      const blob = JSON.stringify(s);
      const w = blob.match(WALLET);
      const i = blob.match(AGID);
      if (w && agent.wallet_address && w[0].toLowerCase() === agent.wallet_address.toLowerCase()) {
        return { kind: "wallet", sid: "wallet:" + w[0].toLowerCase(), how: `MCP Registry entry for ${serverName} carries the profile wallet ${w[0]}` };
      }
      if (i && i[0] === agent.agent_id) {
        return { kind: "agent_id", sid: "agent_id:" + i[0], how: `MCP Registry entry for ${serverName} carries the agent id ${i[0]}` };
      }
      for (const u of entryUrls(s)) {
        const nh = normUrl(u);
        if (urls.some((p) => normUrl(p) === nh)) {
          return { kind: "same_url", sid: "same_url:" + u, how: `MCP Registry entry for ${serverName} publishes the profile URL ${u}` };
        }
        const h = hostOf(u);
        if (h && hosts.includes(h)) {
          return { kind: "same_host", sid: "same_host:" + h, how: `MCP Registry entry for ${serverName} is served from the profile host ${h}` };
        }
      }
    }
    await sleep(350);
  }
  // last resort: fetch the entry's website and look for the profile wallet in it
  // 60 s: the review measured this registry search at 14-46 s, so 25 s was too short
  for (const q of queries) {
    const d = await getJSON(`${MCP}?search=${encodeURIComponent(q)}&limit=20`, 60000);
    if (!d.json || !Array.isArray(d.json.servers)) continue;
    for (const s of d.json.servers) {
      const srv = s.server || s;
      if ((srv.name || "") !== serverName) continue;
      for (const u of entryUrls(s)) {
        const p = await getJSON(u, 20000);
        if (!p.ok || !p.text) continue;
        const w = p.text.match(WALLET);
        if (w && agent.wallet_address && w[0].toLowerCase() === agent.wallet_address.toLowerCase()) {
          return { kind: "wallet", sid: "wallet:" + w[0].toLowerCase(), how: `page at ${u} (linked from the MCP Registry entry for ${serverName}) carries the profile wallet` };
        }
        const i = p.text.match(AGID);
        if (i && i[0] === agent.agent_id) {
          return { kind: "agent_id", sid: "agent_id:" + i[0], how: `page at ${u} (linked from the MCP Registry entry for ${serverName}) carries the agent id` };
        }
      }
    }
    await sleep(350);
  }
  return null;
}

// Review item 5: name-only rows for private individuals (no org, no URL, no wallet).
const PERSONAL = ["Albert", "Jonah", "niels"];

// Review item 4: rows the code must emit even though my network could not read the
// endpoint. "A failed fetch shown in sources.json also passes for the first two."
// These carry a shared identifier that does NOT depend on the failed read (the endpoint
// sits on the profile's own host), and the failed read is recorded in sources.json.
// They are emitted at confidence "blocked" and are never counted as verified.
const BLOCKED_ROWS = [
  {
    basedagents_id: "ag_GgkR34fNWT1cEjfFxaE1jjVQDhPknNLWWMHYzGshkdun",
    agent_name: "NexusHubLaunchAuditor-20260915",
    external_registry: "x402-manifest",
    external_id: "https://nexushub.nexus/.well-known/x402",
    confidence: "blocked",
    evidence: [{
      type: "probe-blocked",
      detail: "x402 manifest on the profile's own host (nexushub.nexus). Both probe attempts "
        + "(2026-10-12T18:24Z and a re-probe at delivery time) returned HTTP 429 from a "
        + "Vercel rate-limit/challenge page, so I could not read payTo myself; both attempts "
        + "are in sources.json. The reviewer reports 200 with payTo = the profile wallet "
        + "0x79a4f63da692e8f825fbcf084cd2685d8b2e7c9e — cited here as reported, not as confirmed by me.",
    }],
  },
];

const kept = [];
const rejected = [];

// Blocked rows are appended last and are never allowed to claim a wallet/agent-id match,
// because the address in their text is the reviewer's report, not something I read.
const allRows = [...rows, ...BLOCKED_ROWS.map((r) => ({ ...r, __blocked: true }))];

for (const row of allRows) {
  const agent = byId.get(row.basedagents_id) || {};
  const blob = JSON.stringify(row.evidence || []);
  let ident = null;

  const w = row.__blocked ? null : blob.match(WALLET);
  const i = row.__blocked ? null : blob.match(AGID);
  if (w && (!agent.wallet_address || w[0].toLowerCase() === agent.wallet_address.toLowerCase())) {
    ident = { kind: "wallet", sid: "wallet:" + w[0].toLowerCase(), how: "external document carries the profile wallet " + w[0] };
  } else if (i && i[0] === agent.agent_id) {
    ident = { kind: "agent_id", sid: "agent_id:" + i[0], how: "external document carries the agent id " + i[0] };
  } else if (/^https?:/i.test(row.external_id || "")) {
    const nh = normUrl(row.external_id);
    if (profileUrls(agent).some((p) => normUrl(p) === nh)) {
      ident = { kind: "same_url", sid: "same_url:" + row.external_id, how: "the external id is a URL the profile itself publishes" };
    } else if (profileHosts(agent).includes(hostOf(row.external_id))) {
      ident = { kind: "same_host", sid: "same_host:" + hostOf(row.external_id), how: "the external entity is served from the profile host " + hostOf(row.external_id) };
    }
  }

  if (!ident && row.external_registry === "mcp-registry") {
    const name = String(row.external_id || "").replace(/^mcp-registry:/, "");
    if (name) {
      const ns = nsDomain(name);
      if (ns && profileHosts(agent).includes(ns)) {
        ident = {
          kind: "same_host",
          sid: "same_host:" + ns,
          how: `MCP Registry namespace "${name.split("/")[0]}" is reverse-DNS for ${ns}, which is the profile's own host`,
        };
      }
    }
    if (!ident && name) ident = await registryIdentifier(name, agent);
  }

  const out = {
    ...row,
    shared_identifier: ident ? ident.sid : null,
    identifier_kind: ident ? ident.kind : "none",
    identifier_how: ident ? ident.how : null,
    profile_has_org: !!agent.organization,
    profile_has_wallet: !!agent.wallet_address,
  };

  if (ident) { kept.push(out); continue; }

  const personal = PERSONAL.includes(row.agent_name);
  rejected.push({
    ...out,
    rejected_because: personal
      ? "review item 5: private-individual name row (no organisation, no profile URL, no wallet) and no shared identifier"
      : "review item 3: name-similarity only — no shared identifier (no id, no wallet, no shared URL/host), so it counts as not correct",
  });
}

writeFileSync(`${OUT}/links_final.json`, JSON.stringify(kept, null, 1));
writeFileSync(`${OUT}/links_rejected.json`, JSON.stringify(rejected, null, 1));
writeFileSync(`${OUT}/sources.json`, JSON.stringify(sourceLog, null, 1));

const byKind = kept.reduce((m, r) => (m[r.identifier_kind] = (m[r.identifier_kind] || 0) + 1, m), {});
const byTier = kept.reduce((m, r) => (m[r.confidence] = (m[r.confidence] || 0) + 1, m), {});
const blockedKept = kept.filter((r) => r.__blocked).length;
const hard = kept.filter((r) => !r.__blocked && (r.identifier_kind === "wallet" || r.identifier_kind === "agent_id" || r.confidence === "verified")).length;

const precision = {
  computed_at: new Date().toISOString(),
  rule: "review item 3: a line counts as correct only when it states a shared identifier (wallet, agent id, same URL, same host). Lines without one are in links_rejected.json and count as not correct.",
  rows_in: allRows.length,
  rows_from_probe: rows.length,
  rows_injected_blocked: BLOCKED_ROWS.length,
  rows_kept: kept.length,
  rows_kept_blocked: blockedKept,
  rows_rejected: rejected.length,
  kept_by_identifier_kind: byKind,
  kept_by_tier: byTier,
  hard_identifier_rows: hard,
  precision_all_rows: +(kept.length / allRows.length).toFixed(3),
  agents_with_any_kept_row: new Set(kept.map((r) => r.basedagents_id)).size,
  agents_total: agents.length,
  coverage_pct: +((100 * new Set(kept.map((r) => r.basedagents_id)).size) / agents.length).toFixed(2),
};
writeFileSync(`${OUT}/precision.json`, JSON.stringify(precision, null, 2));

console.error(`kept ${kept.length} / rejected ${rejected.length} of ${rows.length}`);
console.error("by identifier kind:", JSON.stringify(byKind));
console.error("by tier:", JSON.stringify(byTier));
console.error("precision (all rows):", precision.precision_all_rows);
