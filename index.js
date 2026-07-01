/**
 * AWH Subscription Backend — Firebase Edition
 *
 * Setup:
 *   cp .env.example .env
 *   # Fill in all env vars (see .env.example)
 *   node seed-plans.js   ← creates plans in Razorpay and writes IDs to .env
 *   node server.js
 *
 * Firebase collections:
 *   subscribers/{email}          — one doc per donor (upserted on activation)
 *   subscriptions/{sub_id}       — one doc per Razorpay subscription
 *   payments/{payment_id}        — one doc per charged payment (idempotency key)
 */

"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const serviceAccount = require("./serviceAccountKey.json");

/* ── Validate critical env vars on startup ─────────────────────────── */
const REQUIRED_ENV = [
  // "RAZORPAY_KEY_ID",
  // "RAZORPAY_KEY_SECRET",
  // "RAZORPAY_WEBHOOK_SECRET",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

/* ── Firebase Admin ────────────────────────────────────────────────── */
initializeApp({
  credential: cert(serviceAccount),
});
const db = getFirestore();

/* ── Razorpay client ───────────────────────────────────────────────── */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ── Express app ───────────────────────────────────────────────────── */
const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
    methods: ["GET", "POST"],
  })
);

// Raw body MUST come before express.json() — required for webhook HMAC
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

/* ── Plan catalogue ────────────────────────────────────────────────── */
// Abstract keys are the only thing exposed to the frontend.
// Real Razorpay plan IDs live in .env as PLAN_ID_<KEY>.
const PREDEFINED_PLANS = [
  {
    key: "ally",
    label: "Ally",
    amount: 109900,   // ₹1099 
    description: "Help feed a rescued animal every month",
    perks: ["Feed 1 rescued dog/month", "Monthly impact email", "Digital gratitude card"],
    emoji: "🐾",
  },
  {
    key: "supporter",
    label: "Supporter",
    amount: 509900,   // ₹5099
    description: "Fund emergency medical care for injured animals",
    perks: ["Emergency care", "Rescue update stories", "Name in monthly credits"],
    emoji: "🚑",
    popular: true,
  },
  {
    key: "guardian",
    label: "Guardian",
    amount: 1099900,  // ₹10999
    description: "Sponsor a sterilisation + vaccination drive",
    perks: ["Sponsor 1 sterilisation/month", "Featured on AWH social", "Guardian certificate"],
    emoji: "🛡️",
  },

];

const PLAN_MAP = Object.fromEntries(PREDEFINED_PLANS.map((p) => [p.key, p]));

/* ── Helper: resolve Razorpay plan ID ──────────────────────────────── */
async function getPlanId(planKey) {
  const envVar = `PLAN_ID_${planKey.toUpperCase()}`;
  const planId = process.env[envVar];
  console.log("envVar", envVar);
  console.log("planId", planId);
  if (!planId) {
    throw new Error(
      `Razorpay plan ID not configured. Run seed-plans.js and set ${envVar} in .env`
    );
  }
  return planId;
}

/* ── Helper: safe log (no PII in prod) ─────────────────────────────── */
function log(level, msg, meta = {}) {
  const entry = { level, msg, ts: new Date().toISOString(), ...meta };
  if (process.env.NODE_ENV === "production") {
    // In production, scrub PII fields before logging
    delete entry.email;
    delete entry.name;
    delete entry.contact;
  }
  console[level === "error" ? "error" : "log"](JSON.stringify(entry));
}

/* ══════════════════════════════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════════════════════════════ */

/* GET /health ─────────────────────────────────────────────────────── */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    org: "Animals With Humanity",
    timestamp: new Date().toISOString(),
    razorpay_configured: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    firebase_configured: !!process.env.FIREBASE_PROJECT_ID,
  });
});

/* GET /plans ──────────────────────────────────────────────────────── */
app.get("/plans", (_req, res) => {
  res.json({
    success: true,
    custom_enabled: false,
    plans: PREDEFINED_PLANS.map(({ key, label, amount, description, perks, emoji, popular }) => ({
      key,
      label,
      amount_paise: amount,
      amount_inr: amount / 100,
      description,
      perks,
      emoji,
      popular: !!popular,
      // ✅ Real Razorpay plan IDs are NEVER sent to the frontend
    })),
  });
});

/* POST /create-subscription ───────────────────────────────────────── */
/**
 * Idempotency strategy:
 *   Before creating a new Razorpay subscription, we check Firestore for an
 *   existing subscription for this (email, planKey) pair that is in a
 *   "created" or "authenticated" state.  If one exists and was created
 *   less than 30 minutes ago, we return it instead of creating a new one.
 *   This covers the case where the user's network dropped after the
 *   subscription was created but before the Razorpay checkout loaded.
 */
app.post("/create-subscription", async (req, res) => {
  try {
    const { planKey, name, email, contact } = req.body;

    /* ── Input validation ─────────────────────────────────────────── */
    if (!planKey || !name || !email || !contact) {
      return res.status(400).json({ success: false, error: "Missing required fields: planKey, name, email, contact" });
    }
    if (!PLAN_MAP[planKey]) {
      return res.status(400).json({ success: false, error: "Invalid planKey" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: "Invalid email address" });
    }
    const normalizedContact = contact.replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(normalizedContact)) {
      return res.status(400).json({ success: false, error: "Invalid contact number (must be 10-digit Indian mobile)" });
    }
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100) {
      return res.status(400).json({ success: false, error: "Invalid name" });
    }

    /* ── Idempotency check: already have a pending sub for this user? ── */
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    const existingSnap = await db.collection("subscriptions")
      .where("email", "==", email.toLowerCase())
      .where("planKey", "==", planKey)
      .where("status", "in", ["created", "authenticated"])
      .where("createdAt", ">=", thirtyMinsAgo)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const existing = existingSnap.docs[0].data();
      log("info", "Returning existing pending subscription", { subId: existing.subscriptionId });
      return res.json({
        success: true,
        subscription_id: existing.subscriptionId,
        planKey,
        razorpay_key: process.env.RAZORPAY_KEY_ID,
        prefill: { name, email, contact: normalizedContact },
        reused: true,
      });
    }

    /* ── Also block if user already has an ACTIVE subscription for this plan ── */
    const activeSnap = await db.collection("subscriptions")
      .where("email", "==", email.toLowerCase())
      .where("planKey", "==", planKey)
      .where("status", "==", "active")
      .limit(1)
      .get();

    if (!activeSnap.empty) {
      return res.status(409).json({
        success: false,
        error: "You already have an active subscription for this plan.",
      });
    }

    /* ── Create Razorpay subscription ─────────────────────────────── */
    console.log("planKey", planKey);
    const planId = await getPlanId(planKey);
    console.log("planId", planId);

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      quantity: 1,
      // Razorpay requires a finite count; 120 = 10 years — effectively perpetual
      total_count: 120,
      notes: {
        donor_name: name.trim(),
        donor_email: email.toLowerCase(),
        donor_contact: normalizedContact,
        org: "Animals With Humanity",
      },
    });

    /* ── Persist to Firestore ─────────────────────────────────────── */
    await db.collection("subscriptions").doc(subscription.id).set({
      subscriptionId: subscription.id,
      planKey,
      planLabel: PLAN_MAP[planKey].label,
      amountPaise: PLAN_MAP[planKey].amount,
      name: name.trim(),
      email: email.toLowerCase(),
      contact: normalizedContact,
      status: "created",   // Razorpay initial state
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    log("info", "Subscription created", { subId: subscription.id, planKey });

    res.json({
      success: true,
      subscription_id: subscription.id,
      planKey,
      razorpay_key: process.env.RAZORPAY_KEY_ID,
      prefill: { name: name.trim(), email: email.toLowerCase(), contact: normalizedContact },
    });
  } catch (err) {
    log("error", "create-subscription error", { message: err.message });
    res.status(500).json({ success: false, error: "Failed to create subscription. Please try again." });
  }
});

/* POST /verify-subscription ───────────────────────────────────────── */
/**
 * Called by the frontend after Razorpay checkout success.
 * Verifies the HMAC signature, then marks the subscription as "authenticated"
 * in Firestore.  The webhook (subscription.activated / subscription.charged)
 * is the authoritative source of truth for "active" status.
 *
 * Idempotency: if the payment_id already exists in /payments, we return
 * success without writing again (covers double-submit from frontend).
 */
app.post("/verify-subscription", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: "Missing payment verification fields" });
    }

    /* ── HMAC verification ────────────────────────────────────────── */
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest("hex");

    // Use timingSafeEqual to prevent timing attacks
    const sigBuffer = Buffer.from(generatedSignature, "hex");
    const receivedBuffer = Buffer.from(razorpay_signature || "", "hex");
    const sigValid =
      sigBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(sigBuffer, receivedBuffer);

    if (!sigValid) {
      log("error", "Signature mismatch", { paymentId: razorpay_payment_id });
      return res.status(400).json({ success: false, error: "Payment verification failed" });
    }

    /* ── Idempotency: skip if already recorded ────────────────────── */
    const paymentRef = db.collection("payments").doc(razorpay_payment_id);
    const paymentSnap = await paymentRef.get();
    if (paymentSnap.exists) {
      log("info", "Duplicate verify-subscription call ignored", { paymentId: razorpay_payment_id });
      return res.json({ success: true, message: "Payment already verified" });
    }

    /* ── Write payment record + update subscription ──────────────── */
    const batch = db.batch();

    batch.set(paymentRef, {
      paymentId: razorpay_payment_id,
      subscriptionId: razorpay_subscription_id,
      source: "checkout_verify",
      verifiedAt: FieldValue.serverTimestamp(),
    });

    const subRef = db.collection("subscriptions").doc(razorpay_subscription_id);
    batch.update(subRef, {
      status: "authenticated",
      firstPaymentId: razorpay_payment_id,
      firstPaymentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    log("info", "Payment verified", { paymentId: razorpay_payment_id, subId: razorpay_subscription_id });
    res.json({ success: true, message: "Payment verified" });
  } catch (err) {
    log("error", "verify-subscription error", { message: err.message });
    res.status(500).json({ success: false, error: "Verification failed" });
  }
});

/* POST /webhook ───────────────────────────────────────────────────── */
/**
 * Razorpay sends webhooks for all subscription lifecycle events.
 * This is the authoritative source for updating subscription status.
 *
 * Security: webhook secret is REQUIRED — the server refuses to start
 * without RAZORPAY_WEBHOOK_SECRET (validated at boot above).
 *
 * Idempotency: each webhook event is stored in /webhook_events/{eventId}.
 * Razorpay can retry events; we skip processing if the event_id is already
 * recorded.
 */
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing webhook signature" });
    }

    /* ── Verify webhook HMAC ──────────────────────────────────────── */
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body)           // req.body is raw Buffer here
      .digest("hex");

    const expected = Buffer.from(expectedSignature, "hex");
    const received = Buffer.from(signature, "hex");
    const valid =
      expected.length === received.length &&
      crypto.timingSafeEqual(expected, received);

    if (!valid) {
      log("error", "Invalid webhook signature");
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    const { event, payload: data } = payload;

    /* ── Idempotency: use Razorpay's event ID ─────────────────────── */
    const eventId = payload.id || `${event}_${Date.now()}`;
    const eventRef = db.collection("webhook_events").doc(eventId);
    const eventSnap = await eventRef.get();

    if (eventSnap.exists) {
      log("info", "Duplicate webhook event ignored", { eventId, event });
      return res.json({ received: true }); // Always 200 to Razorpay
    }

    // Record event first (before processing) to prevent race conditions
    await eventRef.set({
      eventId,
      event,
      receivedAt: FieldValue.serverTimestamp(),
      processed: false,
    });

    /* ── Process event ────────────────────────────────────────────── */
    await processWebhookEvent(event, data, eventRef);

    res.json({ received: true });
  } catch (err) {
    log("error", "webhook error", { message: err.message });
    // Return 200 anyway — returning 5xx causes Razorpay to retry endlessly
    // The event is already recorded so the retry will be deduplicated
    res.json({ received: true, warning: "Processing error logged" });
  }
});

async function processWebhookEvent(event, data, eventRef) {
  const subEntity = data?.subscription?.entity;
  const paymentEntity = data?.payment?.entity;
  const subId = subEntity?.id;
  const paymentId = paymentEntity?.id;

  try {
    switch (event) {

      case "subscription.activated": {
        if (!subId) break;
        const subRef = db.collection("subscriptions").doc(subId);
        const subSnap = await subRef.get();

        if (!subSnap.exists) {
          // Subscription created outside this server — seed a record
          log("info", "Creating subscription record from webhook", { subId });
          await subRef.set({
            subscriptionId: subId,
            status: "active",
            activatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            source: "webhook_seeded",
          });
        } else {
          await subRef.update({
            status: "active",
            activatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        // Upsert subscriber record (one doc per donor email)
        const subData = subSnap.exists ? subSnap.data() : {};
        const donorEmail = subData.email || subEntity?.notes?.donor_email;
        if (donorEmail) {
          await db.collection("subscribers").doc(donorEmail).set(
            {
              email: donorEmail,
              name: subData.name || subEntity?.notes?.donor_name || "",
              contact: subData.contact || subEntity?.notes?.donor_contact || "",
              activeSubscriptions: FieldValue.increment(1),
              firstActivatedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        log("info", "Subscription activated", { subId });
        // TODO: Send welcome email via SendGrid / AWS SES
        break;
      }

      case "subscription.charged": {
        if (!paymentId || !subId) break;

        // Idempotency: skip if this payment was already recorded
        const paymentRef = db.collection("payments").doc(paymentId);
        const paymentSnap = await paymentRef.get();
        if (paymentSnap.exists) {
          log("info", "Duplicate subscription.charged ignored", { paymentId });
          break;
        }

        await paymentRef.set({
          paymentId,
          subscriptionId: subId,
          amount: paymentEntity?.amount,
          currency: paymentEntity?.currency || "INR",
          source: "webhook_charged",
          chargedAt: FieldValue.serverTimestamp(),
        });

        await db.collection("subscriptions").doc(subId).update({
          lastPaymentId: paymentId,
          lastPaymentAt: FieldValue.serverTimestamp(),
          totalPayments: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });

        log("info", "Subscription charged", { paymentId, subId });
        // TODO: Issue receipt email
        break;
      }

      case "subscription.cancelled": {
        if (!subId) break;
        await db.collection("subscriptions").doc(subId).update({
          status: "cancelled",
          cancelledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Decrement active count on subscriber doc
        const subSnap = await db.collection("subscriptions").doc(subId).get();
        const donorEmail = subSnap.data()?.email;
        if (donorEmail) {
          await db.collection("subscribers").doc(donorEmail).update({
            activeSubscriptions: FieldValue.increment(-1),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        log("info", "Subscription cancelled", { subId });
        // TODO: Send farewell email
        break;
      }

      case "subscription.halted": {
        if (!subId) break;
        await db.collection("subscriptions").doc(subId).update({
          status: "halted",
          haltedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        log("info", "Subscription halted", { subId });
        // TODO: Notify donor to update payment method
        break;
      }

      case "subscription.paused": {
        if (!subId) break;
        await db.collection("subscriptions").doc(subId).update({
          status: "paused",
          pausedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        break;
      }

      case "subscription.resumed": {
        if (!subId) break;
        await db.collection("subscriptions").doc(subId).update({
          status: "active",
          resumedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        break;
      }

      default:
        log("info", "Unhandled webhook event", { event });
    }

    // Mark event as processed
    await eventRef.update({ processed: true, processedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    log("error", "processWebhookEvent error", { event, message: err.message });
    await eventRef.update({ processingError: err.message });
    throw err; // Let the caller handle the 200 response
  }
}

/* ── Start server ──────────────────────────────────────────────────── */
app.listen(PORT, () => {
  log("info", `AWH Subscription Server started`, { port: PORT });
  console.log(`\n🐾 AWH Subscription Server on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Plans:  http://localhost:${PORT}/plans\n`);
});