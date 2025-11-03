import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8091;

// ===== CORS =====
const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed: " + origin));
  }
}));
app.use(express.json({ limit: "5mb" }));

// ===== Static uploads =====
const uploadsDir = path.resolve("uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage });

// ===== Helper =====
const loadJSON = (file) => JSON.parse(fs.readFileSync(path.resolve("data", file), "utf-8"));

// ===== Lists =====
app.get("/api/poi", (req, res) => res.json(loadJSON("poi.json")));
app.get("/api/cctv", (req, res) => res.json(loadJSON("cctv.json")));
app.get("/api/baseline", (req, res) => res.json(loadJSON("baseline.json")));

// ===== Proxy (bypass CORS) =====
app.get("/api/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing url");
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    res.status(r.status);
    const ct = r.headers.get("content-type");
    if (ct) res.set("content-type", ct);
    const buf = await r.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).send("Proxy error: " + e.message);
  }
});

// ===== BPR estimator =====
// Body: { T_min, Tff_min, L_km, qpc, alpha, beta }
app.post("/api/traffic/estimate", (req, res) => {
  try {
    const { T_min, Tff_min, L_km, qpc, alpha, beta } = req.body;
    if ([T_min, Tff_min, L_km, qpc, alpha, beta].some(v => typeof v !== "number" || v <= 0)) {
      return res.status(400).json({ error: "All fields must be positive numbers." });
    }
    if (T_min <= Tff_min) {
      return res.json({ q_veh_per_h: 0, N_veh: 0, note: "Free flow or better than free flow." });
    }
    const T_h = T_min / 60;
    const Tff_h = Tff_min / 60;
    const Tratio = T_h / Tff_h;
    const base = (Tratio - 1) / alpha;
    if (base < 0) return res.status(400).json({ error: "Invalid base value, check parameters." });

    const q = qpc * Math.pow(base, 1 / beta); // veh/h
    const N = q * T_h; // veh on link approx

    res.json({ q_veh_per_h: Number(q.toFixed(2)), N_veh: Math.round(N), Tratio: Number(Tratio.toFixed(3)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Directions proxy (optional LIVE) =====
app.get("/api/directions", async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(400).json({ error: "GOOGLE_MAPS_API_KEY not set." });
  const { origin, destination } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: "origin & destination required" });

  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&departure_time=now&key=${key}`;
  try {
    const r = await fetch(url);
    const json = await r.json();
    const leg = json?.routes?.[0]?.legs?.[0];
    if (!leg) return res.status(404).json({ error: "No route found" });

    const T_sec = leg.duration_in_traffic?.value ?? leg.duration.value;
    const L_m = leg.distance.value;
    res.json({ T_min: Math.round(T_sec / 60), L_km: Number((L_m / 1000).toFixed(2)), raw: json });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Insights demo =====
app.get("/api/insights", (req, res) => {
  const baseline = loadJSON("baseline.json");
  const items = [
    { type: "info",    message: "[Roaming Insight] POI Wisatawan Asing Tertinggi: Candi Borobudur (+15% inbound roamer).", time: "baru saja" },
    { type: "alert",   message: "[Baseline Alarm] Avg Throughput JATENG turun 40% di bawah baseline.", time: "2 menit lalu",
      compare: { region: "JATENG", now_mbps: 15, baseline_mbps: baseline.regional_baseline.JATENG.throughput_mbps } },
    { type: "warning", message: "Potensi congestion di Denpasar. Kepadatan naik 30%.", time: "5 menit lalu" },
    { type: "info",    message: "Region JABAR trafik naik 8% dibanding kemarin.", time: "7 menit lalu" }
  ];
  res.json(items);
});

// ===== Upload video report =====
app.post("/api/video-report", upload.single("file"), (req, res) => {
  const { region, poi_id } = req.body;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ ok: true, region: region || null, poi_id: poi_id || null, url: `/uploads/${req.file.filename}` });
});

app.listen(PORT, () => console.log("Backend running on http://localhost:" + PORT));
