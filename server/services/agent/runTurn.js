'use strict';

const config = require('../../config/env');
const { ApiError } = require('../../middleware/errors');
const recipes = require('./recipes');
const proposals = require('./proposals');
const tools = require('./tools');
const { SYSTEM_PROMPT } = require('./systemPrompt');

/**
 * One assistant turn.
 *
 * With OPENAI_API_KEY: tool-calling chat. Without it (or in tests): a local
 * intent router that covers the MVP flows so the feature works offline/demo.
 */

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && messages[i].content) return String(messages[i].content);
  }
  return '';
}

async function runLocalTurn(user, messages, context = {}) {
  const text = lastUserText(messages);
  const session = proposals.getSession(user._id);
  const lower = text.toLowerCase().trim();

  const servingsMatch = lower.match(/\b(?:for|serves?)\s+(\d{1,2})\b/) || lower.match(/\b(\d{1,2})\s+people\b/);
  if (servingsMatch) session.servings = Math.min(12, Math.max(1, Number(servingsMatch[1])));

  // Confirm pending proposal
  if (
    session.lastProposalId &&
    /\b(confirm|yes|place|order it|go ahead|haan|ha|ok place)\b/i.test(lower) &&
    !/\b(what|which|how|recipe)\b/i.test(lower)
  ) {
    try {
      const placed = await tools.confirmOrderTool(user, {
        proposalId: session.lastProposalId,
        address: context.address || user.address,
        lat: context.lat,
        lng: context.lng,
      });
      session.lastProposalId = null;
      return {
        reply: `Order placed ✅\n\nOrder ${placed.orderNumber}\nTotal ₹${placed.totalAmount}\nStatus: ${placed.status}\n\nYou can track it under Orders.`,
        cards: [{ type: 'order', ...placed }],
        proposedOrder: null,
      };
    } catch (err) {
      return {
        reply: err.message || 'Could not place that order.',
        cards: [],
        proposedOrder: null,
      };
    }
  }

  // Order ingredients for last / chosen recipe
  if (/\b(order|buy|cart|missing)\b/i.test(lower) && (session.lastRecipeId || session.lastMatches.length)) {
    let recipeId = session.lastRecipeId;
    const num = lower.match(/\b(?:number|option|#)?\s*([1-5])\b/);
    if (num && session.lastMatches.length) {
      const pick = session.lastMatches.find((m) => m.index === Number(num[1]));
      if (pick) recipeId = pick.id;
    }
    if (!recipeId && session.lastMatches[0]) recipeId = session.lastMatches[0].id;

    try {
      const preview = await tools.proposeOrderTool(user, {
        recipeId,
        servings: session.servings,
        marketId: context.marketId,
        shopId: context.shopId,
        paymentMethod: context.paymentMethod || 'cod',
      });
      session.lastRecipeId = recipeId;
      return {
        reply:
          `Here's a cart preview for that dish (≈${session.servings} servings).\n` +
          `Total ₹${preview.total} including delivery.\n\n` +
          `Reply **confirm** to place the order, or tell me what to change.`,
        cards: [{ type: 'proposal', ...preview }],
        proposedOrder: preview,
      };
    } catch (err) {
      return { reply: err.message || 'Could not build that cart.', cards: [], proposedOrder: null };
    }
  }

  // Pick recipe by number
  const pickNum = lower.match(/^(?:number|option|#)?\s*([1-5])\s*$/i) || lower.match(/\b(?:show|make|tell|recipe)\s+(?:me\s+)?(?:number\s+)?([1-5])\b/i);
  if (pickNum && session.lastMatches.length) {
    const pick = session.lastMatches.find((m) => m.index === Number(pickNum[1]));
    if (pick) {
      const detail = await tools.getRecipeTool({ recipeId: pick.id, servings: session.servings });
      session.lastRecipeId = detail.id;
      return {
        reply:
          `**${detail.name}** (${detail.minutes} min, ${detail.servings} servings)\n\n` +
          detail.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
          `\n\nSay **order missing ingredients** if you want a cart preview.`,
        cards: [{ type: 'recipe', ...detail }],
        proposedOrder: null,
      };
    }
  }

  // Vegetable → recipes
  const veggies = recipes.extractVegetables(text);
  if (veggies.length || /\b(cook|curry|recipe|make|dish|possibilit)/i.test(lower)) {
    if (veggies.length) session.vegetables = [...new Set([...session.vegetables, ...veggies])];
    const use = veggies.length ? veggies : session.vegetables;
    if (!use.length) {
      return {
        reply:
          "Tell me which vegetables you have — for example: *potato, tomato, onion, carrot* — and I'll list curries you can make.",
        cards: [],
        proposedOrder: null,
      };
    }

    const { matches } = await tools.listMatchingRecipesTool({
      vegetables: use,
      servings: session.servings,
    });
    session.lastMatches = matches;

    if (!matches.length) {
      return {
        reply: `I couldn't match a dish to ${use.join(', ')} yet. Try adding onion or tomato, or ask for a specific curry name.`,
        cards: [],
        proposedOrder: null,
      };
    }

    const list = matches
      .map(
        (m) =>
          `${m.index}. **${m.name}** (${m.minutes} min) — match ${m.matchScore}%` +
          (m.missing.length ? ` · need also: ${m.missing.join(', ')}` : ' · you have everything')
      )
      .join('\n');

    return {
      reply:
        `With **${use.join(', ')}** I found ${matches.length} option(s):\n\n${list}\n\n` +
        `Reply with a number (e.g. **2**) for steps, or say **order missing ingredients**.`,
      cards: matches.map((m) => ({ type: 'recipe_match', ...m })),
      proposedOrder: null,
    };
  }

  return {
    reply:
      "I'm your VegDrop cooking helper 🥕\n\n" +
      "• Tell me veggies you have → I'll suggest curries\n" +
      "• Pick a number → cooking steps\n" +
      "• Say **order missing ingredients** → cart preview\n" +
      "• Say **confirm** → place the order\n\n" +
      'Try: *I have potato, tomato and onion*',
    cards: [],
    proposedOrder: null,
  };
}

async function runOpenAiTurn(user, messages, context = {}) {
  const apiKey = config.agent.apiKey;
  const model = config.agent.model;

  const openaiMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.slice(-12).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    })),
  ];

  let proposedOrder = null;
  const cards = [];
  let guard = 0;

  while (guard < 4) {
    guard += 1;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: openaiMessages,
        tools: tools.TOOL_DEFS,
        tool_choice: 'auto',
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[agent] openai error', response.status, body?.error);
      throw new ApiError(502, 'The cooking assistant is busy. Please try again.', 'AGENT_PROVIDER_ERROR');
    }

    const choice = body.choices?.[0]?.message;
    if (!choice) {
      throw new ApiError(502, 'The cooking assistant returned an empty reply.', 'AGENT_PROVIDER_ERROR');
    }

    if (choice.tool_calls?.length) {
      openaiMessages.push(choice);
      for (const call of choice.tool_calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        if (name === 'propose_order') {
          args.marketId = args.marketId || context.marketId;
          args.shopId = args.shopId || context.shopId;
          args.paymentMethod = args.paymentMethod || context.paymentMethod || 'cod';
        }
        let result;
        try {
          result = await tools.executeTool(user, name, args);
        } catch (err) {
          result = { error: err.message || 'Tool failed', code: err.code };
        }
        if (name === 'propose_order' && result?.proposalId) {
          proposedOrder = result;
          cards.push({ type: 'proposal', ...result });
        }
        if (name === 'list_matching_recipes' && result?.matches) {
          proposals.getSession(user._id).lastMatches = result.matches;
          for (const m of result.matches) cards.push({ type: 'recipe_match', ...m });
        }
        if (name === 'get_recipe' && result?.id) {
          proposals.getSession(user._id).lastRecipeId = result.id;
          cards.push({ type: 'recipe', ...result });
        }
        openaiMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    return {
      reply: choice.content || 'Done.',
      cards,
      proposedOrder,
    };
  }

  return {
    reply: 'I gathered the details above — tell me what you want next.',
    cards,
    proposedOrder,
  };
}

async function runTurn(user, messages, context = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'Send at least one message.', 'VALIDATION_ERROR');
  }

  if (config.agent.configured && !config.isTest) {
    try {
      return await runOpenAiTurn(user, messages, context);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AGENT_PROVIDER_ERROR') {
        // Fall through to local so the user is not stuck mid-chat.
        console.warn('[agent] falling back to local turn', err.message);
      } else {
        throw err;
      }
    }
  }

  return runLocalTurn(user, messages, context);
}

module.exports = { runTurn, runLocalTurn };
