// linker.mjs — Link BasedAgents agent profiles across public registries by verifiable evidence.
// Reproducible run: node linker.mjs   (append-only, read-only, polite pacing)
// Sources: BasedAgents public API (/v1/agents/search), each agent's own homepage,
//          /.well-known/x402 manifests, GitHub public user API.
// Evidence tiers (per task acceptance):
//   verified — bidirectional: the agent's homepage (listed in its own profile) references the
//              exact BasedAgents agent id.
//   strong   — a unique hard identifier matches: wallet address (0x…) found on the linked
//              surface, or x402 manifest payTo == profile wallet, or GitHub bio carries id/wallet.
//   weak     — name-similarity only (labeled, never mixed upward).

import { writeFileSync, existsSync, readFileSync } from "node:fs";

const API = "https://api.basedagents.ai/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 (compatible; research-linker/1.0)" };

async function getJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(3000); continue; }
      if (!r.ok) return { __http: r.status };
      return await r.json();
    } catch (e) { if (i === tries - 1) return { __err: String(e).slice(0, 80) }; await sleep(1500); }
  }
  return { __err: "retries-exhausted" };
}

async function getText(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { __http: r.status };
      const t = await r.text();
      return { text: t.slice(0, 400000), finalUrl: r.url };
    } catch (e) { if (i === tries - 1) return { __err: String(e).slice(0, 80) }; await sleep(1000); }
  }
  return { __err: "retries-exhausted" };
}

// ---------- 1. enumerate agents ----------
async function enumerate() {
  const all = [];
  let page = 1, totalPages = 1;
  do {
    const d = await getJSON(`${API}/agents/search?limit=100&page=${page}`);
    if (d.__http || d.__err) { console.error("enumerate stop", page, d.__http || d.__err); break; }
    all.push(...d.agents);
    totalPages = d.pagination?.total_pages ?? 1;
    console.error(`enum page ${page}/${totalPages} (+${d.agents.length})`);
    page++;
    await sleep(1100);
  } while (page <= totalPages);
  return all;
}

// ---------- 2. evidence probes for one agent ----------
function hostOf(u) { try { return new URL(u).host; } catch { return null; } }

async function probe(agent) {
  const ev = [];
  const id = agent.agent_id;
  const wallet = (agent.wallet_address || "").toLowerCase() || null;
  const surfaces = [];
  for (const k of ["homepage", "organization_url", "contact_endpoint"]) {
    const u = agent[k];
    if (u && /^https?:\/\//.test(u) && !surfaces.some((s) => s.url === u)) surfaces.push({ kind: k, url: u });
  }
  // weak-only signal candidates
  let weak = null;
  if (!surfaces.length && (agent.name || agent.x_handle)) weak = { type: "name-similarity", detail: "no external surface in profile; name alone is not evidence" };

  for (const s of surfaces) {
    const host = hostOf(s.url);
    const isGitHub = /(^|\.)github\.com$/i.test(host || "");
    if (isGitHub) {
      const user = s.url.replace(/\/+$/, "").split("/").pop();
      const gh = await getJSON(`https://api.github.com/users/${encodeURIComponent(user)}`);
      if (!gh.__http && !gh.__err) {
        const blob = JSON.stringify({ bio: gh.bio, blog: gh.blog, name: gh.name, company: gh.company });
        if (blob.toLowerCase().includes(id.toLowerCase())) ev.push({ external_registry: "github", external_id: user, evidence: [{ type: "bidirectional-id", detail: `github.com/${user} profile (bio/blog/company) references the BasedAgents agent id` }], confidence: "verified" });
        else if (wallet && blob.toLowerCase().includes(wallet)) ev.push({ external_registry: "github", external_id: user, evidence: [{ type: "wallet-address", detail: `github.com/${user} profile contains the profile wallet address` }], confidence: "strong" });
        else ev.push({ external_registry: "github", external_id: user, evidence: [{ type: "profile-link", detail: "profile listed in BasedAgents profile; no hard identifier on GitHub side" }], confidence: "weak" });
      }
      await sleep(1200); // GitHub API politeness (60/hr unauthenticated — keep sparse)
      continue;
    }
    // fetch homepage
    const h = await getText(s.url);
    if (h.text) {
      const low = h.text.toLowerCase();
      if (low.includes(id.toLowerCase())) ev.push({ external_registry: host, external_id: s.url, evidence: [{ type: "bidirectional-id", detail: `${s.kind} page references the exact BasedAgents agent id ${id}` }], confidence: "verified" });
      else if (wallet && low.includes(wallet)) ev.push({ external_registry: host, external_id: s.url, evidence: [{ type: "wallet-address", detail: `${s.kind} page contains the profile wallet address ${wallet}` }], confidence: "strong" });
      else {
        // x402 manifest payTo check
        const m = await getJSON(`https://${host}/.well-known/x402`);
        if (!m.__http && !m.__err) {
          const ms = JSON.stringify(m).toLowerCase();
          if (wallet && ms.includes(wallet)) ev.push({ external_registry: host, external_id: `${host}/.well-known/x402`, evidence: [{ type: "x402-payto", detail: `x402 manifest payTo matches profile wallet ${wallet}` }], confidence: "strong" });
        }
        if (!ev.length) ev.push({ external_registry: host, external_id: s.url, evidence: [{ type: "profile-link", detail: "surface live but carries no agent id or wallet (one-way link only)" }], confidence: "weak" });
      }
    }
    await sleep(900);
  }
  if (!ev.length && weak) ev.push({ external_registry: "(none)", external_id: agent.name, evidence: [weak], confidence: "weak" });
  return ev;
}

// ---------- 3. main ----------
const OUT = "linkage_out";
const agentsFile = `${OUT}/agents.json`;
let agents;
if (existsSync(agentsFile)) {
  agents = JSON.parse(readFileSync(agentsFile, "utf8"));
  console.error(`loaded ${agents.length} agents from cache`);
} else {
  agents = await enumerate();
  writeFileSync(agentsFile, JSON.stringify(agents));
}

const linksFile = `${OUT}/links.json`;
const done = new Map();
if (existsSync(linksFile)) for (const l of JSON.parse(readFileSync(linksFile, "utf8"))) done.set(l.basedagents_id, l);

const targets = agents.filter((a) => !done.has(a.agent_id));
console.error(`to probe: ${targets.length}`);
const CONC = 6;
let idx = 0, results = [...done.values()];
async function worker() {
  while (idx < targets.length) {
    const a = targets[idx++];
    let links = [];
    try { links = await probe(a); } catch (e) { console.error("probe fail", a.agent_id, e); }
    for (const l of links) results.push({ basedagents_id: a.agent_id, agent_name: a.name, ...l });
    done.set(a.agent_id, true);
    if (results.length % 20 === 0) writeFileSync(linksFile, JSON.stringify(results));
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
writeFileSync(linksFile, JSON.stringify(results));
console.error(`links: ${results.length}`);
