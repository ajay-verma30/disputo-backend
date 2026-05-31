const { saveStripeEvent } = require('../services/webhook.services');
const webhookQueue = require('../queues/webhook.queue');

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const handleStripeWebhook = async (req, res) => {

    const stripeEvent  = req.stripeEvent;  // middleware ne attach kiya
    const { tenantId } = req.params;

    // ── 1. stripe_events table mein save (idempotent) ────────────────────
    let savedEvent;
    try {
        savedEvent = await saveStripeEvent(tenantId, stripeEvent);

        if (!savedEvent) {
            // Stripe ne retry kiya — already saved, ignore karo
            return res.status(200).json({ received: true, duplicate: true });
        }

    } catch (err) {
        console.error('[Webhook] DB insert failed:', err.message);
        return res.status(500).json({ error: 'Failed to save event' });
    }

    // ── 2. BullMQ queue mein job daalo ───────────────────────────────────
    try {
        await webhookQueue.add(
            stripeEvent.type,
            { tenantId, stripeEvent },
            {
                jobId:   stripeEvent.id,   // duplicate jobs automatically skip hongi
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: true,
        removeOnFail: false, // failed jobs rakho debug ke liye
            }
        );4
    } catch (err) {
        console.error('[Webhook] Queue add failed:', err.message);
        // Stripe ko 500 do taaki wo retry kare
        return res.status(500).json({ error: 'Failed to queue event' });
    }

    // ── 3. Stripe ko turant 200 do (30s timeout se bachne ke liye) ───────
    return res.status(200).json({ received: true });
};

module.exports = { handleStripeWebhook };