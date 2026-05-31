const pool = require('../../db/conn');

const saveStripeEvent = async (tenantId, event) => {

    const {
        id:           stripeEventId,
        type:         eventType,
        api_version:  apiVersion,
        livemode,
        created:      eventCreated,
        request,
        data,
    } = event;

    const objectType     = data?.object?.object ?? null;
    const requestId      = request?.id          ?? null;
    const idempotencyKey = request?.idempotency_key ?? null;

    const { rows } = await pool.query(
        `INSERT INTO stripe_events (
            tenant_id,
            stripe_event_id,
            event_type,
            api_version,
            livemode,
            object_type,
            event_created,
            request_id,
            idempotency_key,
            payload,
            processed,
            received_at
        )
        VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            false,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT (stripe_event_id) DO NOTHING
        RETURNING id;`,
        [
            tenantId,
            stripeEventId,
            eventType,
            apiVersion      ?? null,
            livemode        ?? false,
            objectType,
            eventCreated    ?? null,
            requestId,
            idempotencyKey,
            JSON.stringify(event),  // full payload JSONB mein
        ]
    );

    // null matlab duplicate — already save ho chuka tha
    return rows[0] ?? null;
};

/**
 * Event successfully process ho gaya
 */
const markEventProcessed = async (stripeEventId) => {
    await pool.query(
        `UPDATE stripe_events
            SET processed    = true,
                processed_at = CURRENT_TIMESTAMP
          WHERE stripe_event_id = $1`,
        [stripeEventId]
    );
};

/**
 * Event process karte waqt error aaya
 */
const markEventFailed = async (stripeEventId, errorMessage) => {
    await pool.query(
        `UPDATE stripe_events
            SET processing_error = $2,
                processed_at     = CURRENT_TIMESTAMP
          WHERE stripe_event_id = $1`,
        [stripeEventId, errorMessage]
    );
};

module.exports = {
    saveStripeEvent,
    markEventProcessed,
    markEventFailed,
};