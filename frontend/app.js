const API = window.API_BASE;

// ---------- Token storage (wrapped: storage can be blocked) ----------
const TOKEN_KEY = "journal_token";
function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return memToken; }
}
let memToken = null;
function setToken(t) {
  memToken = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
  } catch (e) {}
}

// ---------- API helper ----------
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = "Bearer " + token;

  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: "Cannot reach the server. Is the backend running?" } };
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  return { ok: res.ok, status: res.status, data };
}

// ---------- View switching ----------
const authView = document.getElementById("auth-view");
const journalView = document.getElementById("journal-view");

function showAuth() {
  journalView.hidden = true;
  authView.hidden = false;
}
function showJournal() {
  authView.hidden = true;
  journalView.hidden = false;
  loadJournal();
}

// ---------- Auth ----------
const loginBox = document.getElementById("login-box");
const signupBox = document.getElementById("signup-box");

document.getElementById("show-signup").onclick = () => {
  loginBox.hidden = true;
  signupBox.hidden = false;
};
document.getElementById("show-login").onclick = () => {
  signupBox.hidden = true;
  loginBox.hidden = false;
};

async function login(email, password, errorEl) {
  const { ok, data } = await api("/login", { method: "POST", body: { email, password } });
  if (ok) {
    setToken(data.token);
    showJournal();
  } else {
    errorEl.textContent = data.error || "Login failed";
  }
}

document.getElementById("login-form").onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  await login(
    document.getElementById("login-email").value,
    document.getElementById("login-password").value,
    errorEl
  );
};

document.getElementById("signup-form").onsubmit = async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("signup-error");
  errorEl.textContent = "";

  const email = document.getElementById("signup-email").value;
  const password = document.getElementById("signup-password").value;

  const { ok, data } = await api("/users", {
    method: "POST",
    body: {
      name: document.getElementById("signup-name").value,
      email,
      password,
      year: parseInt(document.getElementById("signup-year").value, 10),
    },
  });

  if (!ok) {
    errorEl.textContent = data.error || "Signup failed";
    return;
  }
  await login(email, password, errorEl); // account created: log in straight away
};

document.getElementById("logout").onclick = () => {
  setToken(null);
  showAuth();
};

// ---------- How each kind of item is drawn ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent keeps it XSS-safe
  return node;
}

function formatDate(value) {
  const d = new Date(value);
  return isNaN(d)
    ? String(value)
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Only allow http(s) links so a bad value can't run script
function safeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch (e) {
    return null;
  }
}

// emails_by_clubs row: { c_name, heading, sender_add, mail_link, sent_at }
function emailItem(row) {
  const item = el("div", "item");
  const title = el("h4");
  const href = row.mail_link ? safeUrl(row.mail_link) : null;
  if (href) {
    const a = el("a", "", row.heading || "(no subject)");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    title.appendChild(a);
  } else {
    title.textContent = row.heading || "(no subject)";
  }
  item.appendChild(title);

  const meta = [];
  if (row.sent_at) meta.push(formatDate(row.sent_at));
  if (row.sender_add) meta.push(row.sender_add);
  if (meta.length) item.appendChild(el("div", "meta", meta.join(" | ")));
  return item;
}

// v_notices row: { details, a_name }
function noticeItem(row) {
  const item = el("div", "item");
  item.appendChild(el("p", "", row.details || ""));
  if (row.a_name) item.appendChild(el("div", "meta", "Posted by " + row.a_name));
  return item;
}

// ---------- Sections ----------
// To add a new block later (events, research...), add an entry here,
// write a small item function above, and add the Flask endpoint.
//   groupKey: column to group under headings (omit for a plain list)
//   sortKey:  column to sort newest first inside each group/list (optional)
const SECTIONS = [
  { id: "emails",  title: "Emails by Clubs", path: "/emails_from_clubs", groupKey: "c_name", sortKey: "sent_at", item: emailItem },
  { id: "notices", title: "Notices",         path: "/view_notices",                                             item: noticeItem },
  // { id: "events",   title: "Events",   path: "/view_events",   item: eventItem },
];

function newestFirst(rows, key) {
  if (!key) return rows;
  return [...rows].sort((a, b) => new Date(b[key]) - new Date(a[key]));
}

function renderGrouped(rows, section, container) {
  const groups = new Map();
  rows.forEach((row) => {
    const name = String(row[section.groupKey] ?? "Other");
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  });

  const columns = el("div", "columns");
  groups.forEach((items, name) => {
    const club = el("div", "club");
    club.appendChild(el("h3", "", name));
    newestFirst(items, section.sortKey).forEach((row) => club.appendChild(section.item(row)));
    columns.appendChild(club);
  });
  container.appendChild(columns);
}

function renderList(rows, section, container) {
  const columns = el("div", "columns");
  newestFirst(rows, section.sortKey).forEach((row) => columns.appendChild(section.item(row)));
  container.appendChild(columns);
}

async function loadSection(section) {
  const wrap = el("section", "section");
  wrap.id = section.id;
  wrap.appendChild(el("h2", "", section.title));
  document.getElementById("sections").appendChild(wrap);

  const nav = el("a", "", section.title);
  nav.href = "#" + section.id;
  document.getElementById("nav").appendChild(nav);

  const { ok, status, data } = await api(section.path);
  if (status === 401) {
    setToken(null); // expired or invalid token
    showAuth();
    return;
  }
  if (!ok || !Array.isArray(data)) {
    wrap.appendChild(el("p", "error", data.error || "Could not load this section."));
    return;
  }
  if (!data.length) {
    wrap.appendChild(el("p", "empty", "Nothing to report yet."));
  } else if (section.groupKey) {
    renderGrouped(data, section, wrap);
  } else {
    renderList(data, section, wrap);
  }
}

function loadJournal() {
  document.getElementById("nav").replaceChildren();
  document.getElementById("sections").replaceChildren();
  document.getElementById("today").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  SECTIONS.forEach(loadSection);
}

// ---------- Start ----------
if (getToken()) showJournal(); else showAuth();
