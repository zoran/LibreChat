const express = require('express');
const { updateUserKey, deleteUserKey, getUserKeyExpiry } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const {
  ownAuthHandler,
  authTrack,
  authPersistence,
} = require('~/server/services/LegacyAuthMaintenance');

const router = express.Router();

router.put(
  '/',
  requireJwtAuth,
  ownAuthHandler(async (req, res) => {
    if (req.body == null || typeof req.body !== 'object') {
      return res.status(400).send({ error: 'Invalid request body.' });
    }
    const { name, value, expiresAt } = req.body;
    await authTrack(() =>
      updateUserKey({ userId: req.user.id, name, value, expiresAt }, authPersistence),
    );
    res.status(201).send();
  }),
);

router.delete(
  '/:name',
  requireJwtAuth,
  ownAuthHandler(async (req, res) => {
    const { name } = req.params;
    await authTrack(() => deleteUserKey({ userId: req.user.id, name }, authPersistence));
    res.status(204).send();
  }),
);

router.delete(
  '/',
  requireJwtAuth,
  ownAuthHandler(async (req, res) => {
    const { all } = req.query;

    if (all !== 'true') {
      return res.status(400).send({ error: 'Specify either all=true to delete.' });
    }

    await authTrack(() => deleteUserKey({ userId: req.user.id, all: true }, authPersistence));

    res.status(204).send();
  }),
);

router.get(
  '/',
  requireJwtAuth,
  ownAuthHandler(async (req, res) => {
    const { name } = req.query;
    const response = await getUserKeyExpiry({ userId: req.user.id, name });
    res.status(200).send(response);
  }),
);

module.exports = router;
