const {
    getOverviewStats,
    getNewOverviewStats,
    getChargebackStats,
    getRefundStats,
    getDisputeList,
    getDisputeDetail,
    getRefundList,
    getRevenueChartData,
} = require('../services/dashboard.services');

// GET /api/v1/dashboard/:tenantId/overview
const overviewStats = async (req, res) => {
    try {
        const data = await getOverviewStats(req.params.tenantId);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const overviewStatsNew = async (req, res) => {
    try {
        const data = await getNewOverviewStats(req.params.tenantId);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/v1/dashboard/:tenantId/chargebacks
const chargebackStats = async (req, res) => {
    try {
        const data = await getChargebackStats(req.params.tenantId);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/v1/dashboard/:tenantId/refunds/stats
const refundStats = async (req, res) => {
    try {
        const data = await getRefundStats(req.params.tenantId);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/v1/dashboard/:tenantId/disputes?status=needs_response&page=1&limit=20
const disputeList = async (req, res) => {
    try {
        const { status, page, limit } = req.query;
        const data = await getDisputeList(req.params.tenantId, {
            status,
            page:  parseInt(page)  || 1,
            limit: parseInt(limit) || 20,
        });
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/v1/dashboard/:tenantId/disputes/:disputeId
const disputeDetail = async (req, res) => {
    try {
        const data = await getDisputeDetail(
            req.params.tenantId,
            req.params.disputeId
        );
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/v1/dashboard/:tenantId/refunds?page=1&limit=20
const refundList = async (req, res) => {
    try {
        const { page, limit } = req.query;
        const data = await getRefundList(req.params.tenantId, {
            page:  parseInt(page)  || 1,
            limit: parseInt(limit) || 20,
        });
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/v1/dashboard/:tenantId/revenue?days=30
const revenueChart = async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await getRevenueChartData(req.params.tenantId, days);
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    overviewStats,
    overviewStatsNew,
    chargebackStats,
    refundStats,
    disputeList,
    disputeDetail,
    refundList,
    revenueChart,
};