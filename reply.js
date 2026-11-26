// Reply to a message: what a quoted message is about (its anchor) and the answers that come straight from it.
// The quoted message is the topic: it overrides the conversation's guess. Pure (no page); tests/js/reply.test.js.
//
// anchor = { key, sender, text, kind, companies[], roles[{ id, company, label, applied, cv }], due, event, noticeId,
//            formKeys[], place: { room, slot, venue, time } }
(function (root) {
  const R = typeof module !== "undefined" && module.exports ? require("../supabase/functions/_shared/answer_rules.js") : root.PingRules;
  const firstLine = (t) => String(t || "").split("\n").find((l) => l.trim()) || "";
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];

  // a feed message (item) or a chat bubble (msg: { role, text, created_at })
  function anchorOf(src, data) {
    if (!src) return null;
    if (src.role) {
      const companies = R ? R.matchCompanies(src.text, data, R.entities(data)).hits.map((e) => e.name) : [];
      return { key: src.key, sender: src.role === "me" ? "You" : "Ping", text: firstLine(src.text).slice(0, 160), kind: "text",
               companies, roles: [], formKeys: [], place: {} };
    }
    const it = src, d = it.details || {};
    // the demo's rows name roles and messages without its "sample:" prefix: either form resolves
    const index = (xs) => { const m = new Map(); for (const x of xs || []) { m.set(x.id, x); m.set(String(x.id).replace(/^sample:/, ""), x); } return m; };
    const byId = index(data.roles), items = index(data.items);
    // the roles in the order the message shows them (a digest's rows: For you, then the rest, then Others)
    const rowIds = (d.list || []).flatMap((g) => (g.rows || []).map((r) => r.id)).filter(Boolean);
    const roleIds = [];
    for (const id of rowIds.length ? rowIds : it.role_ids || []) {
      if (byId.has(id)) roleIds.push(byId.get(id).id);
      else for (const rid of (items.get(id) || {}).role_ids || []) roleIds.push(byId.get(rid)?.id || rid);
    }
    const roles = uniq(roleIds).map((id) => byId.get(id)).filter(Boolean)
      .map((r) => ({ id: r.id, company: r.company, label: r.designation, applied: !!r.applied, cv: r.cv || null }));
    const memberItems = rowIds.map((id) => items.get(id)).filter(Boolean);
    const formKeys = uniq([d.form?.key, ...memberItems.map((m) => m.details?.form?.key)]);
    const pd = d.pdf?.details || {};
    return {
      key: `item:${it.id}`, sender: "Ping", text: firstLine(it.title).slice(0, 160),
      kind: d.kind === "application" || it.category === "digest" ? (d.kind || "digest") : d.todo?.action === "fill_form" ? "form" : it.category,
      companies: uniq([it.company, ...roles.map((r) => r.company), ...memberItems.map((m) => m.company)]),
      roles, due: it.due_at || null, event: it.event_at || null, noticeId: it.notice_id || null, formKeys,
      place: { room: pd.room || pd.room_or_venue_from_heading || null, slot: pd.slot || pd.slot_from_heading || null,
               venue: d.venue || null, time: pd.time || pd.time_from_heading || pd.reporting_time || null },
    };
  }

  const ORD = { first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4,
                four: 4, fifth: 5, "5th": 5, five: 5, last: -1 };
  function ordinal(q) {
    const m = String(q).toLowerCase().match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b|#\s*(\d+)|\bno\.?\s*(\d+)\b|\b(one|two|three|four|five)\b(?=\s*(?:\?|$|one|role|company))/);
    if (!m) return null;
    return m[2] || m[3] ? Number(m[2] || m[3]) : ORD[m[1] || m[4]];
  }
  const name = (s) => (R ? R.shortName(s) : s);
  const roleName = (r) => `${name(r.company)} — ${r.label}`;

  // -> { text, tick?, recheck? } or null (then the question goes on as usual, about the anchor's companies)
  function answer(question, a, opts = {}) {
    if (!a) return null;
    const q = String(question || "").toLowerCase().trim();
    // "check again", "are you sure?": that message's company, read again from the ERP
    if (R && R.isRecheck(question) && a.companies.length) return { recheck: a.companies[0], companies: a.companies };
    // "done" on a form line: ticked (your own record)
    if (a.formKeys.length && /^(done|filled|submitted|did it|completed?|ticked?|mark(ed)? (it )?(as )?(done|filled))[\s.!]*$|\b(i('ve| have)? )?(filled|submitted|done) (it|this|that|the form)\b/.test(q)) {
      const key = a.formKeys[0];
      if (opts.isFilled && opts.isFilled(key)) return { text: `Already ticked: the ${name(a.companies[0] || "")} form is marked as filled.`.replace("the  form", "this form") };
      return { tick: key, text: `Ticked: the ${a.companies.length ? `${name(a.companies[0])} ` : ""}form is marked as filled. (Your own record; Ping doesn't fill forms.)` };
    }
    // "which of these haven't I applied to?"
    if (a.roles.length && /\b(haven'?t|have not|not yet|didn'?t|did not|un)\s*(i\s+)?appl|\bnot applied\b|\bpending\b|\bleft to apply\b/.test(q)) {
      const left = a.roles.filter((r) => !r.applied);
      if (!left.length) return { text: `You've applied to all ${a.roles.length} in that message.` };
      return { text: `${left.length} of ${a.roles.length} in that message not applied yet:\n${left.map((r) => `- ${roleName(r)}`).join("\n")}` };
    }
    // "which cv for the second one?"
    const n = ordinal(q);
    if (n && a.roles.length && /\b(cv|resume|apply with)\b/.test(q)) {
      const r = n === -1 ? a.roles[a.roles.length - 1] : a.roles[n - 1];
      if (!r) return { text: `That message lists ${a.roles.length} role${a.roles.length === 1 ? "" : "s"}.` };
      return { text: r.cv ? `${roleName(r)}: apply with ${r.cv}.` : `${roleName(r)}: none of your CVs is a clear best fit for it.` };
    }
    // "which cv?" on a message with one role
    if (a.roles.length === 1 && /\b(which|what)\b.*\b(cv|resume)\b/.test(q)) {
      const r = a.roles[0];
      return { text: r.cv ? `${roleName(r)}: apply with ${r.cv}.` : `${roleName(r)}: none of your CVs is a clear best fit for it.` };
    }
    // "where is it?" on a test or list message: that test's room / slot / venue / time
    if (/\bwhere\b|\b(room|venue|slot|hall|location)\b|\bwhat time\b|\bwhen is it\b/.test(q) && (a.place.room || a.place.slot || a.place.venue || a.event)) {
      const p = a.place, bits = [p.room ? `room ${p.room}` : "", p.slot ? `slot ${p.slot}` : "", p.venue && !String(p.room || "").includes(p.venue) ? p.venue : "",
        p.time ? `reporting ${p.time}` : "", a.event && opts.when ? `test ${opts.when(a.event)}` : ""].filter(Boolean);
      return { text: `${a.companies.length ? `${name(a.companies[0])}: ` : ""}${bits.length ? bits.join(", ") : "the message doesn't give a room"}.` };
    }
    return null;
  }

  // what goes to the router or the model with a reply: the anchor as the topic ("[replying to: …; about: Groww]")
  function context(question, a) {
    if (!a) return question;
    return `${question}\n[replying to ${a.sender}'s message: "${a.text}"${a.companies.length ? `; about: ${a.companies.map(name).join(", ")}` : ""}${a.roles.length ? `; roles: ${a.roles.map(roleName).join("; ")}` : ""}]`;
  }

  const api = { anchorOf, answer, context, ordinal };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PingReply = api;
})(typeof window !== "undefined" ? window : globalThis);
