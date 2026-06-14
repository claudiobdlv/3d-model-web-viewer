const fs = require('fs');
const path = require('path');

const DEFAULT_RULES_PATH = path.resolve(__dirname, '..', '..', '..', 'config', 'material-rules.json');
const VALID_MODES = new Set(['off', 'fallback', 'override']);

function normalizeMode(value) {
  const mode = String(value || 'fallback').toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'fallback';
}

function normalizeColor(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const rgb = value.slice(0, 4).map(Number);
    if (rgb.slice(0, 3).every(Number.isFinite)) {
      return [
        clamp01(rgb[0]),
        clamp01(rgb[1]),
        clamp01(rgb[2]),
        Number.isFinite(rgb[3]) ? clamp01(rgb[3]) : 1
      ];
    }
  }

  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;

  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
    hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  ];
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function compileMatcher(rule) {
  const tests = [];

  for (const value of asArray(rule.exact)) {
    const target = String(value).toLowerCase();
    tests.push((text) => text === target || text.split(/[\/>]/).some((part) => part.trim() === target));
  }

  for (const value of asArray(rule.contains)) {
    const target = String(value).toLowerCase();
    tests.push((text) => text.includes(target));
  }

  for (const value of asArray(rule.regex)) {
    try {
      const regex = new RegExp(String(value), 'i');
      tests.push((text) => regex.test(text));
    } catch (err) {
      console.warn(`[material-rules] skipping invalid regex "${value}": ${err.message}`);
    }
  }

  return tests;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function loadMaterialRules(env = process.env) {
  const mode = normalizeMode(env.MATERIAL_RULES_MODE);
  const rulesPath = path.resolve(env.MATERIAL_RULES_PATH || DEFAULT_RULES_PATH);
  const emptyConfig = { mode, path: rulesPath, rules: [], error: null };

  if (mode === 'off') return emptyConfig;
  if (!fs.existsSync(rulesPath)) return emptyConfig;

  try {
    const parsed = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const sourceRules = Array.isArray(parsed) ? parsed : parsed.rules;
    const rules = (Array.isArray(sourceRules) ? sourceRules : [])
      .map((rule, index) => {
        const color = normalizeColor(rule.color);
        const tests = compileMatcher(rule);
        if (!color || tests.length === 0) return null;
        return {
          index,
          name: String(rule.name || `rule-${index + 1}`),
          color,
          materialName: String(rule.materialName || rule.name || `rule-${index + 1}`),
          tests
        };
      })
      .filter(Boolean);

    return { mode, path: rulesPath, rules, error: null };
  } catch (err) {
    return { ...emptyConfig, error: err.message };
  }
}

function findMaterialRule(config, candidates) {
  if (!config || config.mode === 'off' || !Array.isArray(config.rules)) return null;
  const searchable = candidates
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' > ');

  if (!searchable) return null;

  for (const rule of config.rules) {
    if (rule.tests.some((test) => test(searchable))) {
      return {
        name: rule.name,
        materialName: rule.materialName,
        color: rule.color
      };
    }
  }

  return null;
}

module.exports = {
  DEFAULT_RULES_PATH,
  findMaterialRule,
  loadMaterialRules
};
