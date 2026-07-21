"use strict";

const $ = (sel) => document.querySelector(sel);
const state = { runId: null, es: null };

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok && res.status !== 409) throw new Error(`${path} -> ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/* ------------------------------- doctor ---------------------------------- */
async function loadDoctor() {
  try {
    const results = await api("/api/doctor");
    const el = $("#doctor");
    el.innerHTML = "";
    for (const r of results) {
      const chip = document.createElement("span");
      chip.className = "chip " + (r.ok ? "ok" : r.required ? "bad" : "warn");
      chip.textContent = (r.ok ? "✓ " : r.required ? "✗ " : "○ ") + r.name;
      chip.title = r.detail + (r.hint && !r.ok ? " — " + r.hint : "");
      el.appendChild(chip);
    }
  } catch (e) {
    console.warn(e);
  }
}

/* ------------------------------- stacks ---------------------------------- */
async function loadStacks() {
  const cfg = await api("/api/stacks");
  const sel = $("#stack");
  sel.innerHTML = "";
  for (const s of cfg.stacks) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.label + (s.hasTemplate ? " ✓" : "");
    if (s.id === cfg.defaultStack) opt.selected = true;
    sel.appendChild(opt);
  }
  const scaleSel = $("#scale");
  scaleSel.innerHTML = "";
  for (const sc of cfg.scales || []) {
    const opt = document.createElement("option");
    opt.value = sc.id;
    opt.textContent = sc.label;
    opt.title = sc.summary || "";
    if (sc.id === cfg.defaultScale) opt.selected = true;
    scaleSel.appendChild(opt);
  }
  const comp = $("#compliance");
  comp.innerHTML = '<span class="compliance-label">Compliance:</span>' +
    (cfg.compliance || [])
      .map((c) => `<label class="chip-cb"><input type="checkbox" class="comp-cb" value="${c.id}"/> ${c.id}</label>`)
      .join("");
  const saas = $("#saas");
  if (saas) {
    saas.innerHTML = '<span class="compliance-label">SaaS layer:</span>' +
      (cfg.saas || [])
        .map((c) => `<label class="chip-cb" title="${escapeHtml(c.label)}"><input type="checkbox" class="saas-cb" value="${c.id}"/> ${c.id}</label>`)
        .join("");
  }
  renderTemplates(cfg.stacks);
}

function renderTemplates(stacks) {
  const ul = $("#templates");
  ul.innerHTML = "";
  for (const s of stacks) {
    const li = document.createElement("li");
    const badge = s.hasTemplate
      ? '<span class="tpl-badge ok">seeded</span>'
      : '<span class="tpl-badge none">scaffold</span>';
    const tech = [s.frontend, s.backend, s.database].filter(Boolean).join(" · ");
    li.innerHTML = `${badge} <strong>${escapeHtml(s.label)}</strong>
      <span class="tpl-tech">${escapeHtml(tech || (s.languages || []).join(", "))}</span>
      <span class="tpl-ws">${(s.workstreams || []).map((w) => escapeHtml(w.id)).join(" / ")}</span>`;
    li.title = "Select this stack";
    li.onclick = () => {
      $("#stack").value = s.id;
    };
    ul.appendChild(li);
  }
}

/* -------------------------------- runs ----------------------------------- */
async function loadRuns() {
  const runs = await api("/api/runs");
  const ul = $("#runs");
  ul.innerHTML = "";
  for (const r of runs) {
    const li = document.createElement("li");
    if (r.id === state.runId) li.className = "active";
    li.innerHTML = `<span class="badge ${r.status}">${r.status.replace("_", " ")}</span> <strong>${r.id}</strong>
      <span class="idea">${escapeHtml(r.idea).slice(0, 90)}</span>`;
    li.onclick = () => selectRun(r.id);
    ul.appendChild(li);
  }
}

async function selectRun(id) {
  state.runId = id;
  await loadRuns();
  const run = await api(`/api/runs/${id}`);
  renderDetail(run);
  connectStream(id);
}

function renderDetail(run) {
  $("#detail-title").innerHTML = `Run <strong>${run.id}</strong> <span class="badge ${run.status}">${run.status.replace("_", " ")}</span>`;
  const link = $("#repo-link");
  if (run.repoUrl) {
    link.textContent = run.repoUrl;
    link.href = run.repoUrl;
  } else {
    link.textContent = "";
    link.removeAttribute("href");
  }
  const stages = $("#stages");
  stages.innerHTML = "";
  for (const s of run.stages) {
    const li = document.createElement("li");
    li.className = s.status;
    li.textContent = s.name;
    stages.appendChild(li);
  }
  renderGate(run);
}

function renderGate(run) {
  const gate = $("#gate");
  const stage = run.stages.find((s) => s.status === "awaiting_approval");
  if (!stage) {
    gate.className = "gate hidden";
    gate.innerHTML = "";
    return;
  }
  gate.className = "gate";
  let body = "";
  if (stage.name === "requirements" && run.requirements) {
    const r = run.requirements;
    const parity = r.featureParity && r.featureParity.length ? "\n\nParity checklist (from references):\n✓ " + r.featureParity.map(escapeHtml).join("\n✓ ") : "";
    body = `<pre>${escapeHtml(r.summary)}\n\nFeatures:\n- ${r.coreFeatures.map(escapeHtml).join("\n- ")}${parity}${
      r.openQuestions && r.openQuestions.length ? "\n\nOpen questions:\n? " + r.openQuestions.map(escapeHtml).join("\n? ") : ""
    }</pre>`;
    if (r.wowFeatures && r.wowFeatures.length) {
      const selected = new Set(r.wowSelected || []);
      body += `<div class="wow"><h4>✨ Proposed "wow" features (differentiators peers lack)</h4>${r.wowFeatures
        .map(
          (w) => `<label class="wow-item"><input type="checkbox" class="wow-cb" value="${escapeHtml(w.id)}" ${selected.has(w.id) ? "checked" : ""}/>
            <span><strong>${escapeHtml(w.title)}</strong> <em class="wow-meta">impact:${escapeHtml(w.impact)} · effort:${escapeHtml(w.effort)}</em><br/>
            <span class="wow-desc">${escapeHtml(w.description)}</span></span></label>`,
        )
        .join("")}</div>`;
    }
  } else if (stage.name === "release") {
    body = `<pre>Ready to create a GitHub repo and push to main.</pre>`;
  }
  const canRevise = stage.name === "requirements";
  gate.innerHTML = `<h3>Approval required — ${stage.name}</h3>${body}
    <div class="actions">
      <button data-d="approve">Approve</button>
      ${canRevise ? '<button class="ghost" data-d="revise">Request revision</button>' : ""}
      <button class="ghost" data-d="reject">Reject</button>
    </div>`;
  gate.querySelectorAll(".actions button").forEach((btn) => {
    btn.onclick = () => {
      const wowSelected = btn.dataset.d === "approve"
        ? Array.from(gate.querySelectorAll(".wow-cb")).filter((cb) => cb.checked).map((cb) => cb.value)
        : undefined;
      resolveGate(run.id, stage.name, btn.dataset.d, wowSelected);
    };
  });
}

async function resolveGate(id, stage, decision, wowSelected) {
  let notes;
  if (decision === "revise") {
    notes = prompt("Revision notes:") || "";
  }
  await api(`/api/runs/${id}/gate/${stage}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, notes, wowSelected }),
  });
}

/* ------------------------------- stream ---------------------------------- */
function connectStream(id) {
  if (state.es) state.es.close();
  $("#log").textContent = "";
  const es = new EventSource(`/api/events?runId=${encodeURIComponent(id)}`);
  state.es = es;
  es.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
  // Named events all funnel through onmessage as well; also listen explicitly.
  ["stage.start", "stage.end", "task.start", "task.end", "agent.tool", "agent.delta", "log", "discovery.report", "security.report", "compliance.report", "verify.report", "acceptance.report", "cost.update", "stage.awaiting_approval", "run.done", "run.status"].forEach((type) => {
    es.addEventListener(type, (ev) => handleEvent(JSON.parse(ev.data)));
  });
}

const seen = new Set();
function handleEvent(e) {
  const key = e.ts + e.type + (e.taskId || "") + (e.message || "");
  if (seen.has(key)) return;
  seen.add(key);

  let cls = "l-dim";
  let text = e.message || "";
  switch (e.type) {
    case "stage.start": cls = "l-stage"; text = `▶ ${e.stage}`; break;
    case "stage.end": cls = "l-ok"; text = `✓ ${e.stage}`; break;
    case "task.start": cls = "l-dim"; text = `· ${e.message}`; break;
    case "task.end": cls = e.level === "error" ? "l-err" : "l-dim"; break;
    case "agent.tool": cls = "l-tool"; text = `  ${e.message}`; break;
    case "agent.delta": cls = "l-dim"; break;
    case "security.report": cls = "l-warn"; text = `🔒 ${e.message}`; break;
    case "discovery.report": cls = "l-ok"; text = `🔎 discovery — ${e.message}`; break;
    case "compliance.report": cls = e.level === "warn" ? "l-warn" : "l-ok"; text = `📋 ${e.message}`; break;
    case "verify.report": cls = e.level === "warn" ? "l-warn" : "l-ok"; text = `🚀 verify: ${e.message}`; break;
    case "acceptance.report": cls = e.level === "warn" ? "l-warn" : "l-ok"; text = `🏁 ${e.message}`; break;
    case "cost.update": cls = "l-dim"; text = `💰 ${e.message}`; break;
    case "log": cls = e.level === "error" ? "l-err" : e.level === "warn" ? "l-warn" : "l-dim"; break;
    case "run.done": cls = e.level === "error" ? "l-err" : "l-ok"; break;
    case "stage.awaiting_approval": cls = "l-warn"; text = `⏸ ${e.message}`; break;
    default: return;
  }
  if (e.type === "agent.delta") return; // keep the log readable; deltas are noisy
  appendLog(cls, text);

  // Refresh detail on structural changes.
  if (["stage.start", "stage.end", "run.status", "run.done", "stage.awaiting_approval"].includes(e.type)) {
    api(`/api/runs/${e.runId}`).then(renderDetail).catch(() => {});
    loadRuns();
  }
}

function appendLog(cls, text) {
  if (!text) return;
  const log = $("#log");
  const line = document.createElement("span");
  line.className = cls;
  line.textContent = text + "\n";
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* -------------------------------- init ----------------------------------- */
$("#new-run-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const idea = $("#idea").value.trim();
  if (idea.length < 3) return;
  const stack = $("#stack").value;
  const scale = $("#scale").value;
  const references = $("#refs").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const compliance = Array.from(document.querySelectorAll(".comp-cb")).filter((cb) => cb.checked).map((cb) => cb.value);
  const saas = Array.from(document.querySelectorAll(".saas-cb")).filter((cb) => cb.checked).map((cb) => cb.value);
  const run = await api("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idea, stack, scale, references, compliance, saas }),
  });
  $("#idea").value = "";
  $("#refs").value = "";
  await selectRun(run.id);
});

$("#clear-log").addEventListener("click", () => {
  $("#log").textContent = "";
  seen.clear();
});

loadDoctor();
loadStacks();
loadRuns();
setInterval(loadRuns, 5000);
