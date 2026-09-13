import { CORE_RECORD_TYPES, helpCatalog as legacyHelpCatalog, helpCategories } from "./catalog.js";
import { v11HelpProcedures } from "./catalog-v11.js";
import { v12HelpProcedures } from "./catalog-v12.js";

export { CORE_RECORD_TYPES, helpCategories };
export const helpCatalog = [...legacyHelpCatalog, ...v11HelpProcedures, ...v12HelpProcedures];
