'use strict';

const express = require('express');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { agentChatLimiter } = require('../middleware/rateLimit');
const { runTurn } = require('../services/agent/runTurn');
const tools = require('../services/agent/tools');

const router = express.Router();

const customerGate = [requireAuth, requireRole('customer', 'developer'), agentChatLimiter];

/**
 * Cooking + order assistant.
 *
 * Chat never places an order by itself from free text — propose builds a
 * preview; confirm (or an explicit confirm message handled in runTurn) places it.
 */
router.post(
  '/chat',
  ...customerGate,
  validate({
    body: z
      .object({
        messages: z
          .array(
            z
              .object({
                role: z.enum(['user', 'assistant']),
                content: z.string().min(1).max(4000),
              })
              .strict()
          )
          .min(1)
          .max(24),
        context: z
          .object({
            marketId: fields.objectId.optional(),
            shopId: fields.objectId.optional(),
            address: z.string().max(500).optional(),
            paymentMethod: z.enum(['cod', 'wallet']).optional(),
            lat: z.number().min(-90).max(90).optional(),
            lng: z.number().min(-180).max(180).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const result = await runTurn(req.user, req.valid.body.messages, req.valid.body.context || {});
    return res.json({ data: result });
  }
);

router.post(
  '/confirm-order',
  ...customerGate,
  validate({
    body: z
      .object({
        proposalId: z.string().uuid(),
        address: z.string().max(500).optional(),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const placed = await tools.confirmOrderTool(req.user, req.valid.body);
    return res.json({ data: placed });
  }
);

router.use((_req, _res, next) => {
  next(new ApiError(404, 'Not found.', 'NOT_FOUND'));
});

module.exports = router;
