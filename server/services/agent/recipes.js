'use strict';

/**
 * Seed recipes for the cooking assistant.
 *
 * Matching is by vegetable tag overlap against names the user typed — not by
 * training a model. Catalog linking happens later in search_catalog.
 */

const RECIPES = require('../../data/recipes.json');

const ALIASES = Object.freeze({
  aloo: 'potato',
  potatoes: 'potato',
  tamatar: 'tomato',
  tomatoes: 'tomato',
  pyaz: 'onion',
  onions: 'onion',
  gajar: 'carrot',
  carrots: 'carrot',
  baingan: 'brinjal',
  eggplant: 'brinjal',
  aubergine: 'brinjal',
  palak: 'spinach',
  bendi: 'okra',
  ladyfinger: 'okra',
  'lady finger': 'okra',
  gobi: 'cauliflower',
  beerakaya: 'ridge gourd',
  'ridgegourd': 'ridge gourd',
  cabbage: 'cabbage',
  beans: 'beans',
  garlic: 'garlic',
  drumstick: 'drumstick',
});

function normalizeVeg(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  return ALIASES[s] || s;
}

/** Pull known vegetable tokens from free text. */
function extractVegetables(text) {
  const lower = String(text || '').toLowerCase();
  const found = new Set();

  const candidates = [
    ...Object.keys(ALIASES),
    ...new Set(RECIPES.flatMap((r) => r.vegetables)),
  ].sort((a, b) => b.length - a.length);

  for (const token of candidates) {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) found.add(normalizeVeg(token));
  }
  return [...found];
}

function listMatchingRecipes(vegetables, { limit = 5 } = {}) {
  const have = new Set((vegetables || []).map(normalizeVeg).filter(Boolean));
  if (have.size === 0) return [];

  const scored = RECIPES.map((recipe) => {
    const need = recipe.vegetables.map(normalizeVeg);
    const covered = need.filter((v) => have.has(v));
    const missing = need.filter((v) => !have.has(v));
    const score = covered.length / need.length;
    return { recipe, covered, missing, score };
  })
    .filter((row) => row.covered.length > 0)
    .sort((a, b) => b.score - a.score || a.missing.length - b.missing.length);

  return scored.slice(0, limit).map((row, index) => ({
    index: index + 1,
    id: row.recipe.id,
    name: row.recipe.name,
    difficulty: row.recipe.difficulty,
    minutes: row.recipe.minutes,
    matchScore: Math.round(row.score * 100),
    covered: row.covered,
    missing: row.missing,
  }));
}

function getRecipe(recipeId, servings = 2) {
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe) return null;
  const n = Math.min(12, Math.max(1, Number(servings) || 2));
  return {
    id: recipe.id,
    name: recipe.name,
    difficulty: recipe.difficulty,
    minutes: recipe.minutes,
    servings: n,
    vegetables: recipe.vegetables,
    ingredients: recipe.ingredients.map((ing) => ({
      name: ing.name,
      quantity: Math.round(ing.qtyPerServing * n * 1000) / 1000,
      unit: ing.unit,
    })),
    steps: recipe.steps,
  };
}

module.exports = {
  RECIPES,
  normalizeVeg,
  extractVegetables,
  listMatchingRecipes,
  getRecipe,
};
