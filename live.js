/* Live updates, the parts without page code (tested in tests/js/live.test.js):
 * a run's progress steps, what its chat bubble says, which runs belong in the thread, how often to poll when the
 * Realtime socket is down, and the button's label.
 *
 * A run row (table runs): { id, trigger: "manual" | "schedule", stage, status, requested_at, started_at,
 *   finished_at, new_items, note }. Stages in order: queued, logging in, reading companies, reading notices,
 *   reading PDFs, saving, then done or failed.
 */
(function (root) {
  "use strict";
  const ACTIVE = ["queued", "logging in", "reading companies", "reading notices", "reading PDFs", "saving"];
  // what the bubble shows as steps: queued -> logging in -> reading companies/notices/PDFs -> done
  const STEPS = [
    { label: "queued", stages: ["queued"] },
    { label: "logging in", stages: ["logging in"] },
    { label: "reading companies, notices, PDFs", stages: ["reading companies", "reading notices", "reading PDFs", "saving"] },
    { label: "done", stages: ["done"] },
  ];
  const STALE_MS = 30 * 60000;        // a run that hasn't moved for 30 minutes isn't shown as running any more
  const QUEUED_SLOW_MS = 10 * 60000;  // GitHub hasn't started it after 10 minutes: say so

  const t = (v) => (v ? new Date(v).getTime() : 0);
  const hm = (v) => new Date(v).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const lastMove = (run) => Math.max(t(run.requested_at), t(run.started_at), t(run.finished_at));

  function isActive(run, now) {
    if (!run || !ACTIVE.includes(run.stage)) return false;
    return (now ? new Date(now).getTime() : Date.now()) - lastMove(run) < STALE_MS;
  }

  // [{label, state: "done" | "now" | "todo"}]
  function steps(run) {
    const at = STEPS.findIndex((s) => s.stages.includes(run.stage));
    return STEPS.map((s, i) => ({ label: s.label, state: run.stage === "failed" ? (i < Math.max(at, 1) ? "done" : "todo")
      : i < at || (run.stage === "done" && i === at) ? "done" : i === at ? "now" : "todo" }));
  }

  // the run before this one that finished (for "nothing new since 11:41")
  function previousDone(run, runs) {
    return (runs || []).filter((r) => r.id !== run.id && r.finished_at && t(r.finished_at) < (t(run.started_at) || t(run.requested_at) || Infinity))
      .sort((a, b) => t(b.finished_at) - t(a.finished_at))[0] || null;
  }

  // {kicker, line, steps|null, state: "active" | "done" | "failed"}
  function describe(run, runs, now) {
    const kicker = null;                 // no "Check now" / "Hourly check" label: the bubble says what happened
    if (isActive(run, now)) {
      const slow = run.stage === "queued" && (now ? new Date(now).getTime() : Date.now()) - t(run.requested_at) > QUEUED_SLOW_MS;
      return { kicker, state: "active", steps: steps(run),
               line: slow ? "Still waiting for GitHub to start the check…" : "Checking the ERP now… usually takes 1–2 minutes" };
    }
    if (run.stage === "failed" || (run.status || "").startsWith("failed")) {
      return { kicker, state: "failed", steps: null, line: run.note || "The check couldn't finish. I'll try again at the next hourly check." };
    }
    if (run.demo) {
      // the demo's first Check now finds what its snapshot's last check brought; later ones find nothing new
      const k = Number(run.new_items) || 0;
      return { kicker, state: "done", steps: null, line: k ? "" : "" };
    }
    // done: the page draws the new items themselves (never a count); nothing new is no message at all
    return { kicker, state: "done", steps: null, line: "" };
  }

  // in the thread: a check still going (Check now's progress), one that failed, and one that brought something new
  // (its items, drawn by the page). A finished check with nothing new is no message: the header says "checked just now".
  function inThread(run, now) {
    if (!run || !run.stage) return false;            // rows from before live updates
    if (isActive(run, now)) return run.trigger === "manual" || !!run.demo;
    if (run.stage === "failed" || (run.status || "").startsWith("failed")) return run.trigger === "manual";
    return run.stage === "done" && Number(run.new_items) > 0;
  }

  // a finished check that found nothing (and didn't fail): not a bubble, a thin line
  function quiet(run, now) {
    if (!run || isActive(run, now) || run.stage !== "done" || (run.status || "").startsWith("failed")) return false;
    return !(Number(run.new_items) > 0);
  }
  // Consecutive "nothing new" checks in the thread become ONE thin line that updates in place:
  // "Checked 03:18 · nothing new since 02:53" (since = the check before the first of them). Only a check that found
  // something, failed, or is still going keeps its bubble. entries: the thread, sorted; -> the same with
  // { kind: "quiet", at, key: "run:<first id>", runs, line } in place of each run of quiet checks.
  function collapseQuiet(entries, runs, now) {
    const out = [];
    for (const e of entries) {
      if (e.kind === "run" && quiet(e.run, now)) {
        const prev = out[out.length - 1];
        if (prev && prev.kind === "quiet") { prev.runs.push(e.run); prev.at = e.at; continue; }
        out.push({ kind: "quiet", at: e.at, runs: [e.run] });
        continue;
      }
      out.push(e);
    }
    for (const q of out) {
      if (q.kind !== "quiet") continue;
      const first = q.runs[0], last = q.runs[q.runs.length - 1];
      const since = previousDone(first, runs);
      q.key = `run:${first.id}`;
      q.line = `Checked ${hm(last.finished_at || last.started_at || last.requested_at)} · nothing new` +
        (first.demo ? " (demo sample data)" : since ? ` since ${hm(since.finished_at)}` : "");
    }
    return out;
  }

  const pollEvery = (active) => (active ? 15000 : 60000);

  function buttonLabel(run, now) {
    return isActive(run, now) ? `Checking… ${run.stage === "queued" ? "queued" : run.stage}` : "Check now";
  }

  // the demo's Check now: the same steps on the sample snapshot, nothing fetched
  const DEMO_STAGES = [["queued", 700], ["logging in", 1100], ["reading companies", 900], ["reading notices", 900],
                       ["reading PDFs", 800], ["saving", 500]];

  // the latest run that is going (for the header and the buttons)
  function current(runs, now) { return (runs || []).find((r) => isActive(r, now)) || null; }
  // the page's messages were loaded after the newest finished check it knows of (Ask Ping answers FACT questions in
  // the page only then; otherwise the function, whose data is current)
  function messagesCurrent(runs, stamped) {
    return (lastFinished(runs)?.id ?? null) === (stamped ?? null);
  }
  function lastFinished(runs) {
    return (runs || []).filter((r) => r.finished_at).sort((a, b) => t(b.finished_at) - t(a.finished_at))[0] || null;
  }

  const api = { ACTIVE, STEPS, isActive, steps, describe, inThread, quiet, collapseQuiet, messagesCurrent, pollEvery, buttonLabel, DEMO_STAGES, current,
                lastFinished, previousDone };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PingLive = api;
})(typeof window !== "undefined" ? window : globalThis);
