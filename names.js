/* Company names for display. The ERP sometimes puts the company's website in brackets ("Auro Group(www.AuroIM.com)");
 * on screen that part goes and double spaces go. Display only: the raw ERP name stays in the data (links, search and
 * Ask Ping use it). Tested in tests/js/names.test.js. */
(function (root) {
  "use strict";
  const URLISH = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|io|ai|co|org|net|tech|app|dev|gg|me)\b/i;
  function cleanName(name) {
    const raw = String(name == null ? "" : name);
    let s = raw, prev;
    do {
      prev = s;
      s = s.replace(/\[([^\]]*)\]\(([^()]*)\)/g, (m, t, u) => (URLISH.test(t + u) ? t : m))   // [text](url)
           .replace(/\s*\(([^()]*)\)/g, (m, inner) => (URLISH.test(inner) ? "" : m));          // (www.x.com)
    } while (s !== prev);
    s = s.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
    // "(legal name: Elixar Systems Pvt Ltd)", "(formerly …)": not part of the name on screen
    s = s.replace(/\s*\((legal name|formerly|earlier|a subsidiary|subsidiary)[^)]*\)/gi, "").trim();
    // never "Private Limited" / "Pvt Ltd" / "Limited" on screen
    for (let i = 0; i < 2; i++) s = s.replace(/[\s,]+(private\s+limited|pvt\.?\s*ltd\.?|pvt\.?|limited|ltd\.?|llp|inc\.?|corporation|corp\.?)\s*$/i, "").trim();
    return s || raw.trim();
  }
  // in a list of names on one line: the name without a generic last word ("Intellimation.ai Software" ->
  // "Intellimation.ai", "Waterfly Technologies" -> "Waterfly")
  function shortName(name) {
    const s = displayName(name);
    const t = s.replace(/\s+(software|technologies|technology|solutions|services|systems|india|global|labs? pvt)\s*$/i, "").trim();
    return t.includes(" ") || t.length >= 4 ? t : s;
  }
  // "Intellimation.ai, Auro +2 more": at most two names on a line
  function namesLine(names, n = 2) {
    const list = [...new Set((names || []).map(shortName).filter(Boolean))];
    return list.length <= n ? list.join(", ") : `${list.slice(0, n).join(", ")} +${list.length - n} more`;
  }
  // "Company — Role" rows inside messages: the company part, cleaned the same way
  function cleanRowText(text) {
    const t = String(text == null ? "" : text), i = t.indexOf(" — ");
    return i > 0 ? cleanName(t.slice(0, i)) + t.slice(i) : cleanName(t);
  }
  // on screen, a shouted multi-word name in title case, its short acronyms kept ("FUTURES FIRST" -> "Futures First",
  // "TATA AIG" -> "Tata AIG"); a one-word name stays as the ERP writes it ("AIRAMATRIX", "BLUESTONE")
  const ACRONYMS = new Set("ICICI HDFC IDFC HSBC HPCL BPCL IOCL ONGC NTPC BHEL GAIL SAIL KPMG NVIDIA EXL BNY UBS DBS ITC TVS JSW EY".split(" "));
  function displayName(name) {
    const s = cleanName(name), words = s.split(" ");
    if (words.length < 2 || s !== s.toUpperCase() || !/[A-Z]{4,}/.test(s)) return s;
    return words.map((w) => (w.length <= 3 || /\d/.test(w) || ACRONYMS.has(w.replace(/[^A-Z]/g, "")) ? w : w[0] + w.slice(1).toLowerCase())).join(" ");
  }
  const api = { cleanName, cleanRowText, displayName, shortName, namesLine };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PingNames = api;
})(typeof window !== "undefined" ? window : globalThis);
