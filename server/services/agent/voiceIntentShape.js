'use strict';

/**
 * The only intents a model may return for a spoken sentence.
 *
 * Its own file so the route's validation and the sanitiser share one list
 * rather than two that drift. `payment` is deliberately absent: the model is
 * never given a way to name it, and a sentence about paying is classified as
 * `chat` — the shopper is answered, and nothing acts.
 */
const SPOKEN_INTENTS = Object.freeze([
  'navigate',
  'add_item',
  'remove_item',
  'clear_cart',
  'read_screen',
  'read_cart',
  'help',
  'stop',
  'chat',
]);

module.exports = { SPOKEN_INTENTS };
