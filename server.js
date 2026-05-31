const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
require('dotenv').config();
require('./src/workers/webhook.worker');
const tenantRoutes = require('./src/routes/tenants.routes');
const userRoutes = require('./src/routes/users.routes');
const webhookRouter = require('./src/routes/webhook.routes');
const dashboardRouter = require('./src/routes/dashboard.routes');


const app = express();

app.use(cors({
  origin: [
    'http://localhost:3000',  // ← 3000 karo
    'http://localhost:3001',
    'https://disputo.vercel.app'
  ],
  credentials: true
}));


app.use(morgan('combined'));

// ✅ Webhook pehle — express.raw() route ke andar already hai
app.use('/webhooks', webhookRouter);

// ✅ Baaki routes ke liye JSON parser baad mein
app.use(express.json());

app.use('/api/v1/tenants', tenantRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/dashboard', dashboardRouter);

const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.status(200).send({ message: 'Working' });
});

app.listen(port, () => {
    console.log(`http://localhost:${port}`);
});