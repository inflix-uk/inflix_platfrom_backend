require('dotenv').config();
const connectDB = require('../config/db');
const FeatureCatalog = require('../models/FeatureCatalog');
const LimitCatalog = require('../models/LimitCatalog');
const PlanCatalog = require('../models/PlanCatalog');

const FEATURES = [
    { key: 'repairs', name: 'Repair Management', description: 'Repair tickets and workflow', category: 'Core', defaultEnabled: true, isActive: true },
    { key: 'reports', name: 'Reports', description: 'Dashboard and reports', category: 'Core', defaultEnabled: true, isActive: true },
    { key: 'inventory', name: 'Inventory', description: 'Products, categories, stock', category: 'Inventory', defaultEnabled: true, isActive: true },
    { key: 'printing', name: 'Printing', description: 'Receipt and invoice printing', category: 'Core', defaultEnabled: true, isActive: true },
    { key: 'stock_transfer', name: 'Stock Transfer', description: 'Transfer stock between locations', category: 'Inventory', defaultEnabled: true, isActive: true },
    { key: 'stock_adjustment', name: 'Stock Adjustment', description: 'Stock adjustments and write-offs', category: 'Inventory', defaultEnabled: true, isActive: true },
    { key: 'audit', name: 'Audit Log', description: 'Activity and audit log', category: 'Core', defaultEnabled: true, isActive: true },
    { key: 'sales', name: 'Sales', description: 'Standard sales flow (sales-online-orders + sales-return). Mutually exclusive with invoices.', category: 'Core', defaultEnabled: false, isActive: true },
    { key: 'invoices', name: 'Invoices', description: 'Separate invoice flow with tax categories (create-invoice + invoice-online-order). Mutually exclusive with sales.', category: 'Core', defaultEnabled: false, isActive: true }
];

const LIMITS = [
    { key: 'maxUsers', name: 'Max Users', description: 'Maximum number of users', unit: 'count', defaultValue: 10, isActive: true },
    { key: 'maxLocations', name: 'Max Locations', description: 'Maximum number of locations', unit: 'count', defaultValue: 5, isActive: true },
    { key: 'maxRepairsPerMonth', name: 'Max Repairs Per Month', description: 'Maximum repairs per calendar month', unit: 'count/month', defaultValue: 100, isActive: true }
];

const PLANS = [
    { planKey: 'starter', name: 'Starter', description: 'For small teams', priceMetadata: { monthly: 29, currency: 'GBP' }, features: { repairs: true, reports: true, inventory: true, printing: true, stock_transfer: false, stock_adjustment: true, audit: true, sales: true, invoices: false }, limits: { maxUsers: 3, maxLocations: 2, maxRepairsPerMonth: 50 }, isActive: true },
    { planKey: 'pro', name: 'Pro', description: 'For growing businesses', priceMetadata: { monthly: 79, currency: 'GBP' }, features: { repairs: true, reports: true, inventory: true, printing: true, stock_transfer: true, stock_adjustment: true, audit: true, sales: true, invoices: false }, limits: { maxUsers: 15, maxLocations: 10, maxRepairsPerMonth: 500 }, isActive: true },
    { planKey: 'enterprise', name: 'Enterprise', description: 'Unlimited', priceMetadata: { monthly: 199, currency: 'GBP' }, features: { repairs: true, reports: true, inventory: true, printing: true, stock_transfer: true, stock_adjustment: true, audit: true, sales: true, invoices: false }, limits: { maxUsers: null, maxLocations: null, maxRepairsPerMonth: null }, isActive: true }
];

async function run() {
    await connectDB();
    for (const f of FEATURES) {
        await FeatureCatalog.findOneAndUpdate({ key: f.key }, { $set: { ...f, updatedAtUtc: new Date() } }, { upsert: true, new: true });
        console.log('Feature:', f.key);
    }
    for (const l of LIMITS) {
        await LimitCatalog.findOneAndUpdate({ key: l.key }, { $set: { ...l, updatedAtUtc: new Date() } }, { upsert: true, new: true });
        console.log('Limit:', l.key);
    }
    for (const p of PLANS) {
        await PlanCatalog.findOneAndUpdate(
            { planKey: p.planKey },
            { $set: { name: p.name, description: p.description, priceMetadata: p.priceMetadata, features: p.features, limits: p.limits, isActive: p.isActive, updatedAtUtc: new Date() } },
            { upsert: true, new: true }
        );
        console.log('Plan:', p.planKey);
    }
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    console.log('Entitlements seed done.');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
