import assert from "node:assert/strict";
import { test } from "node:test";

import { classifySchemeVariant } from "../../src/finance/calculations/scheme-variant.js";

const cases: readonly {
  readonly name: string;
  readonly plan: "direct" | "regular" | "unknown";
  readonly option: "growth" | "idcw" | "dividend" | "unknown";
  readonly isBonus?: boolean;
}[] = [
  {
    name: "Axis ELSS- Tax Saver Fund - Direct Plan - Growth Option",
    plan: "direct",
    option: "growth",
  },
  { name: "HDFC Flexi Cap Fund - Direct Growth", plan: "direct", option: "growth" },
  {
    name: "Axis ELSS- Tax Saver Fund - Regular Plan - Growth Option",
    plan: "regular",
    option: "growth",
  },
  {
    name: "Axis ELSS- Tax Saver Fund - Direct Plan - IDCW Option",
    plan: "direct",
    option: "idcw",
  },
  {
    name: "Grindlays Super Saver Income Fund-GSSIF-Half Yearly Dividend",
    plan: "unknown",
    option: "dividend",
  },
  {
    name: "Some Fund Direct Plan Bonus Option",
    plan: "direct",
    option: "unknown",
    isBonus: true,
  },
];

for (const item of cases) {
  test(`classifies "${item.name}"`, () => {
    const variant = classifySchemeVariant(item.name);
    assert.equal(variant.plan, item.plan);
    assert.equal(variant.option, item.option);
    assert.equal(variant.isBonus, item.isBonus === true);
  });
}
