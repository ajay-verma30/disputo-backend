const express = require('express');
const verifyStripeWebhook = require('../middlewares/stripeAuthentication');
const { handleStripeWebhook } = require('../controllers/webhook.controllers');

const router = express.Router();

router.post(
    '/stripe/:tenantId',
    express.raw({ type: 'application/json' }), // raw body — signature verify ke liye zaroori
    verifyStripeWebhook,                        // DB se secret fetch, signature verify, req.stripeEvent attach
    handleStripeWebhook                         // save + process
);

module.exports = router;