const pool = require('../../db/conn');

// ─────────────────────────────────────────────────────────────────────────────
// 1. OVERVIEW STATS
// ─────────────────────────────────────────────────────────────────────────────

const getOverviewStats = async (tenantId) => {

    const { rows } = await pool.query(
        `SELECT
            -- Revenue
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'succeeded'), 0)
                AS total_revenue,

            -- Refunds
            COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.tenant_id = $1), 0)
                AS total_refunded,

            -- Disputes
            COALESCE(SUM(p.amount) FILTER (WHERE p.disputed = true), 0)
                AS total_disputed_amount,

            -- Won disputes (amount saved)
            COALESCE((
                SELECT SUM(d.amount)
                FROM disputes d
                WHERE d.tenant_id = $1 AND d.status = 'won'
            ), 0) AS amount_saved_from_disputes,

            -- Lost disputes
            COALESCE((
                SELECT SUM(d.amount)
                FROM disputes d
                WHERE d.tenant_id = $1 AND d.status = 'lost'
            ), 0) AS amount_lost_from_disputes,

            -- Successful payments count
            COUNT(p.id) FILTER (WHERE p.status = 'succeeded')
                AS successful_payments,

            -- Failed payments count
            COUNT(p.id) FILTER (WHERE p.status = 'failed')
                AS failed_payments

         FROM payments p
         WHERE p.tenant_id = $1`,
        [tenantId]
    );

    const raw = rows[0];
    const toNum = (v) => Number(v ?? 0);

    const stats = {
        total_revenue:              toNum(raw.total_revenue),
        total_refunded:             toNum(raw.total_refunded),
        total_disputed_amount:      toNum(raw.total_disputed_amount),
        amount_saved_from_disputes: toNum(raw.amount_saved_from_disputes),
        amount_lost_from_disputes:  toNum(raw.amount_lost_from_disputes),
        successful_payments:        toNum(raw.successful_payments),
        failed_payments:            toNum(raw.failed_payments),
    };

    // Net revenue = Revenue - Refunds - Lost disputes
    stats.net_revenue =
        stats.total_revenue -
        stats.total_refunded -
        stats.amount_lost_from_disputes;

    return stats;
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. CHARGEBACK STATS
// ─────────────────────────────────────────────────────────────────────────────

const getChargebackStats = async (tenantId) => {

    const { rows } = await pool.query(
        `SELECT
            COUNT(*)                                            AS total_disputes,
            COUNT(*) FILTER (WHERE status = 'won')             AS won,
            COUNT(*) FILTER (WHERE status = 'lost')            AS lost,
            COUNT(*) FILTER (
                WHERE status IN ('needs_response','under_review','warning_needs_response','warning_under_review')
            )                                                   AS under_review,
            COUNT(*) FILTER (WHERE status = 'charge_refunded') AS charge_refunded,

            COALESCE(SUM(amount), 0)                            AS total_amount,
            COALESCE(SUM(amount) FILTER (WHERE status = 'won'),  0) AS amount_saved,
            COALESCE(SUM(amount) FILTER (WHERE status = 'lost'), 0) AS amount_lost,
            COALESCE(SUM(amount) FILTER (
                WHERE status IN ('needs_response','under_review','warning_needs_response','warning_under_review')
            ), 0)                                               AS amount_at_risk,

            -- Win rate
            ROUND(
                COUNT(*) FILTER (WHERE status = 'won') * 100.0
                / NULLIF(COUNT(*) FILTER (WHERE status IN ('won','lost')), 0),
                2
            )                                                   AS win_rate_percent,

            -- Average dispute amount
            ROUND(AVG(amount), 2)                               AS avg_dispute_amount

         FROM disputes
         WHERE tenant_id = $1`,
        [tenantId]
    );

    return rows[0];
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. REFUND STATS
// ─────────────────────────────────────────────────────────────────────────────

const getRefundStats = async (tenantId) => {

    const { rows } = await pool.query(
        `SELECT
            COUNT(*)                                                         AS total_refunds,
            COALESCE(SUM(amount), 0)                                         AS total_amount_refunded,

            -- Full vs partial
            COUNT(*) FILTER (WHERE refund_percentage = 100)                  AS full_refunds,
            COUNT(*) FILTER (WHERE refund_percentage < 100
                             AND refund_percentage IS NOT NULL)               AS partial_refunds,

            -- Usage deducted — kitna merchant ne bachaya
            COALESCE(SUM(usage_deducted_amount), 0)                          AS total_usage_deducted,
            COALESCE(SUM(merchant_loss_amount), 0)                           AS total_merchant_loss,

            -- By reason
            COUNT(*) FILTER (WHERE reason = 'duplicate')                     AS reason_duplicate,
            COUNT(*) FILTER (WHERE reason = 'fraudulent')                    AS reason_fraudulent,
            COUNT(*) FILTER (WHERE reason = 'requested_by_customer')         AS reason_requested,

            -- Average refund
            ROUND(AVG(amount), 2)                                            AS avg_refund_amount

         FROM refunds
         WHERE tenant_id = $1`,
        [tenantId]
    );

    return rows[0];
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. DISPUTE LIST — merchant ke liye saari disputes
// ─────────────────────────────────────────────────────────────────────────────

const getDisputeList = async (tenantId, { status, page = 1, limit = 20 } = {}) => {

    const offset = (page - 1) * limit;

    const conditions = ['d.tenant_id = $1'];
    const values     = [tenantId];
    let   idx        = 2;

    if (status) {
        conditions.push(`d.status = $${idx++}`);
        values.push(status);
    }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(
        `SELECT
            d.id,
            d.stripe_dispute_id,
            d.reason,
            d.status,
            d.amount,
            d.currency,
            d.evidence_due_by,
            d.is_charge_refundable,
            d.created_at              AS dispute_created_at,

            -- Payment details
            p.stripe_payment_intent_id,
            p.stripe_charge_id,
            p.amount                  AS payment_amount,
            p.card_brand,
            p.card_last4,
            p.three_d_secure_used,
            p.three_d_secure_result,
            p.cvc_check,
            p.risk_level,
            p.risk_score,
            p.paid_at,

            -- Customer
            c.stripe_customer_id,
            c.id                      AS customer_id

         FROM disputes d
         LEFT JOIN payments  p ON p.id          = d.payment_id
         LEFT JOIN customers c ON c.id          = p.customer_id
         WHERE ${where}
         ORDER BY d.created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...values, limit, offset]
    );

    // Total count for pagination
    const countResult = await pool.query(
        `SELECT COUNT(*) FROM disputes d WHERE ${where}`,
        values
    );

    return {
        disputes:   rows,
        total:      parseInt(countResult.rows[0].count),
        page,
        limit,
        total_pages: Math.ceil(countResult.rows[0].count / limit),
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. DISPUTE DETAIL — ek dispute ki poori story
//    Merchant ko yahan se saare proofs milenge chargeback fight ke liye
// ─────────────────────────────────────────────────────────────────────────────

const getDisputeDetail = async (tenantId, disputeId) => {

    // ── Dispute + Payment + Customer ──────────────────────────────────────
    const disputeResult = await pool.query(
        `SELECT
            d.*,

            -- Payment proof
            p.stripe_payment_intent_id,
            p.stripe_charge_id,
            p.payment_method_type,
            p.card_brand,
            p.card_last4,
            p.card_country,
            p.amount                  AS payment_amount,
            p.currency                AS payment_currency,
            p.three_d_secure_used,
            p.three_d_secure_result,
            p.cvc_check,
            p.avs_check,
            p.risk_level,
            p.risk_score,
            p.receipt_url,
            p.paid_at,

            -- Customer
            c.id                      AS customer_id,
            c.stripe_customer_id,
            c.country                 AS customer_country

         FROM disputes d
         LEFT JOIN payments  p ON p.id = d.payment_id
         LEFT JOIN customers c ON c.id = p.customer_id
         WHERE d.tenant_id = $1
           AND d.id        = $2`,
        [tenantId, disputeId]
    );

    if (!disputeResult.rows.length) {
        throw new Error('Dispute not found');
    }

    const dispute   = disputeResult.rows[0];
    const customerId = dispute.customer_id;

    // ── Subscription — kab subscribe kiya, kab tak ────────────────────────
    const subscriptionResult = await pool.query(
        `SELECT
            s.stripe_subscription_id,
            s.status,
            s.stripe_price_id,
            s.stripe_product_id,
            s.amount                  AS plan_amount,
            s.currency                AS plan_currency,
            s.interval,
            s.interval_count,
            s.trial_start,
            s.trial_end,
            s.current_period_start,
            s.current_period_end,
            s.created_at              AS subscribed_at,
            s.cancelled_at,
            s.ended_at

         FROM subscriptions s
         WHERE s.tenant_id   = $1
           AND s.customer_id = $2
         ORDER BY s.created_at DESC
         LIMIT 5`,
        [tenantId, customerId]
    );

    // ── Invoice history — kitne invoices pay kiye ─────────────────────────
    const invoiceResult = await pool.query(
        `SELECT
            stripe_invoice_id,
            status,
            amount_due,
            amount_paid,
            currency,
            billing_reason,
            period_start,
            period_end,
            paid_at,
            invoice_pdf,
            hosted_invoice_url

         FROM invoices
         WHERE tenant_id   = $1
           AND customer_id = $2
         ORDER BY created_at DESC`,
        [tenantId, customerId]
    );

    // ── Usage events — services kitna use kiya ────────────────────────────
    const usageResult = await pool.query(
        `SELECT
            event_type,
            resource_type,
            resource_id,
            quantity,
            unit,
            country,
            created_at

         FROM usage_events
         WHERE tenant_id   = $1
           AND customer_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [tenantId, customerId]
    );

    // ── Customer timeline — poori story chronologically ───────────────────
    const timelineResult = await pool.query(
        `SELECT
            event_type,
            title,
            description,
            source,
            reference_id,
            created_at

         FROM customer_timeline
         WHERE tenant_id   = $1
           AND customer_id = $2
         ORDER BY created_at ASC`,
        [tenantId, customerId]
    );

    // ── Fraud signals ──────────────────────────────────────────────────────
    const fraudResult = await pool.query(
        `SELECT
            signal_type,
            severity,
            score,
            description,
            created_at

         FROM fraud_signals
         WHERE tenant_id   = $1
           AND customer_id = $2
         ORDER BY created_at DESC`,
        [tenantId, customerId]
    );

    // ── Total amount paid by customer — subscription se pehle kitna diya ──
    const totalPaidResult = await pool.query(
        `SELECT
            COALESCE(SUM(amount_paid), 0) AS total_paid,
            COUNT(*)                       AS total_invoices

         FROM invoices
         WHERE tenant_id   = $1
           AND customer_id = $2
           AND status      = 'paid'`,
        [tenantId, customerId]
    );

    return {
        dispute,
        subscriptions:    subscriptionResult.rows,
        invoices:         invoiceResult.rows,
        usage_events:     usageResult.rows,
        timeline:         timelineResult.rows,
        fraud_signals:    fraudResult.rows,
        customer_summary: totalPaidResult.rows[0],
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. REFUND LIST
// ─────────────────────────────────────────────────────────────────────────────

const getRefundList = async (tenantId, { page = 1, limit = 20 } = {}) => {

    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
        `SELECT
            r.id,
            r.stripe_refund_id,
            r.amount,
            r.currency,
            r.reason,
            r.status,
            r.initiated_by,
            r.refund_percentage,
            r.usage_deducted_amount,
            r.merchant_loss_amount,
            r.created_at,

            -- Payment details
            p.stripe_payment_intent_id,
            p.stripe_charge_id,
            p.card_brand,
            p.card_last4,
            p.paid_at,

            -- Customer
            c.stripe_customer_id,
            c.id AS customer_id

         FROM refunds r
         LEFT JOIN payments  p ON p.id = r.payment_id
         LEFT JOIN customers c ON c.id = p.customer_id
         WHERE r.tenant_id = $1
         ORDER BY r.created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset]
    );

    const countResult = await pool.query(
        `SELECT COUNT(*) FROM refunds WHERE tenant_id = $1`,
        [tenantId]
    );

    return {
        refunds:     rows,
        total:       parseInt(countResult.rows[0].count),
        page,
        limit,
        total_pages: Math.ceil(countResult.rows[0].count / limit),
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. REVENUE CHART DATA — last 30 days
// ─────────────────────────────────────────────────────────────────────────────

const getRevenueChartData = async (tenantId, days = 30) => {

    const { rows } = await pool.query(
        `SELECT
            DATE(paid_at)            AS date,
            COALESCE(SUM(amount), 0) AS revenue,
            COUNT(*)                 AS transactions

         FROM payments
         WHERE tenant_id = $1
           AND status    = 'succeeded'
           AND paid_at  >= NOW() - ($2 || ' days')::INTERVAL
         GROUP BY DATE(paid_at)
         ORDER BY DATE(paid_at) ASC`,
        [tenantId, days]
    );

    return rows;
};

module.exports = {
    getOverviewStats,
    getChargebackStats,
    getRefundStats,
    getDisputeList,
    getDisputeDetail,
    getRefundList,
    getRevenueChartData,
};