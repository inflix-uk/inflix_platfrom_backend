/**
 * Entitlements from plan + overrides. Usage from TenantUsage (master DB).
 */
const FeatureCatalog = require('../models/FeatureCatalog');
const LimitCatalog = require('../models/LimitCatalog');
const PlanCatalog = require('../models/PlanCatalog');
const TenantSubscription = require('../models/TenantSubscription');
const TenantUsage = require('../models/TenantUsage');

function mapToObject(m) {
    if (!m) return {};
    if (typeof m.toObject === 'function') m = m.toObject();
    if (m instanceof Map) return Object.fromEntries(m);
    if (typeof m === 'object' && m !== null) return m;
    return {};
}

/**
 * Sales and Invoices are mutually exclusive. At most one may be true.
 * Behaviour:
 *  - If both are true, the value passed in `preferKey` wins (the one the caller just turned on).
 *    When unspecified, `invoices` wins (last-write-wins toward the more constrained flow).
 *  - If only one is true, the other is forced to false.
 *  - If both are false / undefined, both are left as-is.
 * Mutates and returns the same object.
 */
function normalizeSalesInvoiceMutex(features, preferKey) {
    if (!features || typeof features !== 'object') return features;
    const sales = features.sales === true;
    const invoices = features.invoices === true;
    if (sales && invoices) {
        if (preferKey === 'sales') {
            features.invoices = false;
        } else {
            features.sales = false;
        }
    } else if (sales) {
        features.invoices = false;
    } else if (invoices) {
        features.sales = false;
    }
    return features;
}

async function getEntitlements(tenantId) {
    const tid = tenantId || 'default';
    const [subscription, featureCatalog, limitCatalog] = await Promise.all([
        TenantSubscription.findOne({ tenantId: tid }).lean(),
        FeatureCatalog.find({ isActive: true }).select('key defaultEnabled').lean(),
        LimitCatalog.find({ isActive: true }).select('key defaultValue').lean()
    ]);
    const planKey = subscription?.planKey || 'starter';
    const planDoc = await PlanCatalog.findOne({ planKey, isActive: true }).lean();
    const planFeatures = mapToObject(planDoc?.features);
    const planLimits = mapToObject(planDoc?.limits);
    const overrideFeatures = mapToObject(subscription?.overrides?.features);
    const overrideLimits = mapToObject(subscription?.overrides?.limits);

    const enabledFeatures = {};
    featureCatalog.forEach((f) => {
        if (overrideFeatures[f.key] !== undefined) {
            enabledFeatures[f.key] = !!overrideFeatures[f.key];
        } else if (planFeatures[f.key] !== undefined) {
            enabledFeatures[f.key] = !!planFeatures[f.key];
        } else {
            enabledFeatures[f.key] = !!f.defaultEnabled;
        }
    });

    // `sales` and `invoices` are first-class mutex features. Always emit explicit booleans
    // even if the FeatureCatalog hasn't been seeded with them yet (so the POS sidebar can
    // hide the relevant tabs reliably).
    for (const key of ['sales', 'invoices']) {
        if (overrideFeatures[key] !== undefined) enabledFeatures[key] = !!overrideFeatures[key];
        else if (planFeatures[key] !== undefined) enabledFeatures[key] = !!planFeatures[key];
        else if (enabledFeatures[key] === undefined) enabledFeatures[key] = false;
    }

    const beforeMutex = { sales: enabledFeatures.sales, invoices: enabledFeatures.invoices };
    normalizeSalesInvoiceMutex(enabledFeatures);
    console.log(`[entitlementsService][sales/invoice] tenantId=${tid} planKey=${planKey} overrides={sales:${overrideFeatures.sales}, invoices:${overrideFeatures.invoices}} plan={sales:${planFeatures.sales}, invoices:${planFeatures.invoices}} preMutex=${JSON.stringify(beforeMutex)} postMutex={sales:${enabledFeatures.sales}, invoices:${enabledFeatures.invoices}}`);

    const limits = {};
    limitCatalog.forEach((l) => {
        if (overrideLimits[l.key] !== undefined && overrideLimits[l.key] !== null) {
            const v = overrideLimits[l.key];
            limits[l.key] = typeof v === 'number' ? v : null;
        } else if (planLimits[l.key] !== undefined && planLimits[l.key] !== null) {
            const v = planLimits[l.key];
            limits[l.key] = typeof v === 'number' ? v : null;
        } else {
            limits[l.key] = l.defaultValue != null ? Number(l.defaultValue) : null;
        }
    });

    return { enabledFeatures, limits, planKey };
}

async function getUsage(tenantId) {
    const tid = tenantId || 'default';
    const usage = await TenantUsage.findOne({ tenantId: tid }).lean();
    if (!usage) {
        return { maxUsers: 0, maxLocations: 0, maxRepairsPerMonth: 0 };
    }
    return {
        maxUsers: usage.usersUsed ?? 0,
        maxLocations: usage.locationsUsed ?? 0,
        maxRepairsPerMonth: usage.repairsThisMonthUsed ?? 0
    };
}

module.exports = {
    getEntitlements,
    getUsage,
    mapToObject,
    normalizeSalesInvoiceMutex
};
