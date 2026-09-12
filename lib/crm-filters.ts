import { and, eq, gt, gte, ilike, isNotNull, isNull, lt, lte, ne, not, or, sql, type SQL } from "drizzle-orm";

import { crmRecords } from "@/db/schema";
import { type CrmFilterGroup, type CrmFilterRule } from "@/lib/crm-filter-types";

export function buildCrmFilterCondition(group: CrmFilterGroup): SQL | undefined {
  const rules = group.rules.map(buildRule).filter((item): item is SQL => Boolean(item));
  return group.logic === "or" ? or(...rules) : and(...rules);
}

function buildRule(rule: CrmFilterRule): SQL | undefined {
  const field = expressionFor(rule.field);
  if (!field) return undefined;
  if (rule.operator === "exists") return isNotNull(field.expression);
  if (rule.operator === "not_exists") return isNull(field.expression);
  const values = rule.operator === "between" ? rule.value as [string | number | boolean, string | number | boolean] : [rule.value as string | number | boolean];
  if (field.kind === "date") return compareDate(field.expression, rule.operator, values.map(String));
  if (rule.operator === "gt" || rule.operator === "lt" || rule.operator === "gte" || rule.operator === "lte" || rule.operator === "between") {
    const numeric = sql`NULLIF(${field.expression}, '')::numeric`;
    const numbers = values.map(Number);
    if (numbers.some((value) => !Number.isFinite(value))) return undefined;
    if (rule.operator === "gt") return gt(numeric, numbers[0]);
    if (rule.operator === "lt") return lt(numeric, numbers[0]);
    if (rule.operator === "gte") return gte(numeric, numbers[0]);
    if (rule.operator === "lte") return lte(numeric, numbers[0]);
    return and(gte(numeric, numbers[0]), lte(numeric, numbers[1]));
  }
  const value = String(values[0]);
  if (rule.operator === "eq") return eq(field.expression, value);
  if (rule.operator === "ne") return ne(field.expression, value);
  if (rule.operator === "contains") return ilike(field.expression, `%${escapeLike(value)}%`);
  if (rule.operator === "not_contains") return not(ilike(field.expression, `%${escapeLike(value)}%`));
  if (rule.operator === "starts_with") return ilike(field.expression, `${escapeLike(value)}%`);
  return undefined;
}

function compareDate(expression: SQL, operator: string, values: string[]) {
  if (operator === "eq") return eq(expression, values[0]);
  if (operator === "ne") return ne(expression, values[0]);
  if (operator === "before") return lt(expression, values[0]);
  if (operator === "after") return gt(expression, values[0]);
  if (operator === "gte") return gte(expression, values[0]);
  if (operator === "lte") return lte(expression, values[0]);
  if (operator === "between") return and(gte(expression, values[0]), lte(expression, values[1]));
  return undefined;
}

function expressionFor(field: string): { expression: SQL; kind: "text" | "date" | "data" } | null {
  if (field === "title") return { expression: sql`${crmRecords.title}`, kind: "text" };
  if (field === "status") return { expression: sql`${crmRecords.status}`, kind: "text" };
  if (field === "createdAt") return { expression: sql`${crmRecords.createdAt}`, kind: "date" };
  if (field === "updatedAt") return { expression: sql`${crmRecords.updatedAt}`, kind: "date" };
  if (!field.startsWith("data.")) return null;
  const key = field.slice("data.".length);
  return { expression: sql`NULLIF(${crmRecords.data}::jsonb ->> ${key}, '')`, kind: "data" };
}

function escapeLike(value: string) { return value.replace(/[\\%_]/g, "\\$&"); }
