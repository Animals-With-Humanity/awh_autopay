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
 *   fundraisers/{id}             — campaign goal + raised totals
 *   fundraiser_donors/{id}       — donor name/email/contact stored before payment
 *   donations/{order_id}         — one-time Razorpay order for a campaign
 *   custom_plans/{amountPaise}   — reused Razorpay plan id per custom monthly amount
 */

"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  try {
    serviceAccount = require("./serviceAccountKey.json");
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT from env or load serviceAccountKey.json:", err.message);
    process.exit(1);
  }
}

/* ── Validate critical env vars on startup ─────────────────────────── */
const REQUIRED_ENV = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
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
  key_id: process.env.RAZORPAY_KEY_ID,9999-999-AA-99
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
    key: "virtualAdoptor",
    label: "Virtual Adoptor",
    amount: 209900,   // ₹2099 
    description: "Virtual Adopt a rescued animal every month",
    perks: ["Virtual Adopt a rescued animal/month", "Monthly impact email", "Digital gratitude card", "Virtual Adoptor certificate"],
    emoji: "🐱",
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

/* Custom monthly autopay: multiples of ₹500. One Razorpay plan per amount, reused. */
const CUSTOM_AUTOPAY = {
  minInr: 500,
  stepInr: 500,
  maxInr: 20000,
};

/* ── One-time fundraiser catalogue (goal tracker, like Razorpay Payment Pages) ── */
const FUNDRAISERS = {
  lalita: {
    id: "lalita",
    title: "Help Lalita Walk Again",
    goalPaise: 4500000, // ₹45,000
    minDonationPaise: 100, // ₹1 — Razorpay's technical floor, no extra lower limit
    maxDonationPaise: 20000000, // ₹2,00,000 per donation
    suggestedAmountsInr: [500, 1000, 2100, 5000],
  },
};

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

function validateCustomAmountInr(amountInr) {
  const amountRupees = Number(amountInr);
  if (!Number.isFinite(amountRupees) || !Number.isInteger(amountRupees)) {
    return { ok: false, error: "Custom amount must be a whole number in rupees" };
  }
  if (amountRupees < CUSTOM_AUTOPAY.minInr) {
    return { ok: false, error: `Minimum custom amount is ₹${CUSTOM_AUTOPAY.minInr}` };
  }
  if (amountRupees > CUSTOM_AUTOPAY.maxInr) {
    return { ok: false, error: `Maximum custom amount is ₹${CUSTOM_AUTOPAY.maxInr.toLocaleString("en-IN")}` };
  }
  if (amountRupees % CUSTOM_AUTOPAY.stepInr !== 0) {
    return { ok: false, error: `Custom amount must be a multiple of ₹${CUSTOM_AUTOPAY.stepInr}` };
  }
  return { ok: true, amountRupees, amountPaise: amountRupees * 100 };
}

/**
 * Reuse a Razorpay plan for this exact custom amount.
 * Creates one only if Firestore has no plan_id for that amount yet.
 * Plans cannot be deleted in Razorpay, so we never create a second one on purpose.
 */
async function getOrCreateCustomPlan(amountPaise, amountInr) {
  const ref = db.collection("custom_plans").doc(String(amountPaise));
  const existing = await ref.get();
  if (existing.exists && existing.data().razorpayPlanId) {
    return { planId: existing.data().razorpayPlanId, created: false };
  }

  const plan = await razorpay.plans.create({
    period: "monthly",
    interval: 1,
    item: {
      name: `AWH Monthly – Custom ₹${amountInr}`,
      amount: amountPaise,
      currency: "INR",
      description: `Custom monthly support of ₹${amountInr}`,
    },
    notes: {
      org: "Animals With Humanity",
      plan_key: "custom",
      amount_inr: String(amountInr),
    },
  });

  try {
    await ref.create({
      amountPaise,
      amountInr,
      razorpayPlanId: plan.id,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (_err) {
    // Concurrent first request already saved a plan for this amount — reuse that one
    const raced = await ref.get();
    if (raced.exists && raced.data().razorpayPlanId) {
      return { planId: raced.data().razorpayPlanId, created: false };
    }
  }

  return { planId: plan.id, created: true };
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
    custom_enabled: true,
    custom: {
      min_inr: CUSTOM_AUTOPAY.minInr,
      step_inr: CUSTOM_AUTOPAY.stepInr,
      max_inr: CUSTOM_AUTOPAY.maxInr,
    },
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
    const { planKey, name, email, contact, amountInr } = req.body;
    const isCustom = planKey === "custom";

    /* ── Input validation ─────────────────────────────────────────── */
    if (!planKey || !name || !email || !contact) {
      return res.status(400).json({ success: false, error: "Missing required fields: planKey, name, email, contact" });
    }
    if (!isCustom && !PLAN_MAP[planKey]) {
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

    let amountPaise;
    let planLabel;
    let storedPlanKey = planKey;
    if (isCustom) {
      const customCheck = validateCustomAmountInr(amountInr);
      if (!customCheck.ok) {
        return res.status(400).json({ success: false, error: customCheck.error });
      }
      amountPaise = customCheck.amountPaise;
      planLabel = `Custom ₹${customCheck.amountRupees.toLocaleString("en-IN")}`;
      // Same query shape as named plans (email + planKey) — no extra Firestore index
      storedPlanKey = `custom_${customCheck.amountRupees}`;
    } else {
      amountPaise = PLAN_MAP[planKey].amount;
      planLabel = PLAN_MAP[planKey].label;
    }

    /* ── Idempotency check: already have a pending sub for this user? ── */
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    const existingSnap = await db.collection("subscriptions")
      .where("email", "==", email.toLowerCase())
      .where("planKey", "==", storedPlanKey)
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
        amount_inr: amountPaise / 100,
        razorpay_key: process.env.RAZORPAY_KEY_ID,
        prefill: { name, email, contact: normalizedContact },
        reused: true,
      });
    }

    /* ── Also block if user already has an ACTIVE subscription for this plan ── */
    const activeSnap = await db.collection("subscriptions")
      .where("email", "==", email.toLowerCase())
      .where("planKey", "==", storedPlanKey)
      .where("status", "==", "active")
      .limit(1)
      .get();

    if (!activeSnap.empty) {
      return res.status(409).json({
        success: false,
        error: "You already have an active subscription for this plan.",
      });
    }

    /* ── Resolve Razorpay plan (named from .env, custom reused from Firestore) ── */
    let planId;
    if (isCustom) {
      const customPlan = await getOrCreateCustomPlan(amountPaise, amountPaise / 100);
      planId = customPlan.planId;
      log("info", "Custom plan resolved", { amountPaise, planId, created: customPlan.created });
    } else {
      console.log("planKey", planKey);
      planId = await getPlanId(planKey);
      console.log("planId", planId);
    }

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
        plan_key: storedPlanKey,
      },
    });

    /* ── Persist to Firestore ─────────────────────────────────────── */
    await db.collection("subscriptions").doc(subscription.id).set({
      subscriptionId: subscription.id,
      planKey: storedPlanKey,
      planLabel,
      amountPaise,
      name: name.trim(),
      email: email.toLowerCase(),
      contact: normalizedContact,
      status: "created",   // Razorpay initial state
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    log("info", "Subscription created", { subId: subscription.id, planKey: storedPlanKey });

    res.json({
      success: true,
      subscription_id: subscription.id,
      planKey,
      amount_inr: amountPaise / 100,
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

/* ── Fundraiser helpers ────────────────────────────────────────────── */
async function ensureFundraiserDoc(campaign) {
  const ref = db.collection("fundraisers").doc(campaign.id);
  const snap = await ref.get();
  if (!snap.exists) {
    try {
      await ref.create({
        campaignId: campaign.id,
        title: campaign.title,
        goalPaise: campaign.goalPaise,
        raisedPaise: 0,
        donorCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (_err) {
      // Concurrent first request already created the doc — safe to continue
    }
  }
  return ref;
}

function formatFundraiser(campaign, data) {
  const goalPaise = campaign.goalPaise;
  const raisedPaise = Number(data?.raisedPaise || 0);
  const remainingPaise = Math.max(0, goalPaise - raisedPaise);
  const percent = goalPaise > 0 ? Math.min(100, Math.round((raisedPaise / goalPaise) * 1000) / 10) : 0;
  return {
    id: campaign.id,
    title: campaign.title,
    goal_inr: goalPaise / 100,
    raised_inr: raisedPaise / 100,
    remaining_inr: remainingPaise / 100,
    percent,
    donor_count: Number(data?.donorCount || 0),
    min_donation_inr: campaign.minDonationPaise / 100,
    suggested_amounts: campaign.suggestedAmountsInr,
  };
}

/**
 * Records a captured fundraiser payment once.
 * payments/{paymentId} is the idempotency key so checkout verify and
 * payment.captured webhook cannot double-count the same donation.
 */
async function recordFundraiserCapture({ paymentId, orderId, amountPaise, source }) {
  const paymentRef = db.collection("payments").doc(paymentId);
  const donationRef = db.collection("donations").doc(orderId);

  return db.runTransaction(async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (paymentSnap.exists) {
      return { alreadyRecorded: true };
    }

    const donationSnap = await tx.get(donationRef);
    if (!donationSnap.exists) {
      return { notADonation: true };
    }

    const donation = donationSnap.data();
    const campaignId = donation.campaignId;
    const incrementPaise = Number(donation.amountPaise || amountPaise || 0);
    const fundraiserRef = db.collection("fundraisers").doc(campaignId);
    const fundraiserSnap = await tx.get(fundraiserRef);

    tx.set(paymentRef, {
      paymentId,
      orderId,
      campaignId,
      amount: incrementPaise,
      currency: "INR",
      source,
      verifiedAt: FieldValue.serverTimestamp(),
    });

    if (donation.status === "captured") {
      return { alreadyRecorded: true, campaignId };
    }

    tx.update(donationRef, {
      status: "captured",
      paymentId,
      capturedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (fundraiserSnap.exists) {
      tx.update(fundraiserRef, {
        raisedPaise: FieldValue.increment(incrementPaise),
        donorCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const campaign = FUNDRAISERS[campaignId];
      tx.set(fundraiserRef, {
        campaignId,
        title: campaign?.title || campaignId,
        goalPaise: campaign?.goalPaise || 0,
        raisedPaise: incrementPaise,
        donorCount: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    if (donation.donorDocId) {
      tx.set(
        db.collection("fundraiser_donors").doc(donation.donorDocId),
        {
          status: "paid",
          paymentId,
          orderId,
          paidAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return { alreadyRecorded: false, campaignId };
  });
}

/**
 * If checkout saved the donor but the donation doc is missing, rebuild it
 * from Razorpay payment notes so webhooks still count the payment.
 */
async function seedDonationFromPaymentNotes(orderId, paymentEntity) {
  const donationRef = db.collection("donations").doc(orderId);
  const snap = await donationRef.get();
  if (snap.exists) return true;

  const notes = paymentEntity?.notes || {};
  const campaignId = notes.campaign;
  if (!campaignId || !FUNDRAISERS[campaignId]) return false;

  await donationRef.set({
    orderId,
    campaignId,
    donorDocId: notes.donor_doc_id || "",
    amountPaise: Number(paymentEntity?.amount || 0),
    name: notes.donor_name || "",
    email: notes.donor_email || "",
    contact: notes.donor_contact || "",
    status: "created",
    source: "webhook_seeded",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return true;
}

async function captureFundraiserFromWebhook(paymentEntity, source) {
  const orderId = paymentEntity?.order_id;
  const paymentId = paymentEntity?.id;
  if (!orderId || !paymentId) return { skipped: true };

  await seedDonationFromPaymentNotes(orderId, paymentEntity);
  return recordFundraiserCapture({
    paymentId,
    orderId,
    amountPaise: paymentEntity?.amount,
    source,
  });
}

/* GET /fundraiser/:id ─────────────────────────────────────────────── */
app.get("/fundraiser/:id", async (req, res) => {
  try {
    const campaign = FUNDRAISERS[req.params.id];
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Fundraiser not found" });
    }

    const ref = await ensureFundraiserDoc(campaign);
    const snap = await ref.get();

    res.json({
      success: true,
      campaign: formatFundraiser(campaign, snap.data()),
    });
  } catch (err) {
    log("error", "get-fundraiser error", { message: err.message });
    res.status(500).json({ success: false, error: "Failed to load fundraiser" });
  }
});

/* POST /fundraiser/:id/donate ─────────────────────────────────────── */
/**
 * Stores donor name/email/contact in Firebase FIRST, then creates a
 * Razorpay order. Checkout happens only after this succeeds.
 */
app.post("/fundraiser/:id/donate", async (req, res) => {
  try {
    const campaign = FUNDRAISERS[req.params.id];
    if (!campaign) {
      return res.status(404).json({ success: false, error: "Fundraiser not found" });
    }

    const { name, email, contact, amountInr } = req.body;

    if (!name || !email || !contact || amountInr === undefined || amountInr === null) {
      return res.status(400).json({ success: false, error: "Missing required fields: name, email, contact, amountInr" });
    }
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100) {
      return res.status(400).json({ success: false, error: "Invalid name" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: "Invalid email address" });
    }
    const normalizedContact = String(contact).replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(normalizedContact)) {
      return res.status(400).json({ success: false, error: "Invalid contact number (must be 10-digit Indian mobile)" });
    }

    const amountRupees = Number(amountInr);
    if (!Number.isFinite(amountRupees) || !Number.isInteger(amountRupees)) {
      return res.status(400).json({ success: false, error: "Amount must be a whole number in rupees" });
    }
    const amountPaise = amountRupees * 100;
    if (amountPaise < campaign.minDonationPaise) {
      return res.status(400).json({
        success: false,
        error: `Minimum donation is ₹${campaign.minDonationPaise / 100}`,
      });
    }
    if (amountPaise > campaign.maxDonationPaise) {
      return res.status(400).json({
        success: false,
        error: `Maximum donation is ₹${(campaign.maxDonationPaise / 100).toLocaleString("en-IN")}`,
      });
    }

    await ensureFundraiserDoc(campaign);

    /* ── Store donor details BEFORE creating the Razorpay order ───── */
    const donorRef = db.collection("fundraiser_donors").doc();
    await donorRef.set({
      campaignId: campaign.id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      contact: normalizedContact,
      amountPaise,
      status: "intent",
      createdAt: FieldValue.serverTimestamp(),
    });

    const receipt = `lalita_${Date.now()}`.slice(0, 40);
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: {
        campaign: campaign.id,
        donor_name: name.trim(),
        donor_email: email.toLowerCase().trim(),
        donor_contact: normalizedContact,
        donor_doc_id: donorRef.id,
        org: "Animals With Humanity",
      },
    });

    await db.collection("donations").doc(order.id).set({
      orderId: order.id,
      campaignId: campaign.id,
      donorDocId: donorRef.id,
      amountPaise,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      contact: normalizedContact,
      status: "created",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await donorRef.update({
      orderId: order.id,
      updatedAt: FieldValue.serverTimestamp(),
    });

    log("info", "Fundraiser donation intent stored", { campaignId: campaign.id, orderId: order.id });

    res.json({
      success: true,
      order_id: order.id,
      amount_paise: amountPaise,
      amount_inr: amountRupees,
      razorpay_key: process.env.RAZORPAY_KEY_ID,
      prefill: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        contact: normalizedContact,
      },
    });
  } catch (err) {
    log("error", "create-donation error", { message: err.message });
    res.status(500).json({ success: false, error: "Failed to start donation. Please try again." });
  }
});

/* POST /verify-donation ───────────────────────────────────────────── */
app.post("/verify-donation", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: "Missing payment verification fields" });
    }

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const sigBuffer = Buffer.from(generatedSignature, "hex");
    const receivedBuffer = Buffer.from(razorpay_signature || "", "hex");
    const sigValid =
      sigBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(sigBuffer, receivedBuffer);

    if (!sigValid) {
      log("error", "Donation signature mismatch", { paymentId: razorpay_payment_id });
      return res.status(400).json({ success: false, error: "Payment verification failed" });
    }

    const donationSnap = await db.collection("donations").doc(razorpay_order_id).get();
    if (!donationSnap.exists) {
      return res.status(404).json({ success: false, error: "Donation order not found" });
    }

    const result = await recordFundraiserCapture({
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amountPaise: donationSnap.data().amountPaise,
      source: "checkout_verify",
    });

    log("info", "Donation verified", {
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      reused: !!result.alreadyRecorded,
    });

    res.json({ success: true, message: result.alreadyRecorded ? "Payment already verified" : "Payment verified" });
  } catch (err) {
    log("error", "verify-donation error", { message: err.message });
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

      case "payment.captured":
      case "order.paid": {
        // Ticket-booking pattern: webhook is the backup for checkout verify.
        // order.paid and payment.captured both mean money was captured.
        // Subscription charges also emit these; capture no-ops unless notes.campaign
        // or a donations/{orderId} doc identifies a fundraiser payment.
        const orderEntity = data?.order?.entity;
        const capturePayment = paymentEntity || null;
        const orderId = capturePayment?.order_id || orderEntity?.id;
        const capturePaymentId = capturePayment?.id || paymentId;
        if (!capturePaymentId || !orderId) break;

        const result = await captureFundraiserFromWebhook(
          capturePayment || { id: capturePaymentId, order_id: orderId, amount: orderEntity?.amount_paid, notes: orderEntity?.notes },
          event === "order.paid" ? "webhook_order_paid" : "webhook_captured"
        );
        if (result.notADonation || result.skipped) {
          log("info", `${event} ignored (not a fundraiser order)`, { paymentId: capturePaymentId, orderId });
        } else {
          log("info", "Fundraiser payment captured", {
            paymentId: capturePaymentId,
            orderId,
            event,
            reused: !!result.alreadyRecorded,
          });
        }
        break;
      }

      case "payment.failed": {
        const orderId = paymentEntity?.order_id;
        if (!orderId) break;
        const donationRef = db.collection("donations").doc(orderId);
        const donationSnap = await donationRef.get();
        if (!donationSnap.exists) break;
        if (donationSnap.data().status === "captured") break;
        await donationRef.update({
          status: "failed",
          failureReason: paymentEntity?.error_description || "Payment failed",
          updatedAt: FieldValue.serverTimestamp(),
        });
        log("info", "Fundraiser payment failed", { orderId, paymentId });
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