// Cases that mention any of these go to the top of the staff queue.
// The check is plain keyword matching on purpose: it is predictable, and a
// false alarm costs staff a few seconds while a miss could cost a household
// their power.

const PATTERNS = {
  medical_equipment: /medical equipment|oxygen|life[- ]support|ventilator|dialysis|\bcpap\b|\bbipap\b/i,
  extreme_weather: /extreme (heat|cold)|heat advisory|heat wave|freez(e|ing)|cold snap|winter storm|severe weather/i,
  minor_in_home: /\b(child|children|infant|baby|newborn|minor)\b/i,
  elderly_resident: /\b(elderly|senior citizen|seniors?|age 6[5-9]|age [7-9]\d|over 65)\b/i,
};

export const URGENCY_LABELS = {
  medical_equipment: 'Medical equipment',
  extreme_weather: 'Extreme weather',
  minor_in_home: 'Child in the home',
  elderly_resident: 'Elderly resident',
};

export function scanText(text) {
  const t = String(text ?? '');
  return Object.entries(PATTERNS)
    .filter(([, re]) => re.test(t))
    .map(([flag]) => flag);
}

export function fromHousehold(h) {
  if (!h) return [];
  const flags = [];
  if (h.medical) flags.push('medical_equipment');
  if (h.minor) flags.push('minor_in_home');
  if (h.senior) flags.push('elderly_resident');
  return flags;
}

export const mergeFlags = (...lists) => [...new Set(lists.flat())];
