const router = require('express').Router();

const {
    registerUser,
    loginUser,
    getUserTenant
} = require('../controllers/users.controller');

const authentication = require('../middlewares/authentication');

router.post('/register', registerUser);
router.post('/login', loginUser);
router.get('/tenant/me', authentication, getUserTenant);

module.exports = router;