/**
 * seed-plans.js
 * Run once to pre-create the four monthly plans in Razorpay
 * and print the plan IDs for your .env file.
 * Usage: node seed-plans.js
 
 */

require("dotenv").config();
const Razorpay = require("razorpay");
const fs = require("fs");
const path = require("path");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const plans = [
  { key: "SUPPORTER", label: "Supporter", amount: 10000,  description: "Help feed a rescued animal every month" },
  { key: "RESCUER",   label: "Rescuer",   amount: 50000,  description: "Fund emergency medical care for injured strays" },
  { key: "GUARDIAN",  label: "Guardian",  amount: 100000, description: "Sponsor a sterilisation + vaccination drive" },
  { key: "CHAMPION",  label: "Champion",  amount: 500000, description: "Sustain an entire wing's monthly operations" },
];

async function seedPlans() {
  console.log("🌱 Seeding Razorpay plans for Animals With Humanity...\n");

  const results = {};

  for (const p of plans) {
    try {
      const plan = await razorpay.plans.create({
        period: "monthly",
        interval: 1,
        item: {
          name: `AWH Monthly – ${p.label} (₹${p.key})`,
          amount: p.amount,
          currency: "INR",
          description: p.description,
        },
        notes: {
          org: "Animals With Humanity",
          plan_key: p.key,
        },
      });

      results[p.key] = plan.id;
      console.log(`✅ Created plan ₹${p.key} (${p.label}): ${plan.id}`);
    } catch (err) {
      console.error(`❌ Failed to create plan ₹${p.key}: ${err.message}`);
    }
  }

  // Update .env file with plan IDs
  const envPath = path.join(__dirname, ".env");
  let envContent = "";

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
  } else {
    envContent = fs.readFileSync(path.join(__dirname, ".env.example"), "utf-8");
  }

  for (const [key, planId] of Object.entries(results)) {
    const envKey = `PLAN_ID_${key}`;
    if (envContent.includes(`${envKey}=`)) {
      envContent = envContent.replace(new RegExp(`${envKey}=.*`), `${envKey}=${planId}`);
    } else {
      envContent += `\n${envKey}=${planId}`;
    }
  }

  fs.writeFileSync(envPath, envContent);
  console.log("\n✅ Plan IDs written to .env");
  console.log("\nPlan IDs summary:");
  for (const [key, planId] of Object.entries(results)) {
    console.log(`  PLAN_ID_${key}=${planId}`);
  }
}

seedPlans().catch(console.error);
