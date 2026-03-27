import { readFileSync, writeFileSync, existsSync } from 'fs';

const DB_PATH = '/root/mrdelegate/platform/data/customers.json';

function loadDb() {
  if (!existsSync(DB_PATH)) return { customers: [] };
  return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
}

function saveDb(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export const db = {
  addCustomer(customer) {
    const data = loadDb();
    data.customers.push(customer);
    saveDb(data);
    return customer;
  },

  updateCustomer(stripeCustomerId, updates) {
    const data = loadDb();
    const idx = data.customers.findIndex(c => c.stripeCustomerId === stripeCustomerId);
    if (idx === -1) return null;
    data.customers[idx] = { ...data.customers[idx], ...updates };
    saveDb(data);
    return data.customers[idx];
  },

  getCustomerByStripeId(stripeCustomerId) {
    return loadDb().customers.find(c => c.stripeCustomerId === stripeCustomerId) || null;
  },

  getCustomerBySubscription(subscriptionId) {
    return loadDb().customers.find(c => c.stripeSubscriptionId === subscriptionId) || null;
  },

  getCustomerByEmail(email) {
    return loadDb().customers.find(c => c.email === email) || null;
  },

  getAllCustomers() {
    return loadDb().customers;
  },
};
