'use strict';

const express = require('express');
const { ApiError } = require('../middleware/errors');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const { agentChatLimiter } = require('../middleware/rateLimit');
const { runTurn } = require('../services/agent/runTurn');
const tools = require('../services/agent/tools');
const { classifySpoken } = require('../services/agent/voiceIntent');

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

/**
 * What one SPOKEN sentence meant.
 *
 * Separate from `/chat` because it answers a different question and must
 * answer it fast: one short classification, no tools, no conversation history,
 * no recipe book. The client has already tried its own keyword table offline
 * and only asks here for the phrasings that table does not recognise.
 *
 * It returns a NAME and some vegetables, never an action. The app runs the
 * same handler a tap runs, under the mode the shopper chose, through the same
 * catalog lookup and pack arithmetic — so a wrong answer here is a wrong
 * screen, not a wrong price.
 */
router.post(
  '/voice',
  ...customerGate,
  validate({
    body: z
      .object({
        utterance: z.string().min(1).max(500),
        language: z.enum(['en', 'hi', 'te']).optional(),
        screen: z
          .object({
            tab: z.string().max(40).optional(),
            productName: z.string().max(120).optional(),
            cartCount: z.number().int().min(0).max(500).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { utterance, language, screen } = req.valid.body;
    const result = await classifySpoken(utterance, { language: language || 'en', screen: screen || null });
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
