const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const Tenant = require('../models/Tenant');
const TenantSubscription = require('../models/TenantSubscription');
const mongoose = require('mongoose');
const entitlementsService = require('../services/entitlementsService');
const asyncHandler = require('../middleware/asyncHandler');
const activityLogService = require('../services/activityLogService');
const { getTenantConnection, getTenantDbName } = require('../services/tenantConnection');
const tenantUserSchema = require('../models/tenantUserSchema');
const tenantRoleSchema = require('../models/tenantRoleSchema');
const { seedTenantRbac } = require('../seeders/seedTenantRbac');
const { validatePassword } = require('../utils/passwordPolicy');
const { mapToObject, normalizeSalesInvoiceMutex } = require('../services/entitlementsService');

/** URL-safe short tenant ID (e.g. ab12cd). Never accept dbName from request. */
function generateTenantId() {
    return crypto.randomBytes(4).toString('base64url').replace(/[-_]/g, '').toLowerCase().slice(0, 8) || crypto.randomBytes(4).toString('hex');
}

const TENANT_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
function isValidTenantIdFormat(id) {
    return typeof id === 'string' && TENANT_ID_REGEX.test(id.trim());
}

function toObjectIds(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.filter((id) => id && mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
}

function getTenantUserModel(tenantId) {
    const conn = getTenantConnection(tenantId);
    if (!conn) return null;
    if (conn.models.User) return conn.models.User;
    return conn.model('User', tenantUserSchema);
}

function getTenantRoleModel(tenantId) {
    const conn = getTenantConnection(tenantId);
    if (!conn) return null;
    if (conn.models.Role) return conn.models.Role;
    return conn.model('Role', tenantRoleSchema);
}

/** Check if subdomain (= tenantId) is available */
exports.checkSubdomain = asyncHandler(async (req, res) => {
    const subdomain = (req.params.subdomain || '').trim().toLowerCase();
    if (!subdomain) return res.json({ success: true, available: false, message: 'Subdomain is required' });
    const existing = await Tenant.findOne({ tenantId: subdomain }).select('tenantId').lean();
    res.json({ success: true, available: !existing });
});

/** List tenants */
exports.list = asyncHandler(async (req, res) => {
    const [tenants, allSubs] = await Promise.all([
        Tenant.find({}).sort({ tenantId: 1 }).lean(),
        TenantSubscription.find({}).select('tenantId').lean()
    ]);
    const idsFromTenants = tenants.map((t) => t.tenantId);
    const idsFromSubs = (allSubs || []).map((s) => s.tenantId).filter(Boolean);
    let tenantIds = [...new Set([...idsFromTenants, ...idsFromSubs])].sort();
    if (tenantIds.length === 0) tenantIds = ['default'];
    const subs = await TenantSubscription.find({ tenantId: { $in: tenantIds } }).lean();
    const list = tenantIds.map((tid) => {
        const tenant = tenants.find((t) => t.tenantId === tid);
        const sub = subs.find((s) => s.tenantId === tid);
        return {
            tenantId: tid,
            tenantSubdomain: tenant?.tenantSubdomain ?? '',
            tenantUrl: tenant?.tenantUrl ?? '',
            name: tenant?.name ?? tid,
            companyName: tenant?.companyName ?? '',
            email: tenant?.email ?? '',
            phone: tenant?.phone ?? '',
            billingAddress: tenant?.billingAddress ?? '',
            billingEmail: tenant?.billingEmail ?? '',
            billingAmount: tenant?.billingAmount ?? null,
            billingCycle: tenant?.billingCycle ?? 'monthly',
            currency: tenant?.currency ?? 'GBP',
            status: tenant?.status ?? 'active',
            planKey: sub ? sub.planKey : null,
            startDate: sub?.startDate ?? null,
            expireDate: sub?.expireDate ?? null,
            overrides: sub ? { features: mapToObject(sub.overrides?.features), limits: mapToObject(sub.overrides?.limits) } : null
        };
    });
    res.status(200).json({ success: true, data: list });
});

/** Create tenant: Tenant + TenantSubscription in master; init tenant DB; optionally first admin user.
 *  Never accepts dbName from request; tenantDbName = TENANT_DB_PREFIX + tenantId (server-derived).
 */
exports.createTenant = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const {
        name,
        companyName,
        email,
        phone,
        contactEmail,
        contactPhone,
        billingAddress,
        billingEmail,
        billingAmount,
        billingCycle,
        currency,
        planKey: bodyPlanKey,
        createFirstAdmin: createFirstAdminFlag,
        firstAdmin: firstAdminBody
    } = body;

    if (body.dbName != null) {
        return res.status(400).json({ success: false, message: 'dbName must not be sent; it is derived from tenantId' });
    }

    const rawSubdomain = (body.tenantSubdomain ?? '').toString().trim().toLowerCase();
    if (!rawSubdomain) {
        return res.status(400).json({ success: false, message: 'tenantSubdomain is required' });
    }
    if (!Tenant.validateSubdomainFormat(rawSubdomain)) {
        return res.status(400).json({
            success: false,
            message: 'Subdomain must be 3–30 characters, lowercase letters, numbers, and hyphens only (cannot start or end with hyphen)'
        });
    }
    const tenantSubdomain = rawSubdomain;
    const existingBySubdomain = await Tenant.findOne({ tenantSubdomain }).lean();
    if (existingBySubdomain) {
        return res.status(400).json({ success: false, message: 'That subdomain is already in use' });
    }

    const displayName = (name || companyName || '').trim() || 'New Tenant';
    const planKey = (bodyPlanKey && String(bodyPlanKey).trim()) ? String(bodyPlanKey).toLowerCase() : 'starter';

    const tenantUrl = body.tenantUrl
        ? String(body.tenantUrl).trim()
        : `https://${tenantSubdomain}.${config.tenantUrlDomain || 'inflix.uk'}`;

    // tenantId = subdomain → DB name becomes tenant_{subdomain}
    const tenantId = tenantSubdomain;
    const existingById = await Tenant.findOne({ tenantId }).lean();
    if (existingById) {
        return res.status(400).json({ success: false, message: 'That tenantId is already in use' });
    }

    const contactEmailVal = (contactEmail ?? email ?? '').toString().trim().toLowerCase();
    const contactPhoneVal = (contactPhone ?? phone ?? '').toString().trim();

    await Tenant.create({
        tenantId,
        tenantSubdomain,
        tenantUrl,
        name: displayName,
        companyName: (companyName || '').trim() || displayName,
        email: contactEmailVal,
        phone: contactPhoneVal,
        billingAddress: (billingAddress || '').trim(),
        billingEmail: (billingEmail || '').trim().toLowerCase(),
        billingAmount: billingAmount != null && Number(billingAmount) >= 0 ? Number(billingAmount) : null,
        billingCycle: billingCycle === 'yearly' ? 'yearly' : 'monthly',
        currency: (currency || 'GBP').trim() || 'GBP',
        status: 'active'
    });

    const now = new Date();
    await TenantSubscription.findOneAndUpdate(
        { tenantId },
        { $set: { tenantId, planKey, overrides: { features: {}, limits: {} }, startDate: now, updatedAtUtc: now } },
        { upsert: true }
    );

    const tenantDbName = getTenantDbName(tenantId);
    const conn = getTenantConnection(tenantId);
    await conn.collection('__init').insertOne({ tenantId, createdAtUtc: now });

    // Seed full permission catalogue (sale.*, invoice.*, etc.) and default roles
    // so platform admins can allot any permission to this tenant immediately.
    await seedTenantRbac(conn);

    const wantFirstAdmin = Boolean(createFirstAdminFlag) || (typeof body.createFirstAdmin === 'object' && body.createFirstAdmin && body.createFirstAdmin.email && body.createFirstAdmin.password);
    const firstAdmin = firstAdminBody || (typeof body.createFirstAdmin === 'object' ? body.createFirstAdmin : null);

    let createdFirstAdmin = false;
    if (wantFirstAdmin) {
        if (!firstAdmin || !(firstAdmin.email && firstAdmin.password)) {
            return res.status(400).json({ success: false, message: 'When createFirstAdmin is true, firstAdmin with email and password is required' });
        }
        const pwdCheck = validatePassword(firstAdmin.password);
        if (!pwdCheck.valid) {
            return res.status(400).json({ success: false, message: pwdCheck.message });
        }
        const User = getTenantUserModel(tenantId);
        const Role = getTenantRoleModel(tenantId);
        const normalizedEmail = (firstAdmin.email || '').toLowerCase().trim();
        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Email already in use for first admin' });
        }
        let firstAdminRoleIds = [];
        if (Role) {
            const allRoles = await Role.find().select('_id').lean();
            firstAdminRoleIds = allRoles.map((r) => r._id);
        }
        await User.create({
            name: (firstAdmin.name || normalizedEmail.split('@')[0] || 'Admin').trim(),
            email: normalizedEmail,
            password: firstAdmin.password,
            role: 'admin',
            roles: firstAdminRoleIds,
            isActive: true,
            tenantId
        });
        createdFirstAdmin = true;
    }

    await activityLogService.logFromReq(req, {
        action: 'PLATFORM_TENANT_CREATED',
        entityType: 'Tenant',
        entityId: tenantId,
        success: true,
        message: `Tenant created: ${tenantId}`,
        metaJson: { tenantId, name: displayName, tenantDbName, createdFirstAdmin }
    });

    res.status(201).json({
        success: true,
        message: 'Tenant created',
        data: {
            tenantId,
            tenantSubdomain,
            tenantUrl,
            tenantDbName,
            status: 'active',
            planKey,
            createdFirstAdmin
        }
    });
});

/** Get one tenant */
exports.getTenant = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    console.log('[getTenant] tenantId:', tenantId);
    const tenant = await Tenant.findOne({ tenantId }).lean();
    console.log('[getTenant] tenant found:', tenant ? 'yes' : 'no');
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const responseData = {
        tenantId: tenant.tenantId,
        tenantSubdomain: tenant.tenantSubdomain,
        tenantUrl: tenant.tenantUrl,
        name: tenant.name,
        companyName: tenant.companyName,
        email: tenant.email,
        phone: tenant.phone,
        billingAddress: tenant.billingAddress,
        billingEmail: tenant.billingEmail,
        billingAmount: tenant.billingAmount,
        billingCycle: tenant.billingCycle,
        currency: tenant.currency,
        status: tenant.status,
        createdAtUtc: tenant.createdAtUtc,
        updatedAtUtc: tenant.updatedAtUtc
    };
    console.log('[getTenant] response:', JSON.stringify(responseData, null, 2));
    res.status(200).json({ success: true, data: responseData });
});

/** Derive a valid subdomain from tenantId when tenant has none (e.g. legacy tenants). */
function deriveSubdomainFromTenantId(tenantId) {
    const s = String(tenantId ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (s.length >= 3 && Tenant.validateSubdomainFormat(s)) return s;
    return (s || 'default').slice(0, 30).padEnd(3, '0');
}

/** Update tenant */
exports.updateTenant = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const { name, companyName, email, phone, billingAddress, billingEmail, billingAmount, billingCycle, currency, status } = req.body || {};
    console.log('[updateTenant] tenantId:', tenantId);
    console.log('[updateTenant] req.body:', JSON.stringify(req.body, null, 2));
    let tenant = await Tenant.findOne({ tenantId });
    if (!tenant) {
        tenant = await Tenant.create({
            tenantId,
            tenantSubdomain: deriveSubdomainFromTenantId(tenantId),
            name: String(name ?? '').trim() || tenantId,
            companyName: String(companyName ?? '').trim(),
            email: String(email ?? '').trim().toLowerCase(),
            phone: String(phone ?? '').trim(),
            billingAddress: String(billingAddress ?? '').trim(),
            billingEmail: String(billingEmail ?? '').trim().toLowerCase(),
            billingAmount: billingAmount != null && Number(billingAmount) >= 0 ? Number(billingAmount) : null,
            billingCycle: billingCycle === 'yearly' ? 'yearly' : 'monthly',
            currency: String(currency ?? 'GBP').trim() || 'GBP',
            status: status === 'suspended' ? 'suspended' : 'active'
        });
    } else {
        if (!tenant.tenantSubdomain || !String(tenant.tenantSubdomain).trim()) {
            tenant.tenantSubdomain = deriveSubdomainFromTenantId(tenantId);
        }
        if (name !== undefined) tenant.name = String(name).trim();
        if (companyName !== undefined) tenant.companyName = String(companyName).trim();
        if (email !== undefined) tenant.email = String(email).trim().toLowerCase();
        if (phone !== undefined) tenant.phone = String(phone).trim();
        if (billingAddress !== undefined) tenant.billingAddress = String(billingAddress).trim();
        if (billingEmail !== undefined) tenant.billingEmail = String(billingEmail).trim().toLowerCase();
        if (billingAmount !== undefined) tenant.billingAmount = billingAmount != null && Number(billingAmount) >= 0 ? Number(billingAmount) : null;
        if (billingCycle !== undefined) tenant.billingCycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
        if (currency !== undefined) tenant.currency = String(currency).trim() || 'GBP';
        if (status !== undefined) {
            const normalized = String(status).toLowerCase().trim();
            if (normalized === 'suspended' || normalized === 'active') tenant.status = normalized;
        }
        await tenant.save();
    }
    await activityLogService.logFromReq(req, { action: 'PLATFORM_TENANT_UPDATED', entityType: 'Tenant', entityId: tenantId, success: true, message: `Tenant updated: ${tenantId}`, metaJson: { tenantId } });

    // Also store billing info in tenant DB for tenant app access
    try {
        const tenantConn = getTenantConnection(tenantId);
        if (tenantConn) {
            await tenantConn.collection('billing').updateOne(
                { tenantId },
                {
                    $set: {
                        tenantId,
                        billingEmail: tenant.billingEmail,
                        billingAmount: tenant.billingAmount,
                        billingCycle: tenant.billingCycle,
                        currency: tenant.currency,
                        status: tenant.status,
                        updatedAtUtc: new Date()
                    }
                },
                { upsert: true }
            );
            console.log('[updateTenant] Synced billing to tenant DB:', tenantId);

            // Also sync status to subscription collection in tenant DB
            if (status !== undefined) {
                await tenantConn.collection('subscription').updateOne(
                    { tenantId },
                    { $set: { status: tenant.status, updatedAtUtc: new Date() } },
                    { upsert: false }
                );
                console.log('[updateTenant] Synced status to tenant DB subscription:', tenantId);
            }
        }
    } catch (syncErr) {
        console.error('[updateTenant] Failed to sync billing to tenant DB:', syncErr.message);
    }

    res.status(200).json({ success: true, data: tenant, message: 'Tenant updated' });
});

/** Delete tenant */
exports.deleteTenant = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    if (!tenantId || tenantId.trim() === '') {
        return res.status(400).json({ success: false, message: 'Tenant ID is required' });
    }
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) {
        await TenantSubscription.deleteOne({ tenantId });
        return res.status(200).json({ success: true, message: 'Tenant removed (subscription cleared)' });
    }
    await TenantSubscription.deleteOne({ tenantId });
    await tenant.deleteOne();
    await activityLogService.logFromReq(req, { action: 'PLATFORM_TENANT_DELETED', entityType: 'Tenant', entityId: tenantId, success: true, message: `Tenant deleted: ${tenantId}`, metaJson: { tenantId, name: tenant.name } });
    res.status(200).json({ success: true, message: 'Tenant deleted' });
});

/** List roles from tenant DB (for platform tenant user UI). tenantId from query: ?tenantId=xxx */
exports.listRoles = asyncHandler(async (req, res) => {
    const tenantId = req.query.tenantId || req.params.tenantId;
    if (!tenantId) return res.status(200).json({ success: true, data: [] });
    const Role = getTenantRoleModel(tenantId);
    if (!Role) return res.status(200).json({ success: true, data: [] });
    const roles = await Role.find().sort('name').select('name description').lean();
    res.status(200).json({ success: true, data: roles });
});

/** List users for a tenant (from tenant DB). tenantId from params only → tenant DB name = TENANT_DB_PREFIX + tenantId. */
exports.listTenantUsers = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const tenant = await Tenant.findOne({ tenantId }).select('tenantId').lean();
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const User = getTenantUserModel(tenantId);
    if (!User) return res.status(200).json({ success: true, data: [] });
    // Ensure Role model is registered before populate
    getTenantRoleModel(tenantId);
    const users = await User.find({ tenantId }).select('-password').populate('roles', 'name description').sort('-createdAt').lean();
    const data = users.map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        roles: u.roles,
        isActive: u.isActive,
        lastLogin: u.lastLogin,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt
    }));
    res.status(200).json({ success: true, data });
});

/** Create user in tenant DB. tenantId from params only. Email must be unique within this tenant. */
exports.createTenantUser = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const { name, email, password, roleIds, isActive, phone, assignAllRoles } = req.body || {};
    const tenant = await Tenant.findOne({ tenantId }).select('tenantId').lean();
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!normalizedEmail) return res.status(400).json({ success: false, message: 'Email is required' });
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.valid) return res.status(400).json({ success: false, message: pwdCheck.message });
    const User = getTenantUserModel(tenantId);
    const Role = getTenantRoleModel(tenantId);
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(400).json({ success: false, message: 'Email already in use' });
    let roleObjectIds = toObjectIds(roleIds);
    if (assignAllRoles === true && Role) {
        const allRoles = await Role.find().select('_id').lean();
        roleObjectIds = allRoles.map((r) => r._id);
    }
    const user = await User.create({
        name: (name || '').trim() || normalizedEmail.split('@')[0],
        email: normalizedEmail,
        password: password,
        role: 'admin',
        roles: roleObjectIds.length ? roleObjectIds : undefined,
        isActive: isActive !== false,
        phone: (phone || '').trim(),
        tenantId
    });
    const saved = await User.findById(user._id).select('-password').lean();
    await activityLogService.logFromReq(req, { action: 'USER_CREATED', entityType: 'User', entityId: user._id, success: true, message: `Platform created user for tenant ${tenantId}: ${user.email}`, metaJson: { tenantId } });
    res.status(201).json({ success: true, data: saved, message: 'User created' });
});

/** Update tenant user. tenantId from params only (determines tenant DB); never from body. */
exports.updateTenantUser = asyncHandler(async (req, res) => {
    const { tenantId, userId } = req.params;
    const { name, email, roleIds, isActive, phone } = req.body || {};
    const User = getTenantUserModel(tenantId);
    if (!User) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (email !== undefined) {
        const normalizedEmail = String(email).trim().toLowerCase();
        const existing = await User.findOne({ email: normalizedEmail, tenantId, _id: { $ne: user._id } });
        if (existing) return res.status(400).json({ success: false, message: 'Email already in use in this tenant' });
        user.email = normalizedEmail;
    }
    if (name !== undefined) user.name = String(name).trim();
    if (phone !== undefined) user.phone = String(phone).trim();
    if (isActive !== undefined) user.isActive = !!isActive;
    if (Array.isArray(roleIds)) user.roles = toObjectIds(roleIds);
    await user.save();
    const after = await User.findById(user._id).select('-password').lean();
    await activityLogService.logFromReq(req, { action: 'USER_UPDATED', entityType: 'User', entityId: user._id, success: true, message: `Platform updated user for tenant ${tenantId}`, metaJson: { tenantId } });
    res.status(200).json({ success: true, data: after, message: 'User updated' });
});

/** Reset password */
exports.resetTenantUserPassword = asyncHandler(async (req, res) => {
    const { tenantId, userId } = req.params;
    const { newPassword } = req.body || {};
    const pwdCheck = validatePassword(newPassword);
    if (!pwdCheck.valid) return res.status(400).json({ success: false, message: pwdCheck.message });
    const User = getTenantUserModel(tenantId);
    if (!User) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const user = await User.findOne({ _id: userId, tenantId }).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.password = newPassword;
    await user.save();
    await activityLogService.logFromReq(req, { action: 'PASSWORD_RESET', entityType: 'User', entityId: user._id, success: true, message: `Platform reset password for tenant ${tenantId}`, metaJson: { tenantId } });
    res.status(200).json({ success: true, message: 'Password reset successfully' });
});

/** Delete tenant user */
exports.deleteTenantUser = asyncHandler(async (req, res) => {
    const { tenantId, userId } = req.params;
    const User = getTenantUserModel(tenantId);
    if (!User) return res.status(404).json({ success: false, message: 'Tenant not found' });
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await user.deleteOne();
    await activityLogService.logFromReq(req, { action: 'USER_DELETED', entityType: 'User', entityId: userId, success: true, message: `Platform deleted user for tenant ${tenantId}`, metaJson: { tenantId } });
    res.status(200).json({ success: true, message: 'User deleted' });
});

/** Get subscription + effective entitlements + usage */
exports.getSubscription = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    console.log('[getSubscription] tenantId:', tenantId);
    const sub = await TenantSubscription.findOne({ tenantId }).lean();
    console.log('[getSubscription] subscription:', JSON.stringify(sub, null, 2));
    const [entitlements, usage] = await Promise.all([
        entitlementsService.getEntitlements(tenantId),
        entitlementsService.getUsage(tenantId)
    ]);
    const responseData = {
        tenantId,
        subscriptionType: sub?.subscriptionType || 'plan',
        planKey: sub ? sub.planKey : null,
        startDate: sub?.startDate ?? null,
        expireDate: sub?.expireDate ?? null,
        overrides: sub ? { features: mapToObject(sub.overrides?.features), limits: mapToObject(sub.overrides?.limits) } : { features: {}, limits: {} },
        effective: {
            enabledFeatures: entitlements.enabledFeatures,
            limits: entitlements.limits
        },
        usage
    };
    console.log('[getSubscription] response:', JSON.stringify(responseData, null, 2));
    res.status(200).json({ success: true, data: responseData });
});

/** Update subscription */
exports.updateSubscription = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const { planKey, overrides, startDate, expireDate, subscriptionType, salesInvoiceMode } = req.body;
    console.log('[updateSubscription] tenantId:', tenantId);
    console.log('[updateSubscription] req.body:', JSON.stringify(req.body, null, 2));

    // If the caller sent a salesInvoiceMode ("none" | "sales" | "invoices"),
    // translate it into overrides.features so the dropdown is the single source of truth.
    const incomingFeatures = (overrides && typeof overrides.features === 'object') ? { ...overrides.features } : null;
    let preferKey;
    if (typeof salesInvoiceMode === 'string') {
        const mode = salesInvoiceMode.toLowerCase();
        if (mode === 'sales') { if (incomingFeatures) { incomingFeatures.sales = true; incomingFeatures.invoices = false; } preferKey = 'sales'; }
        else if (mode === 'invoices' || mode === 'invoice') { if (incomingFeatures) { incomingFeatures.sales = false; incomingFeatures.invoices = true; } preferKey = 'invoices'; }
        else if (mode === 'none') { if (incomingFeatures) { incomingFeatures.sales = false; incomingFeatures.invoices = false; } }
    }
    if (incomingFeatures) normalizeSalesInvoiceMutex(incomingFeatures, preferKey);
    console.log(`[updateSubscription][sales/invoice] tenantId=${tenantId} mode=${salesInvoiceMode || '(unset)'} preferKey=${preferKey || '(none)'} overrides={sales:${incomingFeatures?.sales}, invoices:${incomingFeatures?.invoices}}`);

    let sub = await TenantSubscription.findOne({ tenantId });
    const before = sub ? sub.toObject() : null;
    if (!sub) {
        const now = new Date();
        sub = await TenantSubscription.create({
            tenantId,
            subscriptionType: subscriptionType === 'custom' ? 'custom' : 'plan',
            planKey: subscriptionType === 'custom' ? '' : (planKey || 'starter').trim().toLowerCase(),
            overrides: { features: incomingFeatures || {}, limits: (overrides && overrides.limits) || {} },
            startDate: startDate ? new Date(startDate) : now,
            expireDate: expireDate ? new Date(expireDate) : null
        });
    } else {
        if (subscriptionType !== undefined) sub.subscriptionType = subscriptionType === 'custom' ? 'custom' : 'plan';
        if (planKey !== undefined) sub.planKey = (planKey || '').trim().toLowerCase();
        if (incomingFeatures) sub.overrides.features = incomingFeatures;
        if (overrides && typeof overrides.limits === 'object') sub.overrides.limits = overrides.limits;
        if (startDate !== undefined) sub.startDate = startDate ? new Date(startDate) : null;
        if (expireDate !== undefined) sub.expireDate = expireDate ? new Date(expireDate) : null;
        await sub.save();
    }
    await activityLogService.logFromReq(req, { action: 'PLATFORM_ENTITLEMENTS_UPDATED', entityType: 'TenantSubscription', entityId: sub._id, success: true, message: `Subscription updated for tenant ${tenantId}`, metaJson: { tenantId } });

    const [entitlements, usage] = await Promise.all([
        entitlementsService.getEntitlements(tenantId),
        entitlementsService.getUsage(tenantId)
    ]);

    // Also store subscription + effective entitlements in tenant DB for tenant app access
    try {
        const tenantConn = getTenantConnection(tenantId);
        if (tenantConn) {
            await tenantConn.collection('subscription').updateOne(
                { tenantId },
                {
                    $set: {
                        tenantId,
                        subscriptionType: sub.subscriptionType || 'plan',
                        planKey: sub.planKey,
                        startDate: sub.startDate,
                        expireDate: sub.expireDate,
                        overrides: { features: mapToObject(sub.overrides.features), limits: mapToObject(sub.overrides.limits) },
                        effective: {
                            enabledFeatures: entitlements.enabledFeatures,
                            limits: entitlements.limits
                        },
                        updatedAtUtc: new Date()
                    }
                },
                { upsert: true }
            );
            console.log('[updateSubscription] Synced subscription + entitlements to tenant DB:', tenantId);
            console.log(`[updateSubscription][sales/invoice] tenantId=${tenantId} effective={sales:${entitlements.enabledFeatures.sales}, invoices:${entitlements.enabledFeatures.invoices}} -> written to tenant_${tenantId}.subscription.effective.enabledFeatures`);
        }
    } catch (syncErr) {
        console.error('[updateSubscription] Failed to sync to tenant DB:', syncErr.message);
    }
    res.status(200).json({
        success: true,
        data: {
            tenantId,
            subscriptionType: sub.subscriptionType || 'plan',
            planKey: sub.planKey,
            startDate: sub.startDate ?? null,
            expireDate: sub.expireDate ?? null,
            overrides: { features: mapToObject(sub.overrides.features), limits: mapToObject(sub.overrides.limits) },
            effective: { enabledFeatures: entitlements.enabledFeatures, limits: entitlements.limits },
            usage
        }
    });
});

/** Create a one-time token for platform → tenant login (cross-domain handoff).
 *  Platform admin can open the tenant app as a specific user; tenant exchanges this token for a tenant JWT.
 *  @route POST /api/platform/tenants/:tenantId/tenant-login-token (platform auth required)
 *  @body { email: string } — tenant user email to log in as
 */
exports.createTenantLoginToken = asyncHandler(async (req, res) => {
    const { tenantId } = req.params;
    const { email } = req.body || {};
    if (!tenantId || !isValidTenantIdFormat(tenantId)) {
        return res.status(400).json({ success: false, message: 'Invalid tenantId' });
    }
    const normalizedEmail = (email && String(email).trim()) ? String(email).toLowerCase().trim() : '';
    if (!normalizedEmail) {
        return res.status(400).json({ success: false, message: 'email is required' });
    }
    if (!config.platformSharedSecret) {
        return res.status(503).json({ success: false, message: 'Platform tenant login not configured (PLATFORM_SHARED_SECRET)' });
    }
    const User = getTenantUserModel(tenantId);
    if (!User) {
        return res.status(400).json({ success: false, message: 'Tenant not found' });
    }
    const user = await User.findOne({ email: normalizedEmail }).select('_id email isActive').lean();
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found in this tenant' });
    }
    if (!user.isActive) {
        return res.status(400).json({ success: false, message: 'User account is disabled' });
    }
    const payload = {
        tenantId,
        email: normalizedEmail,
        purpose: 'tenant_login'
    };
    const token = jwt.sign(payload, config.platformSharedSecret, { algorithm: 'HS256', expiresIn: '5m' });
    const tenantDoc = await Tenant.findOne({ tenantId }).select('tenantUrl').lean();
    const tenantUrl = (tenantDoc && tenantDoc.tenantUrl) || null;
    res.status(200).json({ success: true, token, tenantUrl });
});
