// What a compact card says, pure (no page): the deadline in relative words ("Today 23:59 · 2 h 24 m left" when under 6 h,
// "Tomorrow 20:00", "Mon 23 Nov · past due") and a notice / form title cleaned down to what it adds to "Company ·
// task" ("[URGENT] : CDC | NOMURA | Additonal Details" adds nothing; "Groww | APM Additional Requirement" adds "APM").
// Only what renders: the data is never changed. Node tests: tests/js/cards.test.js.
(function (root) {
  const TZ = "Asia/Kolkata";
  const ms = (v) => (v == null || v === "" ? NaN : typeof v === "number" ? v : new Date(v).getTime());
  const dayKey = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t));
  const hm = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
  const dayMon = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" })
    .format(new Date(t)).replace(",", "");
  const plusDays = (t, n) => dayKey(t + n * 86400000);

  // "2 h 24 m", "45 m", "under 1 m"
  function span(d) {
    const m = Math.floor(d / 60000);
    if (m < 1) return "under 1 m";
    const h = Math.floor(m / 60);
    return h ? `${h} h${m % 60 ? ` ${m % 60} m` : ""}` : `${m} m`;
  }

  const URGENT = 6 * 3600000;
  // The second line of a card. event: a test / talk (it is "over", not "past due"). level: for the colour.
  function relDeadline(at, now, { event = false } = {}) {
    const t = ms(at);
    if (Number.isNaN(t)) return { text: "No deadline given", level: "none" };
    const today = dayKey(now), day = dayKey(t);
    if (t <= now) return { text: `${day === today ? `Today ${hm(t)}` : dayMon(t)} · ${event ? "over" : "past due"}`, level: "over" };
    // the countdown only when it's close (under 6 hours), in red; otherwise just the day and time
    const label = day === today ? `Today ${hm(t)}` : day === plusDays(now, 1) ? `Tomorrow ${hm(t)}` : `${dayMon(t)} ${hm(t)}`;
    if (t - now < URGENT) return { text: `${label} · ${span(t - now)} left`, level: "urgent" };
    return { text: label, level: day === today ? "today" : day === plusDays(now, 1) ? "soon" : "later" };
  }

  // ---------------------------------------------------------------- titles
  const TYPOS = [[/\badditonal\b/gi, "Additional"], [/\baddtional\b/gi, "Additional"], [/\bmanagment\b/gi, "Management"],
    [/\brequirment(s?)\b/gi, "Requirement$1"], [/\brecuritment\b/gi, "Recruitment"], [/\bdetials\b/gi, "Details"],
    [/\bregisteration\b/gi, "Registration"], [/\bapplicaton\b/gi, "Application"], [/\bprefrence\b/gi, "Preference"],
    [/\bshorlist(ed)?\b/gi, "Shortlist$1"], [/\bsubmision\b/gi, "Submission"], [/\bintership\b/gi, "Internship"],
    [/\banalyist\b/gi, "Analyst"], [/\bconsultent\b/gi, "Consultant"]];
  // words that only say "a form / an application from the placement office": never worth a line of their own
  const GENERIC = new Set(("additional details detail requirement requirements form forms google application applications apply " +
    "campus recruitment recruitments registration register notice notices update updates urgent important reminder cdc ft fte " +
    "full time intern internship internships placement placements drive for the of and to a an in on regarding reg re fill " +
    "filling link links submission submit cv cvs resume resumes preference preferences process batch students student all " +
    "please kindly iit kgp kharagpur new hiring opportunity opportunities round info information pfa attached").split(" "));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tidy = (s) => s.replace(/\s{2,}/g, " ").replace(/^[\s·,.;-]+|[\s·,.;-]+$/g, "").trim();
  // "GOLDMAN SACHS" stays; "OPERATIONS ANALYST" -> "Operations Analyst" (a shouted phrase), short acronyms kept
  const unshout = (s) => (s === s.toUpperCase() && /[A-Z]{5,}/.test(s)
    ? s.split(" ").map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(" ") : s);
  function companyWords(company) {
    const base = String(company || "").replace(/\s*\([^)]*\)/g, "")
      .replace(/\b(private|pvt|limited|ltd|llp|inc|india|technologies|technology|solutions|services|group)\b\.?/gi, " ").trim();
    const words = base.split(/[\s.]+/).filter((w) => w.length >= 2).map((w) => w.toLowerCase());
    // initials: "FischerJordan" -> "fj", "Axis Bank" -> "ab"
    const parts = base.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s.]+/).filter(Boolean);
    const initials = parts.length > 1 ? parts.map((p) => p[0]).join("").toLowerCase() : "";
    return { words: new Set(words), whole: base.toLowerCase().replace(/[^a-z0-9]+/g, ""), initials };
  }
  // The title as it reads once what the first line already says is gone: "" when nothing is left.
  // drop: more words the first line says (the task, the role shown elsewhere)
  function cleanTitle(title, company, drop = []) {
    let s = String(title || "");
    if (!s.trim()) return "";
    for (const [re, to] of TYPOS) s = s.replace(re, to);
    s = s.replace(/\[[^\]]*\]|\((urgent|important|reminder)\)/gi, " ");
    const co = companyWords(company);
    const dropWords = new Set(drop.flatMap((d) => String(d || "").toLowerCase().split(/\s+/)).filter(Boolean));
    const isCompany = (w) => {
      const k = w.toLowerCase().replace(/[^a-z0-9]+/g, "");
      return !!k && (co.words.has(w.toLowerCase().replace(/[.,]+$/, "")) || k === co.whole || (co.initials.length > 1 && k === co.initials)
        || (k.length >= 4 && co.whole.startsWith(k)));
    };
    const junk = (w) => {
      const k = w.toLowerCase().replace(/[^a-z0-9.]+/g, "").replace(/\.$/, "");
      return !k || GENERIC.has(k) || /^(19|20)\d\d(-\d\d)?$/.test(k) || dropWords.has(k) || isCompany(w);
    };
    const segs = s.split(/\s*(?:\||:|–|—|\s-\s)\s*/);
    const kept = [];
    for (const seg of segs) {
      let words = seg.split(/\s+/).filter(Boolean).filter((w) => !isCompany(w));
      while (words.length && junk(words[0])) words.shift();
      while (words.length && junk(words[words.length - 1])) words.pop();
      if (!words.length || words.every(junk)) continue;
      kept.push(unshout(tidy(words.join(" "))));
    }
    const out = tidy([...new Set(kept)].join(" · "));
    return out ? out[0].toUpperCase() + out.slice(1) : "";
  }

  // The card's type, never a vague "Update": the run stores it (ping/summaries.py label, details.label); this is the
  // same rule for a card written before that.
  const SUBMIT = { assignment: "Assignment", documents: "Documents", cv: "CV submission" };
  function typeLabel(it) {
    const d = (it && it.details) || {}, todo = d.todo || {}, a = todo.action, title = String((it && it.title) || "");
    const cat = it && it.category, kind = d.kind;
    if (d.label) return d.label;
    if (a === "fill_form" || d.form || /\bfill (in )?the form\b/i.test(title)) return "Form";
    // the run stores the type (it reads the notice); without it, the title's words, and Documents only for an upload
    if (a === "submit") return SUBMIT[todo.task] || (/\bcv\b|resume/i.test(title) ? "CV submission"
      : /task[- ]round|take[- ]home|case|assignment/i.test(title) ? "Assignment" : /assessment|online test|coding/i.test(title) ? "Test"
      : /regist\w*.{0,40}portal|create (an |your )?account/i.test(title) ? "Form"
      : /upload|marksheet|certificate|transcript|id proof|signed letter/i.test(title) ? "Documents" : "Submission");
    if (cat === "result") return "Result";
    if (cat === "shortlist" || kind === "shortlist") return "Shortlist";
    if (cat === "ppt" || /pre-placement talk|\bppt\b/i.test(title)) return "Talk";   // a talk is often stored as a timed event
    if (kind === "interview" || (/\binterview/i.test(title) && (cat === "test" || cat === "todo"))) return "Interview";
    if (cat === "test" || kind === "test" || kind === "test_rooms" || a === "take_test") return "Test";
    if (cat === "deadline" || /deadline (extended|moved|changed)|extended to|moved to|postponed|preponed/i.test(title)) return "Deadline change";
    if (cat === "offer" || a === "accept_offer") return "Offer";
    return "Info";
  }

  // The card's own date inside its line (the {when} slot the run leaves): "Today 23:59", "Tomorrow 20:00",
  // "Fri 27 Nov 23:59". One format everywhere; never a date the model wrote.
  function whenText(at, now) {
    const t = ms(at);
    if (Number.isNaN(t)) return "";
    const day = dayKey(t);
    if (t <= now) return `${dayMon(t)} ${hm(t)}`;       // a time that has passed: always the date ("closed Mon 23 Nov 14:00")
    return day === dayKey(now) ? `Today ${hm(t)}` : day === plusDays(now, 1) ? `Tomorrow ${hm(t)}` : `${dayMon(t)} ${hm(t)}`;
  }

  const api = { relDeadline, cleanTitle, span, typeLabel, whenText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PingCards = api;
})(typeof window !== "undefined" ? window : globalThis);
