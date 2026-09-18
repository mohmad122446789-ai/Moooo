import {
  AuditLogEvent,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  activityTable,
  db,
  guildSettingsTable,
  warningsTable,
  walletsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const log = logger.child({ service: "discord-bot" });
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OWNER_ID = process.env.BOT_OWNER_ID;
const DAILY_SALARY = 2_500;
const TASK_REWARD = 500;
const MAX_DAILY_TASKS = 3;
const ADMIN_COMMANDS = [
  "warn",
  "unwarn",
  "warnings",
  "kick",
  "ban",
  "clear",
  "nickname",
  "create-role",
  "create-channel",
  "hide-channel",
  "show-channel",
  "set-log",
  "set-welcome",
  "color",
] as const;

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildModeration,
];

if (process.env.DISCORD_ENABLE_PRIVILEGED_INTENTS === "true") {
  intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent);
}

const client = new Client({ intents });

function today() {
  return new Date().toISOString().slice(0, 10);
}

function weekKey() {
  const date = new Date();
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
  return `${date.getUTCFullYear()}-${Math.ceil((day + start.getUTCDay() + 1) / 7)}`;
}

async function getActivity(guildId: string, userId: string) {
  await db
    .insert(activityTable)
    .values({ guildId, userId, dailyDate: today(), weeklyKey: weekKey() })
    .onConflictDoNothing({
      target: [activityTable.guildId, activityTable.userId],
    });
  const [activity] = await db
    .select()
    .from(activityTable)
    .where(
      and(eq(activityTable.guildId, guildId), eq(activityTable.userId, userId)),
    )
    .limit(1);
  if (!activity) throw new Error("Activity record could not be created.");
  return activity;
}

async function recordActivity(guild: Guild, userId: string) {
  const settings = await getSettings(guild.id);
  const activity = await getActivity(guild.id, userId);
  const currentDate = today();
  const currentWeek = weekKey();
  const dailyMessages = (activity.dailyDate === currentDate ? activity.dailyMessages : 0) + 1;
  const weeklyMessages = (activity.weeklyKey === currentWeek ? activity.weeklyMessages : 0) + 1;
  const messageCount = activity.messageCount + 1;
  const points = Math.floor(messageCount / 3);
  const dailyPoints = Math.floor(dailyMessages / 3);
  const weeklyPoints = Math.floor(weeklyMessages / 3);
  const messagesPerLevel = Math.max(1, settings.messagesPerLevel);
  const nextLevel = Math.floor(messageCount / messagesPerLevel);

  await db
    .update(activityTable)
    .set({
      messageCount,
      level: nextLevel,
      points,
      dailyMessages,
      dailyPoints,
      dailyDate: currentDate,
      weeklyMessages,
      weeklyPoints,
      weeklyKey: currentWeek,
      updatedAt: new Date(),
    })
    .where(eq(activityTable.id, activity.id));

  if (nextLevel > activity.level && settings.levelChannelId) {
    const channel = await guild.channels.fetch(settings.levelChannelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send(`ترقية! <@${userId}> وصل إلى **لفل ${nextLevel}** بعد ${messageCount} رسالة.`);
    }
  }
  return {
    ...activity,
    messageCount,
    level: nextLevel,
    points,
    dailyMessages,
    dailyPoints,
    weeklyMessages,
    weeklyPoints,
  };
}

async function leaderboard(guild: Guild, period: "day" | "week") {
  const rows = await db
    .select()
    .from(activityTable)
    .where(eq(activityTable.guildId, guild.id));
  return rows
    .map((row) => {
      const activity = currentActivity(row);
      return {
        ...row,
        dailyMessages: activity.dailyMessages,
        dailyPoints: activity.dailyPoints,
        weeklyMessages: activity.weeklyMessages,
        weeklyPoints: activity.weeklyPoints,
      };
    })
    .filter((row) => (period === "day" ? row.dailyPoints : row.weeklyPoints) > 0)
    .sort((left, right) =>
      (period === "day" ? right.dailyPoints - left.dailyPoints : right.weeklyPoints - left.weeklyPoints)
      || (period === "day" ? right.dailyMessages - left.dailyMessages : right.weeklyMessages - left.weeklyMessages),
    )
    .slice(0, 10);
}

function helpEmbed() {
  return new EmbedBuilder()
    .setTitle("مساعدة البوت | Bot Help")
    .setColor(0x5865f2)
    .setDescription([
      "**الاقتصاد | Economy**",
      "`/balance` — عرض الرصيد | Check balance",
      "`/pay` — تحويل B | Transfer B",
      "`/salary` — الراتب اليومي | Daily salary",
      "`/task` — مهمة يومية | Daily task",
      "",
      "**اللفل والتوب | Levels & Leaderboard**",
      "`/level` — مستواك ورسائلك | Your level and messages",
      "`/top day` — التوب اليومي | Daily top",
      "`/top week` — التوب الأسبوعي | Weekly top",
      "`t day` / `t week` — اختصار التوب في الشات | Chat leaderboard shortcuts",
      "`/panel` — لوحة الأزرار | Button panel",
      "",
      "**الإدارة | Moderation**",
      "`/warn`, `/unwarn`, `/warnings` — التحذيرات | Warnings",
      "`/kick`, `/ban`, `/clear` — إدارة الأعضاء والرسائل | Member and message moderation",
      "`/set-ban-role` — رتبة الباند | Ban role",
      "`/remove-ban-role` — إزالة رتبة الباند | Remove ban role",
      "`/set-admin-room` — روم اختصارات الإدارة | Admin aliases room",
      "`/remove-admin-room` — إلغاء روم الإدارة | Remove admin room restriction",
      "",
      "**التخصيص | Customization**",
      "`/admin-customize` — اختصار إداري | Admin chat alias",
      "`/customize` — اختصار شات | Chat alias",
      "`/set-level` — إعداد روم اللفل وعدد الرسائل | Configure level channel and message count",
      "`/request` — صورة عضو | User avatar",
      "",
      "اكتب `/help` في أي وقت | Type `/help` anytime.",
    ].join("\n"));
}

function panelComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("bankai:level")
        .setLabel("ترقية")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("bankai:task")
        .setLabel("أخذ مهمة")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("bankai:top-day")
        .setLabel("توب اليوم")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("bankai:top-week")
        .setLabel("توب الأسبوع")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function currentActivity(activity: Awaited<ReturnType<typeof getActivity>>) {
  const currentDate = today();
  const currentWeek = weekKey();
  return {
    ...activity,
    dailyMessages: activity.dailyDate === currentDate ? activity.dailyMessages : 0,
    dailyPoints: activity.dailyDate === currentDate ? activity.dailyPoints : 0,
    weeklyMessages: activity.weeklyKey === currentWeek ? activity.weeklyMessages : 0,
    weeklyPoints: activity.weeklyKey === currentWeek ? activity.weeklyPoints : 0,
  };
}

function levelProgress(
  activity: Awaited<ReturnType<typeof getActivity>>,
  messagesPerLevel: number,
) {
  const messages = Math.max(0, activity.messageCount);
  const step = Math.max(1, messagesPerLevel);
  const level = Math.floor(messages / step);
  const nextLevelAt = (level + 1) * step;
  return {
    level,
    messages,
    nextLevelAt,
    remaining: Math.max(0, nextLevelAt - messages),
    points: Math.floor(messages / 3),
    progress: messages % step,
  };
}

async function levelEmbed(guild: Guild, userId: string) {
  const settings = await getSettings(guild.id);
  const activity = currentActivity(await getActivity(guild.id, userId));
  const progress = levelProgress(activity, settings.messagesPerLevel);
  return new EmbedBuilder()
    .setTitle(`لفل العضو | Level`)
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: "اللفل | Level", value: `**${progress.level}**`, inline: true },
      { name: "النقاط | Points", value: `**${progress.points}**`, inline: true },
      { name: "الرسائل | Messages", value: `**${progress.messages}**`, inline: true },
      {
        name: "التقدم للفل التالي | Next level",
        value: `${progress.progress}/${Math.max(1, settings.messagesPerLevel)} رسالة — متبقي **${progress.remaining}**`,
      },
      {
        name: "نشاط اليوم/الأسبوع | Day/Week",
        value: `${activity.dailyMessages} رسالة / ${activity.dailyPoints} نقطة — ${activity.weeklyMessages} رسالة / ${activity.weeklyPoints} نقطة`,
      },
    )
    .setColor(0x5865f2);
}

async function handleButtonInteraction(interaction: ButtonInteraction) {
  if (!interaction.guild) return;
  const guild = interaction.guild;
  if (interaction.customId === "bankai:level") {
    return interaction.reply({
      embeds: [await levelEmbed(guild, interaction.user.id)],
      ephemeral: true,
    });
  }
  if (interaction.customId === "bankai:task") {
    const settings = await getSettings(guild.id);
    const activity = await getActivity(guild.id, interaction.user.id);
    const progress = levelProgress(activity, settings.messagesPerLevel);
    return interaction.reply({
      content: [
        `مهمتك الحالية: اكتب **${progress.remaining}** رسالة للوصول إلى لفل **${progress.level + 1}**.`,
        `كل **3 رسائل = نقطة واحدة**. مجموع نقاطك: **${progress.points}**.`,
      ].join("\n"),
      ephemeral: true,
    });
  }
  if (interaction.customId === "bankai:top-day" || interaction.customId === "bankai:top-week") {
    const period = interaction.customId === "bankai:top-day" ? "day" : "week";
    const rows = await leaderboard(guild, period);
    const title = period === "day" ? "توب اليوم | Daily Top" : "توب الأسبوع | Weekly Top";
    const lines = rows.length
      ? rows.map((row, index) => {
        const points = period === "day" ? row.dailyPoints : row.weeklyPoints;
        const messages = period === "day" ? row.dailyMessages : row.weeklyMessages;
        return `**${index + 1}.** <@${row.userId}> — ${points} نقطة (${messages} رسالة)`;
      })
      : ["لا توجد نقاط مسجلة حتى الآن."];
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(lines.join("\n"))
          .setColor(0x5865f2),
      ],
      ephemeral: true,
    });
  }
  return undefined;
}

async function getWallet(guildId: string, userId: string) {
  await db
    .insert(walletsTable)
    .values({ guildId, userId, tasksDate: today() })
    .onConflictDoNothing({
      target: [walletsTable.guildId, walletsTable.userId],
    });
  const [wallet] = await db
    .select()
    .from(walletsTable)
    .where(
      and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
    )
    .limit(1);
  if (!wallet) throw new Error("Wallet could not be created.");
  return wallet;
}

async function getSettings(guildId: string) {
  await db
    .insert(guildSettingsTable)
    .values({ guildId })
    .onConflictDoNothing({ target: guildSettingsTable.guildId });
  const [settings] = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId))
    .limit(1);
  if (!settings) throw new Error("Guild settings could not be created.");
  return settings;
}

async function addMoney(guildId: string, userId: string, amount: number) {
  await getWallet(guildId, userId);
  const [wallet] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
    )
    .returning();
  return wallet;
}

async function setMoney(guildId: string, userId: string, amount: number) {
  await getWallet(guildId, userId);
  const [wallet] = await db
    .update(walletsTable)
    .set({ balance: amount, updatedAt: new Date() })
    .where(
      and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
    )
    .returning();
  return wallet;
}

async function sendLog(guild: Guild, title: string, description: string) {
  try {
    const settings = await getSettings(guild.id);
    if (!settings.logChannelId) return;
    const channel = await guild.channels.fetch(settings.logChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description.slice(0, 4000))
      .setColor(0x5865f2)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (error) {
    log.warn({ err: error, guildId: guild.id }, "Could not send audit log");
  }
}

function memberName(member: GuildMember | { user: { tag: string; id: string } }) {
  return `${member.user.tag} (${member.user.id})`;
}

function replyText(
  interaction: {
    reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
  },
  content: string,
  ephemeral = false,
) {
  return interaction.reply({ content, ephemeral });
}

function isOwner(userId: string) {
  return Boolean(
    OWNER_ID === userId || client.application?.owner?.id === userId,
  );
}

async function canBan(guild: Guild, userId: string, permissions?: { has: (permission: bigint) => boolean }) {
  if (isOwner(userId) || permissions?.has(PermissionFlagsBits.BanMembers)) return true;
  const settings = await getSettings(guild.id);
  if (!settings.banRoleId) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  return Boolean(member?.roles.cache.has(settings.banRoleId));
}

async function checkBotBanCapability(guild: Guild, targetId: string) {
  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    return { ok: false, message: "لم أستطع العثور على عضوية البوت داخل السيرفر." };
  }
  if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
    return {
      ok: false,
      message: "البوت نفسه لا يملك صلاحية Ban Members. أعطِ البوت صلاحية الحظر من إعدادات السيرفر.",
    };
  }
  if (targetId === guild.ownerId) {
    return { ok: false, message: "لا يمكن حظر مالك السيرفر." };
  }
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) {
    return { ok: false, message: "العضو غير موجود داخل السيرفر." };
  }
  if (!target.bannable || botMember.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return {
      ok: false,
      message: "لا يمكن للبوت حظر هذا العضو. ارفع رتبة البوت فوق رتبة العضو المستهدف.",
    };
  }
  return { ok: true, target };
}

const commandBuilders = [
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("عرض رصيدك أو رصيد عضو آخر")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو المطلوب").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("تحويل عملة B إلى عضو آخر")
    .addUserOption((option) =>
      option.setName("user").setDescription("المستلم").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("مقدار التحويل")
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("salary")
    .setDescription("استلام راتب يومي مقداره 2500 B"),
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("تنفيذ مهمة يومية، كل مهمة تكافئك بـ 500 B")
    .addStringOption((option) =>
      option
        .setName("sentence")
        .setDescription("اكتب جملة من اختيارك لتنفيذ المهمة")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("شرح أوامر البوت بالعربي والإنجليزي"),
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("فتح لوحة البوت التفاعلية بالأزرار"),
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("عرض لفل ورسائل ونقاط عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("top")
    .setDescription("عرض ترتيب الأعضاء حسب النشاط")
    .addStringOption((option) =>
      option
        .setName("period")
        .setDescription("الفترة")
        .addChoices(
          { name: "يومي | Daily", value: "day" },
          { name: "أسبوعي | Weekly", value: "week" },
        )
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("تحذير عضو بسبب مخالفة")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("سبب التحذير").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("إزالة آخر تحذير عن عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("عرض تحذيرات عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("set-log")
    .setDescription("تحديد روم سجل الأحداث")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("روم السجل")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("set-welcome")
    .setDescription("تفعيل رسالة الترحيب في روم محدد")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("روم الترحيب")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("النص، استخدم {user} لمنشن العضو")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("set-level")
    .setDescription("تحديد روم اللفل وعدد الرسائل لكل لفل")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("روم إشعارات اللفل")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("messages")
        .setDescription("عدد الرسائل المطلوبة لكل لفل")
        .setMinValue(1)
        .setMaxValue(100000)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("set-admin-room")
    .setDescription("تحديد الروم الذي تعمل فيه اختصارات الإدارة — لمالك البوت فقط")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("روم الإدارة")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("remove-admin-room")
    .setDescription("إلغاء تقييد اختصارات الإدارة بروم — لمالك البوت فقط"),
  new SlashCommandBuilder()
    .setName("set-ban-role")
    .setDescription("تحديد رتبة الإدارة المسموح لها بالباند — لمالك البوت فقط")
    .addRoleOption((option) =>
      option
        .setName("role")
        .setDescription("رتبة الإدارة التي تقدر تبند")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("remove-ban-role")
    .setDescription("إزالة رتبة الباند المخصصة — لمالك البوت فقط"),
  new SlashCommandBuilder()
    .setName("alias")
    .setDescription("إنشاء اسم بديل لأمر سلاش")
    .addStringOption((option) =>
      option
        .setName("command")
        .setDescription("الأمر الإنجليزي مثل balance")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("الاسم البديل مثل ب")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("customize")
    .setDescription("إضافة اختصار شات لأمر")
    .addStringOption((option) =>
      option
        .setName("command")
        .setDescription("اسم الأمر الإنجليزي مثل ban أو balance")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("الاسم البديل مثل بانكاي")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("admin-customize")
    .setDescription("تخصيص اختصار أمر إداري — لمالك البوت فقط")
    .addStringOption((option) =>
      option
        .setName("command")
        .setDescription("أمر الإدارة مثل ban أو warn")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("الاختصار العربي مثل بانكاي")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("autoreply")
    .setDescription("إضافة رد تلقائي عند كتابة كلمة")
    .addStringOption((option) =>
      option.setName("trigger").setDescription("الكلمة").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reply").setDescription("الرد").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("color")
    .setDescription("تخصيص لون رتبة عضو — يجب اختيار العضو واللون")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("العضو الذي سيحصل على اللون")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("hex")
        .setDescription("اللون بصيغة HEX مثل #5865F2")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("request")
    .setDescription("طلب وعرض صورة عضو")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("العضو المطلوب — اختره أو ابحث عن يوزره")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("grant")
    .setDescription("منح عضوًا رصيدًا — لمالك البوت فقط")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName("amount").setDescription("المبلغ").setMinValue(1).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("reset-balance")
    .setDescription("تصفير رصيد عضو — لمالك البوت فقط")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("طرد عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("السبب").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("حظر عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("السبب").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("ban-status")
    .setDescription("فحص جاهزية البوت لتنفيذ الباند"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("مسح عدد من الرسائل")
    .addIntegerOption((option) =>
      option.setName("amount").setDescription("العدد من 1 إلى 100").setMinValue(1).setMaxValue(100).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("nickname")
    .setDescription("تغيير اسم عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("name").setDescription("الاسم الجديد").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("create-role")
    .setDescription("صنع رتبة جديدة")
    .addStringOption((option) =>
      option.setName("name").setDescription("اسم الرتبة").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("create-channel")
    .setDescription("صنع روم نصي جديد")
    .addStringOption((option) =>
      option.setName("name").setDescription("اسم الروم").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("hide-channel")
    .setDescription("إخفاء الروم عن الأعضاء")
    .addChannelOption((option) =>
      option.setName("channel").setDescription("الروم").addChannelTypes(ChannelType.GuildText).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("show-channel")
    .setDescription("إظهار الروم للأعضاء")
    .addChannelOption((option) =>
      option.setName("channel").setDescription("الروم").addChannelTypes(ChannelType.GuildText).setRequired(true),
    ),
].map((command) => command.toJSON());

async function handleInteraction(
  interaction: Parameters<typeof client.on>[1] extends never ? never : any,
): Promise<unknown> {
  if (!interaction.guild) return;
  if (interaction.isButton()) return handleButtonInteraction(interaction);
  if (!interaction.isChatInputCommand()) return;
  const guild = interaction.guild;
  const command = interaction.commandName;
  const userId = interaction.user.id;

  try {
    if (command === "balance") {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const wallet = await getWallet(guild.id, target.id);
      return replyText(interaction, `رصيد **${target.tag}** هو **${wallet.balance.toLocaleString()} B**.`);
    }

    if (command === "pay") {
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      if (target.bot || target.id === userId) return replyText(interaction, "لا يمكن التحويل إلى بوت أو إلى نفسك.", true);
      const sender = await getWallet(guild.id, userId);
      if (sender.balance < amount) return replyText(interaction, "رصيدك غير كافٍ.", true);
      await addMoney(guild.id, userId, -amount);
      const receiver = await addMoney(guild.id, target.id, amount);
      return replyText(interaction, `تم تحويل **${amount.toLocaleString()} B** إلى ${target}. رصيدك الآن **${(receiver ? sender.balance - amount : 0).toLocaleString()} B**.`);
    }

    if (command === "salary") {
      const wallet = await getWallet(guild.id, userId);
      if (wallet.lastSalaryAt && Date.now() - wallet.lastSalaryAt.getTime() < 86_400_000) {
        const hours = Math.ceil((86_400_000 - (Date.now() - wallet.lastSalaryAt.getTime())) / 3_600_000);
        return replyText(interaction, `استلمت راتبك مسبقًا. حاول بعد **${hours} ساعة**.`, true);
      }
      await db.update(walletsTable).set({ balance: sql`${walletsTable.balance} + ${DAILY_SALARY}`, lastSalaryAt: new Date(), updatedAt: new Date() }).where(eq(walletsTable.id, wallet.id));
      return replyText(interaction, `تم إيداع راتبك اليومي: **${DAILY_SALARY.toLocaleString()} B**.`);
    }

    if (command === "task") {
      const wallet = await getWallet(guild.id, userId);
      const completed = wallet.tasksDate === today() ? wallet.tasksCompleted : 0;
      if (completed >= MAX_DAILY_TASKS) return replyText(interaction, "أنجزت مهام اليوم الثلاث. عد غدًا.", true);
      await db.update(walletsTable).set({
        balance: sql`${walletsTable.balance} + ${TASK_REWARD}`,
        tasksDate: today(),
        tasksCompleted: completed + 1,
        updatedAt: new Date(),
      }).where(eq(walletsTable.id, wallet.id));
      return replyText(interaction, `مهمة مكتملة (**${interaction.options.getString("sentence", true)}**). حصلت على **${TASK_REWARD} B** — أنجزت ${completed + 1}/${MAX_DAILY_TASKS} اليوم.`);
    }

    if (command === "help") {
      return interaction.reply({ embeds: [helpEmbed()] });
    }

    if (command === "panel") {
      return interaction.reply({
        content: "لوحة Bankai التفاعلية | Bankai interactive panel",
        components: panelComponents(),
      });
    }

    if (command === "level") {
      const target = interaction.options.getUser("user") ?? interaction.user;
      return interaction.reply({ embeds: [await levelEmbed(guild, target.id)] });
    }

    if (command === "top") {
      const period = interaction.options.getString("period", true) as "day" | "week";
      const rows = await leaderboard(guild, period);
      const title = period === "day" ? "توب اليوم | Daily Top" : "توب الأسبوع | Weekly Top";
      const lines = rows.length
        ? rows.map((row, index) => {
          const points = period === "day" ? row.dailyPoints : row.weeklyPoints;
          const messages = period === "day" ? row.dailyMessages : row.weeklyMessages;
          return `**${index + 1}.** <@${row.userId}> — ${points} نقطة (${messages} رسالة)`;
        })
        : ["لا توجد نقاط مسجلة حتى الآن."];
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(title)
            .setDescription(lines.join("\n"))
            .setColor(0x5865f2),
        ],
      });
    }

    if (command === "warn") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) return replyText(interaction, "تحتاج صلاحية Moderate Members.", true);
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason", true);
      await db.insert(warningsTable).values({ guildId: guild.id, userId: target.id, moderatorId: userId, reason });
      await sendLog(guild, "تحذير عضو", `${target} تم تحذيره بواسطة ${interaction.user}.\nالسبب: ${reason}`);
      return replyText(interaction, `تم تحذير ${target}.\nالسبب: ${reason}`);
    }

    if (command === "unwarn" || command === "warnings") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) return replyText(interaction, "تحتاج صلاحية Moderate Members.", true);
      const target = interaction.options.getUser("user", true);
      const rows = await db.select().from(warningsTable).where(and(eq(warningsTable.guildId, guild.id), eq(warningsTable.userId, target.id))).orderBy(desc(warningsTable.createdAt));
      if (command === "unwarn") {
        const last = rows[0];
        if (!last) return replyText(interaction, "لا توجد تحذيرات لهذا العضو.", true);
        await db.delete(warningsTable).where(eq(warningsTable.id, last.id));
        await sendLog(guild, "إزالة تحذير", `تمت إزالة آخر تحذير عن ${target} بواسطة ${interaction.user}.`);
        return replyText(interaction, `تمت إزالة آخر تحذير عن ${target}.`);
      }
      if (!rows.length) return replyText(interaction, `لا توجد تحذيرات على ${target}.`);
      return replyText(interaction, `تحذيرات ${target}:\n${rows.slice(0, 10).map((row, index) => `${index + 1}. ${row.reason}`).join("\n")}`);
    }

    if (command === "set-log") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return replyText(interaction, "تحتاج صلاحية Manage Server.", true);
      const channel = interaction.options.getChannel("channel", true);
      await db.update(guildSettingsTable).set({ logChannelId: channel.id, updatedAt: new Date() }).where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, `تم تحديد ${channel} كسجل للأحداث.`);
    }

    if (command === "set-welcome") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return replyText(interaction, "تحتاج صلاحية Manage Server.", true);
      const channel = interaction.options.getChannel("channel", true);
      const message = interaction.options.getString("message") ?? "أهلًا {user}، نورت السيرفر.";
      await db.update(guildSettingsTable).set({ welcomeChannelId: channel.id, welcomeMessage: message, updatedAt: new Date() }).where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, `تم تفعيل الترحيب في ${channel}. استخدم {user} لمنشن العضو.`);
    }

    if (command === "set-level") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyText(interaction, "تحتاج صلاحية Manage Server.", true);
      }
      const channel = interaction.options.getChannel("channel", true);
      const messages = interaction.options.getInteger("messages", true);
      await getSettings(guild.id);
      await db
        .update(guildSettingsTable)
        .set({
          levelChannelId: channel.id,
          messagesPerLevel: messages,
          updatedAt: new Date(),
        })
        .where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(
        interaction,
        `تم ضبط اللفل: كل **${messages}** رسالة = لفل جديد، وإشعارات اللفل في ${channel}.`,
      );
    }

    if (command === "set-admin-room") {
      if (!isOwner(userId)) {
        return replyText(interaction, "هذا الأمر متاح لمالك البوت فقط.", true);
      }
      const channel = interaction.options.getChannel("channel", true);
      await getSettings(guild.id);
      await db
        .update(guildSettingsTable)
        .set({ adminCommandChannelId: channel.id, updatedAt: new Date() })
        .where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(
        interaction,
        `تم تحديد ${channel} كروم اختصارات الإدارة. لن تعمل الاختصارات الإدارية خارجه.`,
      );
    }

    if (command === "remove-admin-room") {
      if (!isOwner(userId)) {
        return replyText(interaction, "هذا الأمر متاح لمالك البوت فقط.", true);
      }
      await getSettings(guild.id);
      await db
        .update(guildSettingsTable)
        .set({ adminCommandChannelId: null, updatedAt: new Date() })
        .where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, "تم إلغاء تقييد اختصارات الإدارة بروم محدد.");
    }

    if (command === "set-ban-role") {
      if (!isOwner(userId)) {
        return replyText(interaction, "هذا الأمر متاح لمالك البوت فقط.", true);
      }
      const role = interaction.options.getRole("role", true);
      if (role.managed) {
        return replyText(interaction, "لا يمكن اختيار رتبة مرتبطة ببوت أو تكامل.", true);
      }
      await db
        .update(guildSettingsTable)
        .set({ banRoleId: role.id, updatedAt: new Date() })
        .where(eq(guildSettingsTable.guildId, guild.id));
      await sendLog(guild, "تغيير رتبة الباند", `تم تحديد ${role} كرتبة باند بواسطة ${interaction.user}.`);
      return replyText(interaction, `تم. أعضاء رتبة ${role} يستطيعون الآن استخدام أمر الباند.`);
    }

    if (command === "remove-ban-role") {
      if (!isOwner(userId)) {
        return replyText(interaction, "هذا الأمر متاح لمالك البوت فقط.", true);
      }
      await db
        .update(guildSettingsTable)
        .set({ banRoleId: null, updatedAt: new Date() })
        .where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, "تمت إزالة رتبة الباند المخصصة. سيحتاج الباند إلى صلاحية Ban Members أو أن يكون المستخدم مالك البوت.");
    }

    if (command === "admin-customize") {
      if (!isOwner(userId)) {
        return replyText(interaction, "هذا الأمر متاح لمالك البوت فقط.", true);
      }
      const targetCommand = interaction.options
        .getString("command", true)
        .replace(/^\//, "")
        .toLowerCase();
      const aliasName = interaction.options.getString("name", true).trim();
      if (!(ADMIN_COMMANDS as readonly string[]).includes(targetCommand)) {
        return replyText(
          interaction,
          `هذا ليس أمر إدارة مسموحًا. الأوامر المتاحة: ${ADMIN_COMMANDS.map((item) => `\`${item}\``).join("، ")}`,
          true,
        );
      }
      if (!aliasName || /\s/.test(aliasName) || aliasName.length > 32) {
        return replyText(interaction, "الاختصار يجب أن يكون كلمة واحدة وبحد أقصى 32 حرفًا.", true);
      }
      const settings = await getSettings(guild.id);
      const aliases = { ...settings.aliases, [aliasName]: targetCommand };
      await db
        .update(guildSettingsTable)
        .set({ aliases, updatedAt: new Date() })
        .where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(
        interaction,
        `تم تخصيص أمر الإدارة: اكتب **${aliasName}** في الشات ليعمل كـ **/${targetCommand}**. لا يزال Discord يطلب صلاحية الأمر قبل التنفيذ.`,
      );
    }

    if (command === "customize" || command === "alias" || command === "autoreply") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return replyText(interaction, "تحتاج صلاحية Manage Server.", true);
      const settings = await getSettings(guild.id);
      const isCustomize = command === "customize" || command === "alias";
      const key = isCustomize ? interaction.options.getString("command", true) : interaction.options.getString("trigger", true);
      const value = isCustomize ? interaction.options.getString("name", true) : interaction.options.getString("reply", true);
      const current = isCustomize ? { ...settings.aliases, [value]: key.replace(/^\//, "").toLowerCase() } : { ...settings.autoReplies, [key]: value };
      await db.update(guildSettingsTable).set({ [isCustomize ? "aliases" : "autoReplies"]: current, updatedAt: new Date() }).where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, isCustomize ? `تم تخصيص **${value}** ليشغّل الأمر **/${key.replace(/^\//, "").toLowerCase()}**. اكتب ${value} ثم منشن العضو عند الحاجة.` : `تمت إضافة الرد التلقائي للكلمة **${key}**.`);
    }

    if (command === "color") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return replyText(interaction, "تحتاج صلاحية Manage Roles.", true);
      const target = interaction.options.getUser("user", true);
      const rawHex = interaction.options.getString("hex", true).trim();
      const hex = rawHex.startsWith("#") ? rawHex : `#${rawHex}`;
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return replyText(interaction, "اكتب اللون بصيغة HEX صحيحة، مثال: `#5865F2`.", true);
      }
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (!member) return replyText(interaction, "هذا العضو غير موجود داخل السيرفر.", true);
      const oldColorRoles = member.roles.cache.filter(
        (role: GuildMember["roles"]["cache"] extends Map<string, infer Role> ? Role : never) =>
          role.name.startsWith("لون ") && !role.managed,
      );
      if (oldColorRoles.size) await member.roles.remove(oldColorRoles, "استبدال لون العضو");
      const roleName = `لون ${hex.toUpperCase()}`;
      const role = guild.roles.cache.find(
        (candidate: GuildMember["roles"]["cache"] extends Map<string, infer Role> ? Role : never) =>
          candidate.name === roleName && !candidate.managed,
      )
        ?? await guild.roles.create({ name: roleName, color: hex, reason: `لون مخصص لـ ${target.tag}` });
      await member.roles.add(role, "تخصيص لون العضو");
      await sendLog(guild, "تخصيص لون عضو", `${target} حصل على اللون ${hex} بواسطة ${interaction.user}.`);
      return replyText(interaction, `تم إعطاء ${target} رتبة اللون **${hex.toUpperCase()}**.`);
    }

    if (command === "request") {
      const target = interaction.options.getUser("user", true);
      const avatar = target.displayAvatarURL({ extension: "png", size: 1024 });
      const embed = new EmbedBuilder()
        .setTitle(`صورة ${target.tag}`)
        .setDescription(`طلب الصورة بواسطة ${interaction.user}`)
        .setImage(avatar)
        .setColor(0x5865f2)
        .setFooter({ text: `User ID: ${target.id}` });
      return interaction.reply({ embeds: [embed] });
    }

    if (command === "ban-status") {
      const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
      if (!botMember) return replyText(interaction, "لم أستطع العثور على البوت داخل السيرفر.", true);
      const settings = await getSettings(guild.id);
      return replyText(
        interaction,
        [
          `صلاحية البوت Ban Members: ${botMember.permissions.has(PermissionFlagsBits.BanMembers) ? "موجودة" : "ناقصة"}`,
          `رتبة الإدارة المخصصة للباند: ${settings.banRoleId ? `<@&${settings.banRoleId}>` : "غير محددة"}`,
          "شرط إضافي: يجب أن تكون رتبة البوت أعلى من رتبة العضو المستهدف.",
        ].join("\n"),
        true,
      );
    }

    if (command === "grant" || command === "reset-balance") {
      if (!isOwner(userId)) return replyText(interaction, "هذا الأمر متاح لمالك البوت فقط.", true);
      const target = interaction.options.getUser("user", true);
      if (command === "grant") {
        const amount = interaction.options.getInteger("amount", true);
        await addMoney(guild.id, target.id, amount);
        return replyText(interaction, `تم منح ${target} مبلغ **${amount.toLocaleString()} B**.`);
      }
      await setMoney(guild.id, target.id, 0);
      return replyText(interaction, `تم تصفير رصيد ${target}.`);
    }

    const memberTarget = interaction.options.getMember("user");
    if (command === "kick" || command === "ban") {
      const needed = command === "ban" ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
      const allowed = command === "ban"
        ? await canBan(guild, userId, interaction.memberPermissions)
        : Boolean(interaction.memberPermissions?.has(needed) || isOwner(userId));
      if (!allowed) return replyText(interaction, `تحتاج رتبة الباند المخصصة أو صلاحية ${command === "ban" ? "Ban Members" : "Kick Members"}.`, true);
      if (!memberTarget || !("kick" in memberTarget || "ban" in memberTarget)) return replyText(interaction, "لم أجد العضو داخل السيرفر.", true);
      if (command === "ban") {
        const capability = await checkBotBanCapability(guild, memberTarget.id);
        if (!capability.ok) {
          return replyText(
            interaction,
            capability.message ?? "تعذر تنفيذ الباند بسبب صلاحيات Discord.",
            true,
          );
        }
      }
      const reason = interaction.options.getString("reason") ?? "بدون سبب";
      if (command === "ban") await (memberTarget as GuildMember).ban({ reason });
      else await (memberTarget as GuildMember).kick(reason);
      await sendLog(guild, command === "ban" ? "حظر عضو" : "طرد عضو", `${memberTarget} بواسطة ${interaction.user}.\nالسبب: ${reason}`);
      return replyText(interaction, `تم ${command === "ban" ? "حظر" : "طرد"} العضو بنجاح.`);
    }

    if (command === "clear") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) return replyText(interaction, "تحتاج صلاحية Manage Messages.", true);
      const channel = interaction.channel;
      const amount = interaction.options.getInteger("amount", true);
      if (!channel || !("bulkDelete" in channel)) return replyText(interaction, "هذا الأمر يعمل في الرومات النصية فقط.", true);
      await (channel as TextChannel).bulkDelete(amount, true);
      return replyText(interaction, `تم مسح ${amount} رسالة.`, true);
    }

    if (command === "nickname") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames)) return replyText(interaction, "تحتاج صلاحية Manage Nicknames.", true);
      if (!memberTarget || !("setNickname" in memberTarget)) return replyText(interaction, "لم أجد العضو.", true);
      await (memberTarget as GuildMember).setNickname(interaction.options.getString("name", true));
      return replyText(interaction, "تم تغيير اسم العضو.");
    }

    if (command === "create-role") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return replyText(interaction, "تحتاج صلاحية Manage Roles.", true);
      const role = await guild.roles.create({ name: interaction.options.getString("name", true), reason: `بواسطة ${interaction.user.tag}` });
      return replyText(interaction, `تم صنع الرتبة ${role}.`);
    }

    if (command === "create-channel") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return replyText(interaction, "تحتاج صلاحية Manage Channels.", true);
      const channel = await guild.channels.create({ name: interaction.options.getString("name", true), type: ChannelType.GuildText });
      return replyText(interaction, `تم صنع الروم ${channel}.`);
    }

    if (command === "hide-channel" || command === "show-channel") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return replyText(interaction, "تحتاج صلاحية Manage Channels.", true);
      const channel = interaction.options.getChannel("channel", true);
      if (!("permissionOverwrites" in channel)) return replyText(interaction, "اختر رومًا نصيًا.", true);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: command === "show-channel" });
      return replyText(interaction, `تم ${command === "show-channel" ? "إظهار" : "إخفاء"} الروم.`);
    }
    return undefined;
  } catch (error) {
    log.error({ err: error, guildId: guild.id, command }, "Discord command failed");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 50013
    ) {
      const permissionMessage =
        command === "ban"
          ? "Discord رفض الباند: أعطِ البوت صلاحية Ban Members وارفع رتبته فوق العضو المستهدف."
          : "Discord رفض العملية بسبب صلاحيات البوت أو ترتيب الرتب.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(permissionMessage);
      } else {
        await replyText(interaction, permissionMessage, true);
      }
      return undefined;
    }
    if (interaction.replied || interaction.deferred) await interaction.editReply("حدث خطأ غير متوقع أثناء تنفيذ الأمر.");
    else await replyText(interaction, "حدث خطأ غير متوقع أثناء تنفيذ الأمر.", true);
    return undefined;
  }
}

async function handleMessage(message: Parameters<typeof client.on>[1] extends never ? never : any) {
  if (!message.guild || message.author.bot) return;
  const settings = await getSettings(message.guild.id);
  await recordActivity(message.guild, message.author.id);
  const content = message.content.trim();
  if (!content) return;
  const lower = content.toLowerCase();
  const autoReply = Object.entries(settings.autoReplies).find(([trigger]) => lower.includes(trigger.toLowerCase()));
  if (autoReply) await message.reply(autoReply[1]);

  const parts = content.split(/\s+/);
  if (parts[0]?.toLowerCase() === "t" && (parts[1] === "day" || parts[1] === "week")) {
    const period = parts[1] as "day" | "week";
    const rows = await leaderboard(message.guild, period);
    const lines = rows.length
      ? rows.map((row, index) => {
        const points = period === "day" ? row.dailyPoints : row.weeklyPoints;
        const messages = period === "day" ? row.dailyMessages : row.weeklyMessages;
        return `**${index + 1}.** <@${row.userId}> — ${points} نقطة (${messages} رسالة)`;
      })
      : ["لا توجد نقاط مسجلة حتى الآن."];
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(period === "day" ? "توب اليوم | Daily Top" : "توب الأسبوع | Weekly Top")
          .setDescription(lines.join("\n"))
          .setColor(0x5865f2),
      ],
    });
    return;
  }
  const alias = settings.aliases[parts[0]] ?? settings.aliases[parts[0]?.toLowerCase()];
  if (!alias) return;
  const isAdminAlias = (ADMIN_COMMANDS as readonly string[]).includes(alias);
  if (isAdminAlias && settings.adminCommandChannelId && message.channel.id !== settings.adminCommandChannelId) {
    return;
  }
  if (alias === "balance" || alias === "salary" || alias === "task" || alias === "pay") {
    if (alias === "balance") {
      const target = message.mentions.users.first() ?? message.author;
      const wallet = await getWallet(message.guild.id, target.id);
      await message.reply(`رصيدك هو **${wallet.balance.toLocaleString()} B**.`);
    } else if (alias === "salary") {
      await message.reply("استخدم أمر السلاش **/salary** لاستلام راتبك.");
    } else if (alias === "pay" && message.mentions.users.first()) {
      const target = message.mentions.users.first();
      const amount = Number(parts.find((part: string) => /^\d+$/.test(part)));
      if (!amount || amount < 1) {
        await message.reply("اكتب المبلغ بعد المنشن، مثال: `تحويل @عضو 500`.");
        return;
      }
      const sender = await getWallet(message.guild.id, message.author.id);
      if (sender.balance < amount) {
        await message.reply("رصيدك غير كافٍ.");
        return;
      }
      await addMoney(message.guild.id, message.author.id, -amount);
      await addMoney(message.guild.id, target.id, amount);
      await message.reply(`تم تحويل **${amount.toLocaleString()} B** إلى ${target}.`);
    } else {
      await message.reply(`استخدم أمر السلاش **/${alias}** لإكمال العملية.`);
    }
    return;
  }

  if (alias === "warn" && message.mentions.users.first()) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await message.reply("تحتاج صلاحية Moderate Members.");
      return;
    }
    const target = message.mentions.users.first();
    const reason = parts.slice(2).filter((part: string) => !part.startsWith("<@")).join(" ") || "بدون سبب";
    await db.insert(warningsTable).values({
      guildId: message.guild.id,
      userId: target.id,
      moderatorId: message.author.id,
      reason,
    });
    await sendLog(message.guild, "تحذير عضو", `${target} تم تحذيره بواسطة ${message.author}.\nالسبب: ${reason}`);
    await message.reply(`تم تحذير ${target}.\nالسبب: ${reason}`);
    return;
  }

  if ((alias === "ban" || alias === "kick") && message.mentions.members.first()) {
    const permission = alias === "ban" ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
    const allowed = alias === "ban"
      ? await canBan(message.guild, message.author.id, message.member?.permissions)
      : Boolean(message.member?.permissions.has(permission) || isOwner(message.author.id));
    if (!allowed) {
      await message.reply(`تحتاج صلاحية ${alias === "ban" ? "Ban Members" : "Kick Members"}.`);
      return;
    }
    const target = message.mentions.members.first();
    const reason = parts.slice(2).filter((part: string) => !part.startsWith("<@")).join(" ") || "بدون سبب";
    if (alias === "ban") {
      const capability = await checkBotBanCapability(message.guild, target.id);
      if (!capability.ok) {
        await message.reply(capability.message);
        return;
      }
      await target.ban({ reason });
    }
    else await target.kick(reason);
    await sendLog(message.guild, alias === "ban" ? "حظر عضو" : "طرد عضو", `${target} بواسطة ${message.author}.\nالسبب: ${reason}`);
    await message.reply(`تم ${alias === "ban" ? "حظر" : "طرد"} ${target}.`);
    return;
  }

  if (alias === "clear") {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await message.reply("تحتاج صلاحية Manage Messages.");
      return;
    }
    const amount = Number(parts.find((part: string) => /^\d+$/.test(part)));
    if (!amount || amount < 1 || amount > 100 || !("bulkDelete" in message.channel)) {
      await message.reply("اكتب عددًا من 1 إلى 100، مثال: `مسح 20`.");
      return;
    }
    await message.channel.bulkDelete(amount, true);
    await message.channel.send(`تم مسح ${amount} رسالة.`);
    return;
  }

  if (alias === "nickname" && message.mentions.members.first()) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      await message.reply("تحتاج صلاحية Manage Nicknames.");
      return;
    }
    const target = message.mentions.members.first();
    const nickname = parts.slice(2).filter((part: string) => !part.startsWith("<@")).join(" ").trim();
    if (!nickname) {
      await message.reply("اكتب الاسم الجديد بعد المنشن.");
      return;
    }
    await target.setNickname(nickname);
    await message.reply(`تم تغيير اسم ${target} إلى **${nickname}**.`);
    return;
  }

  if (alias === "create-role") {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await message.reply("تحتاج صلاحية Manage Roles.");
      return;
    }
    const name = parts.slice(1).join(" ").trim();
    if (!name) {
      await message.reply("اكتب اسم الرتبة، مثال: `رتبة-جديدة`.");
      return;
    }
    const role = await message.guild.roles.create({ name, reason: `بواسطة ${message.author.tag}` });
    await message.reply(`تم صنع الرتبة ${role}.`);
    return;
  }

  if (alias === "create-channel") {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply("تحتاج صلاحية Manage Channels.");
      return;
    }
    const name = parts.slice(1).join("-").trim();
    if (!name) {
      await message.reply("اكتب اسم الروم، مثال: `روم-جديد`.");
      return;
    }
    const channel = await message.guild.channels.create({ name, type: ChannelType.GuildText });
    await message.reply(`تم صنع الروم ${channel}.`);
    return;
  }

  if ((alias === "hide-channel" || alias === "show-channel") && message.mentions.channels.first()) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await message.reply("تحتاج صلاحية Manage Channels.");
      return;
    }
    const channel = message.mentions.channels.first();
    await channel.permissionOverwrites.edit(message.guild.roles.everyone, {
      ViewChannel: alias === "show-channel",
    });
    await message.reply(`تم ${alias === "show-channel" ? "إظهار" : "إخفاء"} الروم.`);
  }
}

function registerEvents() {
  client.on("interactionCreate", (interaction) => void handleInteraction(interaction));
  client.on("messageCreate", (message) => void handleMessage(message));
  client.on("guildMemberAdd", async (member) => {
    const settings = await getSettings(member.guild.id);
    if (settings.welcomeChannelId) {
      const channel = await member.guild.channels.fetch(settings.welcomeChannelId);
      if (channel?.isTextBased()) await channel.send((settings.welcomeMessage ?? "أهلًا {user}").replaceAll("{user}", `${member}`));
    }
    await sendLog(member.guild, "عضو دخل السيرفر", `${memberName(member)}`);
  });
  client.on("guildMemberRemove", (member) => void sendLog(member.guild, "عضو خرج من السيرفر", `${memberName(member)}`));
  client.on("messageDelete", (message) => {
    if (message.guild) void sendLog(message.guild, "حذف رسالة", `في ${message.channel} بواسطة ${message.author?.tag ?? "عضو غير معروف"}:\n${message.content || "محتوى غير متاح"}`);
  });
  client.on("messageUpdate", (oldMessage, newMessage) => {
    if (newMessage.guild && oldMessage.content !== newMessage.content) void sendLog(newMessage.guild, "تعديل رسالة", `في ${newMessage.channel}:\nقبل: ${oldMessage.content || "غير متاح"}\nبعد: ${newMessage.content || "غير متاح"}`);
  });
  client.on("channelCreate", (channel) => void sendLog(channel.guild, "صنع روم", `${channel}`));
  client.on("channelDelete", (channel) => {
    if ("guild" in channel && channel.guild) {
      void sendLog(channel.guild, "حذف روم", `#${"name" in channel ? channel.name : "روم"}`);
    }
  });
  client.on("channelUpdate", (oldChannel, newChannel) => {
    if ("guild" in newChannel && newChannel.guild && "name" in oldChannel && "name" in newChannel) {
      void sendLog(newChannel.guild, "تعديل روم", `#${oldChannel.name} ← #${newChannel.name}`);
    }
  });
  client.on("roleCreate", (role) => void sendLog(role.guild, "صنع رتبة", `${role}`));
  client.on("roleDelete", (role) => void sendLog(role.guild, "حذف رتبة", `@${role.name}`));
  client.on("roleUpdate", (oldRole, newRole) => void sendLog(newRole.guild, "تعديل رتبة", `@${oldRole.name} ← @${newRole.name}`));
  client.on("guildMemberUpdate", (oldMember, newMember) => {
    if (oldMember.nickname !== newMember.nickname) void sendLog(newMember.guild, "تغيير اسم شخص", `${memberName(newMember)}: ${oldMember.nickname ?? oldMember.user.username} ← ${newMember.nickname ?? newMember.user.username}`);
  });
  client.on("guildUpdate", (oldGuild, newGuild) => void sendLog(newGuild, "تغيير معلومات السيرفر", `${oldGuild.name} ← ${newGuild.name}`));
  client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    const actions = new Map<number, string>([
      [AuditLogEvent.MemberKick, "طرد شخص"],
      [AuditLogEvent.MemberBanAdd, "حظر شخص"],
      [AuditLogEvent.MemberRoleUpdate, "تغيير رتبة عضو"],
      [AuditLogEvent.MessageDelete, "مسح رسالة"],
      [AuditLogEvent.ChannelOverwriteCreate, "إخفاء/فتح روم"],
    ]);
    const title = actions.get(entry.action);
    if (title) await sendLog(guild, title, `بواسطة ${entry.executor?.tag ?? "غير معروف"}`);
  });
}

export async function startDiscordBot() {
  if (!BOT_TOKEN) {
    log.warn("DISCORD_BOT_TOKEN is not set; Discord bot is disabled");
    return;
  }
  if (process.env.DISCORD_ENABLE_PRIVILEGED_INTENTS !== "true") {
    log.warn(
      "Privileged Discord intents are disabled; slash commands work, but welcome, auto-replies, and message-content logging require DISCORD_ENABLE_PRIVILEGED_INTENTS=true and Developer Portal approval",
    );
  }
  registerEvents();
  client.once("clientReady", async (readyClient) => {
    try {
      const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commandBuilders });
      log.info({ tag: readyClient.user.tag, commands: commandBuilders.length }, "Discord bot connected and commands registered");
    } catch (error) {
      log.error({ err: error }, "Could not register Discord slash commands");
    }
  });
  await client.login(BOT_TOKEN);
}