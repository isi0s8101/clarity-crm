export type CrmFilterRule = {
  field: string;
  operator: "eq" | "ne" | "contains" | "not_contains" | "starts_with" | "exists" | "not_exists" | "gt" | "lt" | "gte" | "lte" | "between" | "before" | "after";
  value?: string | number | boolean | [string | number | boolean, string | number | boolean];
};

export type CrmFilterGroup = { logic: "and" | "or"; rules: CrmFilterRule[] };
