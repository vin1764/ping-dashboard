/* The Today panel, without page code (tested in tests/js/today.test.js): what's on today, in time order, with what's
 * over moved to the bottom; a one-line preview of tomorrow; the next ERP check; and the live countdown text every
 * chip in the app uses.
 *
 * build({ items, roles, notices, runs, profile, now, isMine, inChat }) ->
 *   { rows: [{ kind: "test" | "deadline" | "todo" | "notice" | "more", at, over, title, sub, names, status, due, target,
 *              children, via: "email" | null }], ahead, tomorrow: { tests, deadlines, text }, nextCheck, empty, emptyText }
 *   Forms / to-dos due at the same time are one row ("5 forms due 20:00") whose children are the single ones; tests
 *   stay one row each. The next ERP check isn't a row: the header's status line says it (nextCheck is still returned).
 *   isMine(role): the role is one you'd apply to (eligible and "for you"); inChat(item): it is a chat message.
 */
(function (root) {
  "use strict";
  const TZ = "Asia/Kolkata";
  const ms = (v) => (v ? new Date(v).getTime() : NaN);
  // one formatter each, made once: toLocale*String(..., options) builds a new one per call (slow on a phone)
  const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const HM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const dayOf = (t) => DAY.format(new Date(t));
  const clock = (t) => HM.format(new Date(t));
  // display names (dashboard/names.js): the website in brackets goes, the raw ERP name stays in the data
  const NAMES = root.PingNames || (typeof require === "function" ? require("./names.js") : null);
  const cleanName = (s) => (NAMES ? (NAMES.displayName || NAMES.cleanName)(s) : String(s || "").trim());
  // "Piramal" for "Piramal Capital & Housing Finance Ltd", "TATA AIG" for "TATA AIG General Insurance": a list of names
  const LEGALISH = /\b(private|pvt|limited|ltd|inc|llp|llc|plc|co|company|corp|corporation|technologies|technology|services|solutions|group|global|labs|systems|software|india|general|insurance|capital|housing|finance|financial|bank|consulting|developers|energy|the|and)\b\.?/gi;
  const shortName = (s) => {
    const c = cleanName(s).replace(/\s*\(.*?\)/g, "").replace(/[.,&]/g, " ");
    const core = c.replace(LEGALISH, " ").replace(/\s+/g, " ").trim();
    const words = (core || c).split(" ").filter(Boolean);
    return words.slice(0, 2).join(" ") || c.trim();
  };
  const listNames = (names, n) => (NAMES && NAMES.namesLine ? NAMES.namesLine(names) : names.length > n ? `${names.slice(0, n).join(", ")}, …` : names.join(", "));
  const TEST_KINDS = ["test", "test_rooms", "interview", "gd"];

  // "in 1 h 48 m" / "in 42 m" / "in 35 s" / "in 3 days" / "over"; level: over | red (<1 h) | amber (<3 h) | plain
  function countdown(at, now) {
    const left = ms(at) - now;
    if (!(left > 0)) return { text: "over", level: "over" };
    const s = Math.floor(left / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    const level = left < 3600000 ? "red" : left < 3 * 3600000 ? "amber" : "plain";
    if (m < 1) return { text: `in ${s} s`, level };
    if (h < 1) return { text: `in ${m} m`, level };
    if (h < 24) return { text: m % 60 ? `in ${h} h ${m % 60} m` : `in ${h} h`, level };
    const d = Math.round(h / 24);
    return { text: d === 1 ? "in 1 day" : `in ${d} days`, level };
  }

  // the next time the ERP is checked: the last check's start plus the interval, moved past now
  function nextCheck(runs, profile, now) {
    const every = (Number(profile?.check_every_minutes) || 60) * 60000;
    const starts = (runs || []).map((r) => ms(r.started_at || r.requested_at)).filter((t) => t > 0);
    if (!starts.length) return null;
    let next = Math.max(...starts) + every;
    if (next <= now) next += Math.ceil((now - next + 1) / every) * every;
    return next;
  }

  const isTest = (it) => it.category === "test" || TEST_KINDS.includes(it.details?.kind);
  const roleOfTitle = (t) => (String(t || "").match(/\(([^)]+)\)/) || [])[1] || "";
  const pdfStatus = (it) => it.details?.pdf?.status || it.pdf_status || null;

  // a day ("2026-11-24") or a window ({from, to}: Today covers the next 48 hours)
  const inside = (t, day) => (typeof day === "string" ? dayOf(t) === day : t >= day.from && t <= day.to);
  function tests(items, day, inChat) {
    const seen = new Map();
    for (const it of items || []) {
      if (!isTest(it) || !it.event_at || !inside(ms(it.event_at), day)) continue;
      const st = pdfStatus(it);
      // a test that isn't about you (hidden with no list saying so) isn't on your day
      if (it.level === "hidden" && st !== "no" && st !== "yes") continue;
      const key = `${cleanName(it.company).toLowerCase()}|${ms(it.event_at)}`;
      const prev = seen.get(key);
      if (!prev || (!pdfStatus(prev) && st) || (prev.level === "hidden" && it.level !== "hidden")) seen.set(key, it);
    }
    return [...seen.values()].map((it) => {
      const d = it.details || {}, row = d.pdf?.details || {};
      const st = pdfStatus(it);
      const place = [row.room ? `room ${row.room}` : "", row.slot ? `slot ${row.slot}` : "", !row.room && d.venue ? d.venue : ""]
        .filter(Boolean).join(" · ");
      return { kind: "test", at: ms(it.event_at), due: it.event_at, via: d.via || null,
               title: `${cleanName(it.company)} ${d.kind === "interview" ? "interview" : "test"}`,
               sub: [roleOfTitle(it.title), clock(ms(it.event_at)), place].filter(Boolean).join(" · "),
               status: st === "yes" ? "on" : st === "no" ? "off" : null, itemIds: [it.id],
               target: inChat(it) ? { item: it.id } : { company: it.company } };
    });
  }

  // a deadline row counts what's left: the roles you haven't applied to ("1 for you to apply by 20:00", "11 others
  // not applied" only when other roles are listed). Everything applied: the row is done (the "Done today" line).
  function deadlines(roles, day, isMine, items, inChat, { split = true, listOthers = true } = {}) {
    const groups = new Map();
    for (const r of roles || []) {
      const t = ms(r.effective_deadline || r.apply_end);
      if (!(t > 0) || !inside(t, day)) continue;
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(r);
    }
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    return [...groups.entries()].map(([t, rs]) => {
      const open = rs.filter((r) => !r.applied), applied = rs.filter((r) => r.applied);
      const mine = split ? open.filter(isMine) : open, others = split ? open.filter((r) => !isMine(r)) : [];
      const showOthers = split && listOthers && others.length > 0;
      const shown = mine.length ? mine : showOthers ? others : [];
      const names = [...new Set(shown.map((r) => cleanName(r.company)))].sort((a, b) => a.localeCompare(b));
      // the digest that lists this batch, so a tap opens the message that has every role
      const digest = (items || []).find((it) => inChat(it) && ["application", "deadline"].includes(it.details?.kind)
        && ms(it.due_at) === t);
      const title = !open.length ? `${plural(applied.length, "application")} done` : mine.length
        ? `${mine.length}${split ? " for you" : ""} to apply by ${clock(t)}` : showOthers ? `${plural(others.length, "other role")} to apply by ${clock(t)}` : "";
      return { kind: "deadline", at: t, due: new Date(t).toISOString(), title,
               sub: mine.length && showOthers ? `${plural(others.length, "other")} not applied` : !mine.length && showOthers ? "none for you" : "",
               names: NAMES && NAMES.namesLine ? NAMES.namesLine(names) : names.length > 4 ? `${names.slice(0, 4).join(", ")} +${names.length - 4}` : names.join(", "),
               mine: mine.length, others: others.length, notApplied: open.length, roleIds: rs.map((r) => r.id), applied: applied.length,
               total: rs.length, left: mine.length, done: !open.length, quiet: open.length > 0 && !mine.length && !showOthers,
               digestId: digest ? digest.id : null,
               target: digest ? { item: digest.id } : mine.length === 1 || rs.length === 1 ? { role: (mine[0] || rs[0]).id } : { companies: true } };
    }).filter((r) => !r.quiet);
  }

  const todoWhat = (it) => (/fill the form/i.test(it.title || "") || it.details?.todo?.action === "fill_form" ? "form"
    : it.details?.todo?.action === "take_test" ? "test" : /submit/i.test(it.title || "") ? "submission" : "to-do");
  function todos(items, day, inChat, isFilled = () => false) {
    const one = (it) => ({ kind: "todo", at: ms(it.due_at), due: it.due_at, title: cleanName(it.company) || "To do", via: it.details?.via || null,
                           itemIds: [it.id], forms: todoWhat(it) === "form", filledAll: todoWhat(it) === "form" && isFilled(it),
                           filled: todoWhat(it) === "form" && isFilled(it) ? 1 : 0, left: todoWhat(it) === "form" && isFilled(it) ? 0 : 1,
                           sub: `${clock(ms(it.due_at))} · ${String(it.title || "").replace(/^[^:]*:\s*/, "")}`,
                           target: inChat(it) ? { item: it.id } : { company: it.company } });
    const list = (items || []).filter((it) => it.category === "todo" && it.due_at && inside(ms(it.due_at), day)
      && (it.level !== "hidden" || /digest/.test(it.details?.hidden_because || "")));
    const groups = new Map();
    for (const it of list) { const t = ms(it.due_at); if (!groups.has(t)) groups.set(t, []); groups.get(t).push(it); }
    return [...groups.entries()].map(([t, its]) => {
      if (its.length === 1) return one(its[0]);
      const child = (it) => ({ ...one(it), sub: [roleOfTitle(it.title), todoWhat(it) === "form" ? "fill the form" : todoWhat(it)].filter(Boolean).join(" · ") });
      // same time: one row, "5 forms due 20:00", that opens into the single ones
      const whats = new Set(its.map(todoWhat));
      const what = whats.size === 1 ? [...whats][0] : "to-do";
      const names = [...new Set(its.map((it) => shortName(it.company)).filter(Boolean))];
      const digest = (items || []).find((x) => inChat(x) && x.category === "digest" && x.details?.kind === "form" && ms(x.due_at) === t);
      const filled = what === "form" ? its.filter(isFilled).length : 0;
      const left = its.length - filled;
      // what's left: the forms not ticked yet ("2 forms due 20:00"); all ticked: done
      return { kind: "todo", group: true, at: t, due: new Date(t).toISOString(), itemIds: its.map((it) => it.id), what,
               forms: what === "form", filled, filledAll: filled > 0 && filled === its.length, left,
               title: `${left || its.length} ${what}${(left || its.length) === 1 ? "" : "s"} due ${clock(t)}`, sub: "",
               names: listNames(left ? [...new Set(its.filter((it) => !isFilled(it)).map((it) => shortName(it.company)).filter(Boolean))] : names, 4),
               children: its.map(child).sort((a, b) => a.title.localeCompare(b.title)),
               target: digest ? { item: digest.id } : null };
    });
  }

  // a notice for several companies: which ones (first 3 + N) and what it asks ("fill the form by 16:00")
  const ACTION_WORDS = { fill_form: "fill a form", submit: "submit", accept_offer: "accept the offer", apply: "apply" };
  function noticeAsks(n) {
    const a = n.analysis || {};
    const todos = (n.todos || a.todos || []).filter((t) => t && t.action);
    const acts = [...new Set(todos.map((t) => t.action))];
    const main = acts.find((x) => x !== "apply") || acts[0];
    if (main) {
      const due = todos.find((t) => t.action === main && t.due)?.due;
      return `${ACTION_WORDS[main] || main.replace(/_/g, " ")}${due ? ` by ${clock(ms(due))}` : ""}`;
    }
    const kind = n.kind || a.kind;
    const KIND = { apply_open: "open for applications", deadline_extended: "deadlines extended", test: "tests", test_rooms: "test rooms",
                   shortlist: "shortlists", result: "results", ppt: "pre-placement talks", schedule: "schedule" };
    if (KIND[kind]) return KIND[kind];
    const first = String(n.preview || "").split(/(?<=[.!?])\s/)[0];
    return first ? first.slice(0, 80) : "";
  }
  function noticeCompanies(n) {
    const a = n.analysis || {};
    const names = (n.targets || a.targets || []).map((t) => shortName(t.company || String(t.name || "").replace(/^\s*\d+\s*\.\s*/, "")))
      .filter(Boolean);
    return [...new Set(names)];
  }

  // what a notice asks, said as what to do ("deadlines extended to 20:00", "submit CV by 20:00"), with the time it's
  // about and which list it belongs with (applications or forms), so the row reads as an action, not a subject line
  function noticeWhat(n) {
    const a = n.analysis || {}, kind = n.kind || a.kind, subj = String(n.subject || "");
    const todos = (n.todos || a.todos || []).filter((t) => t && t.action);
    const due = (act) => todos.find((t) => (!act || t.action === act) && t.due)?.due || null;
    const at = (v) => (v ? clock(ms(v)) : "");
    if (kind === "deadline_extended" || /extend|extension/i.test(subj)) {
      const d = due("apply") || due();
      return { many: d ? `Deadlines extended to ${at(d)}` : "Deadlines extended", one: d ? `deadline extended to ${at(d)}` : "deadline extended", due: d, list: "apply" };
    }
    if (/\bcv\b|resume/i.test(subj)) {
      const d = due("submit") || due("apply");
      return { many: d ? `Submit CV by ${at(d)}` : "Submit CV", one: d ? `submit CV by ${at(d)}` : "submit CV", due: d, list: "apply" };
    }
    if (due("fill_form")) return { many: `Fill a form by ${at(due("fill_form"))}`, one: `fill the form by ${at(due("fill_form"))}`, due: due("fill_form"), list: "form" };
    if (due("submit")) return { many: `Submit by ${at(due("submit"))}`, one: `submit by ${at(due("submit"))}`, due: due("submit"), list: "form" };
    if (due("accept_offer")) return { many: `Accept offers by ${at(due("accept_offer"))}`, one: `accept the offer by ${at(due("accept_offer"))}`, due: null };
    const KIND = { apply_open: ["Open for applications", "open for applications"], test: ["Tests", "test"], test_rooms: ["Test rooms out", "test rooms out"],
                   shortlist: ["Shortlists out", "shortlist out"], result: ["Results out", "results out"], ppt: ["Pre-placement talks", "pre-placement talk"],
                   schedule: ["Schedule", "schedule"] };
    if (KIND[kind]) {
      const d = kind === "apply_open" ? due("apply") : null;
      return { many: KIND[kind][0] + (d ? ` until ${at(d)}` : ""), one: KIND[kind][1] + (d ? ` until ${at(d)}` : ""), due: d, list: d ? "apply" : null };
    }
    return null;
  }

  const NOTICE_MAX = 6;
  // a notice's subject as a short label: "CDC Placement Schedule for 24th" -> "schedule · 24 Nov"; "[URGENT] : CDC |
  // NOMURA | Additonal Details" -> "Additional Details"; never cut off mid-word
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortSubject(subject, company, at) {
    let t = String(subject || "").replace(/\[[^\]]*\]|\((urgent|important)\)/gi, " ").replace(/\badditonal\b/gi, "Additional")
      .replace(/(^|[\s|:])(cdc|iit\s*kgp|iit\s*kharagpur|placement)(?=$|[\s|:])/gi, "$1 ").replace(/[|:]+/g, " ").replace(/\s+/g, " ").trim();
    const co = String(company || "").split(/\s+/)[0];
    if (co && co.length >= 3) t = t.replace(new RegExp(`^${co.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*`, "i"), "").trim();
    if (/\bschedule\b/i.test(t)) {
      const d = t.match(/\b(\d{1,2})(st|nd|rd|th)?\b/), when = new Date(at || Date.now());
      const mon = MON[Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", month: "numeric" }).format(when)) - 1];
      const day = d ? Number(d[1]) : Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric" }).format(when));
      return `schedule · ${day} ${mon}`;
    }
    if (t.length > 30) t = t.slice(0, 31).replace(/\s+\S*$/, "").replace(/\s+(of|and|for|the|to|in|on|with|&)$/i, "");
    return t || "notice";
  }
  function notices(list, day, items, inChat) {
    const today = (list || []).filter((n) => n.notice_time && dayOf(ms(n.notice_time)) === day)
      .sort((a, b) => ms(a.notice_time) - ms(b.notice_time));
    const rows = today.slice(0, NOTICE_MAX).map((n) => {
      const nid = n.notice_id ?? n.id;
      const it = (items || []).find((x) => x.notice_id === nid && inChat(x));
      const what = noticeWhat(n);
      const posted = `posted ${clock(ms(n.notice_time))}`;
      const base = { kind: "notice", at: ms(n.notice_time), noticeId: nid, itemIds: it ? [it.id] : [], target: it ? { item: it.id } : { notice: nid },
                     dueAt: what?.due ? ms(what.due) : null, list: what?.list || null };
      const many = /multiple|several|various/i.test(n.company || "");
      // one company: "ICICI Lombard · deadline extended to 20:00"
      const generic = /^(cdc|placement|career development|training)/i.test(n.company || "") || !n.company;
      const label = what ? what.one : shortSubject(n.subject, n.company, n.notice_time);
      if (!many) return { ...base, title: generic && /^schedule/.test(label) ? `CDC ${label}` : `${cleanName(n.company)} · ${label}`, sub: posted };
      // several: "Deadlines extended to 20:00 · 18 companies", then which ones
      const names = noticeCompanies(n), asks = noticeAsks(n);
      const who = names.length ? (names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ")) : "several companies";
      const count = names.length ? ` · ${names.length} compan${names.length === 1 ? "y" : "ies"}` : "";
      const lab = what ? what.many : shortSubject(n.subject, "", n.notice_time);
      return { ...base, title: `${/^schedule/.test(lab) ? `CDC ${lab}` : lab}${count}`, companies: names, asks, sub: posted, names: who };
    });
    if (today.length > NOTICE_MAX) rows.push({ kind: "more", at: ms(today[NOTICE_MAX].notice_time),
      title: `+${today.length - NOTICE_MAX} more notices today`, sub: "", target: { feed: true } });
    return rows;
  }

  function build({ items = [], roles = [], notices: nlist = [], runs = [], profile = {}, now = Date.now(),
                   isMine = () => true, inChat = () => true, isFilled = () => false, split = true, listOthers = true } = {}) {
    const day = dayOf(now), tomorrow = dayOf(now + 86400000);
    // what's due from the start of today to 48 hours from now (a deadline the day after tomorrow morning shows today)
    const win = { from: new Date(`${day}T00:00:00+05:30`).getTime(), to: now + 48 * 3600000 };
    // Today = what you still have to act on. Done (everything applied, every form ticked) or over (the time has passed,
    // a test that's over) goes into one "Done today" line at the bottom
    const timed = [...tests(items, win, inChat).map((r) => ({ ...r, left: 1 })), ...deadlines(roles, win, isMine, items, inChat, { split, listOthers }),
                   ...todos(items, win, inChat, isFilled)]
      .map((r) => ({ ...r, over: r.at <= now || !!r.filledAll || !!r.done }));
    // a notice about a deadline that's already a row (the 20:00 applications, the 20:00 forms) joins that row
    // instead of appearing twice: the row says the notice moved or set it
    const news = [];
    for (const r of notices(nlist, day, items, inChat)) {
      const same = r.dueAt && timed.find((t) => t.at === r.dueAt && ((r.list === "apply" && t.kind === "deadline") || (r.list === "form" && t.kind === "todo")));
      if (same) {
        same.noticeIds = [...(same.noticeIds || []), r.noticeId];
        if (!/notice/.test(same.sub)) same.sub = [same.sub, `${/extended/i.test(r.title) ? "extended by a notice" : "per a notice"} (${r.sub.replace("posted ", "")})`].filter(Boolean).join(" · ");
        continue;
      }
      news.push({ ...r, over: false });
    }
    const next = nextCheck(runs, profile, now);
    const ahead = timed.filter((r) => !r.over);
    const done = timed.filter((r) => r.over).sort((a, b) => a.at - b.at);
    const rows = [...ahead, ...news].sort((a, b) => a.at - b.at);
    // "Done today: 11 applied ✓ · 2 forms filled ✓ · 1 test over": applied and ticked things, said once
    const nApplied = timed.filter((r) => r.kind === "deadline").reduce((n, r) => n + (r.applied || 0), 0);
    const nFilled = timed.filter((r) => r.kind === "todo").reduce((n, r) => n + (r.filled || 0), 0);
    const nTests = done.filter((r) => r.kind === "test").length;
    const nClosed = done.filter((r) => r.kind === "deadline" && !r.done).reduce((n, r) => n + (r.left || 0), 0);
    const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const doneParts = [nApplied ? `${nApplied} applied ✓` : "", nFilled ? `${pl(nFilled, "form")} filled ✓` : "",
                       nTests ? `${pl(nTests, "test")} over` : "", nClosed ? `${nClosed} closed without applying` : ""].filter(Boolean);
    // the next deadline after today, for "All done for today. Next deadline: …"
    const nextAt = Math.min(...(roles || []).filter((r) => !r.applied && (!split || isMine(r)))
      .map((r) => ms(r.effective_deadline || r.apply_end)).filter((t) => t > now && dayOf(t) !== day), Infinity);
    const NEXT = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const nextText = Number.isFinite(nextAt) ? ` Next deadline: ${NEXT.format(new Date(nextAt)).replace(/,? (\d\d:\d\d)$/, ", $1")}.` : "";
    // the 48 hours cover tomorrow: no separate "Tomorrow:" line
    const tTests = 0, tDead = 0;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    return {
      rows, done, ahead: ahead.length, left: ahead.reduce((n, r) => n + (r.left || 0), 0), nextCheck: next,
      doneLine: doneParts.length ? `Done today: ${doneParts.join(" · ")}` : "",
      empty: !ahead.length && !news.length,
      emptyText: done.length ? `All done for the next 48 hours.${nextText}` : `Nothing due in the next 48 hours.${nextText}`,
      tomorrow: { tests: tTests, deadlines: tDead,
                  text: tTests || tDead ? `Tomorrow: ${[tTests ? plural(tTests, "test") : "", tDead ? plural(tDead, "deadline") : ""]
                    .filter(Boolean).join(", ")}` : "Tomorrow: nothing scheduled yet" },
    };
  }

  // ---------------------------------------------------------------- the detail sheet behind a row (pure parts)
  const ERP = "https://erp.iitkgp.ac.in";
  // "Open on ERP": the role's own page on the ERP (where Apply is) when Ping knows the role's ids and your roll; it
  // opens in the browser and works while you're signed in to the ERP there. Otherwise the ERP's home page and what
  // to search for. A link only: Ping never opens the ERP itself.
  function erpLink(role, roll) {
    const company = cleanName(role?.company || "");
    if (role && role.jnf_id && role.com_id && role.yop && roll) {
      const q = new URLSearchParams({ jnf_id: role.jnf_id, com_id: role.com_id, yop: role.yop, user_type: "SU", rollno: roll });
      return { href: `${ERP}/TrainingPlacementSSO/TPJNFView.jsp?${q}`, direct: true, search: company };
    }
    return { href: `${ERP}/IIT_ERP3/`, direct: false, search: company };
  }
  // every form link an item carries (the notice's todo, its form links, the mail's), web links only, once each
  function formLinks(it) {
    const d = (it && it.details) || {};
    const all = [d.todo && d.todo.link, ...(d.forms || []), d.mail && d.mail.link, ...(d.mail_links || [])];
    return [...new Set(all.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)))];
  }
  // a sheet's role cards: for you and not applied first (soonest first), then applied, then the others (collapsed)
  function orderCards(cards) {
    // a card is "other" only when the marks say so (mine === false); with no marks (tests, notices, no targets) it's in view
    const rank = (c) => (c.mine === false && !c.applied ? 2 : c.applied ? 1 : 0);
    const by = (a, b) => rank(a) - rank(b) || (a.at || 0) - (b.at || 0) || String(a.company).localeCompare(String(b.company));
    const sorted = [...cards].sort(by);
    return { top: sorted.filter((c) => rank(c) < 2), others: sorted.filter((c) => rank(c) === 2) };
  }
  // which cards a filter chip keeps: "notapplied" | "foryou" (not applied and for you) | "all" (applied only here)
  const filterCards = (cards, f) => cards.filter((c) => f === "all" || (f === "foryou" ? c.mine !== false && !c.applied : !c.applied));
  // the sheet's numbers, the same ones the chips show
  const sheetCounts = (cards) => ({ notApplied: filterCards(cards, "notapplied").length, forYou: filterCards(cards, "foryou").length,
                                    all: cards.length, split: cards.some((c) => c.mine === true || c.mine === false) });
  // header "12 not applied · 1 for you"; under it "Applications close today 20:00 · 23 in all"
  function sheetTitle({ cards, at, now, word = "application", verb = "close" }) {
    const c = sheetCounts(cards);
    const day = dayOf(at) === dayOf(now) ? "today" : dayOf(at) === dayOf(now + 86400000) ? "tomorrow" : dayOf(at);
    return { title: [`${c.notApplied} not applied`, c.split ? `${c.forYou} for you` : ""].filter(Boolean).join(" · "),
             sub: `${word[0].toUpperCase()}${word.slice(1)}s ${verb} ${day} ${clock(at)} · ${c.all} in all` };
  }

  const api = { build, shortSubject, countdown, nextCheck, clock, dayOf, cleanName, shortName, erpLink, formLinks, orderCards, filterCards, sheetCounts, sheetTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PingToday = api;
})(typeof window !== "undefined" ? window : globalThis);
