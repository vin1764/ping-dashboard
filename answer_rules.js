/* Answers from the ERP data without the AI: used when Gemini is busy or down (the ask-ping function), when the
 * function can't be reached at all (the dashboard), and in the offline ?demo=1 copy. One file for both, loaded as a
 * plain script (window.PingRules) by the page and imported by the function (globalThis.PingRules).
 *
 * It answers what was asked:
 *   - a company in the question (fuzzy: typos, "msft" -> Microsoft, "HUL" -> Hindustan Unilever): ONLY that company,
 *     its open deadlines (one line per deadline: "form + CV submission by ..."), its latest notice and your status;
 *   - a company Ping has no data on: says so;
 *   - no company but a clear intent (deadlines, tests, shortlists): that list, for the time asked about;
 *   - neither: says it couldn't tell, then what's due soon.
 * Never a count without names. Tested in tests/js/answer_rules.test.js.
 *
 * data = { now: Date, lastChecked: iso | null,
 *          roles:   [{ id, company, designation, applied, deadline, eligible, ctc, currency, cv }],
 *          items:   [{ id, company, category, title, due_at, event_at, level, pdf_status, role_ids, hidden_because, subject }],
 *          notices: [{ company, subject, notice_time }] }
 */
(function (root) {
  "use strict";
  const TZ = "Asia/Kolkata";
  const FMT = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const DAYKEY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const DAYNAME = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
  const when = (iso) => FMT.format(new Date(iso)).replace(/,/g, "");
  const dayKey = (d) => DAYKEY.format(new Date(d));
  const dayName = (d) => DAYNAME.format(new Date(d)).replace(/,/g, "");   // Deno writes "Sun, 22 Nov", Node "Sun 22 Nov"

  // ---------------------------------------------------------------- names
  const URLISH = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|io|ai|co|org|net|tech|app|dev)\b/i;
  const SUFFIX = /[\s,]+(?:private\s+limited|pvt\.?\s*ltd\.?|limited|ltd\.?|inc\.?|llp|llc|corporation|corp\.?|plc)\s*$/i;
  // display name: no bracketed website, no "Private Limited" / "Corporation" at the end, ALL CAPS made readable
  // well-known acronyms that have vowels (the rest are kept by rule: short or vowel-less words)
  const ACRONYMS = new Set("ICICI HDFC IDFC HSBC HPCL BPCL IOCL ONGC NTPC BHEL GAIL SAIL KPMG NVIDIA EXL BNY UBS DBS ITC TVS JSW EY AMEX IBM SAP AIG LTM ZS".split(" "));
  // capitals the sources themselves use for a word ("RISA" in "RISA Labs - Job Descriptions", a notice in mixed case):
  // learnt from the notices' and JDs' text (learnCasing), so a name keeps the casing its own documents give it
  const CASING = new Set();
  function learnCasing(texts) {
    for (const t of texts || []) {
      const s = String(t || "");
      if (!/[a-z]{3}/.test(s)) continue;                       // a shouted text says nothing about casing
      for (const m of s.matchAll(/\b([A-Z]{2,6})\b(?=\s+[A-Z][a-z])/g)) CASING.add(m[1]);
    }
  }
  function shortName(name) {
    let s = String(name || "").replace(/\s*\(([^()]*)\)/g, (m, inner) => (URLISH.test(inner) ? "" : m));
    for (let i = 0; i < 2; i++) s = s.replace(SUFFIX, "");
    s = s.replace(/\s{2,}/g, " ").trim() || String(name || "").trim();
    // a shouted name in title case, its acronyms kept: short words, words with no vowel, known acronyms, and words the
    // sources write in capitals ("ZS ASSOCIATES" -> "ZS Associates", "RISA LABS" -> "RISA Labs" when its JD says
    // "RISA Labs"); one shouted word stays as it is ("AIRAMATRIX")
    if (s === s.toUpperCase() && /[A-Z]{4,}/.test(s) && /\s/.test(s))
      s = s.split(/(\s+)/).map((w) => (/^[A-Z]{1,3}$|^[^AEIOU\s]+$|\d/.test(w) || ACRONYMS.has(w.replace(/[^A-Z]/g, "")) || CASING.has(w)
        ? w : w.charAt(0) + w.slice(1).toLowerCase())).join("");
    return s;
  }
  // "Auro Group([www.AuroIM.com](https://www.AuroIM.com))" -> "Auro Group", in any answer text (the model's too)
  function cleanNames(text) {
    return String(text || "").replace(/\s*\((?:\s*\[[^\]]*\]\([^)]*\)\s*|[^()]*?(?:https?:\/\/|www\.)[^()]*)\)/g, "");
  }
  const LEGAL = new Set(("private pvt limited ltd inc llp llc plc the and of co company corp corporation technologies technology " +
    "services solutions group global labs systems software india").split(" "));
  const norm = (s) => String(s || "").toLowerCase().replace(/\s*\(([^()]*)\)/g, (m, inner) => (URLISH.test(inner) ? " " : m))
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  const keyWords = (name) => norm(name).split(" ").filter((w) => w && !LEGAL.has(w));

  // cheap aliases: a word in the question -> words that must appear in the company's name
  const ALIASES = { ms: ["microsoft", "morgan stanley"], msft: ["microsoft"], goog: ["google"], amzn: ["amazon"],
    jpm: ["jp morgan", "jpmorgan", "morganchase", "morgan chase"], jpmc: ["jp morgan", "jpmorgan", "morganchase", "morgan chase"],
    gs: ["goldman"], pw: ["physicswallah", "physics wallah"], db: ["deutsche"], bofa: ["bank of america"], amex: ["american express"],
    hul: ["hindustan unilever"], pg: ["procter"], bcg: ["boston consulting"], tcs: ["tata consultancy"], ge: ["general electric"],
    deshaw: ["shaw"], qrt: ["qube"], ib: ["intelligent business"] };

  // words that are never a company: question words, intents, times, role words
  const STOP = new Set(("a an the and or but for of to in on at by from with about into is are was were be been am do does did " +
    "have has had i me my mine we you your it its this that these those there here what whats which who whom whose when where why how " +
    "hows can could would should will shall may might must please pls kindly tell show give list find get got need want know check see " +
    "any anything something everything nothing all some new open still next upcoming soon latest last first recent status update " +
    "lakh lakhs lac lacs lpa crore crores ones closed us usa " +
    "updates info information detail details about regarding re role roles job jobs company companies firm placement placements " +
    "intern internship internships erp ping ok okay thanks thank hi hello hey yes no not just only also more else other others much " +
    "many im ive id isnt dont doesnt didnt cant there theres now right like same again pending remaining left mean meaning " +
    "deadline deadlines due date dates close closes closed closing submit submitted submission submissions form forms apply applied " +
    "applying application applications register registration cv cvs resume resumes test tests exam exams assessment oa room rooms " +
    "venue slot slots interview interviews ppt shortlist shortlisted shortlists result results selected list lists ctc pay salary " +
    "package stipend lpa compensation bond eligible eligibility eligibile time timing schedule today tonight tomorrow week weekend " +
    "month day days hour hours morning evening night monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun " +
    "analyst engineer engineering developer manager management product associate data software sde intern trainee consultant " +
    "consulting finance financial quant research researcher scientist design designer marketing sales operations ops strategy " +
    "business hr core full stack frontend backend senior junior lead program programme officer executive role " +
    "use using used help look looking try go going make take put say think best good better fine sure wait start end let lets " +
    "share send link links portal website site mail email notification notifications message messages question answer " +
    "summarise summarize summary summaries jd jds description descriptions they them their would role's " +
    // where to look (a source is never a company) and Hinglish / chat fillers
    "notice notices circular circulars cdc pdf pdfs attachment attachments attached file files doc docs document documents " +
    "inbox gmail outlook drive mails emails mailed page pages search searched look looked " +
    "kya hai hain ka ki ke ko mein mai bhi aur kuch koi kab kahan kaha kitna kitni kitne batao bata bta btao bhejo dekh dekho " +
    "wala wali vala abhi kaun kon konsa konsi yaar bro bhai na nahi nhi haan ha toh plz plss pls ? " +
    "relevant anywhere located location based office city many number count cut off cutoff cgpa cg departments department " +
    "branch branches degree degrees backlog backlogs joining bonus bonuses take home breakdown breakup brekdown esop esops stock " +
    "retention relocation base fixed variable gross score scores marks rank percentile contact contacts phone poc spoc coordinator " +
    "after before day night january february march april may june july august september october november december jan feb mar apr " +
    "jun jul aug sep sept oct nov dec st nd rd th whats wheres whens hows lets yet so then too much ones one two three tonight's " +
    "allowed criteria cutoffs").split(" "));

  function editClose(a, b) {
    if (Math.abs(a.length - b.length) > 2 || Math.min(a.length, b.length) < 5) return false;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length] <= (Math.max(a.length, b.length) >= 8 ? 2 : 1);
  }

  // every company Ping knows: from the companies list, plus companies that only appear in notices
  const SCHEDULE = /placement schedule|^cdc\b|all students/i;
  function entities(data) {
    learnCasing([...(data.notices || []).map((n) => `${n.subject || ""}. ${String(n.text || "").slice(0, 3000)}`),
                 ...(data.roles || []).map((r) => String(r.jd_text || "").slice(0, 3000)),
                 ...(data.pdf_checks || []).map((c) => String(c.context || "").slice(0, 3000))]);
    const ents = [];
    const byKey = new Map();
    const add = (raw, fromRole) => {
      const kw = keyWords(raw);
      const key = kw.join(" ") || norm(raw);
      if (!key) return;
      let e = byKey.get(key);
      if (!e && !fromRole) {
        // "MICROSOFT" (a notice) belongs to "Microsoft Corporation" (the companies list)
        e = ents.find((x) => x.key.startsWith(key + " ") || key.startsWith(x.key + " "));
      }
      if (!e) {
        e = { key, words: kw.length ? kw : norm(raw).split(" "), name: shortName(raw), raw: new Set(), roles: fromRole };
        ents.push(e);
        byKey.set(key, e);
      }
      e.raw.add(raw);
      if (fromRole && !e.roles) { e.roles = true; e.name = shortName(raw); }
    };
    for (const r of data.roles || []) if (r.company) add(r.company, true);
    for (const n of data.notices || []) if (n.company && !SCHEDULE.test(n.company)) add(n.company, false);
    for (const i of data.items || []) if (i.company && !SCHEDULE.test(i.company)) add(i.company, false);
    return ents;
  }

  function tokensOf(question) { return norm(question).replace(/\b(\w+) s\b/g, "$1").split(" ").filter(Boolean); }

  // the companies a question is about
  function matchCompanies(question, data, ents) {
    ents = ents || entities(data);
    const toks = tokensOf(question);
    const q = ` ${toks.join(" ")} `;
    const joined = toks.join("");
    const hits = [];
    const used = new Set();
    // pass 1: whole names ("ather energy"); their words are taken, so "energy" can't also pick "Energy Aspects"
    for (const e of ents) {
      const whole = (e.key.length >= 3 && q.includes(` ${e.key} `)) ||
        (e.key.includes(" ") && e.key.length >= 6 && joined.includes(e.key.replace(/ /g, "")));
      if (whole) { hits.push(e); e.key.split(" ").forEach((x) => used.add(x)); }
    }
    // a later word of a name that no other company has ("namo" of "Nation with Namo")
    const wordCount = new Map();
    for (const e of ents) for (const w of new Set(e.words || [])) wordCount.set(w, (wordCount.get(w) || 0) + 1);
    // pass 2: one distinctive word, a typo of it, a prefix, initials or an alias
    for (const e of ents) {
      if (hits.includes(e)) continue;
      const w0 = e.words.find((w) => w.length >= 3) || e.words[0];
      const initials = e.words.map((w) => w[0]).join("");
      let hit = null;
      for (const t of toks) {
        if (used.has(t) || STOP.has(t) || /^\d+$/.test(t)) continue;
        if ((t === w0 && t.length >= 2) || (t.length === 2 && t === e.words[0] && /^[a-z]{2}$/.test(t)) ||
            (t.length >= 4 && e.words.indexOf(t) > 0 && wordCount.get(t) === 1 && !LEGAL.has(t)) || (t.length >= 5 && w0.length > t.length && w0.startsWith(t)) || editClose(t, w0) ||
            (t.length >= 3 && e.words.length >= 3 && t === initials)) { hit = t; break; }
        const want = ALIASES[t];
        if (want && want.some((w) => e.key.includes(w) || e.key.replace(/ /g, "").includes(w.replace(/ /g, "")))) { hit = t; break; }
      }
      if (hit) { hits.push(e); hit.split(" ").forEach((x) => used.add(x)); }
    }
    // "jpmc": a name only notices use, with no roles, gives way to the company its alias means ("JP MorganChase")
    const hasRoles = (e) => (data?.roles || []).some((r) => e.raw.has(r.company));
    for (let i = 0; i < hits.length; i++) {
      if (hasRoles(hits[i])) continue;
      const want = ALIASES[String(hits[i].name || "").toLowerCase().replace(/[^a-z0-9]/g, "")];
      const alt = want && ents.find((e) => e !== hits[i] && hasRoles(e) && want.some((w) => e.key.includes(w) || e.key.replace(/ /g, "").includes(w.replace(/ /g, ""))));
      if (alt) hits[i] = { ...alt, raw: new Set([...alt.raw, ...hits[i].raw]) };
    }
    // "Deloitte Touche Tohmatsu India" asked: that company, not also "Deloitte" (the name that matches more words wins)
    if (hits.length > 1) {
      const tok = new Set(toks);
      const score = (e) => (e.words || []).filter((w) => tok.has(w)).length;
      const best = Math.max(...hits.map(score));
      if (best >= 2) return { hits: hits.filter((e) => score(e) === best), used };
    }
    return { hits, used };
  }

  // ---------------------------------------------------------------- intent
  function intentsOf(question) {
    const q = norm(question);
    const has = (re) => re.test(q);
    const out = new Set();
    if (has(/\b(which|what|best|konsa|kaunsa|konsi|kaunsi)\s+(cv|resume)\b|\b(kon|kaun) sa (cv|resume)\b|\bapply\s+with\b|\bcv\s+(for|to use|konsa|kaunsa)\b/)) out.add("whichcv");
    // "summarise X's JD", "what's the JD for X", "what do they want for X", "job description of X"
    if (has(/\bjds?\b|\bjob desc\w*|\bwhat do they (want|look|need)|\bwhat (is|s) the role\b|\bwhat would i do\b|\bsummari[sz]e\b/)) {
      out.add("jd");
      return out;                                  // a JD question is only that (its CV/skill words aren't a deadline)
    }
    if (has(/\b(deadlines?|due|last date|closes?|closing|closed|submit\w*|submissions?|forms?|apply by|register\w*|registration)\b/) ||
        (has(/\b(cv|resume)\b/) && !out.has("whichcv"))) out.add("deadline");
    if (has(/\bshort ?list\w*|\bselected\b|\bresults?\b|\b(am|was|are|is) (i|my name) (on|in) (the |a |any )?([a-z0-9]+ ){0,4}lists?\b/)) out.add("shortlist");
    if (has(/\b(tests?|exams?|assessments?|oa|rooms?|venue|slots?|interviews?|ppt|dates?)\b/) && !has(/\blast date\b/)) out.add("test");
    if (has(/\b(ctc|pay|salary|package|stipend|lpa|compensation|bond)\b/)) out.add("pay");
    if (has(/\beligib\w*|\belig\b/)) out.add("eligible");                       // "elig?" (hurried)
    if (has(/\b(did i apply|have i applied|applied)\b/)) out.add("applied");
    if (has(/\b(bond|take ?home|joining|bonus\w*|esops?|stocks?|retention|relocation|base salary|break ?(down|up)|brekdown)\b/)) out.add("pay");
    if (has(/\bcut ?offs?\b|\bcgpa\b|\bcg\b|\b(departments?|branch\w*|degrees?)\b.*\b(apply|allowed|eligible|can)\b|\bwho can apply\b/)) out.add("eligible");
    if (has(/\b(notices?|announcements?|circulars?)\b/)) out.add("notice");
    if (has(/\bforms?\b(?! (is|are) )|\bpreference form\b/) && !has(/\bjd\b/)) out.add("form");
    // placement mail: "any mails for X", "did I get a test link for Y", "what's due from mail"
    if (has(/\b(e ?mails?|mails?|mailed|inbox|via email)\b/) || has(/\b(test|assessment|oa|interview|meeting) links?\b/)) out.add("mail");
    if (has(/\b(what|which)( all| are the| other)? roles\b|\ball (the )?roles\b|\broles? (does|do|at|in|of|hai|hain)\b|\bopenings?\b|\bpositions?\b|\bkaun(se|si)? roles?\b|^(and |the |its |their )?roles?\b|\broles$/) && !out.has("deadline")) out.add("roles");
    if (has(/\b(located|location|based (in|at)|which city|office)\b/)) out.add("location");
    else if (has(/\bwhere\b/)) out.add("test");
    if (has(/\b(score|scores|marks|rank|percentile)\b/)) out.add("score");
    if (has(/\b(contacts?|phone|poc|spoc|coordinator|email id|number of the)\b/) && !has(/\bhow many\b/)) out.add("contact");
    if (has(/\b(anything|whats|what is|something) (new )?for me\b|\bfor me today\b/) && !out.size) out.add("foryou");
    if (has(/\bwhen\b/) && !out.size) out.add("deadline").add("test");
    if (has(/\bhow many\b|\bnumber of\b|\bcount\b/)) out.add("count");
    if (out.has("score") || out.has("contact")) { out.delete("test"); out.delete("shortlist"); out.delete("deadline"); }
    return out;
  }
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  function timeRange(question, now) {
    const q = norm(question);
    const start = new Date(`${dayKey(now)}T00:00:00+05:30`).getTime();
    const day = (t, label) => ({ from: t, to: t + 86400000, label });
    if (/\bday after\b/.test(q)) return day(start + 2 * 86400000, `on ${dayName(start + 2 * 86400000)}`);
    // "25 november", "nov 25", "25th nov"
    const md = q.match(/\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) ||
      q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?\b/);
    if (md) {
      const [dd, mon] = /^\d/.test(md[1]) ? [md[1], md[2]] : [md[2], md[1]];
      const y = Number(dayKey(now).slice(0, 4));
      const t = new Date(`${y}-${String(MONTHS.indexOf(mon) + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}T00:00:00+05:30`).getTime();
      if (!isNaN(t)) return day(t, `on ${dayName(t)}`);
    }
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b(on |this |next )?${w}\\b`).test(q));
    if (wd >= 0) {
      const today = new Date(start + 12 * 3600000).getUTCDay();
      const t = start + (((wd - today + 7) % 7) || 7) * 86400000;
      return day(t, `on ${dayName(t)}`);
    }
    if (/\btomorrow\b/.test(q)) return { from: start + 86400000, to: start + 2 * 86400000, label: `tomorrow (${dayName(start + 86400000)})` };
    if (/\b(today|tonight)\b/.test(q)) return { from: now.getTime(), dayStart: start, to: start + 86400000, label: `today (${dayName(now)})` };
    if (/\bnext week\b/.test(q)) return { from: start + 7 * 86400000 - ((new Date(start).getUTCDay() + 6) % 7) * 0, to: start + 14 * 86400000, label: "in the next two weeks" };
    if (/\b(this week|week)\b/.test(q)) return { from: now.getTime(), to: now.getTime() + 7 * 86400000, label: "in the next 7 days" };
    return null;
  }

  // ---------------------------------------------------------------- deadlines, merged per company and time
  const PAST = /deadline gone|already happened|updated by a later|older than/;
  function kindOf(i) {
    const t = `${i.subject || ""} ${i.title || ""}`.toLowerCase();
    if (/\b(cv|resume)\b/.test(t)) return "CV submission";
    if (/\bform\b|google form|registration|register/.test(t)) return "form";
    if (/submi/.test(t)) return "submission";
    if (/test|assessment/.test(t)) return "test registration";
    return "application";        // a deadline extension or reminder is about the application itself
  }
  const ORDER = ["form", "CV submission", "submission", "test registration", "application", "deadline"];
  function deadlineEntries(data, ents, from, to) {
    const now = data.now.getTime();
    from = from ?? now; to = to ?? Infinity;
    const roleById = new Map((data.roles || []).map((r) => [r.id, r]));
    const entOf = (company) => ents.find((e) => e.raw.has(company));
    const out = [];
    for (const r of data.roles || []) {
      const at = r.deadline && new Date(r.deadline).getTime();
      if (!at || at <= now || at < from || at >= to || r.eligible === false) continue;
      out.push({ ent: entOf(r.company), at, kind: "application", roles: [r.designation], applied: !!r.applied, fromRole: true });
    }
    for (const i of data.items || []) {
      const at = i.due_at && new Date(i.due_at).getTime();
      if (!at || at <= now || at < from || at >= to || !i.company) continue;
      if (!["todo", "form", "deadline"].includes(i.category) || PAST.test(i.hidden_because || "")) continue;
      // hidden with no reason = not about you (e.g. a submission for a shortlist you're not on); hidden because a
      // digest or list message carries it = still yours
      if (i.level === "hidden" && !/digest|message|collapse|merged/.test(i.hidden_because || "")) continue;
      const roles = (i.role_ids || []).map((id) => roleById.get(id)?.designation).filter(Boolean);
      const paren = /\(([^)]+)\)/.exec(i.title || "");
      out.push({ ent: entOf(i.company), at, kind: kindOf(i), roles: roles.length ? roles : paren ? [paren[1]] : [] });
    }
    // one line per company and deadline: "Meesho (Senior Associate - BM): form + submission by Sun 22 Nov 18:00"
    const merged = new Map();
    for (const e of out.filter((x) => x.ent)) {
      const k = `${e.ent.key}|${Math.floor(e.at / 60000)}`;
      const m = merged.get(k) || { ent: e.ent, at: e.at, kinds: new Set(), roles: new Set(), apps: [] };
      m.kinds.add(e.kind);
      e.roles.forEach((r) => m.roles.add(r));
      if (e.fromRole) m.apps.push(e.applied);
      merged.set(k, m);
    }
    return [...merged.values()].sort((a, b) => a.at - b.at || a.ent.name.localeCompare(b.ent.name));
  }
  function relTime(at, now) {
    const mins = Math.round((at - now.getTime()) / 60000);
    if (dayKey(at) !== dayKey(now) || mins <= 0) return "";
    return ` (today, in ${mins >= 60 ? `${Math.floor(mins / 60)}h ` : ""}${mins % 60}m)`;
  }
  const names = (list, n = 3) => (list.length > n ? `${list.slice(0, n).join(", ")} +${list.length - n} more` : list.join(", "));
  function deadlineLine(m, now, withCompany = true) {
    const roles = [...m.roles];
    const kinds = [...m.kinds].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    const status = m.apps.length && m.apps.every(Boolean) ? " · ✓ applied" : m.apps.some(Boolean) ? ` · applied to ${m.apps.filter(Boolean).length} of ${m.apps.length}`
      : m.apps.length ? " · not applied" : "";
    const who = withCompany ? `${m.ent.name}${roles.length ? ` (${names(roles)})` : ""}` : (roles.length ? names(roles) : "");
    return `- ${who}: ${kinds.join(" + ")} by ${when(m.at)}${relTime(m.at, now)}${status}`;
  }
  function cap(lines, n = 12) { return lines.length > n ? [...lines.slice(0, n), `- +${lines.length - n} more`] : lines; }

  // ---------------------------------------------------------------- answers
  function latestNotice(data, ent) {
    return (data.notices || []).filter((n) => ent.raw.has(n.company))
      .sort((a, b) => String(b.notice_time).localeCompare(String(a.notice_time)))[0] || null;
  }

  // ---------------------------------------------------------------- job descriptions
  // The summary Ping made of a role's JD (roles.jd_summary, from the JD's own text: ping/jd.py), at most 120 words:
  // role & team, what you'd do, must-haves, location, eligibility, anything unusual. Never written fresh here.
  const words = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
  function jdAnswer(role, name) {
    const who = `${name} (${role.designation})`;
    if (role.jd_source === "link-unreadable" && role.jd_url) return `${who}: The JD is a link I can't open: ${role.jd_url}`;
    const s = role.jd_summary;
    // a link Ping couldn't open, next to the JD it did find (the ERP's details)
    const linkNote = role.jd_url && role.jd_source === "detail" ? `\nThe full JD is a link I can't open: ${role.jd_url}` : "";
    const one = (v) => (Array.isArray(v) ? v.filter(Boolean).join("; ") : v ? String(v) : "");
    if (!s) {
      if (role.jd_text && ["notice", "mail"].includes(role.jd_source))
        return `${who}: the JD is in ${docLabel(role)}${role.jd_url ? ` — [Open](${role.jd_url})` : ""}.\n${String(role.jd_text).split(/\s+/).slice(0, 60).join(" ")}…`;
      if (role.jd_text) return `${who}: ${String(role.jd_text).split(/\s+/).slice(0, 90).join(" ")}…` + linkNote;
      const note = String(role.jd_note || "").trim();
      // the ERP's own words when they say something ("As mentioned in Registration Email"), not "-" or "NA"
      const said = /[a-z]{3}/i.test(note) && !/^(n\/?a|nil|none|no jd on the erp)$/i.test(note) ? ` (the ERP says: "${note.slice(0, 80)}")` : "";
      return `${who}: no JD on the ERP${said}.`;
    }
    const team = one(s.role_team);
    const lines = [team && team.toLowerCase() !== String(role.designation || "").toLowerCase() ? `${who}: ${team}` : `${who}:`];
    if ((s.do || []).length) lines.push("What you'd do:", ...s.do.slice(0, 3).map((x) => `- ${x}`));
    if ((s.must_have || []).length) lines.push(`Must-have: ${s.must_have.slice(0, 5).join("; ")}`);
    if (one(s.location)) lines.push(`Location: ${one(s.location)}`);
    const elig = one(s.eligibility) || (role.cgpa_cutoff ? `CG cut-off ${role.cgpa_cutoff} (ERP)` : "");
    if (elig) lines.push(`Eligibility: ${elig}`);
    const odd = [...(s.unusual || [])];
    if (role.bond && !odd.some((x) => /bond|service/i.test(x)) && !/^no$/i.test(String(role.bond).trim())) odd.push(`bond: ${role.bond} (ERP)`);
    if (odd.length) lines.push(`Unusual: ${odd.slice(0, 3).join("; ")}`);
    // at most 120 words: drop from the end of the longest lists first
    let out = lines;
    // at most 7 lines (8 with where it came from): the last "what you'd do" points go first
    while (out.length > 7 && out.some((l, k) => k > 1 && l.startsWith("- "))) {
      const i = out.findLastIndex((l) => l.startsWith("- "));
      out = out.filter((_, k) => k !== i);
    }
    while (words(out.join(" ")) > 120 && out.length > 2) {
      const i = out.findLastIndex((l) => l.startsWith("- "));
      out = out.filter((_, k) => k !== (i > 1 ? i : out.length - 1));
    }
    const src = role.jd_source === "attachment" ? "the JD file on the ERP" : role.jd_source === "link" ? "the JD link"
      : role.jd_source === "detail" ? "the ERP's role details"
      : ["notice", "mail"].includes(role.jd_source) ? `${docLabel(role)}${role.jd_url ? ` — [Open](${role.jd_url})` : ""}`
      : "the ERP's job description";
    return out.join("\n") + `\n(From ${src}.)` + linkNote;
  }

  // ---------------------------------------------------------------- one lookup, every source
  // A fact about a company (its JD, CTC, eligibility, location, deadline) is looked for in this order: the role page
  // (the companies list), the notices' text, the notices' files (a JD PDF kept whole: ping/notice_jd.py), placement
  // mail and its attachments, the form pages. Every answer says where it came from, with a link; an answer that says
  // something isn't there is given only after every source was looked at ("Not on the ERP, in notices, or in
  // placement mail as of 21:12"). A source the student names is looked at first.
  const DM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
  const dayMon = (iso) => (iso ? DM.format(new Date(iso)) : "");
  const hhmm = (iso) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "now");
  const FIELD = {
    jd: { word: "JD", re: /job descriptions?|\bjds?\b|role descriptions?|roles? (and|&) responsibilit\w*|key responsibilit\w*/i },
    pay: { word: "CTC", re: /\bctc\b|\blpa\b|\bstipend\b|\bcompensation\b|\bsalary\b|\bpackage\b/i },
    eligible: { word: "eligibility", re: /eligib\w*|\bcgpa\b|\bcpi\b|who can apply|branches? allowed|open to (all )?(branches|departments)/i },
    location: { word: "location", re: /\blocations?\b|\bbased (in|at)\b|\bon-?site\b|\brelocat\w*/i },
    deadline: { word: "deadline", re: /\bdeadline\b|\blast date\b|\bapply by\b|\btill\b|\buntil\b/i },
  };
  const ATTACHED = /\b(attached|attachment|pfa|enclosed|find the (jd|file|pdf))\b/i;
  const SOURCE_RE = { notice: /\b(notices?|circulars?|cdc)\b/, attachment: /\b(pdfs?|attachments?|attached|files?|docs?|documents?)\b/,
                      mail: /\b(e ?mails?|mails?|inbox|gmail|outlook)\b/, form: /\b(forms? (page|link)s?|google forms?)\b/,
                      erp: /\b(erp|portal|companies list|role page)\b/ };
  const SOURCE_WORD = { erp: "on the ERP", notice: "in notices", attachment: "in notice files", mail: "in placement mail", form: "on form pages" };
  function sourcesOf(question) { const q = norm(question); return Object.keys(SOURCE_RE).filter((k) => SOURCE_RE[k].test(q)); }
  const noticeFile = (n) => (n && n.year && n.notice_id != null
    ? `https://erp.iitkgp.ac.in/TrainingPlacementSSO/AdmFilePDF.htm?type=NOTICE&year=${encodeURIComponent(n.year)}&id=${n.notice_id}` : null);
  // a text about this company: its own name, or the name's first word as a whole word ("EY", not "global" of
  // "EY Global Delivery Services", which would also find Zeta Global)
  function aboutEnt(ent, text, company) {
    if (company && ent.raw.has(company)) return true;
    const w = (ent.words || []).find((x) => x.length >= 2);
    return !!w && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(norm(text || ""));
  }
  function sentence(text, re) {
    const t = String(text || "").replace(/\s+/g, " ");
    const m = t.match(new RegExp(`[^.!?\\n]{0,90}(?:${re.source})[^.!?\\n]{0,90}`, "i"));
    return m ? m[0].trim().slice(0, 160) : "";
  }
  function lookup(ent, field, data, first = []) {
    const F = FIELD[field];
    const found = [];
    const roles = (data.roles || []).filter((r) => ent.raw.has(r.company));
    // 1. the role page (the companies list and the role's own details / JD file / JD link)
    const has = { jd: (r) => ["inline", "attachment", "link", "detail"].includes(r.jd_source) && (r.jd_text || r.jd_summary),
                  pay: (r) => !!Number(r.ctc) || Object.entries(r.pay || {}).some(([k, v]) => /ctc|salary|stipend|take ?home|fixed/i.test(k) && /\d/.test(String(v))),
                  eligible: (r) => r.cgpa_cutoff != null || (r.allowed || []).length > 0,
                  location: (r) => !!r.jd_location, deadline: (r) => !!r.deadline }[field] || (() => false);
    const onPage = roles.filter(has);
    if (onPage.length) found.push({ where: "erp", label: "the companies list", roles: onPage });
    // 2-3. the notices and their files (a JD PDF Ping kept whole, or a notice that says the JD is attached)
    const notices = (data.notices || []).filter((n) => aboutEnt(ent, `${n.subject || ""} ${n.text || ""}`, n.company))
      .sort((a, b) => String(b.notice_time || "").localeCompare(String(a.notice_time || "")));
    const seenFile = new Set();
    for (const r of roles.filter((x) => ["notice", "mail"].includes(x.jd_source) && (field === "jd" || F.re.test(x.jd_text || "")))) {
      const key = r.jd_url || r.jd_note;
      if (seenFile.has(key)) { found.find((f) => f.key === key).roles.push(r); continue; }
      seenFile.add(key);
      found.push({ where: r.jd_source === "mail" ? "mail" : "attachment", key, label: docLabel(r), link: r.jd_url,
                   roles: [r], snippet: field === "jd" ? "" : sentence(r.jd_text, F.re) });
    }
    for (const n of notices) {
      const text = `${n.subject || ""}. ${n.text || n.preview || ""}`;
      const chk = (data.pdf_checks || []).find((c) => c.notice_id === n.id);
      const file = n.has_attachment || chk ? noticeFile(n) : null;
      const label = `the CDC notice PDF (${dayMon(n.notice_time)})`;
      if ([...seenFile].some((k) => String(k).includes(`notice ${n.notice_id} `) || String(k).includes(`id=${n.notice_id}`)) ||
          roles.some((r) => /posted again as/.test(r.jd_note || "") && new RegExp(`\\b${n.notice_id}\\b`).test(r.jd_note))) continue;
      if (chk?.status === "jd" && (field === "jd" || F.re.test(chk.context || ""))) {
        found.push({ where: "attachment", label, link: file, at: n.notice_time, nid: n.notice_id, snippet: field === "jd" ? "" : sentence(chk.context, F.re) });
      } else if (F.re.test(text)) {
        const inFile = file && ATTACHED.test(text);
        found.push({ where: inFile ? "attachment" : "notice", label: inFile ? label : `a CDC notice (${dayMon(n.notice_time)})`, nid: n.notice_id,
                     link: file || null, at: n.notice_time, snippet: inFile && field === "jd" ? "" : sentence(text, F.re), said: inFile && chk?.status !== "jd" });
      }
    }
    // 4. placement mail and its attachments
    for (const m of (data.emails || []).filter((x) => aboutEnt(ent, `${x.subject || ""} ${x.snippet || ""}`, x.company))) {
      const t = `${m.subject || ""}. ${m.snippet || ""}`;
      const doc = m.pdf?.status === "jd";
      if ((doc && (field === "jd" || F.re.test(m.pdf.context || ""))) || F.re.test(t)) {
        const who = String(m.sender || "").replace(/\s*<[^>]*>/g, "").trim() || "placement mail";
        found.push({ where: "mail", label: `the ${dayMon(m.received_at)} mail from ${who}${doc && m.pdf.file && m.pdf.file !== "(mail text)" ? " (PDF attached)" : ""}`,
                     link: m.main_link || null, at: m.received_at, snippet: doc && field === "jd" ? "" : sentence(doc ? m.pdf.context : t, F.re) });
      }
    }
    // 5. the form pages linked for the company
    for (const f of (data.forms || []).filter((x) => [x.company, ...(x.companies || [])].some((c) => c && aboutEnt(ent, c, c)))) {
      if (F.re.test(`${f.title || ""} ${f.description || ""}`) || (field === "deadline" && f.due_at && new Date(f.due_at) > data.now))
        found.push({ where: "form", label: `the form "${f.title || "form"}"`, link: f.final_url || f.link || null, at: f.due_at,
                     snippet: field === "deadline" && f.due_at ? `due ${when(f.due_at)}` : "" });
    }
    // the same notice posted again (same subject, a file each): one entry, the first posting, "posted again as 1860"
    const files = found.filter((f) => f.where === "attachment" && f.at && f.nid);
    for (const f of files) {
      const twin = files.find((g) => g !== f && !g.dup && !f.dup && g.at > f.at && g.said === f.said);
      if (twin) twin.dup = true;
    }
    for (let i = found.length - 1; i >= 0; i--) if (found[i].dup) found.splice(i, 1);
    const order = ["erp", "notice", "attachment", "mail", "form"];
    const firsts = first.flatMap((x) => (x === "notice" ? ["notice", "attachment"] : [x]));
    const rank = (w) => (firsts.includes(w) ? -10 + firsts.indexOf(w) : order.indexOf(w));
    found.sort((a, b) => rank(a.where) - rank(b.where));
    return { found, searched: ["erp", "notice", "attachment", "mail", "form"] };
  }
  // where a role's JD document is, in words ("the CDC notice PDF (22 Nov)", "the 22 Nov mail from CDC (PDF attached)")
  function docLabel(r) {
    const note = String(r.jd_note || "");
    if (r.jd_source === "mail") return note.replace(/ \(one PDF for several roles\)$/, "") || "placement mail";
    const d = (note.match(/\((\d{1,2} [A-Z][a-z]{2})/) || [])[1];
    return `the CDC notice PDF${d ? ` (${d})` : ""}`;
  }
  // one chip per role that asks for that role's JD ("[Associate Product Manager](#ask:RISA Labs Associate Product Manager jd)")
  const askChip = (label, ask) => `[${String(label).replace(/[[\]]/g, "")}](#ask:${encodeURIComponent(ask)})`;
  function roleChips(name, roles, what = "jd") {
    return roles.slice(0, 12).map((r) => askChip(r.designation, `${name} ${r.designation} ${what}`)).join(" ");
  }
  // "For which company?" and chips for the 3 companies with the newest notices (that have roles)
  function clarifyCompany(data, ents, what = "roles") {
    ents = ents || entities(data);
    const withRoles = ents.filter((e) => (data.roles || []).some((r) => e.raw.has(r.company)));
    const latest = new Map();
    for (const n of data.notices || []) {
      const e = withRoles.find((x) => x.raw.has(n.company));
      if (e && String(n.notice_time || "") > String(latest.get(e) || "")) latest.set(e, n.notice_time);
    }
    const pick = [...latest.entries()].sort((a, b) => String(b[1]).localeCompare(String(a[1]))).map(([e]) => e).slice(0, 3);
    const ask = (e) => (what === "roles" ? `which roles at ${e.name}` : `${e.name} ${what}`);
    return `For which company?\n${pick.map((e) => askChip(e.name, ask(e))).join(" ")}`.trim();
  }
  // "Not on the ERP, in notices, or in placement mail as of 21:12"
  const asOfLine = (data) => `as of ${hhmm(data.lastChecked || data.now)}`;
  function absentLine(field, name, data) {
    return `No ${FIELD[field].word} for ${name} on the ERP, in notices, or in placement mail ${asOfLine(data)}.`;
  }
  function foundLine(f, field, name, n = 1) {
    const what = field === "jd" ? (n > 1 ? "JDs are" : "JD is") : `${FIELD[field].word} is`;
    const open = f.link ? ` — [Open](${f.link})` : "";
    const quote = f.snippet ? `: "${f.snippet}"` : "";
    if (f.said) return `${name}: ${f.label.replace(/^the CDC notice PDF/, "a CDC notice")} says the ${FIELD[field].word}${n > 1 ? "s are" : " is"} attached${open}.`;
    return `${name} ${what} in ${f.label}${quote}${open}.`;
  }
  // the answer about the source the student named ("on mail?"): found there, or not there (then where it is)
  function namedSourceLine(field, name, lk, named) {
    const looked = named.flatMap((x) => (x === "notice" ? ["notice", "attachment"] : x === "attachment" ? ["attachment", "mail"] : [x]));
    const hit = lk.found.find((f) => looked.includes(f.where));
    if (hit) return null;
    const where = named.map((s) => SOURCE_WORD[s]).filter(Boolean).join(" or ");
    return where ? `Nothing ${where} for the ${name} ${FIELD[field].word}.` : null;
  }

  function jdForCompany(ent, question, data) {
    const all = (data.roles || []).filter((r) => ent.raw.has(r.company));
    let roles = all;
    // a role named in the question narrows it ("searce associate data engineer")
    const q = new Set(tokensOf(question));
    const initialsOf = (d) => String(d || "").toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z0-9]+/).filter((w) => w && !["of", "and", "the", "in", "for", "us"].includes(w)).map((w) => w[0]).join("");
    const abbr = (r) => [...q].reduce((n, t) => n + (t.length >= 2 && /^[a-z]+$/.test(t) && !STOP.has(t) ? (initialsOf(r.designation) === t ? 2 : 0) : 0), 0);
    const scored = roles.map((r) => [r, keyWords(r.designation).filter((w) => q.has(w) && !LEGAL.has(w) && !MINOR.test(w)).length + abbr(r)]);
    const best = Math.max(0, ...scored.map((x) => x[1]));
    const named = best > 0;
    if (named) roles = scored.filter((x) => x[1] === best).map((x) => x[0]);
    const sources = sourcesOf(question);
    const lk = lookup(ent, "jd", data, sources);
    const lines = [];
    const miss = sources.length ? namedSourceLine("jd", ent.name, lk, sources) : null;
    if (miss) lines.push(miss);
    if (!all.length) {
      const f = lk.found[0];
      return [...lines, f ? foundLine(f, "jd", ent.name) : `I don't have a ${ent.name} role on your companies list, and no ${ent.name} JD in notices or placement mail ${asOfLine(data)}.`].join("\n");
    }
    const own = roles.filter((r) => ["inline", "attachment", "link", "detail", "link-unreadable"].includes(r.jd_source) && (r.jd_text || r.jd_summary || r.jd_url));
    // one role (or a role named): its JD, then where it came from
    if (roles.length === 1 || (named && roles.length <= 2)) {
      // a source named that doesn't have it: that first, then where it is in one line (the summary is one ask away)
      if (miss && own.length) {
        const first = jdAnswer(roles[0], ent.name).split("\n")[0];
        return [...lines, `It's on the ERP: ${first.replace(/:$/, "")}`, `Ask "${ent.name} jd" for the summary.`].join("\n");
      }
      const out = roles.map((r) => jdAnswer(r, ent.name));
      const r0 = roles[0];
      if (!own.length && !["notice", "mail"].includes(r0.jd_source)) {
        const f = lk.found.find((x) => x.where !== "erp");
        const note = String(r0.jd_note || "").trim();
        const said = /[a-z]{3}/i.test(note) && !/^(n\/?a|nil|none|no jd on the erp)$/i.test(note) ? ` The ERP's JD field says: "${note.slice(0, 80)}".` : "";
        out.splice(0, out.length, f ? foundLine(f, "jd", `${ent.name} (${r0.designation})`) : absentLine("jd", `${ent.name} (${r0.designation})`, data) + said);
      }
      return [...lines, ...out].join("\n\n");
    }
    // several roles: one line per source, never one line per role saying the same thing
    const docs = lk.found.filter((f) => f.where !== "erp");
    const byDoc = docs.filter((f) => f.roles);
    // a source you named that doesn't have it: that, and where it is, in one sentence (never only "nothing in mail")
    if (miss && docs.length) {
      const f = byDoc[0] || docs[0];
      lines.splice(0, lines.length, `${miss} It's in ${f.label}${f.link ? ` — [Open](${f.link})` : ""}.`);
      return lines.join("\n");
    }
    for (const f of byDoc) {
      const n = f.roles.length;
      lines.push(`${ent.name} ${n === roles.length ? (n === 1 ? "JD is" : "JDs are") : `JDs for ${n} of ${roles.length} roles are`} in ${f.label}${f.link ? ` — [Open](${f.link})` : ""}.`);
    }
    if (!byDoc.length && docs.length) lines.push(foundLine(docs[0], "jd", ent.name, roles.length));
    // the roles as chips: each asks for that role's JD
    if (docs.length && roles.length > 1) lines.push(roleChips(ent.name, roles));
    if (own.length) lines.push(`${ent.name}: ${own.length === roles.length ? `all ${own.length}` : `${own.length} of ${roles.length}`} roles have a JD on the ERP. Tap one:`);
    const covered = new Set([...byDoc.flatMap((f) => f.roles.map((r) => r.id)), ...own.map((r) => r.id)]);
    const rest = roles.filter((r) => !covered.has(r.id));
    if (rest.length && !docs.length) lines.push(rest.length === roles.length
      ? `${ent.name}: ${roles.length} roles, ${absentLine("jd", ent.name, data).replace(/^No JD for .*? (on the ERP)/, "no JD $1")}`
      : `${ent.name}: ${rest.length} more role${rest.length === 1 ? "" : "s"} with no JD on the ERP, in notices, or in placement mail ${asOfLine(data)}.`);
    if (own.length && !docs.length) lines.push(roleChips(ent.name, own));
    return [...new Set(lines)].join("\n");
  }

  // ---------------------------------------------------------------- one company: the parts asked about
  const money = (v, cur) => (v == null || v === "" || isNaN(Number(v)) ? String(v ?? "") : `${Number(v).toLocaleString("en-IN")}${cur ? ` ${cur}` : ""}`);
  const PAYF = /ctc|salary|gross|take ?home|bonus|bond|stipend|esop|stock|variable|incentive|retention|relocation|joining|allowance|compensation|base/i;
  // the pay parts a question names ("joining bonus", "take home", "bond"): only those fields; none named: all of them
  const PART = [["bond", /\bbonds?\b/, /bond/i], ["take home", /take ?home/, /take ?home/i], ["joining", /joining/, /joining/i],
    ["retention", /retention/, /retention/i], ["relocation", /relocation/, /relocation/i], ["esop", /esops?|stocks?/, /esop|stock/i],
    ["base", /\bbase\b|\bfixed\b/, /base|fixed/i], ["variable", /variable|incentive/, /variable|incentive/i]];
  // roles of a company, narrowed by role words in the question ("same for analyst role?")
  const MINOR = /^(i|ii|iii|iv|v|vi|1|2|3|a|an)$/;
  // the roles the question names by their own words; the company's name is never one ("Data Scientist I, Navi" isn't
  // picked out by "navi")
  function narrow(roles, question, ent = null) {
    const own = new Set((ent && ent.words) || []);
    const q = new Set(tokensOf(question || "").filter((w) => !own.has(w)));
    const scored = roles.map((r) => [r, keyWords(r.designation).filter((w) => q.has(w) && !LEGAL.has(w) && !MINOR.test(w)).length]);
    const best = Math.max(0, ...scored.map((x) => x[1]));
    return best > 0 ? scored.filter((x) => x[1] === best).map((x) => x[0]) : roles;
  }
  const label = (ent, r) => `${ent.name} (${r.designation})`;
  const hasPay = (r) => !!Number(r.ctc) || Object.entries(r.pay || {}).some(([k, v]) => /ctc|salary|stipend|take ?home|fixed/i.test(k) && /\d/.test(String(v)));
  const numOf = (r, re) => Number(String(Object.entries(r.pay || {}).find(([k, v]) => re.test(k) && /^\s*[\d,.]+\s*$/.test(String(v)))?.[1] || "").replace(/,/g, "")) || 0;
  const ctcOf = (r) => Number(r.ctc) || numOf(r, /1st year ctc/i) || numOf(r, /^ctc$/i) || numOf(r, /gross/i) || numOf(r, /fixed take home/i);
  // the breakup's own "Total CTC: ₹36 LPA" when it differs from the first-year figure
  const totalOf = (r) => (String(Object.entries(r.pay || {}).find(([k]) => /ctc break ?up/i.test(k))?.[1] || "").match(/total ctc\s*[:\-]?\s*(₹?\s*[\d.,]+\s*(?:lpa|l\b|lakhs?|cr))/i) || [])[1];
  // the roles with pay, grouped by their CTC as the answer says it: "39,36,000 INR" -> [designations]
  function ctcGroups(roles) {
    const byCtc = new Map();
    for (const r of (roles || []).filter(hasPay)) {
      const k = (ctcOf(r) ? money(ctcOf(r), r.currency || "INR") : "not given") + (totalOf(r) ? `, total CTC ${totalOf(r).replace(/\s+/g, " ")}` : "");
      byCtc.set(k, [...(byCtc.get(k) || []), r.designation]);
    }
    return byCtc;
  }
  function payLinesFor(ent, r, question) {
    const fields = r.pay || {};
    const q = norm(question || "");
    const parts = PART.filter(([, inQ]) => inQ.test(q));
    const pick = Object.entries(fields).filter(([k, v]) => PAYF.test(k) && String(v ?? "").trim() !== "" &&
      (!parts.length || parts.some(([, , inField]) => inField.test(k))));
    const head = `${label(ent, r)}: CTC ${r.ctc ? money(r.ctc, r.currency || "INR") : "not given"}`;
    if (parts.length === 1 && parts[0][0] === "bond") {
      const b = fields.Bonds ?? r.bond;
      const none = /^(no|nil|none|0)$/i.test(String(b ?? "").trim()) || Number(fields["Bond Amount"]) === 0;
      return `${label(ent, r)}: ${b == null ? "the ERP doesn't say whether there's a bond" : none ? "no bond (Bonds: No)" : `bond: ${b}${fields["Bond Amount"] ? `, amount ${money(fields["Bond Amount"])}` : ""}${fields["Bond Duration"] ? `, ${fields["Bond Duration"]}` : ""}`}.`;
    }
    if (!pick.length) return parts.length ? `${label(ent, r)}: the ERP doesn't give ${parts.map((p) => p[0]).join(" or ")}.` : `${head}.`;
    return `${parts.length ? label(ent, r) : head}: ${pick.map(([k, v]) => `${k}: ${/^\d+(\.\d+)?$/.test(String(v).trim()) ? money(v) : String(v).trim()}`).join("; ")}.`;
  }
  function eligibleLine(ent, r, data, question) {
    const p = data.profile || {};
    const bits = [];
    if (r.cgpa_cutoff != null && r.cgpa_cutoff !== "") {
      const cut = Number(r.cgpa_cutoff);
      bits.push(`CG cut-off ${cut % 1 ? cut : cut.toFixed(1)}` + (p.cgpa != null ? `, your CGPA ${Number(p.cgpa).toFixed(1)}: ${Number(p.cgpa) >= cut ? "met" : "not met"}` : ""));
    } else bits.push("no CG cut-off given");
    const depts = [...new Set((r.allowed || []).map((a) => a.department).filter(Boolean))];
    if (/\b(department|branch|who can apply)/.test(norm(question || ""))) bits.push(depts.length ? `departments allowed: ${depts.join(", ")}` : "the ERP doesn't list departments");
    if (r.backlog_rule) bits.push(`backlogs: ${r.backlog_rule}`);
    const status = r.eligible === true ? "eligible (ERP)" : r.eligible === false ? "not eligible (ERP)"
      : !p.department || !p.degree ? "the rest can't be checked until your department and degree are on the Profile page" : "eligibility not sure";
    return `${label(ent, r)}: ${bits.join("; ")}; ${status}.`;
  }
  function testLines(items, now) {
    return items.map((i) => {
      const at = i.event_at && new Date(i.event_at);
      const pdf = i.pdf || {};
      const row = pdf.details || {};
      const t = String(i.title || "");
      const where = [i.venue && !t.includes(i.venue) ? i.venue : "", row.room && !t.includes(row.room) ? `your room: ${row.room}` : "",
                     row.slot && !t.includes(row.slot) ? `your slot: ${row.slot}` : ""].filter(Boolean).join(" · ");
      const st = pdf.status || i.pdf_status;
      // never an absence ("not on it"): only "couldn't find your roll number" (a file read in full) or "couldn't read it"
      const list = /you're (now )?on|you are on|couldn't (find|read)/i.test(t) ? "" : st === "yes" ? "you're on the list"
        : st === "no" ? "I couldn't find your roll number in it; please check the list yourself" : st === "unknown" ? "I couldn't read the file reliably; check it yourself" : "";
      const said = at && t.includes(HM.format(at));
      const time = at ? `${said ? "" : ` Test ${when(at.toISOString())}.`}${at < now ? ` (${dayKey(at) === dayKey(now) ? "earlier today, " : ""}over)` : relTime(at.getTime(), now) || ""}` : "";
      return `- ${i.title}${time}${where ? ` · ${where}` : ""}${list ? ` · ${list}` : ""}`;
    });
  }
  const isListItem = (i) => ["test", "shortlist", "result", "offer"].includes(i.category) || ["test_rooms", "shortlist", "result", "interview"].includes(i.kind);

  // The roles a follow-up pointed at in Ping's last answer ("those 4", "the US ones", "the closed one"), as the
  // model read them: only those roles, the fact asked about them (none asked: each with where it stands)
  const statusOf = (r, now) => r.applied ? "✓ applied" : r.eligible === false ? "not eligible"
    : r.deadline && new Date(r.deadline) > now ? `open till ${when(r.deadline)}` : r.deadline ? `closed ${when(r.deadline)}` : "no deadline yet";
  function subsetAnswer(ent, roles, all, intents, data, question) {
    const now = data.now, lines = [];
    const of = roles.length === all.length ? `${roles.length}` : `${roles.length} of ${all.length}`;
    if (intents.has("pay")) {
      const g = ctcGroups(roles);
      lines.push(g.size ? `${ent.name} CTC: ${[...g.entries()].map(([k, v]) => `${k} (${names(v, 5)})`).join("; ")}.` : `No CTC on the ERP for ${names(roles.map((r) => r.designation), 5)}.`);
    }
    if (intents.has("applied")) {
      const ap = roles.filter((r) => r.applied).map((r) => r.designation), not = roles.filter((r) => !r.applied).map((r) => r.designation);
      lines.push(ap.length ? `You applied to ${names(ap, 5)}${not.length ? `; not to ${names(not, 5)}` : ""}.` : `You haven't applied to ${roles.length === 1 ? roles[0].designation : `any of these ${roles.length}`}.`);
    }
    if (intents.has("eligible")) lines.push(roles.map((r) => eligibleLine(ent, r, data, question)).join("\n"));
    if (!lines.length || intents.has("roles") || intents.has("deadline"))
      lines.unshift(`${ent.name}, ${roles.length === 1 ? "the role" : `the ${of} roles`}:\n` + roles.map((r) => `- ${r.designation} · ${statusOf(r, now)}`).join("\n"));
    return lines.join("\n");
  }

  function aboutCompany(ent, intents, data, ents, checked, question, spec = {}) {
    if (intents.has("jd")) return jdForCompany(ent, question, data);
    const now = data.now;
    const all = (data.roles || []).filter((r) => ent.raw.has(r.company));
    const set = Array.isArray(data.roleSet) && data.roleSet.length ? new Set(data.roleSet.map((x) => norm(x))) : null;
    const subset = set ? all.filter((r) => set.has(norm(r.designation))) : [];
    if (subset.length) return subsetAnswer(ent, subset, all, intents, data, question);
    const roles = narrow(all, spec.roleQuestion || question, ent);
    const items = (data.items || []).filter((i) => i.company && ent.raw.has(i.company));
    const lines = [];
    const open = deadlineEntries(data, ents).filter((m) => m.ent === ent);
    const notice = latestNotice(data, ent);
    const noticeLine = notice ? `Last ${ent.name} notice: "${notice.subject}", ${when(notice.notice_time)}.` : `No ${ent.name} notice in the data yet.`;
    let saidNotice = false, saidApplied = false;

    if (intents.has("score")) lines.push(`I don't have your scores: the ERP doesn't publish test scores or ranks for ${ent.name}.`);
    if (intents.has("contact")) lines.push(`I don't have contact details for ${ent.name}: Ping leaves out names and phone numbers from notices.`);
    const sources = sourcesOf(question);
    // a fact not on the role page: every other source is looked at before saying it isn't there
    const elsewhere = (field) => {
      const lk = lookup(ent, field, data, sources);
      const miss = sources.length ? namedSourceLine(field, ent.name, lk, sources) : null;
      const f = lk.found.find((x) => x.where !== "erp");
      return [miss, f ? foundLine(f, field, ent.name) : absentLine(field, ent.name, data)].filter(Boolean).join("\n");
    };
    if (intents.has("location")) {
      const locs = roles.map((r) => r.jd_location && `${label(ent, r)}: ${r.jd_location}`).filter(Boolean);
      lines.push(locs.length ? [...new Set(locs)].slice(0, 3).join("\n") : elsewhere("location"));
    }
    if (intents.has("whichcv")) {
      const withCv = roles.filter((r) => r.cv);
      lines.push(withCv.length ? withCv.map((r) => `${label(ent, r)}: apply with ${r.cv}.`).join("\n")
        : `No CV suggestion for ${ent.name} yet (it comes from your targets and CVs on the Profile page).`);
    }
    // every role of the company, one short line each with where you stand
    if (intents.has("roles")) lines.push(`${ent.name} roles (${all.length}):\n` + all.map((r) => `- ${r.designation} · ${r.applied ? "✓ applied"
      : r.eligible === false ? "not eligible" : r.deadline && new Date(r.deadline) > now ? `open till ${when(r.deadline)}` : r.deadline ? "closed" : "no deadline yet"}`).join("\n"));
    if (intents.has("form") && !intents.has("pay") && !intents.has("eligible")) {
      const now2 = data.now.getTime();
      const fs = (data.forms || []).filter((f) => [f.company, ...(f.companies || [])].some((c) => c && aboutEnt(ent, c, c)));
      const todos = items.filter((i) => i.todo?.action === "fill_form" && i.due_at);
      const open2 = [...fs.filter((f) => f.due_at && new Date(f.due_at).getTime() > now2 && !f.closed).map((f) => ({ at: f.due_at, link: f.final_url || f.link, what: f.purpose || "form" })),
                     ...todos.filter((i) => new Date(i.due_at).getTime() > now2).map((i) => ({ at: i.due_at, link: i.todo.link, what: "form" }))]
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const seen = new Set();
      const ofs = open2.filter((f) => !seen.has(f.link || f.at) && seen.add(f.link || f.at));
      const past = [...fs.map((f) => f.due_at), ...todos.map((i) => i.due_at)].filter((t) => t && new Date(t).getTime() <= now2).sort().pop();
      lines.push(ofs.length ? ofs.slice(0, 2).map((f) => `${ent.name} ${String(f.what).toLowerCase() === "form" ? "form" : `${String(f.what).toLowerCase()} form`}: due ${when(f.at)}${relTime(new Date(f.at).getTime(), data.now)}${f.link ? ` — [Open](${f.link})` : ""}.`).join("\n")
        : past ? `No open ${ent.name} form: the last one closed ${when(past)}.` : `No ${ent.name} form on the ERP, in notices, or in placement mail ${asOfLine(data)}.`);
      return lines.join("\n");
    }
    if (intents.has("pay")) {
      const withPay = roles.filter(hasPay);
      // the CTC in one line ("15 L for SE I, SE II FS; 30 L for 2 roles"); the breakup only when asked for
      const pq = norm(`${spec.payQuestion || ""} ${question}`);
      const breakup = PART.some(([, inQ]) => inQ.test(pq)) || /\b(break ?(up|down)|brekdown|details?|full|all|esops?|bonus\w*|bond)\b/.test(pq);
      const byCtc = ctcGroups(withPay);
      // every role named (never "(4 roles)": a follow-up has to be able to point at them), up to 5, then "+N more"
      lines.push(withPay.length && !breakup ? `${ent.name} CTC: ${[...byCtc.entries()].map(([k, v]) => `${k} (${names(v, 5)})`).join("; ")}.`
        + (withPay.length < roles.length ? ` No CTC on the ERP for ${roles.length - withPay.length} more.` : "")
        : withPay.length ? withPay.map((r) => payLinesFor(ent, r, spec.payQuestion || question)).join("\n")
        + (withPay.length < roles.length ? `\n${roles.length - withPay.length} more ${ent.name} role${roles.length - withPay.length === 1 ? "" : "s"}: no CTC on the ERP.` : "")
        : elsewhere("pay"));
    }
    if (intents.has("eligible")) {
      const known = roles.filter((r) => r.cgpa_cutoff != null || (r.allowed || []).length);
      lines.push(known.length ? roles.map((r) => eligibleLine(ent, r, data, question)).join("\n") : roles.length ? elsewhere("eligible") : `No ${ent.name} role in your companies list.`);
    }
    if (intents.has("applied")) {
      const ap = roles.filter((r) => r.applied).map((r) => r.designation);
      lines.push(!roles.length ? `No ${ent.name} role in your companies list.` : ap.length ? `Yes, you applied to ${ent.name}: ${names(ap, 4)}.`
        : `No, you haven't applied to ${roles.length === 1 ? `the ${ent.name} role (${roles[0].designation})` : `any of the ${roles.length} ${ent.name} roles`}.`);
      saidApplied = true;
    }
    if (intents.has("test") || intents.has("shortlist")) {
      // a PPO offer list isn't a test: only for a shortlist / result question
      const ev = items.filter((i) => isListItem(i) && (intents.has("shortlist") || (i.category !== "offer" && !/\bextended the offer\b/i.test(i.title || "")))).sort((a, b) => String(b.event_at || b.due_at || "").localeCompare(String(a.event_at || a.due_at || "")));
      if (intents.has("shortlist") && !intents.has("test")) {
        const lists = ev.filter((i) => (i.pdf?.status || i.pdf_status) === "yes" || (i.pdf?.status || i.pdf_status) === "no");
        // the latest list decides the yes / no; the ones before it follow, one line each
        const st = (i) => i.pdf?.status || i.pdf_status;
        // never an absence ("not on it"): a list without your roll is "I couldn't find your roll number", checked by you
        lines.push(lists.length ? [st(lists[0]) === "yes" ? `Yes, you're on the latest ${ent.name} list: ${lists[0].title}`
          : `I couldn't find your roll number in the latest ${ent.name} list${/couldn't find/.test(lists[0].title) ? "" : ` (${lists[0].title})`}. Please check the list yourself.`,
          ...lists.slice(1, 3).filter((i) => st(i) !== st(lists[0])).map((i) => `Earlier: ${i.title}`)].join("\n")
          : `No ${ent.name} shortlist or result in the ERP data yet.`);
      } else {
        // "which room was I in": the one list that has your row
        const mineRow = /\b(room|slot|seat)\b/.test(norm(question)) ? ev.filter((i) => i.pdf?.details?.room || i.pdf?.details?.slot).slice(0, 1) : [];
        // a bare "when is it?" asks for both: say "no test" only when there's no deadline answer either
        if (ev.length) lines.push(testLines(mineRow.length ? mineRow : ev.slice(0, 3), now).join("\n"));
        else if (!intents.has("deadline")) lines.push(`No test, shortlist or result for ${ent.name} in notices or placement mail ${asOfLine(data)}.`);
      }
    }
    if (intents.has("notice")) {
      const fromIt = notice && items.filter((i) => i.notice_id && i.notice_id === notice.notice_id && i.title)
        .sort((a, b) => String(b.first_seen || "").localeCompare(String(a.first_seen || "")))[0];
      lines.push(notice ? noticeLine + (fromIt ? `\nPing's message about it: ${fromIt.title}` : "") : `I don't have any notice for ${ent.name} in the ERP data.`);
      saidNotice = true;
    }
    // deadlines: always for a deadline question, and for any question that isn't one of the above
    const deadlineAsked = intents.has("deadline") || (!lines.length && !intents.has("notice"));
    if (deadlineAsked) {
      const mine = open.filter((m) => !spec.roleQuestion || [...m.roles].some((d) => roles.some((r) => r.designation === d)));
      if (mine.length) lines.unshift(`${ent.name}: open deadlines (last checked ${checked}):\n` + mine.map((m) => deadlineLine(m, now, false)).join("\n"));
      else {
        const closed = roles.filter((r) => r.deadline && new Date(r.deadline) <= now).sort((a, b) => String(b.deadline).localeCompare(String(a.deadline))).slice(0, 3);
        const later = lookup(ent, "deadline", data, sources).found.filter((f) => f.where === "form" && f.at && new Date(f.at) > now);
        const inel = roles.filter((r) => r.eligible === false && r.deadline && new Date(r.deadline) > now);
        if (inel.length) lines.unshift(...inel.slice(0, 2).map((r) => `${label(ent, r)}: closes ${when(r.deadline)}${relTime(new Date(r.deadline).getTime(), data.now)}, but the ERP marks you not eligible.`));
        else
        if (later.length) lines.unshift(...later.slice(0, 2).map((f) => `${ent.name}: ${f.label} is due ${when(f.at)}${f.link ? ` — [Open](${f.link})` : ""}.`));
        else lines.unshift(`No open deadline for ${ent.name} on the ERP, in notices, or in placement mail (last checked ${checked}).` +
          (closed.length === 1 ? ` ${closed[0].designation} closed ${when(closed[0].deadline)} (already passed).`
            : closed.length ? ` ${closed.length} roles closed, the last on ${when(closed[0].deadline)} (already passed).` : ""));
      }
    }
    const short = intents.has("pay") || intents.has("eligible") || intents.has("location") || intents.has("score") || intents.has("contact") ||
      intents.has("whichcv") || intents.has("roles") || intents.has("test") || intents.has("shortlist");
    if (!saidNotice && !short) lines.push(noticeLine);
    // status: applied or not, and the latest list that names you
    if (roles.length && !saidApplied && !short) {
      const ap = roles.filter((r) => r.applied).map((r) => r.designation);
      lines.push(ap.length ? `You applied to: ${names(ap, 4)}.` : `You haven't applied to ${roles.length === 1 ? `the ${ent.name} role` : `any of the ${roles.length} ${ent.name} roles`}.`);
    }
    const mine = items.filter((i) => i.pdf_status === "yes" || i.pdf_status === "no")
      .sort((a, b) => String(b.event_at || b.due_at || "").localeCompare(String(a.event_at || a.due_at || "")))[0];
    if (mine && !short) lines.push(mine.title);
    return intents.has("roles") ? lines.join("\n") : compactLines(lines.join("\n"), ent, question);
  }
  // At most 3 lines unless the question asks for detail: the same line for several roles is said once ("AiPrise (4
  // roles): no CG cut-off given"), then the most useful lines first (the answer, then status; the last notice last)
  function compactLines(text, ent, question) {
    let lines = String(text).split("\n").filter((l) => l.trim());
    const pre = `${ent.name} (`;
    const groups = new Map();
    for (const l of lines) {
      const m = l.startsWith(pre) ? l.match(/^(.*?) \((.+?)\): (.*)$/) : null;
      const k = m ? m[3] : `\u0000${l}`;
      groups.set(k, [...(groups.get(k) || []), m ? m[2] : null]);
    }
    lines = [...groups.entries()].map(([rest, rs]) => (rest.startsWith("\u0000") ? rest.slice(1)
      : `${ent.name} (${names(rs, 5)}): ${rest}`));
    if (/\b(details?|all|every|full|list|breakup|breakdown)\b/.test(norm(question)) || lines.length <= 3) return lines.join("\n");
    // the answer first, then the last notice, then whether you applied
    const rank = (l) => (/^Last .* notice:|^No .* notice in the data/.test(l) ? 1 : /^You (haven't )?applied|^You applied/.test(l) ? 2 : 0);
    return lines.map((l, i) => [l, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).slice(0, 3)
      .sort((a, b) => a[1] - b[1]).map((x) => x[0]).join("\n");
  }

  // ---------------------------------------------------------------- no company: lists for a time
  const HM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function dayWord(at, now) {
    const d = dayKey(at), n = dayKey(now), tm = dayKey(now.getTime() + 86400000);
    if (d === n) return Number(HM.format(at).slice(0, 2)) >= 17 ? "tonight" : "today";
    if (d === tm) return "tomorrow";
    return dayName(at);
  }
  // Applications closing in a range, one block per closing time, the same counts as the digest and Today:
  // "Close tonight 20:00 (in 2h 28m), Sat 21 Nov — 8 for you, 9 applied:" (for you = not applied yet and for you)
  function dueBlocks(data, from, to) {
    const now = data.now;
    const open = (data.roles || []).filter((r) => r.eligible !== false && r.deadline && new Date(r.deadline) > now &&
      new Date(r.deadline).getTime() >= from && new Date(r.deadline).getTime() < to);
    const byTime = new Map();
    for (const r of open) { const k = new Date(r.deadline).getTime(); byTime.set(k, [...(byTime.get(k) || []), r]); }
    const marked = (data.roles || []).some((r) => r.for_you !== undefined);
    const listOthers = data.prefs?.listOthers !== false;
    const line = (r) => `- ${shortName(r.company)} — ${r.designation}`;
    const sort = (rs) => [...rs].sort((a, b) => shortName(a.company).localeCompare(shortName(b.company)) || a.designation.localeCompare(b.designation));
    return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, rs]) => {
      const at = new Date(t), day = dayWord(at, now);
      const rel = relTime(t, now).replace("(today, in ", "(in ");
      const head = `Close ${day} ${HM.format(at)}${rel}${/^(tonight|today|tomorrow)$/.test(day) ? `, ${dayName(at)}` : ""}`;
      const applied = rs.filter((r) => r.applied);
      if (!marked) return [`${head} — ${rs.length} role${rs.length === 1 ? "" : "s"}, ${applied.length} applied:`, ...sort(rs).map((r) => line(r) + (r.applied ? " ✓ applied" : ""))].join("\n");
      const mine = rs.filter((r) => !r.applied && r.for_you);
      const others = rs.filter((r) => !r.applied && !r.for_you);
      return [`${head} — ${mine.length} for you, ${applied.length} applied:`,
        "For you:", ...(mine.length ? sort(mine).map((r) => line(r) + (r.cv ? ` (apply with ${r.cv})` : "")) : ["- none"]),
        ...(applied.length ? ["Applied:", ...sort(applied).map((r) => `${line(r)} ✓ applied`)] : []),
        ...(others.length ? (listOthers ? [`Others (${others.length}):`, ...sort(others).map(line)] : [`Others: ${others.length} more (not listed)`]) : []),
      ].join("\n");
    });
  }
  // forms and submissions due in a range (from the feed), one line per company and time
  function formLines(data, ents, from, to) {
    // the application itself is in the blocks above: here only the forms and submissions
    return deadlineEntries(data, ents, from, to).filter((m) => [...m.kinds].some((k) => k !== "application"))
      .map((m) => deadlineLine({ ...m, kinds: new Set([...m.kinds].filter((k) => k !== "application")), apps: [] }, data.now));
  }
  // the most urgent thing left today, for "anything else?": "48 roles close at 20:00 today (in 2h 28m), 39 not applied: ..."
  function urgentLine(data) {
    const now = data.now, end = new Date(`${dayKey(now)}T00:00:00+05:30`).getTime() + 86400000;
    const open = (data.roles || []).filter((r) => r.eligible !== false && r.deadline && new Date(r.deadline) > now && new Date(r.deadline).getTime() < end);
    if (!open.length) return "";
    const t = Math.min(...open.map((r) => new Date(r.deadline).getTime()));
    const rs = open.filter((r) => new Date(r.deadline).getTime() === t);
    const not = rs.filter((r) => !r.applied);
    const mine = not.filter((r) => r.for_you);
    const cos = [...new Set((mine.length ? mine : not).map((r) => shortName(r.company)))].sort((a, b) => a.localeCompare(b));
    return `${rs.length} roles close at ${HM.format(new Date(t))} today${relTime(t, now).replace("(today, in ", "(in ")}, ${not.length} not applied` +
      `${mine.length ? ` (${mine.length} for you)` : ""}: ${names(cos, 5)}.`;
  }
  function nextDeadline(data, after) {
    const r = (data.roles || []).filter((x) => x.eligible !== false && x.deadline && new Date(x.deadline).getTime() >= after)
      .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))[0];
    return r ? ` Next: ${shortName(r.company)} (${r.designation}) closes ${when(r.deadline)}.` : "";
  }

  function capitalised(words) { return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" "); }

  // spec (from route): { intents, hits, range, else, roleQuestion, payQuestion } instead of reading the question again
  function answer(question, data, spec) {
    data = { ...data, now: new Date(data.now || Date.now()) };
    const now = data.now;
    const checked = data.lastChecked ? when(data.lastChecked) : "not yet";
    const ents = spec?.ents || entities(data);
    const m0 = spec ? { hits: spec.hits, used: new Set() } : matchCompanies(question, data, ents);
    const { hits, used } = m0;
    const intents = spec ? new Set(spec.intents) : intentsOf(question);
    const range = spec ? spec.range : timeRange(question, now);
    if (intents.has("mail") && !intents.has("contact")) return mailAnswer(question, data, hits, intents, range, checked);

    if (hits.length) {
      return { kind: "company", companies: hits.map((e) => e.name),
               text: hits.slice(0, 3).map((e) => aboutCompany(e, intents, data, ents, checked, question, spec || {})).join("\n\n") };
    }
    // "what all roles?" with no company and no topic: ask which, with the companies most recently in the news
    if (intents.has("roles") && !intents.has("deadline") && !range) return { kind: "intent", companies: [], text: clarifyCompany(data, ents, "roles") };
    // a name Ping has no company for: the words left once question words, intents and times are gone
    const left = spec ? spec.unknown || [] : tokensOf(question).filter((t) => !STOP.has(t) && !used.has(t) && t.length >= 3 && !/^\d+$/.test(t));
    const factual = [...intents].some((i) => !["count", "foryou"].includes(i));
    if (left.length && factual && left.length <= 3) {        // "google cv deadline"; a bare "hmm" is not a company
      const name = capitalised(left.slice(0, 3));
      const inSubject = (data.notices || []).filter((n) => left.some((t) => t.length >= 4 && norm(n.subject).split(" ").includes(t)))
        .sort((a, b) => String(b.notice_time).localeCompare(String(a.notice_time)))[0];
      if (inSubject) return { kind: "unknown", companies: [],
        text: `No open deadline for ${name} in the ERP data (last checked ${checked}). It isn't on your companies list; the last notice that mentions it: "${inSubject.subject}" (${shortName(inSubject.company)}), ${when(inSubject.notice_time)}.` };
      return { kind: "unknown", companies: [],
        text: `I don't have ${name} in your ERP data: no role on the companies list and no notice from it (last checked ${checked}).` };
    }
    if (intents.has("score")) return { kind: "intent", companies: [], text: "I don't have your scores: the ERP doesn't publish test scores or ranks." };
    if (intents.has("contact")) return { kind: "intent", companies: [], text: "I don't have contact details: Ping leaves out names and phone numbers from notices." };
    if (intents.has("foryou")) {
      const r = { from: now.getTime(), to: now.getTime() + 3 * 86400000 };
      const blocks = dueBlocks(data, r.from, r.to).map((b) => b.split("\nApplied:")[0].split("\nOthers")[0]);
      const tests = (data.items || []).filter((i) => isListItem(i) && i.event_at && dayKey(i.event_at) === dayKey(now) && i.level !== "hidden");
      const parts = [...blocks, ...(tests.length ? ["Tests today:", ...testLines(tests, now)] : [])];
      return { kind: "intent", companies: [], text: parts.length ? parts.join("\n\n") : `Nothing for you in the next 3 days (last checked ${checked}).` };
    }
    if (intents.has("deadline") || (range && !intents.size)) {
      const r = range || { from: now.getTime(), to: now.getTime() + 3 * 86400000, label: "in the next 3 days" };
      const blocks = dueBlocks(data, r.from, r.to);
      const forms = formLines(data, ents, r.from, r.to);
      if (spec?.else) {
        return { kind: "intent", companies: [], text: blocks.length || forms.length
          ? `That's everything due ${r.label}: nothing else in the ERP data.${nextDeadline(data, r.to)}`
          : `Nothing else due ${r.label} (last checked ${checked}).${nextDeadline(data, r.to)}` };
      }
      const count = intents.has("count") ? `${blocks.reduce((n, b) => n + (b.match(/^- /gm) || []).length, 0)} roles close ${r.label}.\n\n` : "";
      return { kind: "intent", companies: [], text: blocks.length || forms.length
        ? count + [...blocks, ...(forms.length ? [`Forms and submissions due ${r.label}:\n${cap(forms).join("\n")}`] : [])].join("\n\n")
        : `Nothing due ${r.label} in the ERP data (last checked ${checked}).${nextDeadline(data, r.to)}` };
    }
    if (intents.has("shortlist") && !intents.has("test")) {
      const since = now.getTime() - 21 * 86400000;
      const yes = (data.items || []).filter((i) => (i.pdf?.status || i.pdf_status) === "yes" && new Date(i.event_at || i.notice_time || i.due_at || 0).getTime() >= since - 86400000)
        .sort((a, b) => String(b.event_at || "").localeCompare(String(a.event_at || "")));
      return { kind: "intent", companies: [], text: yes.length ? `${intents.has("count") ? `${yes.length} lists name you` : "Lists that name you"} (last 3 weeks):\n${cap(testLines(yes, now)).join("\n")}`
        : `No shortlist or list names you in the last 3 weeks (last checked ${checked}).` };
    }
    if (intents.has("test") || intents.has("shortlist")) {
      // tests earlier today count too (marked "over"): "any tests today?" at 17:30 still names the 15:00 one
      const from = range ? (range.dayStart ?? range.from) : now.getTime() - 86400000, to = range ? range.to : now.getTime() + 7 * 86400000;
      const ev = (data.items || []).filter((i) => ["test", "shortlist", "result"].includes(i.category) && i.event_at &&
        (i.level !== "hidden" || /digest|message|collapse|merged|already happened/.test(i.hidden_because || "")) &&
        new Date(i.event_at).getTime() >= from && new Date(i.event_at).getTime() < to)
        .sort((a, b) => String(a.event_at).localeCompare(String(b.event_at)));
      const label = range ? range.label : "from yesterday to the next 7 days";
      if (spec?.else) {
        const u = urgentLine(data);
        return { kind: "intent", companies: [], text: `No other test ${label.replace(/ \(.*\)$/, "")}${ev.length ? `: ${ev.length === 1 ? "that was the only one" : `those ${ev.length} are all`}` : ""}.${u ? ` ${u}` : ""}` };
      }
      return { kind: "intent", companies: [], text: ev.length ? `${intents.has("count") ? `${ev.length} ` : ""}Tests and lists ${label}:\n${cap(testLines(ev, now)).join("\n")}`
        : `No tests or lists ${label} in the ERP data (last checked ${checked}).` };
    }
    if (intents.has("applied")) {
      const ap = (data.roles || []).filter((r) => r.applied);
      return { kind: "intent", companies: [], text: ap.length ? `You applied to ${ap.length} roles at ${new Set(ap.map((r) => r.company)).size} companies, for example ${names([...new Set(ap.map((r) => shortName(r.company)))].sort(), 6)}. Ask about one company for its roles.`
        : "You haven't applied to any role on the companies list yet." };
    }
    if (intents.has("jd")) return { kind: "intent", companies: [], text: 'Which company\'s JD? For example: "summarise the JD for Groww".' };
    if (intents.size) {
      const ex = deadlineEntries(data, ents)[0];
      const first = [...intents].filter((i) => i !== "count")[0];
      return { kind: "intent", companies: [], text: `Which company? For example: "${first === "whichcv" ? "which cv for" : first === "pay" ? "ctc at" : first === "eligible" ? "am I eligible for" : "deadline for"} ${ex ? ex.ent.name : "Groww"}".` };
    }
    const soon = deadlineEntries(data, ents, now.getTime(), now.getTime() + 3 * 86400000).map((m) => deadlineLine(m, now));
    return { kind: "digest", companies: [], text: "I couldn't tell what you meant. Here's what's due soon:\n" +
      (soon.length ? cap(soon).join("\n") : `- nothing in the next 3 days (last checked ${checked})`) };
  }

  // ---------------------------------------------------------------- placement mail
  // Messages from your mail: "via email" (only the mail has it) and ERP messages the mail repeated ("also mailed").
  const TEST_URL = /hackerrank|hackerearth|mettl|codility|codesignal|imocha|shl\.|talview|hirepro|amcat|cocubes|glider|testgorilla|hirevue|\/test|assess/i;
  const mailOf = (i) => i.via === "email" || i.details?.via === "email" ? "via email" : (i.mail || i.details?.mail)?.note ? "also on the ERP" : null;
  const linkOf = (i) => (i.mail || i.details?.mail)?.link || (i.todo || i.details?.todo)?.link || null;
  function mailAnswer(question, data, hits, intents, range, checked) {
    const now = data.now.getTime(), q = norm(question);
    const wantsTest = /\b(test|assessment|oa)\b/.test(q), wantsDue = intents.has("deadline") || /\b(due|deadline|pending|to do|todo)\b/.test(q);
    let list = (data.items || []).filter((i) => mailOf(i));
    if (hits.length) list = list.filter((i) => hits.some((e) => e.raw.has(i.company) || norm(e.name) === norm(shortName(i.company))));
    else list = list.filter((i) => i.level !== "hidden");
    if (wantsTest) list = list.filter((i) => i.category === "test" || ["test", "interview"].includes(i.kind) ||
      (i.todo || i.details?.todo)?.action === "take_test" || TEST_URL.test(linkOf(i) || ""));
    if (wantsDue) list = list.filter((i) => i.due_at && Date.parse(i.due_at) > now)
      .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
    else list.sort((a, b) => String(b.first_seen || b.sort_at || "").localeCompare(String(a.first_seen || a.sort_at || "")));
    // the companies asked about that have mail (all of them when none has: "No test link from X")
    const named = hits.filter((e) => list.some((i) => e.raw.has(i.company) || norm(e.name) === norm(shortName(i.company))));
    const who = (named.length ? named : hits).map((e) => e.name).join(", ");
    if (!list.length) {
      const what = wantsTest ? "No test link" : wantsDue ? "Nothing due" : "No placement mail";
      return { kind: "mail", companies: hits.map((e) => e.name), text: `${what}${who ? ` from ${who}` : ""} in your mail${wantsTest ? " or on the ERP" : ""} so far (last checked ${checked}). I read placement mail only: from the placement office, companies on your list, test platforms, or with words like test, shortlist, interview, form, offer.` };
    }
    const line = (i) => {
      const t = String(i.title || "").replace(/\.$/, "");
      const link = linkOf(i);
      return `- ${t}${i.due_at && !/ by /.test(t) ? ` (due ${when(i.due_at)})` : ""} · ${mailOf(i)}${link ? `\n  ${link}` : ""}`;
    };
    const head = wantsTest ? `Test link${list.length === 1 ? "" : "s"}${who ? ` for ${who}` : ""}:` : wantsDue ? "Due from your mail:"
      : `Placement mail${who ? ` about ${who}` : ""} (newest first):`;
    return { kind: "mail", companies: hits.map((e) => e.name), text: [head, ...list.slice(0, 8).map(line),
      ...(list.length > 8 ? [`+${list.length - 8} more in the Feed`] : [])].join("\n") };
  }

  // ---------------------------------------------------------------- preferences said in the chat
  // The page answers FACT questions itself; a message that sets or shows preferences goes to the ask-ping function,
  // which saves them (supabase/functions/ask-ping/prefs.ts). The same patterns, copied (tests/test_prefs_patterns.py
  // fails if they drift apart).
  const PREFS_PATTERNS = {
    SHOW: /^(?:what\s+(?:are|is)\s+my\s+(?:preferences|targets|settings)|show\s+(?:me\s+)?my\s+(?:preferences|targets|settings)|what\s+am\s+i\s+looking\s+for)\b/i,
    RESET: /^(?:please\s+)?(?:reset|clear|forget|delete)\s+(?:all\s+)?my\s+(?:preferences|targets|settings)\b/i,
    REMIND: /\bremind\s+me\s+(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)\s+before\b/i,
    REMIND_DAY: /\bremind\s+me\s+(?:a|one|1)?\s*day\s+before\b|\bremind\s+me\s+the\s+day\s+before\b/i,
    EVERY: /\bcheck(?:\s+the\s+erp)?\s+(?:every|once\s+every)\s+(?:(\d+)\s*(min|mins|minutes|h|hr|hrs|hour|hours)|(half\s+an?\s+hour|hour|two\s+hours))\b|\bcheck\s+(hourly|half-hourly)\b/i,
    HOURS: /\b(?:only\s+)?check(?:\s+the\s+erp)?\s+(?:between|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:and|to|-)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
    ALL: /^(?:please\s+)?(?:show\s+me\s+everything|everything\s+from\s+the\s+erp|show\s+all\s+roles|don'?t\s+filter)\b/i,
    PERSONAL: /^(?:please\s+)?(?:only\s+what\s+fits\s+me|personali[sz]e\s+(?:my\s+)?feed|filter\s+(?:my\s+)?feed)\b/i,
    LIST_OFF: /\b(?:stop|don'?t|do\s+not|no\s+longer)\s+(?:list(?:ing)?|show(?:ing)?)\s+(?:the\s+)?other\s+roles\b/i,
    LIST_ON: /^(?:please\s+)?(?:start\s+|keep\s+)?(?:list|show)(?:ing)?\s+(?:the\s+)?other\s+roles\s+(?:separately|again|too)\b/i,
    SET: /^(?:please\s+)?(?:only\s+show\s+me|show\s+me\s+only|just\s+show\s+me|i(?:'m|\s+am)\s+(?:only\s+)?(?:looking\s+for|interested\s+in)|i\s+only\s+want|my\s+targets?\s+(?:is|are))\s+(.+)$/i,
    ADD: /^(?:please\s+)?(?:also\s+(?:include|show(?:\s+me)?|add|count)|include|add)\s+(.+)$/i,
    EXCLUDE: /^(?:please\s+)?(?:(?:don'?t|do\s+not|stop)\s+(?:count(?:ing)?|show(?:ing)?(?:\s+me)?|include|including|list(?:ing)?)|exclude|remove|drop|not\s+interested\s+in|no\s+more)\s+(.+)$/i,
  };
  function prefsLike(message) {
    return String(message || "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean)
      .some((part) => Object.values(PREFS_PATTERNS).some((re) => re.test(part)));
  }

  // ---------------------------------------------------------------- the router
  // Every message, before any model: FACT (answered here, no model call), ACT (a request to do something on the ERP:
  // the read-only answer), ACK ("ok", "thanks") or OPEN (summaries, "why", comparisons, anything else: the model,
  // with these facts). Follow-ups ("and slice?", "and tomorrow?", "nothing else?") are resolved against the last turn
  // first, then routed the same way.
  const FACT = ["whichcv", "deadline", "test", "shortlist", "pay", "eligible", "applied", "notice", "roles", "location", "score",
                "contact", "foryou", "jd", "mail", "form"];
  const ACK = /^(ok(ay)?|k|kk|thanks?|thank you|thx|ty|cool|great|nice|got it|alright|fine|sure|perfect|noted|done|never ?mind|no thanks|nope|leave it|keep it)[\s.!]*$/i;
  const OPEN = /\b(why|how come|explain|compare|comparison|versus|vs|better|difference|differ|should i|recommend|suggest\w*|advice|advise|tips?|prepare|preparation|tell me (more )?about|what do you think|worth|pros|cons|opinion|which (one|company|role|offer) (is|should|would)|(make|give|draft) me a plan|plan (for|my)|prioriti[sz]e|summari[sz]e (this|my|the|today|tonight)( \w+)? (week|day|deadlines|tonight|today)|in (two|three|\d) (lines|sentences|points))\b/;
  const ELSE = /\b(nothing|anything|what|something|any|whats) else\b|\bany ?more\b|\bothers?\s*$|^else$/;
  const FOLLOW = /^(and|but|also|then|so|plus|what about|how about|same for|same|same with|and for)\b/;
  // "that" only as "that one/company/role" or at the end ("what about that"): in "what's due tonight that's relevant
  // to me" it starts a clause and the question is a new one
  const PRONOUN = /\b(it|its|they|them|their|there|this one|those|these)\b|\bthat\s*$|\bthat (one|company|role|test|list)\b/;
  const ACTIONS = "apply|withdraw|submit|upload|change|update|edit|accept|decline|reject|fill|register|cancel|sign\\s?up|opt\\s(?:in|out)|delete|remove|book|send|email|mail";
  const ACT_WORD = new RegExp(`\\b(${ACTIONS})\\b`, "i");
  const STARTS_WITH_ACT = new RegExp(`^(?:please\\s+|pls\\s+|kindly\\s+|ping,?\\s+)?(?:${ACTIONS})\\b`, "i");
  const ASKS_YOU = /^(?:please\s+|pls\s+|kindly\s+)?(?:can|could|would|will)\s+(?:you|ping)\b/i;
  function asksToAct(message) {
    const t = String(message || "").trim();
    if (!ACT_WORD.test(t)) return false;
    return /\b(?:for me|on my behalf)\b/i.test(t) || ASKS_YOU.test(t) || STARTS_WITH_ACT.test(t);
  }
  // "check again", "recheck", "are you sure?", "that's wrong", "I think I'm on it", "I got a call", "check the ERP for
  // the latest, don't answer on old data": about the previous question, read again from the ERP now (never a new,
  // broader question). A company named in the message wins; else the active topic (the last 3 questions).
  const RECHECK = new RegExp([
    "\\bre-?check", "\\bcheck (?:it |that |this |them |again |once more )*(?:again|once more)\\b", "\\bdouble[- ]?check",
    "\\blook (?:again|once more)\\b", "\\b(?:check|look|search|see) (?:on |in |at )?(?:the )?(?:erp|epr)\\b", "\\bverify\\b",
    "\\b(?:it|it'?s|its|has|have|is|was|been) (?:been )?(?:listed|posted|put up|up|out|live) (?:on|in) (?:the )?(?:erp|epr|portal)\\b",
    "\\b(?:don'?t|do not|dont|never) (?:answer|reply|use|go)\\b.{0,30}\\bold\\b", "\\bold data\\b", "\\bstale\\b",
    "\\blatest (?:update|updates|data|info|list|news)\\b", "\\bfresh (?:data|check|look)\\b",
    "\\bare you sure\\b", "\\b(?:that'?s|thats|you'?re|youre|ur|it'?s|its) (?:wrong|not right|incorrect|mistaken|not correct)\\b",
    "\\bi (?:think|believe|guess|feel) i(?:'?m| am| might| may| could| should)\\b", "\\bi (?:got|received|had|have got|get) (?:a |the )?(?:call|mail|email|message)\\b",
    "\\bi(?:'?m| am) (?:on|in) (?:it|the list|there|that list)\\b", "\\bi(?:'?m| am) there\\b", "\\bcheck (?:it |that )?now\\b",
  ].join("|"), "i");
  function isRecheck(message) { return RECHECK.test(String(message || "")); }
  // a question the rules couldn't tie to a company: no company named, none in the answer, and the answer asks
  // "Which company?" or doesn't know a word ("elig", "supply chain"). The page doesn't answer these itself: Ask Ping's
  // function reads them with the model first (PING_MODEL_STEPS), which finds the company the conversation is about.
  function unresolved(question, route, out, data) {
    if (!route || route.kind === "open") return true;
    if (route.kind !== "fact" || (out && out.companies && out.companies.length)) return false;
    if (matchCompanies(String(question || ""), data).hits.length) return false;
    return !!((route.spec && route.spec.unknown && route.spec.unknown.length) || /^(?:Which company|For which company)\b/.test(String(out && out.text || "")));
  }

  const ROLLISH = /^\d{2}[a-z]{2}\d{5}$/;
  function parse(text, data, ents) {
    const { hits, used } = matchCompanies(text, data, ents);
    const intents = intentsOf(text);
    const range = timeRange(text, data.now);
    const unknown = hits.length ? [] : tokensOf(text).filter((t) => !STOP.has(t) && !used.has(t) && t.length >= 3 && !/^\d+$/.test(t) && !ROLLISH.test(t) && t !== "roll" && t !== "no");
    return { intents, hits, range, unknown, toks: tokensOf(text) };
  }
  // ---------------------------------------------------------------- help: Ping about itself (docs/HELP.md -> help.js)
  const HELP_DOC = () => root.PingHelp || (typeof require === "function" ? (() => { try { return require("./help.js"); } catch { return null; } })() : null);
  const HELP_TOPICS = [
    ["install", /\binstall\w*\b|\bhome ?screen\b|\badd (?:it |ping |this )?to (?:my |the )?(?:home|dock|desktop|taskbar)|\bdownload (?:ping|the app|this app|an app|app)\b|\b(?:get|use|have|is there) (?:ping |this )?(?:as )?an? (?:app|desktop app|mobile app)\b|\bpwa\b|\b(?:ping|this|there an?) app\b|\bapp version\b/],
    ["notifications", /\bnotif\w*|\bpush(?: messages?| alerts?)?\b(?! (?:the|my) )|\balerts?\b|\bnotify\b|\bbuzz\b|\bquiet hours\b/],
    ["checks", /\bhow (?:often|frequently)\b|\bwhen (?:do|does|will) (?:you|ping|it) (?:check|look|refresh|update)|\bcheck(?:ing)? (?:interval|frequency|schedule|window)\b|\bhow (?:do i|can i|to) (?:change|set) (?:the |how often|when)|\bevery (?:hour|30 min)\b.*\?|\bhow (?:fresh|up to date|recent)\b|\blast check(?:ed)?\b.*\bhow\b/],
    ["can", /\bwhat (?:can|can't|cannot|do|does|are) (?:you|ping)(?! think| recommend| suggest| reckon| feel| make of)(?: do| help with| for)?\b|\bwho are you\b|\bwhat is ping\b|\bwhat(?:'s| is) this\b|\b(?:your|ping'?s) (?:features|abilities|capabilities|limits|limitations)\b|\bread[- ]only\b|\bcan (?:you|ping) (?:apply|submit|fill|upload|withdraw|accept)\b(?! (?:for|to) )|\bis it (?:safe|read[- ]only)\b|\bare you (?:a bot|an ai|real)\b/],
    ["preferences", /\b(?:how (?:do|can) i|how to|where (?:do|can) i) (?:change|set|edit|update|see|reset|pick|choose) (?:my )?(?:preferences|settings|targets?|interests?|feed|cgpa|cv|profile|companies)|\bwhere (?:are|is) (?:my )?(?:preferences|settings|profile)\b|\bhow (?:do|does) (?:the )?(?:targets?|preferences|for you) work\b/],
    ["setup", /\bset (?:it |this |ping |myself |one )?up\b|\bsetup\b|\b(?:my|your) own (?:copy|ping|version)\b|\bsource (?:code|repo\w*)\b|\bopen[- ]source\b|\bgithub\b|\bself[- ]?host|\bfor (?:my|a) friend\b|\bhow (?:do|can) (?:i|others|my friends?) (?:get|use) ping\b/],
    ["data", /\bwhere (?:is|does|do) (?:my )?(?:data|info|information|password|passwords|cv|cvs) (?:live|go|stored|kept|saved)?|\b(?:is|are) my (?:data|password|passwords|cvs?|mails?|email) (?:safe|stored|private|shared|secure)\b|\bprivacy\b|\bwho can see\b|\bdo you (?:store|keep|save|read) (?:my )?(?:data|password|passwords|mails?|emails?|otp)\b|\bwhat do you (?:store|keep|save)\b/],
  ];
  const HELP_ALONE = /^(?:help|\?+|menu|commands|options|how (?:do i|to) use (?:ping|this|you)|how does (?:ping|this|it) work|about(?: ping)?|getting started|start|hi|hello|hey)[\s.!?]*$/;
  function helpTopic(question) {
    const q = norm(question);
    if (HELP_ALONE.test(q)) return "overview";
    for (const [topic, re] of HELP_TOPICS) if (re.test(q)) return topic;
    if (/\bhelp\b/.test(q) && tokensOf(q).length <= 4) return "overview";
    return null;
  }
  // "windows" | "mac" | "android" | "ios" | "other", from a browser's user agent (and touch points: an iPad says Mac)
  function platformOf(ua, touchPoints) {
    const u = String(ua || "");
    if (/iphone|ipad|ipod/i.test(u) || (/macintosh/i.test(u) && Number(touchPoints) > 1)) return "ios";
    if (/android/i.test(u)) return "android";
    if (/windows/i.test(u)) return "windows";
    if (/macintosh|mac os x/i.test(u)) return "mac";
    return "other";
  }
  function helpAnswer(topic, data) {
    const doc = HELP_DOC();
    if (!doc || !doc[topic]) return { kind: "help", topic, companies: [], text: "Ask me what's due, about a company, or say \"help\"." };
    const t = doc[topic];
    let text = t.text;
    if (topic === "install") {
      const plat = (data && data.platform) || "other";
      const steps = (t.platforms || {})[plat] || (t.platforms || {}).other || "";
      text = data && data.installed ? "You're already using Ping as an installed app." :
        `${t.text}\n${steps}${plat !== "other" ? "\n(On another device? Ask \"how do I install on iPhone\" or Android, Windows, Mac.)" : ""}`;
    }
    return { kind: "help", topic, companies: [], text };
  }
  // "how do I install on iphone": the platform named in the question wins over the browser asking
  function platformNamed(question) {
    const q = norm(question);
    return /\b(iphone|ipad|ios|safari)\b/.test(q) ? "ios" : /\bandroid\b/.test(q) ? "android" : /\b(windows|pc|laptop)\b/.test(q) ? "windows"
      : /\b(mac|macbook|macos)\b/.test(q) ? "mac" : null;
  }

  // -> { kind: "fact" | "act" | "ack" | "help" | "open", spec, why, resolved }  (spec goes to answer(question, data, spec))
  function route(question, previous, data) {
    data = { ...data, now: new Date(data.now || Date.now()) };
    // "the 15 lakh one?", "the closed one?": a follow-up that points back at roles of the last answer and asks no fact
    // of its own is about those roles (their company, where each stands)
    // (the company may be named already: the model's reading adds it to "the US ones?")
    if (data.lastAnswer && !intentsOf(question).size && refersBack(question, { text: data.lastAnswer }, data)) {
      const named = matchCompanies(question, data).hits[0], hit = named || matchCompanies(String(data.lastAnswer), data).hits[0];
      if (hit && ((data.roleSet || []).length || pointedRoles(question, data.lastAnswer, data).length))
        question = `${question}${named ? "" : ` ${shortName(hit.name)}`} what all roles`;
    }
    const ents = entities(data);
    const raw = String(question || "").trim();
    if (ACK.test(raw)) return { kind: "ack", why: "acknowledgement" };
    const text = raw.replace(/^(ok(ay)?|alright|cool|thanks|great|right|hmm+)[,.!]+\s*/i, "");
    const q = norm(text);
    const cur = parse(text, data, ents);
    // about Ping itself ("how do I install", "help"); a company in the question makes it a question about that company
    const topic = helpTopic(raw);
    if (topic && (!cur.hits.length || ["install", "can", "data"].includes(topic) && !cur.intents.size))
      return { kind: "help", topic, platform: platformNamed(raw), why: `help: ${topic}` };
    let spec = { ents, intents: [...cur.intents], hits: cur.hits, range: cur.range, unknown: cur.unknown };
    let resolved = text, why = "";
    const isElse = ELSE.test(q);
    // the active topic: the last 3 questions, newest first
    const prevQs = (previous || []).filter(Boolean).slice(0, 3);
    if (isRecheck(raw)) {
      const prev = prevQs.map((p) => parse(String(p), data, ents)).find((p) => p.hits.length || p.intents.size || p.range) || null;
      const hits = cur.hits.length ? cur.hits : prev ? prev.hits : [];
      const intents = new Set([...(prev ? prev.intents : []), ...cur.intents]);
      const companies = hits.map((e) => e.name);
      const topic = { ents, intents: [...intents].filter((i) => i !== "count"), hits, range: prev?.range || cur.range, unknown: [] };
      const prevIdx = prevQs.findIndex((p) => { const x = parse(String(p), data, ents); return x.hits.length || x.intents.size || x.range; });
      return { kind: "recheck", companies, spec: topic, previous: prevIdx >= 0 ? prevQs[prevIdx] : null,
               why: companies.length ? `re-check: ${companies.join(", ")}` : "re-check: no company in the topic",
               resolved: `${text} [re-check${companies.length ? `: ${companies.join(", ")}` : ""}]` };
    }
    // words that are a role of the topic company, not a company ("jd of supply chain one" after "ey gds roles",
    // "jd for product ownership" after "ather ctc"): the topic company's role, never "I don't have Supply Chain"
    if (!cur.hits.length && cur.unknown.length && prevQs.length) {
      const topicHits = (prevQs.map((p) => parse(String(p), data, ents)).find((p) => p.hits.length) || { hits: [] }).hits;
      const initials = (d) => String(d || "").toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z0-9]+/)
        .filter((w) => w && !["of", "and", "the", "in", "for", "us", "ai", "pg"].includes(w)).map((w) => w[0]).join("");
      const roleWord = (t) => topicHits.some((e) => (data.roles || []).some((r) => e.raw.has(r.company) &&
        (keyWords(r.designation).some((w) => w === t || (t.length >= 5 && (w.startsWith(t) || t.startsWith(w)))) ||
         (t.length >= 2 && t.length <= 5 && initials(r.designation) === t))));
      if (topicHits.length && cur.unknown.some(roleWord)) cur.unknown = cur.unknown.filter((t) => !roleWord(t) && t.length > 3 && !["one", "wala", "wali", "that", "this"].includes(t));
    }
    // a question with no company of its own that asks only about a field or a source ("check notices for JD",
    // "and mail?", "what about CTC", "jd kya hai"): it's about the topic company
    const ATTR = ["jd", "pay", "eligible", "location", "roles", "applied", "shortlist", "test", "whichcv", "deadline", "notice", "mail"];
    const bare = !cur.hits.length && !cur.unknown.length && !cur.range &&
      ([...cur.intents].some((i) => ATTR.includes(i)) || sourcesOf(text).length);
    const follow = prevQs.length && (FOLLOW.test(q) || isElse || PRONOUN.test(q) || cur.toks.length <= 2 || bare ||
      (!cur.intents.size && !cur.hits.length && !cur.unknown.length));
    if (follow) {
      // the last question that had something to go on (a company, an intent or a time)
      const prev = prevQs.map((p) => parse(String(p).replace(/^(ok(ay)?|alright|cool|thanks|great)[,.!]+\s*/i, ""), data, ents))
        .find((p) => p.intents.size || p.hits.length || p.range) || null;
      if (prev) {
        // a source word ("mail", "notices") says where to look, not what to answer
        const ownIntents = [...cur.intents].filter((i) => i !== "count" && !(["mail", "notice"].includes(i) && prev.hits.length && !cur.hits.length));
        const intents = ownIntents.length && !(isElse && !cur.hits.length) ? new Set(ownIntents)
          : new Set([...prev.intents, ...[...cur.intents].filter((i) => !["mail", "notice"].includes(i) || !prev.hits.length)]);
        // the topic company: the latest question that named one (a "what about ctc" in between names none)
        const prevHits = prev.hits.length ? prev.hits
          : (prevQs.map((p) => parse(String(p), data, ents)).find((p) => p.hits.length) || { hits: [] }).hits;
        const hits = cur.hits.length ? cur.hits : prevHits;
        const range = cur.range || (cur.hits.length ? null : prev.range);
        const news = cur.hits.length || cur.range || ownIntents.length || isElse || sourcesOf(text).length ||
          cur.toks.some((t) => hits.some((e) => (data.roles || []).some((r) => e.raw.has(r.company) && keyWords(r.designation).includes(t))));
        if (!news) return { kind: "open", why: "follow-up with nothing new", spec: { ents, intents: [...prev.intents], hits: prev.hits, range: prev.range, unknown: [] }, resolved: prevQs[0] };
        spec = { ents, intents: [...intents], hits, range, unknown: cur.hits.length ? cur.unknown : [], else: isElse,
                 roleQuestion: cur.hits.length ? text : `${text} ${cur.toks.length <= 6 ? "" : ""}`.trim(),
                 payQuestion: [...cur.intents].includes("pay") ? text : prevQs[0] };
        if (!cur.hits.length && !cur.toks.some((t) => hits.some((e) => (data.roles || []).some((r) => e.raw.has(r.company) && keyWords(r.designation).includes(t))))) spec.roleQuestion = "";
        resolved = `${text} [about: ${hits.map((e) => e.name).join(", ") || "-"}; ${[...intents].join(", ")}${range ? `; ${range.label}` : ""}]`;
        why = "follow-up";
      }
    }
    if (asksToAct(text)) return { kind: "act", spec, why: "asks Ping to act", resolved };
    if (OPEN.test(q) && !spec.intents.includes("whichcv")) return { kind: "open", spec, why: "open-ended", resolved };
    const facts = spec.intents.filter((i) => FACT.includes(i));
    if (facts.length) return { kind: "fact", spec, why: why || `intent: ${facts.join(", ")}`, resolved };
    if (spec.range) return { kind: "fact", spec: { ...spec, intents: ["deadline", ...spec.intents] }, why: why || "a time", resolved };
    if (spec.hits.length && cur.toks.length <= 4) return { kind: "fact", spec, why: why || "a company", resolved };
    return { kind: "open", spec, why: why || "no fact intent", resolved };
  }
  // Never the same answer twice in a row: lines already in the last answer are dropped; nothing left -> one line
  // saying nothing new was found (where the student asked to look, if they named a place)
  // "4 roles?", "the US ones", "which of those did I apply to": a short message that points back at Ping's last answer
  // (a number or an amount, "those / these / which / the ones", or a word from that answer). last: {text, at}.
  const POINT = /\b(those|these|them|they|which|ones?|that|same|the (?:first|second|third|last|other|closed|open|us|india|remote)\b)/;
  const AMOUNT = /\d|\b(lakhs?|lacs?|lpa|crores?|cr)\b/;
  function refersBack(question, last, data) {
    if (!last || !last.text) return false;
    if (last.at && data?.now && new Date(data.now) - new Date(last.at) > 30 * 60000) return false;
    const q = norm(question), toks = tokensOf(question);
    if (!toks.length || toks.length > 12 || isRecheck(question) || feedbackLike(question) || prefsLike(question)) return false;
    const point = AMOUNT.test(q) || POINT.test(q);
    if (data && matchCompanies(question, data).hits.length) return point;          // a company named: only when it points
    if (point) return true;
    const said = new Set(tokensOf(last.text).filter((w) => w.length >= 4 && !STOP.has(w)));
    return toks.some((w) => w.length >= 4 && !STOP.has(w) && said.has(w));
  }
  // Without the model (it failed, or no key): the roles of the last answer a follow-up points at, read from the data:
  // an amount ("the 39 lakh ones"), a count ("4 roles?"), "the US ones", "the closed one", "still open", "those".
  // [] when it can't tell. When it can, it wins over the model's reading (an amount, a count or "US" read from the
  // data is exact; the model is for the references these can't read).
  const US_RE = /\bUS\b|\bUSA\b|United States/;
  function pointedRoles(question, last, data, loose = true) {
    if (!last || !data) return [];
    const q = norm(question), hit = matchCompanies(String(last), data).hits[0];
    if (!hit) return [];
    const all = (data.roles || []).filter((r) => hit.raw.has(r.company));
    const said = all.filter((r) => norm(String(last)).includes(norm(r.designation)));
    const pool = said.length ? said : all, now = new Date(data.now), ds = (rs) => rs.map((r) => r.designation);
    const groups = [...ctcGroups(pool).entries()];
    const lakhOf = (k) => { const n = Number(String(k).split(" ")[0].replace(/,/g, "")); return n ? n / 100000 : null; };
    const amt = q.match(/(\d+(?:\.\d+)?)\s*(?:l|lakhs?|lacs?|lpa)\b/);
    if (amt) { const g = groups.filter(([k]) => lakhOf(k) != null && Math.floor(lakhOf(k)) === Math.floor(Number(amt[1]))); if (g.length === 1) return g[0][1]; }
    const cnt = q.match(/\b(\d+)\s+(?:roles?|ones?|positions?|of them)\b/) || q.match(/^\s*(\d+)\s*\??\s*$/);
    if (cnt) {
      const k = Number(cnt[1]), g = groups.filter(([, d]) => d.length === k);
      if (g.length === 1) return g[0][1];
      if (said.length === k) return ds(said);
    }
    if (/\b(us|usa)\b/.test(q)) { const us = pool.filter((r) => US_RE.test(`${r.designation} ${r.jd_location || ""}`)); if (us.length) return ds(us); }
    if (/\bclosed\b/.test(q)) { const c = pool.filter((r) => r.deadline && new Date(r.deadline) <= now); if (c.length) return ds(c); }
    if (/\b(still )?open\b/.test(q)) { const o = pool.filter((r) => r.deadline && new Date(r.deadline) > now); if (o.length) return ds(o); }
    // "those" alone: every role it named (only when there's no better reading, the model's)
    if (loose && /\b(those|these|them)\b/.test(q) && said.length) return ds(said);
    return [];
  }
  // the one short question asked instead of the same answer again: which of the roles it named
  function clarifyLast(last, data) {
    const ents = entities(data || {});
    const hit = matchCompanies(String(last || ""), data || {}, ents).hits[0];
    const said = hit ? (data.roles || []).filter((r) => hit.raw.has(r.company) && norm(String(last)).includes(norm(r.designation))) : [];
    if (hit && said.length > 1) return `Which of these do you mean? ${roleChips(hit.name, said, "")}`.replace(/%20(?=\))/g, "");
    return "Which part do you mean: a role, the deadline, the JD or eligibility?";
  }
  function noRepeat(out, last, question, data) {
    if (!last || !out?.text || ["ack", "recheck", "act", "help"].includes(out.kind)) return out;
    // the same answer again to a message that points back at it: never sent; one short question instead
    const back = refersBack(question, { text: last }, data);
    if (norm(out.text) === norm(last) && back) return { ...out, text: clarifyLast(last, data), kind: "clarify", repeat: true };
    // a narrower answer to a message that points back ("the US ones?") repeats lines of the last one on purpose: the
    // roles it picked out are the answer, so its lines stay
    if (back && (data?.roleSet || []).length) return out;
    const key = (l) => norm(String(l).replace(/^\s*[-•]\s*/, "").replace(/^(As in my last answer|As before): /, "")).trim();
    const prev = new Set(String(last).split("\n").map(key).filter((k) => k.length > 12));
    const lines = String(out.text).split("\n");
    const fresh = lines.filter((l) => !prev.has(key(l)));
    if (fresh.length === lines.length) return out;
    const where = sourcesOf(question).map((x) => SOURCE_WORD[x]).filter(Boolean);
    // where the answer is (a line with its link) stays findable in one line, never the whole answer again
    const linkLine = lines.find((l) => prev.has(key(l)) && /\]\((https?:|#)/.test(l));
    const one = linkLine ? String(linkLine).replace(/^\s*[-•]\s*/, "") : "";
    if (!fresh.some((l) => key(l).length > 2)) {
      if (refersBack(question, { text: last }, data)) return { ...out, text: clarifyLast(last, data), kind: "clarify", repeat: true };
      return { ...out, repeat: true, text: one ? `As in my last answer: ${one}` : where.length ? `Still nothing new ${where.join(" or ")}: my last answer stands.` : "Nothing new since my last answer." };
    }
    const text = fresh.join("\n").replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
    return { ...out, text: one && !/\]\((https?:|#)/.test(text) ? `${text}\nAs before: ${one}` : text };
  }
  // the reply for a routed message that the model doesn't answer
  function routed(r, question, data) {
    // a follow-up that points back at the last answer, read without the model when it gave no roles
    if (data && data.lastAnswer && refersBack(question, { text: data.lastAnswer }, data)) {
      const pr = pointedRoles(question, data.lastAnswer, data, !(data.roleSet || []).length);
      if (pr.length) data = { ...data, roleSet: pr };
    }
    return noRepeat(routedOnce(r, question, data), data && data.lastAnswer, question, data);
  }
  function routedOnce(r, question, data) {
    const out0 = routedCore(r, question, data);
    if (/\b\d{2}[a-z]{2}\d{5}\b/i.test(String(question)) && out0 && out0.text && !["ack", "help"].includes(out0.kind))
      return { ...out0, text: `I look for your own roll number only: other students' rows in a list are never kept.\n${out0.text}` };
    return out0;
  }
  function routedCore(r, question, data) {
    if (r.kind === "ack") return { kind: "ack", companies: [], text: "👍" };
    // a re-check is done by the page (a live, read-only ERP fetch for that company); here only what it's doing,
    // never the old answer again as if it were fresh
    if (r.kind === "recheck") return { kind: "recheck", companies: r.companies, recheck: r.companies[0] || null,
      text: r.companies.length ? `Checking the ERP for ${r.companies.map(shortName).join(", ")} now…` : "Checking the ERP now…" };
    if (r.kind === "help") return helpAnswer(r.topic, { ...data, platform: r.platform || data.platform, installed: r.platform ? false : data.installed });
    if (r.kind === "act") {
      const verb = (String(question).match(ACT_WORD) || ["do that"])[0].toLowerCase();
      const base = r.spec?.hits?.length ? answer(question, data, { ...r.spec, intents: ["deadline"] }).text.split("\n").slice(0, 3).join("\n") : "";
      return { kind: "act", companies: [], text: `Ping is read-only, so I can't ${verb} for you: it only reads the ERP.${base ? `\n${base}` : ""}` };
    }
    // an open question the model couldn't answer: its leftover words ("plan", "lines") are not company names
    // ("summarise this week" is not a JD question when it names no company)
    if (r.kind === "open" && r.spec) {
      const intents = r.spec.hits?.length ? r.spec.intents : (r.spec.intents || []).filter((i) => i !== "jd");
      return answer(question, data, { ...r.spec, unknown: [], intents: intents.length || !/\bweek\b/.test(norm(question)) ? intents : ["deadline"],
                                      range: r.spec.range });
    }
    return answer(question, data, r.spec);
  }

  // ---------------------------------------------------------------- a re-check's answer
  // rc: a rechecks row { status, company, note, result: { read_at, notices: [{ notice_id, subject, kind, notice_time,
  // file: { status, reliability, read_at, details }, title, link }], changes } }. Never an absence ("not on it").
  const HMs = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const LISTWORD = { shortlist: "shortlist", test: "test list", test_rooms: "test room list", result: "result" };
  function recheckAnswer(rc, now, fallbackLink) {
    const name = shortName(rc.company || rc.result?.company || "");
    const at = (iso) => (iso ? HMs.format(new Date(iso)) : "");
    if (!rc || rc.status === "unreachable" || rc.status === "failed") {
      const link = fallbackLink ? ` Check it yourself: [Open list](${fallbackLink})` : " Check the notice on the ERP yourself.";
      return { kind: "recheck", text: `I couldn't reach the ERP just now${rc?.note ? ` (${rc.note})` : ""}, so I can't confirm anything new for ${name}.${link}` };
    }
    const res = rc.result || {};
    const lists = (res.notices || []).filter((n) => LISTWORD[n.kind] || n.file);
    const lines = [`I checked the ERP for ${name} just now (${at(res.read_at)}).`];
    for (const n of lists.slice(0, 3)) {
      const f = n.file || {};
      const what = LISTWORD[n.kind] || "list";
      const open = n.link ? ` [Open list](${n.link})` : "";
      const src = ` (notice ${n.notice_id}, posted ${when(n.notice_time)}${f.read_at ? `; file read ${at(f.read_at)}` : ""})`;
      let line;
      if ((f.status === "yes" && /^You're on /.test(n.title || "")) || (f.status === "no" && /couldn't find your roll/.test(n.title || ""))) {
        // the feed message's own words (they carry the role, the test time and the room)
        line = cleanNames(n.title).replace(/\.+$/, ".") + (f.status === "no" ? " Here it is:" : "");
      } else if (f.status === "yes") {
        const d = f.details || {};
        const extra = [d.room ? `room ${d.room}` : d.room_or_venue_from_heading ? `room ${d.room_or_venue_from_heading}` : "",
                       d.slot || d.slot_from_heading ? `slot ${d.slot || d.slot_from_heading}` : "", d.time || d.time_from_heading || d.reporting_time || ""].filter(Boolean);
        line = `You're on the ${name} ${what}${extra.length ? `: ${extra.join(", ")}` : ""}.`;
      } else if (f.status === "no") {
        line = `I couldn't find your roll number in the ${name} ${what} (posted ${when(n.notice_time)}). Please check the list yourself:`;
      } else if (n.has_attachment) {
        line = `I couldn't read the ${name} ${what} reliably${f.reliability ? ` (${f.reliability})` : ""}. Check it here:`;
      } else {
        line = `${name} ${what}: "${n.subject}", posted ${when(n.notice_time)} (no file attached).`;
      }
      lines.push(`- ${line}${open}${src}`);
    }
    if (!lists.length) {
      const last = (res.notices || [])[0];
      lines.push(last ? `No shortlist or test list for ${name} on the ERP yet. Latest notice: "${last.subject}", ${when(last.notice_time)}.`
        : `The ERP has no notices for ${name}.`);
    }
    for (const c of (res.changes || []).slice(0, 3)) {
      const w = (v) => (v === "yes" ? "on the list" : v === "no" ? "roll not found" : v === "unknown" ? "couldn't read" : "not checked");
      lines.push(`Changed since my last reading: ${w(c.old)} → ${w(c.new)}. I've updated the message in the chat.`);
    }
    return { kind: "recheck", text: lines.join("\n") };
  }
  // how old the ERP data is, when that matters (over 30 min): "ERP data from 12:41 (1 h 20 min ago)."
  function staleNote(lastChecked, now) {
    if (!lastChecked) return null;
    const mins = Math.round((new Date(now) - new Date(lastChecked)) / 60000);
    if (mins <= 30) return null;
    const ago = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
    return `ERP data from ${HMs.format(new Date(lastChecked))} (${ago} ago).`;
  }

  // ---------------------------------------------------------------- numbers in a model's reply
  // Every number, time and amount the model writes must be in the facts it was given ("model_count_mismatch" if not).
  function numbersIn(text) {
    const t = String(text || "");
    const out = [];
    const re = /(\d{1,2}):(\d{2})|(\d+(?:[.,]\d+)*)\s*(lpa|lakhs?|lacs?|l\b|cr\b|crores?)?/gi;
    let m;
    while ((m = re.exec(t))) {
      if (m[1]) { out.push({ kind: "time", v: `${m[1].padStart(2, "0")}:${m[2]}`, raw: m[0] }); continue; }
      let s = m[3];
      const indian = /^\d{1,3}(,\d{2})*,\d{3}$/.test(s), western = /^\d{1,3}(,\d{3})+$/.test(s);
      if (indian || western) s = s.replace(/,/g, ""); else if (s.includes(",")) { s.split(",").forEach((x) => x && out.push({ kind: "num", v: Number(x), raw: x })); continue; }
      let v = Number(s);
      if (isNaN(v)) continue;
      const unit = (m[4] || "").toLowerCase();
      if (/^(lpa|lakh|lakhs|lac|lacs|l)$/.test(unit)) v *= 1e5; else if (/^(cr|crore|crores)$/.test(unit)) v *= 1e7;
      out.push({ kind: "num", v, raw: m[0].trim() });
    }
    return out;
  }
  // -> the numbers in the reply that aren't in the facts (empty: the reply is fine)
  function unsupportedNumbers(reply, facts, question) {
    const have = numbersIn(`${facts}\n${question || ""}`);
    const times = new Set(have.filter((x) => x.kind === "time").map((x) => x.v));
    const nums = have.filter((x) => x.kind === "num").map((x) => x.v);
    return numbersIn(reply).filter((x) => x.kind === "time" ? !times.has(x.v)
      : !(x.v <= 1 || nums.some((n) => (x.v >= 1e5 ? Math.abs(n - x.v) <= x.v * 0.005 : n === x.v)))).map((x) => x.raw);
  }

  // ---------------------------------------------------------------- feedback: "X not relevant", "show X again"
  // Said plainly or as a reply, with typos ("piamal not relevantt for me"): a company, or one of its roles, hidden from
  // For you (or shown again). Decided here by rules, so it works with the model down; the ask-ping function saves it
  // (profile lists: not_interested_companies, interested_companies, hidden_roles, shown_roles) and the page, the
  // digests, Today, Forms and reminders follow. Never a model call, never a status dump.
  const FB_HIDE = /\bnot\s+(?:very\s+|that\s+|really\s+|at\s+all\s+)?(?:rel[ea]?v[ae]?n\w*|rele\w*|int(?:e)?r(?:e)?st\w*|for\s+me|my\s+(?:thing|type|cup)|needed|useful)|\birr?el[ea]?v[ae]?n\w*|\bno\s+longer\s+int\w*|\buninterest\w*|\bnot\s+keen\b|^\s*(?:please\s+|pls\s+)?(?:ignore|hide|remove|skip|drop|mute)\b|\b(?:don'?t|do\s+not|dont)\s+(?:show|want|care|need|list)\b/i;
  const FB_SHOW = /\b(?:is|are|it'?s|seems?)\s+(?:actually\s+|quite\s+|very\s+)?rel[ea]?v[ae]?n\w*|\brel[ea]?v[ae]?n\w*\s+(?:to|for)\s+me\b|\b(?:is|are)\s+for\s+me\b|\bshow\b.*\bagain\b|\bunhide\b|\bbring\b.*\bback\b|\b(?:i'?m|i\s+am)\s+(?:actually\s+)?int(?:e)?r(?:e)?st\w*\s+in\b|^\s*(?:please\s+)?(?:show|include)\s+\w/i;
  const FB_UNDO = /^\s*(?:undo|undo\s+(?:that|it|the\s+last(?:\s+one)?)|revert(?:\s+that)?)[\s.!]*$/i;
  const QUESTION = /\?\s*$|^\s*(?:is|are|am|was|which|what|whats|why|how|when|where|who|should|do|does|did|can|could|will|would)\b/i;
  const FB_FILLER = /\b(?:not|no|longer|very|that|really|at|all|irr?el\w*|rel\w*|int\w*|uninterest\w*|keen|for|me|my|thing|type|cup|needed|useful|ignore|hide|remove|skip|drop|mute|don'?t|dont|do|show|want|care|need|list|again|unhide|bring|back|i'?m|i|am|is|are|it'?s|it|seems?|actually|quite|please|pls|include|the|this|that|these|those|them|one|ones|company|companies|anymore|any|more|to|in|of|please|also|just|ok|okay)\b/gi;
  // a cheap first look (no data): might this be feedback?
  function feedbackLike(message) {
    const raw = String(message || "").trim();
    return !!raw && raw.length <= 300 && (FB_UNDO.test(raw) || (!QUESTION.test(raw) && (FB_HIDE.test(raw) || FB_SHOW.test(raw))));
  }
  const ROLEWORDS = (s) => norm(s).split(" ").filter((w) => w.length >= 2 && !LEGAL.has(w) && !["and", "the", "of", "for", "role", "roles", "i", "ii", "1", "2"].includes(w));

  // -> null (not feedback) | { action: "undo" } | { action: "hide"|"show", level: "company"|"role", company, roles:[{id,label}] }
  //    | { action, ask: { text, chips: [{label, send}] } } when the company isn't clear
  function feedbackOf(message, data, opts = {}) {
    const raw = String(message || "").trim();
    if (!raw || raw.length > 300) return null;
    if (FB_UNDO.test(raw)) return { action: "undo" };
    if (QUESTION.test(raw)) return null;
    const hide = FB_HIDE.test(raw), show = !hide && FB_SHOW.test(raw);
    if (!hide && !show) return null;
    const action = hide ? "hide" : "show";
    const ents = entities(data);
    const anchor = (opts.anchorCompanies || []).filter(Boolean);
    const rest = raw.replace(FB_FILLER, " ").replace(/[^\w&.\- ]+/g, " ").replace(/\s+/g, " ").trim();
    let hits = rest ? matchCompanies(rest, data, ents).hits : [];
    if (anchor.length) {
      const inAnchor = (e) => anchor.some((a) => keyWords(a).join(" ") === e.key || norm(shortName(a)) === norm(e.name) || [...e.raw].includes(a));
      const scoped = hits.filter(inAnchor);
      if (scoped.length) hits = scoped;
      else if (rest) {
        // a looser match against the quoted message's companies only ("piamal" -> Piramal Finance)
        const toks = tokensOf(rest).filter((t) => t.length >= 4 && !STOP.has(t));
        const loose = ents.filter(inAnchor).filter((e) => toks.some((t) => e.words.some((w) => w.length >= 4 && (editClose(t, w) || w.startsWith(t.slice(0, 4))))));
        if (loose.length) hits = loose;
      }
      if (!hits.length && !rest) hits = ents.filter(inAnchor);
    }
    // no company yet: a short typo of one ("grow" -> Groww), when exactly one company fits
    if (!hits.length && rest) {
      const toks = tokensOf(rest).filter((t) => t.length >= 4 && !STOP.has(t));
      const near = (t, w) => w.length >= 4 && (w.startsWith(t) || t.startsWith(w) || editClose(t, w) ||
        (Math.abs(t.length - w.length) <= 1 && Math.min(t.length, w.length) >= 4 && lev1(t, w)));
      const loose = ents.filter((e) => e.roles && toks.some((t) => e.words.some((w) => near(t, w))));
      if (loose.length === 1) hits = loose;
    }
    // a statement with no company: about the previous turn's company, else ask which
    if (!hits.length && opts.previousCompanies?.length) hits = ents.filter((e) => opts.previousCompanies.includes(e.name));
    if (!hits.length && !anchor.length && rest && tokensOf(rest).every((t) => STOP.has(t) || ROLE_HINT.test(t))) return null;    // "not interested in sde roles": a preference about role types
    if (hits.length !== 1) {
      const pool = (hits.length ? hits : anchor.length ? ents.filter((e) => anchor.some((a) => [...e.raw].includes(a) || norm(shortName(a)) === norm(e.name))) : []).slice(0, 5);
      if (!pool.length) return hits.length || anchor.length || rest ? { action, ask: { text: `Which company should I ${action === "hide" ? "hide from" : "show again in"} For you? For example: "${action === "hide" ? "hide" : "show"} ${ents[0]?.name || "Groww"}".`, chips: [] } } : null;
      return { action, ask: { text: `${action === "hide" ? "Hide" : "Show"} which one ${action === "hide" ? "from" : "in"} For you?`,
        chips: [...pool.map((e) => ({ label: e.name, send: `${action} ${e.name}` })), { label: "None", send: "never mind" }] } };
    }
    const e = hits[0];
    // a role of that company named too ("piramal sde not relevant"): that role only
    const words = new Set(tokensOf(rest).filter((t) => !e.words.includes(t) && !(e.key.includes(t))));
    const roles = (data.roles || []).filter((r) => e.raw.has(r.company));
    const named = words.size ? roles.filter((r) => { const rw = ROLEWORDS(r.designation || ""); return rw.some((w) => words.has(w)) && rw.length; }) : [];
    if (named.length && named.length < roles.length) {
      return { action, level: "role", company: [...e.raw][0], name: e.name, roles: named.map((r) => ({ id: r.id, label: `${e.name} — ${r.designation}` })) };
    }
    return { action, level: "company", company: [...e.raw].find((c) => roles.some((r) => r.company === c)) || [...e.raw][0], name: e.name, roles: [] };
  }
  // one edit apart (insert, delete or replace one letter)
  function lev1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  const ROLE_HINT = /^(sde|swe|analyst|analytics|data|product|consulting|consultant|finance|quant|core|software|engineer\w*|developer|design\w*|marketing|sales|ops|operations|hr|research\w*|scientist|management|trainee|manager|banking|strategy|roles?)$/;

  // the four lists after a hide / show (company names as the companies list writes them; role ids)
  const cmp = (s) => norm(String(s || "")).replace(/ /g, "");
  const sameCo = (a, b) => { const x = cmp(a), y = cmp(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
  function applyFeedback(lists, fb, roles) {
    const L = { not_interested_companies: [...(lists.not_interested_companies || [])], interested_companies: [...(lists.interested_companies || [])],
                hidden_roles: [...(lists.hidden_roles || [])], shown_roles: [...(lists.shown_roles || [])] };
    const coRoles = (roles || []).filter((r) => sameCo(r.company, fb.company)).map((r) => String(r.id));
    if (fb.level === "company") {
      if (fb.action === "hide") {
        if (!L.not_interested_companies.some((c) => sameCo(c, fb.company))) L.not_interested_companies.push(fb.company);
        L.interested_companies = L.interested_companies.filter((c) => !sameCo(c, fb.company));
        L.shown_roles = L.shown_roles.filter((id) => !coRoles.includes(String(id)));
      } else {
        const was = L.not_interested_companies.some((c) => sameCo(c, fb.company)) || L.hidden_roles.some((id) => coRoles.includes(String(id)));
        L.not_interested_companies = L.not_interested_companies.filter((c) => !sameCo(c, fb.company));
        L.hidden_roles = L.hidden_roles.filter((id) => !coRoles.includes(String(id)));
        // "show X again" after a hide: back to how Ping judges it; "X is relevant": always For you
        if (!was && !L.interested_companies.some((c) => sameCo(c, fb.company))) L.interested_companies.push(fb.company);
      }
    } else {
      const ids = fb.roles.map((r) => String(r.id));
      if (fb.action === "hide") {
        L.hidden_roles = [...new Set([...L.hidden_roles.map(String), ...ids])];
        L.shown_roles = L.shown_roles.filter((id) => !ids.includes(String(id)));
      } else {
        const was = L.hidden_roles.some((id) => ids.includes(String(id)));
        L.hidden_roles = L.hidden_roles.filter((id) => !ids.includes(String(id)));
        if (!was) L.shown_roles = [...new Set([...L.shown_roles.map(String), ...ids])];
      }
    }
    return L;
  }
  // one line, with its Undo button ([Undo](#ask:undo): the page draws it as a button that sends "undo")
  function feedbackLine(fb) {
    const what = fb.level === "role" ? fb.roles.map((r) => r.label).join(", ") : fb.name;
    return fb.action === "hide" ? `Got it, ${what} won't show as For you anymore. [Undo](#ask:undo)`
      : `Got it, ${what} will show as For you. [Undo](#ask:undo)`;
  }
  // For you, as you've said it: true / false, or null (Ping's own marks decide)
  function pinned(role, lists) {
    if (!role || !lists) return null;
    const id = String(role.id);
    if ((lists.hidden_roles || []).map(String).includes(id)) return false;
    if ((lists.shown_roles || []).map(String).includes(id)) return true;
    if ((lists.not_interested_companies || []).some((c) => sameCo(c, role.company))) return false;
    if ((lists.interested_companies || []).some((c) => sameCo(c, role.company))) return true;
    return null;
  }
  // "My preferences": the lists in words
  function describeLists(lists, roles) {
    const label = (id) => { const r = (roles || []).find((x) => String(x.id) === String(id)); return r ? `${shortName(r.company)} — ${r.designation}` : null; };
    const hid = [...(lists.not_interested_companies || []).map(shortName), ...(lists.hidden_roles || []).map(label).filter(Boolean)];
    const shw = [...(lists.interested_companies || []).map(shortName), ...(lists.shown_roles || []).map(label).filter(Boolean)];
    return [hid.length ? `hidden from For you: ${hid.join(", ")}` : "hidden from For you: none",
            shw.length ? `always For you: ${shw.join(", ")}` : ""].filter(Boolean).join("; ");
  }
  // a reply that is a statement Ping can't place, with the model down: one short question, never a status dump
  function clarify(message, anchorCompanies, data) {
    const ents = entities(data);
    const named = matchCompanies(message, data, ents).hits.filter((e) => anchorCompanies.some((a) => [...e.raw].includes(a) || norm(shortName(a)) === norm(e.name)));
    if (named.length === 1) return { text: `Hide ${named[0].name} from For you? [Yes](#ask:${encodeURIComponent(`hide ${named[0].name}`)}) [No](#ask:never%20mind)` };
    const names = anchorCompanies.map(shortName).slice(0, 4);
    if (!names.length) return null;
    return { text: `I'm not sure what you'd like me to do with that. Hide one of these from For you? ${names.map((n) => `[${n}](#ask:${encodeURIComponent(`hide ${n}`)})`).join(" ")} [No](#ask:never%20mind)` };
  }

  const api = { refersBack, pointedRoles, clarifyLast, ctcGroups, unresolved, learnCasing, lookup, sourcesOf, noRepeat, clarifyCompany, feedbackLike, feedbackOf, applyFeedback, feedbackLine, pinned, describeLists, clarify, answer, route, routed, prefsLike, isRecheck, recheckAnswer, staleNote, cleanNames, helpTopic, helpAnswer, platformOf, asksToAct, numbersIn, unsupportedNumbers, dueBlocks, urgentLine, matchCompanies, intentsOf, entities, shortName, deadlineEntries, jdAnswer, timeRange };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PingRules = api;
})(typeof window !== "undefined" ? window : globalThis);
