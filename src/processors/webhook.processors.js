const pool = require('../../db/conn');

// ─────────────────────────────────────────────────────────────────────────────
// EVENT ROUTER — event type ke hisaab se sahi handler call karo
// ─────────────────────────────────────────────────────────────────────────────

async function processStripeEvent(tenantId, event) {
    const obj = event.data.object;

    switch (event.type) {

        // ── Customer ──────────────────────────────────────────────────────
        case 'customer.created':
            await upsertCustomer(tenantId, obj);
            break;

        case 'customer.updated':
            await upsertCustomer(tenantId, obj);
            break;

        case 'customer.deleted':
            await softDeleteCustomer(tenantId, obj);
            break;

        // ── Subscription ──────────────────────────────────────────────────
        case 'customer.subscription.created':
            await upsertSubscription(tenantId, obj);
            await addCustomerTimeline(tenantId, obj.customer, {
                event_type:   'subscription_created',
                title:        'Subscription Started',
                description:  `Plan: ${obj.items?.data?.[0]?.price?.nickname || obj.items?.data?.[0]?.price?.id}`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        case 'customer.subscription.updated':
            await upsertSubscription(tenantId, obj);
            await addCustomerTimeline(tenantId, obj.customer, {
                event_type:   'subscription_updated',
                title:        'Subscription Updated',
                description:  `Status: ${obj.status}`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        case 'customer.subscription.deleted':
            await upsertSubscription(tenantId, obj);
            await addCustomerTimeline(tenantId, obj.customer, {
                event_type:   'subscription_cancelled',
                title:        'Subscription Cancelled',
                description:  `Ended at: ${obj.ended_at ? new Date(obj.ended_at * 1000).toISOString() : 'N/A'}`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        case 'customer.subscription.trial_will_end':
            await addCustomerTimeline(tenantId, obj.customer, {
                event_type:   'trial_ending_soon',
                title:        'Trial Ending Soon',
                description:  `Trial ends: ${new Date(obj.trial_end * 1000).toISOString()}`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        // ── Invoice ───────────────────────────────────────────────────────
        case 'invoice.created':
            await upsertInvoice(tenantId, obj);
            break;

        case 'invoice.finalized':
            await upsertInvoice(tenantId, obj);
            await addCustomerTimeline(tenantId, obj.customer, {
                event_type:   'invoice_finalized',
                title:        'Invoice Finalized',
                description:  `Amount due: ${(obj.amount_due / 100).toFixed(2)} ${(obj.currency ?? '').toUpperCase()} — Invoice: ${obj.id}`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        case 'invoice.paid':
        case 'invoice.payment_succeeded':
            await upsertInvoice(tenantId, obj);
            await handleInvoicePaymentSucceeded(tenantId, obj);
            break;

        case 'invoice.payment_failed':
            await upsertInvoice(tenantId, obj);
            await handleInvoicePaymentFailed(tenantId, obj);
            break;

        case 'invoice.voided':
            await upsertInvoice(tenantId, obj);
            await addCustomerTimeline(tenantId, obj.customer, {
                event_type:   'invoice_voided',
                title:        'Invoice Voided',
                description:  `Invoice ${obj.id} has been voided`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        case 'invoice.marked_uncollectible':
            await upsertInvoice(tenantId, obj);
            await addCustomerTimeline(tenantId, obj.customer, {
                event_type:   'invoice_uncollectible',
                title:        'Invoice Marked Uncollectible',
                description:  `Amount: ${(obj.amount_due / 100).toFixed(2)} ${(obj.currency ?? '').toUpperCase()}`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        // ── Payment Intent ────────────────────────────────────────────────
        case 'payment_intent.succeeded':
            await upsertPaymentFromIntent(tenantId, obj, 'succeeded');
            break;

        case 'payment_intent.payment_failed':
            await upsertPaymentFromIntent(tenantId, obj, 'failed');
            break;

        case 'payment_intent.canceled':
            await upsertPaymentFromIntent(tenantId, obj, 'canceled');
            break;
        case 'payment_intent.created':
            // intentionally ignored
            break;

        // ── Charge — 3DS, card details, risk score yahan milte hain ──────
        case 'charge.succeeded':
            await handleCharge(tenantId, obj);
            break;

        case 'charge.failed':
            await handleCharge(tenantId, obj);
            break;

        case 'charge.updated':
            await handleCharge(tenantId, obj);
            break;

        case 'charge.refunded':
            await handleChargeRefunded(tenantId, obj);
            break;

        // ── Dispute — chargeback protection ──────────────────────────────
        case 'charge.dispute.created':
            await upsertDispute(tenantId, obj);
            await flagPaymentDisputed(tenantId, obj.charge);
            await addDisputeTimeline(tenantId, obj);
            break;

        case 'charge.dispute.updated':
            await upsertDispute(tenantId, obj);
            break;

        case 'charge.dispute.closed':
            await upsertDispute(tenantId, obj);
            await addCustomerTimelineByCharge(tenantId, obj.charge, {
                event_type:   'dispute_closed',
                title:        'Dispute Closed',
                description:  `Outcome: ${obj.status} — Reason: ${obj.reason}`,
                source:       'stripe',
                reference_id: obj.id,
            });
            break;

        // ── Refund ────────────────────────────────────────────────────────
        case 'refund.created':
        case 'refund.updated':
            await upsertRefund(tenantId, obj);
            break;

        default:
            console.info(`[Webhook] No handler for: ${event.type}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// ── Customer ──────────────────────────────────────────────────────────────────

async function upsertCustomer(tenantId, obj) {
    await pool.query(
        `INSERT INTO customers (
            tenant_id,
            stripe_customer_id,
            email_hash,
            country,
            metadata,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (stripe_customer_id)
        DO UPDATE SET
            country    = EXCLUDED.country,
            metadata   = EXCLUDED.metadata,
            updated_at = CURRENT_TIMESTAMP`,
        [
            tenantId,
            obj.id,
            obj.email   ?? null,   // plain email as hash placeholder — encrypt in prod
            obj.address?.country ?? null,
            obj.metadata ? JSON.stringify(obj.metadata) : null,
        ]
    );
}

async function softDeleteCustomer(tenantId, obj) {
    await pool.query(
        `UPDATE customers
            SET updated_at = CURRENT_TIMESTAMP,
                metadata   = jsonb_set(COALESCE(metadata, '{}'), '{deleted}', 'true')
          WHERE tenant_id          = $1
            AND stripe_customer_id = $2`,
        [tenantId, obj.id]
    );
}

// ── Subscription ──────────────────────────────────────────────────────────────

async function upsertSubscription(tenantId, obj) {

    // customer ka internal UUID fetch karo
    const customerRow = await pool.query(
        `SELECT id FROM customers
          WHERE tenant_id = $1 AND stripe_customer_id = $2`,
        [tenantId, obj.customer]
    );

    // customer abhi tak save nahi hua toh pehle create karo
    if (!customerRow.rows.length) {
        await pool.query(
            `INSERT INTO customers (tenant_id, stripe_customer_id, created_at, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (stripe_customer_id) DO NOTHING`,
            [tenantId, obj.customer]
        );
    }

    const customerId = customerRow.rows[0]?.id;

    const item  = obj.items?.data?.[0];
    const price = item?.price;

    await pool.query(
        `INSERT INTO subscriptions (
            tenant_id,
            customer_id,
            stripe_subscription_id,
            stripe_price_id,
            stripe_product_id,
            status,
            currency,
            amount,
            interval,
            interval_count,
            trial_start,
            trial_end,
            current_period_start,
            current_period_end,
            cancel_at,
            cancelled_at,
            ended_at,
            latest_invoice_id,
            metadata,
            created_at,
            updated_at
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT (stripe_subscription_id)
        DO UPDATE SET
            status               = EXCLUDED.status,
            current_period_start = EXCLUDED.current_period_start,
            current_period_end   = EXCLUDED.current_period_end,
            cancel_at            = EXCLUDED.cancel_at,
            cancelled_at         = EXCLUDED.cancelled_at,
            ended_at             = EXCLUDED.ended_at,
            latest_invoice_id    = EXCLUDED.latest_invoice_id,
            metadata             = EXCLUDED.metadata,
            updated_at           = CURRENT_TIMESTAMP`,
        [
            tenantId,
            customerId                                              ?? null, // $2
            obj.id,                                                          // $3
            price?.id                                              ?? null, // $4
            price?.product                                         ?? null, // $5
            obj.status,                                                      // $6
            obj.currency                                           ?? null, // $7
            price?.unit_amount                                     ?? null, // $8
            price?.recurring?.interval                             ?? null, // $9
            price?.recurring?.interval_count                       ?? null, // $10
            obj.trial_start  ? new Date(obj.trial_start  * 1000)  : null,  // $11
            obj.trial_end    ? new Date(obj.trial_end    * 1000)  : null,  // $12
            obj.current_period_start ? new Date(obj.current_period_start * 1000) : null, // $13
            obj.current_period_end   ? new Date(obj.current_period_end   * 1000) : null, // $14
            obj.cancel_at    ? new Date(obj.cancel_at    * 1000)  : null,  // $15
            obj.canceled_at  ? new Date(obj.canceled_at  * 1000)  : null,  // $16
            obj.ended_at     ? new Date(obj.ended_at     * 1000)  : null,  // $17
            obj.latest_invoice                                     ?? null, // $18
            obj.metadata     ? JSON.stringify(obj.metadata)        : null,  // $19
        ]
    );
}

// ── Charge — 3DS + risk + card details yahan milte hain ──────────────────────

async function handleCharge(tenantId, obj) {

    const outcome = obj.outcome ?? {};
    const card    = obj.payment_method_details?.card ?? {};
    const threeds = card.three_d_secure ?? {};

    // payment_intent ke saath link karke payments table update karo
    await pool.query(
        `UPDATE payments SET
            stripe_charge_id       = $2,
            payment_method_type    = $3,
            card_brand             = $4,
            card_last4             = $5,
            card_country           = $6,
            receipt_url            = $7,
            risk_level             = $8,
            risk_score             = $9,
            network_status         = $10,
            cvc_check              = $11,
            avs_check              = $12,
            three_d_secure_used    = $13,
            three_d_secure_result  = $14,
            status                 = $15
          WHERE tenant_id               = $1
            AND stripe_payment_intent_id = $16`,
        [
            tenantId,                                                   // $1
            obj.id,                                                     // $2  charge id
            obj.payment_method_details?.type        ?? null,           // $3
            card.brand                              ?? null,           // $4
            card.last4                              ?? null,           // $5
            card.country                            ?? null,           // $6
            obj.receipt_url                         ?? null,           // $7
            outcome.risk_level                      ?? null,           // $8  ← fraud signal
            outcome.risk_score                      ?? null,           // $9  ← fraud signal
            outcome.network_status                  ?? null,           // $10
            card.checks?.cvc_check                  ?? null,           // $11
            card.checks?.address_line1_check        ?? null,           // $12
            threeds.authenticated !== undefined ? true : false,        // $13 ← 3DS used?
            threeds.result                          ?? null,           // $14 ← 3DS result
            obj.status,                                                 // $15
            obj.payment_intent,                                         // $16
        ]
    );

    // High risk charges ke liye fraud_signals table mein bhi daalo
    if (outcome.risk_level === 'elevated' || outcome.risk_level === 'highest') {
        await insertFraudSignal(tenantId, obj, outcome);
    }
}

// ── Invoice ───────────────────────────────────────────────────────────────────

async function upsertInvoice(tenantId, obj) {

    // customer ka internal UUID
    const customerRow = await pool.query(
        `SELECT id FROM customers
          WHERE tenant_id = $1 AND stripe_customer_id = $2`,
        [tenantId, obj.customer]
    );
    const customerId = customerRow.rows[0]?.id ?? null;

    // subscription ka internal UUID
    let subscriptionId = null;
    if (obj.subscription) {
        const subRow = await pool.query(
            `SELECT id FROM subscriptions
              WHERE tenant_id = $1 AND stripe_subscription_id = $2`,
            [tenantId, obj.subscription]
        );
        subscriptionId = subRow.rows[0]?.id ?? null;
    }

    await pool.query(
        `INSERT INTO invoices (
            tenant_id,
            customer_id,
            subscription_id,
            stripe_invoice_id,
            stripe_payment_intent_id,
            stripe_charge_id,
            status,
            currency,
            amount_due,
            amount_paid,
            amount_remaining,
            subtotal,
            tax,
            invoice_pdf,
            hosted_invoice_url,
            period_start,
            period_end,
            due_date,
            paid_at,
            attempt_count,
            auto_advance,
            collection_method,
            billing_reason,
            metadata,
            created_at,
            updated_at
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,$22,$23,$24,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT (stripe_invoice_id)
        DO UPDATE SET
            status                   = EXCLUDED.status,
            amount_paid              = EXCLUDED.amount_paid,
            amount_remaining         = EXCLUDED.amount_remaining,
            stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
            stripe_charge_id         = EXCLUDED.stripe_charge_id,
            invoice_pdf              = EXCLUDED.invoice_pdf,
            hosted_invoice_url       = EXCLUDED.hosted_invoice_url,
            paid_at                  = EXCLUDED.paid_at,
            attempt_count            = EXCLUDED.attempt_count,
            metadata                 = EXCLUDED.metadata,
            updated_at               = CURRENT_TIMESTAMP`,
        [
            tenantId,                                                              // $1
            customerId,                                                            // $2
            subscriptionId,                                                        // $3
            obj.id,                                                                // $4
            obj.payment_intent                              ?? null,              // $5
            obj.charge                                      ?? null,              // $6
            obj.status,                                                            // $7
            obj.currency                                    ?? null,              // $8
            obj.amount_due                                  ?? 0,                 // $9
            obj.amount_paid                                 ?? 0,                 // $10
            obj.amount_remaining                            ?? 0,                 // $11
            obj.subtotal                                    ?? 0,                 // $12
            obj.tax                                         ?? 0,                 // $13
            obj.invoice_pdf                                 ?? null,              // $14
            obj.hosted_invoice_url                          ?? null,              // $15
            obj.period_start  ? new Date(obj.period_start  * 1000) : null,       // $16
            obj.period_end    ? new Date(obj.period_end    * 1000) : null,       // $17
            obj.due_date      ? new Date(obj.due_date      * 1000) : null,       // $18
            obj.status_transitions?.paid_at
                ? new Date(obj.status_transitions.paid_at  * 1000) : null,       // $19
            obj.attempt_count                               ?? 0,                 // $20
            obj.auto_advance                                ?? true,              // $21
            obj.collection_method                           ?? null,              // $22
            obj.billing_reason                              ?? null,              // $23
            obj.metadata      ? JSON.stringify(obj.metadata) : null,             // $24
        ]
    );
}

// ── Payment Intent ────────────────────────────────────────────────────────────

async function upsertPaymentFromIntent(tenantId, obj, status) {

    // customer ka internal UUID
    const customerRow = await pool.query(
        `SELECT id FROM customers
          WHERE tenant_id = $1 AND stripe_customer_id = $2`,
        [tenantId, obj.customer]
    );
    const customerId = customerRow.rows[0]?.id ?? null;

    await pool.query(
        `INSERT INTO payments (
            tenant_id,
            customer_id,
            stripe_payment_intent_id,
            currency,
            amount,
            status,
            paid_at,
            created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
        ON CONFLICT (stripe_payment_intent_id)
        DO UPDATE SET
            status  = EXCLUDED.status,
            paid_at = EXCLUDED.paid_at`,
        [
            tenantId,
            customerId,
            obj.id,
            obj.currency                                        ?? null,
            obj.amount,
            status,
            status === 'succeeded' ? new Date() : null,
        ]
    );

    // Timeline mein bhi add karo
    if (obj.customer) {
        await addCustomerTimeline(tenantId, obj.customer, {
            event_type:   status === 'succeeded' ? 'payment_succeeded' : 'payment_failed',
            title:        status === 'succeeded' ? 'Payment Succeeded' : 'Payment Failed',
            description:  `Amount: ${(obj.amount / 100).toFixed(2)} ${(obj.currency ?? '').toUpperCase()}`,
            source:       'stripe',
            reference_id: obj.id,
        });
    }
}

// ── Invoice Payment Handlers ──────────────────────────────────────────────────

async function handleInvoicePaymentSucceeded(tenantId, obj) {

    // Subscription period update karo
    if (obj.subscription) {
        await pool.query(
            `UPDATE subscriptions
                SET latest_invoice_id = $3,
                    updated_at        = CURRENT_TIMESTAMP
              WHERE tenant_id              = $1
                AND stripe_subscription_id = $2`,
            [tenantId, obj.subscription, obj.id]
        );
    }

    // Payment record
    if (obj.payment_intent) {
        const customerRow = await pool.query(
            `SELECT id FROM customers
              WHERE tenant_id = $1 AND stripe_customer_id = $2`,
            [tenantId, obj.customer]
        );
        const customerId = customerRow.rows[0]?.id ?? null;

        await pool.query(
            `INSERT INTO payments (
                tenant_id,
                customer_id,
                stripe_payment_intent_id,
                stripe_invoice_id,
                currency,
                amount,
                status,
                invoice_pdf,
                paid_at,
                created_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,'succeeded',$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            ON CONFLICT (stripe_payment_intent_id)
            DO UPDATE SET
                status      = 'succeeded',
                invoice_pdf = EXCLUDED.invoice_pdf,
                paid_at     = EXCLUDED.paid_at`,
            [
                tenantId,
                customerId,
                obj.payment_intent,
                obj.id,
                obj.currency ?? null,
                obj.amount_paid,
                obj.invoice_pdf ?? null,
            ]
        );
    }

    await addCustomerTimeline(tenantId, obj.customer, {
        event_type:   'invoice_paid',
        title:        'Invoice Paid',
        description:  `Amount: ${(obj.amount_paid / 100).toFixed(2)} ${(obj.currency ?? '').toUpperCase()} — Invoice: ${obj.id}`,
        source:       'stripe',
        reference_id: obj.id,
    });
}

async function handleInvoicePaymentFailed(tenantId, obj) {

    await addCustomerTimeline(tenantId, obj.customer, {
        event_type:   'invoice_payment_failed',
        title:        'Invoice Payment Failed',
        description:  `Amount due: ${(obj.amount_due / 100).toFixed(2)} ${(obj.currency ?? '').toUpperCase()} — Attempt: ${obj.attempt_count}`,
        source:       'stripe',
        reference_id: obj.id,
    });

    // Subscription status bhi update karo — past_due ya unpaid ho sakta hai
    if (obj.subscription) {
        await pool.query(
            `UPDATE subscriptions
                SET status     = 'past_due',
                    updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id              = $1
                AND stripe_subscription_id = $2`,
            [tenantId, obj.subscription]
        );
    }
}

// ── Dispute (Chargeback) ──────────────────────────────────────────────────────

async function upsertDispute(tenantId, obj) {

    // charge se payment_id dhundo — charge_id ya payment_intent se match karo
    let paymentRow = await pool.query(
        `SELECT id FROM payments
          WHERE tenant_id        = $1
            AND stripe_charge_id = $2`,
        [tenantId, obj.charge]
    );

    // charge_id se nahi mila toh payment_intent se try karo
    if (!paymentRow.rows.length && obj.payment_intent) {
        paymentRow = await pool.query(
            `SELECT id FROM payments
              WHERE tenant_id                = $1
                AND stripe_payment_intent_id = $2`,
            [tenantId, obj.payment_intent]
        );
    }

    // Abhi bhi nahi mila toh charge_id se payment create karo
    if (!paymentRow.rows.length) {
        const inserted = await pool.query(
            `INSERT INTO payments (
                tenant_id,
                stripe_charge_id,
                stripe_payment_intent_id,
                amount,
                currency,
                status,
                disputed,
                created_at
            )
            VALUES ($1,$2,$3,$4,$5,'unknown',true,CURRENT_TIMESTAMP)
            ON CONFLICT (stripe_charge_id) DO UPDATE SET disputed = true
            RETURNING id`,
            [
                tenantId,
                obj.charge,
                obj.payment_intent ?? null,
                obj.amount,
                obj.currency ?? null,
            ]
        );
        paymentRow = inserted;
    }

    const paymentId = paymentRow.rows[0]?.id ?? null;

    await pool.query(
        `INSERT INTO disputes (
            tenant_id,
            payment_id,
            stripe_dispute_id,
            stripe_charge_id,
            reason,
            status,
            amount,
            currency,
            evidence_due_by,
            is_charge_refundable,
            created_at,
            updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT (stripe_dispute_id)
        DO UPDATE SET
            status               = EXCLUDED.status,
            evidence_due_by      = EXCLUDED.evidence_due_by,
            is_charge_refundable = EXCLUDED.is_charge_refundable,
            updated_at           = CURRENT_TIMESTAMP`,
        [
            tenantId,
            paymentId,
            obj.id,
            obj.charge,
            obj.reason                                                       ?? null,
            obj.status,
            obj.amount,
            obj.currency                                                     ?? null,
            obj.evidence_details?.due_by
                ? new Date(obj.evidence_details.due_by * 1000)
                : null,
            obj.is_charge_refundable ?? true,
        ]
    );
}

async function flagPaymentDisputed(tenantId, stripeChargeId) {
    await pool.query(
        `UPDATE payments
            SET disputed = true
          WHERE tenant_id      = $1
            AND stripe_charge_id = $2`,
        [tenantId, stripeChargeId]
    );
}

async function addDisputeTimeline(tenantId, obj) {
    // charge se customer dhundo
    await addCustomerTimelineByCharge(tenantId, obj.charge, {
        event_type:   'dispute_opened',
        title:        '⚠️ Chargeback Opened',
        description:  `Reason: ${obj.reason} — Amount: ${(obj.amount / 100).toFixed(2)} ${(obj.currency ?? '').toUpperCase()} — Evidence due: ${obj.evidence_details?.due_by ? new Date(obj.evidence_details.due_by * 1000).toISOString() : 'N/A'}`,
        source:       'stripe',
        reference_id: obj.id,
    });
}

// ── Refund ────────────────────────────────────────────────────────────────────

async function handleChargeRefunded(tenantId, obj) {
    // payments table update karo
    await pool.query(
        `UPDATE payments
            SET refunded        = true,
                amount_refunded = $3
          WHERE tenant_id        = $1
            AND stripe_charge_id = $2`,
        [tenantId, obj.id, obj.amount_refunded]
    );

    // refunds table mein save karo
    const refund = obj.refunds?.data?.[0];
    if (refund) {
        await upsertRefund(tenantId, refund);
    }
}

async function upsertRefund(tenantId, obj) {

    // charge_id se dhundo, nahi mila toh payment_intent se
    let paymentRow = await pool.query(
        `SELECT id FROM payments
          WHERE tenant_id        = $1
            AND stripe_charge_id = $2`,
        [tenantId, obj.charge]
    );

    if (!paymentRow.rows.length && obj.payment_intent) {
        paymentRow = await pool.query(
            `SELECT id FROM payments
              WHERE tenant_id                = $1
                AND stripe_payment_intent_id = $2`,
            [tenantId, obj.payment_intent]
        );
    }

    const paymentId = paymentRow.rows[0]?.id ?? null;

    await pool.query(
        `INSERT INTO refunds (
            tenant_id,
            payment_id,
            stripe_refund_id,
            amount,
            currency,
            reason,
            status,
            initiated_by,
            created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
        ON CONFLICT (stripe_refund_id)
        DO UPDATE SET
            status = EXCLUDED.status`,
        [
            tenantId,
            paymentId,
            obj.id,
            obj.amount,
            obj.currency  ?? null,
            obj.reason    ?? null,
            obj.status,
            obj.reason === 'fraudulent' ? 'stripe' : 'merchant',
        ]
    );
}

// ── Fraud Signal ──────────────────────────────────────────────────────────────

async function insertFraudSignal(tenantId, charge, outcome) {

    const customerRow = await pool.query(
        `SELECT id FROM customers
          WHERE tenant_id = $1 AND stripe_customer_id = $2`,
        [tenantId, charge.customer]
    );
    const customerId = customerRow.rows[0]?.id ?? null;

    const paymentRow = await pool.query(
        `SELECT id FROM payments
          WHERE tenant_id = $1 AND stripe_charge_id = $2`,
        [tenantId, charge.id]
    );
    const paymentId = paymentRow.rows[0]?.id ?? null;

    await pool.query(
        `INSERT INTO fraud_signals (
            tenant_id,
            customer_id,
            payment_id,
            signal_type,
            severity,
            score,
            description,
            metadata,
            created_at
        )
        VALUES ($1,$2,$3,'stripe_risk',$4,$5,$6,$7,CURRENT_TIMESTAMP)`,
        [
            tenantId,
            customerId,
            paymentId,
            outcome.risk_level,                             // elevated / highest
            outcome.risk_score ?? null,
            outcome.seller_message ?? outcome.type ?? null,
            JSON.stringify({ charge_id: charge.id, outcome }),
        ]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMELINE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function addCustomerTimeline(tenantId, stripeCustomerId, data) {

    if (!stripeCustomerId) return;

    const customerRow = await pool.query(
        `SELECT id FROM customers
          WHERE tenant_id = $1 AND stripe_customer_id = $2`,
        [tenantId, stripeCustomerId]
    );
    const customerId = customerRow.rows[0]?.id ?? null;

    await pool.query(
        `INSERT INTO customer_timeline (
            tenant_id,
            customer_id,
            event_type,
            title,
            description,
            source,
            reference_id,
            created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)`,
        [
            tenantId,
            customerId,
            data.event_type,
            data.title,
            data.description  ?? null,
            data.source       ?? 'stripe',
            data.reference_id ?? null,
        ]
    );
}

// charge_id se customer dhundh ke timeline mein add karo
async function addCustomerTimelineByCharge(tenantId, stripeChargeId, data) {

    const paymentRow = await pool.query(
        `SELECT p.customer_id, c.stripe_customer_id
           FROM payments p
           JOIN customers c ON c.id = p.customer_id
          WHERE p.tenant_id        = $1
            AND p.stripe_charge_id = $2`,
        [tenantId, stripeChargeId]
    );

    const stripeCustomerId = paymentRow.rows[0]?.stripe_customer_id;
    if (stripeCustomerId) {
        await addCustomerTimeline(tenantId, stripeCustomerId, data);
    }
}

module.exports = { processStripeEvent };