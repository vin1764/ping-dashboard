# Ping dashboard (built files)

Ping is a personal tool for IIT Kharagpur placement season: it reads the student's own placement ERP
pages and notices once an hour, keeps only what concerns that student, and shows it as a chat with Ping.
It only reads; it never applies, submits or changes anything.

This repository holds **only the built static dashboard** (HTML, JavaScript, CSS and the anonymised demo
data). It is published automatically on GitHub Pages; the source code, settings and data live elsewhere and
are private. Nothing here is meant to be edited by hand: every deploy replaces all files.

- `index.html`, `app.js`, `style.css`: the dashboard
- `config.js`: the public address and publishable key of the dashboard's database (the browser needs them;
  database rules decide what each signed-in user may read)
- `demo-data.json`: an anonymised snapshot for the demo (`?demo=1`): real companies, roles, pay and deadlines;
  a made-up student; other students' details, contacts and all mail removed

Open the demo: add `?demo=1` to the page address.
