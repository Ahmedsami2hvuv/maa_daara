const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3000;
const dataPath = path.join(__dirname, "data.json");

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();

function defaultData() {
  return {
    ids: { user: 2, area: 1, subscriber: 1, record: 1, previousOwner: 1, assignment: 1 },
    settings: { price_3m: 21600, price_4m: 30000, cleaning_fee: 3000, monthly_interest: 0.01 },
    users: [{ id: 1, name: "المدير العام", role: "manager", code: "ADMIN", pin: "1234" }],
    areas: [],
    subscribers: [],
    previousOwners: [],
    assignments: [],
    records: []
  };
}

function loadDB() {
  if (!fs.existsSync(dataPath)) {
    const data = defaultData();
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
    return data;
  }
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

let db = loadDB();

function saveDB() {
  fs.writeFileSync(dataPath, JSON.stringify(db, null, 2), "utf8");
}

function nextId(key) {
  const id = db.ids[key];
  db.ids[key] += 1;
  return id;
}

function authRequired(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "غير مخوّل" });
  req.user = sessions.get(token);
  next();
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "لا تملك صلاحية" });
    next();
  };
}

function userCanAccessSubscriber(user, subscriberId) {
  if (user.role === "manager") return true;
  return db.assignments.some((a) => a.subscriber_id === subscriberId && a.user_id === user.id);
}

function recalcYear(subscriberId, year) {
  const rows = db.records
    .filter((r) => r.subscriber_id === subscriberId && r.year === year)
    .sort((a, b) => a.period_index - b.period_index);

  const prev = db.records
    .filter((r) => r.subscriber_id === subscriberId && r.year < year)
    .sort((a, b) => (a.year === b.year ? a.period_index - b.period_index : a.year - b.year))
    .pop();

  let debt = prev ? Math.max((prev.total_due || 0) - (prev.paid || 0), 0) : 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) {
      rows[i].interest = rows[i - 1].paid > 0 ? 0 : Number((db.settings.monthly_interest * 1000).toFixed(2));
    }
    rows[i].subtotal = Number(rows[i].water || 0) + Number(rows[i].cleaning || 0) + Number(rows[i].interest || 0);
    rows[i].debt = debt;
    rows[i].total_due = rows[i].subtotal + debt;
    debt = Math.max(rows[i].total_due - Number(rows[i].paid || 0), 0);
  }
  saveDB();
}

app.post("/api/auth/login", (req, res) => {
  const { code, pin } = req.body || {};
  const user = db.users.find((u) => u.code === code && u.pin === pin);
  if (!user) return res.status(401).json({ error: "الرمز أو الرقم السري خطأ" });
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { id: user.id, name: user.name, role: user.role, code: user.code });
  res.json({ token, user: sessions.get(token) });
});

app.get("/api/me", authRequired, (req, res) => res.json(req.user));
app.get("/api/settings", authRequired, (req, res) => res.json(db.settings));
app.put("/api/settings", authRequired, allowRoles("manager"), (req, res) => {
  db.settings = { ...db.settings, ...req.body };
  saveDB();
  res.json(db.settings);
});

app.get("/api/backup", authRequired, allowRoles("manager"), (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="water-backup-${stamp}.json"`);
  res.send(JSON.stringify(db, null, 2));
});

app.post("/api/restore", authRequired, allowRoles("manager"), (req, res) => {
  const incoming = req.body;
  if (
    !incoming ||
    typeof incoming !== "object" ||
    !incoming.ids ||
    !Array.isArray(incoming.users) ||
    !Array.isArray(incoming.areas) ||
    !Array.isArray(incoming.subscribers) ||
    !Array.isArray(incoming.records)
  ) {
    return res.status(400).json({ error: "ملف النسخة الاحتياطية غير صالح" });
  }
  db = incoming;
  saveDB();
  sessions.clear();
  return res.json({ ok: true, message: "تم استرجاع البيانات. يرجى تسجيل الدخول مجددا." });
});

app.get("/api/users", authRequired, allowRoles("manager"), (req, res) => {
  res.json(db.users.map((u) => ({ id: u.id, name: u.name, role: u.role, code: u.code })));
});

app.post("/api/users", authRequired, allowRoles("manager"), (req, res) => {
  const { name, role, code, pin } = req.body || {};
  if (!name || !role || !code || !pin) return res.status(400).json({ error: "اكمل الحقول" });
  if (db.users.some((u) => u.code === code)) return res.status(400).json({ error: "الرمز مستخدم" });
  db.users.push({ id: nextId("user"), name, role, code, pin });
  saveDB();
  res.json({ ok: true });
});

app.get("/api/areas", authRequired, (req, res) => res.json(db.areas));
app.post("/api/areas", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "اسم المنطقة مطلوب" });
  db.areas.push({ id: nextId("area"), name });
  saveDB();
  res.json({ ok: true });
});

app.get("/api/subscribers", authRequired, (req, res) => {
  const rows = db.subscribers
    .filter((s) => userCanAccessSubscriber(req.user, s.id))
    .map((s) => ({ ...s, area_name: db.areas.find((a) => a.id === s.area_id)?.name || "-" }));
  res.json(rows);
});

app.post("/api/subscribers", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const { area_id, subscriber_number, owner_name, phone, meter_size, previousOwners = [] } = req.body || {};
  const sub = {
    id: nextId("subscriber"),
    area_id,
    subscriber_number,
    owner_name,
    status: "فعال",
    phone: phone || null,
    meter_size
  };
  db.subscribers.push(sub);
  // creator gets access automatically
  db.assignments.push({ id: nextId("assignment"), subscriber_id: sub.id, user_id: req.user.id, assignment_type: req.user.role });
  for (const name of previousOwners) {
    if (name?.trim()) {
      db.previousOwners.push({ id: nextId("previousOwner"), subscriber_id: sub.id, owner_name: name.trim() });
    }
  }
  saveDB();
  res.json({ ok: true, id: sub.id });
});

app.post("/api/subscribers/:id/assign", authRequired, allowRoles("manager"), (req, res) => {
  const subscriberId = Number(req.params.id);
  const { user_id, assignment_type } = req.body || {};
  if (!db.assignments.some((a) => a.subscriber_id === subscriberId && a.user_id === user_id && a.assignment_type === assignment_type)) {
    db.assignments.push({ id: nextId("assignment"), subscriber_id: subscriberId, user_id, assignment_type });
    saveDB();
  }
  res.json({ ok: true });
});

app.get("/api/subscribers/:id/records/:year", authRequired, (req, res) => {
  const subscriberId = Number(req.params.id);
  const year = Number(req.params.year);
  if (!userCanAccessSubscriber(req.user, subscriberId)) return res.status(403).json({ error: "غير مسموح" });
  const rows = db.records
    .filter((r) => r.subscriber_id === subscriberId && r.year === year)
    .sort((a, b) => a.period_index - b.period_index);
  res.json(rows);
});

app.post("/api/subscribers/:id/records/:year/init", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const subscriberId = Number(req.params.id);
  const year = Number(req.params.year);
  if (!userCanAccessSubscriber(req.user, subscriberId)) return res.status(403).json({ error: "غير مسموح" });
  const subscriber = db.subscribers.find((s) => s.id === subscriberId);
  if (!subscriber) return res.status(404).json({ error: "المشترك غير موجود" });
  const waterPrice = subscriber.meter_size === 3 ? db.settings.price_3m : db.settings.price_4m;
  const datePairs = [["1/1", "28/2"], ["1/3", "31/3"], ["1/5", "30/6"], ["1/7", "31/8"], ["1/9", "31/10"], ["1/11", "31/12"]];
  for (let i = 0; i < 6; i += 1) {
    const exists = db.records.some((r) => r.subscriber_id === subscriberId && r.year === year && r.period_index === i + 1);
    if (!exists) {
      db.records.push({
        id: nextId("record"),
        subscriber_id: subscriberId,
        year,
        period_index: i + 1,
        date_from: datePairs[i][0],
        date_to: datePairs[i][1],
        water: waterPrice,
        cleaning: db.settings.cleaning_fee,
        interest: 0,
        subtotal: 0,
        debt: 0,
        total_due: 0,
        paid: 0,
        receipt_number: null,
        receipt_date: null
      });
    }
  }
  recalcYear(subscriberId, year);
  res.json({ ok: true });
});

app.put("/api/records/:id", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const id = Number(req.params.id);
  const row = db.records.find((r) => r.id === id);
  if (!row) return res.status(404).json({ error: "غير موجود" });
  if (!userCanAccessSubscriber(req.user, row.subscriber_id)) return res.status(403).json({ error: "غير مسموح" });
  Object.assign(row, req.body);
  recalcYear(row.subscriber_id, row.year);
  res.json({ ok: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
