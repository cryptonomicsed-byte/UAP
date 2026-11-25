/**
 * AgentOS engineering pack. Sources are pinned, not installed.
 * A prompt that says the work is finished is not a gate.
 * Smithers coordinator pin: cryptonomicsed-byte/omokoda-smithers da010883634c2635f165af09e27a011dc43b16eb
 */
export interface PackSource {
  repo: string;
  sha: string;
  license: string;
  priority: 'essential' | 'recommended';
  installed: false;
  use: string;
}

export const ENGINEERING_PACK: PackSource[] = [
  { repo: 'cryptonomicsed-byte/agency-agents', sha: 'ad9264e309bd5e5422c04784372d7841b1e5d604', license: 'MIT', priority: 'essential', installed: false, use: 'specialist personas' },
  { repo: 'obra/superpowers', sha: '22f0b463e7a5e579904dd6211a520321035526f7', license: 'MIT', priority: 'essential', installed: false, use: 'plan, TDD, debug, review' },
  { repo: 'rewrite-rs/skills', sha: '3401e9684565e101c8da6c196f66c01160f77c9a', license: 'BSD-3-Clause', priority: 'essential', installed: false, use: 'Rust authority kernel' },
  { repo: 'georgeguimaraes/elixir-agent-tools', sha: 'ac3a5a1661a087158b39d5eb742b3c25fe3c7b44', license: 'Apache-2.0', priority: 'essential', installed: false, use: 'OTP spawn and supervision' },
  { repo: 'Krastanov/JuliaLLMAgentSkills', sha: 'e61fbfda4b1f7bd9dd79e1b5402df3069db0a086', license: 'Unlicense', priority: 'essential', installed: false, use: 'numerical memory' },
  { repo: 'iwillig/clojure-skills', sha: 'c363e80d1e79092ea0b60c8c4e5b0af1c8da53b2', license: 'NOASSERTION', priority: 'essential', installed: false, use: 'symbolic rules; no SPDX, do not vendor' },
  { repo: 'mythicalhacker/go-mastery', sha: '7336750f5bbde8268190068ef4f439ca97be9e91', license: 'MIT', priority: 'essential', installed: false, use: 'network and streams' },
  { repo: 'polyglotdev/best-practice-skills', sha: '0050d764942c3e0314bce61ee9adf487b1df6b16', license: 'NOASSERTION', priority: 'essential', installed: false, use: 'Python adapters; no SPDX, do not vendor' },
  { repo: 'MystenLabs/skills', sha: 'a384d9a158c4639f075ad3f6644d925108ddfc78', license: 'Apache-2.0', priority: 'essential', installed: false, use: 'Sui Move' },
  { repo: 'agshinrajabov/no-slop-design', sha: 'ae2ecc20970ff982a7f2cc7b145d859e1df9ef21', license: 'MIT', priority: 'essential', installed: false, use: 'visual direction' },
  { repo: 'pbakaus/impeccable', sha: 'b49177d32788f2dc585c42831d845dacf1ebed2c', license: 'Apache-2.0', priority: 'essential', installed: false, use: 'layout and type' },
  { repo: 'emilkowalski/skills', sha: '64eb3deb9a5fbfa041faf783e0bc3fd635872e9c', license: 'MIT', priority: 'recommended', installed: false, use: 'motion only when the task is interface' },
  { repo: 'thedaviddias/Front-End-Checklist', sha: 'e8d14d049010e2ce25afcd5e8609dfcbbe63e47e', license: 'MIT', priority: 'essential', installed: false, use: 'accessibility and completeness' },
  { repo: 'Moai-Team-LLC/agentic-product-standard', sha: '55e282317f953055b7cbc4ad06b00bb47cebdaaa', license: 'MIT', priority: 'essential', installed: false, use: 'definition of done' },
  { repo: 'fractal-nyc/software-engineering-go-launch-checklist', sha: 'cdceea0fdc8cf344f67a251d058bfb62f2706b96', license: 'NOASSERTION', priority: 'essential', installed: false, use: 'release checklist; no SPDX, do not vendor' },
  { repo: 'dkneeland/agentic-guardrails', sha: '043e56682b902cfcd991b58b51eda0675f1617b9', license: 'MIT', priority: 'recommended', installed: false, use: 'independent cleanup' },
];

export interface Specialist {
  id: string;
  title: string;
  sources: string[];
  keywords: string[];
}

export const SPECIALISTS: Specialist[] = [
  { id: 'architect', title: 'Systems Architect', sources: ['cryptonomicsed-byte/agency-agents', 'obra/superpowers'], keywords: ['architect', 'contract', 'boundary'] },
  { id: 'rust', title: 'Rust Core Engineer', sources: ['rewrite-rs/skills'], keywords: ['rust', 'lease', 'kernel'] },
  { id: 'elixir', title: 'Elixir Runtime Engineer', sources: ['georgeguimaraes/elixir-agent-tools'], keywords: ['elixir', 'otp', 'worker', 'spawn'] },
  { id: 'julia', title: 'Julia Engineer', sources: ['Krastanov/JuliaLLMAgentSkills'], keywords: ['julia', 'numeric', 'simulation'] },
  { id: 'clojure', title: 'Clojure Logic Engineer', sources: ['iwillig/clojure-skills'], keywords: ['clojure', 'rule', 'symbolic'] },
  { id: 'go', title: 'Go Network Engineer', sources: ['mythicalhacker/go-mastery'], keywords: ['go', 'network', 'stream', 'gateway'] },
  { id: 'python', title: 'Python Integration Engineer', sources: ['polyglotdev/best-practice-skills'], keywords: ['python', 'hermes', 'mcp', 'adapter'] },
  { id: 'move', title: 'Move Blockchain Engineer', sources: ['MystenLabs/skills'], keywords: ['move', 'sui', 'chain'] },
  { id: 'design', title: 'UI/UX Director', sources: ['agshinrajabov/no-slop-design', 'pbakaus/impeccable'], keywords: ['ui', 'layout', 'design', 'type'] },
  { id: 'motion', title: 'Motion Designer', sources: ['emilkowalski/skills'], keywords: ['motion', 'animation', 'easing'] },
  { id: 'review', title: 'Independent Code Reviewer', sources: ['cryptonomicsed-byte/agency-agents', 'dkneeland/agentic-guardrails'], keywords: ['review', 'cleanup'] },
  { id: 'qa', title: 'QA / Reality Checker', sources: ['thedaviddias/Front-End-Checklist', 'Moai-Team-LLC/agentic-product-standard'], keywords: ['qa', 'verify', 'accessibility'] },
  { id: 'release', title: 'Release Engineer', sources: ['fractal-nyc/software-engineering-go-launch-checklist'], keywords: ['release', 'deploy', 'nogo', 'go/no-go'] },
];

const OPTIONAL = [
  { repo: 'greensock/gsap-skills', when: ['gsap'] },
  { repo: '0xlayerghost/solidity-agent-kit', when: ['solidity', 'evm'] },
  { repo: 'giladHaimov/Smart-Contract-AI-Audit-Skill', when: ['audit', 'evm'] },
  { repo: 'InteractiveNLP-Team/RoleLLM-public', when: ['npc', 'personality'] },
  { repo: 'gamedev-skills/awesome-gamedev-agent-skills', when: ['game', 'npc'] },
  { repo: 'remotion-dev/skills', when: ['video', 'remotion'] },
];

export function dispatchSpecialists(task: string) {
  const text = task.toLowerCase();
  const matched = SPECIALISTS.filter((row) => row.keywords.some((word) => text.includes(word)));
  const specialists = matched.length ? matched : [SPECIALISTS[0]];
  const wanted = new Set(specialists.flatMap((row) => row.sources));
  const optional = OPTIONAL.filter((row) => row.when.some((word) => text.includes(word))).map((row) => row.repo);
  return {
    specialists: specialists.map((row) => row.id),
    skills: ENGINEERING_PACK.filter((row) => wanted.has(row.repo)),
    optional,
    loaded: wanted.size,
    refused: 'The other pack sources stay unloaded.',
    installed: 0,
  };
}

export interface TaskEvidence {
  acceptance?: string;
  specialist?: string;
  testExit?: number;
  reviewSid?: string;
  realityNote?: string;
}

export function acceptBuild(evidence: TaskEvidence): { decision: 'GO' | 'NO-GO'; missing: string[] } {
  const missing: string[] = [];
  if (!evidence.acceptance) missing.push('acceptance');
  if (!evidence.specialist) missing.push('specialist');
  if (evidence.testExit !== 0) missing.push('tests');
  if (!evidence.reviewSid || evidence.reviewSid === evidence.specialist) missing.push('independentReview');
  if (!evidence.realityNote) missing.push('realityCheck');
  return { decision: missing.length ? 'NO-GO' : 'GO', missing };
}

export function packReport() {
  return {
    smithers: 'cryptonomicsed-byte/omokoda-smithers@da010883634c2635f165af09e27a011dc43b16eb',
    count: ENGINEERING_PACK.length,
    installed: 0,
    noLicense: ENGINEERING_PACK.filter((row) => row.license === 'NOASSERTION').map((row) => row.repo),
    sources: ENGINEERING_PACK,
  };
}
