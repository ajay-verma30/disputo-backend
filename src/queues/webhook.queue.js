const { Queue } = require('bullmq');

const connection = require('../config/redis');

const webhookQueue = new Queue( 'stripe-webhooks', {
    connection
});

module.exports = webhookQueue;