#!/usr/bin/env node
import { generateToolDocs, renderToolDocsMarkdown } from '../server/src/lib/tool-docs.ts';
import { writeFileSync } from 'node:fs';

const docs = generateToolDocs();
writeFileSync(new URL('../docs/architecture/TOOL-REFERENCE.md', import.meta.url), renderToolDocsMarkdown(docs));
console.log(`wrote docs/architecture/TOOL-REFERENCE.md for ${docs.length} tools`);
