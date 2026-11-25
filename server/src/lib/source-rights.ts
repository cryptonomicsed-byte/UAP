/**
 * Source rights. Patterns may be reimplemented. Licensed trees are not vendored.
 * dusk bot is PolyForm Noncommercial 1.0.0. Commercial use needs their separate
 * license, so none of its files are copied into UAP.
 */
export interface SourceRight {
  repo: string;
  sha: string;
  license: string;
  vendored: false;
  use: string;
}

export const SOURCE_RIGHTS: SourceRight[] = [
  { repo: 'DuskBotAI/duskbot', sha: 'eca6959253d05f06b06d2c361cdf3bfaa95a30e3', license: 'PolyForm-Noncommercial-1.0.0', vendored: false, use: 'capability list only; no source copy' },
  { repo: 'n8n-io/nod', sha: '08da5a7f10648db7814ca9b7a1b3a458293ffba5', license: 'Apache-2.0', vendored: false, use: 'layout pattern: chat, schedule, apps, vault' },
  { repo: 'elie222/rakazo', sha: '4f4189032d7fbf0395762bce2e2ac7924b1238f6', license: 'Apache-2.0', vendored: false, use: 'layout pattern: templates, computers, rooms' },
  { repo: 'leepokai/Codync', sha: '9dae3e2bec9b91a4a42f85a943eb3983f95d0503', license: 'Apache-2.0', vendored: false, use: 'layout pattern: roster and bring-your-own model' },
  { repo: 'milind-soni/OpenMausBot', sha: '0c352d70286aceb8ccabc9d11a56713e35026920', license: 'Apache-2.0', vendored: false, use: 'team surface; enterprise/ excluded' },
  { repo: 'nickvasilescu/bot-hq', sha: 'decf9a215cddd8792a5f20f4a11a87d4dffa6d15', license: 'MIT', vendored: false, use: 'Hermes stays the engine, not a second shell' },
];

export function mayVendor(repo: string): false {
  const row = SOURCE_RIGHTS.find((item) => item.repo === repo);
  if (!row) return false;
  return false;
}

export function duskbotBlocked(): { ok: false; reason: string } {
  return { ok: false, reason: 'PolyForm Noncommercial forbids copying dusk bot source into this commercial app' };
}
