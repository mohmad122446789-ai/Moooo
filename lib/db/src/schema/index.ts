import {
  bigint,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const walletsTable = pgTable(
  "discord_wallets",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    lastSalaryAt: timestamp("last_salary_at", { withTimezone: true }),
    tasksDate: text("tasks_date").notNull().default(""),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userUnique: uniqueIndex("discord_wallets_user_unique").on(table.userId),
  }),
);

export const warningsTable = pgTable("discord_warnings", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  moderatorId: text("moderator_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const guildSettingsTable = pgTable(
  "discord_guild_settings",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    logChannelId: text("log_channel_id"),
    welcomeChannelId: text("welcome_channel_id"),
    banRoleId: text("ban_role_id"),
    bankaiOwnerId: text("bankai_owner_id"),
    adminCommandChannelId: text("admin_command_channel_id"),
    levelChannelId: text("level_channel_id"),
    messagesPerLevel: integer("messages_per_level").notNull().default(100),
    welcomeMessage: text("welcome_message"),
    aliases: jsonb("aliases").$type<Record<string, string>>().notNull().default({}),
    autoReplies: jsonb("auto_replies")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    guildUnique: uniqueIndex("discord_guild_settings_guild_unique").on(table.guildId),
  }),
);

export const activityTable = pgTable(
  "discord_activity",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    level: integer("level").notNull().default(0),
    points: integer("points").notNull().default(0),
    dailyPoints: integer("daily_points").notNull().default(0),
    dailyMessages: integer("daily_messages").notNull().default(0),
    dailyDate: text("daily_date").notNull().default(""),
    weeklyPoints: integer("weekly_points").notNull().default(0),
    weeklyMessages: integer("weekly_messages").notNull().default(0),
    weeklyKey: text("weekly_key").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    guildUserUnique: uniqueIndex("discord_activity_guild_user_unique").on(
      table.guildId,
      table.userId,
    ),
  }),
);

export type Wallet = typeof walletsTable.$inferSelect;
export type Warning = typeof warningsTable.$inferSelect;
export type GuildSettings = typeof guildSettingsTable.$inferSelect;
export type Activity = typeof activityTable.$inferSelect;