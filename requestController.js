const Request = require('../models/Request');
const AccessRecord = require('../models/AccessRecord');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const emailService = require('../services/emailService');
const ldapService = require('../services/ldapService');

const executeProvisioning = async (request, executerId, settingsInput = null) => {
  const { userId } = request;
  
  const settings = settingsInput || (await require('../models/Setting').findOne());
  const groupName = settings?.adMapping?.defaultVpnGroup || 'VPN-Access';

  await ldapService.addUserToGroup(userId.username, groupName);

  request.status = 'approved';
  // Note: itAdminId might technically be a manager or security admin if IT is bypassed
  request.itAdminId = executerId;
  await request.save();

  const startDate = new Date();
  const endDate = new Date();
  endDate.setDate(startDate.getDate() + request.durationDays);

  const accessRecord = await AccessRecord.create({
    userId: userId._id,
    requestId: request._id,
    groupName,
    startDate,
    endDate
  });

    await AuditLog.create({
      category: 'VPN Provisioning',
      action: 'VPN_PROVISIONED',
      performedBy: executerId || userId._id,
      metadata: { requestId: request._id, recordId: accessRecord._id }
    });

  const approvalHtml = settings?.emailTemplates?.approvalText?.replace('[END_DATE]', endDate.toDateString()) || `Your VPN access has been approved and provisioned until ${endDate.toDateString()}.`;

  // Explicitly not awaiting email to speed up response, particularly during batches
  emailService.sendEmail({
    to: userId.email,
    subject: 'VPN Access Approved',
    html: `<p>${approvalHtml}</p>`
  }).catch(err => console.error('[PROVISION] Email notify failed:', err.message));
};

// Submit Request
const createRequest = async (req, res) => {
  const { durationDays, justification } = req.body;
  try {
    const managerId = req.user.managerId;
    
    // Check for an existing pending request
    const pendingRequest = await Request.findOne({
      userId: req.user._id,
      status: { $in: ['pending_manager', 'pending_security', 'pending_it'] }
    });
    
    if (pendingRequest) {
      return res.status(400).json({ message: 'You already have a pending VPN request in the queue.' });
    }

    // Check for an active VPN provision
    const activeAccess = await AccessRecord.findOne({
      userId: req.user._id,
      status: 'active',
      endDate: { $gt: new Date() }
    });
    
    if (activeAccess) {
      return res.status(400).json({ message: 'You already have active VPN access. Please extend your current access instead of creating a new request.' });
    }
    
    // Load settings for dynamic workflow pipeline targeting
    const settings = await require('../models/Setting').findOne();
    const wf = settings?.workflow || { requireManagerApproval: true, requireSecurityApproval: true, requireITAdminApproval: true };

    let initialStatus = 'approved';
    if (wf.requireITAdminApproval) initialStatus = 'pending_it';
    if (wf.requireSecurityApproval) initialStatus = 'pending_security';
    if (wf.requireManagerApproval && managerId) initialStatus = 'pending_manager';
    
    // Auto-approve rule logic (bonus) if <= 3 days could be here, but let's stick to standard flow
    
    const request = await Request.create({
      userId: req.user._id,
      durationDays,
      justification,
      managerId: (wf.requireManagerApproval && managerId) ? managerId : null,
      status: initialStatus
    });

    await AuditLog.create({
      category: 'Application',
      action: 'REQUEST_SUBMITTED',
      performedBy: req.user._id,
      metadata: { requestId: request._id, form: req.body }
    });

    if (managerId && initialStatus === 'pending_manager') {
      const manager = await User.findById(managerId);
      if (manager) {
        await emailService.sendEmail({
          to: manager.email,
          subject: 'VPN Access Request Approval Required',
          html: `<p>User ${req.user.username} has requested VPN access for ${durationDays} days.</p><p><a href="${process.env.FRONTEND_URL}/requests">Review Request</a></p>`
        });
      }
    }

    if (initialStatus === 'approved') {
      await request.populate('userId');
      await executeProvisioning(request, null);
    }

    res.status(201).json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get my requests
const getMyRequests = async (req, res) => {
  try {
    const requests = await Request.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get pending requests (for manager or IT)
const getPendingRequests = async (req, res) => {
  try {
    let requests;
    if (req.user.role === 'manager') {
      requests = await Request.find({ managerId: req.user._id, status: 'pending_manager' }).populate('userId', 'username email');
    } else if (req.user.role === 'it_admin') {
      requests = await Request.find({ status: 'pending_security' }).populate('userId', 'username email');
    } else if (req.user.role === 'super_admin') {
      // Super admins might want to oversee security queue too, or strictly wait for pending_it.
      // We will pull pending_it for their direct action tasks.
      requests = await Request.find({ status: 'pending_it' }).populate('userId', 'username email');
    } else {
      return res.status(403).json({ message: 'Not authorized' });
    }
    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Manager Approve
const managerApprove = async (req, res) => {
  try {
    const request = await Request.findById(req.params.id).populate('userId');
    if (!request || request.status !== 'pending_manager' || request.managerId.toString() !== req.user._id.toString()) {
      return res.status(400).json({ message: 'Invalid request' });
    }

    const settings = await require('../models/Setting').findOne();
    const wf = settings?.workflow || { requireSecurityApproval: true, requireITAdminApproval: true };

    let nextStatus = 'approved';
    if (wf.requireITAdminApproval) nextStatus = 'pending_it';
    if (wf.requireSecurityApproval) nextStatus = 'pending_security';

    request.status = nextStatus;
    await request.save();

    if (nextStatus === 'approved') {
      await executeProvisioning(request, req.user._id);
    }

    await AuditLog.create({
      action: 'MANAGER_APPROVED',
      performedBy: req.user._id,
      metadata: { requestId: request._id }
    });

    // Notifying IT Admin would be here (e.g. sending to it@domain.com)

    res.json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Security Approve
const securityApprove = async (req, res) => {
  try {
    const request = await Request.findById(req.params.id).populate('userId');
    if (!request || request.status !== 'pending_security') {
      return res.status(400).json({ message: 'Invalid request' });
    }

    const settings = await require('../models/Setting').findOne();
    const wf = settings?.workflow || { requireITAdminApproval: true };

    const nextStatus = wf.requireITAdminApproval ? 'pending_it' : 'approved';
    request.status = nextStatus;
    await request.save();

    if (nextStatus === 'approved') {
      await executeProvisioning(request, req.user._id);
    }

    await AuditLog.create({
      category: 'Security',
      action: 'REQUEST_APPROVED_SECURITY',
      performedBy: req.user._id,
      metadata: { requestId: request._id }
    });

    res.json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// IT Approve
const itApprove = async (req, res) => {
  try {
    const request = await Request.findById(req.params.id).populate('userId');
    if (!request || request.status !== 'pending_it') {
      return res.status(400).json({ message: 'Invalid request' });
    }

    await executeProvisioning(request, req.user._id);

    res.json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const rejectRequest = async (req, res) => {
  try {
    const request = await Request.findById(req.params.id).populate('userId');
    request.status = 'rejected';
    await request.save();

    await AuditLog.create({
      action: 'REQUEST_REJECTED',
      performedBy: req.user._id,
      metadata: { requestId: request._id }
    });

    const settings = await require('../models/Setting').findOne();
    const rejectionHtml = settings?.emailTemplates?.rejectionText || 'Your VPN access request was rejected.';

    await emailService.sendEmail({
      to: request.userId.email,
      subject: 'VPN Access Rejected',
      html: `<p>${rejectionHtml}</p>`
    });

    res.json(request);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getActiveAccess = async (req, res) => {
  try {
    const records = await AccessRecord.find({ status: 'active' })
      .populate('userId', 'username email')
      .populate('requestId', 'createdAt');
      
    // Discover unmanaged AD group members
    const settings = await require('../models/Setting').findOne();
    const groupName = settings?.adMapping?.defaultVpnGroup || 'VPN_USERS';
    const adMembers = await ldapService.getGroupMembers(groupName);

    if (adMembers && Array.isArray(adMembers)) {
      const managedUsernames = new Set(records.map(r => r.userId?.username?.toLowerCase()).filter(Boolean));
      
      const unmanaged = adMembers.filter(uname => !managedUsernames.has(uname.toLowerCase()));
      
      const virtualRecords = unmanaged.map(uname => ({
        _id: `unmanaged_${uname}`,
        status: 'unmanaged',
        groupName,
        userId: { username: uname, email: 'Unmanaged AD Account' },
        startDate: null,
        endDate: null
      }));
      
      return res.json([...records, ...virtualRecords]);
    }

    res.json(records);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getMyAccess = async (req, res) => {
  try {
    const records = await AccessRecord.find({ 
      userId: req.user._id, 
      status: { $in: ['active', 'revoked'] } 
    }).sort({ createdAt: -1 });
    res.json(records);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const extendAccess = async (req, res) => {
  try {
    const { durationDays, justification } = req.body;
    const accessId = req.params.accessId;
    
    const access = await AccessRecord.findOne({ _id: accessId, userId: req.user._id, status: 'active' });
    if (!access) return res.status(404).json({ message: 'Active access not found' });
    
    const settings = await require('../models/Setting').findOne();
    const wf = settings?.workflow || { requireManagerApproval: true, requireSecurityApproval: true, requireITAdminApproval: true, autoApproveExtensions: true, maxAutoExtensionDays: 3 };
    
    const isAutoApproveBound = wf.autoApproveExtensions !== false;
    const maxDays = wf.maxAutoExtensionDays || 3;

    if (isAutoApproveBound && durationDays <= maxDays) {
      // Auto-approval logic
      access.endDate = new Date(access.endDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
      await access.save();
      
      const newRequest = await Request.create({
        userId: req.user._id,
        durationDays,
        justification: `[EXTENSION AUTO-APPROVED] ${justification || ''}`,
        status: 'approved'
      });

      await AuditLog.create({
        category: 'VPN Provisioning',
        action: 'ACCESS_EXTENDED_AUTO',
        performedBy: req.user._id,
        metadata: { accessId: access._id, newEndDate: access.endDate, durationDays }
      });

      // Notify user of auto-extension
      emailService.sendEmail({
        to: req.user.email,
        subject: 'VPN Access Auto-Extended',
        html: `<p>Your VPN access has been auto-extended by ${durationDays} day(s) until ${access.endDate.toDateString()}.</p>`
      }).catch(err => console.error('[EXTEND] Auto-email failed:', err.message));

      return res.json({ message: 'Access securely auto-extended.', access, request: newRequest });
    }

    // Normal workflow

    const managerId = req.user.managerId;
    let initialStatus = 'approved';
    if (wf.requireITAdminApproval) initialStatus = 'pending_it';
    if (wf.requireSecurityApproval) initialStatus = 'pending_security';
    if (wf.requireManagerApproval && managerId) initialStatus = 'pending_manager';

    const newRequest = await Request.create({
      userId: req.user._id,
      durationDays,
      justification: `[EXTENSION] ${justification || ''}`,
      managerId: (wf.requireManagerApproval && managerId) ? managerId : null,
      status: initialStatus
    });

    await AuditLog.create({
      category: 'Application',
      action: 'EXTENSION_REQUESTED',
      performedBy: req.user._id,
      metadata: { requestId: newRequest._id, accessId: access._id }
    });

    if (managerId && initialStatus === 'pending_manager') {
      const manager = await User.findById(managerId);
      if (manager) {
        await emailService.sendEmail({
          to: manager.email,
          subject: 'VPN Extension Request Approval Required',
          html: `<p>User ${req.user.username} has requested a VPN extension for ${durationDays} days.</p><p><a href="${process.env.FRONTEND_URL}/requests">Review Request</a></p>`
        });
      }
    }

    if (initialStatus === 'approved') {
      await newRequest.populate('userId');
      await executeProvisioning(newRequest, null);
    }

    res.status(201).json({ message: 'Extension requested successfully', request: newRequest });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAnalytics = async (req, res) => {
  try {
    const activeRecords = await AccessRecord.find({ status: 'active' }).populate('userId', 'username');
    const totalRequests = await Request.countDocuments();
    const pendingRequests = await Request.countDocuments({ status: { $in: ['pending_manager', 'pending_security', 'pending_it'] } });
    const recentRequests = await Request.find().sort({ createdAt: -1 }).limit(5).populate('userId', 'username');

    // Include unmanaged AD members in the total active count
    let totalActive = activeRecords.length;
    const settings = await require('../models/Setting').findOne();
    const groupName = settings?.adMapping?.defaultVpnGroup || 'VPN_USERS';
    const adMembers = await ldapService.getGroupMembers(groupName);

    if (adMembers && Array.isArray(adMembers)) {
      const managedUsernames = new Set(activeRecords.map(r => r.userId?.username?.toLowerCase()).filter(Boolean));
      const unmanagedCount = adMembers.filter(uname => !managedUsernames.has(uname.toLowerCase())).length;
      totalActive += unmanagedCount;
    }

    res.json({
      totalActive,
      totalRequests,
      pendingRequests,
      recentRequests
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const revokeAccess = async (req, res) => {
  try {
    const access = await AccessRecord.findById(req.params.id).populate('userId');
    if (!access || access.status !== 'active') {
      return res.status(400).json({ message: 'Invalid or inactive access record' });
    }

    await ldapService.removeUserFromGroup(access.userId.username, access.groupName);

    access.status = 'revoked';
    access.endDate = new Date();
    await access.save();

    await AuditLog.create({
      category: 'Security',
      action: 'ACCESS_REVOKED_MANUALLY',
      performedBy: req.user._id,
      metadata: { accessRecordId: access._id }
    });

    const settings = await require('../models/Setting').findOne();
    const revokeHtml = settings?.emailTemplates?.revokeText || 'Your VPN secure tunnel has been manually revoked by IT Administration.';

    await emailService.sendEmail({
      to: access.userId.email,
      subject: 'VPN Access Terminated',
      html: `<p>${revokeHtml}</p>`
    });

    res.json(access);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAuditLogs = async (req, res) => {
  try {
    const logs = await AuditLog.find()
      .sort({ createdAt: -1 })
      .populate('performedBy', 'username email');
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const batchProvision = async (req, res) => {
  try {
    const { payload } = req.body; 
    if (!Array.isArray(payload) || payload.length === 0) {
      return res.status(400).json({ message: 'Payload must be a populated array.' });
    }

    const results = { success: 0, skipped: 0, failed: 0, errors: [], skippedUsers: [] };
    const settings = await require('../models/Setting').findOne();
    
    // Pre-filter payload to remove duplicates within the request itself
    const uniquePayload = [];
    const seen = new Set();
    for (const item of payload) {
      const uname = item.username?.toLowerCase();
      if (!uname) continue;
      if (!seen.has(uname)) {
        seen.add(uname);
        uniquePayload.push(item);
      } else {
        results.skipped += 1;
        results.skippedUsers.push(`${item.username} — duplicate entry in upload`);
      }
    }

    // Process in parallel chunks of 5
    const chunkSize = 5;
    for (let i = 0; i < uniquePayload.length; i += chunkSize) {
      const chunk = uniquePayload.slice(i, i + chunkSize);
      
      await Promise.all(chunk.map(async (record) => {
        try {
          let shadowUser = await User.findOne({ username: record.username });
          if (!shadowUser) {
             shadowUser = await User.create({
               username: record.username,
               email: record.email,
               role: 'user'
             });
          }

          const existingAccess = await AccessRecord.findOne({
            userId: shadowUser._id,
            status: 'active',
            endDate: { $gt: new Date() }
          });

          if (existingAccess) {
            results.skipped += 1;
            results.skippedUsers.push(`${record.username} — already has active VPN access`);
            return;
          }
          
          const newReq = await Request.create({
            userId: shadowUser._id,
            durationDays: record.durationDays || 7,
            justification: '[SYSTEM BATCH DEPLOYMENT] Headless mass provisioning invoked by IT.',
            status: 'approved'
          });

          await newReq.populate('userId');
          await executeProvisioning(newReq, req.user._id, settings);

          results.success += 1;
        } catch (err) {
          if (err.code === 11000) {
             results.skipped += 1;
             results.skippedUsers.push(`${record.username} — simultaneous active connection detected`);
             return;
          }
          results.failed += 1;
          results.errors.push(`${record.username}: ${err.message}`);
        }
      }));
    }

    res.json({ message: 'Headless Batch Matrix Complete', results });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getAdRemovalAlerts = async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const alerts = await AccessRecord.find({
      removalReason: 'ad_group_removed',
      adRemovalAlertDismissed: false,
      updatedAt: { $gte: sevenDaysAgo }
    })
      .populate('userId', 'username email')
      .sort({ updatedAt: -1 });

    res.json(alerts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const dismissAdRemovalAlert = async (req, res) => {
  try {
    const record = await AccessRecord.findById(req.params.id);
    if (!record) return res.status(404).json({ message: 'Record not found' });
    record.adRemovalAlertDismissed = true;
    await record.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const adminExtendAccess = async (req, res) => {
  try {
    const { durationDays } = req.body;
    const access = await AccessRecord.findById(req.params.id).populate('userId');
    
    if (!access || access.status !== 'active') {
      return res.status(400).json({ message: 'Invalid or inactive access record' });
    }

    // Support fractional days (e.g. 0.000694 for 1 minute testing)
    const msToAdd = durationDays * 24 * 60 * 60 * 1000;
    access.endDate = new Date(access.endDate.getTime() + msToAdd);
    await access.save();

    await AuditLog.create({
      category: 'VPN Provisioning',
      action: 'ACCESS_EXTENDED_BY_ADMIN',
      performedBy: req.user._id,
      metadata: { 
        accessRecordId: access._id, 
        username: access.userId?.username,
        durationDays, 
        newEndDate: access.endDate 
      }
    });

    // Notify user of admin extension
    emailService.sendEmail({
      to: access.userId.email,
      subject: 'VPN Access Extended by IT',
      html: `<p>An IT Administrator has extended your VPN access until ${access.endDate.toDateString()}.</p>`
    }).catch(err => console.error('[ADMIN-EXTEND] Email failed:', err.message));

    res.json({ message: `Access extended by ${durationDays} day(s) successfully.`, access });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const reconcileAdMembership = async (performerId = null, force = false) => {
  const stats = { processed: 0, revoked: 0, skipped: 0, failures: 0, warnings: [] };
  const AccessRecord = require('../models/AccessRecord');
  const AuditLog = require('../models/AuditLog');
  const ldapService = require('../services/ldapService');
  const emailService = require('../services/emailService');

  const activeRecords = await AccessRecord.find({ status: 'active' }).populate('userId');
  if (activeRecords.length === 0) return stats;

  const byGroup = {};
  for (const record of activeRecords) {
    const g = record.groupName;
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(record);
  }

  for (const [groupName, records] of Object.entries(byGroup)) {
    const adMembers = await ldapService.getGroupMembers(groupName);
    
    if (adMembers === null) {
      stats.failures += records.length;
      continue;
    }

    // Determine who would be revoked
    const toRevoke = records.filter(r => r.userId && !adMembers.includes(r.userId.username.toLowerCase()));

    // SAFETY THRESHOLD A: 100% Mismatch
    // If every single user in the portal is missing from the AD group, it's likely a config/sync issue.
    // Manual sync with 'force' bypasses this safely.
    if (!force && toRevoke.length === records.length && records.length > 0) {
      const warn = `Safety Stop for "${groupName}": 100% of portal users (${records.length}) are missing from AD. Likely a group name mismatch or sync issue. Aborting auto-revoke. Use manual sync to override.`;
      console.warn(`[RECONCILE] ${warn}`);
      stats.warnings.push(warn);
      stats.skipped += records.length;
      continue;
    }

    // SAFETY THRESHOLD B: Large Volume
    if (!force && adMembers.length === 0 && records.length >= 3) {
      const warn = `Group "${groupName}" appears empty in AD but has ${records.length} active portal users. Safety threshold triggered. Use manual sync to override.`;
      console.warn(`[RECONCILE] ${warn}`);
      stats.warnings.push(warn);
      stats.skipped += records.length;
      continue;
    }

    for (const record of toRevoke) {
      stats.processed += 1;
      const user = record.userId;
      if (!user) continue;

      record.status = 'revoked';
      record.removalReason = 'ad_group_removed';
      record.endDate = new Date();
      await record.save();
      stats.revoked += 1;

      await AuditLog.create({
        category: 'Security',
        action: 'AD_GROUP_REMOVAL_DETECTED',
        performedBy: performerId,
        metadata: {
          username: user.username,
          groupName,
          accessRecordId: record._id,
          manualSync: performerId !== null
        }
      });

      await emailService.sendEmail({
        to: user.email,
        subject: 'VPN Access Removed — AD Sync Detection',
        html: `<p>Hi ${user.username},</p><p>A membership sync has detected that your account is no longer in the <strong>${groupName}</strong> group. Your VPN access has been revoked.</p>`
      }).catch(() => {});
    }
    
    // Total processed for stats needs to include those NOT revoked too
    const stayActiveCount = records.length - toRevoke.length;
    stats.processed += stayActiveCount;
  }
  return stats;
};

/**
 * Enforces VPN expiries by removing users from AD and updating DB status.
 */
const enforceExpiries = async () => {
  const stats = { expired: 0, failures: 0 };
  const AccessRecord = require('../models/AccessRecord');
  const AuditLog = require('../models/AuditLog');
  const ldapService = require('../services/ldapService');
  const emailService = require('../services/emailService');
  
  const now = new Date();
  try {
    const expiredRecords = await AccessRecord.find({
      endDate: { $lte: now },
      status: 'active'
    }).populate('userId');

    for (const record of expiredRecords) {
      const user = record.userId;
      if (!user) continue;
      
      try {
        await ldapService.removeUserFromGroup(user.username, record.groupName);
        record.status = 'expired';
        record.removalReason = 'expired';
        await record.save();
        stats.expired += 1;

        await AuditLog.create({
          category: 'System',
          action: 'VPN_EXPIRED',
          performedBy: null, // System action
          metadata: { recordId: record._id, username: user.username }
        });

        emailService.sendEmail({
          to: user.email,
          subject: 'VPN Access Expired',
          html: `<p>Your VPN access has expired and you have been removed from the <strong>${record.groupName}</strong> group.</p>`
        }).catch(() => {});
      } catch (err) {
        stats.failures += 1;
        console.error(`[Maintenance] Failed to expire record ${record._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Maintenance] Expiry enforcement error:', err);
  }
  return stats;
};

/**
 * Detects and prunes redundant 'active' records for the same user.
 */
const pruneDuplicateActiveRecords = async () => {
  const stats = { pruned: 0 };
  const AccessRecord = require('../models/AccessRecord');
  
  try {
    const duplicates = await AccessRecord.aggregate([
      { $match: { status: 'active' } },
      { $group: {
          _id: "$userId",
          count: { $sum: 1 },
          records: { $push: "$$ROOT" }
      }},
      { $match: { count: { $gt: 1 } } }
    ]);

    for (const entry of duplicates) {
      // Keep the record that expires furthest in the future
      const sorted = entry.records.sort((a, b) => new Date(b.endDate) - new Date(a.endDate));
      const toPrune = sorted.slice(1);

      for (const record of toPrune) {
        await AccessRecord.findByIdAndUpdate(record._id, { 
          status: 'revoked', 
          removalReason: 'duplicate_pruned',
          endDate: new Date()
        });
        stats.pruned += 1;
      }
    }
  } catch (err) {
    console.error('[Maintenance] Pruning error:', err);
  }
  return stats;
};

const syncAdMembership = async (req, res) => {
  try {
    // 1. Housekeeping first
    const pruneStats = await pruneDuplicateActiveRecords();
    const expiryStats = await enforceExpiries();
    
    // 2. Then reconcile membership with force: true
    const driftStats = await reconcileAdMembership(req.user._id, true);
    
    res.json({
      message: 'Total Port Sync Complete',
      stats: {
        membership: driftStats,
        expiries: expiryStats,
        duplicates: pruneStats
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const onboardUnmanagedUser = async (req, res) => {
  try {
    const { username, durationDays } = req.body;
    if (!username || !durationDays) return res.status(400).json({ message: 'Username and duration are required.' });

    // 1. Fetch details from AD
    let adUser;
    try {
      adUser = await ldapService.findUserDetails(username);
      if (!adUser) throw new Error('User not found in Active Directory.');
    } catch (err) {
      return res.status(404).json({ message: `Sync Failure: ${err.message}` });
    }

    // 2. Create/Sync User record
    let user = await User.findOne({ username: adUser.sAMAccountName });
    if (!user) {
      user = await User.create({
        username: adUser.sAMAccountName,
        email: adUser.mail || `${username}@domain.com`,
        fullName: adUser.displayName || username,
        role: 'user',
        adDn: adUser.dn
      });
    }

    // 3. Check for existing active record (safety)
    const existing = await AccessRecord.findOne({ userId: user._id, status: 'active' });
    if (existing) return res.status(400).json({ message: 'User is already tracked as active in the portal.' });

    // 4. Create Access Record
    const settings = await require('../models/Setting').findOne();
    const groupName = settings?.adMapping?.defaultVpnGroup || 'VPN_USERS';

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + Number(durationDays));

    const record = await AccessRecord.create({
      userId: user._id,
      groupName,
      startDate,
      endDate,
      status: 'active'
    });

    await AuditLog.create({
      category: 'VPN Provisioning',
      action: 'AD_USER_ONBOARDED',
      performedBy: req.user._id,
      metadata: { username, durationDays, recordId: record._id }
    });

    res.json({ message: `Successfully onboarded ${username} for ${durationDays} days.`, record });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createRequest,
  getMyRequests,
  getPendingRequests,
  managerApprove,
  securityApprove,
  itApprove,
  rejectRequest,
  getActiveAccess,
  getMyAccess,
  extendAccess,
  getAnalytics,
  revokeAccess,
  getAuditLogs,
  batchProvision,
  getAdRemovalAlerts,
  dismissAdRemovalAlert,
  adminExtendAccess,
  syncAdMembership,
  reconcileAdMembership,
  enforceExpiries,
  pruneDuplicateActiveRecords,
  onboardUnmanagedUser
};
