const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const dataPath = path.join(__dirname, "data.json");

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map();

function defaultData() {
  return {
    ids: { user: 2, area: 1, subscriber: 1, record: 1, previousOwner: 1, assignment: 1 },
    settings: {
      cleaning_fee: 3000,
      monthly_interest: 0.01,
      other_fee: 24600,
      meter_plans: [
        { code: "3m", label: "3 متر", water_price: 21600 },
        { code: "4m", label: "4 متر", water_price: 30000 }
      ]
    },
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

function normalizeData(raw) {
  const data = raw && typeof raw === "object" ? raw : defaultData();
  if (!data.settings || typeof data.settings !== "object") data.settings = {};

  // Backward compatibility for old settings format.
  if (!Array.isArray(data.settings.meter_plans)) {
    const p3 = Number(data.settings.price_3m || 21600);
    const p4 = Number(data.settings.price_4m || 30000);
    data.settings.meter_plans = [
      { code: "3m", label: "3 متر", water_price: p3 },
      { code: "4m", label: "4 متر", water_price: p4 }
    ];
  }
  data.settings.cleaning_fee = Number(data.settings.cleaning_fee || 3000);
  data.settings.monthly_interest = Number(data.settings.monthly_interest || 0.01);
  data.settings.other_fee = Number(data.settings.other_fee || 24600);

  if (!Array.isArray(data.users)) data.users = [];
  for (const user of data.users) {
    if (user.name === "Ø§Ù„Ù…Ø¯ÙŠØ± Ø§Ù„Ø¹Ø§Ù…") user.name = "المدير العام";
  }

  if (!Array.isArray(data.subscribers)) data.subscribers = [];
  for (const sub of data.subscribers) {
    if (!sub.billing_plan) {
      sub.billing_plan = Number(sub.meter_size) === 4 ? "4m" : "3m";
    }
    if (!sub.subscriber_type) {
      sub.subscriber_type = "منزلي";
    }
  }
  if (!Array.isArray(data.records)) data.records = [];
  for (const r of data.records) {
    if (r.other === undefined || r.other === null) {
      r.other = data.settings.other_fee;
    }
  }
  return data;
}

let db = normalizeData(loadDB());

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
  if (user.role === "manager" || user.role === "writer") return true;
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
    rows[i].subtotal =
      Number(rows[i].water || 0) +
      Number(rows[i].cleaning || 0) +
      Number(rows[i].interest || 0) +
      Number(rows[i].other || 0);
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
  const incoming = req.body || {};
  const next = {
    ...db.settings,
    cleaning_fee: Number(incoming.cleaning_fee ?? db.settings.cleaning_fee),
    monthly_interest: Number(incoming.monthly_interest ?? db.settings.monthly_interest),
    other_fee: Number(incoming.other_fee ?? db.settings.other_fee),
    meter_plans: Array.isArray(incoming.meter_plans) ? incoming.meter_plans : db.settings.meter_plans
  };
  next.meter_plans = next.meter_plans
    .map((p) => ({
      code: String(p.code || "").trim(),
      label: String(p.label || "").trim(),
      water_price: Number(p.water_price || 0)
    }))
    .filter((p) => p.code && p.label && p.water_price >= 0);
  if (!next.meter_plans.length) {
    return res.status(400).json({ error: "يجب إضافة نظام جباية واحد على الأقل" });
  }
  db.settings = next;
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

app.get("/api/users/:id/subscribers", authRequired, allowRoles("manager"), (req, res) => {
  const userId = Number(req.params.id);
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
  const assignedIds = db.assignments
    .filter((a) => a.user_id === userId)
    .map((a) => a.subscriber_id);
  const uniqueIds = [...new Set(assignedIds)];
  const rows = db.subscribers
    .filter((s) => uniqueIds.includes(s.id))
    .map((s) => ({
      ...s,
      area_name: db.areas.find((a) => a.id === s.area_id)?.name || "-",
      billing_plan_label: db.settings.meter_plans.find((p) => p.code === s.billing_plan)?.label || s.billing_plan
    }));
  res.json({ user: { id: user.id, name: user.name, role: user.role }, subscribers: rows });
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

app.put("/api/areas/:id", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body || {};
  const area = db.areas.find((a) => a.id === id);
  if (!area) return res.status(404).json({ error: "المنطقة غير موجودة" });
  if (!name || !String(name).trim()) return res.status(400).json({ error: "الاسم الجديد مطلوب" });
  area.name = String(name).trim();
  saveDB();
  res.json({ ok: true, area });
});

app.get("/api/subscribers", authRequired, (req, res) => {
  const rows = db.subscribers
    .filter((s) => userCanAccessSubscriber(req.user, s.id))
    .map((s) => ({
      ...s,
      area_name: db.areas.find((a) => a.id === s.area_id)?.name || "-",
      billing_plan_label: db.settings.meter_plans.find((p) => p.code === s.billing_plan)?.label || s.billing_plan
    }));
  res.json(rows);
});

app.post("/api/subscribers", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const { area_id, subscriber_number, owner_name, phone, billing_plan, subscriber_type, previousOwners = [] } = req.body || {};
  if (!db.settings.meter_plans.some((p) => p.code === billing_plan)) {
    return res.status(400).json({ error: "نظام الجباية غير صالح" });
  }
  const sub = {
    id: nextId("subscriber"),
    area_id,
    subscriber_number,
    owner_name,
    status: "فعال",
    phone: phone || null,
    billing_plan,
    subscriber_type: cellStr(subscriber_type) || "منزلي"
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

app.post("/api/subscribers/bulk-delete", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const raw = req.body?.ids;
  const ids = Array.isArray(raw) ? raw.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : [];
  if (!ids.length) return res.status(400).json({ error: "لم يحدد أي مشترك للحذف" });
  const unique = [...new Set(ids)];
  let removed = 0;
  for (const subscriberId of unique) {
    if (!userCanAccessSubscriber(req.user, subscriberId)) continue;
    const ix = db.subscribers.findIndex((s) => s.id === subscriberId);
    if (ix === -1) continue;
    db.subscribers.splice(ix, 1);
    db.records = db.records.filter((r) => r.subscriber_id !== subscriberId);
    db.previousOwners = db.previousOwners.filter((p) => p.subscriber_id !== subscriberId);
    db.assignments = db.assignments.filter((a) => a.subscriber_id !== subscriberId);
    removed += 1;
  }
  saveDB();
  res.json({ ok: true, removed, requested: unique.length });
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

app.get("/api/subscribers/:id/details", authRequired, (req, res) => {
  const subscriberId = Number(req.params.id);
  if (!userCanAccessSubscriber(req.user, subscriberId)) return res.status(403).json({ error: "غير مسموح" });
  const sub = db.subscribers.find((s) => s.id === subscriberId);
  if (!sub) return res.status(404).json({ error: "المشترك غير موجود" });
  const previousOwners = db.previousOwners.filter((p) => p.subscriber_id === subscriberId);
  res.json({ subscriber: sub, previousOwners });
});

app.put("/api/subscribers/:id", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const subscriberId = Number(req.params.id);
  if (!userCanAccessSubscriber(req.user, subscriberId) && req.user.role !== "manager") {
    return res.status(403).json({ error: "غير مسموح" });
  }
  const sub = db.subscribers.find((s) => s.id === subscriberId);
  if (!sub) return res.status(404).json({ error: "المشترك غير موجود" });
  const { area_id, subscriber_number, owner_name, phone, billing_plan, subscriber_type } = req.body || {};
  if (!db.settings.meter_plans.some((p) => p.code === billing_plan)) {
    return res.status(400).json({ error: "نظام الجباية غير صالح" });
  }
  const duplicate = db.subscribers.find(
    (s) => s.id !== subscriberId && String(s.subscriber_number) === String(subscriber_number)
  );
  if (duplicate) return res.status(400).json({ error: "رقم المشترك مستخدم مسبقاً" });
  sub.area_id = Number(area_id);
  sub.subscriber_number = String(subscriber_number).trim();
  sub.owner_name = String(owner_name).trim();
  sub.phone = phone ? String(phone).trim() : null;
  sub.billing_plan = billing_plan;
  sub.subscriber_type = cellStr(subscriber_type) || "منزلي";
  saveDB();
  res.json({ ok: true, subscriber: sub });
});

app.post("/api/subscribers/:id/previous-owners", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const subscriberId = Number(req.params.id);
  if (!userCanAccessSubscriber(req.user, subscriberId) && req.user.role !== "manager") {
    return res.status(403).json({ error: "غير مسموح" });
  }
  const { owner_name } = req.body || {};
  if (!owner_name || !String(owner_name).trim()) {
    return res.status(400).json({ error: "اسم المالك السابق مطلوب" });
  }
  const row = {
    id: nextId("previousOwner"),
    subscriber_id: subscriberId,
    owner_name: String(owner_name).trim()
  };
  db.previousOwners.push(row);
  saveDB();
  res.json({ ok: true, previous_owner: row });
});

app.post("/api/assignments/bulk", authRequired, allowRoles("manager"), (req, res) => {
  const { user_id, user_ids = [], assignment_type, area_ids = [], subscriber_ids = [] } = req.body || {};
  const userIds = [...new Set([...(Array.isArray(user_ids) ? user_ids : []), user_id].map((x) => Number(x)).filter(Boolean))];
  if (!userIds.length || !["writer", "collector"].includes(assignment_type)) {
    return res.status(400).json({ error: "بيانات الإسناد غير صحيحة" });
  }
  const targetUsers = db.users.filter((u) => userIds.includes(u.id) && u.role === assignment_type);
  if (targetUsers.length !== userIds.length) {
    return res.status(400).json({ error: "يوجد مستخدم غير موجود أو دوره غير مطابق" });
  }

  const pickedAreaIds = area_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  const pickedSubscriberIds = subscriber_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  const byAreas = db.subscribers.filter((s) => pickedAreaIds.includes(Number(s.area_id))).map((s) => s.id);
  const allIds = [...new Set([...pickedSubscriberIds, ...byAreas])];

  if (!allIds.length) return res.status(400).json({ error: "اختر مناطق أو مشتركين للإسناد" });

  let added = 0;
  for (const targetUser of targetUsers) {
    for (const subscriberId of allIds) {
      const exists = db.assignments.some(
        (a) => a.subscriber_id === subscriberId && a.user_id === targetUser.id && a.assignment_type === assignment_type
      );
      if (!exists) {
        db.assignments.push({
          id: nextId("assignment"),
          subscriber_id: subscriberId,
          user_id: targetUser.id,
          assignment_type
        });
        added += 1;
      }
    }
  }
  saveDB();
  res.json({ ok: true, added, total_selected: allIds.length, users_count: targetUsers.length });
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
  const plan = db.settings.meter_plans.find((p) => p.code === subscriber.billing_plan);
  const waterPrice = Number(plan?.water_price || 0);
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
        other: db.settings.other_fee,
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

function cellStr(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  return String(v).trim();
}

function normalizeArabicDigits(s) {
  return cellStr(s)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

function normalizeLoose(s) {
  return normalizeArabicDigits(s).toLowerCase().replace(/\s+/g, "").replace(/[\/\\|_-]/g, "");
}

function resolveBillingPlan(rawValue, fallbackCode) {
  const text = cellStr(rawValue);
  if (!text) return fallbackCode;
  const exactCode = db.settings.meter_plans.find((p) => p.code === text);
  if (exactCode) return exactCode.code;
  const exactLabel = db.settings.meter_plans.find((p) => p.label === text);
  if (exactLabel) return exactLabel.code;

  const loose = normalizeLoose(text);
  const byLooseCodeOrLabel = db.settings.meter_plans.find((p) => {
    return normalizeLoose(p.code) === loose || normalizeLoose(p.label) === loose;
  });
  if (byLooseCodeOrLabel) return byLooseCodeOrLabel.code;

  const byContains = db.settings.meter_plans.find((p) => {
    const lc = normalizeLoose(p.code);
    const ll = normalizeLoose(p.label);
    return loose.includes(lc) || loose.includes(ll) || lc.includes(loose) || ll.includes(loose);
  });
  if (byContains) return byContains.code;

  return fallbackCode;
}

function isSerialHeader(h) {
  const s = cellStr(h).toLowerCase();
  if (!s) return false;
  if (/(تسلسل|رقم\s*التسلسل|serial|seq\.?|index|م\s*تسلسل)/i.test(s)) return true;
  if (/^#+\s*$/.test(s)) return true;
  if (/^م[\s\.]*$/.test(s) && s.length <= 4) return true;
  return false;
}

function isExplicitSubscriptionHeader(h) {
  const s = cellStr(h).toLowerCase();
  return /(رقم\s*الاشتراك|رقم\s*المشترك|subscription)/i.test(s);
}

function classifyHeaderCell(h) {
  const s = cellStr(h).toLowerCase();
  if (!s) return null;
  // نوع الاشتراك / نوع المشترك — قبل أي نمط فيه "اشتراك" حتى لا يُخلط مع رقم الاشتراك أو المنطقة
  if (/(نوع\s*(الاشتراك|المشترك)|نوع\s*اشتراك|تصنيف|فئة|category|type)/i.test(s)) return "subscriber_type";
  if (/(مقياس|جباية|عداد|نظام|plan|meter|tariff)/i.test(s)) return "billing_plan";
  if (/(هاتف|جوال|phone|mobile|tel)/i.test(s)) return "phone";
  if (isSerialHeader(h)) return "serial";
  if (isExplicitSubscriptionHeader(h)) return "subscriber_number";
  // المنطقة قبل "اسم المشترك": لا تستخدم نمط "اسم" العام لأنه يطابق "اسم المنطقة" بالخطأ
  if (
    /(اسم\s*المنطقة|^المنطقة$|^منطقة$|المنطقة|منطق|area|zone|حي|قطاع)/i.test(s) &&
    !/نوع/i.test(s)
  ) {
    return "area";
  }
  // اسم المشترك / المالك فقط — لا "اسم الكاتب" ولا "اسم المنطقة"
  if (/(اسم\s*(المشترك|المالك)|مالك|owner|^(name|owner)\b)/i.test(s)) return "owner_name";
  if ((/^اسم\s*$/i.test(s) || /^name\s*$/i.test(s)) && !/منطق|منطقة|نوع|كاتب/i.test(s)) return "owner_name";
  // رقم اشتراك عام: لا صفوف فيها "نوع" (مثل نوع الاشتراك)
  if (/(رقم|number|no\b|subscriber|مشترك|اشتراك)/i.test(s) && !/هاتف|phone|نوع/i.test(s)) return "subscriber_number";
  return null;
}

function mapHeaderRow(headerCells) {
  const map = { subscriber_number: -1, owner_name: -1, area: -1, phone: -1, subscriber_type: -1, billing_plan: -1 };
  const n = headerCells.length;
  const classified = headerCells.map((c) => classifyHeaderCell(c));

  let idx = headerCells.findIndex((c) => isExplicitSubscriptionHeader(c));
  if (idx >= 0) map.subscriber_number = idx;

  idx = headerCells.findIndex((c) => /نوع\s*(الاشتراك|المشترك)/i.test(cellStr(c)));
  if (idx >= 0) map.subscriber_type = idx;
  else {
    idx = classified.findIndex((k) => k === "subscriber_type");
    if (idx >= 0) map.subscriber_type = idx;
  }

  idx = classified.findIndex((k) => k === "billing_plan");
  if (idx >= 0) map.billing_plan = idx;

  idx = classified.findIndex((k) => k === "phone");
  if (idx >= 0) map.phone = idx;

  idx = headerCells.findIndex((c) => /اسم\s*(المشترك|المالك)/i.test(cellStr(c)));
  if (idx >= 0) map.owner_name = idx;
  else {
    idx = classified.findIndex((k) => k === "owner_name");
    if (idx >= 0) map.owner_name = idx;
  }

  idx = headerCells.findIndex((c) => /اسم\s*المنطقة|^المنطقة$|^منطقة$|المنطقة/i.test(cellStr(c)));
  if (idx >= 0) map.area = idx;
  else {
    idx = classified.findIndex((k) => k === "area");
    if (idx >= 0) map.area = idx;
  }

  if (map.subscriber_number === -1) {
    for (let i = 0; i < n; i += 1) {
      if (classified[i] === "subscriber_number" && !isSerialHeader(headerCells[i])) {
        map.subscriber_number = i;
        break;
      }
    }
  }
  return map;
}

function headerRowScore(row) {
  const cells = row.map(cellStr);
  let score = 0;
  if (cells.some((c) => /رقم\s*الاشتراك|رقم\s*المشتراك/i.test(c))) score += 6;
  if (cells.some((c) => /اسم\s*المشترك|اسم\s*المالك/i.test(c))) score += 3;
  if (cells.some((c) => /منطق|منطقة|اسم\s*المنطقة/i.test(c))) score += 2;
  if (cells.some((c) => /نوع\s*الاشتراك/i.test(c))) score += 1;
  if (cells.some((c) => /مقياس\s*الجباية|مقياس/i.test(c))) score += 1;
  return score;
}

function findBestHeaderRowIndex(matrix, maxScan = 25) {
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < Math.min(matrix.length, maxScan); i += 1) {
    const row = matrix[i] || [];
    const sc = headerRowScore(row);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  }
  if (best >= 0 && bestScore >= 5) return best;
  for (let i = 0; i < Math.min(matrix.length, maxScan); i += 1) {
    const row = matrix[i] || [];
    if (row.map(cellStr).some((c) => classifyHeaderCell(c))) return i;
  }
  return 0;
}

function findOrCreateAreaByName(areaName, createMissing) {
  const name = cellStr(areaName);
  if (!name) return null;
  let a = db.areas.find((x) => x.name === name);
  if (!a && createMissing) {
    a = { id: nextId("area"), name };
    db.areas.push(a);
  }
  return a;
}

function createSubscriberRow(req, { area_id, subscriber_number, owner_name, phone, billing_plan, subscriber_type, previousOwners }) {
  if (!db.settings.meter_plans.some((p) => p.code === billing_plan)) {
    return { ok: false, error: "نظام الجباية غير صالح" };
  }
  if (!area_id) return { ok: false, error: "المنطقة مطلوبة" };
  const num = cellStr(subscriber_number);
  const owner = cellStr(owner_name);
  if (!num || !owner) return { ok: false, error: "رقم المشترك والاسم مطلوبان" };
  if (db.subscribers.some((s) => String(s.subscriber_number) === num)) {
    return { ok: false, error: "رقم المشترك مكرر", duplicate: true };
  }
  const sub = {
    id: nextId("subscriber"),
    area_id,
    subscriber_number: num,
    owner_name: owner,
    status: "فعال",
    phone: phone ? cellStr(phone) : null,
    billing_plan,
    subscriber_type: cellStr(subscriber_type) || "منزلي"
  };
  db.subscribers.push(sub);
  db.assignments.push({
    id: nextId("assignment"),
    subscriber_id: sub.id,
    user_id: req.user.id,
    assignment_type: req.user.role
  });
  for (const po of previousOwners || []) {
    if (cellStr(po)) {
      db.previousOwners.push({ id: nextId("previousOwner"), subscriber_id: sub.id, owner_name: cellStr(po) });
    }
  }
  return { ok: true, id: sub.id };
}

app.post(
  "/api/subscribers/import",
  authRequired,
  allowRoles("manager", "writer"),
  upload.single("file"),
  (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "ارفع ملف Excel (.xlsx أو .xls)" });
    }
    const billing_plan = cellStr(req.body?.billing_plan) || db.settings.meter_plans[0]?.code;
    const create_areas = String(req.body?.create_areas || "true") !== "false";
    const skip_duplicates = String(req.body?.skip_duplicates || "true") !== "false";

    let wb;
    try {
      wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    } catch (_e) {
      return res.status(400).json({ error: "تعذر قراءة الملف" });
    }
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    if (!matrix.length) {
      return res.status(400).json({ error: "الملف فارغ" });
    }

    const headerRowIdx = findBestHeaderRowIndex(matrix);
    const headerRow = (matrix[headerRowIdx] || []).map(cellStr);
    const looksLikeHeader = headerRow.some((c) => classifyHeaderCell(c));
    let startRow = 0;
    let colMap = { subscriber_number: -1, owner_name: -1, area: -1, phone: -1, subscriber_type: -1, billing_plan: -1 };

    if (looksLikeHeader) {
      colMap = mapHeaderRow(headerRow);
      startRow = headerRowIdx + 1;
      if (colMap.subscriber_number === -1 || colMap.owner_name === -1 || colMap.area === -1) {
        return res.status(400).json({
          error:
            "تعذر قراءة عناوين الأعمدة. تأكد من وجود أعمدة: رقم الاشتراك (وليس عمود التسلسل)، اسم المشترك، اسم المنطقة"
        });
      }
    } else {
      colMap = { subscriber_number: 0, owner_name: 1, area: 2, phone: 3, subscriber_type: -1, billing_plan: -1 };
    }

    const created = [];
    const errors = [];
    let skipped = 0;

    for (let i = startRow; i < matrix.length; i += 1) {
      const row = matrix[i];
      if (!row || !row.length) continue;
      const get = (key) => {
        const j = colMap[key];
        if (j < 0) return "";
        return cellStr(row[j]);
      };
      const subscriber_number = get("subscriber_number");
      const owner_name = get("owner_name");
      const areaText = get("area");
      const phone = colMap.phone >= 0 ? get("phone") : "";
      const subscriber_type = colMap.subscriber_type >= 0 ? get("subscriber_type") : "منزلي";
      const rowBillingPlanText = colMap.billing_plan >= 0 ? get("billing_plan") : "";
      const rowBillingPlan = resolveBillingPlan(rowBillingPlanText, billing_plan);

      if (/بداية\s*سجل/i.test(subscriber_number) || /بداية\s*سجل/i.test(owner_name)) continue;

      if (!subscriber_number && !owner_name && !areaText) continue;

      const area = findOrCreateAreaByName(areaText, create_areas);
      if (!area) {
        errors.push({ row: i + 1, message: `المنطقة غير موجودة: ${areaText || "-"}` });
        continue;
      }

      const result = createSubscriberRow(req, {
        area_id: area.id,
        subscriber_number,
        owner_name,
        phone: phone || null,
        billing_plan: rowBillingPlan,
        subscriber_type,
        previousOwners: []
      });

      if (result.ok) {
        created.push(result.id);
      } else if (result.duplicate && skip_duplicates) {
        skipped += 1;
      } else {
        errors.push({ row: i + 1, message: result.error || "خطأ" });
      }
    }

    saveDB();
    res.json({
      ok: true,
      sheet: sheetName,
      created: created.length,
      skipped_duplicates: skipped,
      errors,
      message: `تم إنشاء ${created.length} مشترك${skipped ? `، تخطي ${skipped} مكرر` : ""}`
    });
  }
);

function normSearch(q) {
  return cellStr(q).toLowerCase();
}

/** تقسيم الاستعلام إلى كلمات؛ مطابقة ذكية: كل الكلمات يجب أن تظهر في النص (بأي ترتيب)، مثل «احمد حسين» يطابق «احمد علي حسين». */
function searchTokens(q) {
  return normSearch(q)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function matchesSmart(haystack, qRaw) {
  const q = normSearch(qRaw);
  if (!q) return false;
  const hay = cellStr(haystack).toLowerCase();
  if (!hay) return false;
  const tokens = searchTokens(qRaw);
  if (tokens.length <= 1) return hay.includes(q);
  return tokens.every((t) => hay.includes(t));
}

app.get("/api/search", authRequired, (req, res) => {
  const q = normSearch(req.query.q || "");
  if (q.length < 1) {
    return res.json({ areas: [], subscribers: [], users: [], records: [] });
  }

  const areas = db.areas
    .filter((a) => matchesSmart(a.name, req.query.q || ""))
    .map((a) => ({ type: "area", id: a.id, title: a.name, subtitle: "منطقة" }));

  const subs = db.subscribers.filter((s) => userCanAccessSubscriber(req.user, s.id));
  const subscribers = subs
    .filter((s) => {
      const num = cellStr(s.subscriber_number).toLowerCase();
      const owner = cellStr(s.owner_name).toLowerCase();
      const phone = cellStr(s.phone).toLowerCase();
      const tokens = searchTokens(req.query.q || "");
      if (tokens.length <= 1) {
        return num.includes(q) || owner.includes(q) || phone.includes(q);
      }
      const numOk = tokens.every((t) => num.includes(t));
      const ownerOk = tokens.every((t) => owner.includes(t));
      const phoneOk = phone && tokens.every((t) => phone.includes(t));
      return numOk || ownerOk || phoneOk;
    })
    .map((s) => {
      const areaName = db.areas.find((a) => a.id === s.area_id)?.name || "-";
      return {
        type: "subscriber",
        id: s.id,
        title: `${s.subscriber_number} — ${s.owner_name}`,
        subtitle: areaName
      };
    });

  let users = [];
  if (req.user.role === "manager") {
    users = db.users
      .filter((u) => {
        const name = cellStr(u.name).toLowerCase();
        const code = cellStr(u.code).toLowerCase();
        const tokens = searchTokens(req.query.q || "");
        if (tokens.length <= 1) return name.includes(q) || code.includes(q);
        return tokens.every((t) => name.includes(t)) || tokens.every((t) => code.includes(t));
      })
      .map((u) => ({
        type: "user",
        id: u.id,
        role: u.role,
        title: u.name,
        subtitle: `${u.role} — ${u.code}`
      }));
  }

  const records = [];
  for (const r of db.records) {
    const recNo = cellStr(r.receipt_number).toLowerCase();
    if (!recNo) continue;
    const tokens = searchTokens(req.query.q || "");
    const recMatch =
      tokens.length <= 1 ? recNo.includes(q) : tokens.every((t) => recNo.includes(t));
    if (!recMatch) continue;
    if (!userCanAccessSubscriber(req.user, r.subscriber_id)) continue;
    const sub = db.subscribers.find((s) => s.id === r.subscriber_id);
    if (!sub) continue;
    records.push({
      type: "record",
      id: r.id,
      subscriber_id: r.subscriber_id,
      year: r.year,
      title: `وصل ${r.receipt_number}`,
      subtitle: `${sub.subscriber_number} — سنة ${r.year}`
    });
    if (records.length >= 30) break;
  }

  res.json({ areas, subscribers, users, records });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
