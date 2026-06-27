#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'message-templates', 'twilio-content-sids.json');
const SID_RE = /^HX[a-f0-9]{32}$/i;

let cached = null;

function loadRegistry() {
  if (cached) return cached;
  cached = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return cached;
}

function getTemplates() {
  return loadRegistry().templates.slice();
}

function getPrimaryEnvMap() {
  const map = {};
  for (const row of getTemplates()) {
    map[row.env] = row.sid;
  }
  return map;
}

function getFullEnvMap() {
  const map = { ...getPrimaryEnvMap() };
  const aliases = loadRegistry().legacy_aliases || {};
  for (const [aliasKey, primaryKey] of Object.entries(aliases)) {
    if (map[primaryKey]) map[aliasKey] = map[primaryKey];
  }
  return map;
}

function getRequiredProductionKeys() {
  return getTemplates().map(row => row.env);
}

function isValidSid(value) {
  return SID_RE.test(String(value || '').trim());
}

function validateEnvMap(envMap) {
  const errors = [];
  const warnings = [];
  for (const key of getRequiredProductionKeys()) {
    const value = envMap[key];
    if (!value) errors.push(`${key} is missing`);
    else if (!isValidSid(value)) warnings.push(`${key} does not look like a Twilio Content SID`);
  }
  return { errors, warnings };
}

module.exports = {
  REGISTRY_PATH,
  SID_RE,
  loadRegistry,
  getTemplates,
  getPrimaryEnvMap,
  getFullEnvMap,
  getRequiredProductionKeys,
  isValidSid,
  validateEnvMap,
};
