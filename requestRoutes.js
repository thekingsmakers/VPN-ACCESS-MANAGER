const express = require('express');
const router = express.Router();
const {
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
  syncAdMembership
} = require('../controllers/requestController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.use(protect);

router.post('/', createRequest);
router.get('/my', getMyRequests);
router.get('/access/my', getMyAccess);
router.post('/extend/:accessId', extendAccess);
router.get('/pending', getPendingRequests);

router.post('/:id/manager-approve', restrictTo('manager', 'super_admin'), managerApprove);
router.post('/:id/manager-reject', restrictTo('manager', 'super_admin'), rejectRequest);

router.post('/:id/security-approve', restrictTo('it_admin', 'super_admin'), securityApprove);
router.post('/:id/security-reject', restrictTo('it_admin', 'super_admin'), rejectRequest);

router.post('/:id/it-approve', restrictTo('super_admin'), itApprove);
router.post('/:id/it-reject', restrictTo('super_admin'), rejectRequest);

router.get('/access/active', restrictTo('it_admin', 'super_admin'), getActiveAccess);
router.post('/access/:id/revoke', restrictTo('it_admin', 'super_admin'), revokeAccess);
router.post('/access/:id/admin-extend', restrictTo('it_admin', 'super_admin'), adminExtendAccess);
router.get('/analytics', restrictTo('manager', 'it_admin', 'super_admin'), getAnalytics);
router.get('/audit', restrictTo('it_admin', 'super_admin'), getAuditLogs);
router.post('/batch-provision', restrictTo('it_admin', 'super_admin'), batchProvision);
router.post('/sync-ad', restrictTo('it_admin', 'super_admin'), syncAdMembership);
router.post('/onboard-unmanaged', restrictTo('it_admin', 'super_admin'), onboardUnmanagedUser);

router.get('/alerts/ad-removals', restrictTo('it_admin', 'super_admin'), getAdRemovalAlerts);
router.post('/alerts/:id/dismiss', restrictTo('it_admin', 'super_admin'), dismissAdRemovalAlert);

module.exports = router;
