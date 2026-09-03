import type { SchemeOption, SchemePlan, SchemeVariant } from "../types";

const DIRECT = /\bdirect\b/i;
const REGULAR = /\bregular\b/i;
const IDCW = /\bidcw\b/i;
const DIVIDEND = /\bdividend\b|\bdiv\.?\b|\bdiv\b/i;
const GROWTH = /\bgrowth\b|\b-g\b|\(g\)/i;
const BONUS = /\bbonus\b/i;

export function classifySchemeVariant(schemeName: string): SchemeVariant {
  const name = schemeName.trim();
  return {
    plan: classifyPlan(name),
    option: classifyOption(name),
    isBonus: BONUS.test(name),
  };
}

export function isPreferredResearchPlan(
  variant: SchemeVariant,
  plan: SchemePlan = "direct",
  option: SchemeOption = "growth",
): boolean {
  if (variant.isBonus) return false;
  if (plan !== "unknown" && variant.plan !== plan) return false;
  if (option !== "unknown" && variant.option !== option) return false;
  return true;
}

function classifyPlan(name: string): SchemePlan {
  const hasDirect = DIRECT.test(name);
  const hasRegular = REGULAR.test(name);
  if (hasDirect && !hasRegular) return "direct";
  if (hasRegular && !hasDirect) return "regular";
  return "unknown";
}

function classifyOption(name: string): SchemeOption {
  if (IDCW.test(name)) return "idcw";
  if (DIVIDEND.test(name)) return "dividend";
  if (GROWTH.test(name)) return "growth";
  return "unknown";
}
