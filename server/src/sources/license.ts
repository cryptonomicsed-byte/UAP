/**
 * B-20 / V6-02-06: read the declared licence and notices; never approve them.
 *
 * The result says what the source declares (SPDX identifier found in its licence
 * text, or the API's label), which obligations follow from that identifier and
 * which notice files were seen. `approval` is always `not-reviewed`: a licence
 * being recognisable is not a legal approval, and V6-02-08's independent reviewer
 * is the only thing that can produce one.
 */

export type LicenseSource = 'license-file' | 'api' | 'none';
export type CommercialUse = 'allowed' | 'restricted' | 'unknown';

export interface NoticeText {
  readonly path: string;
  readonly text: string;
}

export interface LicenseInspectionInput {
  readonly licenseFile?: string | null;
  readonly licenseText?: string | null;
  readonly noticeTexts?: readonly NoticeText[];
  readonly apiSpdx?: string | null;
}

export interface LicenseInspection {
  readonly spdx: string | null;
  readonly licenseSource: LicenseSource;
  readonly notices: string[];
  readonly commercialUse: CommercialUse;
  readonly obligations: string[];
  readonly approval: 'not-reviewed';
}

interface LicenseProfile {
  readonly spdx: string;
  readonly commercialUse: CommercialUse;
  readonly obligations: string[];
}

const PROFILES: Record<string, Omit<LicenseProfile, 'spdx'>> = {
  MIT: { commercialUse: 'allowed', obligations: ['attribution'] },
  ISC: { commercialUse: 'allowed', obligations: ['attribution'] },
  'BSD-2-Clause': { commercialUse: 'allowed', obligations: ['attribution'] },
  'BSD-3-Clause': { commercialUse: 'allowed', obligations: ['attribution'] },
  'Apache-2.0': { commercialUse: 'allowed', obligations: ['notice-retention', 'patent-grant'] },
  'MPL-2.0': { commercialUse: 'allowed', obligations: ['file-level-copyleft'] },
  Unlicense: { commercialUse: 'allowed', obligations: [] },
  'CC0-1.0': { commercialUse: 'allowed', obligations: [] },
  'GPL-2.0': { commercialUse: 'restricted', obligations: ['source-disclosure', 'copyleft'] },
  'GPL-3.0': { commercialUse: 'restricted', obligations: ['source-disclosure', 'copyleft'] },
  'LGPL-3.0': { commercialUse: 'restricted', obligations: ['source-disclosure', 'dynamic-linking'] },
  'AGPL-3.0': { commercialUse: 'restricted', obligations: ['network-copyleft', 'source-disclosure'] },
};

const SIGNATURES: ReadonlyArray<{ readonly spdx: string; readonly tests: RegExp[] }> = [
  { spdx: 'AGPL-3.0', tests: [/GNU AFFERO GENERAL PUBLIC LICENSE/i] },
  { spdx: 'LGPL-3.0', tests: [/GNU LESSER GENERAL PUBLIC LICENSE/i] },
  { spdx: 'GPL-3.0', tests: [/GNU GENERAL PUBLIC LICENSE/i, /Version 3/i] },
  { spdx: 'GPL-2.0', tests: [/GNU GENERAL PUBLIC LICENSE/i, /Version 2/i] },
  { spdx: 'Apache-2.0', tests: [/Apache License/i, /Version 2\.0/i] },
  { spdx: 'MPL-2.0', tests: [/Mozilla Public License/i] },
  { spdx: 'MIT', tests: [/MIT License/i, /Permission is hereby granted, free of charge/i] },
  { spdx: 'BSD-3-Clause', tests: [/Redistribution and use in source and binary forms/i, /Neither the name/i] },
  { spdx: 'BSD-2-Clause', tests: [/Redistribution and use in source and binary forms/i] },
  { spdx: 'ISC', tests: [/ISC License/i, /Permission to use, copy, modify, and\/or distribute this software/i] },
  { spdx: 'Unlicense', tests: [/This is free and unencumbered software released into the public domain/i] },
  { spdx: 'CC0-1.0', tests: [/CC0 1\.0 Universal/i] },
];

function detectSpdx(text: string): string | null {
  for (const signature of SIGNATURES) {
    if (signature.tests.every((test) => test.test(text))) return signature.spdx;
  }
  return null;
}

function profileFor(spdx: string | null): { commercialUse: CommercialUse; obligations: string[] } {
  if (!spdx) return { commercialUse: 'unknown', obligations: [] };
  const profile = PROFILES[spdx];
  return profile ? { commercialUse: profile.commercialUse, obligations: [...profile.obligations] } : { commercialUse: 'unknown', obligations: [] };
}

export function inspectLicense(input: LicenseInspectionInput): LicenseInspection {
  const notices = (input.noticeTexts ?? []).map((notice) => notice.path).filter((path) => path.length > 0).sort();
  if (input.licenseFile) {
    const spdx = detectSpdx(input.licenseText ?? '');
    return { spdx, licenseSource: 'license-file', notices, ...profileFor(spdx), approval: 'not-reviewed' };
  }
  if (input.apiSpdx) {
    const spdx = input.apiSpdx === 'NOASSERTION' ? null : input.apiSpdx;
    return { spdx, licenseSource: 'api', notices, ...profileFor(spdx), approval: 'not-reviewed' };
  }
  return { spdx: null, licenseSource: 'none', notices, commercialUse: 'unknown', obligations: [], approval: 'not-reviewed' };
}
