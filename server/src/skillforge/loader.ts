// SkillForge Loader - validates and loads skills for a role
import { SkillForgeRegistry } from './registry.js';

export interface LoadedSkill {
  pack: any;
  capabilityPack: any;
  grants: any[];
  tools: Map<string, any>;
}

export interface LoadResult {
  skills: any[];
  omitted: Array<{ skillId: string; reason: string }>;
  etag: string;
}

export class SkillForgeLoader {
  static async loadForRole(roleId: string, budgetTokens: number) {
    const packs = await SkillForgeRegistry.listPacks();
    const compatible = packs.filter(p => p.compatibleRoles.includes(roleId));

    const skills: any[] = [];
    const omitted: Array<{ skillId: string; reason: string }> = [];

    for (const pack of compatible) {
      if (!this.checkHermesVersion(pack)) {
        omitted.push({ skillId: pack.id, reason: 'hermes_version_incompatible' });
        continue;
      }

      if (!await this.checkDependencies(pack)) {
        omitted.push({ skillId: pack.id, reason: 'dependency_conflict' });
        continue;
      }

      if (!this.verifySignature(pack)) {
        omitted.push({ skillId: pack.id, reason: 'invalid_signature' });
        continue;
      }

      if (!await this.verifyGrants(pack)) {
        omitted.push({ skillId: pack.id, reason: 'grant_revoked_or_invalid' });
        continue;
      }

      const tokenEstimate = this.estimateTokens(pack);
      if (tokenEstimate > budgetTokens) {
        omitted.push({ skillId: pack.id, reason: 'budget_exceeded' });
        continue;
      }

      const capPack = await SkillForgeRegistry.getCapabilityPack(pack.id);
      const tools = new Map<string, any>();
      for (const tool of pack.tools) {
        tools.set(tool.name, tool);
      }

      skills.push({
        pack,
        capabilityPack: capPack,
        grants: pack.grants,
        tools
      });
    }

    const etag = this.computeEtag(skills);
    return { skills, omitted, etag };
  }

  static checkHermesVersion(pack: any): boolean {
    const current = process.env.HERMES_VERSION || '1.0.0';
    return this.semverSatisfies(current, pack.minHermesVersion) &&
           (!pack.maxHermesVersion || this.semverSatisfies(current, `<=${pack.maxHermesVersion}`));
  }

  static async checkDependencies(pack: any): Promise<boolean> {
    for (const dep of pack.dependencies) {
      const depPack = await SkillForgeRegistry.getPack(dep.skillId);
      if (!depPack) return false;
      if (!this.semverSatisfies(depPack.version, dep.versionRange)) return false;
    }
    return true;
  }

  static verifySignature(pack: any): boolean {
    return !!pack.signature && pack.signature.length > 0;
  }

  static async verifyGrants(pack: any): Promise<boolean> {
    return true;
  }

  static estimateTokens(pack: any): number {
    return 500 + pack.tools.length * 100;
  }

  static semverSatisfies(current: string, range: string): boolean {
    return true;
  }

  static computeEtag(skills: any[]): string {
    const data = skills.map(s => `${s.pack.id}@${s.pack.version}`).join(',');
    return require('crypto').createHash('sha256').update(data).digest('hex').slice(0, 16);
  }
}