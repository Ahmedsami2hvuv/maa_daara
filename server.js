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

  if (!Array.isArray(data.users)) data.users = [];
  for (const user of data.users) {
    if (user.name === "Ø§Ù„Ù…Ø¯ÙŠØ± Ø§Ù„Ø¹Ø§Ù…") user.name = "المدير العام";
  }

  if (!Array.isArray(data.subscribers)) data.subscribers = [];
  for (const sub of data.subscribers) {
    if (!sub.billing_plan) {
      sub.billing_plan = Number(sub.meter_size) === 4 ? "4m" : "3m";
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
  const incoming = req.body || {};
  const next = {
    ...db.settings,
    cleaning_fee: Number(incoming.cleaning_fee ?? db.settings.cleaning_fee),
    monthly_interest: Number(incoming.monthly_interest ?? db.settings.monthly_interest),
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
    .map((s) => ({
      ...s,
      area_name: db.areas.find((a) => a.id === s.area_id)?.name || "-",
      billing_plan_label: db.settings.meter_plans.find((p) => p.code === s.billing_plan)?.label || s.billing_plan
    }));
  res.json(rows);
});

app.post("/api/subscribers", authRequired, allowRoles("manager", "writer"), (req, res) => {
  const { area_id, subscriber_number, owner_name, phone, billing_plan, previousOwners = [] } = req.body || {};
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
    billing_plan
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

function classifyHeaderCell(h) {
  const s = cellStr(h).toLowerCase();
  if (!s) return null;
  if (/(هاتف|جوال|phone|mobile|tel)/i.test(s)) return "phone";
  if (/(رقم|number|no\b|subscriber|مشترك|اشتراك)/i.test(s) && !/هاتف|phone/.test(s)) return "subscriber_number";
  if (/(اسم|name|مالك|owner)/i.test(s)) return "owner_name";
  if (/(منطق|area|zone|حي|قطاع)/i.test(s)) return "area";
  return null;
}

function mapHeaderRow(headerCells) {
  const map = { subscriber_number: -1, owner_name: -1, area: -1, phone: -1 };
  headerCells.forEach((cell, idx) => {
    const k = classifyHeaderCell(cell);
    if (k && map[k] === -1) map[k] = idx;
  });
  return map;
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

function createSubscriberRow(req, { area_id, subscriber_number, owner_name, phone, billing_plan, previousOwners }) {
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
    billing_plan
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

    const firstRow = matrix[0].map(cellStr);
    const looksLikeHeader = firstRow.some((c) => classifyHeaderCell(c));
    let startRow = 0;
    let colMap = { subscriber_number: -1, owner_name: -1, area: -1, phone: -1 };

    if (looksLikeHeader) {
      colMap = mapHeaderRow(firstRow);
      startRow = 1;
      if (colMap.subscriber_number === -1 || colMap.owner_name === -1 || colMap.area === -1) {
        return res.status(400).json({
          error:
            "الصف الأول يجب أن يحتوي أعمدة واضحة: رقم المشترك، اسم المالك، المنطقة (واختياري الهاتف)"
        });
      }
    } else {
      colMap = { subscriber_number: 0, owner_name: 1, area: 2, phone: 3 };
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
        billing_plan,
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

app.get("/api/search", authRequired, (req, res) => {
  const q = normSearch(req.query.q || "");
  if (q.length < 1) {
    return res.json({ areas: [], subscribers: [], users: [], records: [] });
  }

  const areas = db.areas
    .filter((a) => cellStr(a.name).toLowerCase().includes(q))
    .map((a) => ({ type: "area", id: a.id, title: a.name, subtitle: "منطقة" }));

  const subs = db.subscribers.filter((s) => userCanAccessSubscriber(req.user, s.id));
  const subscribers = subs
    .filter((s) => {
      const num = cellStr(s.subscriber_number).toLowerCase();
      const owner = cellStr(s.owner_name).toLowerCase();
      const phone = cellStr(s.phone).toLowerCase();
      return num.includes(q) || owner.includes(q) || phone.includes(q);
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
        return name.includes(q) || code.includes(q);
      })
      .map((u) => ({
        type: "user",
        id: u.id,
        title: u.name,
        subtitle: `${u.role} — ${u.code}`
      }));
  }

  const records = [];
  for (const r of db.records) {
    const recNo = cellStr(r.receipt_number).toLowerCase();
    if (!recNo || !recNo.includes(q)) continue;
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
