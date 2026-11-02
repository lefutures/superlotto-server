/**
 * SuperLotto Plus — Backend Server
 * - Manages all registered users and their tickets
 * - Checks CA Lottery results every Wed & Sat night
 * - Texts users ONLY when they win
 * - You run ONE Twilio account; users need nothing
 */

const express = require("express");
const twilio = require("twilio");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ─── YOUR TWILIO CREDENTIALS (only you need these) ───────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── SIMPLE USER DATABASE (stored in users.json file) ────────────────────────
// Format: { "phone": { tickets: [...], registeredAt: "...", active: true } }
// Saved on a Railway Volume (DATA_DIR=/data) so subscribers survive redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, "users.json");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
console.log("DATA_DIR:", DATA_DIR, DATA_DIR === __dirname ? "(WARNING: not a Railway Volume - users are lost on redeploy)" : "");
console.log("ADMIN_KEY:", ADMIN_KEY ? "SET" : "MISSING (admin routes open)");

function requireAdmin(req, res) {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

function loadUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}");
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// ─── PRIZE TABLE ─────────────────────────────────────────────────────────────
const PRIZES = {
  "5+1": 1000000, "5+0": 50000,
  "4+1": 1500,    "4+0": 150,
  "3+1": 50,      "3+0": 10,
  "2+1": 5,       "1+1": 2,
  "0+1": 1,
};

// ─── CHECK ONE TICKET ─────────────────────────────────────────────────────────
function checkTicket(ticket, draw) {
  const matched = ticket.numbers.filter(n => draw.numbers.includes(n)).length;
  const megaMatch = ticket.mega === draw.mega;
  const key = `${matched}+${megaMatch ? 1 : 0}`;
  return { matched, megaMatch, prize: PRIZES[key] || 0 };
}

// ─── FETCH REAL DRAWING RESULTS ───────────────────────────────────────────────
async function fetchLatestDrawing() {
  const url = "https://www.calottery.com/api/DrawGameApi/DrawGamePastDrawResults/10/1/1";
  const res = await axios.get(url, { timeout: 10000 });
  const draw = res.data.PreviousDraws[0];
  const parts = draw.WinningNumbers.split(" ").map(Number);
  return {
    numbers: parts.slice(0, 5),
    mega: parts[parts.length - 1],
    date: draw.DrawDate,
  };
}

// ─── BUILD WIN SMS FOR ONE USER ───────────────────────────────────────────────
function buildWinMessage(draw, ticketResults, totalWon) {
  const date = new Date(draw.date).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric"
  });
  const lines = ticketResults
    .filter(r => r.prize > 0)
    .map((r, i) => `Ticket ${i + 1}: $${r.prize.toLocaleString()} (${r.matched} match${r.megaMatch ? "+Mega" : ""})`);

  return [
    `SuperLotto Plus Winner Alerts: YOU WON! ${date}`,
    `Winning: ${draw.numbers.join("-")} Mega:${draw.mega}`,
    ``,
    lines.join("\n"),
    ``,
    `Total: $${totalWon.toLocaleString()}`,
    `Check your ticket and claim with the CA Lottery. Official results are final.`,
    `Reply STOP to opt out.`,
  ].join("\n");
}

// ─── SEND SMS ─────────────────────────────────────────────────────────────────
async function sendSms(toPhone, message) {
  return client.messages.create({
    body: message,
    from: TWILIO_FROM_NUMBER,
    to: `+1${toPhone}`,
  });
}

// ─── MAIN: CHECK ALL USERS & NOTIFY WINNERS ──────────────────────────────────
async function checkAllUsersAndNotify() {
  console.log(`\n[${new Date().toLocaleString()}] Running draw check...`);

  let draw;
  try {
    draw = await fetchLatestDrawing();
    console.log(`Draw: ${draw.numbers.join("-")} Mega:${draw.mega} (${draw.date})`);
  } catch (err) {
    console.error("Could not fetch draw results:", err.message);
    return;
  }

  const users = loadUsers();
  const phones = Object.keys(users);
  console.log(`Checking ${phones.length} registered users...`);

  let winnersCount = 0;

  for (const phone of phones) {
    const user = users[phone];
    if (!user.active) continue; // skip cancelled subscriptions

    const ticketResults = user.tickets.map(t => checkTicket(t, draw));
    const totalWon = ticketResults.reduce((s, r) => s + r.prize, 0);

    if (totalWon > 0) {
      // Only text if they won!
      try {
        const message = buildWinMessage(draw, ticketResults, totalWon);
        await sendSms(phone, message);
        console.log(`✓ Texted winner: ***${phone.slice(-4)} — won $${totalWon}`);
        winnersCount++;
      } catch (err) {
        console.error(`Failed to text ${phone.slice(-4)}:`, err.message);
      }
    }
  }

  console.log(`Done. ${winnersCount} winner(s) notified out of ${phones.length} users.`);
}

// ─── SCHEDULE: Every Wed & Sat at 8:45 PM Pacific ────────────────────────────
cron.schedule("45 20 * * 3,6", checkAllUsersAndNotify, {
  timezone: "America/Los_Angeles"
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// User registers their phone + tickets
app.post("/register", (req, res) => {
  const { phone, tickets } = req.body;
  if (!phone || !tickets || !Array.isArray(tickets)) {
    return res.status(400).json({ error: "Phone and tickets are required." });
  }
  const users = loadUsers();
  users[phone] = {
    tickets,
    registeredAt: new Date().toISOString(),
    active: true,
  };
  saveUsers(users);
  console.log(`New user registered: ***${phone.slice(-4)} with ${tickets.length} ticket(s)`);
  res.json({ success: true, message: "Registered! You'll be texted only when you win." });
});

// User updates their ticket numbers
app.post("/update-tickets", (req, res) => {
  const { phone, tickets } = req.body;
  if (!phone || !tickets) {
    return res.status(400).json({ error: "Phone and tickets are required." });
  }
  const users = loadUsers();
  if (!users[phone]) {
    return res.status(404).json({ error: "Phone not registered. Please register first." });
  }
  users[phone].tickets = tickets;
  users[phone].updatedAt = new Date().toISOString();
  saveUsers(users);
  console.log(`Updated tickets for ***${phone.slice(-4)}`);
  res.json({ success: true, message: "Tickets updated!" });
});

// User cancels (e.g. cancelled subscription)
app.post("/cancel", (req, res) => {
  const { phone } = req.body;
  const users = loadUsers();
  if (users[phone]) {
    users[phone].active = false;
    saveUsers(users);
  }
  res.json({ success: true });
});

// Admin: manually trigger a draw check (for testing)
app.get("/check-now", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ status: "Checking now — winners will be texted shortly!" });
  await checkAllUsersAndNotify();
});

// Admin: see how many users are registered
app.get("/stats", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const users = loadUsers();
  const active = Object.values(users).filter(u => u.active).length;

  // Apple's Small Business Program was submitted 2026-09-12.
  // Approval + the 15% rate typically take effect on Apple's next fiscal
  // period boundary after approval — update this date once you get the
  // approval email, then the calc below switches automatically.
  const APPLE_SMALL_BIZ_EFFECTIVE_DATE = null; // e.g. new Date("2026-10-01") once approved
  const APPLE_RATE = (APPLE_SMALL_BIZ_EFFECTIVE_DATE && new Date() >= APPLE_SMALL_BIZ_EFFECTIVE_DATE)
    ? 0.15
    : 0.30;
  const netPerUser = 2.99 * (1 - APPLE_RATE);

  res.json({
    totalUsers: Object.keys(users).length,
    activeSubscribers: active,
    estimatedAnnualRevenue: `$${(active * netPerUser).toFixed(2)}`,
  });
});

// Privacy policy
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "privacy.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "running", schedule: "Wed & Sat 8:45 PM PT" });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`SuperLotto Plus server running on port ${process.env.PORT || 3000}`);
  console.log("Schedule: Wednesdays & Saturdays at 8:45 PM Pacific");
});
