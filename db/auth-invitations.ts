import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { invitations } from "./schema";

export const invitationActivationTokens = pgTable(
  "invitation_activation_tokens",
  {
    invitationId: text("invitation_id").primaryKey().references(() => invitations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_invitation_activation_token_hash").on(table.tokenHash),
    index("idx_invitation_activation_expires").on(table.expiresAt),
  ],
);
