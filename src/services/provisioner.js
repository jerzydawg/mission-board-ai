import { readFileSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { createInstance, deleteInstance, listInstances, updateInstance, getInstance } from "./vultr-api.js";
import { sendTelegramMessage } from "./telegram.js";
import crypto from "crypto";

const FOUNDER_TELEGRAM_ID = process.env.FOUNDER_TELEGRAM_ID || "262207319";
const POOL_PREFIX = "md-pool-warm-";
const POOL_SIZE = 2;

function backupCustomerEnv(customerId, envVars) {
  try {
    const dir = `/root/mrdelegate-secrets/customers/${customerId}`;
    mkdirSync(dir, { recursive: true });
    chmodSync("/root/mrdelegate-secrets/customers", 0o700);
    const content = Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`).join("\n");
    writeFileSync(`${dir}/env.conf`, `[Service]\n${content}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`[provisioner] WARNING: Failed to backup env for ${customerId}:`, err.message);
  }
}

function generateToken(length = 48) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

function buildCloudInit(customer) {
  let template = readFileSync("/root/mrdelegate/provisioning/cloud-init-template.sh", "utf-8");
  const gatewayToken = generateToken(64);
  const platformKimiKey = process.env.PLATFORM_KIMI_KEY || "";
  const vultrInferenceKey = process.env.VULTR_INFERENCE_KEY || "";
  let platformSshPubKey = "";
  try { platformSshPubKey = readFileSync("/root/.ssh/mrdelegate-vps.pub", "utf-8").trim(); } catch {}
  const customerSubdomain = (customer.email.split("@")[0] || "customer").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "customer";
  return template
    .replace(/\${PLATFORM_SSH_PUBLIC_KEY}/g, platformSshPubKey)
    .replace(/\${CUSTOMER_ID}/g, customer.stripe_customer_id || customer.stripeCustomerId)
    .replace(/\$\{CUSTOMER_EMAIL\}/g, customer.email)
    .replace(/\$\{CUSTOMER_NAME\}/g, customer.name || customer.email.split("@")[0])
    .replace(/\$\{GATEWAY_TOKEN\}/g, gatewayToken)
    .replace(/\$\{MRDELEGATE_DOMAIN\}/g, "mrdelegate.ai")
    .replace(/\$\{PLATFORM_KIMI_KEY\}/g, platformKimiKey)
    .replace(/\${CUSTOMER_SUBDOMAIN}/g, customerSubdomain)
    .replace(/\$\{VULTR_INFERENCE_KEY\}/g, vultrInferenceKey);
}

async function getPoolInstances() {
  const all = await listInstances();
  return (all || []).filter((i) => i.label?.startsWith(POOL_PREFIX));
}

async function claimFromPool(newLabel) {
  const pool = await getPoolInstances();
  if (pool.length === 0) return null;
  const warm = pool[0];
  console.log(`[provisioner] Claiming ${warm.label} from pool → ${newLabel}`);
  await updateInstance(warm.id, { label: newLabel });
  return await getInstance(warm.id);
}

async function refillPool() {
  try {
    const pool = await getPoolInstances();
    const needed = POOL_SIZE - pool.length;
    if (needed <= 0) return;
    console.log(`[provisioner] Refilling pool: adding ${needed}`);
    for (let i = 0; i < needed; i++) {
      await createInstance({ label: `${POOL_PREFIX}${pool.length + i + 1}`, region: "ewr", plan: "vc2-1c-2gb" });
    }
  } catch (err) {
    console.error(`[provisioner] Pool refill failed:`, err.message);
  }
}

export async function provisionVPS(customer) {
  const stripeCustomerId = customer.stripe_customer_id || customer.stripeCustomerId || customer.id;
  if (!stripeCustomerId) throw new Error(`Customer ${customer.email} has no stripe_customer_id`);
  const label = `md-${stripeCustomerId.slice(-8)}`;
  console.log(`[provisioner] Creating VPS for ${customer.email} (label: ${label})`);
  
  let instance = await claimFromPool(label);
  if (instance) {
    console.log(`[provisioner] VPS from pool: ${instance.main_ip}`);
  } else {
    console.log(`[provisioner] Pool empty — creating fresh VPS`);
    const userData = buildCloudInit(customer);
    instance = await createInstance({ label, region: "ewr", plan: "vc2-1c-2gb", userData });
  }
  
  const gatewayToken = generateToken(64);
  backupCustomerEnv(stripeCustomerId, {
    CUSTOMER_ID: stripeCustomerId,
    CUSTOMER_EMAIL: customer.email,
    VULTR_INSTANCE_ID: instance.id,
    GATEWAY_TOKEN: gatewayToken,
    PROVISIONED_AT: new Date().toISOString(),
  });
  
  refillPool().catch((err) => console.error(`[provisioner] Background refill error:`, err.message));
  return instance;
}

export async function deprovisionVPS(customer) {
  const instanceId = customer.vultrInstanceId || customer.vultr_instance_id;
  if (!instanceId) return;
  console.log(`[provisioner] Deprovisioning VPS ${instanceId} for ${customer.email}`);
  await sendTelegramMessage(FOUNDER_TELEGRAM_ID, `⚠️ Deprovisioning VPS for ${customer.email}`).catch(() => {});
  await deleteInstance(instanceId);
}
