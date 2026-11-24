// SkillForge Core Types (V6-09-02, V6-09-03, V6-09-06)
export interface ToolDescriptor {
  name: string;
  version: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  sideEffects: SideEffect[];
  requiredGrants: string[];
  timeoutMs: number;
}

export type SideEffect =
  | { type: 'network'; domains: string[] }
  | { type: 'filesystem'; paths: string[]; access: 'read' | 'write' | 'exec' }
  | { type: 'process'; commands: string[] }
  | { type: 'database'; tables: string[]; operations: ('read'|'write'|'delete')[] }
  | { type: 'crypto'; operations: ('sign'|'verify'|'encrypt'|'decrypt')[] }
  | { type: 'external'; service: string; operations: string[] };

export interface SkillPackVersion {
  id: string;
  version: string;
  name: string;
  publisher: string;
  license: string;
  sourceSha: string;
  sourceUrl: string;
  tools: ToolDescriptor[];
  dependencies: SkillDependency[];
  grants: string[];
  compatibleRoles: string[];
  minHermesVersion: string;
  maxHermesVersion?: string;
  signedAt: string;
  signedBy: string;
  signature: string;
}

export interface SkillDependency {
  skillId: string;
  versionRange: string;
  required: boolean;
}

export interface SignedCapabilityPack {
  skillPack: SkillPackVersion;
  grants: SignedGrant[];
  issuedAt: string;
  expiresAt?: string;
  issuedBy: string;
  signature: string;
}

export interface SignedGrant {
  grantId: string;
  skillPackId: string;
  toolName: string;
  effectClass: string;
  budget: Budget;
  conditions: GrantCondition[];
}

export interface Budget {
  maxCallsPerTask: number;
  maxCallsPerSecond: number;
  maxCpuMs: number;
  maxMemoryMb: number;
  maxNetworkKb: number;
}

export interface GrantCondition {
  type: 'time' | 'role' | 'tenant' | 'approval';
  params: Record<string, unknown>;
}

export interface SkillCandidate {
  id: string;
  sourceUrl: string;
  sourceSha: string;
  proposedBy: string;
  status: 'pending' | 'in-review' | 'approved' | 'rejected' | 'published' | 'revoked';
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNotes?: string;
  skillPack?: SkillPackVersion;
}

export interface SkillDrainPlan {
  fromVersion: string;
  toVersion: string;
  affectedTasks: string[];
  strategy: 'wait-complete' | 'migrate' | 'cancel';
  deadline: string;
}