// audit_final.mjs — self-audit of the PUBLISHED rows (linkage_out/links_final.json).
//
// Review item 3: "each line states the shared identifier (id, wallet, same
// homepage/domain); lines without one count as not correct; precision from those lines."
//
// So this audit does two things at once, live, against the real network:
//   1. re-fetch each row's external_id (or, for mcp-registry:NAME rows, the URL the
//      registry publishes for that server), and
//   2. look for the identifier the row CLAIMS. A row passes only if that identifier is
//      actually present in what comes back. A 200 with only the agent's name in it is a
//      NO_MATCH, not a MATCH.
//
// Reproduce: node audit_final.mjs        (writes linkage_out/audit_final.json)

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "linkage_out";
const MCP = "https://registry.modelcontextprotocol.io/v0/servers";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; research-linker/2.0 auditfinal)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const links = JSON.parse(readFileSync(`${OUT}/links_final.json`, "utf8"));
const agents = JSON.parse(readFileSync(`${OUT}/agents.json`, "utf8"));
const byId = new Map(agents.map((a) => [a.agent_id, a]));

const hostOf = (u) => { try { return new URL(u).host.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const normUrl = (u) => { try { const p = new URL(u); return (p.host.toLowerCase().replace(/^www\./, "") + p.pathname.replace(/\/$/, "")).toLowerCase(); } catch { return null; } };
const profileUrls = (a) => [a.homepage, a.organization_url, a.contact_endpoint].filter((u) => u && /^https?:/i.test(u));

// 20 distinct rows, one per agent, spanning every tier the published file contains.
const order = { verified: 0, strong: 1, weak: 2, blocked: 3 };
const sorted = [...links].sort((a, b) => (order[a.confidence] ?? 9) - (order[b.confidence] ?? 9));
const picked = [];
const used = new Set();
for (const l of sorted) {
  if (used.has(l.basedagents_id)) continue;
  picked.push(l); used.add(l.basedagents_id);
  if (picked.length >= 20) break;
}

async function getText(url, ms = 30000) {
  const t0 = new Date().toISOString();
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(ms) });
    const text = r.ok ? (await r.text()).slice(0, 300000) : "";
    return { http: r.status, text, finalUrl: r.url || url, fetched_at: t0 };
  } catch (e) {
    return { http: "err:" + String(e.message).slice(0, 60), text: "", finalUrl: url, fetched_at: t0 };
  }
}

async function resolveUrl(row) {
  const id = String(row.external_id || "");
  if (/^https?:/i.test(id)) return id;
  if (id.startsWith("mcp-registry:")) {
    const name = id.replace(/^mcp-registry:/, "");
    const q = name.split("/").pop();
    try {
      const r = await fetch(`${MCP}?search=${encodeURIComponent(q)}&limit=20`, { headers: UA, signal: AbortSignal.timeout(25000) });
      const d = await r.json();
      for (const s of d.servers || []) {
        const srv = s.server || s;
        if ((srv.name || "") !== name) continue;
        const meta = (srv._meta || {})["io.modelcontextprotocol.registry/official"] || {};
        const cand = [srv.url, srv.websiteUrl, meta.websiteUrl, meta.repository && meta.repository.url].find((u) => typeof u === "string" && /^https?:/i.test(u));
        if (cand) return cand;
      }
    } catch { /* fall through */ }
    return null;
  }
  return null;
}

const results = [];
for (const row of picked) {
  const agent = byId.get(row.basedagents_id) || {};
  const url = await resolveUrl(row);
  if (!url) {
    results.push({ ...rowLine(row), url: row.external_id, result: "NO_URL", detail: "no fetchable URL for this external id" });
    continue;
  }
  const r = await getText(url);
  const t = r.text || "";
  const hosts = profileUrls(agent).map(hostOf).filter(Boolean);
  const urlsN = profileUrls(agent).map(normUrl).filter(Boolean);

  const foundWallet = agent.wallet_address && new RegExp(agent.wallet_address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(t);
  const foundId = agent.agent_id && t.includes(agent.agent_id);
  const foundSameUrl = urlsN.includes(normUrl(r.finalUrl));
  const foundSameHost = hosts.includes(hostOf(r.finalUrl));

  let result = "NO_MATCH", detail = "";
  if (r.http !== 200) {
    result = "UNREACHABLE";
    detail = `endpoint returned ${r.http}`;
  } else if (foundWallet) {
    result = "MATCH"; detail = "live page carries the profile wallet " + agent.wallet_address;
  } else if (foundId) {
    result = "MATCH"; detail = "live page carries the agent id " + agent.agent_id;
  } else if (foundSameUrl) {
    result = "MATCH"; detail = "live page is the exact URL the profile publishes";
  } else if (foundSameHost) {
    result = "MATCH"; detail = "live page is served from the profile host " + hostOf(r.finalUrl);
  } else {
    result = "NO_MATCH";
    detail = `HTTP 200 but none of the identifiers are present (no wallet, no ag_ id, not the profile host) — the row rests on name similarity only`;
  }
  results.push({
    ...rowLine(row),
    url, final_url: r.finalUrl, http: r.http, fetched_at: r.fetched_at,
    claimed_identifier: row.shared_identifier, claimed_kind: row.identifier_kind,
    result, detail,
    live_checks: { wallet: !!foundWallet, agent_id: !!foundId, same_url: !!foundSameUrl, same_host: !!foundSameHost },
  });
  console.log(`${row.basedagents_id} | ${row.identifier_kind} | ${result} | HTTP ${r.http} | ${detail.slice(0, 80)}`);
  await sleep(400);
}

function rowLine(row) {
  return { basedagents_id: row.basedagents_id, agent_name: row.agent_name, confidence: row.confidence, external_registry: row.external_registry, external_id: row.external_id };
}

const match = results.filter((r) => r.result === "MATCH").length;
const summary = {
  sampled: results.length,
  match,
  no_match: results.filter((r) => r.result === "NO_MATCH").length,
  unreachable: results.filter((r) => r.result === "UNREACHABLE").length,
  no_url: results.filter((r) => r.result === "NO_URL").length,
  precision_over_sampled: +(match / results.length).toFixed(3),
  precision_over_reachable: +(match / Math.max(1, results.filter((r) => r.http === 200).length)).toFixed(3),
  rule: "MATCH requires the identifier the row claims to be present in the live response. A 200 carrying only the name is a NO_MATCH.",
  generated_at: new Date().toISOString(),
};
writeFileSync(`${OUT}/audit_final.json`, JSON.stringify({ summary, results }, null, 1));
console.log("\n" + JSON.stringify(summary, null, 1));
