const router = require('express').Router();

const {
    createTenant
} = require('../controllers/tenants.controllers');

router.post('/', createTenant);

module.exports = router;