/* Ping dashboard. Plain JavaScript, no build step.
 *
 * Home screen is a chat with Ping: every "for you" item is a message from
 * Ping, your questions and Ping's answers sit in the same thread, and unread
 * messages are marked. A bottom bar (phones) or a left rail (desktop) leads to
 * Companies (every role, filters, a sheet per role) and Profile (cards edited in
 * place; Account has Check now, All updates, the theme and sign out).
 * Look and feel: docs/DESIGN.md.
 *
 * Two modes:
 *  - real: log in with Supabase; data is read straight from your own Supabase
 *    project with the publishable key, and Row Level Security only lets your
 *    login see it. "Check now" and AI answers go to two small server functions
 *    that hold the GitHub token and the Gemini key, so neither is ever in here.
 *  - demo: data from demo-data.json, no login; the thread is kept in this browser.
 */
(() => {
  "use strict";
  const CFG = window.PING_CONFIG || {};
  const TZ = "Asia/Kolkata";
  const $ = (s) => document.querySelector(s);
  const LEVELS = { always: "You applied", show: "Open for you", hidden: "Hidden" };
  const PAST = /deadline gone|already happened|older than 3 days|replaced by the 24h reminder|updated by a later message/;

  // ------------------------------------------------------------ tiny DOM helper (no innerHTML: notice text is untrusted)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "href") el.setAttribute("href", safeUrl(v));
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const companyHref = (name) => `#co-${slug(name)}`;
  // company names for display only ("Auro Group(www.AuroIM.com)" -> "Auro Group"): dashboard/names.js
  const { cleanName, cleanRowText } = window.PingNames || { cleanName: (x) => String(x || ""), cleanRowText: (x) => String(x || "") };
  // web links, in-page links, and this site's own pages (setup.html); never javascript: or data:
  const safeUrl = (u) => (/^(https?:|#|mailto:|\?)/i.test(String(u)) || /^[a-z0-9-]+\.html$/i.test(String(u)) ? String(u) : "#");
  const mount = (...nodes) => { const app = $("#app"); app.replaceChildren(...nodes); };
  // every page but the chat: one centred column that scrolls (the chat scrolls its own thread)
  const mountPage = (...nodes) => { mount(h("div", { class: "page" }, ...nodes)); $("#app").scrollTop = 0; };
  const store = {  // per-browser conveniences only; every read/write may fail (private windows)
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------ dates (always IST)
  const dt = (v) => (v ? new Date(v) : null);
  // formatters made once (toLocale*String with options builds a new one on every call: slow on a phone)
  const F_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
  const F_HM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const F_WD = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
  const F_DM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "short" });
  const istDay = (d) => F_DAY.format(d);
  function when(v) {
    const d = dt(v);
    if (!d || isNaN(d)) return "";
    // always with the date, same as Ping's messages ("Sat 21 Nov 20:00")
    return `${F_WD.format(d)} ${F_DM.format(d)} ${F_HM.format(d)}`;
  }
  const clock = (v) => F_HM.format(dt(v));
  function dayLabel(v) {
    const d = dt(v), today = istDay(nowDate()), yest = istDay(new Date(nowDate() - 86400000));
    const k = istDay(d);
    if (k === today) return "Today";
    if (k === yest) return "Yesterday";
    return d.toLocaleDateString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  const money = (n, cur) => (n == null ? "—" : `${Number(n).toLocaleString("en-IN")} ${cur || ""}`.trim());

  // ------------------------------------------------------------ the installable app: an IndexedDB copy of the last
  // thread (read offline) and the messages sent while offline (asked when back online)
  const kv = (() => {
    let db = null;
    const open = () => db || (db = new Promise((ok, no) => {
      const r = indexedDB.open("ping", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    }));
    const tx = async (mode, fn) => { const d = await open(); return new Promise((ok, no) => {
      const t = d.transaction("kv", mode), req = fn(t.objectStore("kv")); t.oncomplete = () => ok(req?.result); t.onerror = () => no(t.error); }); };
    return { get: (k) => tx("readonly", (s) => s.get(k)).catch(() => null), set: (k, v) => tx("readwrite", (s) => s.put(v, k)).catch(() => null) };
  })();
  // offline: the thread as it was when last loaded; reading works, sending queues
  // a form_status change: a tick, or "Not for me" (its time; a reason when you give one)
  function patchOf(x) {
    if (typeof x === "boolean") return { filled: x, filled_at: x ? new Date().toISOString() : null };
    const p = { ...x };
    if ("not_for_me" in p) p.not_for_me_at = p.not_for_me ? new Date().toISOString() : null;
    if ("not_for_me" in p && !p.not_for_me) p.not_for_me_reason = null;
    return p;
  }
  class OfflineSource {
    constructor(snap) {
      this.s = snap; this.kind = snap.kind || "real"; this.demo = !!snap.demo; this.offline = true;
      // where the saved chat starts (older open items in the copy stay out of it, as online)
      this.itemsFrom = snap.itemsFrom || null; this.chatFrom = snap.chatFrom || null;
    }
    async load() { return unpackDemo(this.s.data); }   // a saved copy in the demo file's packed form works too
    async chat() { return this.s.chat || []; }
    async readAt() { return this.s.readAt || null; }
    async setReadAt() {}
    async addChat() {}
    async ask() { const e = new TypeError("offline"); e.offline = true; throw e; }
    async recheck() { const e = new TypeError("offline"); e.offline = true; throw e; }
    async notice() { return { notice: null }; }
    async checkNow() { throw new Error("You're offline: Check now works once you're back online."); }
  }
  const isNetErr = (e) => e && (e.offline || e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message || ""));
  // an error in plain words for the person reading it (DESIGN.md, Tone); the raw one goes to the console
  function plainly(e) {
    const m = String(e?.message || "");
    if (e) console.warn(e);
    if (isNetErr(e) || !navigator.onLine) return "No connection. Try again when you're back online.";
    if (e?.status === 401 || /jwt|expired|not authenticated|invalid claim/i.test(m)) return "Your sign-in has expired. Sign in again, then try once more.";
    if (/exceed|too large|payload/i.test(m)) return "That file is too big (5 MB at most).";
    if (/mime|content.?type/i.test(m)) return "Only PDF files can be uploaded.";
    if (e?.status === 429) return m;                     // the demo's question limit: already in plain words
    return "Something went wrong on Ping's side. Try again in a minute.";
  }

  // ------------------------------------------------------------ data sources
  class DemoSource {
    constructor(data) { this.d = data; this.kind = "demo"; }
    async load() { return this.d; }
    async mail(id) { return (this.d.emails || []).find((m) => m.id === id || m.id === `sample:${id}`) || null; }
    async notice(noticeId) {
      const n = this.d.notices.find((x) => x.notice_id === noticeId);
      return { notice: n, check: n && this.d.pdf_checks.find((c) => c.notice_id === n.id) };
    }
    async saveProfile(p) { Object.assign(this.d.profile, p); }
    async markItem(id, patch) { Object.assign(this.d.items.find((i) => i.id === id) || {}, patch); }
    async correct(noticeKey, fix) {
      const it = this.d.items.find((i) => i.needs_review && i.details?.notice_key === noticeKey);
      if (it) { it.level = "hidden"; it.title = fix.ignore ? "Marked not relevant." : `Noted: it's about ${fix.company}.`; }
    }
    async checkNow() { return "Demo mode: this would start a real run on GitHub. Nothing was started."; }
    async recheck() { return { demo: true }; }
    // form ticks: this browser's own (the static demo has no login)
    async formStatus() { return Object.entries(store.get("ping-demo-forms", {})).map(([form_key, v]) => ({ form_key, ...v })); }
    async setFormStatus(key, filled) {
      const all = store.get("ping-demo-forms", {});
      all[key] = { ...(all[key] || {}), ...patchOf(filled) };
      store.set("ping-demo-forms", all);
      return all[key];
    }
    async formMerge(a, b, choice) { store.set("ping-demo-merges", { ...store.get("ping-demo-merges", {}), [`${a}|${b}`]: choice }); }
    async formMerges() { return Object.entries(store.get("ping-demo-merges", {})).map(([k, choice]) => { const [a, b] = k.split("|"); return { a, b, choice }; }); }
    async ask(q) { if (state.details) { state.startDetails?.(); await state.details; } return answerLocally(q, this.d); }
    async chat() { return store.get("ping-demo-chat", []); }
    async addChat(m) { store.set("ping-demo-chat", [...store.get("ping-demo-chat", []), m].slice(-500)); }
    async readAt() { return store.get("ping-demo-read", null); }
    async setReadAt(t) { store.set("ping-demo-read", t); }
  }

  const READ_ONLY = "The demo is read-only: changes aren't saved.";
  const DEMO_CHIP = "Demo \u2014 sample data, read-only";
  // what a demo visitor may set for their own session (session_prefs); the demo student's details stay fixed
  const DEMO_OWN = ["targets", "reminder_hours", "list_other_roles", "feed_mode", "check_every_minutes", "check_from", "check_to"];
  // One class for both logins: the owner (real rows) and a one-click demo session (an anonymous sign-in that the
  // database only lets read the anonymised demo rows and its own chat).
  // how many messages the chat reads at a time (newest first, then older ones as you scroll up)
  const WINDOW = 200;
  // the same message from several reads (the window, the open items, a moved one): one copy, the fullest
  function mergeItems(...lists) {
    const map = new Map();
    // a full row replaces a lean one; a lean one never replaces a full one; the later read wins otherwise, keeping
    // whether it was read as part of the chat's window (__win: drawn in the chat)
    for (const list of lists) for (const it of list || []) {
      const prev = map.get(it.id);
      if (it.__lean && prev && !prev.__lean) continue;
      if (prev?.__win) it.__win = true;
      map.set(it.id, it);
    }
    return [...map.values()];
  }
  // rows read as part of the chat's window: the chat draws them (whatever their notice's time); the open items read
  // for To do and Today alone don't come into the chat
  const inWindow = (rows) => { for (const r of rows || []) r.__win = true; return rows; };
  // a lean history row shaped like a message (its details with the fields the page reads)
  function leanItem(r) {
    const { hidden_because, subject, venue, kind, notice_time, pdf, via, mail, todo, form, posted_at, reposted_at, ...rest } = r;
    const details = Object.fromEntries(Object.entries({ hidden_because, subject, venue, kind, notice_time, pdf, via, mail, todo, form, posted_at, reposted_at })
      .filter(([, v]) => v != null));
    return { ...rest, details, __lean: true };
  }

  class SupabaseSource {
    constructor(sb, demo = false) {
      this.sb = sb; this.kind = demo ? "demo" : "real"; this.demo = demo; this.chatOk = true;
    }
    async q(table, fn) {
      let query = this.sb.from(table).select("*");
      if (fn) query = fn(query);
      const { data, error } = await query;
      if (error) throw new Error(`${table}: ${error.message}`);
      return data;
    }
    // every row, a page at a time: the database's API returns at most 1,000 rows per request whatever limit is asked,
    // so a single read of a longer table silently stops at the oldest 1,000 (25 Nov: the newest messages, BlueStone's
    // and RISA Labs' assignments, never reached the chat, To do or Today)
    async all(table, fn, cols = "*", page = 1000) {
      const out = [];
      for (let from = 0; from < 20000; from += page) {
        let query = this.sb.from(table).select(cols);
        if (fn) query = fn(query);
        const { data, error } = await query.range(from, from + page - 1);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...(data || []));
        if (!data || data.length < page) break;
      }
      return out;
    }
    // What the page opens with: never the whole history (it grows every hour). The chat's newest WINDOW messages (and
    // any posted again since), the open items To do and Today list (asked for directly: a deadline or event still
    // ahead or just past, not dismissed), roles, profile, runs, notices, forms. Older messages come as you scroll up
    // (olderItems / olderChat); the whole history only when something needs it (history(): Ask Ping's answers on the
    // page, the Updates list, a company's page).
    async load() {
      const [recent, open, roles, profile, runs, notices] = await Promise.all([
        this.recentItems(),
        this.openItems(),
        this.all("roles", (q) => q.order("id", { ascending: true })),
        this.q("profile"),
        this.q("runs", (q) => q.order("id", { ascending: false }).limit(30)),
        // the latest notices, one line each on Today (the full text is read when one is opened)
        this.sb.from("notices").select("notice_id,year,company,subject,notice_time,preview,kind:analysis->>kind,targets:analysis->targets,todos:analysis->todos").order("notice_time", { ascending: false }).limit(1000)
          .then((r) => r.data || [], () => []),
      ]);
      const [forms, moved] = await Promise.all([this.forms(), this.movedSince(this.itemsFrom)]);
      const items = mergeItems(recent, moved, open);
      // the demo is a snapshot: its profile row carries the time it was taken
      return { items, roles, profile: profile[0] || {}, runs, notices, forms,
               generated_at: this.demo ? profile[0]?.updated_at : undefined };
    }
    // the newest WINDOW messages; itemsFrom: the oldest one's first_seen (null: there are no older ones)
    async recentItems() {
      const rows = await this.q("items", (q) => q.order("first_seen", { ascending: false }).order("id", { ascending: false }).limit(WINDOW));
      this.itemsFrom = rows.length >= WINDOW ? rows[rows.length - 1].first_seen : null;
      return inWindow(rows);
    }
    // the next WINDOW older messages (scrolling up); [] when there are none
    async olderItems() {
      if (!this.itemsFrom) return [];
      const rows = await this.q("items", (q) => q.lt("first_seen", this.itemsFrom).order("first_seen", { ascending: false })
        .order("id", { ascending: false }).limit(WINDOW));
      this.itemsFrom = rows.length >= WINDOW ? rows[rows.length - 1].first_seen : null;
      return inWindow(rows);
    }
    // messages first seen before the window but posted (again) inside it: they're drawn there (details.posted_at,
    // reposted_at). The times are compared as text by the database, so a day's margin; the page keeps the right ones.
    async movedSince(from) {
      if (!from) return [];
      const since = new Date(Date.parse(from) - 86400000).toISOString();
      const rows = await this.all("items", (q) => q.lt("first_seen", from).or(`details->>posted_at.gte.${since},details->>reposted_at.gte.${since}`)
        .order("id", { ascending: true })).catch(() => []);
      return inWindow(rows.filter((it) => Math.max(Date.parse(it.details?.posted_at || "") || 0, Date.parse(it.details?.reposted_at || "") || 0) >= Date.parse(from)));
    }
    // what To do and Today list, asked for directly: not dismissed, with a deadline from a week ago on or an event
    // from two days ago on (a past one stays in their "Past due" for a week)
    async openItems() {
      const due = new Date(Date.now() - 7 * 86400000).toISOString(), ev = new Date(Date.now() - 2 * 86400000).toISOString();
      return this.all("items", (q) => q.eq("dismissed", false).or(`due_at.gte.${due},event_at.gte.${ev}`).order("id", { ascending: true }));
    }
    // a live update: what changed since the page loaded it, the same window (newer messages, moved ones, open items)
    async items() {
      const from = this.itemsFrom;
      const [win, moved, open] = await Promise.all([
        from ? this.all("items", (q) => q.gte("first_seen", from).order("first_seen", { ascending: true }).order("id", { ascending: true }))
          : this.all("items", (q) => q.order("first_seen", { ascending: true }).order("id", { ascending: true })),
        this.movedSince(from), this.openItems()]);
      return mergeItems(inWindow(win), moved, open);
    }
    // the whole history, lean (no list rows or form pages): Ask Ping's answers on this page, the Updates list,
    // "which lists am I on"; read once, when first needed
    async history() {
      return this.all("items", (q) => q.order("first_seen", { ascending: true }).order("id", { ascending: true }),
        "id,company,category,title,due_at,event_at,level,pdf_status,role_ids,notice_id,first_seen,sort_at," +
        "dismissed,done,needs_review,hidden_because:details->>hidden_because,subject:details->>subject,venue:details->>venue,kind:details->>kind," +
        "notice_time:details->>notice_time,pdf:details->pdf,via:details->>via,mail:details->mail,todo:details->todo,form:details->form," +
        "posted_at:details->>posted_at,reposted_at:details->>reposted_at").then((rows) => rows.map(leanItem));
    }
    // the forms list (the hourly run builds it): the ones still open or closed in the last two weeks (To do's folds)
    async forms() {
      const since = new Date(Date.now() - 14 * 86400000).toISOString();
      return this.all("forms", (q) => q.or(`due_at.gte.${since},due_at.is.null`).order("due_at", { ascending: true }).order("key", { ascending: true })).catch(() => []);
    }
    // your ticks (your own rows: form_status), every page of them
    async formStatus() { return this.all("form_status", (q) => q.order("form_key", { ascending: true })).catch(() => []); }
    // a tick (true / false) or a patch ({ not_for_me, not_for_me_reason }): only those columns change
    async setFormStatus(key, filled) {
      const { data: { session } } = await this.sb.auth.getSession();
      const row = { owner_id: session?.user?.id, form_key: key, ...patchOf(filled), updated_at: new Date().toISOString() };
      const { error } = await this.sb.from("form_status").upsert(row, { onConflict: "owner_id,form_key" });
      if (error) throw new Error(error.message);
      return row;
    }
    async formMerges() { return this.all("form_merges", (q) => q.order("a", { ascending: true })).catch(() => []); }
    async formMerge(a, b, choice) {
      const { data: { session } } = await this.sb.auth.getSession();
      const { error } = await this.sb.from("form_merges").upsert({ owner_id: session?.user?.id, a, b, choice }, { onConflict: "owner_id,a,b" });
      if (error) throw new Error(error.message);
    }
    // live updates (see startLive): the latest runs, and the items again once a run has finished
    async liveRuns() { return this.q("runs", (q) => q.order("id", { ascending: false }).limit(30)); }
    async mail(id) {
      // a demo row's mail is stored as "sample:<id>"
      const { data, error } = await this.sb.from("emails").select("id,subject,snippet,main_link,received_at").in("id", [id, `sample:${id}`]).limit(1);
      if (error) throw new Error(`emails: ${error.message}`);
      return (data || [])[0] || null;
    }
    async notice(noticeId) {
      const [n] = await this.q("notices", (q) => q.eq("notice_id", noticeId).limit(1));
      const checks = n ? await this.q("pdf_checks", (q) => q.eq("notice_id", n.id)) : [];
      return { notice: n, check: checks[0] };
    }
    async saveProfile(p) {
      if (this.demo) {
        // a demo visitor may set what they're looking for: their own session only (session_prefs), never the
        // owner's profile; the rest of the demo profile is read-only
        const { data: { user } } = await this.sb.auth.getUser();
        const own = Object.fromEntries(Object.entries(p).filter(([k]) => DEMO_OWN.includes(k)));
        if (!Object.keys(own).length) throw new Error(READ_ONLY);
        const { error } = await this.sb.from("session_prefs").upsert({ owner_id: user.id, ...own, updated_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
        state.sessionPrefs = { ...(state.sessionPrefs || {}), ...own };
        return "Saved for this demo session only.";
      }
      const { error } = await this.sb.from("profile").update({ ...p, updated_at: new Date().toISOString() })
        .eq("id", state.data.profile?.id ?? 1);
      if (error) throw new Error(error.message);
    }
    // onboarding answers: the owner's profile row, or a demo session's own row (never the owner's profile)
    async saveOnboarding(save) {
      if (!Object.keys(save).length) return;
      if (this.demo) {
        const { data: { user } } = await this.sb.auth.getUser();
        const { error } = await this.sb.from("session_prefs").upsert({ owner_id: user.id, ...save, updated_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
        return;
      }
      const { error } = await this.sb.from("profile").update(save).eq("id", 1);
      if (error) throw new Error(error.message);
    }
    async sessionPrefs() {
      if (!this.demo) return null;
      const { data } = await this.sb.from("session_prefs").select("*").limit(1);
      return (data || [])[0] || {};
    }
    async latestRun() {
      const { data } = await this.sb.from("runs").select("started_at,finished_at,status").order("started_at", { ascending: false }).limit(1);
      return (data || [])[0] || null;
    }
    // "For you" marks for the current targets, from the server's cache (the page never sees the cache itself)
    async marks() {
      const out = await this.fn("ask-ping", { marks: true });
      return { prefs: out.prefs || {}, marks: new Map(Object.entries(out.marks || {})), lists: out.lists || null };
    }
    async markItem(id, patch) {
      if (this.demo) return;           // the demo: on this page only (the shared demo rows are read-only)
      const { error } = await this.sb.from("items").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    }
    async correct(noticeKey, fix) {
      if (this.demo) return;           // the demo: on this page only
      const { error } = await this.sb.from("corrections").upsert({ notice_id: noticeKey, ...fix });
      if (error) throw new Error(error.message);
    }
    async fn(name, body) {
      const { data: { session } } = await this.sb.auth.getSession();
      const r = await fetch(`${CFG.supabaseUrl}/functions/v1/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify(body || {}),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(out.error || `HTTP ${r.status}`), { status: r.status });
      return out;
    }
    // starts the Ping workflow; the function creates the run's row ("queued") and returns its id
    async checkNow() { return this.fn("check-now"); }
    // "check FirstClub again": one company read again from the ERP (read-only); a demo session gets the snapshot's reading
    async recheck(company, question) { return this.demo ? { demo: true } : this.fn("check-now", { task: "recheck", company, question }); }
    async recheckRow(id) { const { data } = await this.sb.from("rechecks").select("*").eq("id", id).limit(1); return data?.[0] || null; }
    async ask(q, reply) {
      // the demo is a snapshot: "tomorrow" is the day after it, as everywhere else on the page
      const asOf = this.demo && state.asOf ? new Date(state.asOf).toISOString() : undefined;
      const R = window.PingRules;
      try {
        const out = await this.fn("ask-ping", { question: q, as_of: asOf, ...(reply ? { reply } : {}) });
        if (out.prefs_changed) state.prefsChanged = true;
        if (out.lists) { state.lists = { ...(state.lists || {}), ...out.lists }; state.marksVersion = (state.marksVersion || 0) + 1; }
        return out.answer;
      }
      catch (e) {
        // feedback ("X not relevant") is saved by the function: without it, say so, never answer something else
        if (R?.feedbackLike(q)) return isNetErr(e) || e.status >= 500 ? "I couldn't save that just now. Try again in a moment."
          : `I couldn't save that (${plainly(e)}).`;
        if (e.status === 429) return `${e.message}\n\nMeanwhile, from the ERP data: ${answerLocally(q, state.data)}`;
        // a reply that is a statement: one short question, never the status of every company it quotes
        if (reply && !/\?\s*$/.test(q) && R?.clarify) { const c = R.clarify(q, reply.companies || [], factsOf(state.data)); if (c) return c.text; }
        // short and plain: what happened, and that the answer below is still from the ERP data
        const why = e.status === 403 ? "this login can't ask Ping's assistant" : e.status === 400 ? "Ping's assistant couldn't take that message"
          : "Ping's assistant couldn't be reached";
        return answerLocally(q, state.data) + `\n\n(${why}, so this answer comes straight from the ERP data.)`;
      }
    }
    // The thread lives in the chat_messages table; if it isn't there yet (sql/chat.sql not run), this browser keeps it.
    // the newest WINDOW messages of the thread (oldest first); chatFrom: the oldest one's time (null: none older).
    // since: only the ones after it (a live update)
    async chat(since = null) {
      const read = (cols) => {
        let q = this.sb.from("chat_messages").select(cols);
        if (since) return q.gt("created_at", since).order("created_at", { ascending: true }).limit(WINDOW);
        return q.order("created_at", { ascending: false }).limit(WINDOW);
      };
      let { data, error } = await read("role,text,created_at,reply_to,reply_quote");
      if (error) ({ data, error } = await read("role,text,created_at"));
      if (error) { this.chatOk = false; return store.get("ping-chat", []); }
      if (since) return data;
      this.chatFrom = data.length >= WINDOW ? data[data.length - 1].created_at : null;
      return data.reverse();
    }
    // the next WINDOW older messages of the thread (scrolling up), oldest first
    async olderChat() {
      if (!this.chatFrom || !this.chatOk) return [];
      const { data, error } = await this.sb.from("chat_messages").select("role,text,created_at,reply_to,reply_quote")
        .lt("created_at", this.chatFrom).order("created_at", { ascending: false }).limit(WINDOW);
      if (error) return [];
      this.chatFrom = data.length >= WINDOW ? data[data.length - 1].created_at : null;
      return data.reverse();
    }
    async addChat(m) {
      if (this.chatOk) {
        // a demo session's messages are demo rows: only that session can read them back
        const row = { role: m.role, text: m.text, created_at: m.created_at, ...(this.demo ? { is_sample: true } : {}),
                      ...(m.reply_to ? { reply_to: m.reply_to, reply_quote: m.reply_quote || null } : {}) };
        let { error } = await this.sb.from("chat_messages").insert(row);
        // before Admin > apply-sql adds the reply columns: the message without its quote
        if (error && m.reply_to) ({ error } = await this.sb.from("chat_messages").insert({ role: row.role, text: row.text, created_at: row.created_at, ...(this.demo ? { is_sample: true } : {}) }));
        if (!error) return;
        this.chatOk = false;
      }
      store.set("ping-chat", [...store.get("ping-chat", []), m].slice(-500));
    }
    async readAt() { return (!this.demo && state.data.profile?.chat_read_at) || store.get(this.demo ? "ping-demo-session-read" : "ping-read", null); }
    async setReadAt(t) {
      store.set(this.demo ? "ping-demo-session-read" : "ping-read", t);
      if (this.demo) return;
      await this.sb.from("profile").update({ chat_read_at: t }).eq("id", 1);
    }
  }

  // ------------------------------------------------------------ state + boot
  const state = { src: null, data: null, filter: "visible", companyQuery: "", chat: [], open: new Set(), asOf: null,
                  openedAt: Date.now(), held: [] };
  // The demo shows a snapshot: "now" starts when it was taken (so its deadlines don't all read "passed" a week later)
  // and moves on from there in real time, so its countdowns tick like the real ones.
  const nowDate = () => new Date(state.asOf ? state.asOf + (Date.now() - state.openedAt) : Date.now());
  const liveNow = () => nowDate().getTime();      // the clock runs are judged by (the demo's own, or the real one)
  window.PingNow = liveNow;                       // read-only, for the page checks (setup/live_page_test.py)

  async function boot() {
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
      // a new deploy takes over at once: the new worker installs, claims this page, and the page reloads onto the
      // new build (not while you're typing). Without this an installed app showed the previous build until it had
      // been opened twice (cache first). Checked again whenever the app comes back to the front.
      const hadWorker = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadWorker || reloading || document.querySelector("#ask-input")?.value) return;
        reloading = true; location.reload();
      });
      navigator.serviceWorker.register("sw.js", { scope: "./" }).then((reg) => {
        document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
      }).catch(() => {});
      // a tapped notification: the worker asks this window to open the message
      navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "open" && e.data.url) location.href = e.data.url; });
    }
    const params = new URLSearchParams(location.search);
    const wantDemo = params.has("demo") || location.hash === "#demo";
    const hasBackend = CFG.supabaseUrl && CFG.supabaseKey && window.supabase;
    if (wantDemo || !hasBackend) return startDemo(!hasBackend && !wantDemo);
    // no connection (or the library didn't load): the last-loaded thread, if there is one
    const snap = await kv.get("snap");
    if ((!navigator.onLine || !window.supabase) && snap) return startOffline(snap);
    migrateSession();
    const sb = authClient(AUTH_KEY);
    const owner = await restoreSession(sb, AUTH_KEY);
    if (owner === "ok") { keepSessionFresh(sb); return startReal(sb); }
    if (owner === "unreachable") return waitForServer(snap);
    // no owner session on this device: an anonymous demo session from before (the runners'), if it's still good
    if (await hasStored(DEMO_AUTH_KEY)) {
      const demo = authClient(DEMO_AUTH_KEY);
      if (await restoreSession(demo, DEMO_AUTH_KEY) === "ok") { keepSessionFresh(demo); return startReal(demo); }
    }
    return showLogin(sb);
  }

  // ------------------------------------------------------------ staying signed in
  // Sign in once and stay signed in, like a chat app: Supabase keeps a session (a short-lived access token and a
  // refresh token; never the password) in this device's localStorage under a fixed key, refreshes it before it
  // runs out, and again whenever the app comes back to the screen (phones suspend installed apps). An anonymous demo
  // session has its own key and its own client, so it can never replace or sign out the owner's session. Sign-outs
  // are for this device only.
  const AUTH_KEY = "ping-auth";
  const DEMO_AUTH_KEY = "ping-demo-auth";
  // Where the session lives: localStorage, and a second copy in IndexedDB. Refresh tokens are single-use, so a
  // refreshed session must reach storage: iPhone writes localStorage to disk lazily, and an installed app closed
  // right after a refresh can lose that write and wake up next time with a token the server has already replaced
  // (the auth log of 22 Nov: "Invalid Refresh Token: Refresh Token Not Found", then a password sign-in). IndexedDB
  // commits each write; reading takes whichever copy is newer.
  const sessionStore = (() => {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("ping-session", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const idb = async (mode, op) => {
      const d = await db();
      return new Promise((res, rej) => {
        const t = d.transaction("kv", mode);
        const req = op(t.objectStore("kv"));
        t.oncomplete = () => res(req?.result ?? null);
        t.onerror = t.onabort = () => rej(t.error);
      });
    };
    const newer = (a, b) => { const e = (v) => { try { return JSON.parse(v)?.expires_at || 0; } catch { return 0; } }; return e(b) > e(a) ? b : a; };
    return {
      async getItem(k) {
        let a = null, b = null;
        try { a = localStorage.getItem(k); } catch { /* blocked */ }
        try { b = await idb("readonly", (st) => st.get(k)); } catch { /* no IndexedDB */ }
        return a && b ? newer(a, b) : a || b || null;
      },
      async setItem(k, v) {
        try { localStorage.setItem(k, v); } catch { /* blocked */ }
        try { await idb("readwrite", (st) => st.put(v, k)); } catch { /* no IndexedDB */ }
      },
      async removeItem(k) {
        try { localStorage.removeItem(k); } catch { /* blocked */ }
        try { await idb("readwrite", (st) => st.delete(k)); } catch { /* no IndexedDB */ }
      },
    };
  })();
  const hasStored = async (key) => !!(await sessionStore.getItem(key));
  const clients = {};
  function authClient(key) {
    if (!clients[key]) clients[key] = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: sessionStore, storageKey: key },
    });
    return clients[key];
  }
  // sessions saved under supabase-js's default key by earlier versions: moved once, so the update signs nobody out
  function migrateSession() {
    try {
      const old = `sb-${new URL(CFG.supabaseUrl).hostname.split(".")[0]}-auth-token`;
      const v = localStorage.getItem(old);
      if (!v) return;
      const target = JSON.parse(v)?.user?.is_anonymous ? DEMO_AUTH_KEY : AUTH_KEY;
      if (!localStorage.getItem(target)) sessionStore.setItem(target, v);
      localStorage.removeItem(old);
    } catch { /* storage blocked: nothing to move */ }
  }
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // "ok": a usable session (refreshed if it had run out); "none": nothing stored, or the server refused it (only
  // then the sign-in screen); "unreachable": a session is stored but the server can't be reached yet (a phone
  // waking up): never the sign-in screen for that
  async function restoreSession(sb, key) {
    if (!(await hasStored(key))) return "none";
    for (let i = 0; i < 3; i++) {
      // supabase-js retries a refresh that can't reach the server for up to 30 s: after 6 s, say so instead
      let res;
      try { res = await Promise.race([sb.auth.getSession(), pause(6000).then(() => ({ slow: true }))]); }
      catch (e) { res = { error: e }; }
      if (res.data?.session && res.data.session.expires_at * 1000 > Date.now()) return "ok";
      if (!(await hasStored(key))) return "none";    // supabase-js drops a session the server refused
      if (res.slow) return "unreachable";
      await pause(700 * (i + 1));                    // a quick network error: the phone may still be waking up
    }
    return (await hasStored(key)) ? "unreachable" : "none";
  }
  // back on screen (unlocked, switched back to, restored from the back-forward cache) or back online: refresh now
  function keepSessionFresh(sb) {
    const wake = () => {
      if (document.visibilityState !== "visible") { sb.auth.stopAutoRefresh?.(); return; }
      sb.auth.startAutoRefresh?.();
      sb.auth.getSession().catch(() => {});        // refreshes a token that ran out while the app was away
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", (e) => { if (e.persisted) wake(); });
    window.addEventListener("online", wake);
  }
  // signed in, but the server can't be reached: the last-loaded thread if there is one, else a plain note that
  // tries again by itself; never the sign-in form
  function waitForServer(snap) {
    if (snap) return startOffline(snap);
    mountPage(h("div", { class: "login card", id: "reconnecting" },
      h("h1", {}, "Ping"),
      h("p", {}, "You're signed in, but Ping's server can't be reached right now. Trying again\u2026"),
      h("button", { type: "button", class: "btn", onclick: () => location.reload() }, "Try now")));
    const again = () => location.reload();
    window.addEventListener("online", again, { once: true });
    // the refresh supabase-js keeps trying: once it gets through, carry on
    authClient(AUTH_KEY).auth.onAuthStateChange((ev, session) => { if (session && (ev === "TOKEN_REFRESHED" || ev === "SIGNED_IN")) again(); });
    setTimeout(again, 20000);
  }

  // the published demo-data.json keeps each distinct "allowed departments" list once (dashboard/build.sh)
  function unpackDemo(d) {
    if (Array.isArray(d.allowed_lists)) for (const r of d.roles || []) if (typeof r.allowed === "number") r.allowed = d.allowed_lists[r.allowed];
    return d;
  }
  async function startDemo(noBackend) {
    const early = window.PING_DEMO_DATA && await window.PING_DEMO_DATA;      // started in the page's head
    window.PING_DEMO_DATA = null;
    const data = early || await (await fetch("demo-data.json", { cache: "no-store" })).json();
    state.src = new DemoSource(unpackDemo(data));
    // the roles' JD text, pay details and JD summaries: fetched once the chat is on screen, merged into the same role
    // objects; the role sheet and local answers wait for them (demoDetails)
    if (data.details_file) {
      let go; const started = new Promise((r) => { go = r; });
      state.details = started.then(() => fetch(data.details_file, { cache: "no-store" })).then((r) => r.json()).then((det) => {
        for (const r of data.roles || []) if (det[r.id]) Object.assign(r, det[r.id]);
      }).catch(() => {});
      state.startDetails = go;
    }
    $("#mode-badge").replaceChildren("Demo", h("span", { class: "long" }, DEMO_CHIP.replace(/^Demo/, "")));
    $("#mode-badge").title = "Anonymised snapshot of a real run, no login";
    $("#mode-badge").hidden = false;
    if (!noBackend) state.exit = { label: "Exit demo", run: () => { location.href = location.pathname; } };
    await afterStart();
    if (state.startDetails) requestAnimationFrame(() => setTimeout(state.startDetails, 0));   // after the first paint
  }

  async function startOffline(snap) {
    state.src = new OfflineSource(snap);
    state.offline = true;
    if (snap.demo) { $("#mode-badge").replaceChildren("Demo"); $("#mode-badge").hidden = false; }
    await afterStart();
    status(`Offline: your thread as of ${when(snap.savedAt)}. Messages you send wait until you're back online.`);
    window.addEventListener("online", () => location.reload(), { once: true });
  }

  async function startReal(sb) {
    let rpc;
    try { rpc = await sb.rpc("is_ping_owner"); } catch (e) { rpc = { error: e }; }
    if (rpc.error && isNetErr(rpc.error)) { const snap = await kv.get("snap"); if (snap) return startOffline(snap); }
    const { data: ok, error } = rpc;
    let demo = false;
    if (!error && !ok) {
      const r = await sb.rpc("is_ping_demo");
      demo = !r.error && r.data === true;
    }
    if (error || (!ok && !demo)) {
      mountPage(h("div", { class: "login card" },
        h("h1", {}, "Not allowed"),
        h("p", {}, "This login isn't on Ping's list of allowed users. Ping adds the MAIL_ADDRESS from your " +
          "GitHub secrets on every run; to use another email, add it to the allowed_users table in Supabase."),
        error ? h("p", { class: "muted small" }, plainly(error)) : null,
        h("button", { class: "btn", onclick: async () => { await sb.auth.signOut({ scope: "local" }); location.reload(); } }, "Sign out")));
      return;
    }
    state.src = new SupabaseSource(sb, demo);
    if (demo) {
      // "Demo — sample data, read-only"; the second part is hidden on narrow phones
      $("#mode-badge").replaceChildren("Demo", h("span", { class: "long" }, DEMO_CHIP.replace(/^Demo/, "")));
      $("#mode-badge").title = "Anonymised snapshot of a real run: real companies, a made-up student";
      $("#mode-badge").hidden = false;
    }
    // this device only: signing out on a laptop never signs the phone out (and a demo session is its own client)
    state.exit = { label: demo ? "Exit demo" : "Sign out", run: async () => { await sb.auth.signOut({ scope: "local" }); location.replace(location.pathname); } };
    await afterStart();
    // split the lists by the current marks once they arrive, but never while a question is waiting for its answer
    // drawn in place (live), never a full redraw: that would move the chat under someone reading it
    loadMarks().then(() => { if (state.marks?.size && !state.sending) applyLive(); });
  }

  async function afterStart() {
    try {
      state.data = await state.src.load();
      state.data.forms = state.data.forms || [];
      await loadTicks();
      stampItems();
      state.chat = await state.src.chat();
      state.readAt = await state.src.readAt();
      noteWindow();
      if (state.src.kind !== "real") {
        const run = (state.data.runs || [])[0] || {};
        const snap = dt(state.data.generated_at || run.finished_at || run.started_at)?.getTime() || null;
        // the snapshot's minute, 48 s in: the demo's clock turns a minute a few seconds after it opens
        state.asOf = snap ? Math.floor(snap / 60000) * 60000 + 48000 : null;
        state.openedAt = Date.now();
        holdBackLastCheck(snap);
      }
    } catch (e) { mountPage(h("div", { class: "card" }, h("h1", {}, "Couldn't load your data"), h("p", {}, plainly(e)))); return; }
    if (!state.offline) store.set("ping-visits", Number(store.get("ping-visits", 0)) + 1);   // the install offer comes on the 2nd
    setupNav();
    showLastRun();
    await decideOnboarding();
    window.addEventListener("hashchange", route);
    route();
    if (state.offline) return;
    startLive();
    saveSnapshot();
    flushQueue();
    window.addEventListener("online", () => { status(""); flushQueue(); });
    window.addEventListener("offline", () => status("Offline: you can read your thread; messages you send wait until you're back online."));
  }

  // The chat shows what's loaded from where both windows start (messages and the thread: the later of their oldest);
  // the open items To do and Today read can be older and are never drawn out of place in the chat
  function noteWindow() {
    const a = state.src?.itemsFrom, b = state.src?.chatFrom;
    const t = [a, b].filter(Boolean).map((x) => Date.parse(x));
    state.winFrom = t.length ? Math.max(...t) : null;
  }
  const hasEarlier = () => !!(state.src?.olderItems && (state.src.itemsFrom || state.src.chatFrom));
  // every message the page has (the window, open items, older pages, and the whole history once read)
  function knownItems() { return state.history ? mergeItems(state.history, state.data.items) : state.data.items; }
  // the whole history (lean), read once when something needs it; again after a check brought new messages
  function ensureHistory() {
    if (!state.src?.history) return Promise.resolve();
    if (!state.historyP) state.historyP = state.src.history().then((rows) => { state.history = withoutHeld(rows); })
      .catch(() => { state.historyP = null; });
    return state.historyP;
  }
  function forgetHistory() { state.history = null; state.historyP = null; }
  // scrolling up: more of what's loaded first, then the next page of older messages
  async function loadEarlier() {
    if (state.loadingEarlier) return;
    const all = threadEntries();
    const shown = state.renderCount || THREAD_WINDOW;
    if (all.length > shown) { state.renderCount = shown + THREAD_WINDOW; return redrawAnchored(); }
    if (!hasEarlier() || !state.src.olderItems) return;
    state.loadingEarlier = true;
    try {
      const [items, chat] = await Promise.all([state.src.olderItems(), state.src.olderChat()]);
      state.data.items = mergeItems(withoutHeld(items), state.data.items);
      state.chat = [...chat.filter((m) => !state.chat.some((x) => msgKey(x.role, x.created_at) === msgKey(m.role, m.created_at))), ...state.chat];
      noteWindow();
      state.renderCount = shown + THREAD_WINDOW;
      redrawAnchored();
    } finally { state.loadingEarlier = false; }
  }
  // redraw the chat with the message at the top staying where it is
  function redrawAnchored() {
    const thread = $("#thread");
    const first = thread && [...thread.querySelectorAll("[data-key]")].find((n) => n.getBoundingClientRect().bottom > thread.getBoundingClientRect().top);
    const key = first?.dataset.key, off = first ? first.getBoundingClientRect().top - thread.getBoundingClientRect().top : 0;
    route();
    const t2 = $("#thread"), n = key && t2?.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (t2 && n) t2.scrollTop += n.getBoundingClientRect().top - t2.getBoundingClientRect().top - off;
  }

  // the copy of the thread the app opens offline (owner or demo session; the static ?demo=1 copy doesn't need one)
  let snapTimer = null;
  function saveSnapshot() {
    if (!state.data || state.offline || !state.src?.sb) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => kv.set("snap", { kind: state.src.kind, demo: !!state.src.demo, data: state.data, chat: state.chat,
      itemsFrom: state.src.itemsFrom || null, chatFrom: state.src.chatFrom || null,
      readAt: state.readAt, asOf: state.asOf, savedAt: new Date().toISOString() }), 1500);
  }
  // messages written while offline, asked in order once the connection is back
  async function flushQueue() {
    const q = (await kv.get("queue")) || [];
    if (!q.length || state.offline || !navigator.onLine) return;
    await kv.set("queue", []);
    document.querySelectorAll(".msg.queued, .msg.offline-note").forEach((n) => n.remove());
    for (const m of q) {
      const input = $("#ask-input"), thread = $("#thread");
      if (!input || !thread) { await kv.set("queue", q.slice(q.indexOf(m))); return; }
      input.value = m.text;
      await send(input, thread.querySelector(".thread-inner"), thread, document.querySelector(".composer .send"));
    }
  }

  // The demo: the messages its snapshot's last check brought (first seen at the snapshot time) are held back, and the
  // demo's first Check now finds them, as that check did. Every later Check now finds nothing new.
  function holdBackLastCheck(snap) {
    if (!snap) return;
    const fresh = (it) => inChat(it) && Math.abs(dt(it.first_seen) - snap) < 120000;
    state.held = state.data.items.filter(fresh);
    state.data.items = withoutHeld(state.data.items);
  }
  const withoutHeld = (items) => (state.held.length ? items.filter((it) => !state.held.some((x) => x.id === it.id)) : items);

  // ------------------------------------------------------------ live updates (no reloads)
  // Supabase Realtime pushes new chat_messages and every change to runs. Row rules hold on the channel: a demo
  // session receives only its own chat rows and the demo's runs. Items change only when a run writes them, so they
  // are read again when a run finishes. On tab focus everything is read again (Realtime can drop while a laptop
  // sleeps); if the socket fails, the page polls: every 15 s while a run is going, every 60 s otherwise.
  const live = { ok: false, timer: null, syncing: false, newCount: 0, firstNew: null, syncJump: null, local: new Set(), channel: null };

  function startLive() {
    document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
    window.addEventListener("focus", () => sync());
    const sb = state.src.sb;
    if (!sb || !state.src.liveRuns) return;                      // the offline ?demo=1 copy: nothing to listen to
    live.channel = sb.channel("ping-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (p) => onChat(p.new))
      .on("postgres_changes", { event: "*", schema: "public", table: "runs" }, (p) => onRun(p.new))
      // a tick on another device (your own rows only: the row rules hold on the channel)
      .on("postgres_changes", { event: "*", schema: "public", table: "form_status" }, (p) => onTick(p.new))
      // a re-check the chat is waiting for
      .on("postgres_changes", { event: "*", schema: "public", table: "rechecks" }, (p) => onRecheck(p.new))
      .subscribe((st) => {
        const was = live.ok;
        live.ok = st === "SUBSCRIBED";
        document.body.dataset.live = live.ok ? "on" : "off";      // the live page test waits for this
        if (live.ok && !was) sync();                             // (re)connected: catch up on anything missed
        schedulePoll();
      });
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(live.timer);
    if (live.ok || !state.src?.liveRuns) return;
    live.timer = setTimeout(sync, LIVE.pollEvery(!!LIVE.current(state.data.runs, liveNow())));
  }

  async function sync() {
    if (!state.src?.liveRuns || live.syncing || !state.data) return;
    live.syncing = true;
    try {
      const before = LIVE.lastFinished(state.data.runs)?.id;
      mergeRuns(await state.src.liveRuns(), true);
      const last = state.chat.length ? state.chat[state.chat.length - 1].created_at : null;
      const chat = state.src.chatFrom !== undefined && last ? await state.src.chat(last) : await state.src.chat();
      for (const m of chat || []) addChatRow(m);
      if (LIVE.lastFinished(state.data.runs)?.id !== before) {
        state.data.items = withoutHeld(await state.src.items()); stampItems(); forgetHistory();
        if (state.src.forms) state.data.forms = await state.src.forms();
      }
      await loadTicks(true);
      applyLive();
    } catch { /* offline for a moment: the next poll or focus tries again */ }
    finally { live.syncing = false; schedulePoll(); }
  }

  function addChatRow(m) {
    if (!m?.role || !m.text || !m.created_at) return false;
    const k = msgKey(m.role, m.created_at);
    if (state.chat.some((x) => msgKey(x.role, x.created_at) === k && x.text === m.text)) return false;
    state.chat.push({ role: m.role, text: m.text, created_at: m.created_at, reply_to: m.reply_to || null, reply_quote: m.reply_quote || null });
    return true;
  }
  function onChat(row) { if (addChatRow(row)) applyLive(); }

  async function onRun(row) {
    if (!row?.id) return;
    const was = (state.data.runs || []).find((r) => r.id === row.id);
    const ended = ["done", "failed"].includes(row.stage) && (!was || !["done", "failed"].includes(was.stage));
    mergeRuns([row]);
    // a run that just finished: read its new messages first, so they arrive right after its "Done" line
    if (ended && row.stage === "done") { state.data.items = withoutHeld(await state.src.items().catch(() => state.data.items)); stampItems(); forgetHistory(); }
    // nothing new: no message, at most a short toast for a check you started here; never a bare count
    if (ended && row.stage === "done" && live.local.has(row.id) && !runItems({ ...was, ...row }).length) toast("Nothing new", null, null, 3000);
    applyLive();
    // "check the ERP for the latest" with no company in the conversation: the last question again, on the new data
    if (ended && state.reask) {
      const q = state.reask; state.reask = null;
      const text = row.stage === "done" ? `Checked the ERP just now. ${answerLocally(q, state.data)}` : "The check didn't finish, so I can't give you anything newer. Try Check now in a minute.";
      const reply = { role: "ping", text, created_at: new Date().toISOString() };
      if (addChatRow(reply)) { state.src.addChat(reply).catch(() => {}); applyLive(); }
    }
  }

  // runs, newest first; full=true replaces the list (keeping the demo's played-out checks)
  function mergeRuns(rows, full) {
    const byId = new Map((full ? (state.data.runs || []).filter((r) => live.local.has(r.id)) : state.data.runs || []).map((r) => [r.id, r]));
    for (const r of rows || []) byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
    const at = (r) => Math.max(Date.parse(r.requested_at || 0) || 0, Date.parse(r.started_at || 0) || 0, Date.parse(r.shown_at || 0) || 0);
    state.data.runs = [...byId.values()].sort((a, b) => at(b) - at(a) || String(b.id).localeCompare(String(a.id)));
    applyLive();
  }

  function markRead() {
    state.readAt = new Date().toISOString();
    state.src.setReadAt(state.readAt).catch(() => {});
  }

  // what changed, onto the page: the header, the buttons, and in the chat new bubbles at the bottom and changed
  // ones redrawn in place, never moving what you're reading
  function applyLive() {
    if (!state.data) return;
    saveSnapshot();
    showLastRun();
    renderToday();
    const page = location.hash.slice(1) || "chat";
    if (page === "chat" && !state.onb) liveRender();
    else navUnread(unreadOf(threadEntries()).unread.length);
  }

  function liveRender() {
    const thread = $("#thread"), inner = thread?.querySelector(".thread-inner");
    if (!inner || inner.classList.contains("onb")) return;
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    const have = new Map([...inner.querySelectorAll("[data-key]")].map((n) => [n.dataset.key, n]));
    const added = [];
    keepPlace(thread, atBottom, () => {
      // only what the thread draws: older messages that aren't shown (Show earlier) stay out
      const entries = threadEntries().filter((e) => !state.threadFrom || dt(e.at) >= dt(state.threadFrom));
      // a check that joined a line of "nothing new" checks: its own bubble goes, the line above it updates
      const keys = new Set(entries.map(entryKey));
      for (const [k, n] of have) if (k.startsWith("run:") && !keys.has(k)) { n.remove(); have.delete(k); }
      for (const e of entries) {
        const k = entryKey(e), old = have.get(k);
        if (old) {
          if (old.dataset.sig !== entrySig(e)) old.replaceWith(renderEntry(e));
          continue;
        }
        const node = renderEntry(e);
        node.classList.add("enter");
        appendToday(inner, node);
        added.push(node);
      }
    });
    if (!added.length) return live.syncJump?.();
    if (atBottom) {                                   // at the bottom: follow along
      thread.scrollTop = thread.scrollHeight;
      markRead();
    } else {                                          // reading further up: say so, don't move
      if (!live.newCount) live.firstNew = added[0];
      live.newCount += added.filter((n) => !n.classList.contains("me")).length || 0;
    }
    live.syncJump?.();
  }

  // redraw without moving what's on screen: the first bubble you can see stays exactly where it is
  function keepPlace(thread, atBottom, fn) {
    if (atBottom) return fn();
    const top = thread.getBoundingClientRect().top;
    const anchor = [...thread.querySelectorAll("[data-key]")].find((n) => n.getBoundingClientRect().bottom > top);
    const key = anchor?.dataset.key, before = anchor?.getBoundingClientRect().top;
    fn();
    const now = key && thread.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (now) thread.scrollTop += now.getBoundingClientRect().top - before;
  }

  // ------------------------------------------------------------ first-run onboarding (dashboard/onboarding.js)
  const OB = window.PingOnboarding;
  const LIVE = window.PingLive;
  async function decideOnboarding() {
    state.onb = null;
    if (!OB || !state.src.saveOnboarding) return;          // the static ?demo=1 copy can't save answers
    if (state.src.demo) {
      const sp = await state.src.sessionPrefs().catch(() => ({}));
      state.sessionPrefs = sp || {};
      if (sp?.onboarding_step === "done") return;
      state.onb = { step: OB.startStep(sp || {}), ctx: { demo: true, ...(sp || {}) }, log: [], resumed: !!sp?.onboarding_step };
      return;
    }
    const prof = state.data.profile || {};
    if (OB.shouldRun(prof, state.chat.length)) state.onb = { step: OB.startStep(prof), ctx: { ...prof }, log: [], resumed: !!prof.onboarding_step };
  }

  function setupNav() {
    $("#nav").hidden = false;
    $("#check-now-top").hidden = false;
    document.querySelectorAll("[data-check-now]").forEach((b) => { b.onclick = () => checkNow(); });
    const theme = $("#theme-btn");
    const label = () => {
      const t = themeNow();
      // "Theme", and the mode it's in underneath (Auto / Light / Dark): the button says what it is and what it'll change
      theme.querySelector(".theme-mode").textContent = t === "system" ? "Auto" : t === "dark" ? "Dark" : "Light";
      theme.setAttribute("aria-label", `Theme: ${t === "system" ? "follows the system" : t}. Change`);
    };
    theme.onclick = () => { setTheme({ system: "light", light: "dark", dark: "system" }[themeNow()]); label(); };
    label();
    // phones: while you type, the bottom bar steps aside so the thread keeps the room above the keyboard
    const phone = window.matchMedia("(max-width: 899px)");
    document.addEventListener("focusin", (e) => {
      if (phone.matches && e.target.matches("input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea")) document.body.classList.add("typing-focus");
    });
    document.addEventListener("focusout", () => document.body.classList.remove("typing-focus"));
  }

  // Check now, as a process in the chat: a Ping message whose steps update in place (from the run's own row, live),
  // ending in the new messages themselves (or no message when there's nothing new) or the reason it couldn't finish. The demo plays the same steps on its
  // sample snapshot.
  async function checkNow() {
    if (LIVE.current(state.data.runs, liveNow()) || state.starting) return;
    if ((location.hash || "#chat") !== "#chat") location.hash = "#chat";
    if (state.src.kind === "demo") return demoCheck();
    state.starting = true;
    updateCheckButtons();
    try {
      const out = await state.src.checkNow();
      if (out?.run_row && !state.data.runs.some((r) => r.id === out.run_row)) {
        mergeRuns([{ id: out.run_row, trigger: "manual", mode: "run", status: "queued", stage: "queued",
                     requested_at: new Date().toISOString() }]);
      } else if (!out?.run_row) status("Started a check. Its messages appear here as it goes.");
    } catch (e) {
      status(e.status === 404 ? "Check now isn't set up yet (see README)." : `Couldn't start a check. ${plainly(e)}`);
    } finally {
      state.starting = false;
      applyLive();
    }
  }

  function demoCheck() {
    const run = { id: `demo-${Date.now()}`, demo: true, trigger: "manual", mode: "run", status: "queued", stage: "queued",
                  requested_at: nowDate().toISOString(), shown_at: new Date(nowDate().getTime() + 1000).toISOString() };
    live.local.add(run.id);
    mergeRuns([run]);
    let i = 0;
    const step = () => {
      if (i < LIVE.DEMO_STAGES.length) {
        const [stage, ms] = LIVE.DEMO_STAGES[i++];
        Object.assign(run, { stage, status: stage === "queued" ? "queued" : "running" });
        if (stage !== "queued" && !run.started_at) run.started_at = nowDate().toISOString();
        mergeRuns([{ ...run }]);
        setTimeout(step, ms);
      } else {
        // what the snapshot's last check brought arrives now, after the "Done" line (later checks: nothing new)
        const found = state.held.splice(0);
        for (const it of found) it.first_seen = new Date(nowDate().getTime() + 2000).toISOString();
        if (found.length) state.data.items = [...state.data.items, ...found];
        Object.assign(run, { stage: "done", status: "ok", finished_at: nowDate().toISOString(), new_items: found.length });
        mergeRuns([{ ...run }]);
        stampItems();               // the demo's messages are current after its check: FACT answers stay in the page
        if (!found.length) toast("Nothing new", null, null, 3000);
      }
    };
    step();
  }

  // light / dark: follows the system unless you pick one (kept in this browser only)
  const themeNow = () => store.get("ping-theme", "system");
  function setTheme(t) {
    store.set("ping-theme", t);
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    // the rail's Theme button follows a change made on Profile too
    const mode = document.querySelector("#theme-btn .theme-mode");
    if (mode) mode.textContent = t === "system" ? "Auto" : t === "dark" ? "Dark" : "Light";
  }

  // the header: "checking the ERP now…" while a run is going, else the last finished check. No banner for a failed
  // run: ERP hiccups are normal (Ping posts in the chat after 3 in a row, or at once if the ERP refuses the login).
  // Ping's presence, like a contact's: "checked 4 min ago" → "checking the ERP…" (dots, the avatar pulses) →
  // "found 2 new" (2 s, the avatar flashes) → back. From the runs table, live.
  function flash(text) { state.flash = { text, until: Date.now() + 2000 }; showLastRun(); setTimeout(showLastRun, 2050); }
  function agoText(t) {
    const m = Math.floor((liveNow() - t) / 60000);
    if (m < 1) return "checked just now";
    if (m < 60) return `checked ${m} min ago`;
    return istDay(new Date(t)) === istDay(nowDate()) ? `checked ${clock(t)}` : `checked ${when(t)}`;   // short: it fits a phone
  }
  function showLastRun() {
    const cur = LIVE.current(state.data.runs, liveNow());
    const last = LIVE.lastFinished(state.data.runs || []);
    const sub = $("#subtitle"), top = $("#presence");
    const fl = state.flash && state.flash.until > Date.now() ? state.flash.text : null;
    const mode = cur ? "checking" : fl ? "found" : "idle";
    // the next check lives here (not on Today): "checked 4 min ago · next 14:11"
    const next = !cur && !fl && TODAY ? TODAY.nextCheck(state.data.runs, state.data.profile, liveNow()) : null;
    const text = cur ? "checking the ERP" : fl || ((last ? agoText(dt(last.finished_at).getTime())
      : state.asOf ? `snapshot of ${clock(state.asOf)}` : "placement updates") + (next ? ` · next ${clock(new Date(next).toISOString())}` : ""));
    if (sub.textContent !== text) sub.textContent = text;
    sub.classList.toggle("dots", mode === "checking");
    if (top && top.dataset.state !== mode) top.dataset.state = mode;
    updateCheckButtons(cur);
  }

  // every Check now button (rail, header, Profile > Account): off while a run is going, with its step on it
  function updateCheckButtons(cur = LIVE.current(state.data.runs, liveNow())) {
    document.querySelectorAll("[data-check-now]").forEach((b) => {
      b.disabled = !!cur || !!state.starting;
      b.setAttribute("aria-busy", String(!!cur || !!state.starting));
      const label = b.querySelector(".check-label") || b;
      // the header's button (phones) is short; the rail and Profile > Account show the step too
      label.textContent = state.starting ? "Starting…" : b.id === "check-now-top" ? (cur ? "Checking…" : "Check now")
        : LIVE.buttonLabel(cur, liveNow());
    });
  }

  function status(text) { const el = $("#status"); el.textContent = text; el.hidden = !text; }

  function showLogin(sb) {
    // a real form with the fields password managers know (iCloud Keychain, Google Password Manager): they offer to
    // save it once and fill it with Face ID or a fingerprint after that. Ping itself never stores the password.
    const email = h("input", { type: "email", name: "email", required: true, autocomplete: "username", inputmode: "email",
                               autocapitalize: "none", spellcheck: "false", placeholder: "you@example.com", id: "login-email" });
    const pw = h("input", { type: "password", name: "password", required: true, autocomplete: "current-password",
                            placeholder: "Password", id: "login-pw" });
    const msg = h("p", { class: "muted small", id: "login-msg", role: "status" });
    mountPage(h("form", { class: "login card", method: "post", action: "#chat", autocomplete: "on", onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = "Signing in…";
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
      if (error) { msg.textContent = /invalid login/i.test(error.message) ? "That email and password don't match. Try again." : plainly(error); return; }
      // Chrome (Android, desktop): ask its password manager to save the login now, so the next sign-in is one tap
      if (window.PasswordCredential && navigator.credentials?.store) {
        try { await navigator.credentials.store(new PasswordCredential({ id: email.value.trim(), password: pw.value, name: email.value.trim() })); } catch { /* declined or unsupported */ }
      }
      pw.value = "";
      keepSessionFresh(sb);
      startReal(sb);
    } },
      h("img", { class: "login-mark", src: "icons/ping.svg", alt: "", width: "64", height: "64" }),
      h("h1", {}, "Ping"),
      h("p", { class: "promise" }, "Your ERP, filtered for you, every hour."),
      h("p", { class: "who" }, "Sign in (the student this copy belongs to)"),
      h("label", {}, "Email", email),
      h("label", {}, "Password", pw),
      h("button", { class: "btn", type: "submit" }, "Sign in"),
      h("p", { class: "muted small center stay" }, "You'll stay signed in on this device."),
      msg,
      // View demo: an anonymous demo session (its own session key, the demo rows only; never the owner's session or
      // profile). ?anon-demo=1 (the checks and eval runners) opens the same thing.
      h("p", { class: "or" }, "or"),
      h("button", { type: "button", class: "btn demo", id: "view-demo", onclick: async (e) => {
        e.target.disabled = true;
        msg.textContent = "Opening the demo\u2026";
        const demo = authClient(DEMO_AUTH_KEY);          // its own session: never the owner's
        const { error } = await demo.auth.signInAnonymously();
        if (error) {
          // too many demo sign-ins this hour (or the sign-in service is down): the same snapshot, from this site's own
          // copy; only Ask Ping's open questions need the server there
          msg.textContent = "The live demo is busy right now, so opening the same snapshot from this page instead\u2026";
          setTimeout(() => { location.href = `${location.pathname}?demo=1#chat`; }, 1200);
          return;
        }
        msg.textContent = "";
        location.hash = "#chat";
        keepSessionFresh(demo);
        startReal(demo);
      } }, "View demo"),
      h("p", { class: "center", style: "margin:0" }, h("a", { class: "own", href: "setup.html", id: "setup-link" }, "Set up Ping for yourself \u2192"))));
  }

  // ------------------------------------------------------------ router
  // Plain "#name" links: #chat (home), #feed, #companies, #profile, #co-<company>
  function route() {
    if (location.hash.startsWith("#m-")) {
      state.jumpItem = decodeURIComponent(location.hash.slice(3));
      history.replaceState(null, "", "#chat");
    }
    const hash = location.hash.slice(1) || "chat";
    // "#profile/cvs": a page and a place on it (messages link straight to the card they mean)
    const [base, sub] = hash.startsWith("co-") ? [hash] : hash.split("/");
    const page = hash.startsWith("co-") ? "companies" : base;
    document.body.classList.toggle("chat-on", page === "chat");
    document.body.classList.toggle("today-on", page === "today");
    document.querySelectorAll("#nav a").forEach((a) => {
      const on = a.dataset.route === page;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (page !== "chat") document.body.classList.remove("typing-focus");
    if (hash.startsWith("co-")) {
      const name = [...byCompany().keys()].find((c) => slug(c) === hash.slice(3));
      return viewCompany(name || "");
    }
    renderToday();
    // a notification's tap: "#sheet/apply/<ms>" the roles closing then (the Today sheet), "#sheet/form/<ms>" the forms due then
    if (base === "sheet") {
      const [, kind, ms] = hash.split("/"), at = Number(ms);
      if (kind === "form") { state.formsAt = at; state.formsOnly = "all"; state.formsQuery = ""; history.replaceState(null, "", "#forms"); return viewForms(); }
      history.replaceState(null, "", "#today");
      viewToday();
      const roles = (state.data.roles || []).filter((r) => +dt(deadlineOf(r)) === at);
      if (roles.length) {
        const cards = roles.map((x) => roleCard(x, {}));
        const t = TODAY.sheetTitle({ cards, at, now: liveNow() });
        openActSheet({ title: t.title, sub: t.sub, cards, filters: true });
      }
      return;
    }
    if (hash === "feed") return viewFeed();
    if (hash === "today") return viewToday();
    if (hash === "companies") return viewCompanies();
    if (hash === "forms") return viewForms();
    if (base === "profile") { viewProfile(); if (sub) focusCard(sub); return; }
    if (state.onb) return viewOnboarding();
    return viewChat();
  }

  function viewOnboarding() {
    const o = state.onb;
    document.body.classList.add("chat-on");
    const q = OB.question(o.step, o.ctx);
    const inner = h("div", { class: "thread-inner onb", "data-onboarding": o.step });
    inner.append(h("div", { class: "day" }, o.resumed && !o.log.length ? "Welcome back: let's finish setting up" : "Getting started"));
    o.log.forEach((m, i) => inner.append(textBubble(m.role, m.text, m.at, i >= (o.shown || 0))));
    o.shown = o.log.length;
    // typing works at every step (a typed "yes", "every hour", "later" counts as tapping it)
    const input = h("input", { id: "onb-input", autocomplete: "off", maxlength: "300", enterkeyhint: "send",
      placeholder: q.free || "Tap an answer or type it", "aria-label": q.free || "Answer" });
    const chip = (c) => h("button", { type: "button", class: `chip${c.primary ? " primary" : ""}`, onclick: () => {
      if (c.insert) { input.value = c.insert; input.focus(); send.disabled = false; return; }
      onbAnswer({ value: c.value }, c.label);
    } }, c.label);
    // the CV step: the upload control, Later and Skip are in the bubble itself
    if (o.busy) inner.append(h("div", { class: "msg ping typing", role: "status", "aria-label": "Ping is typing" },
      h("span", { class: "dot" }), h("span", { class: "dot" }), h("span", { class: "dot" })));
    else if (!o.done) inner.append(h("div", { class: "msg ping onb-q" }, q.lines.map((l) => h("p", {}, l)),
      q.upload || q.inline ? h("div", { class: "onb-actions" }, q.upload ? onbUpload() : null, ...(q.inline ? q.chips.map(chip) : [])) : null,
      h("span", { class: "time" }, clock(new Date()))));
    const chips = h("div", { class: "chips wrap", role: "group", "aria-label": "Quick replies" },
      ...(q.inline || o.busy ? [] : q.chips.map(chip)),
      o.step === "first_check" ? h("button", { type: "button", class: "chip primary", onclick: () => onbFinish() }, "Go to my feed") : null);
    const send = sendButton(true);
    input.addEventListener("input", () => { send.disabled = !input.value.trim(); });
    const form = h("form", { onsubmit: (ev) => { ev.preventDefault(); const t = input.value.trim(); if (t) onbAnswer({ text: t }, t); } },
      input, send);
    const thread = h("div", { class: "thread", id: "thread", role: "log", "aria-label": "Getting started", "aria-live": "polite" }, inner);
    mount(thread, h("div", { class: "composer" }, chips, form));
    requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
    if (o.step === "first_check" && !o.done) onbFirstCheck();
  }

  // pick a PDF, name it (the label I use when I say which CV to apply with), save
  function onbUpload() {
    const box = h("div", { class: "onb-upload" });
    const file = h("input", { type: "file", accept: "application/pdf", id: "onb-cv", class: "visually-hidden",
      onchange: () => {
        const f = file.files?.[0];
        if (!f) return;
        if (f.type !== "application/pdf" || f.size > 5 * 1024 * 1024) { onbSay("A PDF up to 5 MB, please."); return; }
        const label = h("input", { id: "onb-cv-label", maxlength: "40", value: f.name.replace(/\.pdf$/i, "").slice(0, 40), "aria-label": "Name this CV" });
        const save = h("button", { type: "button", class: "btn small", onclick: async () => {
          const name = label.value.trim() || "CV 1";
          save.disabled = true; save.textContent = "Uploading…";
          try {
            const { error } = await state.src.sb.storage.from("cvs").upload("cv1.pdf", f, { upsert: true, contentType: "application/pdf" });
            if (error) throw new Error(error.message);
            const cvs = [{ label: name, path: "cv1.pdf", uploaded_at: new Date().toISOString() }, ...((state.data.profile.cvs || []).slice(1))];
            await state.src.saveOnboarding({ cvs, cv_names: cvs.map((c) => c.label) });
            state.data.profile.cvs = cvs;
            onbAnswer({ value: "uploaded" }, `Uploaded ${f.name} as “${name}”`);
          } catch (e) { save.disabled = false; save.textContent = "Save CV"; onbSay(`Couldn't upload it. ${plainly(e)}`); }
        } }, "Save CV");
        box.replaceChildren(h("label", { class: "onb-label", for: "onb-cv-label" }, `Name for ${f.name}`), label, save);
        label.focus();
      } });
    box.append(h("label", { class: "btn small upload", for: "onb-cv" }, "Upload CV"), file);
    return box;
  }

  function onbSay(text) { state.onb.log.push({ role: "ping", text, at: new Date().toISOString() }); viewOnboarding(); }

  // one answer at a time: the answer shows at once with Ping typing under it, the step's buttons go until it's done
  // (a tap that waited on Ask Ping looked like nothing happened, so it got tapped again)
  async function onbAnswer(input, label) {
    const o = state.onb;
    if (!o || o.busy) return;
    o.busy = true;
    try { await onbAnswerNow(o, input, label); } finally { o.busy = false; }
    if (state.onb === o && o.step !== "done") viewOnboarding();
  }
  async function onbAnswerNow(o, input, label) {
    const q = OB.question(o.step, o.ctx);
    o.log.push({ role: "ping", text: q.lines.join(" "), at: new Date().toISOString() },
               { role: "me", text: label, at: new Date().toISOString() });
    viewOnboarding();
    const res = OB.answer(o.step, input, o.ctx);
    try {
      await state.src.saveOnboarding(res.save);
    } catch (e) { o.log.push({ role: "ping", text: isNetErr(e) ? "Couldn't save that: no connection. Tap it again when you're back online." : "Couldn't save that. Tap it again, or Skip and tell me later.", at: new Date().toISOString() }); return; }
    if (res.useDemo) { state.onb = null; location.hash = "#chat"; return route(); }
    Object.assign(o.ctx, res.ctxPatch || {}, res.save);
    if (!state.src.demo) Object.assign(state.data.profile, res.save);
    if (res.askPing) {
      try {
        // at most 15 s here: the answer is saved on the server either way, and the walk goes on
        const out = await Promise.race([state.src.fn("ask-ping", { question: res.askPing }),
          new Promise((r) => setTimeout(() => r(null), 15000))]);
        o.log.push({ role: "ping", text: out?.answer || "Noted. Marking the roles that fit takes a moment; you can see or change your targets in Profile › What I'm looking for.", at: new Date().toISOString() });
        if (out) await loadMarks();
      } catch (e) { o.log.push({ role: "ping", text: "Couldn't save that just now. You can tell me later, any time.", at: new Date().toISOString() }); }
    }
    if (res.next === o.step && !res.ctxPatch) {
      o.log.push({ role: "ping", text: "Sorry, I didn't get that. Tap one of the answers, type it another way, or Skip.", at: new Date().toISOString() });
    }
    // after the CV step (uploaded, the demo's, later or skipped): where CVs live from now on, with a link there
    if (o.step === "cv" && res.next !== "cv") o.log.push({ role: "ping", text: OB.CV_LATER, at: new Date().toISOString() });
    o.step = res.next;
    if (o.step === "first_check") o.since = Date.now();
    if (o.step === "done") return onbFinish();
  }

  // the last step: start a check (owner), wait until a run has finished, then explain the thread
  async function onbFirstCheck() {
    const o = state.onb;
    if (o.polling) return;
    o.polling = true;
    const explain = async () => {
      if (!state.onb) return;
      o.log.push({ role: "ping", text: OB.question("first_check", o.ctx).lines.join(" "), at: new Date().toISOString() });
      for (const l of OB.CLOSING) o.log.push({ role: "ping", text: l, at: new Date().toISOString() });
      await state.src.saveOnboarding({ onboarding_step: "done" }).catch(() => {});
      o.done = true;
      viewOnboarding();
    };
    if (state.src.demo) return explain();
    if (!o.started && o.since) { o.started = true; await state.src.checkNow().catch(() => {}); }
    const since = o.since || 0;
    for (let i = 0; i < 60 && state.onb === o; i++) {          // about 20 minutes
      const run = await state.src.latestRun().catch(() => null);
      if (run?.finished_at && (!since || dt(run.finished_at) > since - 60000)) {
        state.data = await state.src.load();
        stampItems();
        return explain();
      }
      await new Promise((r) => setTimeout(r, 20000));
    }
  }

  async function onbFinish() {
    await state.src.saveOnboarding({ onboarding_step: "done" }).catch(() => {});
    state.onb = null;
    location.hash = "#chat";
    route();
  }

  // ------------------------------------------------------------ chat (home)
  // a notice's own time first: Ping's first run posts two weeks of notices at once, and they should still
  // read in the order the CDC posted them (later, notice time and first seen are within the hour anyway)
  const itemTime = (it) => {
    const d = it.details || {};
    if (d.reposted_at) return d.reposted_at;                       // posted again for you (Admin > repost-item)
    if (d.posted_at) return d.posted_at;                           // when it was posted: at the bottom, never back-dated
    // found hours after its notice was posted (the ERP listed it late) and still ahead: in the thread where you'll see
    // it, when Ping found it, not up in the history at the notice's time (24 Nov, BlueStone)
    const nt = d.notice_time, fs = it.first_seen, due = it.due_at || it.event_at;
    if (nt && fs && due) { const gap = dt(fs) - dt(nt); if (gap > 3600000 && gap < 2 * 86400000 && dt(due) > dt(fs)) return fs; }
    return nt || fs || it.sort_at;
  };
  const isPast = (it) => it.level === "hidden" && PAST.test(it.details?.hidden_because || "");
  // A past item stays in the chat only if Ping posted it while it still mattered. A role whose deadline
  // had already gone when Ping first saw it was never news, so it isn't a message.
  const wasLive = (it) => {
    const seen = dt(itemTime(it)), why = it.details?.hidden_because || "";
    if (!seen) return true;
    if (/deadline gone/.test(why) && it.due_at) return seen < dt(it.due_at);
    if (/already happened/.test(why) && it.event_at) return seen < +dt(it.event_at) + 12 * 3600000;
    if (/older than 3 days/.test(why) && it.sort_at) return seen < +dt(it.sort_at) + 3 * 86400000;
    if (/reminder/.test(why) && it.due_at) return seen < +dt(it.due_at) - 86400000;  // else the reminder alone says it
    return true;
  };
  // one card per role ("X opened", "Reminder: X closes") isn't a chat message any more: the new-roles message and
  // the deadline digests list them (the Feed and Companies pages still show every role)
  // a notice's Info card merged into its to-do card (ping/items.py merge_into_todos): one card per notice
  const inChat = (it) => !it.dismissed && it.category !== "apply" && it.category !== "reminder" && !itemNotForMe(it) && !it.details?.merged_into &&
    (it.level !== "hidden" || (isPast(it) && wasLive(it)));

  // the same message twice (same company, task, deadline, link and words) is drawn once, whatever its ids (ping/posting.py
  // collapses them too; this keeps the thread right with data saved before that)
  const repeatKey = (it) => {
    const d = it.details || {}, t = it.due_at || it.event_at || "";
    const co = String(it.company || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/\b(private|pvt|limited|ltd|llp|inc|india)\b\.?/g, " ").replace(/[^a-z0-9]+/g, "");
    const link = String(d.todo?.link || d.form?.link || d.mail?.link || "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    const words = String(it.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return [co, d.todo?.action || d.kind || it.category || "", t ? new Date(t).toISOString().slice(0, 16) : "", link, it.category, words].join("|");
  };
  function onceEach(items) {
    const seen = new Set();
    return [...items].sort((a, b) => String(a.first_seen || "~").localeCompare(String(b.first_seen || "~")) || String(a.id).localeCompare(String(b.id)))
      .filter((it) => {
        if (it.category === "digest" || it.category === "listing" || it.category === "review" || it.needs_review) return true;
        const k = repeatKey(it);
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
  }
  function threadEntries() {
    // from where the loaded window starts: older open items (To do's) aren't drawn out of place
    const inWin = (at) => !state.winFrom || (Date.parse(at) || 0) >= state.winFrom;
    const items = onceEach(state.data.items.filter(inChat)).map((it) => ({ kind: "item", at: itemTime(it), it }))
      .filter((e) => e.it.__win || inWin(e.at));
    const talk = state.chat.map((m) => ({ kind: m.role, at: m.created_at, text: m.text, quote: quoteOf(m) }));
    // a Check now (with its progress) and an hourly check that brought something new
    // a finished check sits at its finish time (the time on the message and any time in it are the same); one that
    // brought nothing the page can show is no message at all
    const runs = (state.data.runs || []).filter((r) => LIVE.inThread(r, liveNow()) && (r.stage !== "done" || runItems(r).length))
      .map((r) => ({ kind: "run", at: r.stage === "done" && r.finished_at ? r.finished_at : r.shown_at || r.requested_at || r.started_at, run: r }));
    const sorted = [...items, ...talk, ...runs].filter((e) => e.at).sort((a, b) =>
      dt(a.at) - dt(b.at) || (a.kind === "item" && b.kind === "item" ? String(a.it.sort_at || "").localeCompare(String(b.it.sort_at || "")) : 0));
    // checks in a row that found nothing: one thin line that updates in place, not a bubble each
    return LIVE.collapseQuiet(sorted, state.data.runs, liveNow());
  }

  function unreadOf(entries) {
    // first visit (or the demo): don't call two weeks of history "unread", only the last day
    const lastAt = entries.length ? dt(entries[entries.length - 1].at) : null;
    const readAt = state.readAt ? dt(state.readAt) : lastAt && new Date(lastAt - 86400000);
    // Ping's own messages (e.g. "couldn't reach the ERP") count as unread too, not your questions or its replies
    return { readAt, unread: entries.filter((e) => (e.kind === "item" || e.kind === "ping") && (!readAt || dt(e.at) > readAt)) };
  }

  const QUICK = [{ label: "What's due tonight?" }, { label: "Anything for me?" }, { label: "Which CV for …?", insert: "Which CV should I use for " },
                 { label: "My preferences", text: "What are my preferences?" }, { label: "Help", text: "help" }];
  const ICON_SEND = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", "M5 12h13M12 5l7 7-7 7");
    s.append(p); return s; };
  const sendButton = (disabled) => h("button", { class: "btn send", "aria-label": "Send", disabled }, ICON_SEND());

  // the thread draws its latest 60 messages (from the first unread one if that is earlier) and the rest on demand:
  // a phone shouldn't lay out 300 bubbles to show the last screenful
  const THREAD_WINDOW = 60;
  function viewChat() {
    const all = threadEntries();
    const { readAt, unread } = unreadOf(all);
    let cut = state.showAll ? 0 : Math.max(0, all.length - (state.renderCount || THREAD_WINDOW));
    if (unread.length) cut = Math.min(cut, all.indexOf(unread[0]));
    if (state.jumpItem) { const j = all.findIndex((e) => e.kind === "item" && e.it.id === state.jumpItem); if (j >= 0) cut = Math.min(cut, j); }
    const entries = all.slice(Math.max(0, cut));
    state.threadFrom = cut > 0 ? entries[0]?.at || null : null;
    const inner = h("div", { class: "thread-inner" });
    let group = null, lastDay = null, divider = null;
    const snapshot = state.asOf && h("p", { class: "note-line snapshot" }, "Demo: " +
      `an anonymised snapshot of a real run, shown as it was on ${when(state.asOf)}. Fake roll number, name and CGPA; ` +
      "other students and all real mail removed (the 4 mails marked \u201cvia email\u201d are made-up samples).");
    if (!all.length) inner.append(h("p", { class: "empty" }, "No messages yet. Ping posts here after its first check (about 10 minutes)."));
    // scrolling up draws (and reads) earlier messages on its own; the button does the same
    if (cut > 0 || hasEarlier()) inner.append(h("button", { type: "button", class: "pill-btn ghost earlier", onclick: () => loadEarlier() },
      cut > 0 ? `Show ${Math.min(cut, THREAD_WINDOW)} earlier message${Math.min(cut, THREAD_WINDOW) === 1 ? "" : "s"}` : "Load earlier messages"));
    for (const e of entries) {
      const day = dayLabel(e.at);
      // one section per day: its header sticks to the top while you scroll through that day
      if (day !== lastDay) { group = h("section", { class: "daygroup", "aria-label": day }, h("div", { class: "day" }, day)); inner.append(group); lastDay = day; }
      if (!divider && unread.length && e === unread[0]) {
        divider = h("div", { class: "unread", id: "unread" }, `${unread.length} new`);
        if (snapshot) group.append(snapshot);
        group.append(divider);
      }
      group.append(renderEntry(e));
    }
    if (snapshot && !divider) (group || inner).append(snapshot);
    const gap = profileGapNote();
    if (gap) (group || inner).append(gap);
    const thread = h("div", { class: "thread", id: "thread", role: "log", "aria-label": "Messages", "aria-live": "polite" }, inner);
    const input = h("input", { id: "ask-input", autocomplete: "off", maxlength: "300", enterkeyhint: "send",
      placeholder: "Ask Ping: what's due tomorrow?", "aria-label": "Message Ping" });
    const btn = sendButton(true);
    input.addEventListener("input", () => { if (!state.waiting) btn.disabled = !input.value.trim(); });
    // about to ask: the whole history (for the page's own answers) is read now, not when you press send
    input.addEventListener("focus", () => { ensureHistory(); }, { once: true });
    const ask = (text) => { input.value = text; btn.disabled = false; form.requestSubmit(); };
    const quick = h("div", { class: "chips", role: "group", "aria-label": "Quick questions" }, QUICK.map((c) =>
      h("button", { type: "button", class: "chip", onclick: () => {
        if (c.insert) { input.value = c.insert; btn.disabled = false; input.focus(); return; }
        ask(c.text || c.label);
      } }, c.label)));
    const form = h("form", { onsubmit: (ev) => { ev.preventDefault(); send(input, inner, thread, btn); } }, input, btn);
    // "N new" when the first unread message is below you; "Latest" when you're far up the thread
    const jump = h("button", { type: "button", class: "pill-btn in-composer", id: "jump", hidden: true });
    const replyBox = h("div", { class: "reply-preview", hidden: true, role: "group", "aria-label": "Replying to" });
    input.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && state.replyTo) { ev.preventDefault(); clearReply(); } });
    const composer = h("div", { class: "composer" }, jump, quick, replyBox, form);
    state.composer = { replyBox, input, thread, inner, ask };
    mount(thread, composer);
    wireReplies(thread, inner);
    const syncJump = () => {
      const tr = thread.getBoundingClientRect();
      const fromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      if (live.newCount && fromBottom < 80) {           // you've scrolled down to what arrived: it's read
        live.newCount = 0;
        live.firstNew = null;
        markRead();
      }
      if (live.newCount && live.firstNew?.isConnected) {
        jump.textContent = `↓ ${live.newCount} new`; jump.className = "pill-btn in-composer"; jump.hidden = false;
        const first = live.firstNew;
        jump.onclick = () => jumpTo(thread, first);
      } else if (divider && divider.getBoundingClientRect().top > tr.bottom - 8) {
        jump.textContent = `${unread.length} new ↓`; jump.className = "pill-btn in-composer"; jump.hidden = false;
        jump.onclick = () => jumpTo(thread, divider);
      } else if (fromBottom > thread.clientHeight) {
        jump.textContent = "Latest ↓"; jump.className = "pill-btn ghost in-composer"; jump.hidden = false;
        jump.onclick = () => jumpTo(thread, null);
      } else jump.hidden = true;
      // the pill sits in the composer, in the quick questions' place (same height): above the box, over no message
      if (quick.hidden !== !jump.hidden) quick.hidden = !jump.hidden;
    };
    thread.addEventListener("scroll", syncJump, { passive: true });
    // scrolling up near the top reads earlier messages: only a scroll upward (yours), never the page moving to the
    // bottom or a short thread sitting near its top
    let lastTop = thread.scrollTop;
    thread.addEventListener("scroll", () => {
      const up = thread.scrollTop < lastTop;
      lastTop = thread.scrollTop;
      if (up && thread.scrollTop < 150 && thread.scrollHeight - thread.clientHeight > 300) loadEarlier();
    }, { passive: true });
    live.newCount = 0;
    live.firstNew = null;
    live.syncJump = syncJump;
    // open at the first unread message, otherwise at the bottom (the latest thing that happened)
    requestAnimationFrame(() => {
      const target = state.jumpItem && inner.querySelector(`[data-key="${CSS.escape(`item:${state.jumpItem}`)}"]`);
      state.jumpItem = null;
      if (target) { target.scrollIntoView({ block: "center" }); target.classList.add("hl"); }
      else if (divider) (snapshot || divider).scrollIntoView({ block: "start" });
      else thread.scrollTop = thread.scrollHeight;
      syncJump();
    });
    if (!offerInstall(inner)) offerPush(inner);
    const latest = entries.length ? entries[entries.length - 1].at : null;
    if (latest && (!readAt || dt(latest) > readAt)) {
      state.readAt = new Date(Math.max(dt(latest), Date.now())).toISOString();
      state.src.setReadAt(state.readAt).catch(() => {});
    }
    navUnread(0);
  }
  // "Install Ping": a Ping message from the second visit on. The button says "Install" only when the browser has
  // handed over its install dialog (beforeinstallprompt: Chrome/Edge on Android, Windows, Mac); otherwise the message
  // shows the steps for this device (docs/HELP.md, help.js). "Not now" hides it for 7 days; an install, for good.
  // Profile > Install Ping always has the same steps.
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const INSTALL_SNOOZE_DAYS = 7;
  const installHidden = () => {
    const v = store.get("ping-install", "");
    if (v === "installed") return true;
    return !!(v && v.snoozeUntil && Date.parse(v.snoozeUntil) > Date.now());
  };
  const snoozeInstall = () => store.set("ping-install", { snoozeUntil: new Date(Date.now() + INSTALL_SNOOZE_DAYS * 86400000).toISOString() });
  // a browser that can install sites at all: the dialog is here, or it's iPhone/iPad Safari, or Chrome/Edge/Samsung
  // on a desktop or Android (where the menu has "Install"); Firefox can't, so it isn't offered there
  const installable = () => !!state.installEvent || isIOS() ||
    (/android|windows|macintosh|cros|linux/i.test(navigator.userAgent) && /chrome|crios|edg|samsungbrowser/i.test(navigator.userAgent) && !/firefox|fxios/i.test(navigator.userAgent));
  const installSteps = () => {
    const help = window.PingHelp?.install;
    const plat = thisPlatform();
    return (help?.platforms?.[plat] || help?.platforms?.other || "Use your browser's menu: Install Ping.");
  };
  // the body of the install message and of Profile > Install Ping: the real button, or the steps for this device
  function installBody(onGone, { profile = false } = {}) {
    const box = h("div", { class: "install-body" });
    const draw = () => {
      if (standalone() || store.get("ping-install", "") === "installed") {
        box.replaceChildren(h("p", { class: "summary" }, "Installed: Ping opens like an app from your home screen, dock or Start menu."));
        return;
      }
      const ev = state.installEvent;
      const text = ev ? "Install me? I'll open like an app, straight to this chat, and work offline for what you've already seen."
        : `${profile ? "" : "Install me as an app: "}${installSteps()}`;
      const chips = h("div", { class: "chips wrap" },
        ev ? h("button", { type: "button", class: "chip primary", "data-install": "prompt", onclick: async () => {
          state.installEvent = null;                       // the dialog can be opened once per event
          try { ev.prompt(); } catch { draw(); return; }
          const { outcome } = await ev.userChoice.catch(() => ({}));
          if (outcome === "accepted") { store.set("ping-install", "installed"); if (onGone) onGone(); else draw(); }
          else draw();                                     // dismissed: the steps, since the button can't work again
        } }, "Install") : null,
        !profile ? h("button", { type: "button", class: "chip", "data-install": "later", onclick: () => { snoozeInstall(); onGone?.(); } }, "Not now") : null);
      box.replaceChildren(...[
        h(profile ? "p" : "span", { class: profile ? "summary" : "text" }, text),
        !ev && isIOS() ? h("img", { class: "ios-steps", src: "icons/ios-install.svg", alt: "Tap Share, then Add to Home Screen", width: 340, height: 150 }) : null,
        chips.children.length ? chips : null].filter(Boolean));
    };
    box.redraw = draw;
    draw();
    return box;
  }
  function offerInstall(inner) {
    if (standalone() || state.offline || Number(store.get("ping-visits", 0)) < 2 || installHidden() ||
        inner.querySelector(".install") || !installable()) return false;
    const at = new Date().toISOString();
    const bubble = h("div", { class: "msg ping sys install enter", role: "group", "aria-label": "Install Ping" },
      h("div", { class: "kicker" }, h("span", { class: "k" }, "Ping")),
      installBody(() => bubble.remove()),
      h("div", { class: "foot" }, h("span", { class: "time" }, clock(at))));
    appendToday(inner, bubble);
    return true;
  }
  // Profile > Install Ping: always there (until installed), so the steps are always findable
  function installCard() {
    return h("section", { class: "card pcard", id: "pc-install", "aria-labelledby": "pc-install-h" },
      h("div", { class: "pcard-head" }, h("h2", { id: "pc-install-h" }, "Install Ping")), installBody(null, { profile: true }));
  }

  // ------------------------------------------------------------ push notifications (docs/PUSH.md): the owner's own
  // devices only (a demo session can't subscribe; the database refuses it). On iPhone/iPad only once installed.
  const urlB64 = (b) => Uint8Array.from(atob((b + "=".repeat((4 - b.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const pushSupported = () => !!(CFG.pushKey && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
  const pushPossible = () => state.src?.kind === "real" && !state.offline && pushSupported() && (!isIOS() || standalone());
  async function pushSubscription() {
    try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { return null; }
  }
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, why: perm === "denied" ? "blocked" : "not now" };
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(CFG.pushKey) });
    const j = sub.toJSON();
    const { error } = await state.src.sb.from("push_subscriptions").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh,
      auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) });
    if (error) { await sub.unsubscribe().catch(() => {}); return { ok: false, why: plainly(error) }; }
    return { ok: true };
  }
  async function disablePush() {
    const sub = await pushSubscription();
    if (sub) { await state.src.sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe().catch(() => {}); }
  }
  const quietText = () => { const p = state.data.profile || {}; return `${p.check_to || "01:00"}–${p.check_from || "06:00"}`; };
  // "Want me to notify you when something's for you?" once per device, never in the same visit as the install offer
  async function offerPush(inner) {
    if (!pushPossible() || Notification.permission !== "default" || store.get("ping-push-ask", "") || inner.querySelector(".push-ask")) return;
    if (await pushSubscription()) return;
    const at = new Date().toISOString();
    const text = h("span", { class: "text" }, `Want me to notify you when something's for you? At most one notification per check, never in your quiet hours (${quietText()}).`);
    const chips = h("div", { class: "chips wrap" },
      h("button", { type: "button", class: "chip primary", onclick: async () => {
        store.set("ping-push-ask", "yes");
        chips.replaceChildren();
        const r = await enablePush().catch((e) => ({ ok: false, why: plainly(e) }));
        text.replaceChildren(...placeLinks(r.ok ? "Done: this phone gets a notification when something's for you. Profile > Notifications to send a test or turn it off."
          : r.why === "blocked" ? "Your browser blocked notifications for Ping. Allow them in this site's settings (the lock or ⓘ next to the address), then turn them on in Profile > Notifications."
          : r.why === "not now" ? "Notifications stay off for now. You can turn them on any time in Profile > Notifications."
          : `Notifications didn't turn on. ${r.why} You can try again in Profile > Notifications.`));
      } }, "Yes"),
      h("button", { type: "button", class: "chip", onclick: () => { store.set("ping-push-ask", "not now"); bubble.remove(); } }, "Not now"));
    const bubble = h("div", { class: "msg ping sys push-ask enter", role: "group", "aria-label": "Notifications" },
      h("div", { class: "kicker" }, h("span", { class: "k" }, "Ping")), text, chips,
      h("div", { class: "foot" }, h("span", { class: "time" }, clock(at))));
    appendToday(inner, bubble);
  }
  // Profile > Notifications: this device on or off, a test, and the optional email
  function pushCard(demo) {
    const p = state.data.profile || {};
    const line = h("p", { class: "summary" }, "…");
    const actions = h("div", { class: "actions" });
    const draw = async () => {
      if (demo) { line.textContent = "Notifications go to the owner's own phone: the demo can't turn them on."; return; }
      if (!pushSupported()) { line.textContent = CFG.pushKey ? "This browser can't receive notifications." : "Notifications aren't set up for this copy of Ping yet (Actions > Admin > push-setup)."; return; }
      if (isIOS() && !standalone()) { line.textContent = "On iPhone and iPad, add Ping to your Home Screen first (Share → Add to Home Screen), then open it from there."; return; }
      const sub = await pushSubscription();
      const perm = Notification.permission;
      line.textContent = sub ? `On for this device. At most one per check, plus test-day reminders; quiet ${quietText()}.`
        : perm === "denied" ? "Blocked for Ping in this browser's site settings." : "Off for this device.";
      actions.replaceChildren(
        sub ? h("button", { type: "button", class: "btn ghost", onclick: async () => { await disablePush(); draw(); } }, "Turn off")
            : perm !== "denied" ? h("button", { type: "button", class: "btn", onclick: async () => { await enablePush().catch(() => {}); draw(); } }, "Turn on") : null,
        sub ? h("button", { type: "button", class: "btn ghost", onclick: async (ev) => {
          ev.target.disabled = true;
          const r = await state.src.fn("send-push", { mode: "test" }).catch((e) => ({ error: plainly(e) }));
          line.textContent = r?.error ? `The test didn't go out. ${r.error}` : `Test sent to ${r.ok} of ${r.devices} device${r.devices === 1 ? "" : "s"}.`;
          ev.target.disabled = false;
        } }, "Send a test") : null);
    };
    draw();
    const mail = h("input", { type: "checkbox", id: "pf-email-digests", checked: !!p.email_digests, disabled: demo, onchange: async (ev) => {
      try { await state.src.saveProfile({ email_digests: ev.target.checked }); state.data.profile.email_digests = ev.target.checked; }
      catch (e) { ev.target.checked = !ev.target.checked; line.textContent = `Couldn't save. ${plainly(e)}`; }
    } });
    return h("section", { class: "card pcard", id: "pc-push", "aria-labelledby": "pc-push-h" },
      h("div", { class: "pcard-head" }, h("h2", { id: "pc-push-h" }, "Notifications")), line, actions,
      h("label", { class: "check" }, mail, "Also email me what's for you (off by default; the alert after 3 failed checks is emailed either way)"));
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installEvent = e;
    // an install message or Profile card already showing the steps gets the real button now
    document.querySelectorAll(".install-body").forEach((b) => b.redraw?.());
    const inner = document.querySelector("#thread .thread-inner");
    if (inner) offerInstall(inner);
  });
  window.addEventListener("appinstalled", () => {
    store.set("ping-install", "installed");
    document.querySelector(".msg.install")?.remove();
    document.querySelectorAll(".install-body").forEach((b) => b.redraw?.());
  });

  const motion = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
  // to a message (or the bottom): smooth for a short way, at once for a long one (a long smooth scroll is slow)
  function jumpTo(thread, el) {
    const top = el ? thread.scrollTop + el.getBoundingClientRect().top - thread.getBoundingClientRect().top - 8 : thread.scrollHeight;
    const far = Math.abs(top - thread.scrollTop) > 3 * thread.clientHeight;
    thread.scrollTo({ top, behavior: far ? "auto" : motion() });
  }
  function navUnread(n) { const d = $("#nav-unread"); if (!d) return; d.textContent = n > 99 ? "99+" : String(n); d.hidden = !n;
    d.parentElement.setAttribute("aria-label", n ? `Chat, ${n} new` : "Chat"); }

  // A place in the app named in a message is a link to it, and "Check now" is the button itself: "Profile >
  // Notifications", "the Profile page (My CVs)", "in Profile", "the Forms tab", "the Today panel", "Check now".
  const CARD = { "about you": "about", "targets": "looking", "what i'm looking for": "looking", "interested / not interested companies": "looking",
    "feed": "looking", "other roles": "looking", "my cvs": "cvs", "cvs": "cvs", "schedule & reminders": "schedule", "notifications": "push",
    "install ping": "install", "account": "account" };
  const PLACE_RE = new RegExp(["Profile\\s*(?:→|›|>)\\s*(About you|Targets|What I'm looking for|Interested / Not interested companies|Feed|Other roles|My CVs|CVs|Schedule & reminders|Notifications|Install Ping|Account)",
    "(?:the )?Profile page(?: \\((My CVs)\\))?", "\\bin Profile\\b", "(?:the )?Forms tab", "(?:the )?Today (?:tab|panel)", "(?:the )?Companies (?:tab|page)", "\\bCheck now\\b"].join("|"), "g");
  function placeLinks(str) {
    const out = [];
    let last = 0, m;
    PLACE_RE.lastIndex = 0;
    while ((m = PLACE_RE.exec(str))) {
      if (m.index > last) out.push(str.slice(last, m.index));
      const t = m[0];
      if (/^Check now$/.test(t)) out.push(h("button", { type: "button", class: "linklike inline-link", "data-check-now": true, onclick: () => checkNow() }, t));
      else {
        const href = m[1] ? `#profile/${CARD[m[1].toLowerCase()]}` : m[2] ? "#profile/cvs" : /Profile/.test(t) ? "#profile"
          : /Forms/.test(t) ? "#forms" : /Today/.test(t) ? "#today" : "#companies";
        out.push(h("a", { href, class: "inline-link" }, t));
      }
      last = PLACE_RE.lastIndex;
    }
    if (last < str.length) out.push(str.slice(last));
    return out;
  }

  // Ping's answers as rich text: "- " lines become a list, **bold** bold, [Open list](https://…) a link (opens in the
  // browser), and an "ERP data from 12:41 (…)" line gets a Check now button. Never literal ** or "- " in a bubble.
  function richText(text) {
    const inline = (str0) => {
      // never a bracket on screen: "[open]" with no link, or a link to nowhere, is just its words
      const str = String(str0).replace(/\[([^\]\n]+)\]\((?!https?:\/\/|#)[^)]*\)/g, "$1").replace(/\[([^\]\n]+)\](?!\()/g, "$1");
      const parts = [], re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|#ask:[^)\s]+|#[a-z][\w/-]*)\)|\*\*([^*]+)\*\*/g;
      let last = 0, m;
      while ((m = re.exec(str))) {
        if (m.index > last) parts.push(...placeLinks(str.slice(last, m.index)));
        // "[Undo](#ask:undo)", "[Yes](#ask:hide%20Groww)": a button that sends that message in the chat
        parts.push(m[1] && m[2].startsWith("#ask:") ? h("button", { type: "button", class: "chip ask-chip", "data-ask": m[2].slice(5),
            onclick: (ev) => { ev.stopPropagation(); askInChat(decodeURIComponent(m[2].slice(5))); } }, m[1])
          : m[1] ? (m[2].startsWith("#") ? h("a", { href: m[2], class: "inline-link" }, m[1])
          : h("a", { href: m[2], target: "_blank", rel: "noopener", class: "inline-link" }, m[1])) : h("strong", {}, m[3]));
        last = re.lastIndex;
      }
      if (last < str.length) parts.push(...placeLinks(str.slice(last)));
      return parts;
    };
    const out = [];
    let ul = null;
    const R = window.PingRules;
    const clean = R?.cleanNames ? R.cleanNames(text) : String(text || "");
    for (const line of clean.split("\n")) {
      const li = line.match(/^\s*[-•*]\s+(.*)$/);
      if (li) {
        if (!ul) { ul = h("ul", { class: "md-list" }); out.push(ul); }
        ul.append(h("li", {}, inline(li[1])));
        continue;
      }
      ul = null;
      if (/^ERP data from \d/.test(line)) {
        out.push(h("span", { class: "stale-note" }, line, " ",
          h("button", { type: "button", class: "linklike", "data-check-now": true, onclick: () => checkNow() }, "Check now")), "\n");
        continue;
      }
      out.push(...inline(line), "\n");
    }
    if (out[out.length - 1] === "\n") out.pop();
    return out;
  }

  // a reply's quote inside the bubble: who and the first line; tapping it goes to the original and flashes it
  const quoteOf = (m) => (m && m.reply_to ? { to: m.reply_to, sender: m.reply_quote?.sender || "Ping", text: m.reply_quote?.text || "" } : null);
  function quoteNode(q) {
    return h("button", { type: "button", class: "quote", "aria-label": `Replying to ${q.sender}: ${q.text}. Show it`,
      onclick: (ev) => { ev.stopPropagation(); goToMessage(q.to); } },
      h("span", { class: "q-who" }, q.sender), h("span", { class: "q-text" }, q.text));
  }
  function textBubble(role, text, at, enter, quote) {
    return h("div", { class: `msg ${role === "me" ? "me" : "ping"}${enter ? " enter" : ""}`, "data-key": msgKey(role, at), "data-sig": "1" },
      quote ? quoteNode(quote) : null,
      h("span", { class: "text" }, role === "me" ? text : richText(text)), role === "me" ? null : rolesButton(text),
      h("div", { class: "foot" }, h("span", { class: "time" }, clock(at))));
  }

  // every bubble has a key (what it is) and a signature (what it shows), so live updates add what's new and
  // redraw only what changed, in place
  const msgKey = (role, at) => `msg:${role === "me" ? "me" : "ping"}:${Date.parse(at)}`;
  const itemSig = (it) => [retitle(it), it.level, it.done ? 1 : 0, it.details?.hidden_because || "", (it.details?.list || []).length,
                            (it.details?.list || []).length ? state.marksVersion || 0 : 0].join("|");
  const runSig = (r) => [r.stage, r.status, r.new_items, r.note, r.finished_at].join("|");
  function entryKey(e) { return e.kind === "item" ? `item:${e.it.id}` : e.kind === "run" ? `run:${e.run.id}` : e.kind === "quiet" ? e.key : msgKey(e.kind, e.at); }
  function entrySig(e) { return e.kind === "item" ? itemSig(e.it) : e.kind === "run" ? runSig(e.run) : e.kind === "quiet" ? `quiet|${e.line}` : "1"; }
  function renderEntry(e) {
    return e.kind === "item" ? itemBubble(e.it, e.at) : e.kind === "run" ? runBubble(e.run, e.at)
      : e.kind === "quiet" ? h("p", { class: "note-line sysline", role: "status", "data-key": e.key, "data-sig": entrySig(e) }, e.line)
      : textBubble(e.kind, e.text, e.at, false, e.quote);
  }

  // what a finished check brought: the messages first seen while it ran (to a minute after it finished)
  function runItems(run) {
    if (run.stage !== "done") return [];
    const ms = (v) => Date.parse(v || "") || 0;
    const from = ms(run.started_at || run.requested_at) - 10000, to = ms(run.finished_at) + 120000;
    // posted by this run (a to-do held back before and posted now carries this run's time in posted_at)
    const at = (it) => ms(it.details?.posted_at || it.first_seen);
    return (state.data.items || []).filter((it) => inChat(it) && at(it) >= from && at(it) <= to)
      .sort((a, b) => (dt(a.due_at || a.event_at) || 9e15) - (dt(b.due_at || b.event_at) || 9e15));
  }
  // one line per new message, the card's words: "Zeta Global · Form · Today 20:00 [Open form]"
  function runItemRow(it) {
    const c = itemCardOf(it), d = it.details || {}, due = it.due_at || it.event_at;
    const rel = due ? relOf(due, !!it.event_at && !it.due_at) : null;
    const link = d.todo?.link || c.forms?.[0] || null;
    return h("div", { class: "run-item" },
      h("button", { type: "button", class: "linklike run-what", onclick: () => goTo({ item: it.id }) },
        // a digest / new-roles message has no one company: its own short title ("1 to apply by 20:00 (ZS Associates)")
        ["digest", "listing"].includes(it.category) || !(c.company || it.company)
          ? h("strong", {}, String(it.title || "").replace(/^(Reminder|Update):\s*/, "").replace(/,? (today|tonight|tomorrow),? [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d\d:\d\d/, "").slice(0, 70))
          : [h("strong", {}, shortCo(c.company || cleanName(it.company || ""))), ` · ${c.word || KIND_WORD[c.kind] || CARDS.typeLabel(it)}`],
        rel ? h("span", { class: `cc-l2 lv-${rel.level}` }, ` · ${rel.text}`) : null),
      link ? h("a", { class: "act-btn primary small", href: link, ...EXT }, /forms\.gle|docs\.google\.com\/forms|\/forms\//i.test(link) || d.todo?.action === "fill_form" ? "Open form" : "Open") : null);
  }
  function runBubble(run, at) {
    const d = LIVE.describe(run, state.data.runs, liveNow());
    const found = d.state === "done" ? runItems(run) : [];
    const names = [...new Set(found.map((it) => shortCo(itemCardOf(it).company || cleanName(it.company || "") || "Placement office")))];
    const body = d.state !== "done" ? h("span", { class: "text title" }, ...placeLinks(d.line))
      : found.length <= 3 ? h("div", { class: "run-items" }, found.map(runItemRow))
      : h("span", { class: "text title" }, `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2} more` : ""} — `,
          h("a", { href: "#today" }, "see Today"));
    return h("div", { class: `msg ping run r-${d.state}`, "data-key": `run:${run.id}`, "data-sig": runSig(run) + `|${found.length}`,
                      role: d.state === "active" ? "status" : null },
      d.state === "active" ? h("div", { class: "kicker" }, h("span", { class: "spin", "aria-hidden": "true" })) : null,
      body,
      d.steps ? h("ol", { class: "steps", "aria-label": "Progress" },
        d.steps.map((st) => h("li", { class: `s-${st.state}`, "aria-current": st.state === "now" ? "step" : null }, st.label))) : null,
      h("div", { class: "foot" }, h("span", { class: "time" }, clock(at))));
  }

  // what kind of message it is decides its edge colour and kicker (docs/DESIGN.md, "Message kinds")
  function msgKind(it) {
    const d = it.details || {};
    if (it.needs_review) return "review";
    if (d.kind === "application" || d.kind === "deadline" || ["digest", "reminder", "deadline"].includes(it.category)) return "soon";
    if (["test", "shortlist", "result"].includes(it.category) || ["test", "test_rooms", "shortlist", "result", "interview"].includes(d.kind)) return "test";
    if (d.kind === "listing" || it.category === "listing" || it.category === "collapse") return "new";
    return "you";
  }
  // "in 1 h 48 m" / "in 42 m" / "over": amber under 3 h, red under 1 h; every chip ticks (tick() below)
  const TODAY = window.PingToday;
  const FORMS = window.PingForms;

  // ------------------------------------------------------------ forms: your ticks (form_status), the Forms tab
  // A tick is your own record that you've filled a form: Ping never fills, submits or signs in to a form. It reaches
  // your other open devices at once (Realtime), and the next check stops reminders for it.
  state.formStatus = new Map();
  async function loadTicks(quiet) {
    if (!state.src?.formStatus) return;
    try {
      const rows = await state.src.formStatus();
      state.formStatus = new Map((rows || []).map((r) => [r.form_key, statusOf(r)]));
      if (state.src.formMerges) state.formMerges = await state.src.formMerges();
      if (quiet) refreshTicks();
    } catch { /* the table isn't there yet: no ticks */ }
  }
  const statusOf = (r) => ({ filled: !!r.filled, filled_at: r.filled_at || null, not_for_me: !!r.not_for_me,
                              not_for_me_at: r.not_for_me_at || null, not_for_me_reason: r.not_for_me_reason || null });
  function onTick(row) {
    if (!row?.form_key) return;
    const was = state.formStatus.get(row.form_key), now = statusOf(row);
    if (was && was.filled === now.filled && was.not_for_me === now.not_for_me && was.not_for_me_reason === now.not_for_me_reason) return;
    state.formStatus.set(row.form_key, now);
    refreshTicks();
  }
  const formByKey = (key) => (state.data?.forms || []).find((f) => f.key === key);
  async function setTick(key, filled, { quiet = false } = {}) {
    const before = state.formStatus.get(key);
    state.formStatus.set(key, { ...(before || {}), filled, filled_at: filled ? new Date().toISOString() : null });
    refreshTicks();
    try { await state.src.setFormStatus(key, filled); }
    catch (e) {
      if (before) state.formStatus.set(key, before); else state.formStatus.delete(key);
      refreshTicks();
      toast(`Couldn't save the tick. ${plainly(e)}`);
      return;
    }
    if (quiet) return;
    const f = formByKey(key);
    const what = f ? `${FORMS.names(f).join(", ")} ${FORMS.label(f.purpose).toLowerCase()}` : "Form";
    toast(filled ? `Ticked: ${what}. Reminders stop for it.` : `Unticked: ${what}.`, "Undo", () => setTick(key, !filled, { quiet: true }));
  }
  // ---- "Not for me" (your own record; never the ERP, never the company's roles): out of Due today / Upcoming / Past
  // due, the badges and Today; no more reminders or pushes from the next check. Undo for 5 s; Restore in Forms.
  const rolesOfForm = (f) => (f.role_ids || []).map((id) => roleById().get(id)?.designation).filter(Boolean);
  const nfmOf = (f) => FORMS.notForMe(state.formStatus, f, rolesOfForm(f));
  // a chat / Today item that's out: its form is, or the item itself was dismissed on Today
  function itemNotForMe(it) {
    if (!it || !state.formStatus?.size) return false;
    if (state.formStatus.get(`item:${it.id}`)?.not_for_me) return true;
    const k = it.details?.form?.key, f = k && formByKey(k);
    return !!(f ? nfmOf(f) : k && state.formStatus.get(k)?.not_for_me);
  }
  async function setNotForMe(key, on, { reason = null, quiet = false, label = "" } = {}) {
    const before = state.formStatus.get(key);
    const patch = on ? { not_for_me: true, ...(reason ? { not_for_me_reason: reason } : {}) } : { not_for_me: false };
    state.formStatus.set(key, { ...(before || { filled: false, filled_at: null }), ...patchOf(patch) });
    refreshTicks();
    try { await state.src.setFormStatus(key, patch); }
    catch (e) {
      if (before) state.formStatus.set(key, before); else state.formStatus.delete(key);
      refreshTicks();
      toast(`Couldn't save that. ${plainly(e)}`);
      return false;
    }
    if (quiet) return true;
    if (on && !reason) nfmToast(key, label, before);
    else if (!on) toast(`Restored: ${label || "it"}.`);
    return true;
  }
  // "Not for me: Diageo form. Undo" for 5 s, with an optional one-tap reason
  function nfmToast(key, label, before) {
    let t = $("#toast");
    if (!t) { t = h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
    const why = h("div", { class: "nfm-why", role: "group", "aria-label": "Why (optional)" },
      FORMS.REASONS.map((r) => h("button", { type: "button", class: "chip", onclick: async () => {
        t.hidden = true;
        await state.src.setFormStatus(key, { not_for_me: true, not_for_me_reason: r }).catch(() => {});
        state.formStatus.set(key, { ...state.formStatus.get(key), not_for_me_reason: r });
        refreshTicks();
        askKindOnce();
      } }, r)));
    t.replaceChildren(h("div", { class: "nfm-toast" },
      h("span", {}, `Not for me: ${label || "this"}.`),
      h("button", { type: "button", class: "linklike", onclick: () => {
        t.hidden = true;
        // back exactly as before: the row as it was (or none)
        if (before && !before.not_for_me) { state.formStatus.set(key, before); refreshTicks(); state.src.setFormStatus(key, { not_for_me: false }).catch(() => {}); }
        else setNotForMe(key, false, { quiet: true });
      } }, "Undo")), why);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; askKindOnce(); }, 5000);
  }
  // two or more forms from one company (or of one role type) dismissed: ask once in the chat; saved only on yes
  async function askKindOnce() {
    const c = FORMS.askAbout(state.formStatus, state.data?.forms || [], rolesOfForm);
    if (!c) return;
    const value = c.kind === "company" ? c.value : c.value;
    const askedKey = `asked:${FORMS.kindKey(c.kind, value).slice(5)}`;
    state.formStatus.set(askedKey, { filled: false, filled_at: null, not_for_me: false });
    state.src.setFormStatus(askedKey, { not_for_me: false }).catch(() => {});
    const yes = `stop showing ${c.label}`, no = `keep showing ${c.label}`;
    const text = `You've marked ${c.n} ${c.label} as not for you. Stop showing ${c.label} from now on? It won't touch the roles. `
      + `[Yes](#ask:${encodeURIComponent(yes)}) [No](#ask:${encodeURIComponent(no)})`;
    const reply = { role: "ping", text, created_at: new Date().toISOString() };
    if (addChatRow(reply)) { state.src.addChat(reply).catch(() => {}); applyLive(); }
  }
  // "stop showing Diageo forms" / "keep showing management trainee forms": answered here, saved as your preference
  function kindAnswer(q) {
    const m = String(q || "").trim().match(/^(stop|keep) showing (.+?) forms\.?$/i);
    if (!m) return null;
    const what = m[2].trim();
    const isRole = FORMS.ROLE_TYPES.some(([t]) => t === what.toLowerCase());
    const key = FORMS.kindKey(isRole ? "role" : "company", what);
    const on = m[1].toLowerCase() === "stop";
    const had = !!state.formStatus.get(key)?.not_for_me;
    if (on || had) setNotForMe(key, on, { quiet: true, reason: on ? "your preference" : null });
    return on ? `Done: ${what} forms go to Not for me in Forms from now on, and get no reminders. The roles stay as they are. [Undo](#ask:${encodeURIComponent(`keep showing ${what} forms`)})`
      : had ? `OK: ${what} forms show again.` : `OK, I'll keep showing ${what} forms.`;
  }
  // every checkbox for a form, wherever it is (Forms, the chat's digests, the sheet), shows the same tick
  function formTick(key) {
    const box = h("input", { type: "checkbox", class: "tick-box", "data-form-key": key, "aria-label": "Filled" });
    box.checked = FORMS.isFilled(state.formStatus, key);
    box.addEventListener("click", (ev) => ev.stopPropagation());
    box.addEventListener("change", () => setTick(key, box.checked));
    return h("label", { class: "tick", title: "Tick when you've filled it (your own record)", onclick: (ev) => ev.stopPropagation() }, box);
  }
  function refreshTicks() {
    document.querySelectorAll("input[data-form-key]").forEach((b) => { b.checked = FORMS.isFilled(state.formStatus, b.dataset.formKey); });
    formsBadge();
    renderToday();
    if ((location.hash.slice(1) || "chat") === "forms") drawForms();
  }
  function formsBadge() {
    const b = $("#nav-forms");
    if (!b || !state.data) return;
    const now = liveNow();
    const n = FORMS.badge(state.data.forms || [], state.formStatus, now, rolesOfForm)
      + taskList(now).filter((t) => FORMS.taskState(t, state.formStatus, now) === "open" && t.at - now <= 86400000 && !t.event).length;
    b.textContent = String(n); b.hidden = !n;
    b.parentElement.setAttribute("aria-label", n ? `To do, ${n} due in the next 24 hours` : "To do");
  }
  let toastTimer = null;
  function toast(text, action, run, ms = 6000) {
    let t = $("#toast");
    if (!t) { t = h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
    t.replaceChildren(...[h("span", {}, text), action ? h("button", { type: "button", class: "linklike", onclick: () => { t.hidden = true; run(); } }, action) : null].filter(Boolean));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  // "For you": forms for companies you're eligible for or that match your targets (a form with no known role counts)
  function formMine(f) {
    const roles = (f.role_ids || []).map((id) => roleById().get(id)).filter(Boolean);
    const rs = roles.length ? roles : state.data.roles.filter((r) => FORMS.names(f).some((n) => cleanName(r.company).toLowerCase() === cleanName(n).toLowerCase()));
    return !rs.length || rs.some((r) => r.applied || isMine(r));
  }
  function viewForms() {
    state.formsOnly = state.formsOnly || "foryou";
    const search = h("input", { type: "search", id: "forms-search", placeholder: "Search a company or task", "aria-label": "Search to-dos",
      value: state.formsQuery || "", oninput: (ev) => { state.formsQuery = ev.target.value; drawForms(); } });
    mountPage(h("div", { class: "forms-page" },
      h("h1", {}, "To do"),
      h("p", { class: "muted small" }, "Everything with a deadline: forms, assignments, documents, tests, interviews, applications. Tick what you've done and its reminders stop. Ping never fills or submits anything."),
      h("div", { class: "forms-tools" }, search, h("div", { class: "chips", id: "forms-chips", role: "group", "aria-label": "Show" })),
      h("div", { id: "forms-list" })));
    drawForms();
  }
  function drawForms() {
    const list = $("#forms-list"), chips = $("#forms-chips");
    if (!list || !state.data) return;
    const now = liveNow();
    const all = state.data.forms || [];
    const chip = (key, label) => h("button", { type: "button", class: "chip", "aria-pressed": String(state.formsOnly === key), "data-only": key,
      onclick: () => { state.formsOnly = key; drawForms(); } }, label);
    chips.replaceChildren(...[chip("foryou", "For you"), chip("all", "All"),
      state.formsAt ? h("button", { type: "button", class: "chip", "aria-pressed": "true", "data-at": "1", onclick: () => { state.formsAt = null; drawForms(); } },
        `Due ${when(new Date(state.formsAt).toISOString())} ×`) : null].filter(Boolean));
    const sec = FORMS.sections(all, state.formStatus, { now, query: state.formsQuery || "", only: state.formsOnly, mineOf: formMine, at: state.formsAt ?? null, rolesOf: rolesOfForm });
    // every other task with a deadline (assignments, documents, CVs, tests, interviews, applications for you)
    const tk = taskList(now);
    const tOpen = tk.filter((t) => FORMS.taskState(t, state.formStatus, now) === "open");
    const tPast = tk.filter((t) => FORMS.taskState(t, state.formStatus, now) === "past" && now - t.at < 7 * 86400000 && !/^apply:/.test(t.key));
    const tDone = tk.filter((t) => FORMS.taskState(t, state.formStatus, now) === "done");
    const tNfm = tk.filter((t) => FORMS.taskState(t, state.formStatus, now) === "notForMe");
    if (!all.length && !tk.length) { list.replaceChildren(h("p", { class: "muted" }, "Nothing to do yet. Forms, assignments, tests and deadlines from the notices and your placement mail show up here after the next check.")); formsBadge(); return; }
    // open: forms and tasks in one list by deadline, no headings (each card's date line says "Today 20:00",
    // "Tomorrow 20:00", "Fri 27 Nov"); none: one line, never an empty section
    const searching = !!(state.formsQuery || "").trim() || state.formsAt != null;
    const openRows = [...sec.open.map((f) => ({ at: dt(f.due_at) ? +dt(f.due_at) : 9e15, el: () => formRow(f) })),
                      ...tOpen.map((t) => ({ at: t.at, el: () => taskRow(t) }))].sort((a, b) => a.at - b.at);
    const open = openRows.length ? h("section", { class: "forms-sec open-list", id: "forms-open", "aria-label": `To do, ${openRows.length}` },
        h("div", { class: "forms-rows" }, openRows.map((r) => r.el())))
      : h("p", { class: "forms-clear", id: "forms-open" }, searching ? "Nothing to do matches." : "Nothing to do. You're clear.");
    // what's left: collapsed rows at the bottom ("Past due · 16"), each only when it has something
    state.formsSecOpen = state.formsSecOpen || {};
    const fold = (id, title, rows, draw, cls = "compact") => rows.length ? h("details", { class: `forms-sec ${cls}`, id: `forms-${id}`, "aria-label": title,
        open: state.formsSecOpen[id] ? true : null, ontoggle: (ev) => { state.formsSecOpen[id] = ev.currentTarget.open; } },
      h("summary", {}, h("h2", {}, title, h("span", { class: "n" }, `· ${rows.length}`)), h("span", { class: "chev", "aria-hidden": "true" })),
      h("div", { class: `forms-rows${cls === "compact" ? " compact" : ""}` }, draw(rows))) : null;
    list.replaceChildren(...[
      open,
      // past due: cards (you might still open one); closed and filled: one line each, a tap opens the form in place;
      // not for you: one line each with Restore
      fold("past", "Past due", [...sec.past, ...tPast], (rows) => rows.map((x) => (x.type ? taskRow(x) : formRow(x))), "fold"),
      fold("closed", "Closed", sec.closed, (rows) => rows.map(compactRow)),
      fold("filled", "Done", [...sec.filled, ...tDone], (rows) => rows.map((x) => (x.type ? taskRow(x) : compactRow(x)))),
      fold("notforme", "Not for me", [...sec.notForMe, ...tNfm], (rows) => rows.map((x) => (x.type ? taskRow(x) : nfmRow(x))))].filter(Boolean));
    formsBadge();
  }
  // the tasks besides forms, for the To do list (dashboard/forms.js tasks), with the list's filters
  function taskList(now) {
    const q = (state.formsQuery || "").trim().toLowerCase();
    return FORMS.tasks({ items: (state.data.items || []).filter((it) => !it.dismissed), roles: state.data.roles || [], now,
                         isMine: (r) => isMine(r) || !!pinOf(r), status: state.formStatus })
      .filter((t) => (!q || `${t.company} ${t.type} ${t.title || ""} ${(t.roles || []).join(" ")}`.toLowerCase().includes(q))
                  && (state.formsAt == null || t.at === state.formsAt));
  }
  // "BlueStone · Assignment · Fri 27 Nov 23:59 [Open brief]": the link (the brief, the test, the ERP) is the button
  function taskRow(t) {
    const name = cleanName(t.company || "") || "Placement office";
    const role = t.roles ? t.roles.join(", ") : roleIn(t.title || "");
    const erp = t.roleIds ? TODAY.erpLink(roleById().get(t.roleIds[0]) || { company: t.company }, myRoll()) : null;
    const primary = t.link ? h("a", { class: "act-btn primary", href: t.link, ...EXT, "data-link": "task" }, t.linkLabel || "Open")
      : erp ? h("a", { class: "act-btn primary", href: erp.href, ...EXT, "data-link": "erp" }, "Apply on ERP") : null;
    const done = state.formStatus.get(t.key)?.filled;
    return cardC({
      key: `task:${t.key}`, cls: `form-row task${done ? " filled" : ""}`, attrs: { "data-task": t.key },
      lead: t.itemId && !t.event ? formTick(t.key) : null, company: name, task: t.type, at: t.due_at, event: !!t.event,
      status: done ? h("span", { class: "pill applied" }, "✓ done") : null, l3: role, primary,
      tail: t.itemId ? h("button", { type: "button", class: "act-btn ghost nfm-btn", onclick: () => setNotForMe(t.key, true, { label: `${name} ${t.type.toLowerCase()}` }) }, "Not for me") : null,
      detail: () => [
        t.itemId ? h("div", { class: "ac-links cc-links nfm-menu" }, h("button", { type: "button", class: "act-btn", onclick: () => setNotForMe(t.key, true, { label: `${name} ${t.type.toLowerCase()}` }) }, "Not for me")) : null,
        ccRow(t.event ? "When" : "Due", when(t.due_at)),
        role ? ccRow(t.roles && t.roles.length > 1 ? "Roles" : "Role", role) : null,
        t.source ? ccRow("From", /^mail/.test(t.source) ? t.source.replace(/^mail from /, "Mail from ").replace(/^mail$/, "Your placement mail") : t.source === "erp" ? "The ERP's companies list" : "A CDC notice") : null,
        ccLinks(t.itemId ? h("button", { type: "button", class: "act-btn", "data-link": "chat", onclick: () => goTo({ item: t.itemId }) }, "Show in chat") : null),
      ],
    });
  }
  // a form you can't act on any more (closed, or ticked): checkbox, company, type, date and a small tag on one line;
  // a tap opens the full card in its place (one at a time), a second tap closes it
  function compactRow(f) {
    const open = state.formsExpanded === f.key;
    const cos = [...new Set(FORMS.names(f).map(FORMS.cleanName))];
    const filled = FORMS.isFilled(state.formStatus, f.key);
    const toggle = () => { state.formsExpanded = open ? null : f.key; drawForms(); };
    const line = h("div", { class: `fc-line${open ? " open" : ""}`, "data-form": f.key }, formTick(f.key),
      h("button", { type: "button", class: "fc-tap", "aria-expanded": String(open), onclick: toggle },
        h("strong", { class: "co" }, cos.length > 1 ? `${cos[0]} +${cos.length - 1}` : cos[0] || "A form"),
        h("span", { class: "fc-what" }, FORMS.label(f.purpose)),
        f.due_at ? h("span", { class: "fc-date num" }, when(f.due_at)) : null,
        h("span", { class: `fc-tag${filled ? " ok" : ""}` }, filled ? "✓" : "closed")));
    return open ? h("div", { class: "fc-open" }, line, formRow(f)) : line;
  }
  function nfmRow(f) {
    const cos = [...new Set(FORMS.names(f).map(FORMS.cleanName))];
    const why = nfmOf(f), st = state.formStatus.get(f.key);
    const label = `${cos[0] || "A form"}${cos.length > 1 ? ` +${cos.length - 1}` : ""} ${FORMS.label(f.purpose).toLowerCase()}`;
    const by = why === "company" ? "all their forms" : why === "role" ? "this kind of role" : st?.not_for_me_reason || "";
    return h("div", { class: "fc-line nfm", "data-form": f.key },
      h("strong", { class: "co" }, cos.length > 1 ? `${cos[0]} +${cos.length - 1}` : cos[0] || "A form"),
      h("span", { class: "fc-what" }, FORMS.label(f.purpose)),
      f.due_at ? h("span", { class: "fc-date num" }, when(f.due_at)) : null,
      by ? h("span", { class: "fc-tag" }, by) : null,
      why === "you" ? h("button", { type: "button", class: "act-btn", onclick: () => setNotForMe(f.key, false, { label }) }, "Restore")
        : h("button", { type: "button", class: "act-btn", onclick: () => askInChat(`keep showing ${why === "company" ? cos[0] : FORMS.roleType([...rolesOfForm(f), f.title].find((x) => FORMS.roleType(x)))} forms`) }, "Restore"));
  }
  // one notice that gives several companies their own forms: one row per form, under that notice's heading
  function groupedRows(rows) {
    const noticeOf = (f) => (f.sources || []).find((x) => x.type === "notice")?.id;
    const count = new Map();
    for (const f of rows) { const n = noticeOf(f); if (n) count.set(n, (count.get(n) || 0) + 1); }
    const out = [], done = new Set();
    for (const f of rows) {
      const n = noticeOf(f);
      if (!n || count.get(n) < 2) { out.push(formRow(f)); continue; }
      if (done.has(n)) continue;
      done.add(n);
      const members = rows.filter((x) => noticeOf(x) === n);
      const subject = CARDS.cleanTitle((state.data.notices || []).find((x) => String(x.notice_id) === String(n))?.subject || "", "");
      const head = subject || "One notice";
      out.push(h("div", { class: "forms-group", role: "group", "aria-label": `${head}: ${members.length} forms` },
        h("div", { class: "fg-head" }, h("strong", {}, head), h("span", { class: "muted small" }, ` · ${members.length} forms`)),
        members.map(formRow)));
    }
    return out;
  }
  // a form's task in plain words: a CV submission, a test, or a form (what it's for goes in the detail)
  const formTask = (f) => (/cv|resume/i.test(f.purpose || "") ? "CV submission" : /test/i.test(f.purpose || "") ? "Test" : "Form");
  function formRow(f) {
    const filled = FORMS.isFilled(state.formStatus, f.key);
    const notices = (f.sources || []).filter((x) => x.type === "notice");
    const item = (f.item_ids || []).map((id) => itemById().get(id)).find((i) => i && inChat(i));
    const href = f.final_url || f.link;
    const moved = FORMS.movedLine(f, when);
    const cos = [...new Set(FORMS.names(f).map(FORMS.cleanName))], many = cos.length > 1;
    const roles = (f.role_ids || []).map((id) => roleById().get(id)).filter(Boolean);
    const roleNames = [...new Set(roles.map((r) => r.designation).filter(Boolean))];
    const extra = CARDS.cleanTitle(f.title, cos[0], [formTask(f), "form"]);
    const erp = href ? null : TODAY.erpLink(roles[0] || { company: cos[0] }, myRoll());
    const status = filled ? h("span", { class: "pill applied" }, "✓ filled") : f.closed ? h("span", { class: "pill over" }, "Closed")
      : moved && !(f.due_at && dt(f.due_at) <= nowDate()) ? h("span", { class: "pill plain" }, "extended") : null;
    return cardC({
      key: `form:${f.key}`, cls: `form-row${filled ? " filled" : ""}${f.closed ? " closed" : ""}`, attrs: { "data-form": f.key },
      lead: formTick(f.key), company: many ? `${cos[0]} +${cos.length - 1}` : cos[0] || "A form", task: formTask(f), at: f.due_at || null, status,
      l3: many ? cos.slice(1).join(", ") : roleNames.join(", ") || extra,
      primary: href ? h("a", { class: "act-btn primary", href, ...EXT, "data-link": "form" }, "Open form")
        : erp ? h("a", { class: "act-btn primary", href: erp.href, ...EXT, "data-link": "erp" }, "Apply on ERP") : null,
      tail: h("button", { type: "button", class: "act-btn ghost nfm-btn", onclick: () => setNotForMe(f.key, true, { label: `${cos[0] || "this"} ${FORMS.label(f.purpose).toLowerCase()}` }) }, "Not for me"),
      detail: () => [
        h("div", { class: "ac-links cc-links nfm-menu" }, h("button", { type: "button", class: "act-btn", onclick: () => setNotForMe(f.key, true, { label: `${cos[0] || "this"} ${FORMS.label(f.purpose).toLowerCase()}` }) }, "Not for me")),
        f.title ? ccRow("Title", f.title) : null,
        ccRow("For", FORMS.label(f.purpose)),
        many ? ccRow("Companies", cos.join(", ")) : null,
        roleNames.length ? ccRow(roleNames.length > 1 ? "Roles" : "Role", roleNames.join(", ")) : null,
        ccRow("Due", f.due_at ? when(f.due_at) : "No deadline given"),
        moved ? ccRow("Moved", moved.replace(/^deadline moved /, "")) : null,
        ccRow("Posted", postedSpan((f.sources || []).map((x) => x.at || (state.data.notices || []).find((n) => String(n.notice_id) === String(x.id))?.notice_time),
          "time")),
        f.signin_required ? h("p", { class: "cc-note" }, "This form needs an institute sign-in: Ping can't read it, so open it in your browser. The notice says what it's for.") : null,
        f.closed ? h("p", { class: "cc-note" }, "The form page says it's no longer accepting responses.") : null,
        ccLinks(noticeButtons(notices.map((x) => x.id)),
          item ? h("button", { type: "button", class: "act-btn", "data-link": "chat", onclick: () => goTo({ item: item.id }) }, "Show in chat") : null),
      ],
    });
  }
  // "Looks like the same form as <X>, merge?": your answer is remembered (form_merges) and the next check follows it
  function looksLike(f, x) {
    const other = formByKey(x.key);
    const decided = (state.formMerges || []).find((m) => (m.a === f.key && m.b === x.key) || (m.a === x.key && m.b === f.key));
    if (decided) return h("div", { class: "fr-line muted small" }, decided.choice === "merge" ? "You merged this with a similar form: the next check joins them." : "Kept apart from a similar form.");
    const answer = async (choice) => {
      try { await state.src.formMerge(f.key, x.key, choice); state.formMerges = [...(state.formMerges || []), { a: f.key, b: x.key, choice }]; drawForms(); }
      catch (e) { toast(`Couldn't save that. ${plainly(e)}`); }
    };
    return h("div", { class: "fr-similar" }, `Looks like the same form as ${other ? FORMS.names(other).join(", ") + " " + FORMS.label(other.purpose).toLowerCase() : x.title || "another one"}${other?.due_at ? ` (due ${when(other.due_at)})` : ""}, merge?`,
      h("button", { type: "button", class: "act-btn", onclick: () => answer("merge") }, "Merge"),
      h("button", { type: "button", class: "act-btn", onclick: () => answer("keep") }, "Keep both"));
  }
  // ------------------------------------------------------------ the compact card (Forms, Today's sheet, chat)
  // Collapsed, at most 3 lines and one button row: line 1 the company and the task in plain words, line 2 the deadline
  // in relative words ("Today 23:59 · 2 h 24 m left", "Tomorrow 20:00", "Mon 23 Nov · past due"), an optional line 3
  // (the role, or what a title adds), one primary button and "⋯". A tap on the card or on ⋯ opens the detail in place:
  // the full titles, every notice, when it was posted, the role, Show in chat. Only what renders: the data is as it was.
  const CARDS = window.PingCards;
  // a company as a card's first line says it: short, no legal suffix ("EY Global Delivery Services")
  const shortCo = (c) => (window.PingNames?.shortName ? window.PingNames.shortName(cleanName(c || "")) : FORMS.cleanName(cleanName(c || "")));
  // a role without the company's own name in it ("Associate Manager BlackBuck Leadership Program" -> "Associate
  // Manager Leadership Program"): the company is already on line 1
  function withoutCo(role, company) {
    const w = String(company || "").split(/\s+/)[0];
    if (!role || !w || w.length < 3) return String(role || "").replace(/\s*\|\s*/g, " · ");
    const out = role.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*`, "ig"), "").replace(/\s*\|\s*/g, " · ").replace(/\s{2,}/g, " ").trim();
    return out.length >= 3 ? out : role;
  }
  const relOf = (at, event = false) => CARDS.relDeadline(at, liveNow(), { event });
  function cardC({ key, cls = "", lead = null, company, task, at, event = false, status = null, l3 = "", primary = null,
                   tail = null, detail = () => [], attrs = {} }) {
    state.cardOpen = state.cardOpen || new Set();
    const open = !!key && state.cardOpen.has(key);
    const rel = at === undefined ? null : relOf(at, event);
    // line 1 never cut off: when the name and the task don't fit, the task leads line 2 ("Test · Tue 24 Nov 11:00")
    const name = shortCo(company), long = task && name.length + task.length > 30;
    const body = h("div", { class: "cc-detail", hidden: open ? null : true });
    let built = false;
    const build = () => { if (!built) { built = true; body.append(...[].concat(detail()).filter(Boolean)); } };
    const more = h("button", { type: "button", class: "cc-more", "aria-expanded": String(open), "aria-label": `More about ${company || "this"}` }, "⋯");
    const card = h("article", { class: `card-c${cls ? ` ${cls}` : ""}${open ? " open" : ""}`, ...attrs },
      h("div", { class: "cc-main" }, lead,
        h("div", { class: "cc-text" },
          h("div", { class: "cc-l1" }, h("strong", { class: "co" }, name), task && !long ? h("span", { class: "cc-task" }, ` · ${task}`) : null, long ? null : status),
          rel || long ? h("div", { class: "cc-l2-wrap" }, long ? h("span", { class: "cc-task2" }, `${task}${rel ? " · " : ""}`) : null,
            rel ? h("span", { class: `cc-l2 lv-${rel.level}`, ...(rel.level !== "over" && rel.level !== "none" && at ? { "data-rel": dt(at).toISOString(), "data-event": event ? "1" : null } : {}) }, rel.text) : null,
            long ? status : null) : null,
          l3 ? h("div", { class: "cc-l3" }, withoutCo(l3, company)) : null)),
      h("div", { class: "cc-act" }, primary, h("span", { class: "cc-gap" }), tail, more),
      body);
    const toggle = () => {
      const now = !card.classList.contains("open");
      if (now) build();
      card.classList.toggle("open", now); body.hidden = !now; more.setAttribute("aria-expanded", String(now));
      if (key) now ? state.cardOpen.add(key) : state.cardOpen.delete(key);
    };
    if (open) build();
    more.addEventListener("click", (ev) => { ev.stopPropagation(); toggle(); });
    card.addEventListener("click", (ev) => { if (!ev.target.closest("a, button, input, label, summary, .tick")) toggle(); });
    return card;
  }
  // the detail's rows: "Posted · first Thu 12 Nov 05:34, last Thu 12 Nov 15:22"
  const ccRow = (label, value) => (value ? h("div", { class: "cc-row" }, h("span", { class: "cc-k" }, label), h("span", { class: "cc-v" }, value)) : null);
  const ccLinks = (...links) => { const l = links.flat().filter(Boolean); return l.length ? h("div", { class: "ac-links cc-links" }, l) : null; };
  // the notices a form or message came from: one button each, by when it was posted (never its number)
  function noticeButtons(ids) {
    const byId = new Map((state.data.notices || []).map((n) => [String(n.notice_id ?? n.id), n]));
    const list = [...new Set(ids.map(String))].map((id) => ({ id, n: byId.get(id) }))
      .sort((a, b) => String(a.n?.notice_time || "").localeCompare(String(b.n?.notice_time || "")));
    return list.map(({ id, n }, k) => h("button", { type: "button", class: "act-btn", "data-link": "notice", onclick: () => openNotice(Number(id) || id) },
      list.length > 1 ? `Notice · ${n?.notice_time ? shortTime(n.notice_time) : k + 1}` : "Notice"));
  }
  // "first Thu 12 Nov 05:34, last Thu 12 Nov 15:22 (2 notices)"
  function postedSpan(times, what = "notice") {
    const t = times.filter(Boolean).map((v) => +dt(v)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    if (!t.length) return "";
    if (t.length === 1) return when(new Date(t[0]).toISOString());
    return `first ${when(new Date(t[0]).toISOString())}, last ${when(new Date(t[t.length - 1]).toISOString())} (${t.length} ${what}s)`;
  }
  const countdown = (at) => TODAY.countdown(at, liveNow()).text;
  const countPill = (at) => { const c = TODAY.countdown(at, liveNow());
    return h("span", { class: `pill cd c-${c.level}`, "data-due": dt(at).toISOString(), title: when(at) }, c.text); };
  function tick() {
    if (!state.data) return;
    const now = liveNow();
    for (const el of document.querySelectorAll("[data-due]")) {
      const c = TODAY.countdown(el.dataset.due, now);
      if (el.textContent !== c.text) el.textContent = c.text;
      const cls = `pill cd c-${c.level}`;
      if (el.className !== cls) el.className = cls;
    }
    for (const el of document.querySelectorAll("[data-when]")) {
      const w = CARDS.whenText(el.dataset.when, now);
      if (el.textContent !== w) el.textContent = w;
    }
    for (const el of document.querySelectorAll("[data-rel]")) {
      const r = CARDS.relDeadline(el.dataset.rel, now, { event: !!el.dataset.event });
      if (el.textContent !== r.text) el.textContent = r.text;
      const cls = `${el.className.replace(/\blv-\w+/, "").trim()} lv-${r.level}`;
      if (el.className !== cls) el.className = cls;
    }
    showLastRun();
    const minute = Math.floor(now / 60000);
    if (minute !== state.tickMinute) { state.tickMinute = minute; renderToday(); }
  }
  setInterval(tick, 1000);
  const shortTime = (v) => { const d = dt(v); const k = istDay(d);
    return k === istDay(nowDate()) ? clock(v) : `${d.toLocaleDateString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" })} ${clock(v)}`; };

  // the attached list of a notice whose verdict asks you to look yourself (not found / not read reliably)
  function listLink(it) {
    const d = it.details || {}, st = d.pdf?.status || it.pdf_status;
    if (!it.notice_id || !(st === "no" || st === "unknown") || !/check (the list|it) yourself|couldn't read/i.test(it.title || "")) return null;
    const year = String(d.notice_key || "").replace(/^sample:/, "").split(":")[0];
    return year ? `https://erp.iitkgp.ac.in/TrainingPlacementSSO/AdmFilePDF.htm?type=NOTICE&year=${encodeURIComponent(year)}&id=${it.notice_id}` : null;
  }
  // line 2: the run's sentence with the card's own date in its slot ("Submit the assignment by Tomorrow 23:59"),
  // coloured like the deadline and kept current by tick(); plain text when given
  function sumLine(it, plain, event) {
    const d = it.details || {}, at = it.due_at || it.event_at || d.summary_past_at;
    if (plain != null || !d.summary_tpl) return plain ?? "";
    // once its deadline or time has passed: what closed or happened, never "now" or a call to act (the run wrote it)
    const gone = at && dt(at) <= liveNow() && d.summary_past_tpl;
    const parts = String(gone ? d.summary_past_tpl : d.summary_tpl).split("{when}");
    const rel = at ? relOf(at, event) : null;
    // "Test on Fri 27 Nov 15:00", but "Test today 15:00" (never "on Today")
    const w = at ? CARDS.whenText(at, liveNow()) : "", rel2 = /^(Today|Tomorrow)/.test(w);
    return parts.flatMap((p, k) => {
      const before = k < parts.length - 1 && rel2 ? p.replace(/\b(on|for)\s+$/i, "") : p;
      return k === 0 ? [before] : [h("span", { class: `cc-when lv-${rel?.level || "none"}`, "data-when": at ? dt(at).toISOString() : null }, w), before];
    });
  }
  // line 2 of a text card the run hasn't written a summary for yet: the title as one plain sentence, whole
  function sumFallback(it, company, task) {
    const t = CARDS.cleanTitle(String(it.title || "").replace(/^[^:]{2,60}:\s*/, ""), company, [task]);
    return t ? (/[.!?]$/.test(t) ? t : `${t}.`) : "New notice: tap to read it.";
  }
  // the whole notice (or the mail's subject and summary) behind ⋯ / a tap, read when opened, never cut
  const fullCache = new Map();
  function fullText(it) {
    const d = it.details || {};
    const box = h("div", { class: "full-text" });
    const show = (head, text) => box.replaceChildren(head ? h("div", { class: "muted small" }, head) : null, h("div", { class: "full-body" }, text || ""));
    const key = it.notice_id ? `n:${it.notice_id}` : d.mail?.id ? `m:${d.mail.id}` : null;
    if (!key) return null;
    if (fullCache.has(key)) { const [a, b] = fullCache.get(key); show(a, b); return box; }
    show("", "Loading the full text…");
    const read = it.notice_id ? state.src.notice(it.notice_id).then((r) => r.notice && [`Notice · ${r.notice.subject || ""} · ${when(r.notice.notice_time)}`, r.notice.text || r.notice.preview || ""])
      : (state.src.mail ? state.src.mail(d.mail.id) : Promise.resolve(null)).then((m) => [`Email · ${d.mail.subject || m?.subject || ""}${d.mail.received_at ? ` · ${when(d.mail.received_at)}` : ""}`,
          [m?.snippet || d.mail.summary || "", m?.main_link || d.mail.link || ""].filter(Boolean).join("\n")]);
    read.then((v) => { if (v) { fullCache.set(key, v); show(...v); } else box.remove(); }).catch(() => show("", "Couldn't load the full text. Tap Notice to open it."));
    return box;
  }
  function itemBubble(it, at) {
    const past = isPast(it);
    const kind = msgKind(it), d = it.details || {};
    const why = it.details?.hidden_because || "";
    const pastLabel = /updated/.test(why) ? "Since updated" : /reminder/.test(why) ? "Replaced by reminder"
      : /deadline/.test(why) ? "Deadline passed" : "Over";
    const due = it.due_at || it.event_at;
    const label = past ? pastLabel : kind === "review" ? "Question"
      : kind === "soon" ? (d.role === "reminder" || it.category === "reminder" || it.category === "digest" ? "Reminder" : "Deadline")
      : kind === "test" ? ({ shortlist: "Shortlist", result: "Result" }[it.category] || "Test")
      : kind === "new" ? "New" : d.todo?.action === "fill_form" ? "Form" : d.todo?.action === "take_test" ? "Test"
      : it.category === "offer" ? "Offer" : it.category === "ppt" ? "Talk" : CARDS.typeLabel(it);
    const open = state.open.has(it.id);
    // placement mail: "via email" on a message only the mail has; "also mailed" on an ERP message the mail repeated;
    // a form / test / meeting link from the mail right on the message
    const viaMail = d.via === "email", mailed = !viaMail && d.mail?.note;
    const mlink = viaMail ? d.mail?.link || d.todo?.link : mailed ? d.mail?.link : null;
    const linkText = (u) => /forms\.gle|docs\.google\.com\/forms|forms\.office|typeform|jotform|\/forms\//i.test(u) ? "Open form ↗"
      : /meet\.google|zoom\.us|teams\.microsoft|webex|\/interview\//i.test(u) ? "Join ↗" : /hackerrank|hackerearth|mettl|codility|test|assess/i.test(u) ? "Open test ↗" : "Open link ↗";
    // collapsed, by the card rule: who and what, the time in relative words, the role (or the names in a list), one
    // button; the full message, its list, where it came from and its links are behind ⋯ (or a tap on the message)
    const digest = (d.list || []).some((g) => (g.rows || []).length);
    const company = shortCo(it.company) || ((it.title || "").match(/^(?:Update - )?([^:(]{2,40}?)(?: deadline| test| form)?:/) || [])[1] || "";
    // the type, never a vague "Update": Form, Assignment, Deadline change, Shortlist, Test, Info... (stored by the run)
    const typed = CARDS.typeLabel(it);
    const task = typed !== "Info" ? typed
      : kind === "test" ? (/interview/i.test(it.title || "") ? "Interview" : "Test")
      : kind === "soon" ? (d.role === "reminder" || it.category === "reminder" ? "Reminder" : "Application") : kind === "new" ? "New roles" : typed;
    const event = ["Test", "Interview", "Shortlist", "Result", "Talk"].includes(task);
    // a card that carries a notice's or a mail's text (not a to-do, not a list): line 2 is its one-sentence summary,
    // written by the run (details.summary), wrapped to two lines and never cut; the whole text is behind ⋯ / a tap
    // a to-do with the run's line uses it too (one card per notice: its Info card was merged into it)
    const textCard = !digest && it.category !== "reminder" && !it.needs_review && (!d.todo?.action || !!(d.summary_tpl || d.summary));
    const summary = textCard ? sumLine(it, d.summary_tpl ? null : d.summary || sumFallback(it, company, task), event) : "";
    const rel = due ? relOf(due, event) : null;
    const listed = digest ? (d.list || []).flatMap((g) => g.collapsed ? [] : (g.rows || []).map((r) => FORMS.cleanName(cleanName(cleanRowText(r.text).split(/ — | deadline\b|:| \(/)[0].trim())))) : [];
    const names = [...new Set(listed)];
    const allIds = digest ? (d.list || []).flatMap((g) => (g.rows || []).map((r) => r.id)).filter(Boolean) : [];
    const shortHead = (t) => {
      const m = String(t).match(/(\d+)\s+(applications?|roles?|forms?|deadlines?|tests?|shortlists?)\b/i), y = String(t).match(/(\d+) for you/);
      return t.length <= 32 || !m ? t : `${m[1]} ${m[2].toLowerCase()}${y ? ` · ${y[1]} for you` : ""}`;
    };
    const headline0 = String(retitle(it) || "").replace(/^(reminder|update)\s*:\s*/i, "").split(/:\s+(?=[A-Z])/)[0].replace(/ for roles you applied to/, "").replace(/\s*\([^)]*\)/g, "").split(/;\s/)[0]
      .replace(/(,| to| by| at| on)? (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} \w{3}( \d\d:\d\d)?:?/g, "").replace(/[.:]\s*$/, "").trim();
    const headline = shortHead(headline0);
    const onList = (d.pdf?.status || it.pdf_status) === "yes" && ["Shortlist", "Test", "Result"].includes(task);
    const status = it.done ? h("span", { class: "pill applied" }, "✓ done") : onList ? h("span", { class: "pill you" }, "you're on it")
      : listLink(it) ? h("span", { class: "pill plain" }, "check the list") : null;
    const role = withoutCo(roleIn(it.title) || "", company);
    const place = [d.pdf?.details?.room ? `Room ${d.pdf.details.room}` : ""].filter(Boolean).join("");
    const plain = CARDS.cleanTitle(it.title, company, [task]);
    const fitNames = (list, room = 34) => { const out = [];
      for (const n of list) { if (out.length && [...out, n].join(", ").length > room) break; out.push(n); }
      return out.length < list.length ? `${out.join(", ")} +${list.length - out.length}` : out.join(", "); };
    const l3 = digest ? fitNames(names)
      : [/^\d+ roles?$/.test(role) ? "" : role, place].filter(Boolean).join(" · ") || (!rel ? plain : "");
    const stop = (ev) => ev.stopPropagation();
    const primary = past ? null
      : mlink ? h("a", { class: "act-btn primary", href: mlink, target: "_blank", rel: "noopener", onclick: stop }, linkText(mlink).replace(" ↗", ""))
      : listLink(it) ? h("a", { class: "act-btn primary", href: listLink(it), target: "_blank", rel: "noopener", onclick: stop }, "Open list")
      : d.todo?.link ? h("a", { class: "act-btn primary", href: d.todo.link, target: "_blank", rel: "noopener", onclick: stop }, "Open form")
      : digest && allIds.length ? h("button", { type: "button", class: "act-btn primary", "aria-haspopup": "dialog", onclick: (ev) => { stop(ev); openDigestSheet(it, { ...d, list: resplit(d) }); } },
          `See all ${new Set(allIds).size}`) : null;
    const review = it.needs_review && it.level !== "hidden" && !past && d.candidates?.length;
    // greyed once its time has passed (or the run hid it as past)
    const pastAt = due || d.summary_past_at;          // without a time of its own: its notice's last deadline
    const over = past || (!!pastAt && !digest && dt(pastAt) <= liveNow() && !!d.summary_past_tpl);
    const bubble = h("div", { class: `msg ping item k-${kind}${over ? " past" : ""}${it.done ? " done" : ""}${open ? " open" : ""}`, role: "button",
      tabindex: "0", "aria-expanded": String(open), "data-kind": kind, "data-key": `item:${it.id}`, "data-sig": itemSig(it) },
      review ? h("div", { class: "kicker" }, h("span", { class: "k" }, label)) : null,
      review ? h("span", { class: "text title" }, (d.candidates || []).reduce((t, c) => t.split(c).join(shortCo(c)), retitle(it)))
        : h("div", { class: "card-c chat-c" }, h("div", { class: "cc-text" },
            h("div", { class: "cc-l1" }, digest ? h("strong", { class: "co" }, headline || label) : h("strong", { class: "co" }, company || label),
              digest || !company || company.length + task.length > 26 ? null : h("span", { class: "cc-task" }, ` · ${task}`)),
            textCard ? h("div", { class: "cc-sum", "data-summary": d.summary ? d.summary_by || "run" : "page" }, summary)
            : !digest && company && company.length + task.length > 26 ? h("div", { class: "cc-l2 cc-task2" }, `${task}${rel ? ` · ${rel.text}` : ""}`, status) : null,
            textCard || (!digest && company && company.length + task.length > 26) ? null
            : rel ? h("div", { class: `cc-l2 lv-${rel.level}`, ...(!past && rel.level !== "over" ? { "data-rel": dt(due).toISOString(), "data-event": event ? "1" : null } : {}) },
              past && rel.level !== "over" ? `${rel.text} · ${pastLabel.toLowerCase()}` : rel.text, status)
              : !digest ? h("div", { class: "cc-l2" }, String(it.title || "").replace(/^[^:]{2,60}:\s*/, "")) : null,
            digest && l3 ? h("div", { class: "cc-sum" }, l3) : !textCard && l3 && rel ? h("div", { class: "cc-l3" }, l3) : null)),
      // "Which company is that? Tap to choose.": the choices are on the message, not under Details
      review ? h("div", { class: "onb-actions choose", role: "group", "aria-label": "Which company" },
        d.candidates.map((c) => h("button", { type: "button", class: "chip", onclick: (ev) => { ev.stopPropagation(); fix(it, { company: c }); } }, shortCo(c))),
        h("button", { type: "button", class: "chip", onclick: (ev) => { ev.stopPropagation(); fix(it, { ignore: true }); } }, "None of these")) : null,
      // a text card keeps 3 lines: its status pill, and its type when line 1 is full, sit by the time
      h("div", { class: "cc-act foot" }, primary, h("span", { class: "cc-gap" }),
        textCard && company && company.length + task.length > 26 ? h("span", { class: "cc-type" }, task) : null,
        textCard ? status : null, textCard && past ? h("span", { class: "cc-type" }, pastLabel.toLowerCase()) : null,
        h("span", { class: "time" }, clock(at)),
        h("button", { type: "button", class: "cc-more expand", "aria-expanded": String(open), "aria-label": open ? "Less" : "More about this message" }, open ? "▴" : "⋯")));
    const toggle = (ev) => {
      if (ev.target.closest("a, button:not(.cc-more), .more, summary, details")) return;
      state.open.has(it.id) ? state.open.delete(it.id) : state.open.add(it.id);
      const next = itemBubble(it, at);
      bubble.replaceWith(next);
      next.focus({ preventScroll: true });
    };
    bubble.addEventListener("click", toggle);
    bubble.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(ev); } });
    // the detail: the whole message, its list, where it came from, every link
    if (open) bubble.append(h("div", { class: "cc-detail chat-detail" },
      review ? null : h("span", { class: "text title" }, retitle(it)),
      !review ? fullText(it) : null,
      // a form posted again: one line on the message, not a new message
      d.extended?.length ? h("div", { class: "ext-line" }, `Deadline extended: ${when(d.extended[0].from)} → ${when(d.extended[d.extended.length - 1].to)}`) : null,
      listBlock(it),
      viaMail ? h("div", { class: "muted small" }, `Via email${d.mail?.from ? ` from ${String(d.mail.from).replace(/<[^>]*>/g, "").trim()}` : ""}`) : null,
      mailed ? h("div", { class: "muted small" }, d.mail.note) : null,
      itemDetails(it)));
    return bubble;
  }

  // "... — 11 for you" in a heading follows the current marks too
  function retitle(it) {
    const marks = state.marks, d = it.details || {};
    if (!marks?.size || !state.prefs?.targets || !/ — \d+ for you$/.test(it.title || "")) return it.title;
    const ids = (d.list || []).flatMap((g) => /^Applied/.test(g.head || "") ? [] : (g.rows || []).map((r) => r.id));
    return it.title.replace(/ — \d+ for you$/, ` — ${ids.filter((id) => marks.get(id)?.relevant).length} for you`);
  }

  // A digest / "new roles" / "3 shortlists out" message: its list, grouped (for you first, others collapsed),
  // then any note and the source of the dates
  // the lists were split by the targets of the last run; if the targets changed since (said in the chat), split them
  // again by the current marks
  function resplit(d) {
    const marks = state.marks, targets = state.prefs?.targets;
    if (!["application", "listing"].includes(d.kind) || ((!marks || !marks.size || !targets) && !hasPins())) return d.list || [];
    const relOf = (id) => { const r = roleById().get(id) || { id }; const pin = pinOf(r);
      return pin !== null ? { relevant: pin, reason: pin ? "You said it's for you" : "" } : (marks?.size && targets ? marks.get(id) : { relevant: true }); };
    const out = [];
    const sections = new Map();
    for (const g of d.list || []) {
      const [prefix] = String(g.head || "").split(" · ");
      const key = /^(For you|Others|$)/.test(prefix) ? "" : prefix;
      if (/^Applied/.test(prefix)) { out.push(g); continue; }
      sections.set(key, [...(sections.get(key) || []), ...(g.rows || [])]);
    }
    const listOthers = state.prefs?.list_other_roles !== false;
    for (const [prefix, rows] of sections) {
      const mine = rows.filter((r) => relOf(r.id)?.relevant).map((r) => {
        const m = relOf(r.id);
        return { ...r, note: [m.reason, m.best_cv ? `Apply with: ${m.best_cv}` : ""].filter(Boolean).join(" · ") };
      });
      const others = rows.filter((r) => !relOf(r.id)?.relevant).map((r) => ({ ...r, note: "" }));
      const h = (s) => (prefix ? `${prefix} · ${s}` : s);
      if (mine.length) out.unshift({ head: h("For you"), rows: mine });
      if (others.length) out.push(listOthers ? { head: h(`Others (${others.length})`), collapsed: true, rows: others }
                                             : { head: h(`${others.length} other roles not shown`), rows: [] });
    }
    return out;
  }

  let itemMap = null;
  const itemById = () => (itemMap && itemMap.src === state.data.items && itemMap.hist === state.history ? itemMap.map
    : (itemMap = { src: state.data.items, hist: state.history, map: new Map(knownItems().map((i) => [i.id, i])) }).map);
  let roleMap = null;
  const roleById = () => (roleMap && roleMap.src === state.data.roles ? roleMap.map
    : (roleMap = { src: state.data.roles, map: new Map(state.data.roles.map((r) => [r.id, r])) }).map);

  // CGPA, degree and department missing from the profile: one note in the thread and a dot on Profile (older
  // digests carried the same sentence under each one; it's taken out of them here)
  const profileGapFree = (note) => String(note || "").replace(/\s*Add your [^.]*on the Profile page to check eligibility\.\s*/g, " ").trim();
  function profileGaps() {
    const p = state.data?.profile || {};
    return [p.cgpa == null || p.cgpa === "" ? "CGPA" : "", !p.degree ? "degree" : "", !p.department ? "department" : ""].filter(Boolean);
  }
  function profileGapNote() {
    const gaps = profileGaps();
    if (!gaps.length || state.src?.kind === "demo") return null;
    const what = gaps.length === 1 ? gaps[0] : `${gaps.slice(0, -1).join(", ")} and ${gaps[gaps.length - 1]}`;
    return h("div", { class: "msg ping sys profile-gap", role: "note" },
      h("span", { class: "text" }, `Add your ${what} and I'll check what you're eligible for.`),
      h("a", { class: "act-btn small", href: "#profile/about" }, "Open Profile"));
  }
  function profileDot() {
    const a = document.querySelector('#nav a[data-route="profile"]');
    if (!a) return;
    let dot = a.querySelector(".dot");
    if (!dot) { dot = h("span", { class: "dot", "aria-hidden": "true" }); a.append(dot); }
    const n = state.src?.kind === "demo" ? 0 : profileGaps().length;
    dot.hidden = !n;
    a.setAttribute("aria-label", n ? "Profile, details missing" : "Profile");
  }

  function listBlock(it) {
    const d0 = it.details || {};
    const d = { ...d0, list: resplit(d0) };
    if (!(d.list || []).length && !d.source) return null;
    // a row: "Company — Role", a ✓ applied badge, and the reason / which CV on a second line
    const row = (r) => {
      const applied = r.tag === "done" || roleById().get(r.id)?.applied;
      const fkey = itemById().get(r.id)?.details?.form?.key;
      return h("div", { class: `li ${r.tag || ""}${fkey ? " has-tick" : ""}` }, fkey ? formTick(fkey) : null, h("span", { class: "rt" }, cleanRowText(r.text)),
        applied ? h("span", { class: "pill applied" }, "✓ applied") : null,
        r.note ? h("span", { class: "why" }, r.note) : null);
    };
    const groups = (d.list || []).map((g) => {
      const rows = (g.rows || []).map(row);
      if (g.collapsed && rows.length) {
        // "Show 33 more": the sheet with every role in this message (one place to act from)
        return h("div", { class: "grp more-rows" }, h("button", { type: "button", class: "linklike show-more", "aria-haspopup": "dialog",
          onclick: (ev) => { ev.stopPropagation(); openDigestSheet(it, d); } }, `Show ${rows.length} more ›`));
      }
      return h("div", { class: "grp" }, g.head ? h("div", { class: "gh" }, g.head) : null, rows);
    });
    const note = profileGapFree(d.note);
    return h("div", { class: "list" }, groups, note ? h("div", { class: "why" }, note) : null,
      d.source ? h("div", { class: "src" }, d.source) : null);
  }

  function openDigestSheet(it, d) {
    const ids = (d.list || []).flatMap((g) => (g.rows || []).map((r) => r.id)).filter(Boolean);
    const roles = [...new Set(ids)].map((id) => roleById().get(id)).filter(Boolean);
    const due = it.due_at ? +dt(it.due_at) : 0;
    const cards = roles.map((r) => roleCard(r, { chat: it.id }));
    const t = TODAY.sheetTitle({ cards, at: due || Date.now(), now: liveNow() });
    openActSheet({ title: t.title, sub: due && roles.every((r) => +dt(deadlineOf(r)) === due) ? t.sub : `${retitle(it)} · ${cards.length} in all`, cards, filters: true });
  }

  function itemDetails(it) {
    const d = it.details || {};
    const due = it.due_at || it.event_at;
    const lines = [];
    if (due) lines.push(h("div", {}, h("strong", {}, it.due_at ? "Due: " : "When: "), when(due)));
    if (it.company) lines.push(h("div", {}, h("strong", {}, "Company: "), h("a", { href: companyHref(it.company) }, it.company)));
    if (d.venue) lines.push(h("div", {}, h("strong", {}, "Venue: "), d.venue));
    if (d.pdf?.status === "yes" && d.pdf.my_row) lines.push(h("div", {}, h("strong", {}, "Your row: "),
      (d.pdf.header ? d.pdf.header.map((x, i) => `${x}: ${d.pdf.my_row[i] ?? ""}`) : d.pdf.my_row).join(" · ")));
    if ((d.reasons || []).length) lines.push(h("div", {}, h("strong", {}, "Eligibility: "), [...d.reasons, ...(d.flags || [])].join("; ")));
    if (d.deadline_source && d.deadline_source !== "companies list") lines.push(h("div", { class: "muted" }, `Deadline from ${d.deadline_source}`));
    if ((d.contacts || []).length) lines.push(h("div", {}, h("strong", {}, "Contacts: "), d.contacts.map((c) => `${c.name} ${c.phone}`).join(", ")));
    if ((d.changes || []).length) lines.push(h("div", {}, h("strong", {}, "What changed: "), d.changes.join("; ")));
    if (d.previous_title) lines.push(h("div", { class: "muted" }, `Before: ${d.previous_title}`));
    if ((d.merged || []).length) lines.push(h("div", { class: "muted" },
      `Also posted ${d.merged.length} more time${d.merged.length > 1 ? "s" : ""} (merged here, not sent again)`));
    if (d.hidden_because) lines.push(h("div", { class: "muted" }, `Not shown any more: ${d.hidden_because}`));
    if (d.mail) lines.push(h("div", {}, h("strong", {}, d.via === "email" ? "From your mail: " : "Also mailed to you: "),
      [d.mail.subject, d.mail.from ? `from ${String(d.mail.from).replace(/<[^>]*>/g, "").trim()}` : "", d.mail.received_at ? when(d.mail.received_at) : ""]
        .filter(Boolean).join(" · ")));
    if (d.when_text && d.via === "email") lines.push(h("div", { class: "muted" }, `The mail says: ${d.when_text}`));
    const links = [
      it.notice_id ? h("button", { type: "button", onclick: () => openNotice(it.notice_id) }, "Open notice") : null,
      it.notice_id && it.pdf_status ? pdfLink(it) : null,
      ...(d.todo?.link ? [h("a", { href: d.todo.link, target: "_blank", rel: "noopener" }, "Open form")] : []),
      ...mailLinks(it).map((u, k) => h("a", { href: u, target: "_blank", rel: "noopener" }, k ? "Link 2" : "Link from your mail")),
      !isPast(it) ? h("button", { type: "button", onclick: () => toggleDone(it) }, it.done ? "Undo done" : "Mark done") : null,
    ];
    const more = h("div", { class: "more" }, lines, h("div", { class: "links" }, links));
    return more;
  }

  // new bubbles go into today's section (a new one if the thread ended on an earlier day)
  function appendToday(inner, node) {
    let group = inner.lastElementChild;
    if (!group || !group.classList.contains("daygroup") || group.getAttribute("aria-label") !== "Today") {
      group = h("section", { class: "daygroup", "aria-label": "Today" }, h("div", { class: "day" }, "Today"));
      inner.querySelector(".empty")?.remove();
      inner.append(group);
    }
    group.append(node);
    return node;
  }

  async function send(input, inner, thread, btn) {
    const q = input.value.trim();
    if (!q || state.waiting) return;
    if (state.offline || !navigator.onLine) return queueSend(q, input, inner, thread);
    input.value = "";
    state.waiting = true;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.replaceChildren(h("span", { class: "wait", "aria-hidden": "true" }, "…"));
    const t0 = performance.now();
    const mine = { role: "me", text: q, created_at: new Date().toISOString() };
    // a reply: the quoted message is the topic (dashboard/reply.js)
    const rp = state.replyTo;
    if (rp) { mine.reply_to = rp.key; mine.reply_quote = { sender: rp.sender, text: rp.text }; clearReply(); }
    const backQuote = { reply_to: msgKey("me", mine.created_at), reply_quote: { sender: "You", text: q.slice(0, 160) } };
    // the question shows at once; the typing dots too if deciding takes more than a moment (the roles' details still
    // loading) and as soon as it goes to Ask Ping's function. A FACT question answered here never shows them.
    appendToday(inner, textBubble("me", q, mine.created_at, true, quoteOf(mine)));
    thread.scrollTop = thread.scrollHeight;
    let wait = null;
    const dots = () => wait || (wait = appendToday(inner, h("div", { class: "msg ping typing enter", role: "status", "aria-label": "Ping is typing" },
      h("span", { class: "dot" }), h("span", { class: "dot" }), h("span", { class: "dot" }))), thread.scrollTop = thread.scrollHeight, wait);
    const dotsSoon = setTimeout(dots, 150);
    // a FACT question: answered at once from the page's own data (in the demo, once the roles' details are in: they
    // arrive within a second of opening)
    if (state.details) { state.startDetails?.(); await state.details; }
    // the page's own answers need the whole history (read once, usually while you typed)
    if (state.src?.history && !state.history) await ensureHistory();
    // "check again", "are you sure?", "I got a call": the previous question, read again from the ERP now
    const RR = window.PingRules;
    // replying: the quoted message answers some questions by itself ("which of these haven't I applied to?", "which
    // cv for the second one?", "where is it?", "done" on a form line, "check again"); others are asked about it
    const P = window.PingReply;
    // feedback ("piramal not relevant", "show Zeta again", "undo"): the function saves it; never answered here
    // "stop showing Diageo forms" (the Yes under Ping's question after two dismissals): your form preference, here
    const kind = !rp ? kindAnswer(q) : null;
    const feedback = !kind && !!RR?.feedbackLike(q);
    const direct = rp && P && !feedback ? P.answer(q, rp.anchor, { isFilled: (k) => !!FORMS?.isFilled(state.formStatus, k), when }) : null;
    const noDots = () => { clearTimeout(dotsSoon); wait?.remove(); };
    if (direct?.recheck) noDots();
    if (direct?.recheck) return recheckFlow(q, { kind: "recheck", companies: rp.anchor.companies }, mine, { input, inner, thread, btn }, backQuote);
    const named = rp && RR ? RR.matchCompanies(q, factsOf(state.data), RR.entities(factsOf(state.data))).hits.length : 0;
    const qRoute = rp && !named && rp.anchor.companies.length ? `${q} ${rp.anchor.companies.map((c) => RR.shortName(c)).join(" ")}` : q;
    const replyCtx = rp ? { sender: rp.anchor.sender, text: rp.anchor.text, companies: rp.anchor.companies } : null;
    const rr = RR && state.data && !feedback && !kind ? RR.route(qRoute, previousQuestions(q), factsOf(state.data)) : null;
    if (rr?.kind === "recheck") noDots();
    if (rr?.kind === "recheck") return recheckFlow(q, rr, mine, { input, inner, thread, btn }, rp ? backQuote : null);
    // forms: "which forms haven't I filled?", "did I fill the Groww form?", "mark the Piramal form as filled" (the
    // last ticks it: your own record, never the ERP or the form)
    if (direct?.tick) setTick(direct.tick, true, { quiet: true });
    const fq = kind || direct || feedback ? null : FORMS && state.data?.forms?.length ? FORMS.ask(qRoute, state.data.forms, state.formStatus, { now: liveNow(), when }) : null;
    if (fq?.tick) setTick(fq.tick, true, { quiet: true });
    const local = kind ? { text: kind } : direct?.text ? { text: direct.text } : fq ? { text: fq.text } : feedback ? {} : localFact(qRoute);
    if (local.text) local.text = withStale(local.text, rr);
    if (local.text) {
      clearTimeout(dotsSoon); wait?.remove();
      state.chat.push(mine);
      const reply = { role: "ping", text: local.text, created_at: new Date(Math.max(Date.now(), Date.parse(mine.created_at) + 1)).toISOString(), ...(rp ? backQuote : {}) };
      state.chat.push(reply);
      const b = textBubble("ping", reply.text, reply.created_at, true, quoteOf(reply));
      b.dataset.answeredBy = "page";
      b.dataset.ms = String(Math.round(performance.now() - t0));
      appendToday(inner, b);
      thread.scrollTop = thread.scrollHeight;
      state.waiting = false;
      btn.removeAttribute("aria-busy");
      btn.replaceChildren(ICON_SEND());
      btn.disabled = !input.value.trim();
      // saved the same way as an answer from the function: the question, then the reply
      state.src.addChat(mine).then(() => state.src.addChat(reply)).catch(() => {});
      return;
    }
    state.chat.push(mine);
    clearTimeout(dotsSoon); dots();
    // a long answer never looks frozen: after 4 s the dots say so
    const slow = setTimeout(() => {
      if (!wait.isConnected) return;
      wait.setAttribute("aria-label", "Ping is still thinking");
      wait.append(h("span", { class: "thinking" }, "still thinking…"));
    }, 4000);
    thread.scrollTop = thread.scrollHeight;
    // saved while asking (not before: one wait less): Ask Ping reads the thread from the database and leaves out the
    // question itself if it's already there, so the answer is the same either way
    const savedQ = state.src.addChat(mine).catch(() => {});
    let answer;
    state.sending = (state.sending || 0) + 1;
    // the typing bubble shows at least briefly, even for an answer that comes back at once
    const typing = new Promise((r) => setTimeout(r, 600));
    let lost = false, answeredBy = "page";
    try { answer = helpHere(q) ?? await state.src.ask(q, replyCtx); answeredBy = "server"; } catch (e) { if (isNetErr(e)) lost = true; answer = plainly(e); } finally { state.sending -= 1; }
    if (lost) {                                   // the connection went while asking: this one waits too
      clearTimeout(slow); wait.remove(); state.waiting = false; btn.removeAttribute("aria-busy"); btn.replaceChildren(ICON_SEND());
      state.chat = state.chat.filter((m) => m !== mine);
      inner.querySelector(`[data-key="${CSS.escape(msgKey("me", mine.created_at))}"]`)?.remove();
      return queueSend(q, input, inner, thread);
    }
    await typing;
    clearTimeout(slow);
    const reply = { role: "ping", text: withStale(answer || "I couldn't come up with an answer.", rr), created_at: new Date().toISOString(), ...(rp ? backQuote : {}) };
    state.chat.push(reply);
    state.waiting = false;
    btn.removeAttribute("aria-busy");
    btn.replaceChildren(ICON_SEND());
    btn.disabled = !input.value.trim();
    if (wait.isConnected) {
      const b = textBubble("ping", reply.text, reply.created_at, true, quoteOf(reply));
      b.dataset.answeredBy = answeredBy;
      b.dataset.ms = String(Math.round(performance.now() - t0));
      wait.replaceWith(b);
      thread.scrollTop = thread.scrollHeight;
    } else {
      route();   // the chat was drawn again meanwhile (e.g. the "For you" marks arrived): draw it with the reply
    }
    state.src.addChat(reply).catch(() => {});
    state.readAt = reply.created_at;
    state.src.setReadAt(state.readAt).catch(() => {});
    // a preference was saved: fetch the new marks and show the lists split the new way
    if (state.prefsChanged) { state.prefsChanged = false; await loadMarks(); route(); }
  }

  // an answer about deadlines, tests, shortlists or a company says how old the ERP data is when that's over 30 min
  // (richText turns the line into "ERP data from 12:41 (1 h 20 min ago). [Check now]")
  function withStale(text, rr) {
    const R = window.PingRules;
    if (!R?.staleNote || !rr || state.src?.demo || /ERP data from \d/.test(text)) return text;
    const about = (rr.spec?.intents || []).some((i) => ["deadline", "test", "shortlist", "applied", "notice", "foryou"].includes(i)) || rr.spec?.hits?.length;
    if (!about || !["fact", "open"].includes(rr.kind)) return text;
    const note = R.staleNote(factsOf(state.data).lastChecked, liveNow());
    return note ? `${text}\n${note}` : text;
  }

  // ---------------------------------------------------------------- reply to a message
  // Phone: swipe a bubble right (or long-press it) to reply. PC: the arrow on a bubble (hover or keyboard), or
  // right-click / long-press. The quoted message shows above the box (✕ or Esc cancels) and becomes the topic.
  function sourceOf(key) {
    if (key.startsWith("item:")) return itemById().get(key.slice(5)) || null;
    const m = state.chat.find((x) => msgKey(x.role, x.created_at) === key);
    return m ? { ...m, key } : null;
  }
  function startReply(el) {
    const key = el?.dataset?.key;
    const P = window.PingReply;
    if (!key || !P || !state.composer || !(key.startsWith("item:") || key.startsWith("msg:"))) return;
    const facts = factsOf(state.data);
    const src = sourceOf(key);
    const anchor = src ? P.anchorOf(src.role ? src : { ...src, details: src.details || {} }, facts) : null;
    if (!anchor) return;
    anchor.key = key;
    if (!anchor.text) anchor.text = (el.querySelector(".text")?.textContent || "").split("\n")[0].slice(0, 160);
    state.replyTo = { key, sender: anchor.sender, text: anchor.text, anchor };
    const { replyBox, input } = state.composer;
    replyBox.replaceChildren(h("div", { class: "rp-bar", "aria-hidden": "true" }),
      h("div", { class: "rp-body" }, h("span", { class: "q-who" }, anchor.sender === "You" ? "You" : "Ping"), h("span", { class: "q-text" }, anchor.text)),
      // pressing ✕ keeps the focus in the box (no layout jump under the finger, the phone's keyboard stays up)
      h("button", { type: "button", class: "rp-x", "aria-label": "Cancel reply", onpointerdown: (e) => e.preventDefault(), onmousedown: (e) => e.preventDefault(),
        onclick: () => { clearReply(); input.focus(); } }, "✕"));
    replyBox.hidden = false;
    input.placeholder = "Reply…";
    input.focus();
  }
  function clearReply() {
    state.replyTo = null;
    if (!state.composer) return;
    state.composer.replyBox.hidden = true;
    state.composer.replyBox.replaceChildren();
    state.composer.input.placeholder = "Ask Ping: what's due tomorrow?";
  }
  // the original of a quote: scrolled to and flashed; earlier messages are loaded if it's above the window
  async function goToMessage(key) {
    const { inner, thread } = state.composer || {};
    if (!inner) return;
    let el = inner.querySelector(`[data-key="${CSS.escape(key)}"]`);
    for (let i = 0; !el && i < 12; i++) {
      const more = inner.querySelector(".earlier");
      if (!more) break;
      more.click();
      await new Promise((r) => requestAnimationFrame(r));
      el = inner.querySelector(`[data-key="${CSS.escape(key)}"]`);
    }
    if (!el) { toast("That message isn't in the chat any more."); return; }
    jumpTo(thread, el);
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  }
  const REPLY_ICON = () => { const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(ns, "path"); p.setAttribute("d", "M10 8V4L3 11l7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"); svg.append(p); return svg; };
  function wireReplies(thread, inner) {
    // an arrow on every chat bubble (shown on hover / focus on a PC; touch uses swipe and long-press)
    const arm = (root) => root.querySelectorAll?.(".msg[data-key]:not([data-reply])").forEach((m) => {
      const k = m.dataset.key;
      if (!(k.startsWith("item:") || k.startsWith("msg:")) || m.classList.contains("typing")) return;
      m.dataset.reply = "1";
      m.append(h("button", { type: "button", class: "reply-btn", "aria-label": "Reply to this message", title: "Reply",
        onclick: (ev) => { ev.stopPropagation(); startReply(m); } }, REPLY_ICON()));
    });
    arm(inner);
    new MutationObserver((recs) => recs.forEach((r) => r.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches?.(".msg")) arm(n.parentNode || inner); else arm(n); } })))
      .observe(inner, { childList: true, subtree: true });
    inner.addEventListener("contextmenu", (ev) => {
      const m = ev.target.closest(".msg[data-reply]");
      if (!m || ev.target.closest("a, input, textarea") || String(window.getSelection?.() || "")) return;
      ev.preventDefault(); startReply(m);
    });
    // touch: swipe right to reply (not inside something that scrolls sideways), or hold for half a second
    let g = null;
    const sideways = (el) => { for (let n = el; n && n !== inner; n = n.parentElement) if (n.scrollWidth > n.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true; return false; };
    inner.addEventListener("pointerdown", (ev) => {
      const m = ev.target.closest(".msg[data-reply]");
      if (!m || ev.pointerType === "mouse" && ev.button !== 0 || ev.target.closest("button, a, input, summary")) return;
      g = { m, x: ev.clientX, y: ev.clientY, dx: 0, side: sideways(ev.target), swiping: false,
            hold: ev.pointerType === "mouse" ? null : setTimeout(() => { if (g && !g.swiping) { navigator.vibrate?.(10); startReply(m); g = null; } }, 500) };
    });
    inner.addEventListener("pointermove", (ev) => {
      if (!g) return;
      const dx = ev.clientX - g.x, dy = ev.clientY - g.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { clearTimeout(g.hold); g.hold = null; }
      if (g.side || ev.pointerType === "mouse") return;
      if (!g.swiping && dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) g.swiping = true;
      if (g.swiping) { g.dx = Math.max(0, Math.min(dx, 80)); g.m.style.transform = `translateX(${g.dx}px)`; g.m.style.setProperty("--swipe", String(Math.min(1, g.dx / 56))); }
    });
    const end = () => {
      if (!g) return;
      clearTimeout(g.hold);
      const { m, dx, swiping } = g; g = null;
      if (!swiping) return;
      m.style.transform = ""; m.style.removeProperty("--swipe");
      if (dx >= 56) { navigator.vibrate?.(10); startReply(m); }
    };
    inner.addEventListener("pointerup", end);
    inner.addEventListener("pointercancel", end);
  }

  // ---------------------------------------------------------------- re-check on demand
  const recheckWaiters = new Map();
  function onRecheck(row) {
    const w = row?.id && recheckWaiters.get(row.id);
    if (w && ["done", "unreachable", "failed"].includes(row.status)) { recheckWaiters.delete(row.id); w(row); }
  }
  // the row once it's finished (Realtime, with a poll every 4 s in case the socket is down); 4 min at most
  function waitRecheck(id) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (row) => { if (!done) { done = true; clearInterval(poll); clearTimeout(cap); resolve(row); } };
      recheckWaiters.set(id, finish);
      const poll = setInterval(async () => {
        const row = await state.src.recheckRow?.(id).catch(() => null);
        if (row && ["done", "unreachable", "failed"].includes(row.status)) finish(row);
      }, 4000);
      const cap = setTimeout(() => finish({ id, status: "unreachable", note: "the ERP didn't answer within 4 minutes" }), 240000);
    });
  }
  // the newest list notice we know for a company: its file on the ERP (opens in the browser; a link only)
  function listLinkFor(company) {
    const R = window.PingRules, key = (s) => R.shortName(s || "").toLowerCase();
    const n = (state.data?.notices || []).filter((x) => key(x.company) === key(company) && ["shortlist", "test", "test_rooms", "result"].includes(x.kind))
      .sort((a, b) => String(b.notice_time).localeCompare(String(a.notice_time)))[0];
    const it = n ? null : (state.data?.items || []).filter((i) => key(i.company) === key(company) && i.notice_id && i.details?.pdf)
      .sort((a, b) => String(b.details?.notice_time).localeCompare(String(a.details?.notice_time)))[0];
    const id = n?.notice_id || it?.notice_id, year = n?.year || (it?.details?.notice_key || "").split(":")[0];
    return id && year ? `https://erp.iitkgp.ac.in/TrainingPlacementSSO/AdmFilePDF.htm?type=NOTICE&year=${encodeURIComponent(year)}&id=${id}` : null;
  }
  // the demo can't log in to the ERP: it answers from the snapshot, and says so
  function demoRecheck(company) {
    const R = window.PingRules, key = (s) => R.shortName(s || "").toLowerCase();
    const items = (state.data?.items || []).filter((i) => key(i.company) === key(company) && i.notice_id);
    const notices = items.filter((i) => i.details?.pdf || ["shortlist", "test", "test_rooms", "result"].includes(i.details?.kind))
      .map((i) => ({ notice_id: i.notice_id, subject: i.details?.subject, kind: i.details?.kind || i.category, notice_time: i.details?.notice_time,
                     has_attachment: !!i.details?.pdf, file: i.details?.pdf ? { status: i.details.pdf.status, read_at: i.details.pdf.checked_at, details: i.details.pdf.details } : null }));
    return { status: "done", demo: true, company, result: { company, read_at: factsOf(state.data).lastChecked, notices, changes: [] } };
  }
  async function recheckFlow(q, rr, mine, { input, inner, thread, btn }, backQuote = null) {
    const R = window.PingRules;
    const release = () => { state.waiting = false; btn.removeAttribute("aria-busy"); btn.replaceChildren(ICON_SEND()); btn.disabled = !input.value.trim(); };
    state.chat.push(mine);                         // the question is on screen already (send)
    await state.src.addChat(mine).catch(() => {});
    const company = rr.companies[0] || null;
    const name = company ? R.shortName(company) : "";
    const status = h("div", { class: "msg ping run r-active enter", role: "status", "data-recheck": company || "all" },
      h("div", { class: "kicker" }, h("span", { class: "k" }, "Ping"), h("span", { class: "k2" }, "Re-check"), h("span", { class: "spin", "aria-hidden": "true" })),
      h("span", { class: "text title" }, company ? `Checking the ERP for ${name} now…` : "Checking the ERP now…"));
    appendToday(inner, status);
    thread.scrollTop = thread.scrollHeight;
    release();
    let text;
    if (!company) {
      // nothing in the conversation names a company: a full check, then the last question again on the new data
      let started = true;
      try { await state.src.checkNow(); } catch { started = false; }
      state.reask = started ? (rr.previous || null) : null;
      text = started ? `Checking the whole ERP now (about 2 minutes).${rr.previous ? ` I'll answer "${rr.previous}" again with what it finds.` : ""}`
        : `I couldn't start a check just now. Try Check now in a minute.`;
    } else {
      let rc;
      try {
        const out = await state.src.recheck(company, q);
        rc = out.demo ? demoRecheck(company) : { ...(await waitRecheck(out.recheck)), company };
      } catch (e) { rc = { status: "unreachable", company, note: e?.offline ? "you're offline" : plainly(e) }; }
      text = R.recheckAnswer(rc, liveNow(), listLinkFor(company)).text;
      if (rc.demo) text = text.replace(/^I checked the ERP for (.+?) just now \((.*?)\)\./, "Demo: Ping can't log in to the ERP here, so this is the snapshot's reading of $1 ($2).");
      if (rc.status === "done" && !rc.demo) {        // the feed may have changed (a verdict, a new notice): read it again
        state.data.items = withoutHeld(await state.src.items().catch(() => state.data.items)); stampItems(); forgetHistory();
      }
    }
    const reply = { role: "ping", text, created_at: new Date(Math.max(Date.now(), Date.parse(mine.created_at) + 1)).toISOString(), ...(backQuote || {}) };
    state.chat.push(reply);
    const b = textBubble("ping", reply.text, reply.created_at, true, quoteOf(reply));
    b.dataset.answeredBy = "recheck";
    if (status.isConnected) status.replaceWith(b); else route();
    state.src.addChat(reply).catch(() => {});
    applyLive?.();
  }

  async function queueSend(q, input, inner, thread) {
    input.value = "";
    const queue = (await kv.get("queue")) || [];
    queue.push({ text: q, at: new Date().toISOString() });
    await kv.set("queue", queue);
    const at = new Date().toISOString();
    appendToday(inner, h("div", { class: "msg me queued enter" }, h("span", { class: "text" }, q),
      h("div", { class: "foot" }, h("span", { class: "time" }, "waiting for a connection"))));
    if (!inner.querySelector(".offline-note")) {
      appendToday(inner, h("div", { class: "msg ping offline-note enter" }, h("div", { class: "kicker" }, h("span", { class: "k" }, "Ping")),
        h("span", { class: "text" }, "You're offline. I'll ask this as soon as you're back."), h("div", { class: "foot" }, h("span", { class: "time" }, clock(at)))));
    }
    thread.scrollTop = thread.scrollHeight;
  }

  async function loadMarks() {
    if (!state.src?.marks) return;
    try {
      const { prefs, marks, lists } = await state.src.marks();
      if (lists) state.lists = lists;
      state.marks = marks;
      state.marksVersion = (state.marksVersion || 0) + 1;     // the lists split differently: redraw them in place
      state.prefs = prefs;
      Object.assign(state.data.profile, { targets: prefs.targets, reminder_hours: prefs.reminder_hours,
                                          list_other_roles: prefs.list_other_roles });
    } catch { /* keep the lists as the last run built them */ }
  }

  // ------------------------------------------------------------ Today (dashboard/today.js builds it)
  const isMine = (r) => r.eligible !== false && (pinOf(r) ?? (targetsOn() ? !!markOf(r)?.relevant : true));
  function todayModel() {
    return TODAY.build({ items: state.data.items.filter((it) => !it.dismissed && !itemNotForMe(it)), roles: state.data.roles,
      notices: state.data.notices || [], runs: state.data.runs, profile: state.data.profile, now: liveNow(), isMine, inChat,
      split: targetsOn() || hasPins(), listOthers: ({ ...(state.data.profile || {}), ...(state.prefs || {}) }).list_other_roles !== false,
      isFilled: (it) => FORMS.isFilled(state.formStatus, it.details?.form?.key) });
  }
  // a line that asks a question ("Tomorrow: 1 deadline"): tapping it asks Ping in the chat
  function askInChat(text) {
    const go = () => state.composer?.ask?.(text);
    if (location.hash.slice(1) && location.hash !== "#chat") {
      location.hash = "#chat"; setTimeout(go, 60);
    } else go();
  }
  function tomorrowLine(t) {
    // nothing tomorrow: no line at all (never an empty heading or a "nothing" line on Today)
    if (!t.tests && !t.deadlines) return null;
    return h("p", { class: "tomorrow" }, h("button", { type: "button", class: "linklike inline-link",
      onclick: () => askInChat("What's due tomorrow?") }, `${t.text} ›`));
  }
  function todayPanel(m) {
    const now = nowDate();
    const head = h("div", { class: "today-head" }, h("h2", {}, "Today"),
      h("span", { class: "muted small" }, now.toLocaleDateString("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "short" })));
    // a row, by the card rule: what and who on line 1, the deadline in relative words on line 2, the names (or the
    // role and room) on line 3; internal notes ("per a notice (00:02)", "posted 12:34", "31 others") stay in the sheet
    const row = (r) => {
      const status = [r.filledAll ? h("span", { class: "pill applied" }, "✓ filled") : null,
        r.status === "on" ? h("span", { class: "pill you" }, "you're on the list")
        : r.status === "off" ? h("span", { class: "pill plain" }, "check the list") : null].filter(Boolean);
      const done = r.done || r.filledAll, due = r.due || (r.dueAt ? new Date(r.dueAt).toISOString() : null);
      const what = r.kind === "test" ? String(r.title).replace(/ (test|interview)$/i, (m, w) => ` · ${w[0].toUpperCase()}${w.slice(1)}`)
        : r.kind === "todo" && !r.group ? `${r.title} · ${r.forms ? "Form" : /submi|cv/i.test(r.sub || "") ? "CV submission" : /test/i.test(r.sub || "") ? "Test" : "To do"}`
        : String(r.title).replace(/ to apply by \d\d:\d\d$/, " to apply").replace(/ due \d\d:\d\d$/, (m) => (r.forms || /form/.test(r.title) ? " to fill" : ""))
            .replace(/ (by|until) \d\d:\d\d$/, "").replace(/ · submit (your )?CVs?$/i, " · CV submission");
      const rel = r.kind === "more" ? null : done ? { text: "✓ done", level: "done" } : due ? relOf(due, r.kind === "test") : null;
      const l3 = r.kind === "test" ? String(r.sub || "").split(" · ").filter((x) => !/^\d\d:\d\d$/.test(x)).join(" · ")
        // a to-do's line 3 is its role only: the task is on line 1 and the time on line 2 ("fill the form by Tue 24 Nov
        // 23:59." says both again)
        : r.kind === "todo" && !r.group ? ((r.sub || "").match(/\(([^)]+)\)/) || [])[1] || ""
        : r.names || "";
      const body = [h("span", { class: "t-title" }, what, status),
                    rel ? h("span", { class: `t-sub cc-l2 lv-${rel.level}`, ...(rel.level !== "over" && rel.level !== "done" && due ? { "data-rel": dt(due).toISOString(), "data-event": r.kind === "test" ? "1" : null } : {}) }, rel.text) : null,
                    l3 ? h("span", { class: "t-names" }, l3) : null];
      // every row opens the sheet with everything in it ("5 forms due 20:00": one card per form)
      return h("button", { type: "button", class: `today-row k-${r.kind}${r.group ? " group" : ""}${r.over ? " over" : ""}`,
        "aria-haspopup": r.kind === "more" ? null : "dialog", onclick: () => openRowSheet(r) },
        h("span", { class: "t-ico", "aria-hidden": "true" }), h("span", { class: "t-body" }, body),
        r.kind === "more" ? null : h("span", { class: "t-caret", "aria-hidden": "true" }, "›"));
    };
    // "Done today: 11 applied ✓ · 2 forms filled ✓": one collapsed line, the done rows inside
    const doneLine = () => m.doneLine ? h("details", { class: "today-done" }, h("summary", {}, m.doneLine),
      h("div", { class: "today-list" }, m.done.map(row))) : null;
    // "+19 more notices today": not something to act on, so a quiet link at the bottom, not a row
    const more = m.rows.find((r) => r.kind === "more");
    const moreLink = more ? h("p", { class: "today-more" }, h("a", { href: "#feed", class: "muted small" },
      `${more.title.replace(/^\+/, "")} in All updates ›`)) : null;
    const rows = m.rows.filter((r) => r.kind !== "more");
    if (m.empty) return h("div", { class: "today" }, head, h("p", { class: "today-empty" }, m.emptyText), doneLine(), tomorrowLine(m.tomorrow), moreLink);
    return h("div", { class: "today" }, head, h("div", { class: "today-list" }, rows.map(row)), doneLine(), tomorrowLine(m.tomorrow), moreLink);
  }
  // a tap on Today: the chat message it came from, else the role, the notice or the company
  function goTo(t) {
    if (!t) return;
    if (t.item) {
      const show = () => {
        let n = document.querySelector(`[data-key="${CSS.escape(`item:${t.item}`)}"]`);
        if (!n && !state.showAll && $("#thread")) { state.showAll = true; route(); n = document.querySelector(`[data-key="${CSS.escape(`item:${t.item}`)}"]`); }
        const thread = $("#thread");
        if (!n || !thread) return;
        jumpTo(thread, n);
        n.classList.remove("hl"); void n.offsetWidth; n.classList.add("hl");
      };
      if ((location.hash || "#chat") !== "#chat") { location.hash = "#chat"; setTimeout(show, 80); } else show();
      return;
    }
    if (t.role) { const r = state.data.roles.find((x) => x.id === t.role); if (r) openRole(r); return; }
    if (t.notice) return openNotice(t.notice);
    if (t.company) { location.hash = companyHref(t.company); return; }
    if (t.feed) { location.hash = "#feed"; return; }
    if (t.companies) location.hash = "#companies";
  }
  function renderToday() {
    if (!state.data || !TODAY) return;
    profileDot();
    formsBadge();
    const m = todayModel();
    const badge = $("#nav-today");
    // the badge: what's left to do today (roles for you not applied, forms not ticked, tests ahead), the same numbers
    // as the rows
    if (badge) { badge.textContent = String(m.left); badge.hidden = !m.left;
      badge.parentElement.setAttribute("aria-label", m.left ? `Today, ${m.left} left to do` : "Today"); }
    const rail = $("#today-rail");
    if (rail) rail.replaceChildren(todayPanel(m));
    const page = $("#today-page");
    if (page) page.replaceChildren(todayPanel(m));
  }
  function viewToday() {
    mountPage(h("div", { id: "today-page" }));
    renderToday();
  }

  // ------------------------------------------------------------ all updates (list with the three level filters)
  const itemDue = (it) => it.due_at || it.event_at;
  function sortNewest(a, b) { return String(itemTime(b) || "").localeCompare(String(itemTime(a) || "")); }

  function viewFeed() {
    if (!state.history && state.src?.history) { const at = location.hash; ensureHistory().then(() => { if (location.hash === at) viewFeed(); }); }
    const items = knownItems().filter((i) => !i.dismissed);
    const counts = { always: 0, show: 0, hidden: 0 };
    items.forEach((i) => { counts[i.level] = (counts[i.level] || 0) + 1; });
    const filters = [["visible", "For you", counts.always + counts.show], ["always", LEVELS.always, counts.always],
                     ["show", LEVELS.show, counts.show], ["hidden", LEVELS.hidden, counts.hidden]];
    const shown = items.filter((i) => state.filter === "visible" ? i.level !== "hidden" : i.level === state.filter).sort(sortNewest);
    mountPage(
      h("p", { class: "page-links" }, h("a", { href: "#profile" }, "← Profile")),
      h("h1", {}, "All updates"),
      h("p", { class: "muted small" }, "Newest first. “You applied” is anything about a role you applied to; " +
        "“Open for you” is roles you can still apply to; “Hidden” is kept but not about you (or already past)."),
      h("div", { class: "chips filters", role: "group", "aria-label": "Show" }, filters.map(([key, label, n]) =>
        h("button", { type: "button", class: "chip", "aria-pressed": String(state.filter === key), onclick: () => { state.filter = key; viewFeed(); } },
          label, h("span", { class: "n" }, n)))),
      shown.length ? h("div", { class: "list" }, shown.map(itemCard)) : h("p", { class: "muted" }, "Nothing here right now."));
  }

  // All updates: the same compact card (who and what, when, one button); the rest behind ⋯
  function itemCard(it) {
    const due = itemDue(it), d = it.details || {};
    const cls = it.needs_review ? "review" : it.level;
    const c = itemCardOf(it);
    const link = d.todo?.link || mailLinks(it)[0];
    const card = cardC({
      key: `feed:${it.id}`, cls: `item ${cls}${it.done ? " done" : ""}`, company: c.company || cleanName(it.company || "") || "Placement office",
      task: it.needs_review ? "Question" : c.word || KIND_WORD[c.kind] || CARDS.typeLabel(it), at: due || undefined, event: !!it.event_at && !it.due_at,
      status: it.done ? h("span", { class: "pill applied" }, "✓ done") : null,
      l3: c.roleName || (due ? "" : (d.candidates || []).reduce((t, x) => t.split(x).join(shortCo(x)), String(it.title || "").replace(/^[^:]{2,60}:\s*/, ""))),
      primary: link ? h("a", { class: "act-btn primary", href: link, ...EXT }, /forms\.gle|docs\.google\.com\/forms|\/forms\//i.test(link) || d.todo?.link ? "Open form"
        : /meet\.google|zoom\.us|teams\.microsoft|webex|\/interview\//i.test(link) ? "Join" : /hackerrank|hackerearth|mettl|codility|test|assess/i.test(link) ? "Open test" : "Open link") : null,
      detail: () => [
        ccRow("Message", it.title),
        ccRow("Shown as", it.needs_review ? "Question" : LEVELS[it.level]),
        due ? ccRow(it.due_at ? "Due" : "When", when(due)) : null,
        d.via === "email" ? ccRow("From", d.source ? d.source.replace(/^mail from /, "Mail from ") : "Your placement mail") : d.mail?.note ? ccRow("Also", d.mail.note) : null,
        ccLinks(it.company ? h("a", { class: "act-btn", href: companyHref(it.company) }, "Company") : null,
          it.notice_id ? noticeButtons([it.notice_id]) : null,
          it.notice_id && it.pdf_status ? Object.assign(pdfLink(it), { className: "act-btn" }) : null,
          ...mailLinks(it).slice(link === mailLinks(it)[0] ? 1 : 0).map((u) => h("a", { class: "act-btn", href: u, ...EXT }, "Link from your mail")),
          it.level !== "hidden" ? h("button", { type: "button", class: "act-btn", onclick: () => toggleDone(it) }, it.done ? "Undo done" : "Mark done") : null),
      ],
    });
    if (it.needs_review && it.level !== "hidden") {
      card.append(h("div", { class: "onb-actions choose" }, "It's about:",
        (d.candidates || []).map((x) => h("button", { type: "button", class: "chip", onclick: () => fix(it, { company: x }) }, shortCo(x))),
        h("button", { type: "button", class: "chip", onclick: () => fix(it, { ignore: true }) }, "None of these")));
    }
    return card;
  }

  function mailLinks(it) {
    const d = it.details || {};
    const links = d.mail_links?.length ? d.mail_links : it.category === "email" || d.via === "email" ? d.links || [] : [];
    return links.filter((u) => u !== d.todo?.link).slice(0, 2);
  }

  function pdfLink(it) {
    const year = it.details?.notice_year;
    const href = year ? `https://erp.iitkgp.ac.in/TrainingPlacementSSO/AdmFilePDF.htm?type=NOTICE&year=${encodeURIComponent(year)}&id=${it.notice_id}`
                      : "https://erp.iitkgp.ac.in/";
    return h("a", { href, target: "_blank", rel: "noopener", title: "Opens on the ERP; you need to be logged in to the ERP in this browser" },
      `PDF (${it.pdf_status === "yes" ? "you're in it" : it.pdf_status === "no" ? "not in it" : "unread"})`);
  }

  async function toggleDone(it) {
    it.done = !it.done;
    try { await state.src.markItem(it.id, { done: it.done }); } catch (e) { status(`Couldn't save that. ${plainly(e)}`); }
    route();
  }

  async function fix(it, f) {
    try {
      await state.src.correct(it.details?.notice_key, f);
      const demo = state.src.kind === "demo" || state.src.demo;
      status(demo ? "Noted for this demo session (nothing is saved)." : "Saved. The next run will use your answer.");
      if (!demo) it.level = "hidden";
      else if (it.needs_review) { it.needs_review = false; it.title = f.ignore ? "Marked not relevant." : `Noted: it's about ${f.company}.`; }
    } catch (e) { status(`Couldn't save that. ${plainly(e)}`); }
    route();
  }

  async function openNotice(noticeId) {
    const body = $("#modal-body");
    body.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    $("#modal").showModal();
    let res;
    try { res = await state.src.notice(noticeId); } catch (e) { body.replaceChildren(h("p", {}, `Couldn't open the notice. ${plainly(e)}`)); return; }
    const n = res.notice;
    if (!n) { body.replaceChildren(h("p", {}, "This notice isn't stored.")); return; }
    const c = res.check;
    const a = n.analysis || {};
    body.replaceChildren(
      h("h2", {}, `${n.subject} · ${n.company}`),
      h("p", { class: "muted small" }, `Posted ${when(n.notice_time)} · notice ${n.notice_id}`),
      h("pre", { class: "notice" }, n.text || n.preview || ""),
      c ? h("div", { class: "card" },
        h("strong", {}, c.status === "yes" ? `You're in the attachment (matched by ${c.matched_by})` :
                         c.status === "no" ? "I couldn't find your roll number in the attachment. Please check it yourself."
                         : "I couldn't read the attachment reliably. Check it yourself."),
        c.checked_at ? h("p", { class: "muted small" }, `File read ${when(c.checked_at)}${c.format ? ` · ${String(c.format).toUpperCase()}${c.pages ? `, ${c.pages} page${c.pages === 1 ? "" : "s"}` : ""}` : ""}`) : null,
        c.my_row ? h("div", { class: "table-wrap" }, h("table", {},
          c.header ? h("tr", {}, c.header.map((x) => h("th", {}, x))) : null,
          h("tr", {}, c.my_row.map((x) => h("td", {}, x))))) : null,
        c.error ? h("p", { class: "muted small" }, c.error) : null) : null,
      n.has_attachment ? h("p", {}, h("a", { target: "_blank", rel: "noopener",
        href: `https://erp.iitkgp.ac.in/TrainingPlacementSSO/AdmFilePDF.htm?type=NOTICE&year=${encodeURIComponent(n.year)}&id=${n.notice_id}` },
        "Open the PDF on the ERP"), h("span", { class: "muted small" }, " (works when you're logged in to the ERP in this browser)")) : null,
      (a.contacts || []).length ? h("p", { class: "small" }, "Contacts: ", a.contacts.map((x) => `${x.name} ${x.phone}`).join(", ")) : null,
      (a.deadlines || []).length ? h("p", { class: "small muted" }, "Dates found: ", a.deadlines.map((d) => `${when(d.at)} (“${d.text}”)`).join("; ")) : null);
  }

  // ------------------------------------------------------------ companies
  function byCompany() {
    const map = new Map();
    for (const r of state.data.roles) {
      if (!map.has(r.company)) map.set(r.company, []);
      map.get(r.company).push(r);
    }
    return map;
  }
  const deadlineOf = (r) => r.effective_deadline || r.apply_end;

  // the "For you" mark of a role: the current marks (targets said in the chat) or the last run's
  // what you said in the chat ("X not relevant", "show Y again") wins over Ping's own marks
  const listsNow = () => state.lists || state.data?.profile || {};
  const pinOf = (r) => window.PingRules?.pinned ? window.PingRules.pinned(r, listsNow()) : null;
  const hasPins = () => { const L = listsNow(); return ["not_interested_companies", "interested_companies", "hidden_roles", "shown_roles"].some((k) => (L[k] || []).length); };
  const markOf = (r) => {
    const pin = pinOf(r);
    if (pin !== null) return { relevant: pin, reason: pin ? "You said it's for you" : "You hid it from For you" };
    return (state.marks?.size ? state.marks.get(r.id) : r.relevance) || null;
  };
  const targetsOn = () => {
    const p = { ...(state.data.profile || {}), ...(state.prefs || {}) };
    return !!p.targets && p.feed_mode !== "all";
  };
  const isOpen = (r) => { const d = dt(deadlineOf(r)); return !!d && d > nowDate(); };
  const forYou = (r) => r.eligible !== false && isOpen(r) && !r.applied && (pinOf(r) ?? (targetsOn() ? !!markOf(r)?.relevant : true));
  const closingSoon = (r) => !r.applied && r.eligible !== false && isOpen(r) && dt(deadlineOf(r)) - nowDate() < 48 * 3600000;
  const FILTERS = [["for_you", "For you", forYou], ["applied", "Applied", (r) => !!r.applied], ["soon", "Closing soon", closingSoon],
                   ["all", "All", () => true]];
  function ctcShort(r) {
    const n = Number(r.ctc);
    if (!n) return "CTC —";
    if ((r.currency || "INR") !== "INR") return money(n, r.currency);
    return n >= 1e7 ? `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr` : `₹${(n / 1e5).toFixed(1).replace(/\.0$/, "")} L`;
  }
  const bestCv = (r) => { const m = markOf(r); return m?.relevant && m.best_cv ? m.best_cv : null; };

  // the companies you're on a shortlist / test list of (from the lists Ping read), for the one status chip
  function shortlistedSet() {
    const key = knownItems();
    if (state.slCache?.src === state.data.items && state.slCache?.hist === state.history) return state.slCache.set;
    const set = new Set(key.filter((it) => (it.category === "shortlist" || it.category === "test" || ["shortlist", "test", "test_rooms"].includes(it.details?.kind))
      && (it.details?.pdf?.status || it.pdf_status) === "yes").map((it) => cleanName(it.company).toLowerCase()));
    state.slCache = { src: state.data.items, hist: state.history, set };
    return set;
  }
  // a role: the company and one status chip, the role, the next deadline; pay, criteria and the JD are one tap away
  function roleRow(r) {
    const dl = deadlineOf(r), open = isOpen(r);
    const cls = r.applied ? "applied" : targetsOn() && forYou(r) ? "you" : closingSoon(r) ? "soon" : "plain";
    const chip = shortlistedSet().has(cleanName(r.company).toLowerCase()) ? ["you", "Shortlisted"] : r.applied ? ["applied", "Applied"]
      : !open && dl ? ["over", "Closed"] : r.eligible === false ? ["no", "Not eligible"] : ["plain", "Eligible"];
    const rel = dl ? relOf(dl) : null;
    return h("button", { type: "button", class: `role-row r-${cls}`, "data-role": r.id, onclick: () => openRole(r),
      "aria-label": `${cleanName(r.company)}, ${r.designation}, ${chip[1]}. Details` },
      h("span", { class: "co" }, shortCo(r.company)),
      h("span", { class: `pill ${chip[0]} rr-chip` }, chip[1]),
      h("span", { class: "rn" }, withoutCo(r.designation, cleanName(r.company))),
      h("span", { class: `meta cc-l2${rel ? ` lv-${rel.level}` : ""}`, ...(rel && open ? { "data-rel": dt(dl).toISOString() } : {}) },
        rel ? (open ? rel.text : rel.text.replace(/ · past due$/, " · closed")) : "No deadline yet"));
  }

  function sortRoles(list, key) {
    const t = (r) => +dt(deadlineOf(r)) || 0;
    if (key === "applied") return list.sort((a, b) => t(b) - t(a));
    if (key === "all") return list.sort((a, b) => (isOpen(b) - isOpen(a)) || (isOpen(a) ? t(a) - t(b) : t(b) - t(a)));
    return list.sort((a, b) => t(a) - t(b));
  }

  function viewCompanies() {
    const roles = state.data.roles;
    if (!state.roleFilter) state.roleFilter = roles.some(forYou) ? "for_you" : "all";
    const input = h("input", { class: "search", id: "company-search", type: "search", placeholder: "Search a company or role",
      "aria-label": "Search companies and roles", value: state.companyQuery, oninput: (e) => { state.companyQuery = e.target.value; state.roleLimit = 60; draw(); } });
    const chips = h("div", { class: "chips filters", role: "group", "aria-label": "Show" });
    const out = h("div", { class: "roles", id: "roles", "aria-live": "polite" });
    const count = h("p", { class: "lede", id: "roles-count" });
    function draw() {
      const q = state.companyQuery.trim().toLowerCase();
      const match = (r) => !q || `${r.company} ${cleanName(r.company)} ${r.designation}`.toLowerCase().includes(q);
      chips.replaceChildren(...FILTERS.map(([key, label, fn]) => h("button", { type: "button", class: "chip", "data-filter": key,
        "aria-pressed": String(state.roleFilter === key), onclick: () => { state.roleFilter = key; state.roleLimit = 60; draw(); } },
        label, h("span", { class: "n" }, roles.filter((r) => match(r) && fn(r)).length))));
      const fn = FILTERS.find(([k]) => k === state.roleFilter)[2];
      const shown = sortRoles(roles.filter((r) => match(r) && fn(r)), state.roleFilter);
      const limit = state.roleLimit || 60;
      count.textContent = `${shown.length} role${shown.length === 1 ? "" : "s"} · ${new Set(shown.map((r) => r.company)).size} companies`;
      out.replaceChildren(...(shown.length ? shown.slice(0, limit).map(roleRow)
        : [h("p", { class: "empty" }, q ? `No roles match “${state.companyQuery}”. ` : "Nothing here right now. ",
            // the way out, right there: clear the search / show every role
            h("button", { type: "button", class: "linklike", onclick: () => {
              if (q) { state.companyQuery = ""; const box = $("#company-search"); if (box) box.value = ""; }
              else state.roleFilter = "all";
              draw();
            } }, q ? "Clear the search" : "Show all roles"))]),
        shown.length > limit ? h("button", { type: "button", class: "btn ghost", onclick: () => { state.roleLimit = limit + 100; draw(); } },
          `Show ${Math.min(100, shown.length - limit)} more`) : null);
    }
    draw();
    const search = h("div", { class: "search-row" }, svgIcon("M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM21 21l-5-5"), input);
    mountPage(h("h1", {}, "Companies"),
      h("p", { class: "lede" }, `Every role on the ERP's companies list (${roles.length}). Tap one for pay, criteria and the JD.`),
      search, chips, count, out,
      h("p", { class: "page-links" }, h("a", { href: "#feed" }, "All updates, newest first")));
  }

  function svgIcon(d) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p);
    return s;
  }

  // ------------------------------------------------------------ the detail sheet behind Today rows and lists
  // One place to act from: a Today row, a digest's "Show N more" and an Ask Ping answer that lists roles all open
  // this sheet, one card per company/role with what it is, when, where you stand, and links. Links only (Ping stays
  // read-only); the ERP and forms open in the browser, never inside the app; a link Ping doesn't know isn't shown.
  // Phones: full screen with a back arrow (the phone's own back closes it too); desktop: a side panel.
  const EXT = { target: "_blank", rel: "noopener noreferrer" };
  const myRoll = () => (state.src?.kind === "demo" || state.data?.profile?.is_sample ? null : state.data?.profile?.roll || null);
  const KIND_WORD = { application: "Application", form: "Form", submission: "CV submission", test: "Test", interview: "Interview",
                      shortlist: "Shortlist", notice: "Notice", "to-do": "To do" };
  const roleIn = (t) => (String(t || "").match(/\(([^)]+)\)/) || [])[1] || "";
  function roleCard(r, extra = {}) {
    const m = markOf(r), due = deadlineOf(r);
    return { role: r, company: cleanName(r.company), roleName: r.designation, due, at: due ? +dt(due) : 0, kind: "application",
             applied: !!r.applied, mine: pinOf(r) ?? (targetsOn() ? !!m?.relevant : null), reason: m?.relevant ? m.reason || "" : "",
             cv: m?.relevant ? m.best_cv || "" : "", forms: [], noticeId: null, pdf: null, chat: null, ...extra };
  }
  function itemCardOf(it) {
    const d = it.details || {};
    const role = (it.role_ids || []).map((id) => roleById().get(id)).find(Boolean) || null;
    const st = d.pdf?.status || it.pdf_status || null;
    const kind = it.category === "test" || ["test", "test_rooms", "interview"].includes(d.kind) ? (d.kind === "interview" ? "interview" : "test")
      : it.category === "shortlist" || d.kind === "shortlist" ? "shortlist"
      : /fill the form/i.test(it.title || "") || d.todo?.action === "fill_form" ? "form"
      : /submi/i.test(`${it.title} ${d.subject || ""}`) ? "submission" : it.category === "todo" ? "to-do" : "notice";
    const row = d.pdf?.details || {}, m = role ? markOf(role) : null, due = it.due_at || it.event_at;
    // the word on the card: what the to-do is (an assignment is not a CV submission: 25 Nov, RISA Labs "submit the
    // assignment" read "CV submission" because any "submi..." meant a CV), else the type
    const word = ["submission", "to-do", "notice"].includes(kind) ? CARDS.typeLabel(it) : KIND_WORD[kind];
    return { item: it, role, company: cleanName(it.company), roleName: role?.designation || roleIn(it.title), due, at: due ? +dt(due) : 0, kind, word,
             applied: role ? !!role.applied : null, list: st === "yes" ? "on" : st === "no" ? "off" : null, done: !!it.done,
             mine: role && targetsOn() ? !!m?.relevant : null, reason: m?.relevant ? m.reason || "" : "", cv: m?.relevant ? m.best_cv || "" : "",
             place: [row.room ? `Room ${row.room}` : "", row.slot ? `Slot ${row.slot}` : "", !row.room && d.venue ? d.venue : ""].filter(Boolean).join(" · "),
             myRow: d.pdf?.my_row ? (d.pdf.header ? d.pdf.header.map((x, i) => `${x}: ${d.pdf.my_row[i] ?? ""}`) : d.pdf.my_row).join(" · ") : "",
             forms: TODAY.formLinks(it), noticeId: it.notice_id || null, pdf: it.notice_id && st ? it : null, chat: inChat(it) ? it.id : null,
             formKey: d.form?.key || null };
  }
  function sheetCard(c) {
    const status = c.done ? h("span", { class: "pill applied" }, "✓ done")
      : c.list === "on" ? h("span", { class: "pill you" }, "on the list")
      : c.applied === true ? h("span", { class: "pill applied" }, "✓ applied") : null;
    const erp = c.role || c.kind === "application" ? TODAY.erpLink(c.role || { company: c.company }, myRoll()) : null;
    const event = ["test", "interview", "notice", "shortlist"].includes(c.kind);
    const form = c.forms[0];
    const primary = form && !c.applied ? h("a", { class: "act-btn primary", href: form, ...EXT, "data-link": "form" }, "Open form")
      : erp && !c.applied ? h("a", { class: "act-btn primary", href: erp.href, ...EXT, "data-link": "erp",
          title: erp.direct ? "The role's page on the ERP, in your browser" : `On the ERP: CDC › Application of Placement/Internship, search “${erp.search}”` }, "Apply on ERP")
      : c.list === "off" && c.pdf ? Object.assign(pdfLink(c.pdf), { className: "act-btn primary", textContent: "Open list" }) : null;
    // line 3: the role, then what you need to act (the CV to apply with, your room)
    const l3 = [c.roleName, c.place, c.cv && !c.applied ? `Apply with ${c.cv}` : ""].filter(Boolean).join(" · ");
    // a Today to-do: "Not for me" (its form, or the item itself when it has no form)
    const nfmKey = c.formKey || (c.item && !c.role && !["test", "interview", "notice", "shortlist"].includes(c.kind) ? `item:${c.item.id}` : null);
    const nfm = (menu) => nfmKey ? h("button", { type: "button", class: `act-btn${menu ? "" : " ghost nfm-btn"}`,
      onclick: () => { setNotForMe(nfmKey, true, { label: `${c.company || "this"} ${String(c.word || KIND_WORD[c.kind] || "to-do").toLowerCase()}` }); closeSheet(); } }, "Not for me") : null;
    return cardC({
      key: `sheet:${c.kind}:${c.role?.id || c.item?.id || c.company}`, cls: `act-card${c.mine === false && !c.applied ? " other" : ""}`,
      attrs: { "data-kind": c.kind }, lead: c.formKey ? formTick(c.formKey) : null,
      company: c.company || "Notice", task: c.word || KIND_WORD[c.kind] || c.kind, at: c.due || null, event, status, l3, primary, tail: nfm(false),
      detail: () => [
        nfmKey ? h("div", { class: "ac-links cc-links nfm-menu" }, nfm(true)) : null,
        c.roleName ? ccRow("Role", c.roleName) : null,
        c.due ? ccRow(event ? "When" : "Due", when(c.due)) : null,
        c.applied === false ? ccRow("Status", "Not applied") : null,
        c.list === "off" ? ccRow("List", "Roll not found: check the list yourself") : null,
        c.mine != null ? ccRow("Fit", [c.mine ? "For you" : "Other", c.reason].filter(Boolean).join(" · ")) : null,
        c.cv ? ccRow("Apply with", c.cv) : null,
        c.place ? ccRow("Where", c.place) : null,
        c.myRow ? ccRow("Your row", c.myRow) : null,
        c.text ? h("p", { class: "cc-note" }, c.text) : null,
        c.item?.title ? ccRow("Message", c.item.title) : null,
        ccLinks(
          erp && (form || c.applied) ? h("a", { class: "act-btn", href: erp.href, ...EXT, "data-link": "erp" }, "Open on ERP") : null,
          ...c.forms.slice(form && !c.applied ? 1 : 0).map((u, k) => h("a", { class: "act-btn", href: u, ...EXT, "data-link": "form" }, c.forms.length > 1 ? `Form link ${k + (form && !c.applied ? 2 : 1)}` : "Form link")),
          c.pdf && c.list !== "off" ? Object.assign(pdfLink(c.pdf), { className: "act-btn" }) : null,
          c.noticeId ? noticeButtons([c.noticeId]) : null,
          c.chat ? h("button", { type: "button", class: "act-btn", "data-link": "chat", onclick: () => { closeSheet(); goTo({ item: c.chat }); } }, "Show in chat") : null),
      ],
    });
  }
  // open and close: the phone's back gesture closes the sheet (a history entry while it's open)
  function showSheet(sheet) {
    if (!sheet.dataset.wired) {
      sheet.dataset.wired = "1";
      sheet.addEventListener("click", (ev) => { if (ev.target === sheet) sheet.close(); });   // a tap on the backdrop
      sheet.addEventListener("close", () => { if (history.state?.pingSheet) { state.sheetPopping = true; history.back(); } });
      window.addEventListener("popstate", () => {
        if (state.sheetPopping) { state.sheetPopping = false; return; }
        if (sheet.open) { history.replaceState(null, ""); sheet.close(); }
      });
    }
    if (!sheet.open) { if (!history.state?.pingSheet) history.pushState({ pingSheet: 1 }, ""); sheet.showModal(); }
    sheet.scrollTop = 0;
  }
  const closeSheet = () => { const s = $("#sheet"); if (s?.open) s.close(); };
  function openActSheet({ title, sub = "", cards, filters = false, note = "" }) {
    if (state.details && !state.detailsIn) {           // the demo's JD and pay details: fetched after the first paint
      state.startDetails?.();
      state.details.then(() => { state.detailsIn = true; openActSheet({ title, sub, cards, filters, note }); });
      return;
    }
    const sheet = $("#sheet");
    let filter = filters ? "notapplied" : "all";         // what's left to do first; applied roles only under All
    const body = h("div", { class: "sheet-body act-body" });
    const chip = (key, label) => h("button", { type: "button", class: "chip", "aria-pressed": String(filter === key), "data-filter": key,
      onclick: () => { filter = key; draw(); } }, label, h("span", { class: "n" }, TODAY.filterCards(cards, key).length));
    const draw = () => {
      const { top, others } = TODAY.orderCards(filters ? TODAY.filterCards(cards, filter) : cards);
      body.replaceChildren(...[
        filters ? h("div", { class: "chips filters", role: "group", "aria-label": "Show" },
          chip("notapplied", "Not applied"), chip("foryou", "For you"), chip("all", "All")) : null,
        top.length ? h("div", { class: "act-list" }, top.map(sheetCard)) : null,
        others.length ? h("details", { class: "act-others" }, h("summary", {}, `Others (${others.length})`),
          h("div", { class: "act-list" }, others.map(sheetCard))) : null,
        !top.length && !others.length ? h("p", { class: "muted" }, "Nothing here with this filter.") : null,
        h("p", { class: "muted small act-note" }, note || (myRoll()
          ? "“Open on ERP” opens the role's page in your browser; sign in to the ERP there if it asks. Ping only reads the ERP: you apply there."
          : "“Open on ERP” opens the ERP in your browser: CDC › Application of Placement/Internship, then search for the company. Ping only reads the ERP: you apply there.")),
      ].filter(Boolean));
    };
    const close = h("button", { type: "button", class: "close", "aria-label": "Close", onclick: () => sheet.close() }, "×");
    const back = h("button", { type: "button", class: "back", "aria-label": "Back", onclick: () => sheet.close() }, "←");
    sheet.classList.add("act");
    sheet.replaceChildren(
      h("div", { class: "sheet-head" }, back, h("div", { class: "act-titles" }, h("h2", { id: "sheet-title", class: "co" }, title),
        sub ? h("div", { class: "rn small" }, sub) : null), close), body);
    draw();
    showSheet(sheet);
    (matchMedia("(max-width: 899px)").matches ? back : close).focus();
  }
  // what each Today row opens
  function openRowSheet(r) {
    const items = (r.itemIds || []).map((id) => itemById().get(id)).filter(Boolean);
    if (r.kind === "deadline") {
      const roles = (r.roleIds || []).map((id) => roleById().get(id)).filter(Boolean);
      const cards = roles.map((x) => roleCard(x, { chat: r.digestId }));
      const t = TODAY.sheetTitle({ cards, at: r.at, now: liveNow() });
      return openActSheet({ title: t.title, sub: t.sub, cards, filters: true });
    }
    if (r.kind === "todo" && r.forms) {                 // forms: the Forms list at that deadline
      state.formsAt = r.at; state.formsOnly = "all"; state.formsQuery = "";
      location.hash = "#forms";
      return;
    }
    if (r.kind === "todo" || r.kind === "test") {
      const cards = items.map(itemCardOf);
      const done = cards.filter((c) => c.done).length;
      return openActSheet({ title: r.title, sub: [r.group ? clock(r.due) : r.sub, done ? `${done} done` : ""].filter(Boolean).join(" · "), cards,
        filters: cards.length > 3 });
    }
    if (r.kind === "notice") {
      const n = (state.data.notices || []).find((x) => (x.notice_id ?? x.id) === r.noticeId) || {};
      const it = items[0] || null;
      const base = it ? itemCardOf(it) : { company: cleanName(n.company), kind: "notice", forms: [], noticeId: r.noticeId };
      const names = r.companies || [];
      const roles = names.length ? state.data.roles.filter((x) => names.some((nm) => cleanName(x.company).toLowerCase().startsWith(nm.toLowerCase())
        || nm.toLowerCase().startsWith(cleanName(x.company).toLowerCase())) && (x.applied || isOpen(x))) : [];
      const cards = roles.length ? roles.map((x) => roleCard(x, { kind: "application", forms: base.forms, noticeId: r.noticeId, chat: base.chat || null }))
        : [{ ...base, text: base.kind === "notice" ? (n.preview || "").slice(0, 220) : "", noticeId: r.noticeId }];
      return openActSheet({ title: r.title, sub: [r.sub, r.names].filter(Boolean).join(" · "), cards, filters: roles.length > 3 });
    }
    return goTo(r.target);
  }
  // the roles an Ask Ping answer lists ("- Company — Role (apply with …)"), to open them in the sheet
  const norm = (s) => cleanName(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
  function rolesIn(text) {
    if (!state.data?.roles?.length) return [];
    const out = [];
    for (const line of String(text || "").split("\n")) {
      const m = line.match(/^\s*[-•]\s*(.+?)\s+—\s+(.+?)(?:\s+\(apply with[^)]*\)|\s+✓ applied)?\s*$/);
      if (!m) continue;
      const co = norm(m[1]), rn = m[2].trim().toLowerCase();
      const r = state.data.roles.find((x) => String(x.designation || "").trim().toLowerCase() === rn
        && (norm(x.company).startsWith(co) || co.startsWith(norm(x.company))));
      if (r && !out.includes(r)) out.push(r);
    }
    return out;
  }
  function rolesButton(text) {
    const roles = rolesIn(text);
    if (roles.length < 2) return null;
    return h("button", { type: "button", class: "linklike open-roles", onclick: (ev) => { ev.stopPropagation();
      openActSheet({ title: `${roles.length} roles from this answer`, sub: [`${roles.filter((x) => !x.applied && targetsOn() && markOf(x)?.relevant).length} for you`,
        `${roles.filter((x) => x.applied).length} applied`].join(" · "), cards: roles.map((x) => roleCard(x)), filters: true }); } },
      `Open these ${roles.length} roles`);
  }

  // the role sheet: everything Ping knows about one role (a bottom sheet on phones, a side panel on desktop)
  function openRole(r) {
    if (state.details && !state.detailsIn) {           // the demo's JD and pay details: fetched after the first paint
      state.startDetails?.();
      state.details.then(() => { state.detailsIn = true; openRole(r); });
      return;
    }
    const sheet = $("#sheet");
    const kv = (rows) => { rows = rows.filter(([, v]) => v != null && v !== "" && v !== false);
      return rows.length ? h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])) : null; };
    const sec = (title, ...body) => { const b = body.flat().filter(Boolean); return b.length ? h("section", {}, h("h3", {}, title), b) : null; };
    const f = Object.fromEntries(Object.entries(r.more_details?.fields || {}).map(([k, v]) => [k, typeof v === "string" ? tidyText(v) : v]));
    const pay = Object.entries(f).filter(([k, v]) => v && /ctc|salary|gross|base|stipend|bonus|esop|joining|relocation|bond|variable|retention/i.test(k)
      && String(v).length < 400);
    const e = r.eligibility || {}, mk = markOf(r), dl = deadlineOf(r);
    const updates = knownItems().filter((i) => i.company === r.company && !i.dismissed).sort(sortNewest).slice(0, 8);
    const depts = new Set((r.allowed || []).map((a) => a.department));
    const close = h("button", { type: "button", class: "close", "aria-label": "Close", onclick: () => sheet.close() }, "×");
    sheet.replaceChildren(
      h("div", { class: "sheet-head" }, h("div", {}, h("h2", { id: "sheet-title", class: "co" }, cleanName(r.company)),
        h("div", { class: "rn" }, r.designation)), close),
      h("div", { class: "sheet-body" },
        h("div", { class: "chips wrap", style: "padding:0" },
          r.applied ? h("span", { class: "pill applied" }, "✓ applied") : null,
          targetsOn() && mk?.relevant ? h("span", { class: "pill you" }, "For you") : null,
          dl && isOpen(r) && !r.applied ? countPill(dl, "soon") : null,
          r.eligible === true ? h("span", { class: "pill you" }, "Eligible") : r.eligible === false ? h("span", { class: "pill no" }, "Not eligible")
            : h("span", { class: "pill over" }, "Eligibility not sure")),
        sec("Why it's for you", mk?.relevant && mk.reason ? h("p", { style: "margin:0" }, mk.reason) : null,
          bestCv(r) ? h("p", { style: "margin:0" }, "Apply with ", h("strong", {}, bestCv(r))) : null),
        jdSection(r, kv, sec),
        sec("Pay", kv([["CTC", money(r.ctc, r.currency)], ...pay.map(([k, v]) => [k, /^\d+(\.\d+)?$/.test(String(v)) ? money(v, r.currency) : String(v)])])),
        sec("Eligibility", kv([
          ["You", r.eligible === true ? "Eligible" : r.eligible === false ? "Not eligible" : "Not sure"],
          ["Why", [...(e.reasons || []), ...(e.flags || [])].join("; ")],
          ["CGPA", r.cgpa_cutoff ? `≥ ${r.cgpa_cutoff}` : "No cut-off"],
          ["Backlogs", r.backlog_rule ? r.backlog_rule.replace(/\.+$/, "") : ""],
          ["Departments", depts.size ? `${depts.size} allowed` : ""],
          ["Written test", r.has_written_test === true ? "Yes" : r.has_written_test === false ? "No" : ""]])),
        sec("Deadlines", kv([
          ["Applications open", when(r.apply_start)],
          ["Closes", when(dl) || "Not announced"],
          ["Where that date is from", r.deadline_source || "companies list"],
          ["ERP's own close time", r.effective_deadline && r.apply_end && +dt(r.effective_deadline) !== +dt(r.apply_end) ? when(r.apply_end) : ""],
          ["Interview", r.interview_date || ""]])),
        sec("Notices and lists", updates.length ? h("div", { class: "list" }, updates.map((i) =>
          h("div", { class: "small" }, h("span", { class: "muted num" }, shortTime(itemTime(i)) + " · "), i.title,
            i.pdf_status === "yes" ? h("span", { class: "pill you", style: "margin-left:6px" }, "you're on it") : null,
            i.notice_id ? [" ", h("button", { type: "button", class: "linklike", onclick: () => openNotice(i.notice_id) }, "Open notice")] : null)))
          : h("p", { class: "muted small", style: "margin:0" }, "No notices about this company yet.")),
        null,
        sec("Source", h("p", { class: "muted small", style: "margin:0" },
          `The ERP's companies list${r.last_seen ? `, last read ${when(r.last_seen)}` : ""}. Ping only reads the ERP: apply there. `),
          h("a", { href: companyHref(r.company), onclick: () => sheet.close() }, `All roles at ${cleanName(r.company)}`))));
    sheet.classList.remove("act");
    showSheet(sheet);
    close.focus();
  }

  // ERP / PDF text as fonts can draw it: Windows-1252 bullets and quotes, Symbol/Wingdings bullets (U+F0B7...), boxes
  // and arrows used as bullets become "•"; zero-width marks go (the same as ping/jd.py glyphs(), for text stored
  // before that clean-up and for the role's other fields)
  const C1 = { "\x95": "•", "\x96": "–", "\x97": "—", "\x91": "'", "\x92": "'", "\x93": '"', "\x94": '"', "\x85": "…" };
  const BULLETISH = "[\\ue000-\\uf8ff\\u25a0-\\u25ff\\u2794-\\u27bf\\u2219\\u2023\\u2043\\u2b9a-\\u2b9f\\u2713\\u2714\\u2756]";
  function tidyText(t) {
    return String(t || "").replace(/[\x80-\x9f]/g, (c) => C1[c] || "").replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/g, "")
      .replace(/\u00a0/g, " ").replace(new RegExp(`(^|\\n)[ \\t]*${BULLETISH}+[ \\t]*`, "g"), "$1• ")
      .replace(new RegExp(`[ \\t]*${BULLETISH}+[ \\t]*(?=\\S)`, "g"), " • ").replace(new RegExp(BULLETISH, "g"), "").replace(/\ufffd/g, "");
  }
  // the JD: Ping's short summary of it (roles.jd_summary), the full text behind "Full JD", and where it came from
  function jdSection(r, kv, sec) {
    const s = r.jd_summary, text = tidyText(r.jd_text || r.job_description || "");
    const one = (v) => (Array.isArray(v) ? v.filter(Boolean).join("; ") : v ? String(v) : "");
    const linkShut = r.jd_source === "link-unreadable" || (r.jd_source === "detail" && r.jd_url);
    const from = { attachment: "the JD file on the ERP", link: "the JD link", detail: "the ERP's role details", inline: "the ERP's job description",
                   notice: r.jd_note || "a notice's PDF", mail: r.jd_note || "placement mail" }[r.jd_source];
    const srcLink = r.jd_url ? h("a", { href: r.jd_url, target: "_blank", rel: "noopener",
      title: ["attachment", "notice"].includes(r.jd_source) ? "Opens on the ERP; you need to be logged in to the ERP in this browser" : null },
      r.jd_source === "attachment" ? "Open the JD file on the ERP" : r.jd_source === "notice" ? "Open the PDF on the ERP"
        : linkShut ? "The full JD link (Ping couldn't open it)" : "Open the JD link") : null;
    const body = [];
    if (r.jd_source === "link-unreadable") {
      body.push(h("p", { style: "margin:0" }, "The JD is a link Ping can't open (private or gone). "), srcLink);
    } else if (s) {
      const team = one(s.role_team);
      if (team && team.toLowerCase() !== String(r.designation || "").toLowerCase()) body.push(h("p", { style: "margin:0", class: "jd-role" }, team));
      if ((s.do || []).length) body.push(h("ul", { class: "jd-list" }, s.do.map((x) => h("li", {}, x))));
      body.push(kv([["Must-have", (s.must_have || []).join("; ")], ["Location", one(s.location)],
                    ["Eligibility", one(s.eligibility) || (r.cgpa_cutoff ? `CG cut-off ${r.cgpa_cutoff} (ERP)` : "")],
                    ["Unusual", (s.unusual || []).join("; ")]]));
    } else if (!text.trim() || r.jd_source === "none") {
      body.push(h("p", { class: "muted small", style: "margin:0" }, `No JD on the ERP${r.jd_note ? ` (${r.jd_note})` : ""}.`));
    }
    if (text.trim() && r.jd_source !== "link-unreadable") {
      body.push(h("details", { class: "jd-full" }, h("summary", { class: "linklike" }, "Full JD"),
        h("pre", { class: "notice" }, text.slice(0, 20000))));
    }
    if (from || srcLink) body.push(h("p", { class: "muted small", style: "margin:0" }, from ? `From ${from}. ` : "", r.jd_source !== "link-unreadable" ? srcLink : null));
    return sec("Job description", body);
  }

  function viewCompany(name) {
    const roles = sortRoles([...(byCompany().get(name) || [])], "all");
    // a company's whole history: the page draws again once it's read (the first time only)
    if (!state.history && state.src?.history) { const at = location.hash; ensureHistory().then(() => { if (location.hash === at) route(); }); }
    const items = knownItems().filter((i) => i.company === name && i.level !== "hidden").sort(sortNewest);
    mountPage(
      h("p", { class: "page-links" }, h("a", { href: "#companies" }, "← Companies")),
      h("h1", {}, name ? cleanName(name) : "Not found"),
      h("p", { class: "lede" }, `${roles.length} role${roles.length === 1 ? "" : "s"}. Tap one for pay, eligibility and deadlines.`),
      roles.length ? h("div", { class: "roles" }, roles.map(roleRow)) : h("p", { class: "empty" }, "No roles for this company in the companies list."),
      h("h2", {}, "Updates"),
      items.length ? h("div", { class: "list" }, items.map(itemCard)) : h("p", { class: "muted" }, "Nothing current."));
  }

  // ------------------------------------------------------------ profile
  // Cards (About you · What I'm looking for · CVs · Schedule & reminders · Account), each read at a glance and
  // edited in place with its own Save. The same fields the onboarding and the chat set.
  function profileValues() {
    const p = { ...(state.data.profile || {}) };
    if (state.src.demo) for (const [k, v] of Object.entries(state.sessionPrefs || {})) if (DEMO_OWN.includes(k) && v != null) p[k] = v;
    if (state.prefs) for (const k of ["targets", "reminder_hours", "list_other_roles"]) if (state.prefs[k] !== undefined) p[k] = state.prefs[k];
    return p;
  }
  const everyText = (m) => (Number(m) === 30 ? "Every 30 minutes" : Number(m) === 120 ? "Every 2 hours" : "Every hour");

  // a card on Profile, scrolled to and flashed ("Profile › My CVs" in a message opens it there)
  function focusCard(key) {
    requestAnimationFrame(() => {
      const el = document.getElementById(`pc-${key}`);
      if (!el) return;
      el.scrollIntoView({ block: "start", behavior: motion() });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    });
  }

  function viewProfile() {
    const p = profileValues();
    const demo = !!state.src.demo || state.src.kind === "demo";
    const depts = new Set(), degrees = new Set();
    state.data.roles.forEach((r) => (r.allowed || []).forEach((a) => { depts.add(a.department); degrees.add(a.degree); }));
    const field = (name, label, value, attrs = {}, hint) => h("label", {}, label, hint ? h("span", { class: "hint" }, hint) : null,
      h("input", { name, id: `pf-${name}`, value: value ?? "", ...attrs }));
    const lists = (v) => (v || []).join("\n");
    const kv = (rows) => h("dl", { class: "kv summary" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v == null || v === "" ? "—" : v)]));

    // one card: summary, or (after Edit) its form; Save writes only this card's fields
    function card(key, title, summary, formKids, toPatch, opts = {}) {
      const editing = state.editCard === key;
      const msg = h("span", { class: "saved", role: "status" }, state.cardMsg?.[key] || "");
      const head = h("div", { class: "pcard-head" }, h("h2", { id: `pc-${key}-h` }, title),
        !editing && formKids && !opts.locked ? h("button", { type: "button", class: "btn ghost small", id: `edit-${key}`,
          "aria-label": `Edit ${title}`, onclick: () => { state.editCard = key; viewProfile(); $(`#pc-${key} input, #pc-${key} textarea, #pc-${key} select`)?.focus(); } }, "Edit") : null);
      let body;
      if (editing) {
        const form = h("form", { onsubmit: async (ev) => {
          ev.preventDefault();
          const patch = toPatch(new FormData(form));
          msg.textContent = "Saving…";
          try {
            const before = profileValues().targets || "";
            const note = await state.src.saveProfile(patch);
            if (!state.src.demo) Object.assign(state.data.profile, patch);
            let said = note || (state.src.kind === "demo" ? "Saved for this visit (demo)." : "Saved. Applies on the next check.");
            // new targets: have the roles marked now (the same path as saying it in the chat), then split the lists
            if ("targets" in patch && state.src.fn && (patch.targets || "") !== before && patch.targets) {
              msg.textContent = "Saved. Marking roles…";
              const out = await state.src.fn("ask-ping", { question: `my targets are ${patch.targets}` }).catch((e) => ({ answer: `Saved. Marking the roles didn't work just now (${plainly(e).replace(/\.$/, "").toLowerCase()}); the next check marks them.` }));
              said = out.answer || said;
            }
            if (state.src.fn) await loadMarks();
            state.cardMsg = { [key]: said };
            state.editCard = null;
            viewProfile();
            $(`#edit-${key}`)?.focus();
          } catch (err) { msg.textContent = err.message; }
        } }, formKids, h("div", { class: "actions" }, h("button", { class: "btn" }, "Save"),
          h("button", { type: "button", class: "btn ghost", onclick: () => { state.editCard = null; viewProfile(); } }, "Cancel"), msg));
        body = form;
      } else body = [summary, msg.textContent ? msg : null];
      return h("section", { class: "card pcard", id: `pc-${key}`, "aria-labelledby": `pc-${key}-h` }, head, opts.note ? h("p", { class: "hint", style: "margin:0" }, opts.note) : null, body);
    }

    const about = card("about", "About you",
      // the roll number masked on the page ("22XY•••42"); the edit form shows it in full
      kv([["Roll number", p.roll ? String(p.roll).replace(/^(.{4}).+(.{2})$/, "$1•••$2") : "Your ERP user id"], ["Name", p.name], ["Degree", p.degree], ["Department", p.department],
          ["CGPA", p.cgpa], ["Active backlogs", p.active_backlogs ? "Yes" : "No"]]),
      [h("div", { class: "row2" },
        field("roll", "Roll number", p.roll, {}, "Leave empty to use your ERP user id"),
        field("name", "Name", p.name, { autocomplete: "name" }, "Only used when a PDF has names but no roll numbers")),
       h("div", { class: "row2" },
        field("degree", "Degree", p.degree, { list: "dl-degrees" }),
        field("department", "Department", p.department, { list: "dl-depts" }, "As the ERP writes it")),
       h("div", { class: "row2" },
        field("cgpa", "CGPA", p.cgpa, { type: "number", step: "0.01", min: "0", max: "10", inputmode: "decimal" }),
        h("label", { class: "check" }, h("input", { type: "checkbox", name: "active_backlogs", id: "pf-backlogs", checked: !!p.active_backlogs }), "I have active backlogs")),
       h("datalist", { id: "dl-depts" }, [...depts].sort().map((d) => h("option", { value: d }))),
       h("datalist", { id: "dl-degrees" }, [...degrees].sort().map((d) => h("option", { value: d })))],
      (f) => { const cgpa = String(f.get("cgpa") || "").trim(); const t = (k) => String(f.get(k) || "").trim() || null;
        return { roll: t("roll"), name: t("name"), department: t("department"), degree: t("degree"), cgpa: cgpa ? Number(cgpa) : null,
                 active_backlogs: f.get("active_backlogs") === "on" }; },
      { locked: demo, note: demo ? "The demo student's details are made up and fixed." : "Used to decide what you're eligible for." });

    const split = (f, k) => String(f.get(k) || "").split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    const looking = card("looking", "What I'm looking for",
      kv([["Feed", p.feed_mode === "all" ? "Everything from the ERP" : "Only what fits me first"],
          ["Targets", p.targets || "Not set: every role is listed the same way"],
          ["Other roles", p.list_other_roles === false ? "Not listed" : "Listed separately, collapsed"],
          ...(demo ? [] : [["Interested", (p.interested_companies || []).join(", ")], ["Not interested", (p.not_interested_companies || []).join(", ")]])]),
      [h("fieldset", { class: "seg" }, h("legend", {}, "Feed"),
        h("label", { class: "check" }, h("input", { type: "radio", name: "feed_mode", value: "personal", checked: p.feed_mode !== "all" }), "Only what fits me first"),
        h("label", { class: "check" }, h("input", { type: "radio", name: "feed_mode", value: "all", checked: p.feed_mode === "all" }), "Everything from the ERP")),
       h("label", {}, "Targets", h("span", { class: "hint" }, "In your own words. Ping marks each role \"For you\" or not and lists those first."),
        h("textarea", { name: "targets", id: "pf-targets", rows: 3, placeholder: "The kinds of roles you want, and any you don't" }, p.targets || "")),
       h("label", { class: "check" }, h("input", { type: "checkbox", name: "list_other_roles", id: "pf-list-others", checked: p.list_other_roles !== false }),
        "List the other roles separately so I don't miss anything"),
       demo ? null : h("div", { class: "row2" },
        h("label", {}, "Interested companies", h("span", { class: "hint" }, "One per line"),
          h("textarea", { name: "interested_companies", id: "pf-interested", rows: 4 }, lists(p.interested_companies))),
        h("label", {}, "Not interested", h("span", { class: "hint" }, "One per line. Their roles are hidden."),
          h("textarea", { name: "not_interested_companies", id: "pf-not-interested", rows: 4 }, lists(p.not_interested_companies))))],
      (f) => ({ feed_mode: f.get("feed_mode") === "all" ? "all" : "personal", targets: String(f.get("targets") || "").trim() || null,
                list_other_roles: f.get("list_other_roles") === "on",
                ...(demo ? {} : { interested_companies: split(f, "interested_companies"), not_interested_companies: split(f, "not_interested_companies") }) }),
      { note: "You can also just tell Ping in the chat: \"only show me finance roles\", \"also include data roles\"." });

    const cvs = h("section", { class: "card pcard", id: "pc-cvs", "aria-labelledby": "pc-cvs-h" },
      h("div", { class: "pcard-head" }, h("h2", { id: "pc-cvs-h" }, "My CVs")), cvBlock(p));

    const sched = card("schedule", "Schedule & reminders",
      kv([["Checks the ERP", everyText(p.check_every_minutes)], ["Between", `${p.check_from || "06:00"} and ${p.check_to || "01:00"} IST`],
          ["Reminders", Number(p.reminder_hours ?? 2) === 24 ? "The day before" : `${p.reminder_hours ?? 2} h before a deadline`]]),
      [h("label", {}, "How often", h("select", { name: "check_every_minutes", id: "pf-every" },
          [[30, "Every 30 minutes"], [60, "Every hour"], [120, "Every 2 hours"]].map(([v, t]) =>
            h("option", { value: v, selected: Number(p.check_every_minutes ?? 60) === v }, t)))),
       h("div", { class: "row2" },
        field("check_from", "From (IST)", p.check_from || "06:00", { type: "time" }),
        field("check_to", "To (IST)", p.check_to || "01:00", { type: "time" }, "Past midnight is fine, e.g. 06:00 to 01:00")),
       field("reminder_hours", "Remind me before a deadline (hours)", p.reminder_hours ?? 2,
         { type: "number", step: "0.5", min: "0.5", max: "48", inputmode: "decimal" }, "One reminder per deadline, listing what you haven't applied to")],
      (f) => ({ check_every_minutes: Number(f.get("check_every_minutes")) || 60, check_from: String(f.get("check_from") || "06:00").slice(0, 5),
                check_to: String(f.get("check_to") || "01:00").slice(0, 5),
                reminder_hours: Number(f.get("reminder_hours")) > 0 ? Number(f.get("reminder_hours")) : 2 }),
      { note: demo ? "In the demo these are saved for your session only; nothing runs on a schedule for it." : "Or say it in the chat: \"check every 30 minutes\"." });

    const run = (state.data.runs || [])[0];
    const themeChips = h("div", { class: "chips wrap", role: "group", "aria-label": "Theme", style: "padding:0" },
      [["system", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([t, l]) => h("button", { type: "button", class: "chip", "data-theme-choice": t,
        "aria-pressed": String(themeNow() === t), onclick: () => { setTheme(t); viewProfile(); } }, l)));
    const checkBtn = h("button", { type: "button", class: "btn ghost", id: "account-check", "data-check-now": true,
      onclick: () => checkNow() }, h("span", { class: "check-label" }, "Check now"));
    const account = h("section", { class: "card pcard", id: "pc-account", "aria-labelledby": "pc-account-h" },
      h("div", { class: "pcard-head" }, h("h2", { id: "pc-account-h" }, "Account")),
      kv([["Signed in as", demo ? "Demo visitor (anonymous, read-only)" : "The owner"], ["Last check", run ? when(run.finished_at || run.started_at) : "Not yet"]]),
      h("div", { class: "actions" }, checkBtn, h("a", { class: "btn ghost", href: "#feed" }, "All updates"),
        state.exit ? h("button", { type: "button", class: "btn ghost", id: "sign-out", onclick: () => state.exit.run() }, state.exit.label) : null),
      h("div", {}, h("div", { class: "hint", style: "margin-bottom:4px" }, "Theme"), themeChips));

    mountPage(h("h1", {}, "Profile"), h("p", { class: "lede" },
      "Whether you applied comes from the ERP's companies list, not from here. Ping only reads the ERP."),
      // grouped: you, your alerts, the app
      h("h2", { class: "pgroup" }, "You"), h("div", { class: "pcards" }, about, looking, cvs),
      h("h2", { class: "pgroup" }, "Checks and alerts"), h("div", { class: "pcards" }, sched, pushCard(demo)),
      h("h2", { class: "pgroup" }, "App and account"), h("div", { class: "pcards" }, installCard(), account));
    updateCheckButtons();
  }

  // "My CVs": up to 3 PDFs with labels, in the private "cvs" bucket (owner only; never in git; demo sessions can't
  // reach it). The hourly run summarises a new or replaced file once; only the summary is kept in the profile.
  function cvBlock(p) {
    const cvs = (p.cvs || []).slice(0, 3);
    const demo = !!state.src?.demo || state.src?.kind === "demo";
    const status = h("span", { class: "muted small", id: "cv-status" });
    const slot = (i) => {
      const c = cvs[i] || {};
      const label = h("input", { id: `cv-label-${i}`, value: c.label || "", placeholder: `CV ${i + 1} label`, "aria-label": `CV ${i + 1} label`, disabled: demo });
      const file = h("input", { type: "file", accept: "application/pdf", id: `cv-file-${i}`, "aria-label": `CV ${i + 1} PDF`, disabled: demo });
      const upload = h("button", { type: "button", class: "btn small", disabled: demo, onclick: async () => {
        const f = file.files?.[0];
        const name = label.value.trim();
        if (!name) { status.textContent = " Give the CV a label first."; return; }
        try {
          const next = [...cvs];
          if (f) {
            if (f.type !== "application/pdf" || f.size > 5 * 1024 * 1024) { status.textContent = " A PDF up to 5 MB, please."; return; }
            const path = `cv${i + 1}.pdf`;
            const { error } = await state.src.sb.storage.from("cvs").upload(path, f, { upsert: true, contentType: "application/pdf" });
            if (error) throw new Error(error.message);
            next[i] = { label: name, path, uploaded_at: new Date().toISOString() };      // a new file: summarised again
          } else if (c.path) {
            next[i] = { ...c, label: name };                                            // only the label changed
          } else { status.textContent = " Choose a PDF."; return; }
          await state.src.saveProfile({ cvs: next.filter(Boolean), cv_names: next.filter(Boolean).map((x) => x.label) });
          p.cvs = next.filter(Boolean);
          status.replaceChildren(" Saved. Ping reads it on the next check and then says which CV to apply with. ",
            h("button", { type: "button", class: "linklike", "data-check-now": true, onclick: () => checkNow() }, "Check now"));
        } catch (e) { status.textContent = ` Couldn't upload it. ${plainly(e)}`; }
      } }, c.path ? "Replace" : "Upload");
      return h("div", { class: "cv-slot" }, label, demo ? null : file, demo ? null : upload,
        // what Ping read from it: one tap away (it's long)
        c.summary ? h("details", { class: "cv-sum small muted" }, h("summary", {}, "What Ping read from it"), h("div", {}, c.summary))
          : c.path ? h("div", { class: "small muted" }, "Not read yet") : null);
    };
    return h("div", { class: "cvs" },
      h("p", { class: "hint", style: "margin:0" }, demo ? " Made-up CVs of the demo student (summaries only; the demo can't upload)."
        : " Up to 3 PDFs. Private: only your login can read them; Ping keeps a short summary to pick the CV for each role."),
      [0, 1, 2].map(slot), status);
  }

  // ------------------------------------------------------------ answers without AI
  // Used in the offline ?demo=1 copy and whenever the ask-ping function can't be reached. The same rules the
  // function uses when Gemini is busy (supabase/functions/_shared/answer_rules.js, loaded as window.PingRules):
  // a company in the question gets an answer about that company only; otherwise what was asked about.
  const thisPlatform = () => window.PingRules?.platformOf(navigator.userAgent, navigator.maxTouchPoints) || "other";
  // "how do I install?", "help": answered here from docs/HELP.md (help.js), for this device, with no server call
  function helpHere(question) {
    const R = window.PingRules;
    if (!R?.helpTopic(question)) return null;
    const data = state.data || {};
    const r = R.route(question, [], { now: nowDate(), roles: data.roles || [], items: [], notices: [] });
    return r.kind === "help" ? R.routed(r, question, { platform: thisPlatform(), installed: standalone() }).text : null;
  }
  // the same data shape the ask-ping function builds (factsData), from what the page has loaded
  function factsOf(data) {
    const run = (data.runs || [])[0] || {};
    return {
      now: nowDate(),
      lastChecked: run.finished_at || run.started_at || data.generated_at || null,
      profile: data.profile || {}, prefs: { listOthers: (state.prefs || data.profile || {}).list_other_roles !== false },
      roles: (data.roles || []).map((r) => {
        const m = state.marks?.size ? state.marks.get(r.id) : r.relevance;
        return { ...r, deadline: r.effective_deadline || r.apply_end, for_you: targetsOn() ? !!m?.relevant : undefined,
                 cv: m?.relevant ? m.best_cv : null, pay: r.more_details?.fields || {}, jd_location: r.jd_summary?.location || null };
      }),
      items: (data === state.data ? knownItems() : data.items || []).filter((i) => !i.dismissed).map((i) => ({ ...i, hidden_because: i.details?.hidden_because,
        subject: i.details?.subject, venue: i.details?.venue, pdf: i.details?.pdf, kind: i.details?.kind, notice_time: i.details?.notice_time,
        via: i.details?.via, mail: i.details?.mail, todo: i.details?.todo })),
      notices: data.notices || [],
      // the other sources a fact can be in (the demo has them; the signed-in page asks the function, which reads them)
      pdf_checks: (data.pdf_checks || []).map((c) => ({ notice_id: c.notice_id, status: c.status, context: c.status === "jd" ? c.context : null })),
      emails: data.emails || [], forms: data.forms || [],
      // never the same answer twice in a row
      lastAnswer: [...(state.chat || [])].reverse().find((m) => m.role !== "me")?.text || null,
      platform: thisPlatform(), installed: standalone(),
    };
  }
  // the page has every source for a fact (notice text and files, mail, form pages) only in the demo; otherwise a
  // question about a field or a source goes to the function, which reads them all
  const hasSources = (data) => !!(data && (data.notices || []).some((n) => n.text) && data.emails && data.forms && data.pdf_checks);
  const SOURCE_INTENTS = ["jd", "pay", "eligible", "location", "notice", "mail"];
  const previousQuestions = (question) => state.chat.filter((m) => m.role === "me" && m.text !== question).map((m) => m.text).reverse().slice(0, 4);
  function answerLocally(question, data) {
    const R = window.PingRules;
    if (!R) return "I can't answer that right now. Try again in a minute.";
    const facts = factsOf(data);
    return R.routed(R.route(question, previousQuestions(question), facts), question, facts).text;
  }

  // FACT questions are answered here, from the data this page already has, in a few milliseconds; only OPEN ones
  // (and preference changes, which the function saves) go to the ask-ping function. If a check has finished since
  // the page loaded its messages, or the "For you" marks aren't in yet, the function answers (its data is current).
  const lastRunId = () => LIVE.lastFinished(state.data?.runs || [])?.id ?? null;
  function stampItems() { state.itemsRun = lastRunId(); }
  const MODEL_WINDOW_MIN = 0;
  function localFact(question) {
    const R = window.PingRules;
    if (!R || !state.data) return { why: "no rules" };
    if (R.prefsLike(question)) return { why: "preferences" };
    if (!LIVE.messagesCurrent(state.data.runs, state.itemsRun)) return { why: "stale" };
    // without the whole history the page would answer from part of it: Ask Ping's function answers instead
    if (state.src?.history && !state.history) return { why: "history not read" };
    if (targetsOn() && !state.marks?.size && !state.data.roles.some((r) => r.relevance)) return { why: "no marks" };
    const facts = factsOf(state.data);
    // Ping's last reply: a follow-up that points back at it ("4 roles?", "the US ones", "which of those did I apply
    // to") goes to the function, where the model reads it with that reply and the facts behind it
    const last = [...(state.chat || [])].reverse().find((m) => m.role !== "me" && m.text);
    facts.lastAnswer = last?.text || null;
    if (last && R.refersBack?.(question, { text: last.text, at: last.created_at }, facts)) return { why: "refers back" };
    // within a few minutes of a Ping reply, every question goes to the function (the model reads it with the
    // conversation): off unless MODEL_WINDOW_MIN is set (docs/DECISIONS.md: the latency and accuracy it costs)
    if (last && MODEL_WINDOW_MIN && Date.now() - Date.parse(last.created_at) < MODEL_WINDOW_MIN * 60000) return { why: "conversation" };
    const r = R.route(question, previousQuestions(question), facts);
    if (r.kind === "open") return { why: "open" };
    if (!hasSources(state.data) && ((r.spec?.intents || []).some((i) => SOURCE_INTENTS.includes(i)) || R.sourcesOf(question).length))
      return { why: "needs every source" };
    const out = R.routed(r, question, facts);
    // the same answer as last time: never sent from here; the function narrows it (or asks one short question)
    if (out.repeat) return { why: "repeat" };
    // "elig?", "jd of the supply chain one" that the rules can't tie to a company: the function reads it with the
    // model first (it knows the conversation), instead of an instant "Which company?"
    if (R.unresolved?.(question, r, out, facts)) return { why: "unresolved" };
    return { text: out.text, kind: r.kind };
  }

  boot().catch((e) => mountPage(h("div", { class: "card" }, h("h1", {}, "Something went wrong"), h("p", {}, `${plainly(e)} Reloading the page usually fixes it.`))));
})();
