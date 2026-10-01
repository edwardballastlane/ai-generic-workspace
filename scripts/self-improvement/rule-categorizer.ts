/**
 * Rule Categorizer: Keyword-based category detection for rules.
 * Used by the inject-rules hook and Qdrant storage for contextual filtering.
 *
 * No LLM dependency — pure keyword matching for speed.
 */

const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  git: [/\bgit\b/i, /\bcommit\b/i, /\bmerge\b/i, /\bbranch\b/i, /\brebase\b/i, /\bpush\b/i, /\bpull\b/i, /\bcherry.?pick\b/i, /\breset\b/i, /\brevert\b/i, /\bstag(e|ing)\b/i],
  typescript: [/\btypescript\b/i, /\btsconfig\b/i, /\btype\s+error/i, /\binterface\b/i, /\b\.ts\b/i, /\btype\s+annotation/i, /\bas\s+any\b/i],
  react: [/\breact\b/i, /\bcomponent\b/i, /\bjsx\b/i, /\btsx\b/i, /\buseState\b/i, /\buseEffect\b/i, /\bprops\b/i, /\brender\b/i, /\bhook\b/i],
  'file-editing': [/\bEdit\b/, /\bWrite\b/, /\bRead\b/, /\bfile\b/i, /\bedit\s+loop\b/i, /\bbatch\b/i, /\bincremental\b/i, /\bmodif(y|ied|ying)\b/i],
  debugging: [/\bdebug\b/i, /\berror\b/i, /\broot\s+cause\b/i, /\btroubleshoot\b/i, /\bstack\s+trace\b/i, /\bdiagnos/i, /\binvestigat/i],
  testing: [/\btest\b/i, /\bspec\b/i, /\bassert\b/i, /\bcoverage\b/i, /\bjest\b/i, /\bpytest\b/i, /\bunit\s+test/i],
  architecture: [/\barchitect/i, /\bpattern\b/i, /\brefactor\b/i, /\bdesign\b/i, /\babstract/i, /\bmodular/i],
  config: [/\bconfig\b/i, /\bsetting/i, /\bappsetting/i, /\b\.json\b/i, /\benvironment\b/i, /\bdocker/i, /\bcompose\b/i],
  security: [/\bsecret\b/i, /\bpassword\b/i, /\btoken\b/i, /\bapi\s*key\b/i, /\bauth/i, /\bsensitive\b/i, /\bcredential/i, /\bfilter\b/i],
  planning: [/\bplan\b/i, /\bscope\b/i, /\bdecision\b/i, /\bphase\b/i, /\bprerequisit/i, /\bworkflow\b/i, /\bstrateg/i],
  deployment: [/\bdeploy/i, /\bvercel\b/i, /\bstatic\s*web/i, /\bbuild\b/i, /\bci\/cd\b/i, /\bpipeline\b/i],
  dotnet: [/\b\.net\b/i, /\bdotnet\b/i, /\bc#\b/i, /\bcsharp\b/i, /\bnuget\b/i, /\basp\.net\b/i, /\bentity\s+framework\b/i, /\bDI\s+registration\b/i],
};

/**
 * Categorize a rule by matching its text against keyword patterns.
 * Returns an array of matching category names. Falls back to ['general']
 * if no categories match.
 */
export function categorizeRule(text: string): string[] {
  const categories: string[] = [];

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some(p => p.test(text))) {
      categories.push(category);
    }
  }

  return categories.length > 0 ? categories : ['general'];
}

/**
 * Detect which projects a rule applies to based on keyword matching.
 * Returns an array of project names. Empty array = applies to all projects.
 *
 * Add an entry per project in your workspace, mapping project name to a list
 * of regexes that, when matched against rule text, scope the rule to that
 * project. Leaving this empty means every extracted rule applies globally.
 */
const PROJECT_PATTERNS: Record<string, RegExp[]> = {
  // Example (uncomment + adapt for your project):
  // 'my-backend': [
  //   /\bGraphQL\b/i, /\bresolver/i, /\bTypeORM\b/i, /\bNestJS\b/i,
  //   /\bN\+1\b/, /\bJWT\b/i,
  // ],
};

export function detectProjects(text: string): string[] {
  const projects: string[] = [];

  for (const [project, patterns] of Object.entries(PROJECT_PATTERNS)) {
    if (patterns.some(p => p.test(text))) {
      projects.push(project);
    }
  }

  return projects;
}
