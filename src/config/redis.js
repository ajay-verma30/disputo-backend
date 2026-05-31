const IORedis = require('ioredis');

const connection = new IORedis(
    process.env.REDIS_URL,
    {
        maxRetriesPerRequest: null
    }
);


module.exports = connection;