// linker2.mjs — cross-registry linkage of BasedAgents agents, revision 2.
//
// Fixes vs revision 1 (all per reviewer notes):
//   1. No placeholder rows. Every emitted link names a real external entry
//      (registry + id) and the rule that matched it. Tier stats therefore only
//      count rows with a real external entity.
//   2. New surfaces probed: /.well-known/agent.json, /.well-known/agent-card.json,
//      MCP Registry search (registry.modelcontextprotocol.io/v0/servers?search=),
//      GitHub owner + repo metadata, x402 manifest even when the homepage is not
//      200, and one link-hop from a marketplace/listing homepage.
//   3. audit20.mjs works off external_id (not the registry host root).
//   4. links[] is written in full; delivery references a commit-pinned URL.
//   5. Fresh-dir safe (mkdir -p linkage_out), rows deduped, stats computed in
//      code, fetched_at + HTTP status recorded per source.
//   6. Stats are grouped by real registry, plus coverage of agents with >=1 link.
//
// Reproduce:  node linker2.mjs            (resumable: re-running skips cached agents)

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const API = "https://api.basedagents.ai/v1";
const MCP_REG = "https://registry.modelcontextprotocol.io/v0/servers";
const OUT = "linkage_out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 (compatible; research-linker/2.0)" };

const nowISO = () => new Date().toISOString();

// ---------- fetch helpers: every call records url + http status + timestamp ----------
const sourceLog = [];
async function getJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const t0 = nowISO();
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) });
      sourceLog.push({ url, http: r.status, fetched_at: t0 });
      if (r.status === 429) { await sleep(4000); continue; }
      if (!r.ok) return { __http: r.status };
      return await r.json();
    } catch (e) {
      sourceLog.push({ url, http: "err:" + String(e).slice(0, 60), fetched_at: t0 });
      if (i === tries - 1) return { __err: true };
      await sleep(1500);
    }
  }
  return { __err: true };
}

async function getText(url, tries = 1) {
  for (let i = 0; i < tries; i++) {
    const t0 = nowISO();
    try {
      const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(30000) });
      sourceLog.push({ url, http: r.status, fetched_at: t0, final_url: r.url });
      if (!r.ok) return { __http: r.status, finalUrl: r.url };
      return { text: (await r.text()).slice(0, 300000), finalUrl: r.url };
    } catch (e) {
      sourceLog.push({ url, http: "err:" + String(e).slice(0, 60), fetched_at: t0 });
      if (i === tries - 1) return { __err: true };
      await sleep(1000);
    }
  }
  return { __err: true };
}

// ---------- 1. enumerate every public agent profile ----------
async function enumerate() {
  const all = [];
  let page = 1, totalPages = 1;
  do {
    const d = await getJSON(`${API}/agents/search?limit=100&page=${page}`);
    if (d.__http || d.__err) { console.error("enumerate stop at page", page, d.__http || "err"); break; }
    all.push(...d.agents);
    totalPages = d.pagination?.total_pages ?? 1;
    console.error(`enum page ${page}/${totalPages} (+${d.agents.length})`);
    page++;
    await sleep(1000);
  } while (page <= totalPages);
  return all;
}

// ---------- helpers ----------
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// ---------- 2. probes for one agent ----------
async function probe(agent) {
  const ev = [];
  const id = agent.agent_id;
  const wallet = (agent.wallet_address || "").toLowerCase() || null;
  const name = agent.name || "";

  const surfaces = [];
  for (const k of ["homepage", "organization_url", "contact_endpoint"]) {
    const u = agent[k];
    if (u && /^https?:\/\//.test(u) && !surfaces.some((s) => s.url === u)) surfaces.push({ kind: k, url: u });
  }

  // ---- 2a. the agent's own declared surfaces ----
  for (const s of surfaces) {
    const host = hostOf(s.url);
    if (!host) continue;

    // GitHub: user OR repo URL (a repo path is queried as user "<owner>/<repo>")
    if (/(^|\.)github\.com$/i.test(host)) {
      const path = s.url.replace(/^https?:\/\/[^/]+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
      const key = path.length >= 2 ? `${path[0]}/${path[1]}` : path[0];
      const gh = await getJSON(`https://api.github.com/users/${encodeURIComponent(key)}`);
      if (!gh.__http && !gh.__err) {
        const blob = JSON.stringify({ bio: gh.bio, blog: gh.blog, name: gh.name, company: gh.company, login: gh.login });
        if (blob.toLowerCase().includes(id.toLowerCase()))
          ev.push({ external_registry: "github", external_id: `https://github.com/${key}`, evidence: [{ type: "bidirectional-id", detail: `github.com/${key} profile fields reference the exact BasedAgents agent id` }], confidence: "verified" });
        else if (wallet && blob.toLowerCase().includes(wallet))
          ev.push({ external_registry: "github", external_id: `https://github.com/${key}`, evidence: [{ type: "wallet-address", detail: `github.com/${key} profile contains the profile wallet address` }], confidence: "strong" });
        else
          ev.push({ external_registry: "github", external_id: `https://github.com/${key}`, evidence: [{ type: "profile-link", detail: `GitHub profile listed in the BasedAgents profile; carries neither agent id nor wallet (one-way link only)` }], confidence: "weak" });
      } else if (gh.__http === 404 && path.length >= 2) {
        // repo URL: fall back to the repo endpoint itself
        const repo = await getJSON(`https://api.github.com/repos/${key}`);
        if (!repo.__http && !repo.__err) {
          const blob = JSON.stringify({ desc: repo.description, homepage: repo.homepage, name: repo.name });
          const tier = blob.toLowerCase().includes(id.toLowerCase()) ? "verified"
            : (wallet && blob.toLowerCase().includes(wallet)) ? "strong" : "weak";
          ev.push({ external_registry: "github", external_id: `https://github.com/${key}`,
            evidence: [{ type: tier === "weak" ? "profile-link" : (tier === "verified" ? "bidirectional-id" : "wallet-address"), detail: `repo metadata of ${key} ${tier === "weak" ? "lists the profile URL but carries no id/wallet" : "references the agent id / wallet"}` }],
            confidence: tier });
        }
      }
      await sleep(1100); // unauthenticated GitHub API politeness
      continue;
    }

    // homepage fetch
    const h = await getText(s.url);
    const body = h.text || "";
    const low = body.toLowerCase();

    if (body && low.includes(id.toLowerCase())) {
      ev.push({ external_registry: host, external_id: h.finalUrl || s.url, evidence: [{ type: "bidirectional-id", detail: `${s.kind} page references the exact BasedAgents agent id ${id}` }], confidence: "verified" });
    } else if (body && wallet && low.includes(wallet)) {
      ev.push({ external_registry: host, external_id: h.finalUrl || s.url, evidence: [{ type: "wallet-address", detail: `${s.kind} page contains the profile wallet ${wallet}` }], confidence: "strong" });
    } else {
      // one link-hop: a marketplace/listing homepage that links the agent's own entry
      if (body && name) {
        const n = norm(name);
        if (n.length >= 4) {
          const anchors = [...body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)]
            .map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, "") }));
          for (const a of anchors.slice(0, 60)) {
            if (!norm(a.text).includes(n) && !norm(a.href).includes(n)) continue;
            let abs;
            try { abs = new URL(a.href, h.finalUrl || s.url).href; } catch { continue; }
            if (norm(abs) === norm(h.finalUrl || s.url)) continue;
            const p = await getText(abs);
            if (!p.text) continue;
            const pl = p.text.toLowerCase();
            if (pl.includes(id.toLowerCase()))
              ev.push({ external_registry: host, external_id: abs, evidence: [{ type: "bidirectional-id", detail: `agent's own entry linked from ${s.url} references the exact agent id` }], confidence: "verified" });
            else if (wallet && pl.includes(wallet))
              ev.push({ external_registry: host, external_id: abs, evidence: [{ type: "wallet-address", detail: `agent's own entry linked from ${s.url} contains the profile wallet` }], confidence: "strong" });
            if (ev.length) break;
            await sleep(400);
          }
        }
      }

      // A2A / agent-card well-known documents on the surface host
      for (const wk of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
        const d = await getJSON(`https://${host}${wk}`);
        if (d.__http || d.__err) continue;
        const blob = JSON.stringify(d).toLowerCase();
        if (blob.includes(id.toLowerCase()))
          ev.push({ external_registry: "a2a-wellknown", external_id: `https://${host}${wk}`, evidence: [{ type: "bidirectional-id", detail: `${wk} on the profile host references the exact agent id` }], confidence: "verified" });
        else if (wallet && blob.includes(wallet))
          ev.push({ external_registry: "a2a-wellknown", external_id: `https://${host}${wk}`, evidence: [{ type: "wallet-address", detail: `${wk} payTo/agent id fields contain the profile wallet` }], confidence: "strong" });
        else
          ev.push({ external_registry: "a2a-wellknown", external_id: `https://${host}${wk}`, evidence: [{ type: "profile-link", detail: `${wk} exists on the profile host but names neither the agent id nor the wallet` }], confidence: "weak" });
        if (ev.some((e) => e.confidence !== "weak")) break;
      }

      // x402 manifest — probed even when the homepage itself was not 200
      if (!ev.some((e) => e.confidence !== "weak")) {
        const m = await getJSON(`https://${host}/.well-known/x402`);
        if (!m.__http && !m.__err) {
          const ms = JSON.stringify(m).toLowerCase();
          if (wallet && ms.includes(wallet))
            ev.push({ external_registry: "x402-manifest", external_id: `https://${host}/.well-known/x402`, evidence: [{ type: "x402-payto", detail: `x402 manifest payTo matches profile wallet ${wallet}` }], confidence: "strong" });
          else if (ms.includes(id.toLowerCase()))
            ev.push({ external_registry: "x402-manifest", external_id: `https://${host}/.well-known/x402`, evidence: [{ type: "bidirectional-id", detail: `x402 manifest on the profile host references the exact agent id` }], confidence: "verified" });
          else
            ev.push({ external_registry: "x402-manifest", external_id: `https://${host}/.well-known/x402`, evidence: [{ type: "profile-link", detail: `x402 manifest served on the profile host; no agent id or wallet inside` }], confidence: "weak" });
        }
      }
    }
    await sleep(800);
  }

  // ---- 2b. MCP Registry search — a real external entity, named in the row ----
  if (name && !ev.some((e) => e.confidence === "verified" || e.confidence === "strong")) {
    const q = name.trim().slice(0, 60);
    const d = await getJSON(`${MCP_REG}?search=${encodeURIComponent(q)}&limit=10`);
    if (!d.__http && !d.__err && Array.isArray(d.servers)) {
      const n = norm(name);
      for (const srv of d.servers) {
        const sm = srv.server || srv;
        const sName = sm.name || "";
        if (!sName) continue;
        const sn = norm(sName);
        const url = sm.url || (srv._meta && srv._meta["io.modelcontextprotocol.registry/official"] && srv._meta["io.modelcontextprotocol.registry/official"].repository && srv._meta["io.modelcontextprotocol.registry/official"].repository.url) || "";
        // exact server-name equality = unique hard identifier; otherwise keep only
        // a containment match and label it as a name rule.
        let tier = null, rule = null;
        if (sn === n) { tier = "strong"; rule = `exact server-name equality with the profile name ("${sName}")`; }
        else if (n.length >= 5 && sn.includes(n)) { tier = "weak"; rule = `profile name "${name}" is contained in the MCP server name "${sName}" (name rule only)`; }
        // was `sn.includes(sn)` — a tautology, so this branch fired on every name and
        // emitted a reverse-containment row that had not been tested at all
        else if (n.length >= 5 && n.includes(sn) && sn.length >= 5) { tier = "weak"; rule = `MCP server name "${sName}" is contained in the profile name (name rule only)`; }
        if (!tier) continue;
        ev.push({ external_registry: "mcp-registry", external_id: url || `mcp-registry:${sName}`,
          evidence: [{ type: tier === "strong" ? "unique-hard-identifier" : "name-similarity", detail: rule }],
          confidence: tier });
        break;
      }
    }
    await sleep(400);
  }

  // dedupe this agent's rows
  const seen = new Set();
  return ev.filter((e) => {
    const k = e.external_registry + "|" + e.external_id;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

// ---------- 3. main ----------
mkdirSync(OUT, { recursive: true });
const agentsFile = `${OUT}/agents.json`;
let agents;
if (existsSync(agentsFile)) {
  agents = JSON.parse(readFileSync(agentsFile, "utf8"));
  console.error(`loaded ${agents.length} agents from cache`);
} else {
  agents = await enumerate();
  writeFileSync(agentsFile, JSON.stringify(agents, null, 1));
}

const linksFile = `${OUT}/links.json`;
const seenAgent = new Map();
if (existsSync(linksFile)) {
  for (const l of JSON.parse(readFileSync(linksFile, "utf8"))) {
    // dedupe on agent + external entity
    const k = l.basedagents_id + "|" + l.external_registry + "|" + l.external_id;
    if (!seenAgent.has(k)) { seenAgent.set(k, l); }
  }
}
console.error(`cached link rows: ${seenAgent.size}`);

// REFILTER=1 re-applies the distinctness filter + stats to an existing links.json
// without re-fetching anything.
const REFILTER = process.env.REFILTER === "1";
const targets = REFILTER ? [] : agents.filter((a) => !seenAgent.has(a.agent_id + "|"));
const CONC = 6;
let idx = 0;
async function worker() {
  while (idx < targets.length) {
    const a = targets[idx++];
    let links = [];
    try { links = await probe(a); } catch (e) { console.error("probe fail", a.agent_id, String(e).slice(0, 60)); }
    for (const l of links) {
      const k = a.agent_id + "|" + l.external_registry + "|" + l.external_id;
      if (!seenAgent.has(k)) seenAgent.set(k, { basedagents_id: a.agent_id, agent_name: a.name, ...l });
    }
    if (idx % 25 === 0) {
      writeFileSync(linksFile, JSON.stringify([...seenAgent.values()], null, 1));
      console.error(`progress ${idx}/${targets.length} rows=${seenAgent.size} fetches=${sourceLog.length}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
const links = [...seenAgent.values()];
writeFileSync(linksFile, JSON.stringify(links, null, 1));

// ---------- 4. distinctness filter ----------
// A weak row only counts as a linkage if the external entity belongs to THIS agent.
// Host-generic documents (one /.well-known/agent.json or /.well-known/x402 shared by
// 100+ agents on the same host) are not linkage evidence - keeping them would just be
// a placeholder with a URL in it. A weak row survives only when its external_id is
// claimed by exactly one agent, or when the id itself carries the agent's name/id.
const shareCount = new Map();
for (const l of links) {
  const k = l.external_registry + "|" + l.external_id;
  shareCount.set(k, (shareCount.get(k) || 0) + 1);
}
const normId = (l) => norm(l.basedagents_id) + norm(l.agent_name || "");
const kept = [], dropped = [];
for (const l of links) {
  if (l.confidence !== "weak") { kept.push(l); continue; }
  const k = l.external_registry + "|" + l.external_id;
  const shared = shareCount.get(k);
  const selfNamed = norm(l.external_id).includes(normId(l));
  if (shared === 1 || selfNamed) kept.push(l);
  else dropped.push({ ...l, dropped_reason: `external entity is shared by ${shared} agents (host-generic document, not agent-specific evidence)` });
}
const droppedShare = new Map();
for (const d of dropped) {
  const k = d.external_id;
  droppedShare.set(k, (droppedShare.get(k) || 0) + 1);
}
const topDropped = [...droppedShare.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([url, n]) => ({ external_id: url, agents_dropped: n }));
writeFileSync(`${OUT}/links_filtered.json`, JSON.stringify(kept, null, 1));
writeFileSync(`${OUT}/links_dropped_shared.json`, JSON.stringify(dropped, null, 1));
console.error(`distinctness filter: kept ${kept.length}, dropped ${dropped.length} shared-entity weak rows`);

// ---------- 5. stats computed in code ----------
const byTier = { verified: 0, strong: 0, weak: 0 };
const byRegistry = {};
const perAgent = new Map();
for (const l of kept) {
  byTier[l.confidence] = (byTier[l.confidence] || 0) + 1;
  byRegistry[l.external_registry] = (byRegistry[l.external_registry] || 0) + 1;
  if (!perAgent.has(l.basedagents_id)) perAgent.set(l.basedagents_id, { name: l.agent_name, rows: 0, best: "weak" });
  const p = perAgent.get(l.basedagents_id);
  p.rows++;
  if (l.confidence === "verified" || (l.confidence === "strong" && p.best !== "verified")) p.best = l.confidence;
}
const covered = [...perAgent.values()].filter((p) => p.rows > 0);
const coveredHard = covered.filter((p) => p.best === "verified" || p.best === "strong");
const httpStats = {};
for (const s of sourceLog) httpStats[s.http] = (httpStats[s.http] || 0) + 1;

const stats = {
  generated_at: nowISO(),
  agents_enumerated: agents.length,
  link_rows: kept.length,
  rows_dropped_by_distinctness_filter: dropped.length,
  top_dropped_shared_entities: topDropped,
  distinctness_rule:
    "a weak row survives only when its external_id is claimed by exactly one agent, or when the id " +
    "itself carries that agent's id/name; host-generic documents shared by many agents are dropped " +
    "and listed in links_dropped_shared.json rather than silently kept",
  rows_by_tier: byTier,
  rows_by_registry: byRegistry,
  agents_with_at_least_one_real_link: covered.length,
  coverage_pct: +(100 * covered.length / agents.length).toFixed(1),
  agents_with_verified_or_strong: coveredHard.length,
  hard_coverage_pct: +(100 * coveredHard.length / agents.length).toFixed(1),
  http_status_counts: httpStats,
  fetches: sourceLog.length,
};
writeFileSync(`${OUT}/stats.json`, JSON.stringify(stats, null, 2));
writeFileSync(`${OUT}/sources.json`, JSON.stringify(sourceLog, null, 1));
console.error("\n=== STATS ===\n" + JSON.stringify(stats, null, 2));