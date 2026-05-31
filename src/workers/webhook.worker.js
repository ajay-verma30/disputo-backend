// webhook.worker.js
const { Worker } = require('bullmq');
const connection = require('../config/redis');
const { markEventProcessed, markEventFailed } = require('../services/webhook.services');
const { processStripeEvent } = require('../processors/webhook.processors'); 

const webhookProcessor = async (job) => {
    const { tenantId, stripeEvent } = job.data;

    console.log(`[Worker] Processing: ${stripeEvent.type} (${stripeEvent.id})`);

    await processStripeEvent(tenantId, stripeEvent);
    await markEventProcessed(stripeEvent.id);

    console.log(`[Worker] ✅ Done: ${stripeEvent.id}`);
};

const worker = new Worker('stripe-webhooks', webhookProcessor, {
    connection,
    concurrency: 10,
});

worker.on('completed', (job) => {
    console.log(`[Worker] Job Completed: ${job.id}`);
});

worker.on('failed', async (job, err) => {
    console.error(`[Worker] Job Failed: ${job.id}`, err.message);

    // Saari retries khatam hone ke baad hi markEventFailed call karo
    if (job.attemptsMade >= job.opts.attempts) {
        await markEventFailed(job.data.stripeEvent.id, err.message).catch(() => {});
    }
});



module.exports = worker;