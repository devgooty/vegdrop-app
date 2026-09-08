'use strict';

/**
 * Seed recipes for the cooking assistant.
 *
 * Matching is by vegetable tags and/or dish name against free text — not by
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

/** Common dish nicknames → recipe id. Longer keys win (sorted at lookup). */
const DISH_ALIASES = Object.freeze({
  'aloo gobi': 'aloo-gobi-style',
  'aloo gobhi': 'aloo-gobi-style',
  'potato cauliflower': 'aloo-gobi-style',
  'potato tomato curry': 'potato-tomato-curry',
  'aloo tamatar': 'potato-tomato-curry',
  'mixed veg': 'mixed-veg-curry',
  'mixed vegetable': 'mixed-veg-curry',
  'potato carrot fry': 'potato-carrot-fry',
  'tomato onion': 'tomato-onion-curry',
  'tomato curry': 'tomato-onion-curry',
  'brinjal curry': 'brinjal-curry',
  'baingan curry': 'brinjal-curry',
  'cabbage fry': 'cabbage-fry',
  'palak': 'spinach-dal-style',
  'spinach': 'spinach-dal-style',
  'bendi fry': 'okra-fry',
  'okra fry': 'okra-fry',
  'lady finger fry': 'okra-fry',
  sambar: 'sambar-veg-base',
  'ridge gourd': 'ridge-gourd-curry',
  beerakaya: 'ridge-gourd-curry',
  poriyal: 'beans-carrot-poriyal',
  'beans carrot': 'beans-carrot-poriyal',
});

function normalizeVeg(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  return ALIASES[s] || s;
}

function normalizeDishQuery(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * Find dishes by name / nickname ("cabbage fry", "aloo gobi", "sambar").
 * Returns the same card shape as listMatchingRecipes (covered/missing empty).
 */
function findRecipesByDishName(query, { limit = 5 } = {}) {
  const q = normalizeDishQuery(query);
  if (!q || q.length < 3) return [];

  const aliasHits = [];
  for (const [alias, recipeId] of Object.entries(DISH_ALIASES).sort(
    (a, b) => b[0].length - a[0].length
  )) {
    if (!q.includes(alias) && !alias.includes(q)) continue;
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (recipe) aliasHits.push({ recipe, score: alias === q ? 1 : 0.95 });
  }

  const scored = RECIPES.map((recipe) => {
    const name = normalizeDishQuery(recipe.name);
    const id = normalizeDishQuery(recipe.id.replace(/-/g, ' '));
    let score = 0;
    if (name === q || id === q) score = 1;
    else if (name.includes(q) || id.includes(q) || q.includes(name)) score = 0.9;
    else {
      const tokens = q.split(' ').filter((t) => t.length > 2);
      if (tokens.length) {
        const hit = tokens.filter((t) => name.includes(t) || id.includes(t)).length;
        score = hit / tokens.length;
      }
    }
    return { recipe, score };
  }).filter((row) => row.score >= 0.5);

  const byId = new Map();
  for (const row of [...aliasHits, ...scored]) {
    const prev = byId.get(row.recipe.id);
    if (!prev || row.score > prev.score) byId.set(row.recipe.id, row);
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row, index) => ({
      index: index + 1,
      id: row.recipe.id,
      name: row.recipe.name,
      difficulty: row.recipe.difficulty,
      minutes: row.recipe.minutes,
      matchScore: Math.round(row.score * 100),
      covered: row.recipe.vegetables.map(normalizeVeg),
      missing: [],
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
  findRecipesByDishName,
  getRecipe,
};
