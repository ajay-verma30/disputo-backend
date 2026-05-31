const Stripe = require('stripe');
const stripe = new Stripe('dummy');
const pool = require('../../db/conn');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const verifyStripeWebhook = async (req, res, next) => {

    try {

        const { tenantId } = req.params;

        const signature = req.headers['stripe-signature'];

        if (!signature) {
            return res.status(400).send({
                error: 'Missing stripe signature'
            });
        }

        // DB se tenant ka encrypted webhook secret fetch karo
        const result = await pool.query(
            `SELECT
                pgp_sym_decrypt(
                    stripe_webhook_secret,
                    $2
                ) AS webhook_secret
             FROM tenants
             WHERE id = $1`,
            [tenantId, WEBHOOK_SECRET]
        );

        if (!result.rows.length) {
            return res.status(404).send({
                error: 'Tenant not found'
            });
        }

        const webhookSecret = result.rows[0].webhook_secret;

        // Stripe signature verify karo
        const event = stripe.webhooks.constructEvent(
            req.body,       // raw Buffer — express.raw() zaroori hai
            signature,
            webhookSecret   // tenant ka apna whsec_
        );

        // Controller ke liye attach karo
        req.stripeEvent = event;

        next();

    } catch (error) {
        console.error('[Webhook Error]', error.message);
        return res.status(400).send({
            error: error.message
        });
    }
};

module.exports = verifyStripeWebhook;