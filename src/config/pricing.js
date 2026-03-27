/**
 * MrDelegate Pricing Configuration
 * Update Price IDs when Stripe products are created
 */

export const PRICING_TIERS = {
  starter: {
    name: 'Starter',
    price: 29,
    priceId: process.env.STRIPE_PRICE_STARTER || null,
    features: [
      '1 vCPU',
      '1GB RAM',
      '25GB SSD',
      'Email support',
      '99.5% uptime SLA'
    ],
    resources: { vcpu: 1, ram: 1, disk: 25 }
  },
  pro: {
    name: 'Pro',
    price: 49,
    priceId: process.env.STRIPE_PRICE_PRO || null,
    popular: true,
    features: [
      '2 vCPU',
      '4GB RAM',
      '50GB SSD',
      'Priority support',
      '99.9% uptime SLA',
      'Custom domain'
    ],
    resources: { vcpu: 2, ram: 4, disk: 50 }
  },
  business: {
    name: 'Business',
    price: 99,
    priceId: process.env.STRIPE_PRICE_BUSINESS || null,
    features: [
      '4 vCPU',
      '8GB RAM',
      '100GB SSD',
      'Priority support',
      '99.95% uptime SLA',
      'Custom domain',
      'API access',
      'Team management'
    ],
    resources: { vcpu: 4, ram: 8, disk: 100 }
  },
  enterprise: {
    name: 'Enterprise',
    price: 199,
    priceId: process.env.STRIPE_PRICE_ENTERPRISE || null,
    features: [
      '8 vCPU',
      '16GB RAM',
      '200GB SSD',
      'Dedicated support',
      '99.99% uptime SLA',
      'Custom domain',
      'API access',
      'Team management',
      'White-label',
      'Custom integrations'
    ],
    resources: { vcpu: 8, ram: 16, disk: 200 }
  }
};

export function getPriceId(tier) {
  const plan = PRICING_TIERS[tier];
  if (!plan || !plan.priceId) {
    throw new Error(`Invalid tier or missing price ID: ${tier}`);
  }
  return plan.priceId;
}

export function getTierByPriceId(priceId) {
  for (const [key, tier] of Object.entries(PRICING_TIERS)) {
    if (tier.priceId === priceId) return { key, ...tier };
  }
  return null;
}

export default PRICING_TIERS;
