/**
 * Backfill the sales/invoices mutex for every existing tenant subscription.
 *
 * The platform previously had only an `invoices` feature flag; `sales` was always
 * available via RBAC. Now Sales and Invoice are mutually exclusive — at most one can
 * be enabled per tenant — and both are gated by the subscription feature catalog.
 *
 * Default behaviour for existing tenants:
 *  - If overrides.features.invoices === true                → keep Invoice (sales=false, invoices=true)
 *  - Else                                                   → grant Sales   (sales=true,  invoices=false)
 *
 * Override with the --mode flag:
 *  - node src/seeders/backfillSalesInvoiceMutex.js --mode sales
 *  - node src/seeders/backfillSalesInvoiceMutex.js --mode invoices
 *  - node src/seeders/backfillSalesInvoiceMutex.js --mode none
 *  - node src/seeders/backfillSalesInvoiceMutex.js          (auto, per-tenant)
 *
 * Also re-syncs effective entitlements into each tenant DB's subscription doc.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const TenantSubscription = require('../models/TenantSubscription');
const Tenant = require('../models/Tenant');
const entitlementsService = require('../services/entitlementsService');
const { getTenantConnection } = require('../services/tenantConnection');
const { mapToObject } = require('../services/entitlementsService');

function parseMode() {
    const idx = process.argv.indexOf('--mode');
    if (idx === -1) return null;
    const v = (process.argv[idx + 1] || '').toLowerCase();
    if (v === 'sales' || v === 'invoices' || v === 'none') return v;
    return null;
}

function decideMode(sub, forced) {
    if (forced) return forced;
    const ov = mapToObject(sub?.overrides?.features);
    if (ov.invoices === true) return 'invoices';
    return 'sales';
}

async function run() {
    await connectDB();
    const forced = parseMode();
    const tenants = await Tenant.find({}).select('tenantId name').lean();
    if (tenants.length === 0) {
        console.log('No tenants found.');
    }
    let updated = 0;
    for (const t of tenants) {
        try {
            const sub = await TenantSubscription.findOne({ tenantId: t.tenantId });
            if (!sub) {
                console.warn('Skip', t.tenantId, '(no subscription)');
                continue;
            }
            const mode = decideMode(sub, forced);
            const features = mapToObject(sub.overrides?.features);
            features.sales = mode === 'sales';
            features.invoices = mode === 'invoices';
            sub.overrides.features = features;
            await sub.save();
            updated += 1;

            // Sync effective entitlements into tenant DB.
            try {
                const [entitlements, usage] = await Promise.all([
                    entitlementsService.getEntitlements(t.tenantId),
                    entitlementsService.getUsage(t.tenantId)
                ]);
                const tenantConn = getTenantConnection(t.tenantId);
                if (tenantConn) {
                    await tenantConn.collection('subscription').updateOne(
                        { tenantId: t.tenantId },
                        {
                            $set: {
                                tenantId: t.tenantId,
                                subscriptionType: sub.subscriptionType || 'plan',
                                planKey: sub.planKey,
                                startDate: sub.startDate,
                                expireDate: sub.expireDate,
                                overrides: { features, limits: mapToObject(sub.overrides.limits) },
                                effective: { enabledFeatures: entitlements.enabledFeatures, limits: entitlements.limits },
                                updatedAtUtc: new Date()
                            }
                        },
                        { upsert: true }
                    );
                }
                console.log(`[${t.tenantId}] mode=${mode}  usage=${JSON.stringify(usage)}`);
            } catch (syncErr) {
                console.warn(`[${t.tenantId}] entitlement sync failed:`, syncErr.message);
            }
        } catch (err) {
            console.error(`[${t.tenantId}] failed:`, err.message);
        }
    }
    console.log(`Backfill complete. Subscriptions updated: ${updated}/${tenants.length}.`);
    await mongoose.disconnect();
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
