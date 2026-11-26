/* First-run onboarding, inside the chat: one question per message, chips + free text, "Skip" always there.
 * Pure logic (no page code), so the whole script is tested in tests/js/onboarding.test.js.
 * Progress is saved in the profile (onboarding_step) after every answer, so a refresh resumes where it stopped.
 * Everything set here can be changed later just by telling Ping ("check every 30 minutes", "remind me 4 hours before").
 */
(function (root) {
  "use strict";
  const ORDER = ["welcome", "education", "targets", "others", "cv", "schedule", "hours", "reminders", "first_check", "done"];
  const PERSONAL_ONLY = new Set(["targets", "others", "cv"]);
  const DEGREES = ["B.Tech", "Dual Degree", "M.Tech", "M.Sc", "MBA"];
  const TARGET_EXAMPLES = ["Product & consulting", "Data & analytics", "Finance", "Core engineering"];

  // the next step, leaving out the questions about targets when the feed is "everything"
  function next(step, ctx) {
    let i = ORDER.indexOf(step);
    if (i < 0) return "welcome";
    while (++i < ORDER.length) {
      const s = ORDER[i];
      if (PERSONAL_ONLY.has(s) && (ctx && ctx.feed_mode) === "all") continue;
      return s;
    }
    return "done";
  }

  // should onboarding show? resumes any unfinished step; starts only for an empty profile with no messages
  function shouldRun(profile, messageCount) {
    const step = profile && profile.onboarding_step;
    if (step === "done") return false;
    if (step && ORDER.includes(step)) return true;
    const empty = !(profile && (profile.targets || profile.department || profile.degree));
    return empty && !messageCount;
  }

  function startStep(profile) {
    const s = profile && profile.onboarding_step;
    return s && ORDER.includes(s) && s !== "done" ? s : "welcome";
  }

  // what Ping says at a step: {lines, chips:[{label, value?, insert?}], free (placeholder or null), upload}
  function question(step, ctx) {
    ctx = ctx || {};
    const skip = { label: "Skip", value: "__skip" };
    switch (step) {
      case "welcome":
        // the demo: straight to the feed in one tap, or the questions a student gets
        if (ctx.demo && !ctx.walk) return {
          lines: ["Hi, I'm Ping. Every hour I read your placement ERP (companies, notices and the PDFs that name you) and tell you only what's about you.",
                  "This is a demo with a made-up student. Jump straight to the feed, or see how a student sets me up?"],
          chips: [{ label: "Use the demo profile", value: "__demo", primary: true }, { label: "Walk me through it", value: "__walk" }],
          free: null,
        };
        return {
          lines: [ctx.walk ? "Here's what a student answers the first time (in the demo nothing is saved to anyone's profile)."
                           : "Hi, I'm Ping. Every hour I read your placement ERP (companies, notices and the PDFs that name you) and tell you only what's about you.",
                  "I only read: I never apply, submit or change anything on the ERP.",
                  "How do you want your feed?"],
          chips: [{ label: "Only what fits me", value: "personal" }, { label: "Everything from the ERP", value: "all" }, skip],
          free: null,
        };
      case "education":
        return {
          lines: [ctx.degree ? `Got it: ${ctx.degree}. And your department, as the ERP writes it?`
                             : "Your degree and department? I need them to check what you're eligible for."],
          chips: [...(ctx.degree ? [] : DEGREES.map((d) => ({ label: d, value: d }))), skip],
          free: "Your department, e.g. as on the ERP",
        };
      case "targets":
        return {
          lines: ["What are you looking for? Tap one, or type it in your own words."],
          chips: [...TARGET_EXAMPLES.map((t) => ({ label: t, value: `${t} roles` })), skip],
          free: "In your own words: the roles you want, and any you don't",
        };
      case "others":
        return { lines: ["Want the other roles listed separately, so you don't miss anything?"],
                 chips: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }, skip], free: null };
      case "cv":
        // the upload control, Later and Skip sit in the bubble itself (inline); the demo uses its made-up CVs
        return { lines: [ctx.demo ? "Pick the CV I should suggest roles from? The demo student has three made-up CVs ready."
                                  : "Upload a CV so I can suggest which one to apply with? PDF, up to 5 MB; only you can see it."],
                 chips: [...(ctx.demo ? [{ label: "Use the demo CVs", value: "democvs", primary: true }] : []),
                         { label: "Later", value: "later" }, skip],
                 free: null, upload: !ctx.demo, inline: true };
      case "schedule":
        return { lines: ["How often should I check the ERP?"],
                 chips: [{ label: "Every hour", value: "60" }, { label: "Every 2 hours", value: "120" },
                         { label: "Every 30 min", value: "30" }, skip], free: null };
      case "hours":
        return { lines: ["Between which hours (IST)?"],
                 chips: [{ label: "06:00 – 01:00", value: "06:00-01:00" }, { label: "08:00 – 22:00", value: "08:00-22:00" },
                         { label: "All day", value: "00:00-00:00" }, skip],
                 free: "Or type them, e.g. 7 to 23" };
      case "reminders":
        return { lines: ["When should I remind you before a deadline?"],
                 chips: [{ label: "1 h", value: "1" }, { label: "2 h", value: "2" }, { label: "4 h", value: "4" },
                         { label: "Day before", value: "24" }, skip], free: null };
      case "first_check":
        return { lines: [ctx.demo ? "All set. This demo shows a real run from 21 Nov, so the feed is already here."
                                  : "Running your first check now… The first one reads two weeks of notices, so give it about 10 minutes."],
                 chips: [], free: null };
      default:
        return { lines: [], chips: [], free: null };
    }
  }

  // a typed answer -> the chip it means ("yes", "every hour", "2h", "day before", "later", "demo"…), or null
  function typedChoice(step, text, ctx) {
    const t = String(text || "").toLowerCase().replace(/[^a-z0-9: ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (/^(skip|skip it|no thanks|not now|pass|nah)$/.test(t)) return "__skip";
    if (step === "welcome") {
      if (ctx.demo && !ctx.walk) return /demo|use|jump|feed|quick|go/.test(t) ? "__demo" : /walk|set ?up|show|how|through/.test(t) ? "__walk" : null;
      return /everything|all|every thing|dont filter|don t filter/.test(t) ? "all" : /fit|me|personal|only|mine|filter/.test(t) ? "personal" : null;
    }
    if (step === "others") return /^(y|yes|yeah|yep|sure|ok|okay|list them|please)\b/.test(t) ? "yes" : /^(n|no|nope|don t|dont)\b/.test(t) ? "no" : null;
    if (step === "cv") return /later|not now|after/.test(t) ? "later" : ctx.demo && /demo|use|yes/.test(t) ? "democvs" : null;
    if (step === "schedule") {
      if (/\b30\b|half/.test(t)) return "30";
      if (/\b(2|two)\s*(h|hr|hrs|hour|hours)\b|\b120\b/.test(t)) return "120";
      if (/\b(1|one|an|every)\s*(h|hr|hour)\b|hourly|\b60\b|^hour$|every hour/.test(t)) return "60";
      return null;
    }
    if (step === "reminders") {
      if (/day|24/.test(t)) return "24";
      const m = /(?:^|\D)(1|2|4|one|two|four)(?:\D|$)/.exec(t);
      return m ? { one: "1", two: "2", four: "4" }[m[1]] || m[1] : null;
    }
    if (step === "first_check") return "__go";
    return null;
  }

  const hhmm = (h, m) => `${String(Number(h) % 24).padStart(2, "0")}:${m || "00"}`;

  // an answer -> what to save and where to go. input: {value} from a chip, {text} typed, or {skip: true}
  function answer(step, input, ctx) {
    ctx = ctx || {};
    const v = input && input.value, text = ((input && input.text) || "").trim();
    const go = (save, extra) => {
      const merged = Object.assign({}, ctx, save);
      const n = next(step, merged);
      return Object.assign({ save: Object.assign({}, save, { onboarding_step: n }), next: n }, extra || {});
    };
    if ((input && input.skip) || v === "__skip") return go({}, { skipped: true });
    // typed answers work at every step: a typed word that names one of the answers counts as tapping it
    if (text && !v) {
      const m = typedChoice(step, text, ctx);
      if (m === "__skip") return go({}, { skipped: true });
      if (m) return answer(step, { value: m }, ctx);
    }
    switch (step) {
      case "welcome":
        if (v === "__demo") return { save: { onboarding_step: "done" }, next: "done", useDemo: true };
        if (v === "__walk") return { save: {}, next: step, ctxPatch: { walk: true } };
        if (v === "personal" || v === "all") return go({ feed_mode: v });
        if (text) return go({ feed_mode: /everything|all|don'?t filter/i.test(text) ? "all" : "personal" });
        return { save: {}, next: step };
      case "education": {
        if (v && !text) return { save: { degree: v }, next: step, ctxPatch: { degree: v } };   // then the department
        if (text) {
          const deg = [...[["DUAL", "Dual Degree"], ["M.TECH", "M.Tech"], ["MTECH", "M.Tech"], ["B.TECH", "B.Tech"], ["BTECH", "B.Tech"],
                           ["M.SC", "M.Sc"], ["MSC", "M.Sc"], ["MBA", "MBA"]]].find(([k]) => text.toUpperCase().includes(k));
          const dept = text.replace(/\b(b\.?\s?tech|m\.?\s?tech|dual\s+degree|m\.?\s?sc|mba)\b/ig, "").replace(/[,;]+/g, " ").trim();
          const save = {};
          if (deg && !ctx.degree) save.degree = deg[1];
          if (dept) save.department = dept.toUpperCase();
          if (!save.department) return { save, next: step, ctxPatch: save };
          return go(save);
        }
        return { save: {}, next: step };
      }
      case "targets":
        // saved through Ask Ping ("my targets are ..."): it marks the roles and answers with one "Saved: ..." line
        if (text || v) return go({}, { askPing: `my targets are ${text || v}` });
        return { save: {}, next: step };
      case "others":
        if (v === "yes" || v === "no") return go({ list_other_roles: v === "yes" });
        return { save: {}, next: step };
      case "cv":
        if (v === "later" || v === "uploaded" || v === "democvs") return go({}, { cvDone: v });
        return { save: {}, next: step };
      case "schedule":
        if (["30", "60", "120"].includes(v)) return go({ check_every_minutes: Number(v) });
        return { save: {}, next: step };
      case "hours": {
        let m = v && /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(v);
        if (m) return go({ check_from: m[1], check_to: m[2] });
        m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|and|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
        if (m) {
          const conv = (h, ap) => { h = Number(h); if (ap && /pm/i.test(ap) && h < 12) h += 12; if (ap && /am/i.test(ap) && h === 12) h = 0; return h; };
          return go({ check_from: hhmm(conv(m[1], m[3]), m[2]), check_to: hhmm(conv(m[4], m[6]), m[5]) });
        }
        return { save: {}, next: step };
      }
      case "reminders":
        if (["1", "2", "4", "24"].includes(v)) return go({ reminder_hours: Number(v) });
        return { save: {}, next: step };
      case "first_check":
        return go({});
      default:
        return { save: {}, next: "done" };
    }
  }

  // the demo profile in one tap (the demo persona is already on the demo profile)
  const DEMO_DONE = { onboarding_step: "done" };

  // the last message, once the first feed is in
  const CLOSING = ["Your feed is in. Here is how the thread works:",
    "• New roles come as one message per check, with their deadlines.",
    "• Roles closing at the same time come as one digest, and you get one reminder before they close.",
    "• Shortlists, tests and room lists that name you get their own message, with the time.",
    "Want something different? Just tell me, e.g. \"check every 30 minutes\", \"remind me 4 hours before\" or \"only show me finance roles\"."];

  // where CVs live afterwards, said once after the CV step (a link that opens that card)
  const CV_LATER = "You can change these anytime in [Profile › My CVs](#profile/cvs).";

  const api = { ORDER, next, shouldRun, startStep, question, answer, typedChoice, DEMO_DONE, CLOSING, CV_LATER, DEGREES, TARGET_EXAMPLES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PingOnboarding = api;
})(typeof window !== "undefined" ? window : globalThis);
