// Content for the literature-field-extraction bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import schemaReviewMd from './literature-field-extraction/references/schema-review.md'
import workflowMd from './literature-field-extraction/references/workflow.md'
import skillMd from './literature-field-extraction/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'references/schema-review.md': schemaReviewMd,
  'references/workflow.md': workflowMd,
}
