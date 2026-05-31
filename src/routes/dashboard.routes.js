const express = require('express');
const {
    overviewStats,
    overviewStatsNew,
    chargebackStats,
    refundStats,
    disputeList,
    disputeDetail,
    refundList,
    revenueChart,
} = require('../controllers/dashboard.controller');

const authentication = require('../middlewares/authentication');

const router = express.Router();

// Overview
// router.get('/:tenantId/overview', authentication, overviewStats);
// Overview v2
router.get('/:tenantId/overview', authentication, overviewStatsNew);

// Chargebacks
router.get('/:tenantId/chargebacks', authentication, chargebackStats);
router.get('/:tenantId/disputes', authentication, disputeList);
router.get('/:tenantId/disputes/:disputeId', authentication, disputeDetail);

// Refunds
router.get('/:tenantId/refunds/stats',authentication, refundStats);
router.get('/:tenantId/refunds', authentication, refundList);

// Revenue chart
router.get('/:tenantId/revenue', authentication, revenueChart);

module.exports = router;